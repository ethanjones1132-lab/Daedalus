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
import { ConductorBus } from "./conductor-bus";
import { LiveConductor } from "./conductor";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } from "./agent-pool";

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
  test("planner empty completion retries once then executes without a plan or replan", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      const stage = options?.stageLabel ?? "?";
      stageLabels.push(stage);
      if (stage === "planner") return { content: "" };
      if (stage === "reviewer") return { content: "ACCEPT" };
      if (stage === "synthesizer") return { content: "Grounded answer without a plan." };
      return { content: "Executor continued without a plan." };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    let coordinatorCalls = 0;
    coordinator.route = (async () => {
      coordinatorCalls++;
      throw new Error("planner degradation must not consume a replan");
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: "explain the runtime architecture",
      initialDecision: baseDecision({ pipeline: ["planner", "executor", "reviewer", "synthesizer"] }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "planner-empty-degrade" },
      executor,
      agentRunId: "run-planner-empty-degrade",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 2,
    });

    expect(stageLabels.filter((stage) => stage === "planner")).toHaveLength(2);
    expect(stageLabels).toContain("executor");
    expect(coordinatorCalls).toBe(0);
    expect(result.outcome).toBe("degraded");
    expect(result.error_code).toBe("upstream_stage_failed");
  });

  test("reviewer empty completion retries once then proceeds", async () => {
    // F7: reasoning models sometimes emit empty visible content (whole budget
    // burned in the thinking channel). One retry on a fresh callModel lets
    // stage-health steer to another candidate before an empty verdict silently
    // skips the review gate. Mirrors the planner retry.
    const stageLabels: string[] = [];
    let reviewerCalls = 0;
    const callModel = async (_messages: any[], options?: any) => {
      const stage = options?.stageLabel ?? "?";
      stageLabels.push(stage);
      if (stage === "planner") return { content: "PLAN: do the thing" };
      if (stage === "reviewer") {
        reviewerCalls++;
        return { content: reviewerCalls === 1 ? "" : "ACCEPT" };
      }
      if (stage === "synthesizer") return { content: "Final grounded answer." };
      return { content: "Executor did the thing." };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);

    const result = await runPipelineWithReplanning({
      contextMessage: "explain the runtime architecture",
      initialDecision: baseDecision({ pipeline: ["planner", "executor", "reviewer", "synthesizer"] }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "reviewer-empty-retry" },
      executor,
      agentRunId: "run-reviewer-empty-retry",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 2,
    });

    // Reviewer invoked twice (empty → retry → ACCEPT); pipeline still reaches synthesizer.
    expect(reviewerCalls).toBe(2);
    expect(stageLabels).toContain("synthesizer");
    expect(result.outcome).not.toBe("degraded");
  });

  test("planner double-empty bypasses live-conductor self-reroute accounting", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      const stage = options?.stageLabel ?? "?";
      stageLabels.push(stage);
      if (stage === "planner") return { content: "" };
      if (stage === "reviewer") return { content: "ACCEPT" };
      if (stage === "synthesizer") return { content: "Executor evidence synthesized." };
      return { content: "Executor continued without a plan." };
    };
    const bus = new ConductorBus();
    const supervisionStages: string[] = [];
    const live = new LiveConductor(
      callModel as any,
      bus,
      new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS),
      { supervision_timeout_ms: 1_000, max_tool_errors_before_reroute: 1, supervise_low_complexity: true },
      (async (messages: Array<{ role: string; content: string }>) => {
        const content = messages.map((message) => message.content).join("\n");
        const stage = content.match(/Stage:\s*(\w+)/)?.[1] ?? "unknown";
        supervisionStages.push(stage);
        return stage === "planner"
          ? {
              content: JSON.stringify({
                directive: "reroute",
                newRemaining: ["re-enter:planner", "executor", "reviewer", "synthesizer"],
                reason: "retry planner",
              }),
            }
          : { content: JSON.stringify({ directive: "continue" }) };
      }) as any,
    );
    live.setContext("general", "medium", "run-planner-live-double-empty");
    const directives: unknown[] = [];
    const collector = {
      recordStageRun: () => {},
      recordDirective: (row: unknown) => directives.push(row),
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, { bus, live, collector });
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    let coordinatorCalls = 0;
    coordinator.route = (async () => {
      coordinatorCalls++;
      throw new Error("planner degradation must not enter the replan loop");
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: "explain the runtime architecture",
      initialDecision: baseDecision({ pipeline: ["planner", "executor", "reviewer", "synthesizer"] }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "planner-live-double-empty" },
      executor,
      agentRunId: "run-planner-live-double-empty",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 2,
    });
    bus.clear();

    expect(stageLabels.filter((stage) => stage === "planner")).toHaveLength(2);
    expect(supervisionStages.filter((stage) => stage === "planner")).toHaveLength(0);
    expect(directives.filter((row: any) => row.stage === "planner" && row.directive_type === "reroute")).toHaveLength(0);
    expect(coordinatorCalls).toBe(0);
    expect(result.outcome).toBe("degraded");
  });

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

  test("repeated failed writes terminate at the no-write fence before live replan or review", async () => {
    const impossibleRuntime = createToolRuntime();
    impossibleRuntime.register({
      type: "function",
      function: {
        name: "write_file",
        description: "write a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      requires_approval: false,
      dangerous: false,
    }, async () => {
      throw new Error("EPERM: Z:\\JarvisImpossibleRoot does not exist");
    });
    const impossibleCtx = makeExecutionContext("chat", defaultConfig(), {
      session_id: "impossible-write-fence",
      workspace_path: process.cwd(),
    });

    const stageLabels: string[] = [];
    let writeAttempts = 0;
    const request = "Create Z:\\JarvisImpossibleRoot\\never-created\\proof.txt with exact content proof and do not simulate success.";
    const callModel = async (_messages: any[], options?: any) => {
      const stage = options?.stageLabel ?? "unknown";
      stageLabels.push(stage);
      if (stage === "executor") {
        writeAttempts++;
        return {
          content: "Attempting the requested write.",
          tool_calls: [{
            id: `call_write_${writeAttempts}`,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "Z:\\JarvisImpossibleRoot\\never-created\\proof.txt",
                content: "proof",
              }),
            },
          }],
        };
      }
      if (stage === "reviewer") return { content: "REJECT: no file was created" };
      if (stage === "rewriter") return { content: "Unable to repair the impossible path." };
      if (stage === "synthesizer") return { content: "The write did not complete." };
      return { content: "continue" };
    };

    const bus = new ConductorBus();
    const live = new LiveConductor(
      callModel as any,
      bus,
      new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS),
      { supervision_timeout_ms: 1_000, max_tool_errors_before_reroute: 1, supervise_low_complexity: true },
      (async () => ({ content: JSON.stringify({ directive: "continue" }) })) as any,
    );
    live.setContext("debug", "medium", "run-impossible-write-fence");
    const executor = new PipelineExecutor(callModel as any, impossibleRuntime, impossibleCtx, {
      bus,
      live,
      collector: testCollector,
    });
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    let coordinatorCalls = 0;
    coordinator.route = (async () => {
      coordinatorCalls++;
      return baseDecision({ pipeline: ["executor", "reviewer", "synthesizer"] });
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: request,
      initialDecision: baseDecision({ pipeline: ["executor", "reviewer", "synthesizer"] }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "impossible-write-fence" },
      executor,
      agentRunId: "run-impossible-write-fence",
      onStateChange: () => {},
      baseOptions: {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: request,
      },
      maxReplans: 1,
    });
    bus.clear();

    expect(result).toMatchObject({
      outcome: "failed",
      error_code: "effect_gate_no_write_effect",
    });
    expect(writeAttempts).toBe(2);
    expect(result.toolCalls?.map((call) => call.output)).toEqual([
      expect.stringContaining("EPERM"),
      expect.stringContaining("EPERM"),
    ]);
    expect(coordinatorCalls).toBe(0);
    expect(stageLabels).not.toContain("reviewer");
    expect(stageLabels).not.toContain("rewriter");
    expect(stageLabels).not.toContain("synthesizer");
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
    // "migrate the users table" carries write intent, and this fixture model
    // only ever answers prose — so the executor stage presses its bounded
    // write-effect nudge three times before accepting the prose ending:
    // 4 executor model calls for the single executor stage entry.
    expect(stageLabels).toEqual(["executor", "executor", "executor", "executor", "rewriter", "reviewer", "synthesizer"]);
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
    // The executor STAGE legitimately runs twice here: once in the pre-budget
    // segment, and again in the final segment, because the coordinator's LAST
    // decision (returned just before the budget ran out) still explicitly
    // lists "executor" — and an explicit request in the model's own decision
    // always wins over "already completed", even across the budget-exhaustion
    // boundary. Each stage entry additionally makes 4 model calls (initial +
    // 3 bounded write-effect nudges) because this write-intent
    // fixture only ever answers prose.
    expect(stageLabels).toEqual([
      "executor", "executor", "executor", "executor",
      "rewriter",
      "executor", "executor", "executor", "executor",
      "reviewer", "synthesizer",
    ]);
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
    // Two executor STAGE entries (original + deliberate re-run), each pressed
    // by the bounded write-effect nudge into 4 model calls.
    expect(stageLabels).toEqual([
      "executor", "executor", "executor", "executor",
      "rewriter",
      "executor", "executor", "executor", "executor",
      "reviewer", "synthesizer",
    ]);
    expect(stageLabels.filter((s) => s === "executor")).toHaveLength(8);
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
  });

  test("evidence-insufficient replan forces executor even when revised route is synthesizer-only", async () => {
    const segmentStages: string[][] = [];
    const executor = {
      executeSegment: async (
        _request: string,
        stages: string[],
        _agentRunId: string,
        _onStateChange: unknown,
        _options: unknown,
        carry: any = {},
      ) => {
        segmentStages.push([...stages]);
        if (segmentStages.length === 1) {
          return {
            state: {
              ...carry,
              executor: { ok: false, narrative: "insufficient evidence", toolCalls: [] },
            },
            replanRequested: {
              trigger: "evidence_insufficient",
              detail: "needs real workspace evidence",
            },
          };
        }
        return {
          state: {
            ...carry,
            executor: { ok: true, narrative: "executor reran", toolCalls: [] },
          },
          synthesizerAnswer: "final answer",
          synthesizerEmptyCompletion: false,
        };
      },
    } as unknown as PipelineExecutor;

    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => baseDecision({
      pipeline: ["synthesizer"],
      coordinator_rationale: "parse fallback/default route",
    })) as typeof coordinator.route;

    await runPipelineWithReplanning({
      contextMessage: "comprehensively audit this repo without modifying files",
      initialDecision: baseDecision({ pipeline: ["executor", "synthesizer"] }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "force-executor-replan" },
      executor,
      agentRunId: "run-force-executor-replan",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 1,
    });

    expect(segmentStages[0]).toEqual(["executor", "reviewer", "synthesizer"]);
    expect(segmentStages[1]).toContain("executor");
    expect(segmentStages[1]).toContain("synthesizer");
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

  // ── 2026-07-17 incident (run_cce0482e): mid-run replan coordinator hit its
  // 15s stage deadline, the unguarded `coordinator.route` throw aborted the
  // whole turn, and the user's chat bubble was the raw
  // "Stage deadline exceeded (15000ms) on stage=coordinator" string.
  // A replan-coordinator failure must degrade to "continue without replan",
  // never abort the turn.
  test("marker-path coordinator failure continues with the remaining planned stages", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      stageLabels.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => {
      throw new Error("Stage deadline exceeded (15000ms) on stage=coordinator");
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(), // ["executor","conductor_replan","reviewer","synthesizer"]
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "coordinator-crash-marker" },
      executor,
      agentRunId: "run-coordinator-crash-marker",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 2,
    });

    // The turn survives: remaining stages run and the synthesizer's honest
    // (effect-gated) answer ships instead of a raw deadline error.
    expect(stageLabels).toContain("synthesizer");
    expect(result.answer).toBe("output for synthesizer");
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
  });

  test("mid-run replan coordinator failure falls through to final synthesis", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      stageLabels.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => {
      throw new Error("Stage deadline exceeded (15000ms) on stage=coordinator");
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      // No conductor_replan marker: the replan is requested mid-run by the
      // effect gate (write intent + zero successful mutations).
      initialDecision: baseDecision({ pipeline: ["executor", "reviewer", "synthesizer"] }),
      turnRequirement: "full_execution",
      coordinator,
      routeOptions: { sessionId: "coordinator-crash-midrun" },
      executor,
      agentRunId: "run-coordinator-crash-midrun",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 1,
    });

    expect(stageLabels).toContain("synthesizer");
    expect(result.answer).toBe("output for synthesizer");
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
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
