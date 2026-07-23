import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
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
  type PolicyPatch,
} from "./policy-staging";
import type { OrchestratorAgent } from "../orchestration/agent-pool";

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
    const r = recordEligibleOutcome(i % 5 === 0 ? "failed" : "success");
    expect(r.action).toBe("eligible_recorded");
  }
  const entered = recordEligibleOutcome("success");
  expect(entered.action).toBe("entered_shadow");
  expect(entered.version?.stage).toBe("shadow");
}

function advanceToCanary(successRate = 0.9): void {
  advanceToShadow();
  const n = POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow;
  const outcomes = Array.from({ length: n }, (_, i) => ({
    success: i / n < successRate,
  }));
  const r = runShadowReplay(outcomes);
  expect(r.action).toBe("entered_canary");
  expect(r.version?.stage).toBe("canary");
  expect(getPolicyVersionStore().canary?.id).toBe(r.version?.id);
}

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
    const fail = runShadowReplay(
      Array.from({ length: 20 }, () => ({ success: false })),
    );
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
    for (let i = 0; i < 5; i++) recordEligibleOutcome("success");

    persistPolicyVersions(root);
    expect(existsSync(policyVersionsPath(root))).toBe(true);
    const onDisk = JSON.parse(readFileSync(policyVersionsPath(root), "utf-8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.production.id).toBe(productionId);
    expect(onDisk.candidate.stage).toBe("candidate");
    expect(onDisk.candidate.eligibleOutcomes).toBe(5);
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
    expect(reloaded.candidate?.patch.domain).toBe("budget");
    expect(reloaded.lastKnownGood?.id).toBe(lkgId);
    // Production snapshot re-applied to pool maps.
    expect(
      getLearnedPoolState().modelRoutingScoreDeltas.get("opencode_go:deepseek-v4-flash"),
    ).toBe(0.12);
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
    for (let i = 0; i < 20; i++) recordEligibleOutcome("success");
    runShadowReplay(Array.from({ length: 20 }, () => ({ success: true })));
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
      const r = recordEligibleOutcome("success");
      expect(r.action).toBe("eligible_recorded");
      expect(r.reason).toContain("shadow_live_");
    }
    const entered = recordEligibleOutcome("success");
    expect(entered.action).toBe("entered_canary");
    expect(entered.version?.stage).toBe("canary");
    expect(getPolicyVersionStore().canary?.id).toBe(entered.version?.id);
    // Still held back from production maps until promote.
    expect(getLearnedPoolState().modelRoutingScoreDeltas.size).toBe(0);
  });

  test("live shadow rejects catastrophic success rate without offline job", () => {
    advanceToShadow();
    let last = recordEligibleOutcome("failed");
    for (let i = 1; i < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow; i++) {
      last = recordEligibleOutcome("failed");
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
