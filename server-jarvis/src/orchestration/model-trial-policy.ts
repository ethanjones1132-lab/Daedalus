/**
 * Give a newly released free model a fair hearing before ranking it.
 *
 * A model discovered from a live catalog gets its capabilities from
 * `inferredCapabilities` — a name-matching regex. Anything that does not look
 * like a known family lands on the pessimistic floor (`code: 0.68`) while the
 * pool's hand-tuned incumbents sit at the median (`code: 0.85`). Since tier-0
 * free selection is decided entirely by scored ranking (`default_for` pins in
 * the live config are all on tier-1 Go models), a new arrival is placed in the
 * bottom half of the pool before it runs once, and can never accumulate the
 * data that would correct the guess.
 *
 * Measured 2026-08-01 over the prior week: `deepseek-v4-flash-free` 684 uses,
 * `ling-3.0-flash-free` 19, `poolside/laguna-s-2.1:free` 3 — and the handful
 * the newcomers did get were cascade fallbacks after the incumbent failed,
 * not selections on merit.
 *
 * The policy is explore-then-graduate: try an unproven FREE model
 * aggressively until it has enough observations for a fair assessment, then
 * stop treating it specially and let it compete on measured performance.
 *
 * Two properties make this safe rather than reckless:
 *
 *   - Bad trials terminate themselves. `ModelScorecard.unfitKeys` marks any
 *     model at >= 50% error over >= 6 samples, and `pickFor` already excludes
 *     those via `combinedStageExclusions`. A model that cannot do the job
 *     removes itself within its own trial window.
 *   - Exploration never costs money. Only free-tier lanes are trialled, so the
 *     price of being wrong is one turn, never spend.
 */

import type { OrchestratorAgent } from "./agent-pool";

/**
 * Observations required before a model is judged on merit.
 *
 * Deliberately the same value as `ModelScorecard`'s `MIN_SAMPLES`, which is
 * already the point where `errorRate()` stops returning `undefined`. Sharing
 * it keeps one definition of "enough data" — a trial ends exactly when the
 * scorecard is willing to grade.
 */
export const TRIAL_SAMPLE_TARGET = 6;

/**
 * Stages where a wrong pick is contained.
 *
 * The coordinator chooses the pipeline for the entire turn, so a bad route
 * mis-shapes every stage after it and no cascade recovers it — unlike an
 * executor or reviewer pick, which falls back within the stage. Explore
 * wherever being wrong is cheap; never where it poisons the turn.
 */
export function isTrialEligibleStage(stage: string): boolean {
  return stage !== "coordinator";
}

/** Free lanes only: exploring must never spend. */
function isFreeLane(agent: OrchestratorAgent): boolean {
  if (agent.billing_tier === "go" || agent.billing_tier === "paid") return false;
  if (agent.provider === "opencode_go") return false;
  return true;
}

/**
 * The most data-starved eligible free model, or `undefined` when every
 * candidate has graduated — in which case normal scored ranking applies.
 *
 * `sampleCountFor` is injected rather than reaching into a scorecard so this
 * stays pure and testable; callers pass a lookup keyed `provider:model_id`.
 */
export function selectTrialCandidate(
  candidates: readonly OrchestratorAgent[],
  stage: string,
  sampleCountFor: (agent: OrchestratorAgent) => number,
): OrchestratorAgent | undefined {
  if (!isTrialEligibleStage(stage)) return undefined;
  const inTrial = candidates
    .filter((agent) => agent.enabled && isFreeLane(agent))
    .map((agent) => ({ agent, samples: sampleCountFor(agent) }))
    .filter((entry) => entry.samples < TRIAL_SAMPLE_TARGET);
  if (inTrial.length === 0) return undefined;
  // Fewest samples first, so several new arrivals all graduate promptly
  // instead of one monopolising the trial slot.
  inTrial.sort((a, b) => a.samples - b.samples);
  return inTrial[0]!.agent;
}
