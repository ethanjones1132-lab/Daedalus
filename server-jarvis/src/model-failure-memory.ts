/**
 * Process-lifetime registry of "hard failure" strikes per provider:model.
 *
 * Why this exists (live incident, 2026-07-03/07-03 sessions, every session in
 * the current logs): the executor stage resolves `north-mini-code-free`
 * (opencode_zen) as its pool default. The provider returns HTTP 400
 * ("Upstream request failed") immediately. `chatCompletionWithFallback`'s
 * non-retryable-HTTP branch (openrouter.ts, "advance, don't kill the turn")
 * correctly advances the cascade within that call — but nothing about the
 * failure survives past the call. The very next turn re-resolves the pool
 * default, picks north-mini-code-free again, and burns the first cascade
 * attempt on a model that is known-broken. This module gives that knowledge
 * a place to live across turns: a model that hard-fails twice is excluded
 * from pool selection for a cooldown window, then gets one probe attempt to
 * see if it recovered.
 *
 * Non-retryable HTTP failures (4xx other than 429) call `recordHardFailure`.
 * Repeated 429s use a separate, shorter provider-level cooldown because a
 * quota window commonly affects every model on the endpoint. Transient 5xx
 * retries are NOT hard failures and must not touch either registry.
 *
 * First-token stalls get their OWN registry (2026-07-16 evening, session
 * 10cf071d): the cascade advances past a stalled model within a call, but
 * nothing survived across turns, so every turn burned its synthesis runway
 * re-probing the same stalling model (deepseek-v4-flash: 20-40s of dead air
 * per turn, four turns in a row). Stalls use a shorter cooldown than hard
 * failures because provider load spikes pass — but while one lasts, the
 * first attempt of every user-visible stage must not pay for it.
 *
 * This is intentionally a simple in-memory Map, not persisted to disk or the
 * DB — it exists to survive across *turns* within one running process, not
 * across restarts. Restarting Jarvis gives every model a clean slate, which
 * is fine: the point is to stop the "burn one attempt every turn, forever"
 * pattern within a live session, not to build a permanent model reputation
 * store (that's the separate self-tuning/conductor-learning system).
 */

/** Strikes at/above this count make a key eligible for cooldown exclusion. */
export const HARD_FAILURE_STRIKE_THRESHOLD = 2;

/** How long a key stays excluded once it crosses the strike threshold. */
export const HARD_FAILURE_COOLDOWN_MS = 10 * 60_000;

/** Stall strikes at/above this count make a key eligible for cooldown exclusion. */
export const STALL_STRIKE_THRESHOLD = 2;

/** Stall cooldown — shorter than hard failures; provider load spikes pass. */
export const STALL_COOLDOWN_MS = 5 * 60_000;

/** Provider quota/rate-limit strikes before all of its models cool down. */
export const RATE_LIMIT_STRIKE_THRESHOLD = 2;

/** 429s are usually short-lived quota windows, so probe sooner than stalls. */
export const RATE_LIMIT_COOLDOWN_MS = 2 * 60_000;

interface FailureRecord {
  strikes: number;
  /** Timestamp (ms) when the strike count first reached the threshold. */
  cooldownStartedAt: number;
}

const registry = new Map<string, FailureRecord>();
const stallRegistry = new Map<string, FailureRecord>();
const providerRateLimitRegistry = new Map<string, FailureRecord>();

function keyFor(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function recordStrike(
  target: Map<string, FailureRecord>,
  key: string,
  threshold: number,
  now: number,
): void {
  const existing = target.get(key);
  const strikes = (existing?.strikes ?? 0) + 1;
  const cooldownStartedAt = strikes >= threshold
    ? (existing && existing.strikes >= threshold ? existing.cooldownStartedAt : now)
    : 0;
  target.set(key, { strikes, cooldownStartedAt });
}

/**
 * Shared exclusion check with "one probe attempt after cooldown" semantics —
 * see the `isTemporarilyExcluded` doc comment below for the full rationale.
 */
function isExcludedIn(
  target: Map<string, FailureRecord>,
  key: string,
  threshold: number,
  cooldownMs: number,
  now: number,
): boolean {
  const record = target.get(key);
  if (!record) return false;
  if (record.strikes < threshold) return false;
  const cooldownElapsed = now - record.cooldownStartedAt >= cooldownMs;
  if (!cooldownElapsed) return true;
  target.set(key, { strikes: threshold - 1, cooldownStartedAt: 0 });
  return false;
}

/**
 * Record a non-retryable hard failure (e.g. HTTP 400) for a model. After
 * `HARD_FAILURE_STRIKE_THRESHOLD` strikes, the key becomes excluded for
 * `HARD_FAILURE_COOLDOWN_MS` starting from the strike that crossed the
 * threshold (not the first strike).
 */
export function recordHardFailure(provider: string, modelId: string, now: number = Date.now()): void {
  recordStrike(registry, keyFor(provider, modelId), HARD_FAILURE_STRIKE_THRESHOLD, now);
}

/**
 * Record a first-token stall (no HTTP headers or no body bytes within the
 * leash window). After `STALL_STRIKE_THRESHOLD` strikes the model is
 * excluded from cascade selection for `STALL_COOLDOWN_MS`, then gets one
 * probe attempt — same shape as hard failures, separate books.
 */
export function recordStall(provider: string, modelId: string, now: number = Date.now()): void {
  recordStrike(stallRegistry, keyFor(provider, modelId), STALL_STRIKE_THRESHOLD, now);
}

/**
 * Remember repeated 429s at provider scope. Live OpenCode Go quota failures
 * affected every model on that endpoint; model-only memory simply moved from
 * deepseek-v4-pro to deepseek-v4-flash and paid the same retry tax again.
 */
export function recordRateLimit(provider: string, _modelId: string, now: number = Date.now()): void {
  recordStrike(providerRateLimitRegistry, provider, RATE_LIMIT_STRIKE_THRESHOLD, now);
}

/**
 * Clear all strikes/cooldown state for a model. Call on any successful
 * completion so a model that recovers is no longer penalized for past
 * failures.
 */
export function recordSuccess(provider: string, modelId: string): void {
  registry.delete(keyFor(provider, modelId));
  stallRegistry.delete(keyFor(provider, modelId));
  providerRateLimitRegistry.delete(provider);
}

/**
 * True when the model is currently excluded: strikes >= threshold AND still
 * within the cooldown window that started when the threshold was crossed.
 *
 * Expiry semantics: once the cooldown window elapses, the key is NOT
 * excluded (`isTemporarilyExcluded` returns false) — this is the "one probe
 * attempt" behavior. But we don't reset strikes to 0, because that would let
 * a permanently-broken model earn a full fresh 2-strike grace period every
 * 10 minutes forever. Instead, on expiry we lazily decrement strikes back to
 * `HARD_FAILURE_STRIKE_THRESHOLD - 1`: the model gets exactly one
 * unexcluded attempt, and if that attempt also hard-fails, the very next
 * `recordHardFailure` call brings strikes back to the threshold and
 * re-triggers cooldown immediately (starting a fresh cooldown window at the
 * new failure's timestamp). If the probe succeeds, `recordSuccess` clears
 * the entry entirely.
 */
export function isTemporarilyExcluded(provider: string, modelId: string, now: number = Date.now()): boolean {
  const key = keyFor(provider, modelId);
  // Cooldown window expired (either registry): allow exactly one probe
  // attempt by dropping strikes just below the threshold (inside
  // isExcludedIn). The next record* call after a failed probe re-crosses
  // the threshold and starts a brand new cooldown window at that failure's
  // timestamp; a successful probe clears the entry via recordSuccess.
  return (
    isExcludedIn(registry, key, HARD_FAILURE_STRIKE_THRESHOLD, HARD_FAILURE_COOLDOWN_MS, now) ||
    isExcludedIn(stallRegistry, key, STALL_STRIKE_THRESHOLD, STALL_COOLDOWN_MS, now) ||
    isExcludedIn(providerRateLimitRegistry, provider, RATE_LIMIT_STRIKE_THRESHOLD, RATE_LIMIT_COOLDOWN_MS, now)
  );
}

/**
 * All `provider:modelId` keys currently in cooldown (matches the exclude-set
 * key format `${provider}:${model_id}` used throughout index.ts/agent-pool.ts/
 * openrouter.ts's excludeModels plumbing).
 */
export function excludedModelKeys(now: number = Date.now()): Set<string> {
  const result = new Set<string>();
  for (const [key, record] of registry.entries()) {
    if (record.strikes < HARD_FAILURE_STRIKE_THRESHOLD) continue;
    if (now - record.cooldownStartedAt < HARD_FAILURE_COOLDOWN_MS) result.add(key);
  }
  for (const [key, record] of stallRegistry.entries()) {
    if (record.strikes < STALL_STRIKE_THRESHOLD) continue;
    if (now - record.cooldownStartedAt < STALL_COOLDOWN_MS) result.add(key);
  }
  for (const [provider, record] of providerRateLimitRegistry.entries()) {
    if (record.strikes < RATE_LIMIT_STRIKE_THRESHOLD) continue;
    if (now - record.cooldownStartedAt < RATE_LIMIT_COOLDOWN_MS) result.add(`${provider}:*`);
  }
  return result;
}

/** Test-only: clear all state between tests. */
export function resetModelFailureMemory(): void {
  registry.clear();
  stallRegistry.clear();
  providerRateLimitRegistry.clear();
}
