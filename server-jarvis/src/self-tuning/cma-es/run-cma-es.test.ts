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
  proposeCampaignWinner,
  runCmaEsCampaign,
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
