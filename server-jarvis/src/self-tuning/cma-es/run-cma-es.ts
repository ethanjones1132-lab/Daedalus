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
import { projectToBounds, thetaBoundWidths } from "./theta-bounds";
import { SepCmaEs } from "./sep-cma-es";

/**
 * Phase D driver: sep-CMA-ES over θ, scored by in-process fixture rollouts,
 * with the winner handed to policy-staging for live vetting.
 *
 * Train/held-out separation is structural, not a convention. `evaluateFitness`
 * takes no task list — it closes over TRAINING_TASKS, so there is no parameter
 * through which a held-out fixture could reach the optimizer loop.
 * `scoreHeldOut` / `compareHeldOut` are separate functions called only after
 * the loop terminates.
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
  /**
   * Optional training subset for early budget-controlled runs (`--tasks N`).
   * Defaults to the full TRAINING_TASKS export. Held-out scoring always uses
   * HELD_OUT_TASKS regardless of this override.
   */
  trainingTasks?: readonly FixtureTask[];
  /**
   * Sampler seeds for paired held-out verdicts (common random numbers).
   * Default `[0]` preserves the historical single-sample path.
   * CLI derives a list from `--heldout-repeats` and `--seed`.
   */
  heldOutSeeds?: readonly number[];
  /**
   * Base for training-fitness seeds (CRN within a generation).
   * Generation g uses `campaignSeedBase + g` for every candidate in that gen.
   */
  campaignSeedBase?: number;
}

export interface GenerationReport {
  generation: number;
  bestFitness: number;
  meanFitness: number;
  sigma: number;
}

/** Paired 95% t-CI comparison of winner vs baseline on held-out fixtures. */
export interface HeldOutComparison {
  winnerMean: number;
  baselineMean: number;
  meanDelta: number;
  ciHalfWidth: number;
  pairCount: number;
  improved: boolean;
}

export interface CampaignResult {
  /** θ at the optimizer's final mean, bounds-projected. */
  winner: OrchestrationTheta;
  /** Mean held-out reward for winner (over seeds × tasks). */
  winnerHeldOut: number;
  /** Mean held-out reward for baseline (same seed matrix). */
  baselineHeldOut: number;
  /** True iff lower bound of paired 95% t-CI on per-pair deltas is > 0. */
  improved: boolean;
  /** Full paired comparison stats (absent only on legacy partial fixtures). */
  heldOutComparison?: HeldOutComparison;
  generations: number;
  history: GenerationReport[];
}

/**
 * NOTE on step size: θ dimensions span ~0.5 (ratios) to ~7_200_000 (TTL ms).
 * The optimizer searches in raw units; `initialD: thetaBoundWidths()` scales
 * each coordinate of the covariance so DEFAULT_INITIAL_SIGMA is a comparable
 * fraction of every dimension's range (not just ratio01). See also
 * sep-cma-es `initialD` and theta-bounds `thetaBoundWidths`.
 */
export const DEFAULT_INITIAL_SIGMA = 0.05;

/**
 * Two-sided 95% Student-t critical value for `df` degrees of freedom.
 * Small-df table + normal asymptotic for large df — enough for fixture-scale N.
 */
export function studentTCritical95(df: number): number {
  if (df <= 0) return Number.POSITIVE_INFINITY;
  // df → t_{0.975,df}
  const table: Record<number, number> = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    12: 2.179,
    15: 2.131,
    20: 2.086,
    24: 2.064,
    30: 2.042,
    40: 2.021,
    60: 2.0,
    120: 1.98,
  };
  if (table[df] !== undefined) return table[df]!;
  if (df > 120) return 1.96;
  // Nearest lower tabulated df
  const keys = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  let lo = keys[0]!;
  for (const k of keys) {
    if (k <= df) lo = k;
    else break;
  }
  return table[lo]!;
}

/**
 * Paired 95% t-CI decision on per-pair deltas (winner − baseline).
 * `improved` iff the lower CI bound is strictly positive.
 * Zero-variance positive mean ⇒ improved with halfWidth 0 (no NaN).
 */
export function pairedTTestImproved(deltas: readonly number[]): {
  meanDelta: number;
  ciHalfWidth: number;
  pairCount: number;
  improved: boolean;
} {
  const pairCount = deltas.length;
  if (pairCount === 0) {
    return { meanDelta: 0, ciHalfWidth: 0, pairCount: 0, improved: false };
  }
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / pairCount;
  if (pairCount === 1) {
    // Single pair: no variance estimate; refuse to claim improvement.
    return {
      meanDelta,
      ciHalfWidth: Number.POSITIVE_INFINITY,
      pairCount,
      improved: false,
    };
  }
  let sumSq = 0;
  for (const d of deltas) {
    const e = d - meanDelta;
    sumSq += e * e;
  }
  const variance = sumSq / (pairCount - 1);
  if (variance === 0) {
    return {
      meanDelta,
      ciHalfWidth: 0,
      pairCount,
      improved: meanDelta > 0,
    };
  }
  const se = Math.sqrt(variance / pairCount);
  const ciHalfWidth = studentTCritical95(pairCount - 1) * se;
  const improved = meanDelta - ciHalfWidth > 0;
  return { meanDelta, ciHalfWidth, pairCount, improved };
}

/**
 * Mean reward of one θ over the TRAINING fixtures.
 *
 * Deliberately parameterless with respect to tasks — see the module docstring.
 * `seed` is shared across all candidates in a generation (CRN).
 */
async function evaluateFitness(
  theta: OrchestrationTheta,
  callModel: CallModelFn,
  concurrency: number,
  trainingTasks: readonly FixtureTask[],
  seed: number,
): Promise<number> {
  const [outcomes] = await runRolloutBatch(
    [{ theta, seed }],
    trainingTasks,
    callModel,
    { concurrency },
  );
  return meanReward(outcomes ?? []);
}

export interface ScoreHeldOutResult {
  /** Grand mean over all (seed, task) cells. */
  mean: number;
  /**
   * Reward matrix: `matrix[seedIndex][taskIndex]`.
   * One candidate per seed, each evaluated on every held-out task.
   */
  matrix: number[][];
}

/**
 * Mean reward over the HELD-OUT fixtures, optionally repeated over seeds.
 * Call after the optimizer loop. Same seed list for winner and baseline
 * enables paired comparison (see `compareHeldOut`).
 */
export async function scoreHeldOut(
  theta: OrchestrationTheta,
  callModel: CallModelFn,
  concurrency = DEFAULT_ROLLOUT_CONCURRENCY,
  seeds: readonly number[] = [0],
): Promise<ScoreHeldOutResult> {
  const seedList = seeds.length > 0 ? seeds : [0];
  const candidates = seedList.map((seed) => ({ theta, seed }));
  const batch = await runRolloutBatch(candidates, HELD_OUT_TASKS, callModel, {
    concurrency,
  });
  const matrix = batch.map((outcomes) => outcomes.map((o) => o.reward));
  const flat = matrix.flat();
  const mean = flat.length === 0 ? 0 : flat.reduce((a, b) => a + b, 0) / flat.length;
  return { mean, matrix };
}

/**
 * Evaluate winner and baseline on the same (task, seed) matrix in one batch,
 * then decide improvement from a paired 95% t-CI on per-pair deltas.
 */
export async function compareHeldOut(
  winner: OrchestrationTheta,
  baseline: OrchestrationTheta,
  seeds: readonly number[],
  callModel: CallModelFn,
  concurrency = DEFAULT_ROLLOUT_CONCURRENCY,
): Promise<HeldOutComparison> {
  const seedList = seeds.length > 0 ? [...seeds] : [0];
  // Interleave winner/baseline per seed so both θs share daemon conditions.
  const candidates: { theta: OrchestrationTheta; seed: number }[] = [];
  for (const seed of seedList) {
    candidates.push({ theta: winner, seed });
    candidates.push({ theta: baseline, seed });
  }
  const batch = await runRolloutBatch(candidates, HELD_OUT_TASKS, callModel, {
    concurrency,
  });

  const deltas: number[] = [];
  let winnerSum = 0;
  let baselineSum = 0;
  let n = 0;
  for (let s = 0; s < seedList.length; s++) {
    const winnerOutcomes = batch[s * 2] ?? [];
    const baselineOutcomes = batch[s * 2 + 1] ?? [];
    const taskCount = Math.min(winnerOutcomes.length, baselineOutcomes.length);
    for (let t = 0; t < taskCount; t++) {
      const w = winnerOutcomes[t]!.reward;
      const b = baselineOutcomes[t]!.reward;
      deltas.push(w - b);
      winnerSum += w;
      baselineSum += b;
      n += 1;
    }
  }

  const test = pairedTTestImproved(deltas);
  return {
    winnerMean: n === 0 ? 0 : winnerSum / n,
    baselineMean: n === 0 ? 0 : baselineSum / n,
    meanDelta: test.meanDelta,
    ciHalfWidth: test.ciHalfWidth,
    pairCount: test.pairCount,
    improved: test.improved,
  };
}

/** Run the optimizer loop and score the result against held-out fixtures. */
export async function runCmaEsCampaign(opts: CampaignOptions): Promise<CampaignResult> {
  const trainingTasks = opts.trainingTasks ?? TRAINING_TASKS;
  if (trainingTasks.length === 0) {
    throw new Error("no training fixtures — refusing to run a campaign with nothing to score");
  }
  if (HELD_OUT_TASKS.length === 0) {
    throw new Error(
      "no held-out fixtures — a campaign with no held-out set cannot distinguish " +
        "a real improvement from overfitting, so its result would be meaningless",
    );
  }

  const concurrency = opts.concurrency ?? DEFAULT_ROLLOUT_CONCURRENCY;
  const heldOutSeeds = opts.heldOutSeeds ?? [0];
  const campaignSeedBase = opts.campaignSeedBase ?? 0;
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
    // Per-dimension scale so DEFAULT_INITIAL_SIGMA's raw-unit step is a
    // comparable proportion of every dimension's range, not just ratio01's.
    initialD: thetaBoundWidths(),
  });

  const history: GenerationReport[] = [];

  for (let gen = 0; gen < opts.generations; gen++) {
    const samples = cma.ask();
    // CRN: every candidate in this generation shares one generation seed.
    const generationSeed = campaignSeedBase + gen;
    const fitness: number[] = [];
    for (const vector of samples) {
      const theta = vectorToTheta(vector, BASELINE_THETA);
      fitness.push(
        await evaluateFitness(theta, opts.callModel, concurrency, trainingTasks, generationSeed),
      );
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
  const heldOutComparison = await compareHeldOut(
    winner,
    BASELINE_THETA,
    heldOutSeeds,
    opts.callModel,
    concurrency,
  );

  return {
    winner,
    winnerHeldOut: heldOutComparison.winnerMean,
    baselineHeldOut: heldOutComparison.baselineMean,
    improved: heldOutComparison.improved,
    heldOutComparison,
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

  const cmp = result.heldOutComparison;
  const evidence = cmp
    ? `paired Δ ${cmp.meanDelta.toFixed(4)} ± ${cmp.ciHalfWidth.toFixed(4)} ` +
      `over ${cmp.pairCount} pairs; means ${result.winnerHeldOut.toFixed(4)} vs ` +
      `${result.baselineHeldOut.toFixed(4)}`
    : `held-out mean reward ${result.winnerHeldOut.toFixed(4)} vs baseline ` +
      `${result.baselineHeldOut.toFixed(4)}`;

  return proposePolicy(
    { domain: "budget", theta: diff },
    `Phase D sep-CMA-ES over ${result.generations} generation(s): ${evidence} ` +
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

export interface TrainingTaskSelection {
  /** Explicit fixture names, evaluated in the order given. Wins over `limit`. */
  names?: readonly string[];
  /** Prefix-slice size — the historical `--tasks N` behaviour. */
  limit?: number;
}

/**
 * Choose the training fixtures a campaign optimizes against.
 *
 * `limit` takes a *prefix* of TRAINING_TASKS, and the leading fixtures are the
 * easy ones. Measured 2026-08-09: two of three campaigned models scored a
 * population mean of exactly 1.0000 on that prefix — a 15-way fitness tie,
 * which leaves sep-CMA-ES ranking candidates by tie-break order rather than by
 * signal, so the whole campaign is noise. Held-out score does not predict this
 * (hauhau scored 0.5625 held-out and still tied at the ceiling on training).
 *
 * `names` exists so fixtures can be chosen by *measured* per-model difficulty:
 * a fixture pinned at the ceiling (or the floor) for every candidate adds a
 * constant to every fitness and contributes no gradient.
 */
export function selectTrainingTasks(
  selection: TrainingTaskSelection = {},
): readonly FixtureTask[] {
  const { names, limit } = selection;
  if (names === undefined) {
    return limit !== undefined ? TRAINING_TASKS.slice(0, limit) : TRAINING_TASKS;
  }
  if (names.length === 0) {
    throw new Error(
      "Training fixture list is empty — omit the flag to use all " +
        `${TRAINING_TASKS.length} training fixtures.`,
    );
  }

  const byName = new Map(TRAINING_TASKS.map((t) => [t.name, t]));
  const heldOut = new Set(HELD_OUT_TASKS.map((t) => t.name));

  // Fail loudly on a bad name. A typo that silently selected a different (or
  // empty) set would not surface until a multi-hour campaign had already run.
  return names.map((name) => {
    const task = byName.get(name);
    if (task !== undefined) return task;
    if (heldOut.has(name)) {
      throw new Error(
        `"${name}" is a held-out fixture — training on it would leak the evaluation set.`,
      );
    }
    throw new Error(
      `Unknown training fixture "${name}". Use --preflight to list the ` +
        `${TRAINING_TASKS.length} available names.`,
    );
  });
}

/** Deterministic held-out seed list from campaign seed + repeat count. */
export function heldOutSeedsFromCampaignSeed(
  campaignSeed: number | undefined,
  repeats: number,
): number[] {
  const n = Math.max(1, Math.floor(repeats));
  const base = 100_000 + ((campaignSeed ?? 0) >>> 0);
  return Array.from({ length: n }, (_, i) => base + i);
}
