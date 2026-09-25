// server-jarvis/src/self-tuning/run-finalizer.instructions.test.ts
// Attribution contracts: the instruction evidence a turn records must describe
// the prompt the worker actually received, and the A/B arms must only be
// credited when that prompt is the one the selector arbitrated.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConductorLearningLoop } from "./conductor-learning";
import { SessionOutcomeCollector } from "./collector";
import { RunFinalizer } from "./run-finalizer";
import { SelfTuningStore } from "./store";
import { hashInstruction } from "../orchestration/worker-prompt";
import type { CoordinatorResult } from "../orchestration/coordinator";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const CONDUCTOR_TEXT = "Conductor-authored executor instruction.";
const REVISED_TEXT = "Revised executor instruction after the replan.";

function route(workerInstructions?: Record<string, string>): CoordinatorResult {
  return {
    task_type: "debug",
    pipeline: ["executor"],
    topology: "linear",
    context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "low" },
    coordinator_rationale: "exercise the runtime",
    worker_instructions: workerInstructions as CoordinatorResult["worker_instructions"],
    conductor_source: "local",
    conductor_model: "test-model",
  };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-instruction-binding-"));
  temporaryDirectories.push(directory);
  const store = new SelfTuningStore(join(directory, "self-tuning.db"));
  const learning = new ConductorLearningLoop(store, {
    enabled: true,
    min_samples_for_heuristics: 5,
    capability_adjustment_step: 0.03,
    trajectory_export: false,
    instruction_ab_epsilon: 0,
    max_trajectory_snapshots: 20,
  });
  const finalizer = new RunFinalizer({
    agentRunId: "run_binding",
    sessionId: "session_binding",
    userRequest: "inspect the failing test",
    taskType: "debug",
    pipeline: ["executor"],
    route: route({ executor: CONDUCTOR_TEXT }),
    normalizedPipeline: ["executor"],
    routeSource: "model",
    conductorSource: "local",
    conductorModel: "test-model",
    latencyMs: 4,
    store,
    collector: new SessionOutcomeCollector(store),
    learning,
  });
  return { store, learning, finalizer };
}

/** A stage run for the executor, as the pipeline would record it. */
function executorStageRun(successful = true) {
  return [{
    id: "stage_executor_binding",
    agent_run_id: "run_binding",
    mode_id: "executor",
    turn_number: 1,
    was_successful: successful ? 1 : 0,
    had_error: successful ? 0 : 1,
  }];
}

describe("RunFinalizer instruction attribution", () => {
  test("a baseline pick records the baseline arm, not the route's own text", () => {
    const { store, learning, finalizer } = setup();
    expect(finalizer.start()).toBe(true);
    // The selector chose baseline: no executor key survives in the selection.
    finalizer.setInstructionVariants({
      instructions: undefined,
      variants: { executor: "baseline" },
    });

    const completion = learning.prepareCompletion({
      conductorRunId: finalizer.runConductorId,
      agentRunId: "run_binding",
      sessionId: "session_binding",
      taskType: "debug",
      route: route({ executor: CONDUCTOR_TEXT }),
      runOutcome: "success",
      // The executed set is what the selector produced, not the raw route.
      workerInstructions: undefined,
      instructionVariants: { instructions: undefined, variants: { executor: "baseline" } },
      stageRuns: executorStageRun(),
      modelAttributions: [],
      durationMs: 100,
      userRequest: "inspect the failing test",
    });

    const outcome = completion.workerInstructionOutcomes[0];
    expect(outcome?.instruction_hash).toBe("baseline");
    expect(outcome?.instruction_variant).toBe("baseline");
    expect(outcome?.instruction_text).toBeUndefined();
    expect(completion.instructionVariants).toEqual([
      { variantId: "baseline", stageId: "executor", taskType: "debug", success: true },
    ]);
    expect(store.getInstructionVariantStats("debug")).toHaveLength(0);
  });

  test("a Conductor pick records the hash of the text that was sent", () => {
    const { learning, finalizer } = setup();
    expect(finalizer.start()).toBe(true);
    const conductorKey = `conductor:${hashInstruction(CONDUCTOR_TEXT)}`;
    finalizer.setInstructionVariants({
      instructions: { executor: CONDUCTOR_TEXT },
      variants: { executor: conductorKey },
    });

    const completion = learning.prepareCompletion({
      conductorRunId: finalizer.runConductorId,
      agentRunId: "run_binding",
      sessionId: "session_binding",
      taskType: "debug",
      route: route({ executor: CONDUCTOR_TEXT }),
      runOutcome: "success",
      workerInstructions: { executor: CONDUCTOR_TEXT },
      instructionVariants: {
        instructions: { executor: CONDUCTOR_TEXT },
        variants: { executor: conductorKey },
      },
      stageRuns: executorStageRun(),
      modelAttributions: [],
      durationMs: 100,
      userRequest: "inspect the failing test",
    });

    const outcome = completion.workerInstructionOutcomes[0];
    expect(outcome?.instruction_hash).toBe(hashInstruction(CONDUCTOR_TEXT));
    expect(outcome?.instruction_variant).toBe(conductorKey);
    expect(outcome?.instruction_text).toBe(CONDUCTOR_TEXT);
    expect(completion.instructionVariants).toEqual([
      { variantId: conductorKey, stageId: "executor", taskType: "debug", success: true },
    ]);
  });

  test("a revised instruction is recorded as provenance but credited to no arm", () => {
    const { store, learning, finalizer } = setup();
    expect(finalizer.start()).toBe(true);
    const conductorKey = `conductor:${hashInstruction(CONDUCTOR_TEXT)}`;
    finalizer.setInstructionVariants({
      instructions: { executor: CONDUCTOR_TEXT },
      variants: { executor: conductorKey },
    });
    // The replan loop sent a different instruction than the selector chose.
    finalizer.setExecutedInstructions({ instructions: { executor: REVISED_TEXT }, revised: true });

    finalizer.finalize({
      finalOutput: "done",
      durationMs: 100,
      outcome: "success",
      stageRuns: executorStageRun(),
      modelAttributions: [],
    });

    const outcomes = store.getWorkerInstructionOutcomes("run_binding");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.instruction_text).toBe(REVISED_TEXT);
    expect(outcomes[0]?.instruction_hash).toBe(hashInstruction(REVISED_TEXT));
    expect(outcomes[0]?.instruction_variant).toBe(`unselected:${hashInstruction(REVISED_TEXT)}`);
    // The A/B loop must not learn from a prompt it never selected.
    expect(store.getInstructionVariantStats("debug")).toHaveLength(0);
  });

  test("a revision that sends the selected text keeps the arm credit", () => {
    const { store, finalizer } = setup();
    expect(finalizer.start()).toBe(true);
    const conductorKey = `conductor:${hashInstruction(CONDUCTOR_TEXT)}`;
    finalizer.setInstructionVariants({
      instructions: { executor: CONDUCTOR_TEXT },
      variants: { executor: conductorKey },
    });
    // A replan that re-issued the same text changed nothing the worker saw.
    finalizer.setExecutedInstructions({ instructions: { executor: CONDUCTOR_TEXT }, revised: true });

    finalizer.finalize({
      finalOutput: "done",
      durationMs: 100,
      outcome: "success",
      stageRuns: executorStageRun(),
      modelAttributions: [],
    });

    const stats = store.getInstructionVariantStats("debug");
    expect(stats).toHaveLength(1);
    expect(stats[0]?.variant_id).toBe(conductorKey);
    expect(stats[0]?.sample_count).toBe(1);
  });

  test("the finalizer records the executed set rather than the route's own text", () => {
    const { store, finalizer } = setup();
    expect(finalizer.start()).toBe(true);
    // Baseline selection: the route still carries the Conductor's text.
    finalizer.setInstructionVariants({ instructions: undefined, variants: { executor: "baseline" } });
    finalizer.finalize({
      finalOutput: "done",
      durationMs: 100,
      outcome: "success",
      stageRuns: executorStageRun(),
      modelAttributions: [],
    });

    const outcomes = store.getWorkerInstructionOutcomes("run_binding");
    expect(outcomes).toHaveLength(1);
    // Regression: the finalizer used to re-derive this from
    // `route.worker_instructions`, describing a prompt the worker never saw.
    // SQLite returns NULL (not undefined) for the absent column.
    expect(outcomes[0]?.instruction_text ?? undefined).toBeUndefined();
    expect(outcomes[0]?.instruction_hash).toBe("baseline");
  });

  test("a stage that never ran records no instruction and no variant", () => {
    const { store, finalizer } = setup();
    expect(finalizer.start()).toBe(true);
    const conductorKey = `conductor:${hashInstruction(CONDUCTOR_TEXT)}`;
    finalizer.setInstructionVariants({
      instructions: { executor: CONDUCTOR_TEXT },
      variants: { executor: conductorKey },
    });

    finalizer.finalize({
      finalOutput: "done",
      durationMs: 100,
      outcome: "success",
      stageRuns: [],
      modelAttributions: [],
    });

    expect(store.getWorkerInstructionOutcomes("run_binding")).toHaveLength(0);
    expect(store.getInstructionVariantStats("debug")).toHaveLength(0);
  });
});
