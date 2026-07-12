// server-jarvis/src/orchestration/replan-loop.test.ts
import { describe, expect, test } from "bun:test";
import { runPipelineWithReplanning } from "./replan-loop";
import { PipelineExecutor } from "./pipeline";
import { Coordinator } from "./coordinator";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { defaultConfig } from "../config";
import { SessionReplanCounter } from "./replan-telemetry";
import { SelfTuningStore } from "../self-tuning/store";
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
  test("preserves missing_workspace_evidence through the replan finalizer", async () => {
    const calls: string[] = [];
    const executor = new PipelineExecutor(async (_messages, options) => {
      calls.push(options?.stageLabel ?? "unknown");
      return { content: "This is an Expo app configured by app.json." };
    }, runtime, ctx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);

    const result = await runPipelineWithReplanning({
      contextMessage: "Summarize this repo.",
      initialDecision: baseDecision({ pipeline: ["executor", "synthesizer"] }),
      turnRequirement: "workspace_read",
      coordinator,
      routeOptions: { sessionId: "workspace-evidence-replan" },
      executor,
      agentRunId: "run-workspace-evidence-replan",
      onStateChange: () => {},
      baseOptions: {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
      },
      maxReplans: 0,
    });

    expect(calls).toEqual(["executor", "executor"]);
    expect(result).toMatchObject({
      answer: "",
      outcome: "failed",
      error_code: "missing_workspace_evidence",
    });
  });

  test("final segment with a failed executor call is degraded by the effect gate", async () => {
    const failingRuntime = createToolRuntime();
    failingRuntime.register({
      type: "function",
      function: {
        name: "boom",
        description: "deliberately fail",
        parameters: { type: "object", properties: {}, required: [] },
      },
      requires_approval: false,
      dangerous: false,
    }, async () => {
      throw new Error("write failed");
    });
    const failingCtx = makeExecutionContext("agent", defaultConfig(), {
      session_id: "effect-gate-replan",
      workspace_path: process.cwd(),
    });
    let executorTurns = 0;
    const callModel = async (_messages: any[], options?: any) => {
      if (options?.stageLabel === "executor" && executorTurns++ === 0) {
        return {
          content: "trying",
          tool_calls: [{
            id: "call_boom",
            type: "function",
            function: { name: "boom", arguments: "{}" },
          }],
        };
      }
      if (options?.stageLabel === "reviewer") return { content: "ACCEPT" };
      if (options?.stageLabel === "synthesizer") return { content: "The write failed." };
      return { content: "done" };
    };
    const executor = new PipelineExecutor(callModel as any, failingRuntime, failingCtx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);

    const result = await runPipelineWithReplanning({
      contextMessage: "change the target",
      initialDecision: baseDecision({ pipeline: ["executor", "reviewer", "synthesizer"] }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "effect-gate-replan" },
      executor,
      agentRunId: "run-effect-gate-replan",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 0,
    });

    expect(result.outcome).toBe("degraded");
    expect(result.error_code).toBe("effect_gate_tool_failures");
  });

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
      turnRequirement: "full_execution",
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
    // Deliberate effect-gate inversion: this full-execution fixture never
    // produces a successful write, so a polished answer is still failed.
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
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
      turnRequirement: "full_execution",
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
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
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
      turnRequirement: "full_execution",
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
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
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

// ═══════════════════════════════════════════════════════════════
// B-04: per-session replan cap + persistent `replan_events` telemetry.
// ═══════════════════════════════════════════════════════════════

describe("runPipelineWithReplanning — B-04 session cap + telemetry", () => {
  test("B-04: replan events are recorded to the store with replan_index, rationale, revised_pipeline, session_id", async () => {
    const callModel = async () => ({ content: "ok" });
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    // Coordinator: one replan, then a clean revised route.
    let calls = 0;
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => {
      calls += 1;
      return {
        task_type: "debug",
        pipeline: ["reviewer", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
        coordinator_rationale: "the schema turned out to be different from what we expected",
        worker_instructions: { reviewer: "use the new schema" },
      } as CoordinatorResult;
    }) as typeof coordinator.route;

    // In-memory store so the test never touches the production self-tuning DB.
    const store = new SelfTuningStore(":memory:");
    const counter = new SessionReplanCounter({ maxPerSession: 6, store });

    await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "b04-s1" },
      executor,
      agentRunId: "run-b04-1",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 2,
      sessionCounter: counter,
      sessionId: "b04-s1",
    });

    expect(calls).toBe(1);
    expect(counter.used("b04-s1")).toBe(1);
    const events = store.getReplanEventsForSession("b04-s1");
    expect(events).toHaveLength(1);
    expect(events[0].replan_index).toBe(1);
    expect(events[0].session_id).toBe("b04-s1");
    expect(events[0].agent_run_id).toBe("run-b04-1");
    expect(events[0].rationale).toContain("schema");
    expect(JSON.parse(events[0].revised_pipeline)).toEqual(["reviewer", "synthesizer"]);
    expect(events[0].revised_worker_instructions_keys).toBe("reviewer");
    expect(events[0].capped).toBe(""); // no cap hit — loop completed normally
    expect(events[0].segment_outcome).toBe("success");
  });

  test("B-04: session-level cap is enforced independently of per-turn cap (binding constraint = session)", async () => {
    const callModel = async () => ({ content: "ok" });
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    // The coordinator always returns a replan-on-replan decision so the
    // budget (whichever is binding) is what stops the loop.
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => baseDecision()) as typeof coordinator.route;

    // Per-turn cap is generous (5); session cap is tight (2). After 2
    // replans the loop must terminate, with `error_code: "session_replan_cap_exceeded"`.
    const counter = new SessionReplanCounter({ maxPerSession: 2, store: null });

    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "b04-s2" },
      executor,
      agentRunId: "run-b04-2",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 5,
      sessionCounter: counter,
      sessionId: "b04-s2",
    });

    expect(counter.used("b04-s2")).toBe(2);
    expect(result.outcome).toBe("failed");
    // A real missing-effect failure outranks the softer session-cap tag.
    expect(result.error_code).toBe("effect_gate_no_write_effect");
  });

  test("B-04: per-turn cap is preserved when session cap is generous (binding constraint = per_turn)", async () => {
    const callModel = async () => ({ content: "ok" });
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => baseDecision()) as typeof coordinator.route;

    // Session cap = 10, per-turn cap = 1. Loop must terminate after 1
    // replan (per-turn wins), session cap untouched, and the result is
    // NOT tagged with `session_replan_cap_exceeded` — it terminated via
    // per-turn exhaustion, which is a normal outcome.
    const counter = new SessionReplanCounter({ maxPerSession: 10, store: null });

    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "b04-s3" },
      executor,
      agentRunId: "run-b04-3",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 1,
      sessionCounter: counter,
      sessionId: "b04-s3",
    });

    expect(counter.used("b04-s3")).toBe(1);
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
  });

  test("B-04: clearSession resets the counter so a fresh session can replan again", async () => {
    const counter = new SessionReplanCounter({ maxPerSession: 1, store: null });
    counter.record({
      sessionId: "b04-s4",
      agentRunId: "run-old",
      replanIndex: 0,
      rationale: "old",
      revised: baseDecision(),
      segmentOutcome: "success",
      cap: "",
    });
    expect(counter.used("b04-s4")).toBe(1);
    expect(counter.remaining("b04-s4")).toBe(0);

    counter.clearSession("b04-s4");
    expect(counter.used("b04-s4")).toBe(0);
    expect(counter.remaining("b04-s4")).toBe(1);

    // Cross-session isolation: another session's counter is untouched.
    counter.record({
      sessionId: "b04-s5",
      agentRunId: "run-other",
      replanIndex: 0,
      rationale: "other",
      revised: baseDecision(),
      segmentOutcome: "success",
      cap: "",
    });
    expect(counter.used("b04-s4")).toBe(0);
    expect(counter.used("b04-s5")).toBe(1);
  });
});
