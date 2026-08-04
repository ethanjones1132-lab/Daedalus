// ═══════════════════════════════════════════════════════════════
// ── Frontier harness metrics (Part IV verification) ───────────
// ═══════════════════════════════════════════════════════════════
//
// Pure aggregation over stored agent_runs + stage_runs. Complements the
// release-gate metrics in conductor-performance.ts with wall-clock and
// throughput diagnostics used by the conductor-completion benchmark CLI.
//
// Fields:
//   avg_run_wall_clock         — mean agent_runs.duration_ms (or stage sum)
//   round_trips_per_run        — stage_runs count / runs
//   time_to_first_visible_token — best-effort: run.created_at → first
//                                 synthesizer stage created_at offset; null
//                                 when not computable (no stream TTFT in DB)
//   cache_hit_rate             — 0 until durable per-run cache signals are
//                                 aggregated (M2 logs/probes cached_tokens;
//                                 field always present)

/** Minimal run shape for frontier aggregation (matches self-tuning rows). */
export interface FrontierMetricsRun {
  duration_ms?: number | null;
  created_at?: string | null;
  stageRuns: readonly FrontierMetricsStage[];
}

export interface FrontierMetricsStage {
  mode_id: string;
  duration_ms?: number | null;
  created_at?: string | null;
}

export interface FrontierMetricsSummary {
  /** Mean wall-clock ms per run; null when no duration signal exists. */
  avg_run_wall_clock: number | null;
  /** stage_runs / runs; null when there are no runs. */
  round_trips_per_run: number | null;
  /**
   * Mean ms from agent_run.created_at to first synthesizer stage.created_at
   * when both timestamps parse. Null when not computable.
   *
   * Note: this is a proxy for "time to first user-visible answer stage",
   * not stream first-token latency (first_token_ms lives on attributions and
   * is stage-scoped, not run-scoped). Documented as stub/proxy until a
   * run-level visible-token timestamp is persisted.
   */
  time_to_first_visible_token: number | null;
  /**
   * Conductor / prompt-prefix cache hit rate. Hard-coded 0 until durable
   * per-run cache signals (M2 currently probes/logs cached_tokens on the
   * response path) are aggregated into fixtures. Field always present.
   */
  cache_hit_rate: number;
}

function finiteMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseIsoMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Prefer agent_runs.duration_ms; fall back to sum of stage duration_ms. */
function runWallClockMs(run: FrontierMetricsRun): number | undefined {
  const direct = finiteMs(run.duration_ms);
  if (direct !== undefined) return direct;
  let sum = 0;
  let any = false;
  for (const stage of run.stageRuns) {
    const d = finiteMs(stage.duration_ms);
    if (d !== undefined) {
      sum += d;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/**
 * Proxy TTFT: earliest synthesizer stage created_at minus run created_at.
 * Returns undefined when either timestamp is missing or the delta is negative.
 */
function runTimeToFirstVisibleTokenMs(run: FrontierMetricsRun): number | undefined {
  const runStart = parseIsoMs(run.created_at);
  if (runStart === undefined) return undefined;
  let best: number | undefined;
  for (const stage of run.stageRuns) {
    if (stage.mode_id !== "synthesizer") continue;
    const stageAt = parseIsoMs(stage.created_at);
    if (stageAt === undefined) continue;
    const delta = stageAt - runStart;
    if (delta < 0) continue;
    if (best === undefined || delta < best) best = delta;
  }
  return best;
}

export function summarizeFrontierMetrics(
  runs: readonly FrontierMetricsRun[],
): FrontierMetricsSummary {
  const n = runs.length;
  if (n === 0) {
    return {
      avg_run_wall_clock: null,
      round_trips_per_run: null,
      time_to_first_visible_token: null,
      cache_hit_rate: 0,
    };
  }

  let wallSum = 0;
  let wallCount = 0;
  let stageCount = 0;
  let ttftSum = 0;
  let ttftCount = 0;

  for (const run of runs) {
    stageCount += run.stageRuns.length;
    const wall = runWallClockMs(run);
    if (wall !== undefined) {
      wallSum += wall;
      wallCount += 1;
    }
    const ttft = runTimeToFirstVisibleTokenMs(run);
    if (ttft !== undefined) {
      ttftSum += ttft;
      ttftCount += 1;
    }
  }

  return {
    avg_run_wall_clock: wallCount > 0 ? wallSum / wallCount : null,
    round_trips_per_run: stageCount / n,
    time_to_first_visible_token: ttftCount > 0 ? ttftSum / ttftCount : null,
    // Durable per-run cache aggregation not yet wired — keep the field, zero the rate.
    cache_hit_rate: 0,
  };
}
