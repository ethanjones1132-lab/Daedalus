import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_THETA,
  THETA_KEYS,
  resetGlobalThetaToBaseline,
  type OrchestrationTheta,
} from "../../orchestration/orchestration-policy";
import type { CallModelFn } from "../../orchestration/coordinator";
import { resetLearnedPoolStateForTests } from "../learned-pool-state";
import {
  getPolicyVersionStore,
  loadPolicyVersions,
  policyVersionsPath,
  recordEligibleOutcome,
  resetPolicyStagingForTests,
} from "../policy-staging";
import { loadHeldOutTasks, loadTrainingTasks } from "../rollout/fixture-tasks";
import {
  campaignFixtureSummary,
  compareHeldOut,
  pairedTTestImproved,
  persistCampaignWinner,
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
    expect(s.training).toBe(loadTrainingTasks().length);
    expect(s.heldOut).toBe(loadHeldOutTasks().length);
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

    expect(comparison.pairCount).toBe(loadHeldOutTasks().length * seeds.length);
    // Per-task derivation: candidate.seed * 1000 + taskIndex
    const expectedTaskSeeds = new Set<number>();
    for (const s of seeds) {
      for (let t = 0; t < loadHeldOutTasks().length; t++) {
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
      trainingTasks: loadTrainingTasks().slice(0, 1),
      campaignSeedBase: 7,
      heldOutSeeds: [0], // minimize held-out work
      rng: seededRng(99),
    });

    // generation 0 → generationSeed 7 → taskIndex 0 → 7000
    expect(seenSeeds.has(7000)).toBe(true);
    // Held-out with seed 0 → task seeds 0..loadHeldOutTasks().length-1
    for (let t = 0; t < loadHeldOutTasks().length; t++) {
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

describe("persistCampaignWinner", () => {
  let root: string;

  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    resetGlobalThetaToBaseline();
    root = mkdtempSync(join(tmpdir(), "jarvis-campaign-policy-"));
  });

  afterEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    resetGlobalThetaToBaseline();
    rmSync(root, { recursive: true, force: true });
  });

  const improved = (key = THETA_KEYS[0]!, value = BASELINE_THETA[key] + 2): CampaignResult => ({
    winner: { ...BASELINE_THETA, [key]: value },
    winnerHeldOut: 0.8123,
    baselineHeldOut: 0.4011,
    improved: true,
    generations: 3,
    history: [],
  });

  test("persists an improved winner and reloads it before qualification", () => {
    const result = improved();
    const handoff = persistCampaignWinner(result, { root });

    expect(handoff.status).toBe("proposed");
    expect(handoff.persisted).toBe(true);
    expect(handoff.exitCode).toBe(0);

    const onDisk = JSON.parse(readFileSync(policyVersionsPath(root), "utf8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.candidate.stage).toBe("candidate");
    expect(onDisk.candidate.patch.theta).toEqual(thetaDiff(result.winner));
    expect(onDisk.candidate.rationale).toContain("0.8123");

    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    resetGlobalThetaToBaseline();
    expect(loadPolicyVersions(root)).toBe(true);

    const candidate = getPolicyVersionStore().candidate;
    expect(candidate?.patch.theta).toEqual(thetaDiff(result.winner));
    expect(candidate?.eligibleOutcomes).toBe(0);
    const qualified = recordEligibleOutcome("success", {
      evidenceId: "campaign-restart-evidence",
      policyId: candidate!.id,
      policyVersion: candidate!.version,
      patch: candidate!.patch,
      source: "candidate_execution",
      arm: "candidate",
      runId: "campaign-restart-run",
      sessionId: "campaign-restart-session",
      taskType: "campaign-restart",
      outcome: "success",
    });
    expect(qualified.action).toBe("eligible_recorded");
  });

  test("does not replace an existing candidate", () => {
    const first = persistCampaignWinner(improved(), { root });
    expect(first.status).toBe("proposed");
    const before = readFileSync(policyVersionsPath(root));
    const firstCandidate = getPolicyVersionStore().candidate;
    const second = persistCampaignWinner(
      improved(THETA_KEYS[1]!, BASELINE_THETA[THETA_KEYS[1]!] + 3),
      { root },
    );

    expect(second.status).toBe("rejected");
    expect(second.exitCode).toBe(0);
    expect(readFileSync(policyVersionsPath(root)).toString()).toBe(before.toString());
    expect(getPolicyVersionStore().candidate?.id).toBe(firstCandidate?.id);
  });

  test("does not rewrite a prior policy for a no-op campaign", () => {
    persistCampaignWinner(improved(), { root });
    const before = readFileSync(policyVersionsPath(root)).toString();
    const noImprovement = persistCampaignWinner(
      { ...improved(), improved: false },
      { root },
    );
    const unchanged = persistCampaignWinner(improved(), { root });

    expect(noImprovement.status).toBe("not_proposed");
    expect(unchanged.status).toBe("rejected");
    expect(readFileSync(policyVersionsPath(root)).toString()).toBe(before);
  });

  test("fails closed and rolls back when persistence fails", () => {
    const handoff = persistCampaignWinner(improved(), {
      root,
      persistPolicyVersions: () => false,
    });

    expect(handoff.status).toBe("persistence_failed");
    expect(handoff.persisted).toBe(false);
    expect(handoff.exitCode).toBe(1);
    expect(getPolicyVersionStore().candidate).toBeNull();
    expect(existsSync(policyVersionsPath(root))).toBe(false);
  });

  test("leaves a prior policy readable when a replacement cannot persist", () => {
    persistCampaignWinner(improved(), { root });
    const before = readFileSync(policyVersionsPath(root)).toString();
    resetPolicyStagingForTests();

    const handoff = persistCampaignWinner(
      improved(THETA_KEYS[1]!, BASELINE_THETA[THETA_KEYS[1]!] + 3),
      {
        root,
        loadPolicyVersions: () => true,
        persistPolicyVersions: () => false,
      },
    );

    expect(handoff.status).toBe("persistence_failed");
    expect(readFileSync(policyVersionsPath(root), "utf8")).toBe(before);
    expect(getPolicyVersionStore().candidate).toBeNull();
  });

  test("does not overwrite an unreadable policy file", () => {
    mkdirSync(join(root, "self-tuning"), { recursive: true });
    const path = policyVersionsPath(root);
    writeFileSync(path, "{not-json", "utf8");
    const handoff = persistCampaignWinner(improved(), { root });

    expect(handoff.status).toBe("load_failed");
    expect(handoff.exitCode).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{not-json");
    expect(getPolicyVersionStore().candidate).toBeNull();
  });
});

describe("selectTrainingTasks", () => {
  test("no selector returns the full training set", () => {
    expect(selectTrainingTasks()).toEqual(loadTrainingTasks());
  });

  test("limit keeps the existing prefix-slice behaviour", () => {
    const picked = selectTrainingTasks({ limit: 3 });
    expect(picked.map((t) => t.name)).toEqual(loadTrainingTasks().slice(0, 3).map((t) => t.name));
  });

  test("names select exactly those fixtures, in the order given", () => {
    const a = loadTrainingTasks()[4]!.name;
    const b = loadTrainingTasks()[1]!.name;
    const picked = selectTrainingTasks({ names: [a, b] });
    expect(picked.map((t) => t.name)).toEqual([a, b]);
  });

  test("names win over limit — an explicit list is never silently truncated", () => {
    const a = loadTrainingTasks()[7]!.name;
    const b = loadTrainingTasks()[9]!.name;
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
    expect(() => selectTrainingTasks({ names: [loadHeldOutTasks()[0]!.name] })).toThrow(
      /held-out/i,
    );
  });

  test("an empty name list throws rather than yielding zero fixtures", () => {
    expect(() => selectTrainingTasks({ names: [] })).toThrow();
  });
});
