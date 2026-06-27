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

export type Backend = "ollama" | "openrouter" | "claude_cli";

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

const RING_SIZE = 200;
const ring: InferenceRecord[] = [];
let ringHead = 0;

export function recordInference(rec: InferenceRecord): void {
  ring[ringHead % RING_SIZE] = rec;
  ringHead += 1;
}

/** Ordered oldest→newest snapshot of up to RING_SIZE recent records. */
function ringSnapshot(): InferenceRecord[] {
  if (ringHead < RING_SIZE) return ring.slice(0, ringHead);
  const tail = ringHead % RING_SIZE;
  return [...ring.slice(tail), ...ring.slice(0, tail)];
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

export interface InferenceMetricsSnapshot {
  window_size: number;
  backends: BackendStats[];
  generated_at: number;
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

  return { window_size: records.length, backends: stats, generated_at: Date.now() };
}
