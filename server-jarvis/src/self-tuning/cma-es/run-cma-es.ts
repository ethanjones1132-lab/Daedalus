import {
  BASELINE_THETA,
  THETA_DIM,
  THETA_KEYS,
  thetaToVector,
  vectorToTheta,
  type OrchestrationTheta,
} from "../../orchestration/orchestration-policy";
import type { CallModelFn } from "../../orchestration/coordinator";
import { proposePolicy, type TransitionResult } from "../policy-staging";
import {
  HELD_OUT_TASKS,
  TRAINING_TASKS,
  type FixtureTask,
} from "../rollout/fixture-tasks";
import {
  DEFAULT_ROLLOUT_CONCURRENCY,
  meanReward,
  runRolloutBatch,
} from "../rollout/rollout-pool";
import { projectToBounds } from "./theta-bounds";
import { SepCmaEs } from "./sep-cma-es";

/**
 * Phase D driver: sep-CMA-ES over θ, scored by in-process fixture rollouts,
 * with the winner handed to policy-staging for live vetting.
 *
 * Train/held-out separation is structural, not a convention. `evaluateFitness`
 * takes no task list — it closes over TRAINING_TASKS, so there is no parameter
 * through which a held-out fixture could reach the optimizer loop.
 * `scoreHeldOut` is a separate function called only after the loop terminates.
 */

export interface CampaignOptions {
  callModel: CallModelFn;
  /** Optimizer generations to run before stopping. */
  generations: number;
  /** Parallel rollouts; empirical, bounded by local GPU contention. */
  concurrency?: number;
  /** Initial step size, in normalized units. See NOTE on scaling below. */
  initialSigma?: number;
  popSize?: number;
  rng?: () => number;
  onGeneration?: (info: GenerationReport) => void;
}

export interface GenerationReport {
  generation: number;
  bestFitness: number;
  meanFitness: number;
  sigma: number;
}

export interface CampaignResult {
  /** θ at the optimizer's final mean, bounds-projected. */
  winner: OrchestrationTheta;
  winnerHeldOut: number;
  baselineHeldOut: number;
  improved: boolean;
  generations: number;
  history: GenerationReport[];
}

/**
 * NOTE on step size: θ dimensions span ~0.5 (ratios) to ~7_200_000 (TTL ms),
 * so one scalar sigma cannot be right for every dimension in raw units. The
 * optimizer searches in RAW units and relies on `projectToBounds` clamping, so
 * a sigma tuned for milliseconds would saturate every ratio dimension at its
 * bound and vice-versa. Until per-dimension scaling is added (normalize each
 * dimension to its [min,max] range before search, denormalize after), keep
 * sigma small relative to the widest dimension and treat early results as
 * exploratory. This is a known limitation, not a tuned default.
 */
export const DEFAULT_INITIAL_SIGMA = 0.05;

/**
 * Mean reward of one θ over the TRAINING fixtures.
 *
 * Deliberately parameterless with respect to tasks — see the module docstring.
 */
async function evaluateFitness(
  theta: OrchestrationTheta,
  callModel: CallModelFn,
  concurrency: number,
): Promise<number> {
  const [outcomes] = await runRolloutBatch(
    [{ theta, seed: 0 }],
    TRAINING_TASKS,
    callModel,
    { concurrency },
  );
  return meanReward(outcomes ?? []);
}

/** Mean reward over the HELD-OUT fixtures. Call once, after the loop. */
export async function scoreHeldOut(
  theta: OrchestrationTheta,
  callModel: CallModelFn,
  concurrency = DEFAULT_ROLLOUT_CONCURRENCY,
): Promise<number> {
  const [outcomes] = await runRolloutBatch(
    [{ theta, seed: 0 }],
    HELD_OUT_TASKS,
    callModel,
    { concurrency },
  );
  return meanReward(outcomes ?? []);
}

/** Run the optimizer loop and score the result against held-out fixtures. */
export async function runCmaEsCampaign(opts: CampaignOptions): Promise<CampaignResult> {
  if (TRAINING_TASKS.length === 0) {
    throw new Error("no training fixtures — refusing to run a campaign with nothing to score");
  }
  if (HELD_OUT_TASKS.length === 0) {
    throw new Error(
      "no held-out fixtures — a campaign with no held-out set cannot distinguish " +
        "a real improvement from overfitting, so its result would be meaningless",
    );
  }

  const concurrency = opts.concurrency ?? DEFAULT_ROLLOUT_CONCURRENCY;
  const cma = new SepCmaEs({
    dim: THETA_DIM,
    // Start from the hand-tuned baseline, not a random draw: the fixture suite
    // is small enough that early wild exploration burns budget that should go
    // to refinement, and BASELINE_THETA is a known-good point.
    initialMean: projectToBounds(thetaToVector(BASELINE_THETA)),
    initialSigma: opts.initialSigma ?? DEFAULT_INITIAL_SIGMA,
    bounds: projectToBounds,
    popSize: opts.popSize,
    rng: opts.rng,
  });

  const history: GenerationReport[] = [];

  for (let gen = 0; gen < opts.generations; gen++) {
    const samples = cma.ask();
    const fitness: number[] = [];
    for (const vector of samples) {
      const theta = vectorToTheta(vector, BASELINE_THETA);
      fitness.push(await evaluateFitness(theta, opts.callModel, concurrency));
    }
    cma.tell(samples, fitness);

    const report: GenerationReport = {
      generation: cma.generation,
      bestFitness: Math.max(...fitness),
      meanFitness: fitness.reduce((a, b) => a + b, 0) / fitness.length,
      sigma: cma.sigma,
    };
    history.push(report);
    opts.onGeneration?.(report);

    if (cma.converged()) break;
  }

  const winner = vectorToTheta(projectToBounds(cma.mean), BASELINE_THETA);
  const winnerHeldOut = await scoreHeldOut(winner, opts.callModel, concurrency);
  const baselineHeldOut = await scoreHeldOut(BASELINE_THETA, opts.callModel, concurrency);

  return {
    winner,
    winnerHeldOut,
    baselineHeldOut,
    improved: winnerHeldOut > baselineHeldOut,
    generations: history.length,
    history,
  };
}

/** Dimensions where the winner differs from baseline — the patch to stage. */
export function thetaDiff(winner: OrchestrationTheta): Record<string, number> {
  const diff: Record<string, number> = {};
  for (const key of THETA_KEYS) {
    if (winner[key] !== BASELINE_THETA[key]) diff[key] = winner[key];
  }
  return diff;
}

/**
 * D4 — hand a winning candidate to policy-staging.
 *
 * Deliberately does NOT promote anything itself. `proposePolicy` starts the
 * candidate → shadow → canary → production lifecycle, which is driven by
 * outcomes from REAL traffic and gated by immutable governance thresholds.
 * A fixture campaign is evidence a candidate is worth vetting, not evidence it
 * is safe to ship — those are different claims and only live traffic settles
 * the second one.
 */
export function proposeCampaignWinner(result: CampaignResult): TransitionResult | null {
  if (!result.improved) {
    // Not shipping a losing candidate is the correct outcome, not a failure:
    // it says the signal is not there (or the fixture suite is too small/samey)
    // — which is information worth having, and not license to promote anyway.
    return null;
  }
  const diff = thetaDiff(result.winner);
  if (Object.keys(diff).length === 0) return null;

  return proposePolicy(
    { domain: "budget", theta: diff },
    `Phase D sep-CMA-ES over ${result.generations} generation(s): held-out mean reward ` +
      `${result.winnerHeldOut.toFixed(4)} vs baseline ${result.baselineHeldOut.toFixed(4)} ` +
      `across ${HELD_OUT_TASKS.length} held-out fixture(s); ${Object.keys(diff).length} ` +
      `of ${THETA_KEYS.length} dimensions changed`,
  );
}

/** Fixture counts, for a driver script to log before spending a campaign. */
export function campaignFixtureSummary(): {
  training: number;
  heldOut: number;
  trainingNames: string[];
  heldOutNames: string[];
} {
  const names = (tasks: readonly FixtureTask[]) => tasks.map((t) => t.name);
  return {
    training: TRAINING_TASKS.length,
    heldOut: HELD_OUT_TASKS.length,
    trainingNames: names(TRAINING_TASKS),
    heldOutNames: names(HELD_OUT_TASKS),
  };
}
