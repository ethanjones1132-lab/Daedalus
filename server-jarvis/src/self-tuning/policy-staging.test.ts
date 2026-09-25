import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyPolicySnapshotToPool,
  getLearnedPoolState,
  modelRoutingScoreDelta,
  resetLearnedPoolStateForTests,
  runWithPolicyOverlay,
  snapshotStagedPolicyFields,
} from "./learned-pool-state";
import {
  POLICY_STAGING_THRESHOLDS,
  activeSnapshotForArm,
  evaluatePromotion,
  getPolicyVersionStore,
  loadPolicyVersions,
  persistPolicyVersions,
  policyVersionsPath,
  proposePolicy,
  recordCanaryOutcome,
  recordEligibleOutcome,
  resetPolicyStagingForTests,
  rollbackPolicy,
  runShadowReplay,
  shouldApplyCanary,
  type PolicyEvidence,
  type PolicyPatch,
} from "./policy-staging";
import type { OrchestratorAgent } from "../orchestration/agent-pool";
import { policy, resetGlobalThetaToBaseline } from "../orchestration/orchestration-policy";

const routingPatch: PolicyPatch = {
  domain: "routing",
  modelRoutingScoreDeltas: { "opencode_go:deepseek-v4-flash": 0.12 },
  stageModelRoutingScoreDeltas: { "opencode_go:deepseek-v4-flash:synthesizer": 0.08 },
};

const budgetPatch: PolicyPatch = {
  domain: "budget",
  modelFirstTokenTimeouts: { "opencode_go:deepseek-v4-flash": 42_000 },
};

function advanceToShadow(): void {
  const proposed = proposePolicy(routingPatch, "boost reliable model");
  expect(proposed.action).toBe("proposed");
  for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow - 1; i++) {
    const r = recordCandidateOutcome(i % 5 === 0 ? "failed" : "success", i);
    expect(r.action).toBe("eligible_recorded");
  }
  const entered = recordCandidateOutcome(
    "success",
    POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow - 1,
  );
  expect(entered.action).toBe("entered_shadow");
  expect(entered.version?.stage).toBe("shadow");
}

function advanceToCanary(successRate = 0.9): void {
  advanceToShadow();
  const candidate = getPolicyVersionStore().candidate;
  if (!candidate) throw new Error("shadow candidate is not available");
  const n = POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow;
  const outcomes = replayOutcomes(candidate, n, "success");
  const adjusted = outcomes.map((row, index) => ({
    ...row,
    outcome: index / n < successRate ? "success" : "failed",
  }));
  const r = runShadowReplay(adjusted);
  expect(r.action).toBe("entered_canary");
  expect(r.version?.stage).toBe("canary");
  expect(getPolicyVersionStore().canary?.id).toBe(r.version?.id);
}

function captureWarnings(action: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    action();
  } finally {
    console.warn = original;
  }
  return warnings;
}

function promoteValidPolicy(): void {
  advanceToCanary(1.0);
  for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion; i++) {
    recordCanaryOutcome("canary", true);
    recordCanaryOutcome("production", true);
  }
}

function snapshotPool(): Record<string, Array<[string, unknown]>> {
  const state = getLearnedPoolState();
  return {
    modelRoutingScoreDeltas: [...state.modelRoutingScoreDeltas.entries()],
    stageModelRoutingScoreDeltas: [...state.stageModelRoutingScoreDeltas.entries()],
    fallbackBoosts: [...state.fallbackBoosts.entries()],
    modelFirstTokenTimeouts: [...state.modelFirstTokenTimeouts.entries()],
    recoveryPolicy: [...state.recoveryPolicy.entries()],
  };
}

function policyEvidence(
  candidate: NonNullable<ReturnType<typeof getPolicyVersionStore>["candidate"]>,
  index: number,
  source: PolicyEvidence["source"],
  arm: PolicyEvidence["arm"],
  outcome: PolicyEvidence["outcome"] = "success",
): PolicyEvidence {
  return {
    evidenceId: `evidence-${index}`,
    policyId: candidate.id,
    policyVersion: candidate.version,
    patch: candidate.patch,
    source,
    arm,
    runId: `run-${index}`,
    sessionId: `session-${index}`,
    taskType: index % 2 === 0 ? "refactor" : "debug",
    outcome,
  };
}

function recordCandidateOutcome(
  outcome: PolicyEvidence["outcome"],
  index: number,
): ReturnType<typeof recordEligibleOutcome> {
  const candidate = getPolicyVersionStore().candidate;
  if (!candidate) throw new Error("candidate is not available");
  return recordEligibleOutcome(
    outcome,
    policyEvidence(candidate, index, "candidate_execution", "candidate", outcome),
  );
}

function replayOutcomes(
  candidate: NonNullable<ReturnType<typeof getPolicyVersionStore>["candidate"]>,
  count: number,
  outcome: PolicyEvidence["outcome"] = "success",
  start = 10_000,
): PolicyEvidence[] {
  return Array.from({ length: count }, (_, index) =>
    policyEvidence(candidate, start + index, "offline_replay", "offline_replay", outcome),
  );
}

describe("qualification provenance", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
  });

  test("ignores forty production-arm terminals with mixed task types", () => {
    const proposed = proposePolicy(routingPatch, "candidate provenance");
    expect(proposed.action).toBe("proposed");
    const candidate = getPolicyVersionStore().candidate;
    if (!candidate) throw new Error("candidate was not proposed");
    expect(recordEligibleOutcome("success").reason).toBe("evidence_required");

    for (let i = 0; i < 40; i += 1) {
      const outcome = i % 3 === 0 ? "failed" : "success";
      const result = recordEligibleOutcome(
        outcome,
        policyEvidence(candidate, i, "live_turn", "production", outcome),
      );
      expect(result.action).toBe("none");
    }

    const current = getPolicyVersionStore().candidate;
    expect(current?.stage).toBe("candidate");
    expect(current?.eligibleOutcomes).toBe(0);

    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow; i += 1) {
      recordCandidateOutcome("success", 1_000 + i);
    }
    const shadow = getPolicyVersionStore().candidate;
    if (!shadow) throw new Error("candidate did not enter shadow");
    for (let i = 0; i < 40; i += 1) {
      const outcome = i % 3 === 0 ? "failed" : "success";
      const result = recordEligibleOutcome(
        outcome,
        policyEvidence(shadow, 2_000 + i, "live_turn", "production", outcome),
      );
      expect(result.action).toBe("none");
    }
    expect(getPolicyVersionStore().candidate?.shadow?.replayed).toBe(0);
  });

  test("counts only matching candidate executions and offline replay receipts", () => {
    expect(proposePolicy(routingPatch, "candidate provenance").action).toBe("proposed");
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow; i += 1) {
      const candidate = getPolicyVersionStore().candidate;
      if (!candidate) throw new Error("candidate disappeared");
      const result = recordEligibleOutcome(
        "success",
        policyEvidence(candidate, i, "candidate_execution", "candidate"),
      );
      expect(result.action).toBe(i === 19 ? "entered_shadow" : "eligible_recorded");
    }

    const candidate = getPolicyVersionStore().candidate;
    if (!candidate) throw new Error("shadow candidate disappeared");
    const replay = runShadowReplay(
      Array.from({ length: POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow }, (_, i) =>
        policyEvidence(candidate, 100 + i, "offline_replay", "offline_replay"),
      ),
    );
    expect(replay.action).toBe("entered_canary");
    expect(getPolicyVersionStore().canary?.stage).toBe("canary");
  });

  test("fails closed for duplicate, stale, wrong-arm, and mismatched evidence", () => {
    expect(proposePolicy(routingPatch, "candidate provenance").action).toBe("proposed");
    const candidate = getPolicyVersionStore().candidate;
    if (!candidate) throw new Error("candidate was not proposed");
    const valid = policyEvidence(candidate, 1, "candidate_execution", "candidate");
    expect(recordEligibleOutcome("success", valid).action).toBe("eligible_recorded");
    expect(recordEligibleOutcome("success", valid).reason).toBe("duplicate_evidence");

    const stale = {
      ...policyEvidence(candidate, 2, "candidate_execution", "candidate"),
      policyVersion: candidate.version + 1,
    };
    expect(recordEligibleOutcome("success", stale).reason).toBe("stale_policy_version");
    const wrongArm = {
      ...policyEvidence(candidate, 3, "candidate_execution", "production"),
    };
    expect(recordEligibleOutcome("success", wrongArm).reason).toBe("wrong_policy_arm");
    const patchMismatch = {
      ...policyEvidence(candidate, 4, "candidate_execution", "candidate"),
      patch: { ...candidate.patch, modelRoutingScoreDeltas: { changed: 0.2 } },
    };
    expect(recordEligibleOutcome("success", patchMismatch).reason).toBe("patch_mismatch");
    const mismatched = {
      ...policyEvidence(candidate, 5, "offline_replay", "offline_replay"),
    };
    expect(runShadowReplay([mismatched]).reason).toBe("replay_requires_shadow");
  });

  test("reports partial replay progress as recorded evidence", () => {
    advanceToShadow();
    const candidate = getPolicyVersionStore().candidate;
    if (!candidate) throw new Error("shadow candidate is not available");
    const result = runShadowReplay(replayOutcomes(candidate, 1, "success", 400));
    expect(result.action).toBe("eligible_recorded");
    expect(candidate.shadow?.replayed).toBe(1);
  });

  test("rejects a replay batch atomically when one receipt is stale", () => {
    advanceToShadow();
    const candidate = getPolicyVersionStore().candidate;
    if (!candidate) throw new Error("shadow candidate is not available");
    const beforeEvidence = [...(candidate.qualificationEvidence?.evidenceIds ?? [])];
    const valid = policyEvidence(candidate, 300, "offline_replay", "offline_replay");
    const stale = {
      ...policyEvidence(candidate, 301, "offline_replay", "offline_replay"),
      policyVersion: candidate.version + 1,
    };
    const result = runShadowReplay([valid, stale]);
    expect(result.reason).toBe("stale_policy_version");
    expect(candidate.shadow?.replayed).toBe(0);
    expect(candidate.qualificationEvidence?.evidenceIds).toEqual(beforeEvidence);
  });
});

describe("policy staging thresholds", () => {
  test("plan thresholds are pinned", () => {
    expect(POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow).toBe(20);
    expect(POLICY_STAGING_THRESHOLDS.canaryTrafficFraction).toBe(0.1);
    expect(POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion).toBe(20);
  });
});

describe("propose → eligible → shadow → canary → promote", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
  });

  test("rejects empty patch and concurrent candidates", () => {
    const empty = proposePolicy({ domain: "routing" }, "noop");
    expect(empty.action).toBe("rejected");
    expect(empty.reason).toBe("empty_patch");

    const first = proposePolicy(routingPatch, "first");
    expect(first.action).toBe("proposed");
    const second = proposePolicy(budgetPatch, "second");
    expect(second.action).toBe("rejected");
    expect(second.reason).toBe("in_flight_exists");
  });

  test("accepts a theta-only patch (Phase D promotion path)", () => {
    const proposed = proposePolicy(
      { domain: "budget", theta: { routing_timeout_ms: 25_000 } },
      "Phase D sep-CMA-ES candidate",
    );
    expect(proposed.action).toBe("proposed");
    expect(proposed.version?.snapshot.theta).toEqual({ routing_timeout_ms: 25_000 });
  });

  test("holds candidate until 20 eligible outcomes then enters shadow", () => {
    advanceToShadow();
    const store = getPolicyVersionStore();
    expect(store.candidate?.stage).toBe("shadow");
    expect(store.candidate?.eligibleOutcomes).toBe(20);
    // Held-back: production maps must not yet include the candidate patch.
    expect(getLearnedPoolState().modelRoutingScoreDeltas.size).toBe(0);
  });

  test("shadow replay rejects low quality and advances high quality to canary", () => {
    advanceToShadow();
    const candidate = getPolicyVersionStore().candidate;
    if (!candidate) throw new Error("shadow candidate is not available");
    const fail = runShadowReplay(replayOutcomes(candidate, 20, "failed"));
    expect(fail.action).toBe("rejected");
    expect(fail.reason).toBe("shadow_failed_quality_gate");
    expect(getPolicyVersionStore().candidate).toBeNull();
    expect(getPolicyVersionStore().canary).toBeNull();

    // Fresh candidate after rejection.
    advanceToCanary(0.95);
    expect(getPolicyVersionStore().canary?.stage).toBe("canary");
  });

  test("canary traffic fraction is ~10% and arms stay isolated until promote", () => {
    advanceToCanary();
    let hits = 0;
    const n = 10_000;
    // Deterministic RNG stepping through [0,1).
    let i = 0;
    const rng = () => {
      const v = i / n;
      i += 1;
      return v;
    };
    for (let k = 0; k < n; k++) {
      if (shouldApplyCanary(rng)) hits += 1;
    }
    expect(hits).toBe(Math.floor(n * POLICY_STAGING_THRESHOLDS.canaryTrafficFraction));

    const canarySnap = activeSnapshotForArm("canary");
    expect(canarySnap.modelRoutingScoreDeltas["opencode_go:deepseek-v4-flash"]).toBe(0.12);
    const prodSnap = activeSnapshotForArm("production");
    expect(prodSnap.modelRoutingScoreDeltas["opencode_go:deepseek-v4-flash"]).toBeUndefined();
    // Live pool still production (empty) during canary.
    expect(getLearnedPoolState().modelRoutingScoreDeltas.size).toBe(0);
  });

  test("promote applies snapshot to pool and seeds last-known-good", () => {
    advanceToCanary(1.0);
    // 20 canary successes + concurrent production successes.
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion; i++) {
      const r = recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
      if (i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion - 1) {
        expect(r.action).toBe("canary_outcome_recorded");
      }
    }
    // Final canary outcome should have promoted (20th run).
    const store = getPolicyVersionStore();
    expect(store.production?.stage).toBe("production");
    expect(store.canary).toBeNull();
    expect(store.candidate).toBeNull();
    expect(store.lastKnownGood).not.toBeNull();
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBe(0.12);
    expect(
      getLearnedPoolState().stageModelRoutingScoreDeltas.get(
        "opencode_go:deepseek-v4-flash:synthesizer",
      ),
    ).toBe(0.08);
  });

  test("evaluatePromotion is a no-op below the canary run threshold", () => {
    advanceToCanary(1.0);
    for (let i = 0; i < 5; i++) recordCanaryOutcome("canary", true);
    const r = evaluatePromotion();
    expect(r.action).toBe("none");
    expect(r.reason).toContain("insufficient_canary_runs");
  });
});

describe("rollback triggers", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
  });

  test("auto-rollback when canary failure rate is catastrophic", () => {
    advanceToCanary(1.0);
    // Seed a production baseline so LKG has something meaningful after first promote path.
    // Here we roll back mid-canary: failure rate 1.0 after 10 samples.
    let last = recordCanaryOutcome("canary", false);
    for (let i = 1; i < POLICY_STAGING_THRESHOLDS.minSamplesForRollback; i++) {
      last = recordCanaryOutcome("canary", false);
    }
    expect(last.action).toBe("rolled_back");
    expect(last.reason).toContain("canary_failure_rate");
    expect(getPolicyVersionStore().canary).toBeNull();
    expect(getPolicyVersionStore().candidate).toBeNull();
  });

  test("auto-rollback when canary underperforms production arm", () => {
    advanceToCanary(1.0);
    // Keep canary failure rate < 0.5 so the catastrophic gate does not fire first,
    // but leave canary success well below the concurrent production arm (>0.15 gap).
    // canary: 6/10 success (0.6); production: 10/10 success (1.0) → regression 0.4.
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minSamplesForRollback; i++) {
      recordCanaryOutcome("production", true);
    }
    let last = recordCanaryOutcome("canary", true);
    for (let i = 1; i < 6; i++) last = recordCanaryOutcome("canary", true);
    for (let i = 0; i < 4; i++) last = recordCanaryOutcome("canary", false);
    expect(last.action).toBe("rolled_back");
    expect(last.reason).toContain("canary_regression");
  });

  test("explicit rollback restores last-known-good snapshot to pool", () => {
    // Establish production via a clean promote.
    advanceToCanary(1.0);
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBe(0.12);

    // Mutate pool as if a bad promote landed, then roll back.
    getLearnedPoolState().modelRoutingScoreDeltas.set("opencode_go:deepseek-v4-flash", 0.99);
    const rolled = rollbackPolicy("operator_requested");
    expect(rolled.action).toBe("rolled_back");
    // LKG was seeded from empty live maps at first promote → restored empty.
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBeUndefined();
    expect(getPolicyVersionStore().production?.stage).toBe("production");
  });
});

describe("restart survival", () => {
  let root: string;

  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    root = mkdtempSync(join(tmpdir(), "jarvis-policy-staging-"));
  });

  afterEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    resetGlobalThetaToBaseline();
    rmSync(root, { recursive: true, force: true });
  });

  test("persist + load restores production/candidate/canary/LKG and pool maps", () => {
    // Promote once so production + LKG exist.
    advanceToCanary(1.0);
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }
    const productionId = getPolicyVersionStore().production?.id;
    const lkgId = getPolicyVersionStore().lastKnownGood?.id;
    expect(productionId).toBeTruthy();
    expect(lkgId).toBeTruthy();

    // Start a new candidate mid-flight.
    const mid = proposePolicy(budgetPatch, "raise first-token budget");
    expect(mid.action).toBe("proposed");
    for (let i = 0; i < 5; i++) recordCandidateOutcome("success", i);

    persistPolicyVersions(root);
    expect(existsSync(policyVersionsPath(root))).toBe(true);
    const onDisk = JSON.parse(readFileSync(policyVersionsPath(root), "utf-8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.production.id).toBe(productionId);
    expect(onDisk.candidate.stage).toBe("candidate");
    expect(onDisk.candidate.eligibleOutcomes).toBe(5);
    expect(onDisk.candidate.qualificationEvidence.runIds).toHaveLength(5);
    expect(onDisk.lastKnownGood.id).toBe(lkgId);

    // Simulate process restart: wipe memory, reload.
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    expect(getPolicyVersionStore().production).toBeNull();
    expect(getLearnedPoolState().modelRoutingScoreDeltas.size).toBe(0);

    loadPolicyVersions(root);
    const reloaded = getPolicyVersionStore();
    expect(reloaded.production?.id).toBe(productionId);
    expect(reloaded.candidate?.eligibleOutcomes).toBe(5);
    expect(reloaded.candidate?.qualificationEvidence?.runIds).toHaveLength(5);
    expect(reloaded.candidate?.patch.domain).toBe("budget");
    expect(reloaded.lastKnownGood?.id).toBe(lkgId);
    // Production snapshot re-applied to pool maps.
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBe(0.12);
  });

  test("valid persisted theta is re-applied after restart", () => {
    const proposed = proposePolicy(
      { domain: "budget", theta: { routing_timeout_ms: 25_000 } },
      "valid theta restart",
    );
    expect(proposed.action).toBe("proposed");
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow; i++) {
      recordCandidateOutcome("success", i);
    }
    const shadowCandidate = getPolicyVersionStore().candidate;
    if (!shadowCandidate) throw new Error("shadow candidate is not available");
    expect(runShadowReplay(replayOutcomes(shadowCandidate, 20)).action).toBe("entered_canary");
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }
    persistPolicyVersions(root);

    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    loadPolicyVersions(root);

    expect(policy().routing_timeout_ms).toBe(25_000);
  });

  test("unknown schema is ignored atomically with a stable warning", () => {
    promoteValidPolicy();
    const beforeStore = JSON.parse(JSON.stringify(getPolicyVersionStore()));
    const beforePool = snapshotPool();
    persistPolicyVersions(root);
    const raw = JSON.parse(readFileSync(policyVersionsPath(root), "utf-8"));
    raw.schemaVersion = 2;
    writeFileSync(policyVersionsPath(root), JSON.stringify(raw), "utf-8");

    const warnings = captureWarnings(() => loadPolicyVersions(root));

    expect(warnings).toContain("[PolicyStaging] Ignoring invalid policy versions: unknown_schema");
    expect(getPolicyVersionStore()).toEqual(beforeStore);
    expect(snapshotPool()).toEqual(beforePool);
  });

  test("malformed snapshots are ignored atomically", () => {
    promoteValidPolicy();
    const beforeStore = JSON.parse(JSON.stringify(getPolicyVersionStore()));
    const beforePool = snapshotPool();
    persistPolicyVersions(root);
    const validRaw = JSON.parse(readFileSync(policyVersionsPath(root), "utf-8"));
    const mutations: Array<[string, (raw: any) => void]> = [
      ["missing_snapshot", (raw) => delete raw.production.snapshot],
      ["missing_map", (raw) => delete raw.production.snapshot.modelRoutingScoreDeltas],
      ["nonnumeric_map", (raw) => { raw.production.snapshot.modelRoutingScoreDeltas = { bad: "1" }; }],
      ["invalid_theta", (raw) => { raw.production.snapshot.theta = { unknown_dimension: 1 }; }],
      ["invalid_recovery", (raw) => { raw.production.snapshot.recovery = { bad: null }; }],
    ];

    for (const [label, mutate] of mutations) {
      const raw = JSON.parse(JSON.stringify(validRaw));
      mutate(raw);
      writeFileSync(policyVersionsPath(root), JSON.stringify(raw), "utf-8");
      const warnings = captureWarnings(() => loadPolicyVersions(root));
      expect(warnings).toContain(`[PolicyStaging] Ignoring invalid policy versions: invalid_state (${label})`);
      expect(getPolicyVersionStore()).toEqual(beforeStore);
      expect(snapshotPool()).toEqual(beforePool);
    }
  });

  test("invalid stages, counters, and pointers are ignored atomically", () => {
    promoteValidPolicy();
    const beforeStore = JSON.parse(JSON.stringify(getPolicyVersionStore()));
    const beforePool = snapshotPool();
    persistPolicyVersions(root);
    const validRaw = JSON.parse(readFileSync(policyVersionsPath(root), "utf-8"));
    const mutations: Array<[string, (raw: any) => void]> = [
      ["invalid_stage", (raw) => { raw.production.stage = "candidate"; }],
      ["negative_counter", (raw) => { raw.production.eligibleOutcomes = -1; }],
      ["counter_mismatch", (raw) => { raw.production.eligibleSuccessCount += 1; }],
      ["invalid_next_version", (raw) => { raw.nextVersion = 0; }],
      ["invalid_lkg_stage", (raw) => { raw.lastKnownGood.stage = "candidate"; }],
      ["duplicate_production_lkg_id", (raw) => { raw.lastKnownGood.id = raw.production.id; }],
    ];

    for (const [label, mutate] of mutations) {
      const raw = JSON.parse(JSON.stringify(validRaw));
      mutate(raw);
      writeFileSync(policyVersionsPath(root), JSON.stringify(raw), "utf-8");
      const warnings = captureWarnings(() => loadPolicyVersions(root));
      const reason = label === "negative_counter"
        ? "invalid_counter"
        : label === "invalid_lkg_stage"
          ? "invalid_stage"
          : label === "duplicate_production_lkg_id"
            ? "pointer_mismatch"
            : label;
      expect(warnings).toContain(`[PolicyStaging] Ignoring invalid policy versions: invalid_state (${reason})`);
      expect(getPolicyVersionStore()).toEqual(beforeStore);
      expect(snapshotPool()).toEqual(beforePool);
    }
  });

  test("candidate and canary pointers must describe the same version", () => {
    advanceToCanary(1.0);
    const beforeStore = JSON.parse(JSON.stringify(getPolicyVersionStore()));
    const beforePool = snapshotPool();
    persistPolicyVersions(root);
    const raw = JSON.parse(readFileSync(policyVersionsPath(root), "utf-8"));
    raw.candidate.id = "different-version";
    writeFileSync(policyVersionsPath(root), JSON.stringify(raw), "utf-8");

    const warnings = captureWarnings(() => loadPolicyVersions(root));

    expect(warnings).toContain("[PolicyStaging] Ignoring invalid policy versions: invalid_state (pointer_mismatch)");
    expect(getPolicyVersionStore()).toEqual(beforeStore);
    expect(snapshotPool()).toEqual(beforePool);
  });

  test("malformed JSON is ignored atomically", () => {
    promoteValidPolicy();
    const beforeStore = JSON.parse(JSON.stringify(getPolicyVersionStore()));
    const beforePool = snapshotPool();
    persistPolicyVersions(root);
    writeFileSync(policyVersionsPath(root), "{", "utf-8");

    const warnings = captureWarnings(() => loadPolicyVersions(root));

    expect(warnings).toContain("[PolicyStaging] Ignoring invalid policy versions: invalid_json");
    expect(getPolicyVersionStore()).toEqual(beforeStore);
    expect(snapshotPool()).toEqual(beforePool);
  });

  test("a valid empty schema-v1 store loads without creating versions", () => {
    persistPolicyVersions(root);
    writeFileSync(
      policyVersionsPath(root),
      JSON.stringify({
        schemaVersion: 1,
        nextVersion: 1,
        production: null,
        candidate: null,
        canary: null,
        lastKnownGood: null,
      }),
      "utf-8",
    );

    loadPolicyVersions(root);

    expect(getPolicyVersionStore()).toEqual({
      schemaVersion: 1,
      nextVersion: 1,
      production: null,
      candidate: null,
      canary: null,
      lastKnownGood: null,
    });
  });

  test("load is a no-op when no file exists", () => {
    loadPolicyVersions(root);
    expect(getPolicyVersionStore().production).toBeNull();
    expect(getPolicyVersionStore().candidate).toBeNull();
  });

  test("canary in-flight survives restart with rollback still available", () => {
    advanceToCanary(1.0);
    for (let i = 0; i < 7; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }
    const canaryId = getPolicyVersionStore().canary?.id;
    persistPolicyVersions(root);

    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    loadPolicyVersions(root);

    expect(getPolicyVersionStore().canary?.id).toBe(canaryId);
    expect(getPolicyVersionStore().canary?.canaryStats?.runs).toBe(7);
    // Finish promotion after restart.
    for (let i = 0; i < 13; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }
    expect(getPolicyVersionStore().production?.id).toBe(canaryId);
    expect(getPolicyVersionStore().canary).toBeNull();
    // LKG still present for rollback after restart-surviving promote.
    expect(getPolicyVersionStore().lastKnownGood).not.toBeNull();
    const rolled = rollbackPolicy("post_restart_rollback");
    expect(rolled.action).toBe("rolled_back");
  });
});

describe("recovery + budget domains", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
  });

  test("recovery patch lands in recoveryPolicy map only after promote", () => {
    const patch: PolicyPatch = {
      domain: "recovery",
      recovery: { prefer_fallback_on_timeout: true, max_recovery_attempts: 2 },
    };
    proposePolicy(patch, "safer recovery");
    for (let i = 0; i < 20; i++) recordCandidateOutcome("success", i);
    const candidate = getPolicyVersionStore().candidate;
    if (!candidate) throw new Error("shadow candidate is not available");
    runShadowReplay(replayOutcomes(candidate, 20));
    expect(getLearnedPoolState().recoveryPolicy.size).toBe(0);
    for (let i = 0; i < 20; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }
    expect(getLearnedPoolState().recoveryPolicy.get("prefer_fallback_on_timeout")).toBe(true);
    expect(getLearnedPoolState().recoveryPolicy.get("max_recovery_attempts")).toBe(2);
  });
});

describe("merge apply + live shadow progress + canary overlay", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
  });

  test("applyPolicySnapshotToPool merges keys and preserves concurrent learning", () => {
    const state = getLearnedPoolState();
    state.modelRoutingScoreDeltas.set("openrouter:concurrent-learn", 0.07);
    state.modelFirstTokenTimeouts.set("openrouter:concurrent-learn", 12_000);

    applyPolicySnapshotToPool({
      modelRoutingScoreDeltas: { "opencode_go:deepseek-v4-flash": 0.12 },
      stageModelRoutingScoreDeltas: {},
      fallbackBoosts: {},
      modelFirstTokenTimeouts: { "opencode_go:deepseek-v4-flash": 40_000 },
      recovery: {},
    });

    expect(state.modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash")).toBe(0.12);
    expect(state.modelRoutingScoreDeltas.get("openrouter:concurrent-learn")).toBe(0.07);
    expect(state.modelFirstTokenTimeouts.get("openrouter:concurrent-learn")).toBe(12_000);
    expect(state.modelFirstTokenTimeouts.get("opencode_go:deepseek-v4-flash")).toBe(40_000);
  });

  test("promote merges canary keys without wiping concurrent inference-feedback keys", () => {
    // Concurrent operational feedback present before promote.
    getLearnedPoolState().modelRoutingScoreDeltas.set("openrouter:ops-feedback", -0.05);

    advanceToCanary(1.0);
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }

    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBe(0.12);
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("openrouter:ops-feedback"),
    ).toBe(-0.05);
  });

  test("rollback drops canary-only keys but keeps concurrent learning", () => {
    getLearnedPoolState().modelRoutingScoreDeltas.set("openrouter:ops-feedback", 0.03);

    advanceToCanary(1.0);
    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion; i++) {
      recordCanaryOutcome("canary", true);
      recordCanaryOutcome("production", true);
    }
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBe(0.12);

    const rolled = rollbackPolicy("operator_requested");
    expect(rolled.action).toBe("rolled_back");
    // Canary-only key removed via previous=active on merge.
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBeUndefined();
    // Concurrent operational key preserved.
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("openrouter:ops-feedback"),
    ).toBe(0.03);
  });

  test("live shadow outcomes auto-complete shadow without offline replay job", () => {
    advanceToShadow();
    expect(getPolicyVersionStore().candidate?.stage).toBe("shadow");

    for (let i = 0; i < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow - 1; i++) {
      const r = recordCandidateOutcome("success", 100 + i);
      expect(r.action).toBe("eligible_recorded");
      expect(r.reason).toContain("shadow_live_");
    }
    const entered = recordCandidateOutcome(
      "success",
      100 + POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow - 1,
    );
    expect(entered.action).toBe("entered_canary");
    expect(entered.version?.stage).toBe("canary");
    expect(getPolicyVersionStore().canary?.id).toBe(entered.version?.id);
    // Still held back from production maps until promote.
    expect(getLearnedPoolState().modelRoutingScoreDeltas.size).toBe(0);
  });

  test("live shadow rejects catastrophic success rate without offline job", () => {
    advanceToShadow();
    let last = recordCandidateOutcome("failed", 200);
    for (let i = 1; i < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow; i++) {
      last = recordCandidateOutcome("failed", 200 + i);
    }
    expect(last.action).toBe("rejected");
    expect(last.reason).toBe("shadow_failed_quality_gate");
    expect(getPolicyVersionStore().candidate).toBeNull();
    expect(getPolicyVersionStore().canary).toBeNull();
  });

  test("runWithPolicyOverlay surfaces canary snapshot for routing without mutating pool", () => {
    advanceToCanary();
    const canarySnap = activeSnapshotForArm("canary");
    const agent: OrchestratorAgent = {
      id: "a",
      provider: "opencode_go",
      model_id: "deepseek-v4-flash",
      capabilities: { code: 0.7, reasoning: 0.7, speed: 0.7, cost: 0.7, json_reliability: 0.7 },
      default_for: [],
      enabled: true,
    };

    expect(modelRoutingScoreDelta(agent)).toBe(0);
    expect(getLearnedPoolState().modelRoutingScoreDeltas.size).toBe(0);

    const scored = runWithPolicyOverlay(canarySnap, () => modelRoutingScoreDelta(agent));
    expect(scored).toBe(0.12);
    // Global maps still production (empty).
    expect(getLearnedPoolState().modelRoutingScoreDeltas.size).toBe(0);
    expect(modelRoutingScoreDelta(agent)).toBe(0);
  });

  test("snapshotStagedPolicyFields round-trips merge apply", () => {
    const state = getLearnedPoolState();
    state.fallbackBoosts.set("agent:executor:refactor", 0.1);
    state.recoveryPolicy.set("max_recovery_attempts", 3);
    const snap = snapshotStagedPolicyFields();
    resetLearnedPoolStateForTests();
    applyPolicySnapshotToPool(snap);
    expect(getLearnedPoolState().fallbackBoosts.get("agent:executor:refactor")).toBe(0.1);
    expect(getLearnedPoolState().recoveryPolicy.get("max_recovery_attempts")).toBe(3);
  });
});
