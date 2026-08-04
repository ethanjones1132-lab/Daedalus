/**
 * M7 — close the self-tuning loop.
 *
 * Flow:
 *  1. `applyTuningProposal` marks applied + snapshots baseline success rate
 *  2. Subsequent completed agent runs accumulate for the proposal's task_type
 *  3. Once ≥ minSamples post-apply runs exist, write a `tuning_outcomes` row
 *     with measured vs baseline and improved true/false
 *
 * Call `evaluatePendingTuningOutcomes` from completeAgentRun (or a cron) so
 * outcomes get written without a separate offline job.
 */

import {
  SelfTuningStore,
  successRateOfRuns,
  type TuningOutcome,
  type TuningProposal,
} from "./store";

/** Default post-apply completed runs required before writing an outcome. */
export const DEFAULT_MIN_POST_APPLY_SAMPLES = 3;

export interface EvaluatePendingOptions {
  minSamples?: number;
}

/**
 * For each applied proposal without an outcome yet, if enough post-apply
 * completed runs of the same task_type exist, measure success rate vs the
 * baseline captured at apply time and record a tuning_outcomes row.
 *
 * @returns outcomes written on this pass (empty when nothing was ready).
 */
export function evaluatePendingTuningOutcomes(
  store: SelfTuningStore,
  opts: EvaluatePendingOptions = {},
): TuningOutcome[] {
  const minSamples = Math.max(1, opts.minSamples ?? DEFAULT_MIN_POST_APPLY_SAMPLES);
  const pending = store.getProposalsPendingMeasurement();
  const written: TuningOutcome[] = [];

  for (const prop of pending) {
    const outcome = maybeMeasureProposal(store, prop, minSamples);
    if (outcome) written.push(outcome);
  }
  return written;
}

function parsePreApplyRunIds(prop: TuningProposal): Set<string> | null {
  if (!prop.pre_apply_run_ids) return null;
  try {
    const parsed = JSON.parse(prop.pre_apply_run_ids) as unknown;
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.map(String));
  } catch {
    return null;
  }
}

/** Completed runs for task_type that were not part of the apply-time baseline set. */
export function postApplyRuns(
  all: ReturnType<SelfTuningStore["getCompletedAgentRunsForTaskType"]>,
  prop: TuningProposal,
): ReturnType<SelfTuningStore["getCompletedAgentRunsForTaskType"]> {
  const priorIds = parsePreApplyRunIds(prop);
  if (priorIds) {
    return all.filter((r) => !priorIds.has(r.id));
  }
  // Legacy fallbacks when pre_apply_run_ids is missing.
  if (prop.pre_apply_run_count != null) {
    return all.slice(prop.pre_apply_run_count);
  }
  if (prop.applied_at) {
    return all.filter((r) => (r.created_at ?? "") > prop.applied_at!);
  }
  return [];
}

function maybeMeasureProposal(
  store: SelfTuningStore,
  prop: TuningProposal,
  minSamples: number,
): TuningOutcome | null {
  const all = store.getCompletedAgentRunsForTaskType(prop.task_type);
  // Prefer id-set captured at apply (immune to same-ms created_at ordering).
  const post = postApplyRuns(all, prop);

  if (post.length < minSamples) return null;

  const measured = successRateOfRuns(post);
  const baseline = prop.baseline_success_rate ?? 0;
  const improved = measured.rate > baseline;
  const notes =
    `task_type=${prop.task_type} proposal_type=${prop.proposal_type}: ` +
    `post-apply success_rate=${measured.rate.toFixed(3)} vs baseline=${baseline.toFixed(3)} ` +
    `over sample_n=${measured.sample_n} (min=${minSamples})`;

  return store.recordTuningOutcome(prop.id, {
    measured: measured.rate,
    baseline,
    improved,
    sample_n: measured.sample_n,
    notes,
  });
}
