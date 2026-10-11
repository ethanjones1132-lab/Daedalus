// ═══════════════════════════════════════════════════════════════
// ── health-format — pure shapes, parsers and formatters for the Health page
// ═══════════════════════════════════════════════════════════════
//
// No React, no Tauri. Moved from the legacy orphaned `SystemHealthView`; the
// shapes mirror `server-jarvis/src/inference-metrics.ts` and the Rust
// `get_doctor_report` command.

import type { Tone } from '../../design';
import type { JarvisStatus } from '../../domain/types';

// ── Bun server telemetry ───────────────────────────────────────

export interface BackendStats {
  backend: string;
  requests?: number;
  errors?: number;
  error_rate?: number;
  p50_ms: number;
  p95_ms: number;
  total_tokens_in?: number;
  total_tokens_out?: number;
  last_error?: string;
  last_model?: string;
}

export interface InferenceAttempt {
  ts?: number;
  session_id?: string;
  run_id?: string;
  stage: string;
  provider: string;
  model: string;
  outcome: string;
  latency_ms: number;
  first_token_ms?: number;
  fallback_attempt: number;
}

export interface ConductorCacheRecord {
  ts?: number;
  conductor_cache_hit?: boolean;
  prefix_tokens_recomputed?: number;
}

export interface ConductorCacheSummary {
  window_size: number;
  cache_hit_rate: number;
  avg_prefix_recomputed: number;
  records: ConductorCacheRecord[];
  generated_at: number;
}

export interface ConductorDirectiveSummary {
  window_size: number;
  by_type: Record<string, number>;
  records: unknown[];
  generated_at: number;
}

export interface RuntimePerformanceSnapshot {
  event_loop_delay_ms?: { p95?: number; p99?: number };
  event_loop_utilization?: number;
  rss_bytes?: number;
}

export interface InferenceMetrics {
  window_size: number;
  backends: BackendStats[];
  generated_at: number;
  recent_attempts: InferenceAttempt[];
  runtime?: RuntimePerformanceSnapshot;
  /** `null` until a conductor turn has been recorded, so "no data" is distinct from a bad measurement. */
  conductor_cache?: ConductorCacheSummary | null;
}

export interface ConductorReadiness {
  enabled: boolean;
  state: 'pending' | 'warming' | 'ready' | 'degraded' | 'disabled';
  model: string;
  started_at: number | null;
  completed_at: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface ReadinessHealth {
  conductor: ConductorReadiness;
}

export interface RuntimeHealth {
  version?: string;
  model?: string;
  model_resolved?: boolean;
  git_sha?: string;
  built_at?: string;
}

// ── Doctor report ──────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  status: string;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { total: number; ok: number; warn: number; error: number; overall: string };
  timestamp: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A malformed doctor report is a failed read, never an empty checklist. */
export function parseDoctorReport(value: unknown): DoctorReport | null {
  if (!isRecord(value) || !Array.isArray(value.checks) || !isRecord(value.summary)) return null;
  const { summary } = value;
  for (const key of ['total', 'ok', 'warn', 'error'] as const) {
    if (typeof summary[key] !== 'number') return null;
  }
  if (typeof summary.overall !== 'string') return null;
  const checks: DoctorCheck[] = [];
  for (const check of value.checks) {
    if (!isRecord(check) || typeof check.name !== 'string' || typeof check.status !== 'string') return null;
    checks.push({ name: check.name, status: check.status, detail: typeof check.detail === 'string' ? check.detail : '' });
  }
  return {
    checks,
    summary: summary as DoctorReport['summary'],
    timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
  };
}

/** `jarvis_check_status` may omit fields on an older shell, but must name the backend. */
export function parseJarvisStatus(value: unknown): JarvisStatus | null {
  return isRecord(value) && typeof value.active_backend === 'string' ? (value as unknown as JarvisStatus) : null;
}

// ── Bun HTTP payload decoding (tolerant, like the legacy view) ──

export function decodeInferenceMetrics(value: unknown): InferenceMetrics | null {
  if (!isRecord(value) || typeof value.window_size !== 'number') return null;
  const backends = Array.isArray(value.backends) ? value.backends.filter(isRecord) as unknown as BackendStats[] : [];
  const attempts = Array.isArray(value.recent_attempts) ? value.recent_attempts.filter(isRecord) as unknown as InferenceAttempt[] : [];
  const cache = value.conductor_cache;
  return {
    window_size: value.window_size,
    generated_at: typeof value.generated_at === 'number' ? value.generated_at : 0,
    backends,
    recent_attempts: attempts,
    runtime: isRecord(value.runtime) ? (value.runtime as RuntimePerformanceSnapshot) : undefined,
    conductor_cache: isRecord(cache) && typeof cache.cache_hit_rate === 'number'
      ? {
          window_size: typeof cache.window_size === 'number' ? cache.window_size : 0,
          cache_hit_rate: cache.cache_hit_rate,
          avg_prefix_recomputed: typeof cache.avg_prefix_recomputed === 'number' ? cache.avg_prefix_recomputed : 0,
          records: Array.isArray(cache.records) ? cache.records.filter(isRecord) as ConductorCacheRecord[] : [],
          generated_at: typeof cache.generated_at === 'number' ? cache.generated_at : 0,
        }
      : null,
  };
}

export function decodeDirectives(value: unknown): ConductorDirectiveSummary | null {
  if (!isRecord(value) || typeof value.window_size !== 'number' || !isRecord(value.by_type)) return null;
  const byType: Record<string, number> = {};
  for (const [type, count] of Object.entries(value.by_type)) if (typeof count === 'number') byType[type] = count;
  return {
    window_size: value.window_size,
    by_type: byType,
    records: Array.isArray(value.records) ? value.records : [],
    generated_at: typeof value.generated_at === 'number' ? value.generated_at : 0,
  };
}

export function decodeRuntimeHealth(value: unknown): RuntimeHealth | null {
  return isRecord(value) ? (value as RuntimeHealth) : null;
}

export function decodeReadiness(value: unknown): ReadinessHealth | null {
  return isRecord(value) && isRecord(value.conductor) ? (value as unknown as ReadinessHealth) : null;
}

// ── Formatters ─────────────────────────────────────────────────

export function parsePercent(value: string): number {
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/**
 * Map a conductor cache hit rate (0..1) to a tone-bearing variant. The A-02
 * acceptance criterion is >80% prefix reuse on a 3-turn session, so >=0.8 is
 * the "green" target. 0.5..0.8 is amber (a session mixing API + local turns, or
 * still warming). Below 0.5 is red: the warm-conductor machinery is mostly
 * missing, which is the failure mode the metric exists to surface. A corrupt
 * measurement (NaN, infinity, negative) is never allowed to read green.
 */
export function conductorCacheVariant(rate: number): 'success' | 'warn' | 'error' {
  if (!Number.isFinite(rate) || rate < 0) return 'error';
  if (rate >= 0.8) return 'success';
  if (rate >= 0.5) return 'warn';
  return 'error';
}

export function formatRuntimeProvenance(runtime: RuntimeHealth | null): string {
  if (!runtime) return 'Runtime health unavailable';
  const sha = runtime.git_sha ? runtime.git_sha.slice(0, 12) : 'unknown-sha';
  return `${runtime.version ?? 'unknown-version'} · ${sha} · ${runtime.model ?? 'unknown-model'}`;
}

export function formatAttemptSummary(
  attempt: Pick<InferenceAttempt, 'stage' | 'provider' | 'model' | 'outcome' | 'latency_ms'>,
): string {
  return `${attempt.stage} · ${attempt.provider}/${attempt.model} · ${attempt.outcome} · ${attempt.latency_ms}ms`;
}

export function checkTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'pass') return 'ok';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'error' || s === 'fail') return 'error';
  return 'neutral';
}

export function errorRateTone(rate: number | undefined): Tone {
  const r = rate ?? 0;
  return r > 0.1 ? 'error' : r > 0 ? 'warn' : 'ok';
}

/** Cache variant → tone, so the badge and the sparkline agree. */
export function cacheTone(rate: number): Tone {
  const variant = conductorCacheVariant(rate);
  return variant === 'success' ? 'ok' : variant;
}
