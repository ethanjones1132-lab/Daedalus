/**
 * Self-tuning proposal measurement — the pure decision.
 *
 * An applied tuning proposal opens a comparison: the post-apply success rate of
 * its task_type against the rate captured at apply time. Two defects made that
 * comparison able to report a conclusion it did not have:
 *
 *  1. `successRateOfRuns` scored a completed run with neither an `outcome` nor a
 *     rating as a success, so a pre-migration backlog read as 100%.
 *  2. A missing baseline was read as a real zero (`prop.baseline_success_rate ??
 *     0`), so any non-zero post-apply rate was `improved`.
 *
 * This module owns the one question "what can be said about this proposal?".
 * Three states, and only `measured` may carry a verdict:
 *
 *   measured             post-apply known outcomes ≥ minSamples, baseline available
 *   awaiting_samples     the post-apply window cannot say anything yet
 *   baseline_unavailable the apply-time baseline was never measured
 *
 * Writing no outcome row for the two non-measured states is deliberate: a
 * `tuning_outcomes` row is the record of a conclusion, and these states have no
 * conclusion to record. The read path (`/tuning/proposals`) states the same
 * decision per proposal so the wait is visible instead of silent.
 */

import { successRateOfRuns, type AgentRun, type TuningOutcome, type TuningProposal } from "./store";

/** Default post-apply completed runs required before writing an outcome. */
export const DEFAULT_MIN_POST_APPLY_SAMPLES = 3;

export type TuningMeasurementState =
  | "measured"
  | "awaiting_samples"
  | "baseline_unavailable";

/** Stable machine-readable cause. Never prose, never a raw DB error. */
export type TuningMeasurementReason =
  | "post_apply_samples_below_minimum"
  | "post_apply_outcomes_unknown"
  | "baseline_unavailable";

export interface ProposalMeasurement {
  state: TuningMeasurementState;
  reason: TuningMeasurementReason | null;
  /** Post-apply success rate over known runs (0..1); null unless measurable. */
  measured: number | null;
  /** Apply-time success rate (0..1); null when it was never measurable. */
  baseline: number | null;
  /** 1 when measured > baseline, 0 when not; null when no comparison was made. */
  improved: number | null;
  /** Completed post-apply runs in the window. */
  sample_n: number;
  /** Completed post-apply runs with a known outcome; null for a recorded row. */
  known_n: number | null;
  /** Completed post-apply runs with neither an outcome nor a rating; null for a recorded row. */
  unknown_n: number | null;
  /** Evidence floor the window was held to. */
  minSamples: number;
  /** When the conclusion was written; null until it is. */
  measured_at: string | null;
  /** When the proposal was applied; null when never applied. */
  applied_at: string | null;
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
  all: AgentRun[],
  prop: TuningProposal,
): AgentRun[] {
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

export interface ProposalMeasurementInput {
  proposal: TuningProposal;
  /** The recorded `tuning_outcomes` row, when one exists. */
  outcome: TuningOutcome | null;
  /** Every completed run of the proposal's task_type, oldest-first. */
  completedRuns: AgentRun[];
  minSamples?: number;
}

/**
 * Decide what may be said about one applied (or unapplied) tuning proposal.
 * Pure: no clock, no store, no I/O.
 */
export function decideProposalMeasurement(
  input: ProposalMeasurementInput,
): ProposalMeasurement {
  const { proposal, outcome } = input;
  const minSamples = Math.max(1, Math.floor(input.minSamples ?? DEFAULT_MIN_POST_APPLY_SAMPLES));

  // A recorded conclusion is the authority for its own numbers: the window has
  // grown since it was written, so re-deriving it here would report a different
  // rate than the row an operator can read.
  if (outcome) {
    return {
      state: "measured",
      reason: null,
      measured: outcome.measured ?? null,
      baseline: outcome.baseline ?? null,
      improved: outcome.improved ?? null,
      sample_n: outcome.sample_n ?? 0,
      known_n: null,
      unknown_n: null,
      minSamples,
      measured_at: outcome.measured_at ?? null,
      applied_at: proposal.applied_at ?? null,
    };
  }

  const post = postApplyRuns(input.completedRuns, proposal);
  const dial = successRateOfRuns(post);
  const baseline = proposal.baseline_success_rate ?? null;

  const shared = {
    baseline,
    sample_n: dial.sample_n,
    known_n: dial.known_n,
    unknown_n: dial.unknown_n,
    minSamples,
    measured_at: null,
    applied_at: proposal.applied_at ?? null,
  };

  // The evidence floor is a floor on *known* outcomes. A window whose
  // denominator would silently drop unrated runs is not a measurement, and its
  // share of unknown runs is reported rather than hidden.
  if (dial.known_n < minSamples) {
    return {
      ...shared,
      state: "awaiting_samples",
      reason:
        dial.unknown_n > 0
          ? "post_apply_outcomes_unknown"
          : "post_apply_samples_below_minimum",
      measured: null,
      improved: null,
    };
  }

  if (baseline == null) {
    return {
      ...shared,
      state: "baseline_unavailable",
      reason: "baseline_unavailable",
      measured: dial.rate,
      improved: null,
    };
  }

  return {
    ...shared,
    state: "measured",
    reason: null,
    measured: dial.rate,
    improved: dial.rate > baseline ? 1 : 0,
  };
}
