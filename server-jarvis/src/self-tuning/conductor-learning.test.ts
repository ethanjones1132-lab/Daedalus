import { describe, expect, test, beforeEach } from "bun:test";
import { ConductorLearningLoop } from "./conductor-learning";
import { SelfTuningStore } from "./store";
import { resetLearnedPoolStateForTests } from "./learned-pool-state";
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
    });

    loop.recordStageModel({
      agentRunId: "run_p4",
      stageId: "executor",
      agentId: sampleAgent.id,
      provider: "opencode_zen",
      modelId: "north-mini-code-free",
      durationMs: 1200,
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
      }],
      modelAttributions: store.getModelAttributions("run_p4"),
      durationMs: 5000,
      userRequest: "fix auth bug",
    });

    expect(store.getConductorRuns("run_p4")[0].run_outcome).toBe("success");
    expect(store.getModelAttributions("run_p4")).toHaveLength(1);
    expect(store.getTrajectorySnapshots(1)).toHaveLength(1);
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
});