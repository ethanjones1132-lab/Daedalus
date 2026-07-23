import { describe, expect, test, beforeEach } from "bun:test";
import { ConductorLearningLoop } from "./conductor-learning";
import { SelfTuningStore } from "./store";
import { resetLearnedPoolStateForTests } from "./learned-pool-state";
import { resetPolicyStagingForTests } from "./policy-staging";
import type { OrchestratorAgent } from "../orchestration/agent-pool";
import { hashInstruction } from "../orchestration/worker-prompt";

const TEST_DB = ":memory:";

const sampleAgent: OrchestratorAgent = {
  id: "zen-north-code-free",
  provider: "opencode_zen",
  model_id: "north-mini-code-free",
  capabilities: { code: 0.92, reasoning: 0.72, speed: 0.72, cost: 1, json_reliability: 0.8 },
  default_for: ["executor"],
  enabled: true,
};

describe("Conductor learning (Phase 4)", () => {
  beforeEach(() => {
    resetLearnedPoolStateForTests();
    resetPolicyStagingForTests();
  });

  test("records routing, model attribution, and trajectory on run completion", () => {
    const store = new SelfTuningStore(TEST_DB);
    const loop = new ConductorLearningLoop(store);
    store.insertAgentRun({
      id: "run_p4",
      session_id: "sess_p4",
      user_request: "fix auth bug",
      task_type: "debug",
      pipeline: JSON.stringify(["planner", "executor", "synthesizer"]),
      completed: 0,
    });

    const conductorRunId = loop.recordRouting({
      agentRunId: "run_p4",
      sessionId: "sess_p4",
      route: {
        task_type: "debug",
        pipeline: ["planner", "executor", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
        coordinator_rationale: "needs code changes",
        worker_instructions: { executor: "Read auth module first." },
        conductor_source: "local",
        conductor_model: "gemma4:e2b",
      },
      normalizedPipeline: ["planner", "executor", "synthesizer"],
      routeSource: "model",
      conductorSource: "local",
      conductorModel: "gemma4:e2b",
      latencyMs: 2770,
    });

    loop.recordStageModel({
      agentRunId: "run_p4",
      stageId: "executor",
      agentId: sampleAgent.id,
      provider: "opencode_zen",
      modelId: "north-mini-code-free",
      durationMs: 1200,
      firstTokenMs: 275,
      wasSuccessful: true,
    });

    const selection = loop.selectInstructionVariants(
      { executor: "Read auth module first." },
      "debug",
    );

    loop.completeRun({
      conductorRunId,
      agentRunId: "run_p4",
      sessionId: "sess_p4",
      taskType: "debug",
      route: {
        task_type: "debug",
        pipeline: ["planner", "executor", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
        coordinator_rationale: "needs code changes",
        worker_instructions: { executor: "Read auth module first." },
      },
      runOutcome: "success",
      workerInstructions: { executor: "Read auth module first." },
      instructionVariants: selection,
      stageRuns: [{
        id: "stage_exec",
        agent_run_id: "run_p4",
        mode_id: "executor",
        turn_number: 1,
        was_successful: 1,
        had_error: 0,
        stop_reason: "tool_calls",
      }, {
        id: "stage_synth",
        agent_run_id: "run_p4",
        mode_id: "synthesizer",
        turn_number: 1,
        was_successful: 0,
        had_error: 0,
        stop_reason: "provider_cut",
        partial_error_code: "stream_cut",
      }],
      modelAttributions: store.getModelAttributions("run_p4"),
      durationMs: 5000,
      userRequest: "fix auth bug",
    });

    expect(store.getConductorRuns("run_p4")[0].run_outcome).toBe("success");
    // P5.1: routing latency was only ever a console.log line, never queryable.
    expect(store.getConductorRuns("run_p4")[0].latency_ms).toBe(2770);
    expect(store.getModelAttributions("run_p4")).toHaveLength(1);
    expect(store.getModelAttributions("run_p4")[0].first_token_ms).toBe(275);
    expect(store.getTrajectorySnapshots(1)).toHaveLength(1);
    // T0.2: trajectory snapshot carries stop_reason / partial_error_code.
    const traj = JSON.parse(store.getTrajectorySnapshots(1)[0].snapshot_json);
    const synth = traj.stage_runs.find((s: { mode_id: string }) => s.mode_id === "synthesizer");
    expect(synth.stop_reason).toBe("provider_cut");
    expect(synth.partial_error_code).toBe("stream_cut");
    expect(store.getAgentPerformance("debug").some((r) => r.agent_id === sampleAgent.id)).toBe(true);
  });

  test("optimizeAndApply boosts high-performing agents and records proposals", async () => {
    const store = new SelfTuningStore(TEST_DB);
    const loop = new ConductorLearningLoop(store, {
      enabled: true,
      min_samples_for_heuristics: 3,
      capability_adjustment_step: 0.05,
      trajectory_export: false,
      instruction_ab_epsilon: 0,
      max_trajectory_snapshots: 100,
    });

    for (let i = 0; i < 5; i++) {
      store.upsertAgentPerformance(sampleAgent.id, "executor", "refactor", true, 800);
    }

    const result = await loop.optimizeAndApply("run_heur", "refactor", [sampleAgent]);
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.agentsAdjusted).toBeGreaterThan(0);
    expect(result.fallbackBoostsApplied).toBeGreaterThan(0);

    const adjusted = loop.applyLearnedAgents([sampleAgent]);
    expect(adjusted[0].capabilities.code).toBeGreaterThan(sampleAgent.capabilities.code);
  });

  test("F10: recordStageModel persists first_token_ms and never rewards empty success", () => {
    const store = new SelfTuningStore(TEST_DB);
    const loop = new ConductorLearningLoop(store);
    store.insertAgentRun({
      id: "run_f10",
      session_id: "sess_f10",
      user_request: "plan",
      task_type: "general",
      pipeline: JSON.stringify(["planner"]),
      completed: 0,
    });
    loop.recordStageModel({
      agentRunId: "run_f10",
      stageId: "planner",
      provider: "opencode_zen",
      modelId: "nemotron-3-ultra-free",
      durationMs: 4_000,
      firstTokenMs: 1_250,
      wasSuccessful: true,
    });
    loop.recordStageModel({
      agentRunId: "run_f10",
      stageId: "planner",
      provider: "opencode_zen",
      modelId: "nemotron-3-ultra-free",
      durationMs: 800,
      // empty completion — explicit failure
      wasSuccessful: false,
      hadError: true,
    });
    // Omitted wasSuccessful must not default to success.
    loop.recordStageModel({
      agentRunId: "run_f10",
      stageId: "planner",
      provider: "opencode_zen",
      modelId: "empty-default",
      durationMs: 10,
    });

    const rows = store.getModelAttributions("run_f10");
    expect(rows).toHaveLength(3);
    expect(rows[0].first_token_ms).toBe(1_250);
    expect(rows[0].was_successful).toBe(1);
    expect(rows[1].was_successful).toBe(0);
    expect(rows[1].had_error).toBe(1);
    expect(rows[2].was_successful).toBe(0);
    expect(rows[2].had_error).toBe(1);
  });

  test("completeRun skips instruction learning for stage_window_exhausted rows", () => {
    const store = new SelfTuningStore(TEST_DB);
    const loop = new ConductorLearningLoop(store);
    store.insertAgentRun({
      id: "run_starve",
      session_id: "sess_starve",
      user_request: "audit",
      task_type: "research",
      pipeline: JSON.stringify(["planner", "executor"]),
      completed: 0,
    });
    const conductorRunId = loop.recordRouting({
      agentRunId: "run_starve",
      sessionId: "sess_starve",
      route: {
        task_type: "research",
        pipeline: ["planner", "executor", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "high" },
        coordinator_rationale: "research",
        worker_instructions: { planner: "Write a gap plan." },
        conductor_source: "local",
        conductor_model: "gemma4:e2b",
      },
      normalizedPipeline: ["planner", "executor", "synthesizer"],
      routeSource: "model",
      conductorSource: "local",
      conductorModel: "gemma4:e2b",
    });
    const selection = loop.selectInstructionVariants(
      { planner: "Write a gap plan." },
      "research",
    );
    loop.completeRun({
      conductorRunId,
      agentRunId: "run_starve",
      sessionId: "sess_starve",
      taskType: "research",
      route: {
        task_type: "research",
        pipeline: ["planner", "executor", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "high" },
        coordinator_rationale: "research",
        worker_instructions: { planner: "Write a gap plan." },
      },
      runOutcome: "failed",
      workerInstructions: { planner: "Write a gap plan." },
      instructionVariants: selection,
      stageRuns: [{
        id: "stage_planner_starve",
        agent_run_id: "run_starve",
        mode_id: "planner",
        turn_number: 1,
        was_successful: 0,
        had_error: 1,
        error_message: "Stage budget exhausted on stage=planner",
        partial_error_code: "stage_window_exhausted",
      }],
      modelAttributions: [],
      durationMs: 90_000,
      userRequest: "audit",
    });
    // Starvation rows must not create instruction-variant trial samples.
    expect(store.getInstructionVariantStats("research")).toHaveLength(0);
  });

  test("instruction bandit can select baseline variant", () => {
    const store = new SelfTuningStore(TEST_DB);
    const loop = new ConductorLearningLoop(store, {
      enabled: true,
      min_samples_for_heuristics: 5,
      capability_adjustment_step: 0.03,
      trajectory_export: false,
      instruction_ab_epsilon: 0,
      max_trajectory_snapshots: 100,
    });

    for (let i = 0; i < 6; i++) {
      store.upsertInstructionVariantStats("baseline", "executor", "coding", true);
    }
    const instructionText = "Always run tests before committing.";
    const conductorKey = `conductor:${hashInstruction(instructionText)}`;
    for (let i = 0; i < 6; i++) {
      store.upsertInstructionVariantStats(conductorKey, "executor", "coding", false);
    }

    const selection = loop.selectInstructionVariants(
      { executor: instructionText },
      "coding",
    );
    expect(selection.variants.executor).toBe("baseline");
    expect(selection.instructions?.executor).toBeUndefined();
  });

  test("proposeStagedPolicy layers on top of immediate capability path without replacing it", async () => {
    const store = new SelfTuningStore(TEST_DB);
    const loop = new ConductorLearningLoop(store, {
      enabled: true,
      min_samples_for_heuristics: 3,
      capability_adjustment_step: 0.05,
      trajectory_export: false,
      instruction_ab_epsilon: 0,
      max_trajectory_snapshots: 100,
    });

    for (let i = 0; i < 5; i++) {
      store.upsertAgentPerformance(sampleAgent.id, "executor", "refactor", true, 800);
    }
    const heuristic = await loop.optimizeAndApply("run_both", "refactor", [sampleAgent]);
    expect(heuristic.agentsAdjusted).toBeGreaterThan(0);

    const staged = loop.proposeStagedPolicy(
      {
        domain: "budget",
        modelFirstTokenTimeouts: { "opencode_zen:north-mini-code-free": 30_000 },
      },
      "budget canary candidate",
    );
    expect(staged.action).toBe("proposed");
    expect(staged.version?.stage).toBe("candidate");

    // Capability delta from optimizeAndApply remains applied immediately.
    const adjusted = loop.applyLearnedAgents([sampleAgent]);
    expect(adjusted[0].capabilities.code).toBeGreaterThan(sampleAgent.capabilities.code);

    // Budget candidate is held back — pool timeout map still empty.
    const { getLearnedPoolState } = await import("./learned-pool-state");
    expect(getLearnedPoolState().modelFirstTokenTimeouts.size).toBe(0);

    // Eligible outcomes advance toward shadow without mutating production maps.
    for (let i = 0; i < 19; i++) loop.noteEligiblePolicyOutcome("success");
    const entered = loop.noteEligiblePolicyOutcome("success");
    expect(entered.action).toBe("entered_shadow");
    expect(getLearnedPoolState().modelFirstTokenTimeouts.size).toBe(0);
  });
});
