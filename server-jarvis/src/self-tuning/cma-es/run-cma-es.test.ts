import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BASELINE_THETA,
  THETA_KEYS,
  type OrchestrationTheta,
} from "../../orchestration/orchestration-policy";
import type { CallModelFn } from "../../orchestration/coordinator";
import { getPolicyVersionStore, resetPolicyStagingForTests } from "../policy-staging";
import { HELD_OUT_TASKS, TRAINING_TASKS } from "../rollout/fixture-tasks";
import {
  campaignFixtureSummary,
  compareHeldOut,
  pairedTTestImproved,
  proposeCampaignWinner,
  runCmaEsCampaign,
  selectTrainingTasks,
  thetaDiff,
  type CampaignResult,
} from "./run-cma-es";

/** Deterministic uniform stream so generations are reproducible in tests. */
function seededRng(seed = 42): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Never calls a tool — every rollout scores the same, keeping tests fast. */
const inertModel: CallModelFn = async () => ({ content: "no tools." });

describe("campaignFixtureSummary", () => {
  test("reports disjoint, non-empty splits", () => {
    const s = campaignFixtureSummary();
    expect(s.training).toBe(TRAINING_TASKS.length);
    expect(s.heldOut).toBe(HELD_OUT_TASKS.length);
    expect(s.training).toBeGreaterThan(0);
    expect(s.heldOut).toBeGreaterThan(0);
    for (const name of s.heldOutNames) {
      expect(s.trainingNames).not.toContain(name);
    }
  });
});

describe("thetaDiff", () => {
  test("is empty for the baseline itself", () => {
    expect(thetaDiff(BASELINE_THETA)).toEqual({});
  });

  test("reports only changed dimensions", () => {
    const key = THETA_KEYS[0]!;
    const winner: OrchestrationTheta = {
      ...BASELINE_THETA,
      [key]: BASELINE_THETA[key] + 1,
    };
    const diff = thetaDiff(winner);
    expect(Object.keys(diff)).toEqual([key]);
    expect(diff[key]).toBe(BASELINE_THETA[key] + 1);
  });
});

describe("runCmaEsCampaign", () => {
  test("runs the requested generations and reports history", async () => {
    const result = await runCmaEsCampaign({
      callModel: inertModel,
      generations: 2,
      popSize: 4,
      concurrency: 2,
      rng: seededRng(),
    });
    expect(result.generations).toBeLessThanOrEqual(2);
    expect(result.history.length).toBe(result.generations);
    for (const report of result.history) {
      expect(Number.isFinite(report.bestFitness)).toBe(true);
      expect(Number.isFinite(report.meanFitness)).toBe(true);
      expect(report.sigma).toBeGreaterThan(0);
    }
  }, 120_000);

  test("winner is always a valid in-bounds theta", async () => {
    const result = await runCmaEsCampaign({
      callModel: inertModel,
      generations: 1,
      popSize: 4,
      concurrency: 2,
      rng: seededRng(7),
    });
    for (const key of THETA_KEYS) {
      const v = result.winner[key];
      expect(Number.isFinite(v), `${key} is not finite`).toBe(true);
    }
  }, 120_000);

  test("a large-scale dimension (thrash_ttl_ms, width 7.14M) moves after one generation", async () => {
    // Regression guard for the sigma-scaling limitation flagged in
    // DEFAULT_INITIAL_SIGMA's docstring: a raw stepSize of 0.05 is ~5% of a
    // ratio01 dim's width-1 range but ~0.0000007% of thrash_ttl_ms's 7.14M
    // range. Without per-dimension scaling, every sampled perturbation for
    // this dim rounds back to BASELINE_THETA every single generation, so the
    // optimizer can never even begin to explore it.
    const result = await runCmaEsCampaign({
      callModel: inertModel,
      generations: 1,
      popSize: 8,
      concurrency: 2,
      rng: seededRng(11),
    });
    expect(result.winner.thrash_ttl_ms).not.toBe(BASELINE_THETA.thrash_ttl_ms);
  }, 120_000);

  test("invokes the per-generation callback", async () => {
    const seen: number[] = [];
    await runCmaEsCampaign({
      callModel: inertModel,
      generations: 2,
      popSize: 4,
      concurrency: 2,
      rng: seededRng(3),
      onGeneration: (info) => seen.push(info.generation),
    });
    expect(seen.length).toBeGreaterThan(0);
    // Generations are reported in increasing order.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  }, 120_000);
});

describe("pairedTTestImproved", () => {
  test("tiny positive mean delta with high spread ⇒ improved: false", () => {
    // Bare `>` on means would say true (mean ≈ +0.05); the paired CI must reject.
    const deltas = [0.4, -0.3, 0.35, -0.25, 0.3, -0.2];
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    expect(mean).toBeGreaterThan(0);
    const result = pairedTTestImproved(deltas);
    expect(result.improved).toBe(false);
    expect(result.meanDelta).toBeCloseTo(mean, 10);
    expect(result.ciHalfWidth).toBeGreaterThan(result.meanDelta);
  });

  test("all deltas identical and positive ⇒ improved: true, finite zero-width CI", () => {
    const deltas = [0.1, 0.1, 0.1, 0.1];
    const result = pairedTTestImproved(deltas);
    expect(result.improved).toBe(true);
    expect(result.meanDelta).toBe(0.1);
    expect(result.ciHalfWidth).toBe(0);
    expect(Number.isFinite(result.ciHalfWidth)).toBe(true);
  });
});

describe("compareHeldOut", () => {
  test("winner and baseline are evaluated with identical (task, seed) pairs", async () => {
    const seeds = [11, 22];
    const seen: Array<number | undefined> = [];
    const spy: CallModelFn = async (_messages, options) => {
      seen.push(options?.seed);
      return { content: "no tools." };
    };

    const comparison = await compareHeldOut(
      BASELINE_THETA,
      { ...BASELINE_THETA, max_directives_per_turn: BASELINE_THETA.max_directives_per_turn + 1 },
      seeds,
      spy,
      2,
    );

    expect(comparison.pairCount).toBe(HELD_OUT_TASKS.length * seeds.length);
    // Per-task derivation: candidate.seed * 1000 + taskIndex
    const expectedTaskSeeds = new Set<number>();
    for (const s of seeds) {
      for (let t = 0; t < HELD_OUT_TASKS.length; t++) {
        expectedTaskSeeds.add(s * 1000 + t);
      }
    }
    const uniqueSeeds = new Set(seen.filter((s): s is number => s !== undefined));
    expect([...uniqueSeeds].sort((a, b) => a - b)).toEqual(
      [...expectedTaskSeeds].sort((a, b) => a - b),
    );
  }, 120_000);
});

describe("CRN training fitness", () => {
  test("all candidates in one generation share the same (task → seed) assignment", async () => {
    // One generation, popSize 4, one training task. Every candidate must see
    // the same task seed = generationSeed * 1000 + taskIndex.
    const seenSeeds = new Set<number>();
    const spy: CallModelFn = async (_messages, options) => {
      if (options?.seed !== undefined) seenSeeds.add(options.seed);
      return { content: "no tools." };
    };

    await runCmaEsCampaign({
      callModel: spy,
      generations: 1,
      popSize: 4,
      concurrency: 2,
      trainingTasks: TRAINING_TASKS.slice(0, 1),
      campaignSeedBase: 7,
      heldOutSeeds: [0], // minimize held-out work
      rng: seededRng(99),
    });

    // generation 0 → generationSeed 7 → taskIndex 0 → 7000
    expect(seenSeeds.has(7000)).toBe(true);
    // Held-out with seed 0 → task seeds 0..HELD_OUT_TASKS.length-1
    for (let t = 0; t < HELD_OUT_TASKS.length; t++) {
      expect(seenSeeds.has(t)).toBe(true);
    }
  }, 120_000);
});

describe("proposeCampaignWinner", () => {
  beforeEach(() => resetPolicyStagingForTests());
  afterEach(() => resetPolicyStagingForTests());

  const base = (over: Partial<CampaignResult>): CampaignResult => ({
    winner: BASELINE_THETA,
    winnerHeldOut: 0,
    baselineHeldOut: 0,
    improved: false,
    generations: 1,
    history: [],
    ...over,
  });

  test("does not propose when held-out did not improve", () => {
    const key = THETA_KEYS[0]!;
    const result = base({
      winner: { ...BASELINE_THETA, [key]: BASELINE_THETA[key] + 1 },
      winnerHeldOut: 0.1,
      baselineHeldOut: 0.4,
      improved: false,
    });
    expect(proposeCampaignWinner(result)).toBeNull();
    expect(getPolicyVersionStore().candidate).toBeNull();
  });

  test("does not propose when the winner is identical to baseline", () => {
    const result = base({ winnerHeldOut: 0.9, baselineHeldOut: 0.4, improved: true });
    expect(proposeCampaignWinner(result)).toBeNull();
    expect(getPolicyVersionStore().candidate).toBeNull();
  });

  test("proposes a candidate carrying only the changed dimensions", () => {
    const key = THETA_KEYS[0]!;
    const changed = BASELINE_THETA[key] + 2;
    const result = base({
      winner: { ...BASELINE_THETA, [key]: changed },
      winnerHeldOut: 0.8,
      baselineHeldOut: 0.4,
      improved: true,
    });

    const transition = proposeCampaignWinner(result);
    expect(transition).not.toBeNull();
    expect(transition!.action).not.toBe("rejected");

    const candidate = getPolicyVersionStore().candidate;
    expect(candidate).not.toBeNull();
    expect(candidate!.snapshot.theta).toEqual({ [key]: changed });
  });

  test("the rationale records the evidence behind the proposal", () => {
    const key = THETA_KEYS[0]!;
    const result = base({
      winner: { ...BASELINE_THETA, [key]: BASELINE_THETA[key] + 2 },
      winnerHeldOut: 0.8123,
      baselineHeldOut: 0.4011,
      improved: true,
      generations: 5,
    });
    proposeCampaignWinner(result);
    const rationale = getPolicyVersionStore().candidate!.rationale;
    expect(rationale).toContain("0.8123");
    expect(rationale).toContain("0.4011");
    expect(rationale).toContain("5 generation");
  });
});

describe("selectTrainingTasks", () => {
  test("no selector returns the full training set", () => {
    expect(selectTrainingTasks()).toEqual(TRAINING_TASKS);
  });

  test("limit keeps the existing prefix-slice behaviour", () => {
    const picked = selectTrainingTasks({ limit: 3 });
    expect(picked.map((t) => t.name)).toEqual(TRAINING_TASKS.slice(0, 3).map((t) => t.name));
  });

  test("names select exactly those fixtures, in the order given", () => {
    const a = TRAINING_TASKS[4]!.name;
    const b = TRAINING_TASKS[1]!.name;
    const picked = selectTrainingTasks({ names: [a, b] });
    expect(picked.map((t) => t.name)).toEqual([a, b]);
  });

  test("names win over limit — an explicit list is never silently truncated", () => {
    const a = TRAINING_TASKS[7]!.name;
    const b = TRAINING_TASKS[9]!.name;
    const picked = selectTrainingTasks({ names: [a, b], limit: 1 });
    expect(picked.map((t) => t.name)).toEqual([a, b]);
  });

  test("an unknown fixture name throws and names the offender", () => {
    // A typo must not silently run a different (or empty) fixture set — that
    // wastes a multi-hour campaign before anyone notices.
    expect(() => selectTrainingTasks({ names: ["merge_intervals", "nope_not_real"] })).toThrow(
      /nope_not_real/,
    );
  });

  test("a held-out fixture name is rejected — it would leak the eval set into training", () => {
    expect(() => selectTrainingTasks({ names: [HELD_OUT_TASKS[0]!.name] })).toThrow(
      /held-out/i,
    );
  });

  test("an empty name list throws rather than yielding zero fixtures", () => {
    expect(() => selectTrainingTasks({ names: [] })).toThrow();
  });
});
