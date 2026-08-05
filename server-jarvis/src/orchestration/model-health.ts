/**
 * Executor-stage health signals used to demote models that burn turns.
 *
 * Measured 2026-07-20 → 08-05: 44% of executor turns (942/2130) emitted no tool
 * call at all, costing 9,883s of 51,339s total stage time. Selection has never
 * consumed this signal — `docs/delegate-era-baseline.md` lists it as the open
 * W3.4 TODO. Per-model rates only became computable once attributions carried
 * a stage_run_id (Task 1).
 */

/** Executor turns a model needs before its no-tool rate is actionable. */
export const MIN_NO_TOOL_SAMPLE = 12;

/**
 * No-tool rate above which a model stops being a preferred executor pick.
 * Set above the 44% fleet average so this demotes the tail, not the field —
 * demoting everything would empty the pool.
 */
export const NO_TOOL_DEMOTION_THRESHOLD = 0.6;

export interface NoToolStats {
  noToolTurns: number;
  executorTurns: number;
}

export function shouldDemoteForNoTool(stats: NoToolStats): boolean {
  if (stats.executorTurns < MIN_NO_TOOL_SAMPLE) return false;
  return stats.noToolTurns / stats.executorTurns > NO_TOOL_DEMOTION_THRESHOLD;
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

/** Test helper: clear process-local health aggregates. */
export function __resetModelHealthForTests(): void {
  noToolStats.clear();
}
