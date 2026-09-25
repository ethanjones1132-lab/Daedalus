/**
 * M7 — close the self-tuning loop.
 *
 * Flow:
 *  1. `applyTuningProposal` marks applied + snapshots baseline success rate
 *  2. Subsequent completed agent runs accumulate for the proposal's task_type
 *  3. Once ≥ minSamples post-apply runs exist, write a `tuning_outcomes` row
 *     with measured vs baseline and improved true/false
 *
 * A row is written only when `decideProposalMeasurement` can actually compare
 * two rates. A window with too few known outcomes, or a proposal whose baseline
 * was never measurable, stays pending and unmeasured rather than being recorded
 * as an `improved` verdict against a fabricated zero.
 *
 * Call `evaluatePendingTuningOutcomes` from completeAgentRun (or a cron) so
 * outcomes get written without a separate offline job.
 */

import {
  SelfTuningStore,
  type TuningOutcome,
  type TuningProposal,
} from "./store";
import {
  DEFAULT_MIN_POST_APPLY_SAMPLES,
  decideProposalMeasurement,
  postApplyRuns,
} from "./tuning-measurement";

export { DEFAULT_MIN_POST_APPLY_SAMPLES, postApplyRuns };

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

function maybeMeasureProposal(
  store: SelfTuningStore,
  prop: TuningProposal,
  minSamples: number,
): TuningOutcome | null {
  // Prefer id-set captured at apply (immune to same-ms created_at ordering).
  const all = store.getCompletedAgentRunsForTaskType(prop.task_type);
  const verdict = decideProposalMeasurement({ proposal: prop, outcome: null, completedRuns: all, minSamples });

  if (verdict.state !== "measured") {
    // Nothing to conclude yet. The reason is recoverable from the read path
    // (/tuning/proposals) rather than a note on a row that does not exist.
    return null;
  }

  const measured = verdict.measured as number;
  const baseline = verdict.baseline as number;
  const notes =
    `task_type=${prop.task_type} proposal_type=${prop.proposal_type}: ` +
    `post-apply success_rate=${measured.toFixed(3)} vs baseline=${baseline.toFixed(3)} ` +
    `over sample_n=${verdict.sample_n} (min=${minSamples})`;

  return store.recordTuningOutcome(prop.id, {
    measured,
    baseline,
    improved: verdict.improved === 1,
    sample_n: verdict.sample_n,
    notes,
  });
}
