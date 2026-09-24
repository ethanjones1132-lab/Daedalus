import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConductorLearningLoop, type RunCompletionInput } from "./conductor-learning";
import { SessionOutcomeCollector } from "./collector";
import { RunFinalizer } from "./run-finalizer";
import { SelfTuningStore } from "./store";
import type { CoordinatorResult } from "../orchestration/coordinator";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function route(): CoordinatorResult {
  return {
    task_type: "debug",
    pipeline: ["executor"],
    topology: "linear",
    context: {
      needs_workspace_inspection: true,
      needs_memory: false,
      estimated_complexity: "low",
    },
    coordinator_rationale: "exercise the runtime",
    worker_instructions: { executor: "Inspect the failing test." },
    conductor_source: "local",
    conductor_model: "test-model",
  };
}

function setup(options: { trajectoryExport?: boolean; onTerminal?: () => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-run-finalizer-"));
  temporaryDirectories.push(directory);
  const store = new SelfTuningStore(join(directory, "self-tuning.db"));
  const collector = new SessionOutcomeCollector(store);
  const learning = new ConductorLearningLoop(store, {
    enabled: true,
    min_samples_for_heuristics: 5,
    capability_adjustment_step: 0.03,
    trajectory_export: options.trajectoryExport ?? true,
    instruction_ab_epsilon: 0,
    max_trajectory_snapshots: 20,
  });
  const finalizer = new RunFinalizer({
    agentRunId: "run_finalizer",
    sessionId: "session_finalizer",
    userRequest: "inspect the failing test",
    taskType: "debug",
    pipeline: ["executor"],
    route: route(),
    normalizedPipeline: ["executor"],
    routeSource: "model",
    conductorSource: "local",
    conductorModel: "test-model",
    latencyMs: 4,
    store,
    collector,
    learning,
    onTerminal: options.onTerminal,
  });
  return { store, collector, learning, finalizer };
}

function addEvidence(collector: SessionOutcomeCollector, learning: ConductorLearningLoop): void {
  collector.recordStageRun({
    id: "stage_finalizer",
    agent_run_id: "run_finalizer",
    mode_id: "executor",
    turn_number: 1,
    input_tokens: 11,
    output_tokens: 7,
    tool_calls_json: JSON.stringify([{ name: "read_file" }]),
    duration_ms: 40,
    was_successful: 0,
    had_error: 1,
    error_message: "synthetic_failure",
  });
  learning.recordStageModel({
    agentRunId: "run_finalizer",
    stageId: "executor",
    stageRunId: "stage_finalizer",
    agentId: "agent-finalizer",
    provider: "test",
    modelId: "test-model",
    durationMs: 40,
    wasSuccessful: false,
    hadError: true,
  });
}

function snapshots(store: SelfTuningStore): Array<Record<string, unknown>> {
  return store
    .getTrajectorySnapshots(20)
    .filter((row) => row.agent_run_id === "run_finalizer")
    .map((row) => JSON.parse(row.snapshot_json) as Record<string, unknown>);
}

describe("RunFinalizer", () => {
  test("does nothing when finalization is attempted before start", () => {
    const { store, finalizer } = setup();

    expect(finalizer.finalize({ finalOutput: "late", durationMs: 1, outcome: "failed" })).toBe("not_started");
    expect(store.getAgentRuns()).toHaveLength(0);
    expect(store.getConductorRuns()).toHaveLength(0);
    expect(store.getTrajectorySnapshots(20)).toHaveLength(0);
  });

  test("finalizes a routed failure with canonical evidence and one snapshot", () => {
    const { store, collector, learning, finalizer } = setup();

    expect(finalizer.start()).toBe(true);
    addEvidence(collector, learning);

    expect(finalizer.finalize({ finalOutput: "failed", durationMs: 80, outcome: "failed" })).toBe("claimed");
    expect(finalizer.isFinalized()).toBe(true);
    expect(learning.hasPendingAttributions("run_finalizer")).toBe(false);

    const run = store.getAgentRuns().find((row) => row.id === "run_finalizer");
    expect(run?.completed).toBe(1);
    expect(run?.outcome).toBe("failed");
    expect(store.getConductorRuns("run_finalizer")[0]?.run_outcome).toBe("failed");
    expect(snapshots(store)).toHaveLength(1);
    expect(snapshots(store)[0]?.stage_runs).toEqual([
      expect.objectContaining({ id: "stage_finalizer", had_error: 1 }),
    ]);
    expect(snapshots(store)[0]?.model_attributions).toEqual([
      expect.objectContaining({ agent_id: "agent-finalizer", had_error: 1 }),
    ]);
  });

  test("keeps cancellation distinct in the parent and suppresses learning updates", () => {
    const { store, collector, learning, finalizer } = setup();

    expect(finalizer.start()).toBe(true);
    addEvidence(collector, learning);

    expect(finalizer.finalize({ finalOutput: "cancelled", durationMs: 20, outcome: "cancelled" })).toBe("claimed");
    expect(store.getAgentRuns()[0]?.outcome).toBe("cancelled");
    expect(store.getConductorRuns("run_finalizer")[0]?.run_outcome).toBe("failed");
    expect(store.getInstructionVariantStats()).toHaveLength(0);
    expect(store.getAgentPerformance()).toHaveLength(0);
    expect(snapshots(store)).toHaveLength(1);
  });

  test("preserves a successful terminal record when a later side effect throws", () => {
    const afterTerminal = () => {
      throw new Error("post-finalization side effect failed");
    };
    const { store, finalizer } = setup({ onTerminal: afterTerminal });

    expect(finalizer.start()).toBe(true);
    expect(() => finalizer.finalize({
      finalOutput: "answer",
      durationMs: 12,
      outcome: "success",
      verifiedVia: "runtime_check",
      checkTier: "existing",
      rewardScore: 0.8,
      rewardJson: "{\"score\":0.8}",
    })).toThrow("post-finalization side effect failed");

    expect(finalizer.finalize({ finalOutput: "overwritten", durationMs: 99, outcome: "failed" })).toBe("already_terminal");
    const run = store.getAgentRuns()[0];
    expect(run?.outcome).toBe("success");
    expect(run?.reward_score).toBe(0.8);
    expect(run?.verified_via).toBe("runtime_check");
    expect(store.getConductorRuns("run_finalizer")[0]?.run_outcome).toBe("success");
    expect(snapshots(store)).toHaveLength(1);
  });

  test("maps partial parent outcomes to degraded learning without duplicating terminal effects", () => {
    const { store, finalizer } = setup();

    expect(finalizer.start()).toBe(true);
    expect(finalizer.finalize({ finalOutput: "partial", durationMs: 30, outcome: "partial" })).toBe("claimed");
    expect(finalizer.finalize({ finalOutput: "retry", durationMs: 31, outcome: "failed" })).toBe("already_terminal");
    expect(store.getAgentRuns()[0]?.outcome).toBe("partial");
    expect(store.getConductorRuns("run_finalizer")[0]?.run_outcome).toBe("degraded");
    expect(snapshots(store)).toHaveLength(1);
  });

  test("allows only one finalizer to claim a run across store instances", () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-run-finalizer-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "shared.db");
    const firstStore = new SelfTuningStore(path);
    const secondStore = new SelfTuningStore(path);
    const firstCollector = new SessionOutcomeCollector(firstStore);
    const secondCollector = new SessionOutcomeCollector(secondStore);
    const firstLearning = new ConductorLearningLoop(firstStore);
    const secondLearning = new ConductorLearningLoop(secondStore);
    const first = new RunFinalizer({
      agentRunId: "run_shared",
      sessionId: "session_shared",
      userRequest: "shared",
      taskType: "general",
      pipeline: ["executor"],
      route: { ...route(), task_type: "general" },
      normalizedPipeline: ["executor"],
      conductorSource: "local",
      store: firstStore,
      collector: firstCollector,
      learning: firstLearning,
    });
    const second = new RunFinalizer({
      agentRunId: "run_shared",
      sessionId: "session_shared",
      userRequest: "shared",
      taskType: "general",
      pipeline: ["executor"],
      route: { ...route(), task_type: "general" },
      normalizedPipeline: ["executor"],
      conductorSource: "local",
      store: secondStore,
      collector: secondCollector,
      learning: secondLearning,
    });
    expect(first.start()).toBe(true);
    expect(second.start()).toBe(true);
    expect(first.finalize({ finalOutput: "first", durationMs: 1, outcome: "success" })).toBe("claimed");
    expect(second.finalize({ finalOutput: "second", durationMs: 2, outcome: "failed" })).toBe("already_terminal");
    expect(firstStore.getAgentRuns()[0]?.final_output).toBe("first");
    expect(firstStore.getTrajectorySnapshots(20)).toHaveLength(1);
  });
});

test("ConductorLearningLoop completion remains idempotent for legacy direct callers", () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-run-finalizer-"));
  temporaryDirectories.push(directory);
  const store = new SelfTuningStore(join(directory, "legacy.db"));
  const learning = new ConductorLearningLoop(store);
  store.insertAgentRun({
    id: "run_legacy",
    session_id: "session_legacy",
    user_request: "legacy",
    task_type: "general",
    pipeline: JSON.stringify(["executor"]),
    completed: 1,
  });
  const conductorRunId = learning.recordRouting({
    agentRunId: "run_legacy",
    sessionId: "session_legacy",
    route: route(),
    normalizedPipeline: ["executor"],
    conductorSource: "local",
  });
  const input: RunCompletionInput = {
    conductorRunId,
    agentRunId: "run_legacy",
    sessionId: "session_legacy",
    taskType: "general",
    route: route(),
    runOutcome: "success",
    instructionVariants: { variants: {} },
    stageRuns: [],
    modelAttributions: [],
    durationMs: 1,
    userRequest: "legacy",
  };
  expect(learning.completeRun(input)).toBe(true);
  expect(learning.completeRun(input)).toBe(false);
  expect(store.getTrajectorySnapshots(20).filter((row) => row.agent_run_id === "run_legacy")).toHaveLength(1);
});
