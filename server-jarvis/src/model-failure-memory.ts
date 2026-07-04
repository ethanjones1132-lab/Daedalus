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
 * Scope: ONLY non-retryable HTTP failures (4xx other than 429) call
 * `recordHardFailure`. 429s are handled by the existing in-call 2-strike
 * rule in `chatCompletionWithFallback`; transient 5xx retries and
 * first-token stalls are NOT hard failures and must not touch this registry.
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

interface FailureRecord {
  strikes: number;
  /** Timestamp (ms) when the strike count first reached the threshold. */
  cooldownStartedAt: number;
}

const registry = new Map<string, FailureRecord>();

function keyFor(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/**
 * Record a non-retryable hard failure (e.g. HTTP 400) for a model. After
 * `HARD_FAILURE_STRIKE_THRESHOLD` strikes, the key becomes excluded for
 * `HARD_FAILURE_COOLDOWN_MS` starting from the strike that crossed the
 * threshold (not the first strike).
 */
export function recordHardFailure(provider: string, modelId: string, now: number = Date.now()): void {
  const key = keyFor(provider, modelId);
  const existing = registry.get(key);
  const strikes = (existing?.strikes ?? 0) + 1;
  const cooldownStartedAt = strikes >= HARD_FAILURE_STRIKE_THRESHOLD
    ? (existing && existing.strikes >= HARD_FAILURE_STRIKE_THRESHOLD ? existing.cooldownStartedAt : now)
    : 0;
  registry.set(key, { strikes, cooldownStartedAt });
}

/**
 * Clear all strikes/cooldown state for a model. Call on any successful
 * completion so a model that recovers is no longer penalized for past
 * failures.
 */
export function recordSuccess(provider: string, modelId: string): void {
  registry.delete(keyFor(provider, modelId));
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
  const record = registry.get(key);
  if (!record) return false;
  if (record.strikes < HARD_FAILURE_STRIKE_THRESHOLD) return false;
  const cooldownElapsed = now - record.cooldownStartedAt >= HARD_FAILURE_COOLDOWN_MS;
  if (!cooldownElapsed) return true;
  // Cooldown window expired: allow exactly one probe attempt by dropping
  // strikes just below the threshold. Mutate in place so the next
  // recordHardFailure (if the probe fails) re-crosses the threshold and
  // starts a brand new cooldown window at that failure's timestamp.
  registry.set(key, { strikes: HARD_FAILURE_STRIKE_THRESHOLD - 1, cooldownStartedAt: 0 });
  return false;
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
  return result;
}

/** Test-only: clear all state between tests. */
export function resetModelFailureMemory(): void {
  registry.clear();
}
