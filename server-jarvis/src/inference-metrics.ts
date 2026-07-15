// ═══════════════════════════════════════════════════════════════
// Inference metrics — in-process ring buffer (Phase 2.3)
// ═══════════════════════════════════════════════════════════════
//
// Keeps the last RING_SIZE per-request observations in memory with zero
// external dependencies. Consumed by GET /health/inference so the UI
// (SystemHealthView) can show per-backend latency/error/usage without
// reading log files.
//
// Call `recordInference` at the end of each successful or failed inference
// turn. Read the snapshot with `inferenceMetricsSnapshot`.
//
// Track A (Conductor Evolution): the snapshot also folds in the conductor
// KV/prefix-reuse window from `./orchestration/conductor-metrics` so the
// same dashboard can show "is the warm Ollama conductor actually reusing
// its prefix on turn 2+?" without a second fetch. The import is
// dependency-safe: conductor-metrics does not import inference-metrics
// (verified — the dependency graph is one-way).

// The set of backends the inference observability layer tracks. OpenCode Zen
// and OpenCode Go were added to the orchestrator's pool on 2026-06-24 — the
// `Backend` type must enumerate them so `recordInference` can attribute the
// actual provider used for each turn (instead of falling back to
// `cfg.active_backend`, which is the user's *selected* backend, not the
// provider the orchestrator's pool routed through). The CLI agent-loop path
// still only emits "ollama" / "openrouter" / "claude_cli" — those are the
// three the legacy `cfg.active_backend` value can be.
import {
  conductorCacheSnapshot,
  type ConductorCacheRecord,
} from "./orchestration/conductor-metrics";

export type Backend = "ollama" | "openrouter" | "claude_cli" | "opencode_zen" | "opencode_go";

/**
 * Map a provider string from the orchestrator's pool (`poolProvider`,
 * `actualProviderUsed`) to the `Backend` enum used by `recordInference`. The
 * pool emits provider names from `OrchestratorAgent.provider` (openrouter,
 * opencode_zen, opencode_go); `cfg.active_backend` emits the three legacy
 * "selected backend" values (ollama, openrouter, claude_cli). The two sets
 * overlap on "openrouter" and "ollama" but the opencode providers are pool-
 * only and would otherwise be silently re-bucketed to "openrouter" by an
 * unguarded cast.
 *
 * The optional `fallback` covers the case where the orchestrator failed
 * before it ever recorded a provider (network unreachable on the first
 * attempt, config not loaded, etc.) — we fall back to the user's selected
 * backend rather than fabricating a value.
 */
export function backendForProvider(
  provider: string | undefined,
  fallback?: string,
): Backend {
  switch (provider) {
    case "ollama":
    case "openrouter":
    case "claude_cli":
    case "opencode_zen":
    case "opencode_go":
      return provider;
    default:
      if (fallback === "ollama") return "ollama";
      if (fallback === "claude_cli") return "claude_cli";
      return "openrouter";
  }
}

export interface InferenceRecord {
  ts: number;       // unix ms
  backend: Backend;
  model: string;
  ok: boolean;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  error?: string;   // set when ok=false
  fallback_used?: boolean;
  /** OpenRouter fallback-chain retry count for this turn (0 = primary succeeded). */
  retry_count?: number;
  /** Model actually used when a fallback chain was engaged. */
  fallback_model?: string;
}

export type InferenceAttemptOutcome =
  | "success"
  | "truncated"
  | "first_token_timeout"
  | "stream_idle_timeout"
  | "visible_progress_timeout"
  | "degenerate_stream"
  | "empty_completion"
  | "http_error";

export interface InferenceAttemptRecord {
  ts: number;
  session_id?: string;
  run_id?: string;
  stage: string;
  provider: Backend;
  model: string;
  outcome: InferenceAttemptOutcome;
  latency_ms: number;
  first_token_ms?: number;
  fallback_attempt: number;
}

const RING_SIZE = 200;
const ring: InferenceRecord[] = [];
let ringHead = 0;
const attemptRing: InferenceAttemptRecord[] = [];
let attemptRingHead = 0;

export function recordInference(rec: InferenceRecord): void {
  ring[ringHead % RING_SIZE] = rec;
  ringHead += 1;
}

export function recordInferenceAttempt(rec: InferenceAttemptRecord): void {
  attemptRing[attemptRingHead % RING_SIZE] = rec;
  attemptRingHead += 1;
}

/** Ordered oldest→newest snapshot of up to RING_SIZE recent records. */
function ringSnapshot(): InferenceRecord[] {
  if (ringHead < RING_SIZE) return ring.slice(0, ringHead);
  const tail = ringHead % RING_SIZE;
  return [...ring.slice(tail), ...ring.slice(0, tail)];
}

function attemptRingSnapshot(): InferenceAttemptRecord[] {
  if (attemptRingHead < RING_SIZE) return attemptRing.slice(0, attemptRingHead);
  const tail = attemptRingHead % RING_SIZE;
  return [...attemptRing.slice(tail), ...attemptRing.slice(0, tail)];
}

export interface BackendStats {
  backend: Backend;
  requests: number;
  errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  last_error?: string;
  last_model?: string;
  last_ts?: number;
  /** Total retry attempts across all records for this backend (0 = no retries). */
  total_retries: number;
  /** Number of turns that engaged a fallback model. */
  fallbacks_used: number;
  last_fallback_model?: string;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[i];
}

export interface ConductorCacheSummary {
  /** Number of conductor turns in the rolling window (0 = no turns observed yet). */
  window_size: number;
  /** Fraction of turns where the warm Ollama conductor reused its prefix (0..1). */
  cache_hit_rate: number;
  /** Average prefix tokens that had to be recomputed across the window (lower = better reuse). */
  avg_prefix_recomputed: number;
  /** Last 20 raw records, oldest→newest, for drill-down. */
  records: ConductorCacheRecord[];
  /** Unix ms when this snapshot was generated. */
  generated_at: number;
}

export interface InferenceMetricsSnapshot {
  window_size: number;
  backends: BackendStats[];
  generated_at: number;
  recent_attempts: InferenceAttemptRecord[];
  /**
   * Conductor KV/prefix-reuse observability (Track A). `null` when no
   * conductor turns have been recorded yet in this Bun process — the UI
   * should render an empty/disabled state, not a "0% hit rate" that looks
   * like a real measurement.
   */
  conductor_cache: ConductorCacheSummary | null;
}

export function inferenceMetricsSnapshot(): InferenceMetricsSnapshot {
  const records = ringSnapshot();
  const byBackend = new Map<Backend, InferenceRecord[]>();
  for (const r of records) {
    const arr = byBackend.get(r.backend) ?? [];
    arr.push(r);
    byBackend.set(r.backend, arr);
  }

  const stats: BackendStats[] = [];
  for (const [backend, recs] of byBackend) {
    const errors = recs.filter((r) => !r.ok);
    const latencies = recs.map((r) => r.latency_ms).sort((a, b) => a - b);
    const last = recs[recs.length - 1];
    const retriesList = recs.map((r) => r.retry_count ?? 0);
    const totalRetries = retriesList.reduce((s, r) => s + r, 0);
    const fallbacksUsed = recs.filter((r) => !!r.fallback_used).length;
    const lastFallbackM = recs.filter((r) => r.fallback_model).map((r) => r.fallback_model).pop();
    stats.push({
      backend,
      requests: recs.length,
      errors: errors.length,
      error_rate: recs.length ? errors.length / recs.length : 0,
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
      total_tokens_in: recs.reduce((s, r) => s + r.tokens_in, 0),
      total_tokens_out: recs.reduce((s, r) => s + r.tokens_out, 0),
      last_error: errors.at(-1)?.error,
      last_model: last?.model,
      last_ts: last?.ts,
      total_retries: totalRetries,
      fallbacks_used: fallbacksUsed,
      last_fallback_model: lastFallbackM,
    });
  }

  // Conductor cache is a module-singleton ring in conductor-metrics.ts.
  // When no turns have been recorded yet, window_size is 0 — we surface
  // `null` so the UI shows a "no data" state instead of a fake "0% hit rate"
  // that looks like a real (bad) measurement.
  const conductorSnap = conductorCacheSnapshot();
  const conductor_cache: ConductorCacheSummary | null = conductorSnap.window_size === 0
    ? null
    : {
      window_size: conductorSnap.window_size,
      cache_hit_rate: conductorSnap.cache_hit_rate,
      avg_prefix_recomputed: conductorSnap.avg_prefix_recomputed,
      records: conductorSnap.records,
      generated_at: conductorSnap.generated_at,
    };

  return {
    window_size: records.length,
    backends: stats,
    generated_at: Date.now(),
    recent_attempts: attemptRingSnapshot().slice(-30),
    conductor_cache,
  };
}
