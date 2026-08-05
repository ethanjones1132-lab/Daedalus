/**
 * Executor-stage health signals used to demote models that burn turns.
 *
 * Measured 2026-07-20 → 08-05: 44% of executor turns (942/2130) emitted no tool
 * call at all, costing 9,883s of 51,339s total stage time. Selection has never
 * consumed this signal — `docs/delegate-era-baseline.md` lists it as the open
 * W3.4 TODO. Per-model rates only became computable once attributions carried
 * a stage_run_id (Task 1).
 */

import { BASELINE_THETA, policy } from "./orchestration-policy";

/** Executor turns a model needs before its no-tool rate is actionable. */
export const MIN_NO_TOOL_SAMPLE = BASELINE_THETA.min_no_tool_sample;

/**
 * No-tool rate above which a model stops being a preferred executor pick.
 * Set above the 44% fleet average so this demotes the tail, not the field —
 * demoting everything would empty the pool.
 */
export const NO_TOOL_DEMOTION_THRESHOLD = BASELINE_THETA.no_tool_demotion_threshold;

export interface NoToolStats {
  noToolTurns: number;
  executorTurns: number;
}

export function shouldDemoteForNoTool(stats: NoToolStats): boolean {
  if (stats.executorTurns < policy().min_no_tool_sample) return false;
  return stats.noToolTurns / stats.executorTurns > policy().no_tool_demotion_threshold;
}

const noToolStats = new Map<string, NoToolStats>();

function modelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** Record one executor stage outcome for a model. Call where stage rows are written. */
export function recordExecutorTurn(
  provider: string,
  modelId: string,
  emittedToolCall: boolean,
): void {
  const key = modelKey(provider, modelId);
  const e = noToolStats.get(key) ?? { noToolTurns: 0, executorTurns: 0 };
  e.executorTurns++;
  if (!emittedToolCall) e.noToolTurns++;
  noToolStats.set(key, e);
}

export function noToolStatsFor(provider: string, modelId: string): NoToolStats {
  return noToolStats.get(modelKey(provider, modelId)) ?? { noToolTurns: 0, executorTurns: 0 };
}

/** Calls before an error rate is actionable. */
export const MIN_ERROR_RATE_SAMPLE = BASELINE_THETA.min_error_rate_sample;

/**
 * Error rate above which a model is benched outright. Deliberately high: this
 * targets models that are broken (claude_cli:cohere/north-mini-code:free at
 * 91%, claude_cli:gemma4:e2b at 85%), not merely unreliable
 * (nemotron-3-ultra-free at 20% stays in the pool).
 */
export const ERROR_RATE_BENCH_THRESHOLD = BASELINE_THETA.error_rate_bench_threshold;

export interface ErrorRateStats {
  errors: number;
  calls: number;
}

export function shouldBenchForErrorRate(stats: ErrorRateStats): boolean {
  if (stats.calls < policy().min_error_rate_sample) return false;
  return stats.errors / stats.calls > policy().error_rate_bench_threshold;
}

/**
 * Process-local error aggregates.
 * - `errorRateByProviderModel` is keyed `provider:modelId` for pool diagnostics.
 * - `errorRateByModel` is keyed by bare model id for delegate selection (model
 *   ids themselves often contain colons, e.g. `cohere/north-mini-code:free`).
 */
const errorRateByProviderModel = new Map<string, ErrorRateStats>();
const errorRateByModel = new Map<string, ErrorRateStats>();

function bumpErrorStats(
  map: Map<string, ErrorRateStats>,
  key: string,
  hadError: boolean,
): void {
  const e = map.get(key) ?? { errors: 0, calls: 0 };
  e.calls++;
  if (hadError) e.errors++;
  map.set(key, e);
}

/** Record one model call outcome for error-rate benching. */
export function recordModelCall(
  provider: string,
  modelId: string,
  hadError: boolean,
): void {
  const normalized = modelId.trim();
  if (!normalized) return;
  bumpErrorStats(errorRateByProviderModel, modelKey(provider, normalized), hadError);
  // Bare model id so delegate selection (which keys on model only) can consume
  // the same process-local evidence.
  bumpErrorStats(errorRateByModel, normalized, hadError);
}

/**
 * Look up error stats. Prefer `provider:modelId` when both are known; bare
 * `modelId` is accepted for delegate scoreboard union.
 */
export function errorStatsFor(provider: string, modelId: string): ErrorRateStats {
  const keyed = errorRateByProviderModel.get(modelKey(provider, modelId));
  if (keyed) return keyed;
  return errorRateByModel.get(modelId.trim()) ?? { errors: 0, calls: 0 };
}

export function errorStatsForModel(modelId: string): ErrorRateStats {
  return errorRateByModel.get(modelId.trim()) ?? { errors: 0, calls: 0 };
}

/**
 * Model ids currently over the error-rate bench threshold (bare ids so they
 * match `getBenchedDelegateModels` / free-pool keys).
 */
export function modelsBenchedForErrorRate(): string[] {
  const out: string[] = [];
  for (const [model, stats] of errorRateByModel) {
    if (shouldBenchForErrorRate(stats)) out.push(model);
  }
  return out;
}

/** Test helper: clear process-local health aggregates. */
export function __resetModelHealthForTests(): void {
  noToolStats.clear();
  errorRateByProviderModel.clear();
  errorRateByModel.clear();
}
