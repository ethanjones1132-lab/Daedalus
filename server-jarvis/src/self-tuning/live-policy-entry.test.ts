import { beforeEach, describe, expect, test } from "bun:test";
import { DeadToolTracker } from "../orchestration/dead-tool-suppression";
import { policy, resetGlobalThetaToBaseline } from "../orchestration/orchestration-policy";
import { createTurnBudget } from "../orchestration/turn-budget";
import { ConductorLearningLoop } from "./conductor-learning";
import { resetLearnedPoolStateForTests } from "./learned-pool-state";
import {
  POLICY_STAGING_GOVERNANCE,
  resetPolicyStagingForTests,
} from "./policy-staging";
import { SelfTuningStore } from "./store";

function learningLoop(): ConductorLearningLoop {
  return new ConductorLearningLoop(new SelfTuningStore(":memory:"), {
    enabled: true,
    min_samples_for_heuristics: 3,
    capability_adjustment_step: 0.05,
    trajectory_export: false,
    instruction_ab_epsilon: 0,
    max_trajectory_snapshots: 100,
  });
}

function advanceCandidateToCanary(loop: ConductorLearningLoop): void {
  const proposed = loop.proposeStagedPolicy({
    domain: "budget",
    theta: {
      absolute_turn_cap_ms: 10_000,
      stage_extension_ceiling_ms: 10_000,
      routing_timeout_ms: 1_000,
      dead_tool_suppress_threshold: 1,
    },
  }, "live-entry regression");
  expect(proposed.action).toBe("proposed");
  for (let i = 0; i < POLICY_STAGING_GOVERNANCE.minEligibleOutcomesBeforeShadow; i++) {
    loop.noteEligiblePolicyOutcome("success");
  }
  for (let i = 0; i < POLICY_STAGING_GOVERNANCE.minEligibleOutcomesBeforeShadow; i++) {
    loop.noteEligiblePolicyOutcome("success");
  }
}

describe("live policy turn entry", () => {
  beforeEach(() => {
    resetPolicyStagingForTests();
    resetLearnedPoolStateForTests();
    resetGlobalThetaToBaseline();
  });

  test("selected canary scopes initial budget, routing timeout, and owner construction", () => {
    const loop = learningLoop();
    advanceCandidateToCanary(loop);

    const canary = loop.runSelectedPolicyTurn(() => {
      const budget = createTurnBudget("answer_only", "low", 0);
      const deadTools = new DeadToolTracker();
      deadTools.record("grep", true, "executable not found");
      return {
        turnMs: budget.turn_ms,
        routingTimeoutMs: policy().routing_timeout_ms,
        deadToolSuppressed: deadTools.isSuppressed("grep"),
      };
    }, () => 0);

    expect(canary).toEqual({
      arm: "canary",
      result: {
        turnMs: 10_000,
        routingTimeoutMs: 1_000,
        deadToolSuppressed: true,
      },
    });

    const production = loop.runSelectedPolicyTurn(() => {
      const budget = createTurnBudget("answer_only", "low", 0);
      const deadTools = new DeadToolTracker();
      deadTools.record("grep", true, "executable not found");
      return {
        turnMs: budget.turn_ms,
        routingTimeoutMs: policy().routing_timeout_ms,
        deadToolSuppressed: deadTools.isSuppressed("grep"),
      };
    }, () => 0.99);

    expect(production).toEqual({
      arm: "production",
      result: {
        turnMs: 45_000,
        routingTimeoutMs: 20_000,
        deadToolSuppressed: false,
      },
    });
  });

  test("selected arm remains active across asynchronous turn work", async () => {
    const loop = learningLoop();
    advanceCandidateToCanary(loop);

    const selected = loop.runSelectedPolicyTurn(async () => {
      await Promise.resolve();
      const deadTools = new DeadToolTracker();
      deadTools.record("grep", true, "executable not found");
      return {
        routingTimeoutMs: policy().routing_timeout_ms,
        deadToolSuppressed: deadTools.isSuppressed("grep"),
      };
    }, () => 0);

    expect(selected.arm).toBe("canary");
    expect(await selected.result).toEqual({
      routingTimeoutMs: 1_000,
      deadToolSuppressed: true,
    });
  });
});
