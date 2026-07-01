// server-jarvis/src/orchestration/replan-loop.test.ts
import { describe, expect, test } from "bun:test";
import { runPipelineWithReplanning } from "./replan-loop";
import { PipelineExecutor } from "./pipeline";
import { Coordinator } from "./coordinator";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { defaultConfig } from "../config";
import type { StageRunRecorder } from "./pipeline";
import type { CoordinatorResult } from "./coordinator";

// In-memory collector so this test can never touch the production self-tuning DB.
const testCollector: StageRunRecorder = { recordStageRun: () => {} };
const runtime = createToolRuntime();
const ctx = makeExecutionContext("agent", defaultConfig(), { session_id: "s1", workspace_path: process.cwd() });

function baseDecision(overrides: Partial<CoordinatorResult> = {}): CoordinatorResult {
  return {
    task_type: "debug",
    pipeline: ["executor", "conductor_replan", "reviewer", "synthesizer"],
    topology: "linear",
    context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
    coordinator_rationale: "fixture",
    ...overrides,
  };
}

describe("runPipelineWithReplanning", () => {
  test("runs the first segment, re-invokes the conductor, then finishes with the revised route", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      stageLabels.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    let coordinatorCalls = 0;
    const coordinatorCallModel = async () => ({ content: "unused" }); // Coordinator not exercised via API path here
    const coordinator = new Coordinator(coordinatorCallModel as any);
    coordinator.route = (async (request: string) => {
      coordinatorCalls += 1;
      expect(request).toContain("[MID-PIPELINE REPLAN]");
      return {
        task_type: "debug",
        pipeline: ["reviewer", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
        coordinator_rationale: "revised after discovering the real schema",
        worker_instructions: { reviewer: "focus on the new schema" },
      } as CoordinatorResult;
    }) as typeof coordinator.route;

    const stateEvents: string[] = [];
    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "workspace_read",
      coordinator,
      routeOptions: { sessionId: "s1" },
      executor,
      agentRunId: "run-replan-1",
      onStateChange: (state) => stateEvents.push(`${state.stage}:${state.status}`),
      baseOptions: {},
      maxReplans: 2,
    });

    expect(coordinatorCalls).toBe(1);
    expect(stageLabels).toEqual(["executor", "reviewer", "synthesizer"]);
    expect(stateEvents).toContain("conductor_replan:running");
    expect(stateEvents).toContain("conductor_replan:done");
    expect(result.outcome).toBe("success");
    expect(result.answer).toBe("output for synthesizer");
  });

  test("stops replanning once maxReplans is exhausted and runs the remaining pipeline to completion", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      stageLabels.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    let coordinatorCalls = 0;
    coordinator.route = (async () => {
      coordinatorCalls += 1;
      // Every replan response ALSO asks to replan again — the budget must win.
      return baseDecision() as CoordinatorResult;
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "workspace_read",
      coordinator,
      routeOptions: { sessionId: "s1" },
      executor,
      agentRunId: "run-replan-2",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 1,
    });

    expect(coordinatorCalls).toBe(1); // exactly one replan invocation, then budget exhausted
    // Executor legitimately runs twice here: once in the pre-budget segment,
    // and again in the final segment, because the coordinator's LAST decision
    // (returned just before the budget ran out) still explicitly lists
    // "executor" — and an explicit request in the model's own decision always
    // wins over "already completed", even across the budget-exhaustion
    // boundary. This mirrors the deliberate-re-run guarantee (see the
    // "deliberately re-requested executor runs again" test above): the loop
    // intentionally trusts the model's latest explicit stage list rather than
    // inferring staleness, bounded by maxReplans so the worst case is a few
    // extra model calls, never incorrect output.
    expect(stageLabels).toEqual(["executor", "executor", "reviewer", "synthesizer"]);
    expect(result.outcome).toBe("success");
  });

  test("deliberately re-requested executor runs again even though carry already has its output", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      stageLabels.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    let coordinatorCalls = 0;
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async (request: string) => {
      coordinatorCalls += 1;
      expect(request).toContain("[MID-PIPELINE REPLAN]");
      // The coordinator decided the original executor pass was wrong and
      // explicitly wants it redone with revised instructions.
      return {
        task_type: "debug",
        pipeline: ["executor", "reviewer", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
        coordinator_rationale: "the original executor pass targeted the wrong table",
        worker_instructions: { executor: "redo against the correct schema" },
      } as CoordinatorResult;
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "workspace_read",
      coordinator,
      routeOptions: { sessionId: "s1" },
      executor,
      agentRunId: "run-replan-4",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 2,
    });

    expect(coordinatorCalls).toBe(1);
    expect(stageLabels).toEqual(["executor", "executor", "reviewer", "synthesizer"]);
    expect(stageLabels.filter((s) => s === "executor")).toHaveLength(2);
    expect(result.outcome).toBe("success");
  });

  test("read_only profile cannot escalate to full even if the replanned decision implies more authority", async () => {
    const profiles: Array<string | undefined> = [];
    const callModel = async () => ({ content: "ok" });
    const runtimeSpy = createToolRuntime();
    const executor = new PipelineExecutor(callModel as any, runtimeSpy, ctx, testCollector);
    const originalExecuteSegment = executor.executeSegment.bind(executor);
    executor.executeSegment = (async (request, stages, agentRunId, onStateChange, options, carry) => {
      profiles.push(options.executionProfile);
      return originalExecuteSegment(request, stages, agentRunId, onStateChange, options, carry);
    }) as typeof executor.executeSegment;

    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => baseDecision({ pipeline: ["reviewer", "synthesizer"] })) as typeof coordinator.route;

    await runPipelineWithReplanning({
      contextMessage: "read the config",
      initialDecision: baseDecision(),
      turnRequirement: "workspace_read", // maps to read_only via normalizeRoute
      coordinator,
      routeOptions: { sessionId: "s1" },
      executor,
      agentRunId: "run-replan-3",
      onStateChange: () => {},
      baseOptions: { executionProfile: "full" }, // caller-supplied "full" must NOT win
      maxReplans: 2,
    });

    expect(profiles.every((p) => p === "read_only")).toBe(true);
  });
});
