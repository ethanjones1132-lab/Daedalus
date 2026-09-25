// server-jarvis/src/orchestration/replan-loop.instructions.test.ts
// Production-boundary contracts: the prompt the worker actually receives must be
// the instruction the A/B selector chose, for every segment of a turn — and a
// replan revision must be reported so the turn's attribution can be corrected.
import { describe, expect, test } from "bun:test";
import { runPipelineWithReplanning } from "./replan-loop";
import { PipelineExecutor } from "./pipeline";
import { Coordinator } from "./coordinator";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { defaultConfig } from "../config";
import type { StageRunRecorder } from "./pipeline";
import type { CoordinatorResult } from "./coordinator";

const testCollector: StageRunRecorder = { recordStageRun: () => {} };
const runtime = createToolRuntime();
const ctx = makeExecutionContext("agent", defaultConfig(), { session_id: "s1", workspace_path: process.cwd() });

const CONDUCTOR_EXECUTOR_TEXT = "Conductor-authored executor instruction.";
const SELECTED_EXECUTOR_TEXT = "Selected executor instruction.";
const REVISED_REVIEWER_TEXT = "Focus on the newly discovered schema.";

/** Captures the real system prompt each stage's worker was sent. */
function promptHarness() {
  const prompts: Array<{ stage: string; system: string }> = [];
  const callModel = async (messages: any[], options?: any) => {
    const stage: string = options?.stageLabel ?? "?";
    const system = String(messages?.[0]?.content ?? "");
    prompts.push({ stage, system });
    if (stage === "reviewer") return { content: "ACCEPT" };
    if (stage === "synthesizer") return { content: "Grounded answer." };
    return { content: `output for ${stage}` };
  };
  return { prompts, executor: new PipelineExecutor(callModel as any, runtime, ctx, testCollector) };
}

function decision(overrides: Partial<CoordinatorResult> = {}): CoordinatorResult {
  return {
    task_type: "debug",
    pipeline: ["executor", "conductor_replan", "reviewer", "synthesizer"],
    topology: "linear",
    context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "low" },
    coordinator_rationale: "fixture",
    ...overrides,
  };
}

/** No replan marker: one segment runs the whole pipeline. */
const NO_REPLAN = decision({ pipeline: ["executor", "reviewer", "synthesizer"] });

describe("selected instructions reach the executed worker", () => {
  test("a baseline pick sends the static stage baseline, not the Conductor's text", async () => {
    const { prompts, executor } = promptHarness();
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);

    await runPipelineWithReplanning({
      contextMessage: "inspect the failing test",
      // The route still carries the Conductor's instruction, but the selector
      // dropped the stage when it chose baseline — so `selectedInstructions` has
      // no executor key.
      initialDecision: decision({
        pipeline: ["executor", "reviewer", "synthesizer"],
        worker_instructions: { executor: CONDUCTOR_EXECUTOR_TEXT },
      }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "s-baseline" },
      executor,
      agentRunId: "run-baseline-no-replan",
      onStateChange: () => {},
      baseOptions: { workerInstructions: undefined },
      maxReplans: 1,
    });

    const executorPrompt = prompts.find((p) => p.stage === "executor")?.system ?? "";
    expect(executorPrompt).not.toContain(CONDUCTOR_EXECUTOR_TEXT);
    // The stage baseline contract still applies — the prompt is not empty.
    expect(executorPrompt).not.toContain("Conductor instructions for this request:");
  });

  test("a Conductor pick sends the exact selected text", async () => {
    const { prompts, executor } = promptHarness();
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);

    await runPipelineWithReplanning({
      contextMessage: "inspect the failing test",
      initialDecision: decision({
        pipeline: ["executor", "reviewer", "synthesizer"],
        worker_instructions: { executor: CONDUCTOR_EXECUTOR_TEXT },
      }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "s-conductor" },
      executor,
      agentRunId: "run-conductor-no-replan",
      onStateChange: () => {},
      baseOptions: { workerInstructions: { executor: SELECTED_EXECUTOR_TEXT } },
      maxReplans: 1,
    });

    const executorPrompt = prompts.find((p) => p.stage === "executor")?.system ?? "";
    expect(executorPrompt).toContain(SELECTED_EXECUTOR_TEXT);
    expect(executorPrompt).not.toContain(CONDUCTOR_EXECUTOR_TEXT);
  });

  test("a baseline pick survives the first segment of a replan-marked route", async () => {
    const { prompts, executor } = promptHarness();
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);

    // Regression: the replan marker path used to re-read the *initial*
    // decision's own `worker_instructions`, so the executor ran the Conductor's
    // text while the selector had recorded the baseline arm.
    await runPipelineWithReplanning({
      contextMessage: "inspect the failing test",
      initialDecision: decision({
        worker_instructions: { executor: CONDUCTOR_EXECUTOR_TEXT },
      }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "s-baseline-replan" },
      executor,
      agentRunId: "run-baseline-replan",
      onStateChange: () => {},
      baseOptions: { workerInstructions: undefined },
      maxReplans: 1,
    });

    const executorPrompts = prompts.filter((p) => p.stage === "executor").map((p) => p.system);
    expect(executorPrompts.length).toBeGreaterThan(0);
    for (const prompt of executorPrompts) {
      expect(prompt).not.toContain(CONDUCTOR_EXECUTOR_TEXT);
    }
  });
});

describe("replan revisions are reported to the turn's attribution", () => {
  test("a revised decision's instructions are executed and reported as revised", async () => {
    const { prompts, executor } = promptHarness();
    const revisions: Array<{ instructions: unknown; revised: boolean }> = [];
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () =>
      decision({
        pipeline: ["reviewer", "synthesizer"],
        worker_instructions: { reviewer: REVISED_REVIEWER_TEXT },
        coordinator_rationale: "revised",
      }) as CoordinatorResult) as typeof coordinator.route;

    await runPipelineWithReplanning({
      contextMessage: "inspect the failing test",
      initialDecision: decision({
        worker_instructions: { executor: CONDUCTOR_EXECUTOR_TEXT },
      }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "s-revised" },
      executor,
      agentRunId: "run-revised",
      onStateChange: () => {},
      baseOptions: { workerInstructions: { executor: SELECTED_EXECUTOR_TEXT } },
      maxReplans: 1,
      onInstructionsRevised: (report) => revisions.push(report),
    });

    const reviewerPrompt = prompts.find((p) => p.stage === "reviewer")?.system ?? "";
    expect(reviewerPrompt).toContain(REVISED_REVIEWER_TEXT);

    // Exactly one report: the revision that was actually sent downstream, so
    // the run finalizer can record the prompt the workers really received
    // instead of the route it started from.
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revised).toBe(true);
    expect(revisions[0]?.instructions).toEqual({ reviewer: REVISED_REVIEWER_TEXT });
  });

  test("a turn with no replan reports no revision", async () => {
    const { executor } = promptHarness();
    const revisions: unknown[] = [];
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);

    await runPipelineWithReplanning({
      contextMessage: "inspect the failing test",
      initialDecision: NO_REPLAN,
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "s-no-replan" },
      executor,
      agentRunId: "run-no-replan",
      onStateChange: () => {},
      baseOptions: { workerInstructions: { executor: SELECTED_EXECUTOR_TEXT } },
      maxReplans: 1,
      onInstructionsRevised: (report) => revisions.push(report),
    });

    expect(revisions).toEqual([]);
  });
});
