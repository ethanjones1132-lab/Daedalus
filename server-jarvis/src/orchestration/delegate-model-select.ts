/**
 * Delegate executor model selection ranked by measured verified-write evidence.
 *
 * Preference order (W1.1 / W1.2 / W1.3):
 *   1. Operator pin (non-empty non-"auto") until thrash threshold
 *   2. Highest write-evidence among eligible candidates:
 *      - Free models (proxy path) only when earned: verifiedWrites > 0 and not benched
 *      - OpenAI-format Go when proxy is up
 *      - Anthropic-native Go when Go key is present — even when proxy is up
 *   3. Free only ranks above Go when its write rate strictly exceeds the best
 *      eligible Go model; thrash after minimax prefers other Go before free
 *   4. Thrash advances through that list (not free-first / cheapest)
 *
 * Scoreboard is process-cached and persisted in self-tuning.db so a restart
 * does not re-learn free-pool failure from zero.
 */

import { SelfTuningStore } from "../self-tuning/store";
import {
  modelsBenchedForErrorRate,
  shouldBenchForErrorRate,
  errorStatsForModel,
} from "./model-health";
import { BASELINE_THETA, policy } from "./orchestration-policy";

/** OpenAI-format Go models (need proxy for Claude CLI). */
export const DELEGATE_GO_OPENAI_MODELS = [
  "deepseek-v4-flash",
  "mimo-v2.5",
] as const;

/**
 * Mirror of the claude_cli proxy's own model routing
 * (claude_cli_proxy.py::resolve_upstream, verified 2026-07-29):
 *
 *   1. Bare id in get_opencode_go_openai_models() + Go key -> opencode_go (direct)
 *   2. Namespaced "vendor/model[:tag]" + OpenRouter key     -> openrouter
 *   3. Bare Ollama ids / claude-* placeholders              -> ollama
 *
 * Rule 1 matters: DELEGATE_GO_OPENAI_MODELS ("deepseek-v4-flash", "mimo-v2.5")
 * are bare ids that resolve WITHOUT being installed in Ollama, via a
 * different mechanism than rule 3. A bare id that matches neither rule 1 nor
 * an installed Ollama model is unreachable: the proxy sends it to :11434 and
 * gets `{"error":{"message":"model '<id>' not found"}}`, the delegate exits
 * nonzero, and the turn opens with a failed git_metadata call. Through
 * 2026-07-29 every id in DELEGATE_FREE_FIRST_MODELS was a bare OpenCode ZEN
 * id (a different catalog than OpenCode Go) matching neither rule 1 nor any
 * installed Ollama model, so the whole free-first pool 404'd on every write run.
 */
export function isProxyResolvable(
  model: string,
  installedOllamaModels: readonly string[],
  goOpenaiModels: readonly string[] = DELEGATE_GO_OPENAI_MODELS,
): boolean {
  const id = model.trim();
  if (id.length === 0) return false;
  if (goOpenaiModels.includes(id)) return true; // rule 1 — OpenCode Go direct
  if (id.includes("/")) return true;            // rule 2 — OpenRouter
  if (id.startsWith("claude-")) return true;    // rule 3 — proxy default model
  return installedOllamaModels.includes(id);    // rule 3 — must be installed
}

/**
 * Free-tier delegate models (historical free-first order, healthiest first).
 *
 * These MUST be namespaced (`vendor/model`) so the proxy routes them to
 * OpenRouter. Bare OpenCode Zen ids are unreachable — see isProxyResolvable.
 *
 * Free is an *earned* lane (W1.3): models appear in selection only while not
 * benched, and ranking is by write evidence — not by being free.
 */
export const DELEGATE_FREE_FIRST_MODELS = [
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "google/gemma-4-31b-it:free",
] as const;

/**
 * Free-first is the goal, but a lane that cannot emit a tool call is not a
 * cheap lane — it is a wasted turn plus a fallback.
 *
 * The delegate is the primary write path, so tool-call fidelity is the entire
 * job. Reasoning models emit `<think>` and leave `content` empty, so there is
 * nothing to parse as a tool call (the trap already recorded for MiniMax M3).
 * Live 2026-08-01 (run_d84a937f, run_275068a5): with the reasoning model in
 * this pool, one executor turn produced 7825 output tokens and ZERO tool
 * calls, the delegate's only edit was a no-op (`old_string` === `new_string`),
 * and both delegate stages recorded ok=0 err=1.
 *
 * Listed by EXPLICIT id rather than matched on a substring like "reasoning":
 * a wrong exclusion silently costs a free lane, and re-enabling a model once
 * it supports tools must be deleting one line here — nothing else. Entries
 * stay in DELEGATE_FREE_FIRST_MODELS above so the pool still documents what
 * exists and ordering is unchanged for every capable model.
 */
export const DELEGATE_TOOL_INCAPABLE_MODELS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
] as const;

/** False only for models known to be unable to emit a usable tool call. */
export function isToolCallCapableDelegate(
  model: string,
  incapable: readonly string[] = DELEGATE_TOOL_INCAPABLE_MODELS,
): boolean {
  return !incapable.includes(model.trim());
}

/** Anthropic-native Go models (skip proxy; need opencode_go key). */
export const DELEGATE_GO_ANTHROPIC_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
] as const;

export const DELEGATE_GO_CHEAP_CAPABLE_MODELS = [
  ...DELEGATE_GO_OPENAI_MODELS,
  ...DELEGATE_GO_ANTHROPIC_MODELS,
] as const;

export const DEFAULT_FREE_THRASH_THRESHOLD = BASELINE_THETA.default_free_thrash_threshold;
export const DELEGATE_WRITE_SCOREBOARD_BENCH_ATTEMPTS = BASELINE_THETA.delegate_write_scoreboard_bench_attempts;
/** Default session thrash counter TTL (30 minutes). */
export const DEFAULT_THRASH_TTL_MS = BASELINE_THETA.thrash_ttl_ms;

/**
 * Historical write-evidence seeds so scoreboard ranking picks a proven writer
 * on the first turn after deploy (no re-learning free-pool failure on restart).
 *
 * Measured aggregate (2026-07/08 live runs):
 *   - minimax-m3: 123 attempts, ~96% verified write rate → 118 verified
 *   - Free pool (tool-capable lanes): ~33 attempts / ~9% verified across pool
 *
 * Free seeds split the free-pool aggregate across tool-capable free-first
 * models so each starts poorly enough that minimax-m3 ranks first without
 * hand-tuning after deploy. The tool-incapable reasoning model is not seeded.
 */
export const DELEGATE_WRITE_SCOREBOARD_SEEDS: ReadonlyArray<{
  model: string;
  attempts: number;
  verifiedWrites: number;
}> = [
  // 118 / 123 ≈ 0.959
  { model: "minimax-m3", attempts: 123, verifiedWrites: 118 },
  // Free pool split of ~33 attempts / ~9% verified (3/33 ≈ 0.091)
  { model: "cohere/north-mini-code:free", attempts: 17, verifiedWrites: 1 },
  { model: "google/gemma-4-31b-it:free", attempts: 16, verifiedWrites: 2 },
];

export type DelegateModelPool = "free" | "go_capable";

export interface DelegateModelSelection {
  model: string;
  pool: DelegateModelPool;
  reason: string;
  thrashCount: number;
}

/** Session-scoped thrash state with expiry for free→Go promotion. */
export interface DelegateThrashState {
  count: number;
  updatedAt: number;
}

/** Process-local thrash counters keyed by session (survives agent-run boundaries). */
const thrashByKey = new Map<string, DelegateThrashState>();

export interface DelegateWriteScoreboardEntry {
  model: string;
  attempts: number;
  verifiedWrites: number;
  benched: boolean;
}

/** Process-local cache of write evidence; hydrated from self-tuning.db. */
const writeScoreboard = new Map<string, DelegateWriteScoreboardEntry>();
let scoreboardHydrated = false;
/** When true, empty scoreboard stays empty (tests) and seeds are not re-applied. */
let scoreboardSeedSuppressed = false;
let scoreboardStore: SelfTuningStore | null = null;

function getScoreboardStore(): SelfTuningStore {
  if (!scoreboardStore) {
    scoreboardStore = new SelfTuningStore();
  }
  return scoreboardStore;
}

function entryFromSeed(seed: {
  model: string;
  attempts: number;
  verifiedWrites: number;
}): DelegateWriteScoreboardEntry {
  return {
    model: seed.model,
    attempts: seed.attempts,
    verifiedWrites: seed.verifiedWrites,
    benched:
      seed.attempts >= DELEGATE_WRITE_SCOREBOARD_BENCH_ATTEMPTS &&
      seed.verifiedWrites === 0,
  };
}

function persistScoreboardEntry(entry: DelegateWriteScoreboardEntry): void {
  try {
    getScoreboardStore().upsertDelegateWriteScoreboard(entry);
  } catch (e) {
    console.error("[delegate-model-select] persist scoreboard failed:", e);
  }
}

/**
 * Merge historical seeds for models missing from the in-memory board.
 * Never overwrites live counters. Safe to call repeatedly.
 */
function mergeHistoricalSeeds(): void {
  for (const seed of DELEGATE_WRITE_SCOREBOARD_SEEDS) {
    if (writeScoreboard.has(seed.model)) continue;
    const entry = entryFromSeed(seed);
    writeScoreboard.set(entry.model, entry);
    persistScoreboardEntry(entry);
  }
}

/**
 * Load scoreboard from self-tuning.db; merge historical seeds for any missing
 * models (never overwrites live counters). Idempotent per process unless reset.
 */
export function ensureDelegateWriteScoreboardHydrated(): void {
  if (scoreboardHydrated) return;
  scoreboardHydrated = true;

  let rows: Array<{
    model: string;
    attempts: number;
    verified_writes: number;
    benched: number;
  }> = [];
  try {
    rows = getScoreboardStore().getAllDelegateWriteScoreboard();
  } catch (e) {
    console.error("[delegate-model-select] load scoreboard failed:", e);
  }

  for (const row of rows) {
    writeScoreboard.set(row.model, {
      model: row.model,
      attempts: row.attempts,
      verifiedWrites: row.verified_writes,
      benched: row.benched === 1,
    });
  }

  // Always merge missing seeds when not suppressed (empty or partial table).
  if (!scoreboardSeedSuppressed) {
    mergeHistoricalSeeds();
  }
}

/** Apply historical seeds into the in-memory + persisted scoreboard (merge only). */
export function seedDelegateWriteScoreboardFromHistory(): void {
  ensureDelegateWriteScoreboardHydrated();
  mergeHistoricalSeeds();
}

/**
 * Test helper: clear in-memory scoreboard and backing store rows.
 * Suppresses auto-seed so unit tests can start from an empty board.
 */
export function __resetDelegateWriteScoreboardForTests(): void {
  writeScoreboard.clear();
  scoreboardHydrated = true;
  scoreboardSeedSuppressed = true;
  try {
    getScoreboardStore().clearDelegateWriteScoreboard();
  } catch {
    /* ignore */
  }
}

/**
 * Test helper: reset + re-apply historical seeds (acceptance fixtures).
 */
export function __reseedDelegateWriteScoreboardForTests(): void {
  writeScoreboard.clear();
  scoreboardHydrated = true;
  scoreboardSeedSuppressed = false;
  try {
    getScoreboardStore().clearDelegateWriteScoreboard();
  } catch {
    /* ignore */
  }
  for (const seed of DELEGATE_WRITE_SCOREBOARD_SEEDS) {
    const entry = entryFromSeed(seed);
    writeScoreboard.set(entry.model, entry);
    persistScoreboardEntry(entry);
  }
}

/** Inject store for tests (optional; defaults to SelfTuningStore under NODE_ENV=test → :memory:). */
export function __setDelegateWriteScoreboardStoreForTests(store: SelfTuningStore | null): void {
  scoreboardStore = store;
  writeScoreboard.clear();
  scoreboardHydrated = false;
  scoreboardSeedSuppressed = false;
}

export function getDelegateWriteScoreboard(model: string): DelegateWriteScoreboardEntry | undefined {
  ensureDelegateWriteScoreboardHydrated();
  return writeScoreboard.get(model.trim());
}

/** Why a model is excluded from delegate auto-selection. */
export type DelegateBenchReason = "write_evidence" | "error_rate";

export interface BenchedDelegateModelEntry {
  model: string;
  reason: DelegateBenchReason;
}

/**
 * Write-evidence benches unioned with process-local error-rate benches.
 * Reasons stay distinct so the replay harness can tell them apart.
 */
export function getBenchedDelegateModelEntries(): BenchedDelegateModelEntry[] {
  ensureDelegateWriteScoreboardHydrated();
  const entries: BenchedDelegateModelEntry[] = [];
  for (const entry of writeScoreboard.values()) {
    if (entry.benched) {
      entries.push({ model: entry.model, reason: "write_evidence" });
    }
  }
  for (const model of modelsBenchedForErrorRate()) {
    entries.push({ model, reason: "error_rate" });
  }
  // Also check scoreboard-known models against bare error stats in case the
  // error map only holds the model id without a dual provider key.
  for (const entry of writeScoreboard.values()) {
    if (entry.benched) continue;
    if (shouldBenchForErrorRate(errorStatsForModel(entry.model))) {
      if (!entries.some((e) => e.model === entry.model && e.reason === "error_rate")) {
        entries.push({ model: entry.model, reason: "error_rate" });
      }
    }
  }
  return entries;
}

export function getBenchedDelegateModels(): string[] {
  return [...new Set(getBenchedDelegateModelEntries().map((e) => e.model))];
}

/**
 * Whether a delegate outcome should count as model write-capability evidence.
 *
 * Always record verified writes. Skip abort/cancel/integration/handoff paths
 * that often fire before the model does real work — three cancels must not
 * bench a capable model. Model failure signals (no_write, stream, timeout,
 * exit, cli, rate, …) still count.
 */
export function shouldRecordDelegateWriteOutcome(input: {
  hasVerifiedWrite: boolean;
  errorCode?: string;
}): boolean {
  if (input.hasVerifiedWrite) return true;
  const code = (input.errorCode || "").toLowerCase();
  if (!code) return true;
  // External cancel / pre-model integration failure / conductor intervention.
  if (code.includes("abort")) return false; // delegate_aborted, mid_loop_abort
  if (code.includes("cancel")) return false;
  if (code.includes("integration")) return false;
  if (code.includes("handoff")) return false;
  return true;
}

export function recordDelegateWriteOutcome(
  model: string,
  verifiedWrite: boolean,
): DelegateWriteScoreboardEntry {
  ensureDelegateWriteScoreboardHydrated();
  const normalized = model.trim() || "unknown-delegate-model";
  const previous = writeScoreboard.get(normalized);
  const attempts = (previous?.attempts ?? 0) + 1;
  const verifiedWrites = (previous?.verifiedWrites ?? 0) + (verifiedWrite ? 1 : 0);
  const entry: DelegateWriteScoreboardEntry = {
    model: normalized,
    attempts,
    verifiedWrites,
    benched: attempts >= DELEGATE_WRITE_SCOREBOARD_BENCH_ATTEMPTS && verifiedWrites === 0,
  };
  writeScoreboard.set(normalized, entry);
  persistScoreboardEntry(entry);
  return entry;
}

/** Write-evidence score: higher rate wins; ties break toward more attempts. */
export function writeEvidenceScore(entry: DelegateWriteScoreboardEntry | undefined): {
  rate: number;
  attempts: number;
  verifiedWrites: number;
} {
  const attempts = entry?.attempts ?? 0;
  const verifiedWrites = entry?.verifiedWrites ?? 0;
  return {
    rate: verifiedWrites / Math.max(attempts, 1),
    attempts,
    verifiedWrites,
  };
}

/** Compare two models by write evidence (descending). Negative → a ranks above b. */
export function compareDelegateWriteEvidence(a: string, b: string): number {
  ensureDelegateWriteScoreboardHydrated();
  const sa = writeEvidenceScore(writeScoreboard.get(a.trim()));
  const sb = writeEvidenceScore(writeScoreboard.get(b.trim()));
  if (sb.rate !== sa.rate) return sb.rate - sa.rate;
  if (sb.attempts !== sa.attempts) return sb.attempts - sa.attempts;
  // Stable fallback: prefer Anthropic Go, then OpenAI Go, then free (lexical).
  const tier = (m: string): number => {
    if ((DELEGATE_GO_ANTHROPIC_MODELS as readonly string[]).includes(m)) return 0;
    if ((DELEGATE_GO_OPENAI_MODELS as readonly string[]).includes(m)) return 1;
    return 2;
  };
  const ta = tier(a.trim());
  const tb = tier(b.trim());
  if (ta !== tb) return ta - tb;
  return a.trim().localeCompare(b.trim());
}

export function rankModelsByWriteEvidence(models: readonly string[]): string[] {
  ensureDelegateWriteScoreboardHydrated();
  return [...models].sort(compareDelegateWriteEvidence);
}

/**
 * Auto-mode candidate order: free only sits above Go when its write rate
 * strictly exceeds the best eligible Go model. Otherwise Go (evidence-ranked)
 * comes first, then earned free (evidence-ranked). Thrash after minimax
 * therefore prefers other Go models before free.
 */
export function rankDelegateAutoCandidates(
  freeModels: readonly string[],
  goModels: readonly string[],
): string[] {
  ensureDelegateWriteScoreboardHydrated();
  const goRanked = rankModelsByWriteEvidence(goModels);
  const freeRanked = rankModelsByWriteEvidence(freeModels);
  if (goRanked.length === 0) return freeRanked;
  if (freeRanked.length === 0) return goRanked;

  const bestGoRate = writeEvidenceScore(writeScoreboard.get(goRanked[0]!)).rate;
  const freeAboveBestGo: string[] = [];
  const freeRest: string[] = [];
  for (const model of freeRanked) {
    const rate = writeEvidenceScore(writeScoreboard.get(model)).rate;
    if (rate > bestGoRate) freeAboveBestGo.push(model);
    else freeRest.push(model);
  }
  return [...freeAboveBestGo, ...goRanked, ...freeRest];
}

/** Stable thrash key for a session; blank/missing → unknown-session. */
export function delegateThrashKey(sessionId: string): string {
  return sessionId.trim() || "unknown-session";
}

export function __resetDelegateThrashForTests(): void {
  thrashByKey.clear();
}

function thrashStateAt(
  key: string,
  ttlMs: number,
  now: number,
): DelegateThrashState | undefined {
  const state = thrashByKey.get(key);
  if (!state) return undefined;
  if (now - state.updatedAt > ttlMs) {
    thrashByKey.delete(key);
    return undefined;
  }
  return state;
}

export function getDelegateThrashCount(
  key: string,
  ttlMs: number = DEFAULT_THRASH_TTL_MS,
  now: number = Date.now(),
): number {
  return thrashStateAt(key, ttlMs, now)?.count ?? 0;
}

export function recordDelegateThrash(
  key: string,
  ttlMs: number = DEFAULT_THRASH_TTL_MS,
  now: number = Date.now(),
): number {
  const prev = thrashStateAt(key, ttlMs, now);
  const next = (prev?.count ?? 0) + 1;
  thrashByKey.set(key, { count: next, updatedAt: now });
  return next;
}

export function clearDelegateThrash(key: string): void {
  thrashByKey.delete(key);
}

/**
 * Whether a delegate outcome should count as thrash for free→Go promotion.
 */
export function isDelegateThrashOutcome(input: {
  ok: boolean;
  hasVerifiedWrite: boolean;
  errorCode?: string;
}): boolean {
  if (input.hasVerifiedWrite) return false;
  if (input.ok && !input.hasVerifiedWrite) return true;
  const code = (input.errorCode || "").toLowerCase();
  if (!code) return !input.ok;
  return (
    code.includes("no_write") ||
    code.includes("stream") ||
    code.includes("timeout") ||
    code.includes("rate") ||
    code.includes("spawn") ||
    code.includes("exit") ||
    // Named CLI stream failures (result is_error / type:error) — previously
    // often classified as delegate_exit_nonzero; must still promote free→Go.
    code.includes("cli") ||
    code.includes("unverified") ||
    code.includes("aborted") ||
    code.includes("handoff") ||
    code.includes("integration") ||
    code.includes("unavailable")
  );
}

function poolForModel(
  model: string,
  free: readonly string[],
  goOpenai: readonly string[],
  goAnthropic: readonly string[],
): DelegateModelPool {
  // Free-list membership wins: goOpenai may include a bare free id solely so
  // isProxyResolvable can route it (see free-pool resolvability tests).
  if ((free as readonly string[]).includes(model)) return "free";
  if ((goOpenai as readonly string[]).includes(model) || (goAnthropic as readonly string[]).includes(model)) {
    return "go_capable";
  }
  return "free";
}

/**
 * Free lane is earned (W1.3): not benched AND at least one verified write.
 * Unseen free models are not auto-selected until they prove a write
 * (operator pin can still force them). Seeded free with verifiedWrites > 0
 * remains eligible but ranks below higher-evidence Go unless it beats best Go.
 */
export function isEarnedFreeDelegateModel(model: string): boolean {
  ensureDelegateWriteScoreboardHydrated();
  const entry = writeScoreboard.get(model.trim());
  if (!entry || entry.benched) return false;
  return entry.verifiedWrites > 0;
}

export function selectDelegateModel(input: {
  configuredModel: string;
  thrashCount: number;
  thrashThreshold?: number;
  /** Local claude_cli_proxy on :19878 (required for free + OpenAI-format Go). */
  proxyAvailable?: boolean;
  /** OpenCode Go API key present (required for Anthropic-native Go). */
  hasOpenCodeGoKey?: boolean;
  freeModels?: readonly string[];
  goOpenaiModels?: readonly string[];
  goAnthropicModels?: readonly string[];
  /** Ollama tags, for resolving bare model ids. Empty means "none installed". */
  installedOllamaModels?: readonly string[];
  /** Models with repeated launches and zero verified writes. */
  benchedModels?: readonly string[];
}): DelegateModelSelection {
  ensureDelegateWriteScoreboardHydrated();

  const threshold = input.thrashThreshold ?? policy().default_free_thrash_threshold;
  const free = input.freeModels ?? DELEGATE_FREE_FIRST_MODELS;
  const goOpenai = input.goOpenaiModels ?? DELEGATE_GO_OPENAI_MODELS;
  const goAnthropic = input.goAnthropicModels ?? DELEGATE_GO_ANTHROPIC_MODELS;
  const installed = input.installedOllamaModels ?? [];
  const benched = new Set([
    ...(input.benchedModels ?? []),
    ...getBenchedDelegateModels(),
  ].map((model) => model.trim()).filter(Boolean));

  // Two independent reasons a free lane is not actually usable: the proxy
  // cannot route it, or the model cannot emit a tool call. Both cost a whole
  // turn plus a fallback. W1.3: also require non-benched (earned free lane).
  const resolvableFree = free.filter((model) =>
    !benched.has(model) &&
    isEarnedFreeDelegateModel(model) &&
    isProxyResolvable(model, installed, goOpenai) &&
    isToolCallCapableDelegate(model));
  const proxyOk = input.proxyAvailable !== false;
  const goKey = input.hasOpenCodeGoKey !== false;
  const configured = input.configuredModel.trim();
  const configuredBenched = Boolean(configured && benched.has(configured));
  const auto = !configured || configured.toLowerCase() === "auto" || configuredBenched;
  const thrash = input.thrashCount;

  const capableGoOpenai = proxyOk
    ? goOpenai.filter((model) => !benched.has(model))
    : [];
  // W1.2: Anthropic-native Go needs only the Go key — proxy up must not exclude it.
  const capableGoAnthropic = goKey
    ? goAnthropic.filter((model) => !benched.has(model))
    : [];
  const capableFree = proxyOk ? resolvableFree : [];

  const pickFromOrdered = (
    ordered: readonly string[],
    reason: string,
    index = 0,
  ): DelegateModelSelection => {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const model of ordered) {
      if (seen.has(model)) continue;
      seen.add(model);
      deduped.push(model);
    }
    if (deduped.length === 0) {
      return {
        model: "minimax-m3",
        pool: "go_capable",
        reason: `${reason}_fallback_minimax`,
        thrashCount: thrash,
      };
    }
    const idx = Math.min(Math.max(0, index), deduped.length - 1);
    const model = deduped[idx]!;
    return {
      model,
      pool: poolForModel(model, free, goOpenai, goAnthropic),
      reason,
      thrashCount: thrash,
    };
  };

  /**
   * Go-capable pick: rank OpenAI Go + Anthropic Go by write evidence.
   * Proxy availability only gates the OpenAI Go lane; Anthropic stays eligible
   * whenever the Go key is present (W1.2).
   */
  const pickGo = (reason: string, index = 0): DelegateModelSelection => {
    const candidates = rankModelsByWriteEvidence([
      ...capableGoOpenai,
      ...capableGoAnthropic,
    ]);
    // When proxy is down, capableGoOpenai is empty; anthropic-only path.
    const annotatedReason =
      !proxyOk && capableGoAnthropic.length > 0 && capableGoOpenai.length === 0
        ? `${reason}_anthropic_no_proxy`
        : reason;
    return pickFromOrdered(candidates, annotatedReason, index);
  };

  if (thrash >= threshold) {
    // Thrash promotion: evidence-ranked among Go-capable only (drop free).
    // Index by thrash so repeated failures walk the ranked Go list.
    return pickGo(`thrash_promoted_after_${thrash}`, thrash - threshold);
  }

  // No proxy → free/OpenAI Go cannot launch; jump to Anthropic Go if possible.
  if (!proxyOk) {
    if (!auto && configured) {
      return pickGo("no_proxy_promote_go");
    }
    return pickGo("no_proxy_go_first");
  }

  if (!auto) {
    const pinnedIsGo =
      goOpenai.includes(configured as typeof goOpenai[number]) ||
      goAnthropic.includes(configured as typeof goAnthropic[number]);
    return {
      model: configured,
      pool: pinnedIsGo ? "go_capable" : "free",
      reason: configuredBenched ? "operator_pin_benched_promote" : "operator_pin",
      thrashCount: thrash,
    };
  }

  // Auto under thrash threshold: Go first by evidence; earned free only above
  // Go when free rate strictly exceeds best Go (rankDelegateAutoCandidates).
  const goEligible = [...capableGoOpenai, ...capableGoAnthropic];
  if (capableFree.length === 0 && goEligible.length === 0) {
    return pickGo("no_free_candidates");
  }
  const ordered = rankDelegateAutoCandidates(capableFree, goEligible);
  return pickFromOrdered(
    ordered,
    thrash === 0 ? "write_evidence" : `write_evidence_rotate_${thrash}`,
    thrash,
  );
}

/**
 * Build ordered candidate models to try until CLI availability succeeds.
 * Starts at current thrash selection and walks the evidence-ranked list,
 * then appends remaining Go / free candidates so availability probing can
 * exhaust the full capable set.
 */
export function enumerateDelegateModelCandidates(input: {
  configuredModel: string;
  thrashCount: number;
  thrashThreshold?: number;
  proxyAvailable?: boolean;
  hasOpenCodeGoKey?: boolean;
  benchedModels?: readonly string[];
  freeModels?: readonly string[];
  goOpenaiModels?: readonly string[];
  goAnthropicModels?: readonly string[];
}): DelegateModelSelection[] {
  ensureDelegateWriteScoreboardHydrated();
  const threshold = input.thrashThreshold ?? policy().default_free_thrash_threshold;
  const free = input.freeModels ?? DELEGATE_FREE_FIRST_MODELS;
  const goOpenai = input.goOpenaiModels ?? DELEGATE_GO_OPENAI_MODELS;
  const goAnthropic = input.goAnthropicModels ?? DELEGATE_GO_ANTHROPIC_MODELS;
  // Walk enough thrash steps to cover free + go openai + go anthropic.
  const maxThrash = Math.max(
    input.thrashCount,
    threshold,
    free.length + goOpenai.length + goAnthropic.length,
  ) + 1;
  const seen = new Set<string>();
  const out: DelegateModelSelection[] = [];
  for (let t = input.thrashCount; t <= maxThrash; t++) {
    const sel = selectDelegateModel({ ...input, thrashCount: t });
    if (seen.has(sel.model)) continue;
    seen.add(sel.model);
    out.push(sel);
  }

  const benched = new Set((input.benchedModels ?? []).map((m) => m.trim()));
  const pushIfNew = (model: string, pool: DelegateModelPool, reason: string) => {
    if (benched.has(model) || seen.has(model)) return;
    out.push({ model, pool, reason, thrashCount: input.thrashCount });
    seen.add(model);
  };

  // Remaining OpenAI Go (proxy path) in write-evidence order.
  if (input.proxyAvailable !== false) {
    for (const model of rankModelsByWriteEvidence(goOpenai)) {
      pushIfNew(model, "go_capable", "go_openai_fallback");
    }
  }

  // Anthropic Go fallback when key exists (no-proxy launch path too).
  if (input.hasOpenCodeGoKey !== false) {
    for (const model of rankModelsByWriteEvidence(goAnthropic)) {
      pushIfNew(model, "go_capable", "anthropic_go_fallback");
    }
  }

  // Remaining earned free models (proxy path).
  if (input.proxyAvailable !== false) {
    for (const model of rankModelsByWriteEvidence(free)) {
      if (!isToolCallCapableDelegate(model)) continue;
      if (!isEarnedFreeDelegateModel(model)) continue;
      pushIfNew(model, "free", "free_fallback");
    }
  }

  return out;
}
