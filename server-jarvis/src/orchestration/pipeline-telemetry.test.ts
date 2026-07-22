import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { StageRun } from "../self-tuning/store";
import { PipelineExecutor, type StageRunRecorder } from "./pipeline";
import { LiveConductor } from "./conductor";
import { ConductorBus } from "./conductor-bus";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS } from "./agent-pool";
import { TurnDeadlineExceededError } from "../stream-liveness";
import { DEEP_READ_MIN_CONTENT_READS } from "./evidence-sufficiency";

function toolDefinition(name: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description: `${name} test tool`,
      parameters: { type: "object" as const, properties: {}, required: [] },
    },
    requires_approval: false,
    dangerous: false,
  };
}

function toolCall(name: string) {
  return {
    id: `call_${name}`,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

function toolCallWithArgs(name: string, args: Record<string, unknown>) {
  return {
    id: `call_${name}_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function telemetryHarness(toolName: string, handler: () => Promise<string>) {
  const rows: StageRun[] = [];
  const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
  const runtime = createToolRuntime();
  runtime.register(toolDefinition(toolName), handler);
  const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
  return { rows, runtime, ctx, collector };
}

describe("pipeline stage telemetry", () => {
  test("high-complexity gate failure retries the executor once with a different model", async () => {
    class GateRetryExecutor extends PipelineExecutor {
      private syntaxGateCalls = 0;

      protected async gateWrittenSyntax(_toolCalls: any[]): Promise<any[]> {
        this.syntaxGateCalls++;
        return this.syntaxGateCalls === 1
          ? [{ path: "p2-retry.py", message: "invalid syntax", kind: "syntax" }]
          : [];
      }

      protected async gateWrittenRun(): Promise<any> {
        return { status: "skipped", reason: "test", issues: [] };
      }
    }

    const runtime = createToolRuntime();
    runtime.register(toolDefinition("write_file"), async () => "written");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    ctx.config.tools.require_approval = [];
    const exclusions: string[][] = [];
    let executorCalls = 0;
    const callModel = async (_messages: unknown[], options: any = {}) => {
      if (options.stageLabel === "executor") {
        exclusions.push(options.excludeModels ?? []);
        const model = executorCalls < 2 ? "model-one" : "model-two";
        const writeTurn = executorCalls % 2 === 0;
        executorCalls++;
        return {
          content: writeTurn ? "candidate write" : "candidate complete",
          ...(writeTurn ? { tool_calls: [toolCallWithArgs("write_file", { path: "p2-retry.py", content: "fixed" })] } : {}),
          _provider: "openrouter",
          _modelUsed: model,
        };
      }
      if (options.stageLabel === "reviewer") return { content: "ACCEPT" };
      if (options.stageLabel === "synthesizer") return { content: "final answer" };
      return { content: "plan" };
    };

    const executor = new GateRetryExecutor(callModel as any, runtime, ctx, { recordStageRun: () => {} });
    const result = await executor.execute("fix p2-retry.py", ["executor", "reviewer", "synthesizer"], "run-p2-retry", () => {}, {
      executionProfile: "full",
      estimatedComplexity: "high",
      rawMessage: "fix p2-retry.py",
      maxReviewRepairRounds: 0,
      allowMidRunReplan: false,
    });

    expect(result.answer).toBe("final answer");
    expect(executorCalls).toBe(4);
    expect(exclusions[0]).toEqual([]);
    expect(exclusions[2]).toEqual(["openrouter:model-one"]);
  });

  test("preserves streamed synthesis as a partial answer when the turn deadline expires", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const collector: StageRunRecorder = { recordStageRun: () => {} };
    const callModel = async (_messages: unknown[], options: { stageLabel?: string; onChunk?: (chunk: string) => void } = {}) => {
      if (options.stageLabel === "synthesizer") {
        options.onChunk?.("Partial plan: inspect the runtime first.");
        throw new TurnDeadlineExceededError("synthesizer", 150_000);
      }
      return { content: "unexpected" };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);

    const result = await executor.execute("make a plan", ["synthesizer"], "run-synth-deadline", () => {});

    expect(result.answer).toBe("Partial plan: inspect the runtime first.");
    expect(result.outcome).toBe("partial");
    expect(result.error_code).toBe("turn_deadline");
    expect(result.error).toBeUndefined();
  });

  test("executor stage run records had_error:1 when a tool call fails", async () => {
    const { rows, runtime, ctx, collector } = telemetryHarness("boom", async () => {
      throw new Error("deliberate tool failure");
    });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "trying", tool_calls: [toolCall("boom")] };
      }
      return { content: "done" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.execute("run the failing tool", ["executor"], "run-tool-failure", () => {});

    const failedTurn = rows.find((row) => row.mode_id === "executor" && row.turn_number === 1);
    expect(failedTurn?.was_successful).toBe(0);
    expect(failedTurn?.had_error).toBe(1);
    expect(failedTurn?.error_message).toContain("boom: deliberate tool failure");
  });

  test("executor stage run stays was_successful:1 when tools succeed", async () => {
    const { rows, runtime, ctx, collector } = telemetryHarness("okay", async () => "worked");
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "trying", tool_calls: [toolCall("okay")] };
      }
      return { content: "done" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.execute("run the successful tool", ["executor"], "run-tool-success", () => {});

    const successfulTurn = rows.find((row) => row.mode_id === "executor" && row.turn_number === 1);
    expect(successfulTurn?.was_successful).toBe(1);
    expect(successfulTurn?.had_error).toBe(0);
    expect(successfulTurn?.error_message).toBeUndefined();
  });

  test("executor salvages a request timeout after successful evidence", async () => {
    const { rows, runtime, ctx, collector } = telemetryHarness("read_file", async () => "grounded evidence");
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "reading", tool_calls: [toolCallWithArgs("read_file", { path: "src/app.ts" })] };
      }
      throw new Error("Request timed out after 60s");
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);

    const result = await executor.execute("inspect src/app.ts", ["executor"], "run-timeout-salvage", () => {});

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.output).toBe("grounded evidence");
    const timeoutRow = rows.find((row) => row.mode_id === "executor" && row.had_error === 1);
    expect(timeoutRow?.error_message).toContain("Request timed out");
  });

  test("executor keeps zero-evidence request timeouts loud", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const executor = new PipelineExecutor(
      (async () => { throw new Error("Stream idle timeout after 60s"); }) as any,
      runtime,
      ctx,
      { recordStageRun: () => {} },
    );

    expect(executor.executeSegment("inspect src/app.ts", ["executor"], "run-timeout-loud", () => {}, {}))
      .rejects.toThrow("Stream idle timeout");
  });

  test("successful executor turns are not marked as model errors while evidence is still pending", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "source contents");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorCalls = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorCalls++;
        return {
          content: "I read one source file and need more evidence.",
          tool_calls: executorCalls === 1
            ? [toolCallWithArgs("read_file", { path: "src/a.ts" })]
            : [],
        };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.executeSegment(
      "comprehensively audit this repo",
      ["executor", "synthesizer"],
      "run-evidence-pending-telemetry",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
        rawMessage: "comprehensively audit this repo",
        allowMidRunReplan: true,
      },
    );

    const executorRows = rows.filter((row) => row.mode_id === "executor");
    expect(executorRows.length).toBeGreaterThan(0);
    expect(executorRows[0]?.was_successful).toBe(1);
    expect(executorRows[0]?.had_error).toBe(0);
    expect(executorRows[0]?.error_message).toBeUndefined();
  });

  test("executor re-entry carries prior successful reads into the evidence ledger", async () => {
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async (args) => `contents of ${String((args as { path?: unknown }).path)}`);
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorCalls = 0;
    let addedRemainingEvidence = false;
    const executorInputs: any[][] = [];
    const callModel = async (messages: any[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorCalls++;
        executorInputs.push(messages);
        const hasCarriedEvidence = messages.some((message) => String(message.content).includes("[Runtime carried evidence]"));
        if (!hasCarriedEvidence && executorCalls === 1) {
          return {
            content: "I read two files; I need one more.",
            tool_calls: [
              toolCallWithArgs("read_file", { path: "src/a.ts" }),
              toolCallWithArgs("read_file", { path: "src/b.ts" }),
            ],
          };
        }
        if (hasCarriedEvidence && !addedRemainingEvidence) {
          addedRemainingEvidence = true;
          return {
            content: "I read the remaining source file.",
            tool_calls: [toolCallWithArgs("read_file", { path: "src/c.ts" })],
          };
        }
        return { content: "done", tool_calls: [] };
      }
      return { content: "final answer" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx);
    const first = await executor.executeSegment(
      "comprehensively audit this repo",
      ["executor"],
      "run-evidence-carry-1",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
        rawMessage: "comprehensively audit this repo",
        allowMidRunReplan: false,
      },
    );
    const firstSegmentExecutorCalls = executorCalls;
    const second = await executor.executeSegment(
      "comprehensively audit this repo",
      ["executor", "synthesizer"],
      "run-evidence-carry-2",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
        rawMessage: "comprehensively audit this repo",
        allowMidRunReplan: false,
      },
      first.state,
    );

    expect(executorCalls).toBeGreaterThanOrEqual(2);
    expect(executorInputs[firstSegmentExecutorCalls].some((message) => String(message.content).includes("src/a.ts"))).toBe(true);
    expect(second.synthesizerFatalError).toBeUndefined();
    expect(second.state.executor?.toolCalls.filter((call) => call.name === "read_file")).toHaveLength(3);
  });

  // Task 1.3: PipelineResult.toolCalls is the evidence-plumbing seam the
  // cross-turn no-progress guard (orchestration/repetition-guard.ts, wired
  // in index.ts's streamJarvis success branch) reads to build its
  // `evidenceKeys` set. If this field stops reflecting the executor's real
  // tool calls, the guard silently degrades to "never sees new evidence".
  test("PipelineResult.toolCalls surfaces the executor's tool call records", async () => {
    const { runtime, ctx, collector } = telemetryHarness("read_file", async () => "file contents");
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "reading", tool_calls: [toolCallWithArgs("read_file", { path: "CONTEXT.md" })] };
      }
      if (options.stageLabel === "executor") {
        return { content: "done reading" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Here is the file summary." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "read CONTEXT.md and summarize it",
      ["executor", "synthesizer"],
      "run-toolcalls-surfaced",
      () => {},
      { executionProfile: "read_only" },
    );

    expect(result.outcome).toBe("success");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "read_file",
      arguments: { path: "CONTEXT.md" },
      is_error: false,
    });
  });

  test("full_execution research turns require workspace evidence and request a replan", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        return { content: "I can infer the architecture without reading.", tool_calls: [] };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Ungrounded architecture summary." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const segment = await executor.executeSegment(
      "comprehensively audit this repo without modifying files",
      ["executor", "synthesizer"],
      "run-full-exec-research-evidence",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: "comprehensively audit this repo without modifying files",
        allowMidRunReplan: true,
      },
    );

    expect(segment.synthesizerAnswer).toBe("");
    expect(segment.synthesizerFatalError).toContain("Workspace inspection failed");
    expect(segment.fatalErrorCode).toBe("missing_workspace_evidence");
    expect(segment.replanRequested?.trigger).toBe("evidence_insufficient");
    expect(rows.some((row) => row.mode_id === "synthesizer")).toBe(false);
  });

  test("pipeline applies one deterministic executor re-entry before the evidence replan", async () => {
    const collector: StageRunRecorder = { recordStageRun: () => {} };
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorCalls = 0;
    let supervisorCalls = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorCalls++;
        return { content: "I can infer the architecture without reading.", tool_calls: [] };
      }
      return { content: "unexpected" };
    };
    const bus = new ConductorBus();
    const conductor = new LiveConductor(
      callModel as any,
      bus,
      new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS),
      {
        supervision_timeout_ms: 5_000,
        max_tool_errors_before_reroute: 2,
        supervise_low_complexity: false,
      },
      async () => {
        supervisorCalls++;
        return { content: '{"directive":"continue"}' };
      },
    );
    conductor.setContext("general", "high", "run-pipeline-evidence-reroute");
    const directives: string[] = [];
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, {
      bus,
      live: conductor,
      collector,
    });

    const segment = await executor.executeSegment(
      "comprehensively audit this repo",
      ["executor", "synthesizer"],
      "run-pipeline-evidence-reroute",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: "comprehensively audit this repo",
        allowMidRunReplan: true,
        onDirective: (directive, stage) => {
          directives.push(`${stage}:${directive.type}`);
        },
      },
    );

    expect(executorCalls).toBeGreaterThanOrEqual(2);
    expect(directives.filter((entry) => entry === "executor:reroute")).toHaveLength(1);
    expect(supervisorCalls).toBe(1);
    expect(segment.replanRequested?.trigger).toBe("evidence_insufficient");
  });

  test("workspace evidence nudge is bounded to two and the second requires new evidence", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "file contents");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorCalls = 0;
    const executorInputs: any[][] = [];
    const callModel = async (messages: any[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorCalls += 1;
        executorInputs.push(messages.map((message) => ({ ...message })));
        if (executorCalls === 1) {
          return { content: "I should answer from memory.", tool_calls: [] };
        }
        if (executorCalls === 2) {
          return {
            content: "Reading one file.",
            tool_calls: [toolCallWithArgs("read_file", { path: "src/a.ts" })],
          };
        }
        return { content: "I have enough now.", tool_calls: [] };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.executeSegment(
      "comprehensively audit src without modifying files",
      ["executor"],
      "run-progress-aware-nudges",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
        rawMessage: "comprehensively audit src without modifying files",
      },
    );

    const thirdExecutorInput = executorInputs[2].map((message) => message.content ?? "").join("\n");
    const nudgeCount = (thirdExecutorInput.match(/Workspace evidence is required/g) ?? []).length;
    expect(nudgeCount).toBe(2);
    expect(executorCalls).toBe(3);
  });

  // Task 2.2: deep-read requests get a deterministic list_directory + anchor
  // read_file preflight (pipeline.ts's runExecutorStage, before the model's
  // first turn) so a weak executor model starts already grounded instead of
  // needing to choose the right tool sequence itself under a tight turn
  // budget -- the upstream fix for the 2026-07-12 incident where the
  // executor called list_directory once and then narrated prose.
  test("deep-read preflight seeds list_directory + anchor read_file calls before any model-driven tool call", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("list_directory"), async () => "package.json\nREADME.md\nsrc/");
    runtime.register(toolDefinition("read_file"), async () => '{"name":"test"}');
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });

    // The mocked executor-stage model never emits a tool_call of its own --
    // any workspace evidence in the result MUST have come from the
    // deterministic preflight, not from a model-driven read.
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        return { content: "narrating without reading anything" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Here is what I found." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "comprehensively diagnose this repo",
      ["executor", "synthesizer"],
      "run-deep-read-preflight",
      () => {},
      { executionProfile: "read_only", turnRequirement: "workspace_read" },
    );

    const listingCalls = result.toolCalls?.filter((call) => call.name === "list_directory") ?? [];
    const anchorReadCalls = result.toolCalls?.filter((call) => call.name === "read_file") ?? [];
    expect(listingCalls.length).toBeGreaterThanOrEqual(1);
    expect(anchorReadCalls.length).toBeGreaterThanOrEqual(1);
    // The preflight's list_directory call must be the very first tool call
    // recorded -- proving it ran before the model's (tool_call-less) first
    // turn could have produced anything.
    expect(result.toolCalls?.[0]?.name).toBe("list_directory");
  });

  test("deep-read workspace-evidence turns inject one deterministic depth target before executor model call", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("list_directory"), async () => "package.json\nREADME.md\nsrc/");
    runtime.register(toolDefinition("read_file"), async () => "file contents");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const executorInputs: Array<Array<{ role: string; content?: string }>> = [];
    const callModel = async (messages: Array<{ role: string; content?: string }>, options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorInputs.push(messages.map((message) => ({ ...message })));
        return { content: "grounded enough" };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.executeSegment(
      "comprehensively audit this repo without modifying files",
      ["executor"],
      "run-deep-read-depth-target",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: "comprehensively audit this repo without modifying files",
      },
    );

    const firstExecutorInput = executorInputs[0].map((message) => message.content ?? "").join("\n");
    const expectedLine =
      `[Runtime depth target] Deep-read workspace evidence is required: read at least ${DEEP_READ_MIN_CONTENT_READS} distinct source files before ending the stage; listings/manifests do not count; never repeat a call.`;
    expect((firstExecutorInput.match(/\[Runtime depth target\]/g) ?? []).length).toBe(1);
    expect(firstExecutorInput).toContain(expectedLine);
  });

  test("all runtime evidence fences use the raw deep-read intent", async () => {
    const collector: StageRunRecorder = { recordStageRun: () => {} };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("list_directory"), async () => "package.json\nREADME.md\nsrc/");
    runtime.register(toolDefinition("read_file"), async () => "metadata only");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let synthUser = "";
    const callModel = async (messages: Array<{ role: string; content?: string }>, options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") return { content: "I can infer the answer.", tool_calls: [] };
      if (options.stageLabel === "synthesizer") {
        synthUser = messages.map((m) => m.content ?? "").join("\n");
        return { content: "Partial audit from listing + package.json + README only." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const segment = await executor.executeSegment(
      "narrow segment request",
      ["executor", "synthesizer"],
      "run-raw-deep-read-fence",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: "comprehensively audit this repo without modifying files",
        allowMidRunReplan: true,
      },
    );

    // F6: preflight listing/anchors are partial evidence — synthesize with
    // disclosure; still request replan; never fatal-refuse.
    expect(segment.synthesizerAnswer).toContain("Partial audit");
    expect(segment.fatalErrorCode).toBeUndefined();
    expect(segment.replanRequested?.trigger).toBe("evidence_insufficient");
    expect(synthUser).toMatch(/Evidence disclosure requirement|INCOMPLETE/i);
  });

  test("F6: deep-read with two source reads synthesizes partial answer and keeps replan", async () => {
    const collector: StageRunRecorder = { recordStageRun: () => {} };
    const runtime = createToolRuntime();
    // No list_directory → skip deep-read preflight so only model-driven reads count.
    // Handler receives tool arguments (not the full call object) — match other tests.
    runtime.register(toolDefinition("read_file"), async (args) => {
      const path = String((args as { path?: unknown }).path ?? "file.ts");
      return `// contents of ${path}`;
    });
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorTurns = 0;
    let synthCalls = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        if (executorTurns++ === 0) {
          return {
            content: "reading two sources",
            tool_calls: [
              toolCallWithArgs("read_file", { path: "src/a.ts" }),
              toolCallWithArgs("read_file", { path: "src/b.ts" }),
            ],
          };
        }
        return { content: "done" };
      }
      if (options.stageLabel === "synthesizer") {
        synthCalls += 1;
        return { content: "Two-file partial audit of a.ts and b.ts." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const segment = await executor.executeSegment(
      "comprehensively audit this repo architecture",
      ["executor", "synthesizer"],
      "run-f6-two-source-partial",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: "comprehensively audit this repo architecture",
        allowMidRunReplan: true,
      },
    );

    expect(synthCalls).toBe(1);
    expect(segment.state.executor?.toolCalls?.filter((c) => c.name === "read_file" && !c.is_error).length).toBe(2);
    expect(segment.synthesizerAnswer).toContain("Two-file partial audit");
    expect(segment.synthesizerFatalError).toBeUndefined();
    expect(segment.fatalErrorCode).toBeUndefined();
    expect(segment.replanRequested?.trigger).toBe("evidence_insufficient");
  });

  test("F10 smoke: deep-read architecture audit does not fatal-refuse with insufficient_workspace_evidence", async () => {
    // Closes the smoke blind spot: a single-file write smoke can pass while the
    // deep-read/full_execution path fails live. This pins the post-remediation
    // contract at the pipeline boundary (fixture repo = process.cwd()).
    const collector: StageRunRecorder = { recordStageRun: () => {} };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("list_directory"), async () => "package.json\nREADME.md\nsrc\nlib");
    runtime.register(toolDefinition("read_file"), async (args) => {
      const path = String((args as { path?: unknown }).path ?? "file");
      return `// fixture source for ${path}\nexport const x = 1;\n`;
    });
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        if (executorTurns++ === 0) {
          return {
            content: "reading sources",
            tool_calls: [
              toolCallWithArgs("read_file", { path: "src/a.ts" }),
              toolCallWithArgs("read_file", { path: "src/b.ts" }),
              toolCallWithArgs("read_file", { path: "lib/c.ts" }),
            ],
          };
        }
        return { content: "done" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Architecture gaps: three residual seams in the fixture shell." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const segment = await executor.executeSegment(
      `Identify all remaining gaps in ${process.cwd()} — architecture audit`,
      ["executor", "synthesizer"],
      "run-f10-deep-read-smoke",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: `Identify all remaining gaps in ${process.cwd()} — architecture audit`,
        allowMidRunReplan: false,
      },
    );

    expect(segment.fatalErrorCode).not.toBe("insufficient_workspace_evidence");
    expect(segment.fatalErrorCode).not.toBe("missing_workspace_evidence");
    expect(segment.synthesizerFatalError).toBeUndefined();
    expect(segment.synthesizerAnswer).toBeTruthy();
    expect(segment.synthesizerAnswer).not.toMatch(/could not gather enough evidence/i);
  });

  test("F8: floor-completion deterministically reads plan-named sources when model stops short", async () => {
    const collector: StageRunRecorder = { recordStageRun: () => {} };
    const runtime = createToolRuntime();
    const readPaths: string[] = [];
    runtime.register(toolDefinition("read_file"), async (args) => {
      const path = String((args as { path?: unknown }).path ?? "");
      readPaths.push(path);
      return `// contents of ${path}`;
    });
    // No list_directory — skip preflight; only model + floor-completion reads.
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        if (executorTurns++ === 0) {
          return {
            content: "I will read one file then stop.",
            tool_calls: [toolCallWithArgs("read_file", { path: "src/only.ts" })],
          };
        }
        return { content: "done" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Floor-completed audit of only.ts, dashboard.ts, and client.ts." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const segment = await executor.executeSegment(
      "comprehensively audit this repo architecture",
      ["executor", "synthesizer"],
      "run-f8-floor-completion",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: "comprehensively audit this repo architecture",
        workerInstructions: {
          executor: "Read lib/gateway/dashboard.ts and client.ts next.",
        },
        allowMidRunReplan: false,
      },
    );

    // Model read one source; floor-completion should add plan-named files
    // toward DEEP_READ_MIN_CONTENT_READS without a replan cycle.
    expect(readPaths.some((p) => p.includes("only.ts"))).toBe(true);
    expect(readPaths.some((p) => p.toLowerCase().includes("dashboard.ts"))).toBe(true);
    const contentReads = (segment.state.executor?.toolCalls ?? []).filter(
      (c) => c.name === "read_file" && !c.is_error,
    ).length;
    expect(contentReads).toBeGreaterThanOrEqual(DEEP_READ_MIN_CONTENT_READS);
    expect(segment.synthesizerAnswer).toContain("Floor-completed");
    expect(segment.fatalErrorCode).toBeUndefined();
  });

  test("F6: deep-read with zero tool results still refuses with missing_workspace_evidence", async () => {
    const collector: StageRunRecorder = { recordStageRun: () => {} };
    const runtime = createToolRuntime();
    // No workspace tools registered → no preflight, zero evidence.
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") return { content: "I can infer everything.", tool_calls: [] };
      return { content: "Should not synthesize." };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const segment = await executor.executeSegment(
      "comprehensively audit this repo without modifying files",
      ["executor", "synthesizer"],
      "run-f6-zero-evidence-refuse",
      () => {},
      {
        executionProfile: "full",
        turnRequirement: "full_execution",
        rawMessage: "comprehensively audit this repo without modifying files",
        allowMidRunReplan: true,
      },
    );

    expect(segment.synthesizerAnswer).toBe("");
    expect(segment.fatalErrorCode).toBe("missing_workspace_evidence");
    expect(segment.replanRequested?.trigger).toBe("evidence_insufficient");
  });

  // Task 2.3: a model-driven read_file on a directory gets an immediate
  // runtime list_directory substitution (one tool hop) instead of waiting a
  // full model round-trip for the healing hint to be acted on. The original
  // failed call stays recorded for evidence accounting.
  test("read_file on a directory triggers an immediate list_directory substitution", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => {
      throw new Error('Error: "src" is a directory, not a file. Use list_directory to see its contents.');
    });
    runtime.register(toolDefinition("list_directory"), async () => "main.ts\nutil.ts");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "reading", tool_calls: [toolCallWithArgs("read_file", { path: "src" })] };
      }
      if (options.stageLabel === "executor") {
        return { content: "done" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "The directory has two files." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "what files are in src?",
      ["executor", "synthesizer"],
      "run-read-dir-substitution",
      () => {},
      { executionProfile: "read_only" },
    );

    const calls = result.toolCalls ?? [];
    // Original failed read_file is preserved, and the substituted
    // list_directory ran immediately after it with the same path.
    const failedRead = calls.find((c) => c.name === "read_file");
    const substituted = calls.find((c) => c.name === "list_directory");
    expect(failedRead?.is_error).toBe(true);
    expect(substituted).toBeDefined();
    expect(substituted?.is_error).toBe(false);
    expect(substituted?.arguments).toEqual({ path: "src" });
    expect(substituted?.output).toContain("main.ts");
  });

  // Task 3.1: read-only tool calls in one executor turn dispatch
  // concurrently. Two 30ms reads completing in well under 60ms total proves
  // real overlap; the recorded order must still match the model's emission
  // order for deterministic tool_call_id pairing.
  test("read-only tool calls in one turn run concurrently and record in emission order", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    let inFlight = 0;
    let maxInFlight = 0;
    runtime.register(toolDefinition("read_file"), async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return "file body";
    });
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return {
          content: "reading three files",
          tool_calls: [
            toolCallWithArgs("read_file", { path: "a.ts" }),
            toolCallWithArgs("read_file", { path: "b.ts" }),
            toolCallWithArgs("read_file", { path: "c.ts" }),
          ],
        };
      }
      if (options.stageLabel === "executor") return { content: "done" };
      if (options.stageLabel === "synthesizer") return { content: "Summary of three files." };
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "read a.ts, b.ts and c.ts",
      ["executor", "synthesizer"],
      "run-parallel-reads",
      () => {},
      { executionProfile: "read_only" },
    );

    expect(maxInFlight).toBeGreaterThanOrEqual(2); // reads genuinely overlapped
    const readCalls = (result.toolCalls ?? []).filter((c) => c.name === "read_file");
    expect(readCalls.map((c) => (c.arguments as { path: string }).path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("duplicate read-only tool calls in one executor stage execute once and return a deflection result", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    let listRuns = 0;
    runtime.register(toolDefinition("list_directory"), async () => {
      listRuns++;
      return "src/\npackage.json";
    });
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return {
          content: "listing twice",
          tool_calls: [
            toolCallWithArgs("list_directory", { path: "src" }),
            toolCallWithArgs("list_directory", { path: "src" }),
          ],
        };
      }
      if (options.stageLabel === "executor") return { content: "done" };
      if (options.stageLabel === "synthesizer") return { content: "Listed src." };
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "list src twice",
      ["executor", "synthesizer"],
      "run-duplicate-list-deflection",
      () => {},
      { executionProfile: "read_only" },
    );

    expect(listRuns).toBe(1);
    const listCalls = (result.toolCalls ?? []).filter((call) => call.name === "list_directory");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]?.output).toContain("package.json");
    expect(listCalls[1]?.output).toContain("[duplicate call deflected]");
    expect(listCalls[1]?.output).toContain("choose a NEW target");
  });

  test("a write tool invalidates duplicate read-only deflection within the executor stage", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    let listRuns = 0;
    let writeRuns = 0;
    runtime.register(toolDefinition("list_directory"), async () => {
      listRuns++;
      return "src/\npackage.json";
    });
    runtime.register(toolDefinition("write_file"), async () => {
      writeRuns++;
      return "wrote file";
    });
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return {
          content: "list, write, list again",
          tool_calls: [
            toolCallWithArgs("list_directory", { path: "src" }),
            toolCallWithArgs("list_directory", { path: "src" }),
            toolCallWithArgs("write_file", { path: "src/generated.txt", content: "fresh" }),
            toolCallWithArgs("list_directory", { path: "src" }),
          ],
        };
      }
      if (options.stageLabel === "executor") return { content: "done" };
      if (options.stageLabel === "synthesizer") return { content: "Updated src." };
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "create a file and relist src",
      ["executor", "synthesizer"],
      "run-write-invalidates-duplicate-deflection",
      () => {},
      { executionProfile: "full" },
    );

    expect(writeRuns).toBe(1);
    expect(listRuns).toBe(2);
    const listOutputs = (result.toolCalls ?? [])
      .filter((call) => call.name === "list_directory")
      .map((call) => call.output);
    expect(listOutputs).toEqual([
      expect.stringContaining("package.json"),
      expect.stringContaining("[duplicate call deflected]"),
      expect.stringContaining("package.json"),
    ]);
  });

  test("a dangerous side-effect tool also invalidates duplicate read-only deflection", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    let listRuns = 0;
    let sideEffectRuns = 0;
    runtime.register(toolDefinition("list_directory"), async () => {
      listRuns++;
      return `snapshot-${listRuns}`;
    });
    runtime.register({ ...toolDefinition("bash"), requires_approval: false, dangerous: true }, async () => {
      sideEffectRuns++;
      return "mutated workspace";
    });
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return {
          content: "list, mutate, list again",
          tool_calls: [
            toolCallWithArgs("list_directory", { path: "src" }),
            toolCallWithArgs("bash", { command: "touch src/generated.txt" }),
            toolCallWithArgs("list_directory", { path: "src" }),
          ],
        };
      }
      if (options.stageLabel === "executor") return { content: "done" };
      if (options.stageLabel === "synthesizer") return { content: "Updated src." };
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "mutate the workspace and relist src",
      ["executor", "synthesizer"],
      "run-dangerous-invalidates-duplicate-deflection",
      () => {},
      { executionProfile: "full" },
    );

    expect(sideEffectRuns).toBe(1);
    expect(listRuns).toBe(2);
    expect((result.toolCalls ?? []).filter((call) => call.name === "list_directory").map((call) => call.output))
      .toEqual(["snapshot-1", "snapshot-2"]);
  });

  test("duplicate deflections do not inflate executor evidence progress counts", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "file body");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const progressCounts: number[] = [];
    const turnBudget = {
      extendStageOnProgress: (_stage: string, count: number) => progressCounts.push(count),
    };
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return {
          content: "reading same file twice",
          tool_calls: [
            toolCallWithArgs("read_file", { path: "README.md" }),
            toolCallWithArgs("read_file", { path: "README.md" }),
          ],
        };
      }
      if (options.stageLabel === "executor") return { content: "done" };
      if (options.stageLabel === "synthesizer") return { content: "Read README." };
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "read README twice",
      ["executor", "synthesizer"],
      "run-duplicate-progress-stability",
      () => {},
      { executionProfile: "read_only", turnBudget: turnBudget as any },
    );

    expect(result.toolCalls?.map((call) => call.output)).toEqual([
      "file body",
      expect.stringContaining("[duplicate call deflected]"),
    ]);
    expect(progressCounts[0]).toBe(1);
  });

  test("duplicate-read write pressure is injected in-loop and bounded to three directives", async () => {
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "source body");
    runtime.register(toolDefinition("write_file"), async () => "unused write");
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    let executorTurns = 0;
    let finalMessages: Array<{ role: string; content?: string }> = [];
    const callModel = async (messages: Array<{ role: string; content?: string }>, options: { stageLabel?: string } = {}) => {
      if (options.stageLabel !== "executor") return { content: "unexpected" };
      executorTurns++;
      finalMessages = messages.map((message) => ({ ...message }));
      return {
        content: "reading again",
        tool_calls: [
          toolCallWithArgs("read_file", { path: "src/app.ts" }),
          toolCallWithArgs("read_file", { path: "src/app.ts" }),
        ],
      };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, { recordStageRun: () => {} });

    await executor.execute("update src/app.ts", ["executor"], "run-write-read-loop", () => {}, {
      executionProfile: "full",
    });

    const directives = finalMessages.filter((message) => message.content?.includes("Expected write target"));
    expect(executorTurns).toBe(12);
    expect(directives).toHaveLength(3);
    expect(directives.every((message) => message.content?.includes("write_file"))).toBe(true);
    expect(directives.every((message) => message.content?.includes("src/app.ts"))).toBe(true);
  });

  test("PipelineResult.toolCalls is undefined when the executor stage never ran", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "synthesizer") return { content: "Hi there!" };
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "hey",
      ["synthesizer"],
      "run-toolcalls-absent",
      () => {},
    );

    expect(result.outcome).toBe("success");
    expect(result.toolCalls).toBeUndefined();
  });

  test("rewriter stage run records a failed tool result as an error", async () => {
    const { rows, runtime, ctx, collector } = telemetryHarness("boom", async () => {
      throw new Error("rewriter tool failure");
    });
    let reviewerTurns = 0;
    let rewriterTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "reviewer") {
        return { content: reviewerTurns++ === 0 ? "PARTIAL: repair needed" : "ACCEPT" };
      }
      if (options.stageLabel === "rewriter" && rewriterTurns++ === 0) {
        return { content: "repairing", tool_calls: [toolCall("boom")] };
      }
      return { content: "repair complete" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.execute("fix workspace/thing.md", ["reviewer"], "run-rewriter-failure", () => {});

    const failedTurn = rows.find((row) => row.mode_id === "rewriter" && row.turn_number === 1);
    expect(failedTurn?.was_successful).toBe(0);
    expect(failedTurn?.had_error).toBe(1);
    expect(failedTurn?.error_message).toContain("boom: rewriter tool failure");
  });

  test("a failed executor tool degrades the result and tells the synthesizer", async () => {
    const { runtime, ctx, collector } = telemetryHarness("boom", async () => {
      throw new Error("cannot write target");
    });
    let executorTurns = 0;
    let synthesizerInput = "";
    const callModel = async (messages: Array<{ role: string; content: string }>, options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "trying", tool_calls: [toolCall("boom")] };
      }
      if (options.stageLabel === "synthesizer") {
        synthesizerInput = messages.find((message) => message.role === "user")?.content ?? "";
        return { content: "The write failed." };
      }
      return { content: "done" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "change the target",
      ["executor", "synthesizer"],
      "run-effect-gate",
      () => {},
      { executionProfile: "full" },
    );

    expect(result.outcome).toBe("degraded");
    expect(result.error_code).toStartWith("effect_gate_");
    expect(synthesizerInput).toContain("Execution Verification");
  });

  test("no-write effect triggers a rewriter repair before synthesis", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "existing content");
    runtime.register(toolDefinition("write_file"), async () => "wrote file");
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    let rewriterTurns = 0;
    let writeCalls = 0;
    let synthesizerInput = "";
    const callModel = async (messages: Array<{ role: string; content: string }>, options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "inspecting", tool_calls: [toolCallWithArgs("read_file", { path: "CONTEXT.md" })] };
      }
      if (options.stageLabel === "executor") {
        return { content: "read complete" };
      }
      if (options.stageLabel === "reviewer") {
        return { content: "ACCEPT" };
      }
      if (options.stageLabel === "rewriter" && rewriterTurns++ === 0) {
        writeCalls++;
        return {
          content: "repairing missing write",
          tool_calls: [toolCallWithArgs("write_file", { path: "workspace/smoke.md", content: "- done" })],
        };
      }
      if (options.stageLabel === "rewriter") {
        return { content: "repair complete" };
      }
      if (options.stageLabel === "synthesizer") {
        synthesizerInput = messages.find((message) => message.role === "user")?.content ?? "";
        return { content: "The file was written." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "write workspace/smoke.md",
      ["executor", "reviewer", "synthesizer"],
      "run-effect-gate-repair",
      () => {},
      { executionProfile: "full" },
    );

    expect(writeCalls).toBe(1);
    expect(result.outcome).toBe("success");
    expect(result.error_code).toBeUndefined();
    expect(synthesizerInput).not.toContain("ZERO file mutations succeeded");
    const rewriterRow = rows.find((row) => row.mode_id === "rewriter");
    expect(rewriterRow?.tool_calls_json).toContain("write_file");
  });

  // Pin the `hasMutationIntent` gate that lives inside the repair branch
  // (pipeline.ts ~line 803). The repair should only fire when the user's
  // request looks like a real write intent; a "read this", "what does",
  // or "explain the X" prompt must not trigger a needless rewriter run
  // even though the effect-gate itself reports `no_write_effect`.
  //
  // This is the same escalation concern the 2026-07-02 P1-D live issue
  // called out at the orchestrator classifier level — the repair path
  // needs the same guarantee so a read-only user message doesn't spawn
  // an extra LLM call to "fix" a non-existent missing write.
  test("repair branch does not fire on a read request even when profile=full and effect-gate sees no writes", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "existing content");
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "inspecting", tool_calls: [toolCallWithArgs("read_file", { path: "CONTEXT.md" })] };
      }
      if (options.stageLabel === "executor") {
        return { content: "read complete" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Here's the context." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "read CONTEXT.md and summarize what it says",
      ["executor", "synthesizer"],
      "run-read-no-repair",
      () => {},
      { executionProfile: "full" },
    );

    // A full-capability route can still be a read-intent turn; the effect gate
    // must not demand a mutation that the user never requested.
    expect(result.outcome).toBe("success");
    expect(result.error_code).toBeUndefined();
    expect(rows.find((row) => row.mode_id === "rewriter")).toBeUndefined();
  });

  test("repair branch does not fire on an explanatory request (no mutation verb, no file path)", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "existing content");
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "checking", tool_calls: [toolCallWithArgs("read_file", { path: "src/main.ts" })] };
      }
      if (options.stageLabel === "executor") {
        return { content: "read complete" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "The code does X then Y." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "what does this code do?",
      ["executor", "synthesizer"],
      "run-explain-no-repair",
      () => {},
      { executionProfile: "full" },
    );

    expect(result.outcome).toBe("success");
    expect(result.error_code).toBeUndefined();
    expect(rows.find((row) => row.mode_id === "rewriter")).toBeUndefined();
  });

  test("repair branch does not fire on an explain-the-api request (no mutation verb at all)", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "API surface content");
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "looking up", tool_calls: [toolCallWithArgs("read_file", { path: "src/api.ts" })] };
      }
      if (options.stageLabel === "executor") {
        return { content: "read complete" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "The API has these endpoints." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "explain the api",
      ["executor", "synthesizer"],
      "run-explain-api-no-repair",
      () => {},
      { executionProfile: "full" },
    );

    expect(result.outcome).toBe("success");
    expect(result.error_code).toBeUndefined();
    expect(rows.find((row) => row.mode_id === "rewriter")).toBeUndefined();
  });

  // Task 1.4: pin the repair-loop cap in `runReviewerRewriterLoop`
  // (pipeline.ts ~line 801). A 2026-07-11 live incident showed
  // reviewer/rewriter ping-ponging 4+ rounds before a fix landed capping
  // repair rounds. The cap already exists in code
  // (`Math.min(2, Math.max(0, Math.floor(configuredRepairRounds)))`); these
  // tests pin that behavior so a future change can't silently regress it
  // back to unbounded repair.
  //
  // Note on row counting: each repair round's rewriter stage runs its own
  // internal turn loop (BUILTIN_MODES.rewriter.max_turns). A round that
  // performs a write always records at least 2 "rewriter" stage_run rows --
  // the turn with the write, and a follow-up turn where the rewriter
  // reports nothing further to do (only that turn, returning no tool_calls,
  // can flip `rewriterDone` and let the round's inner loop exit). So "number
  // of rewriter stage_run rows" is NOT the same as "number of repair
  // rounds" -- these tests count actual writes instead, which is the
  // correct proxy for repair-round count.
  test("repair rounds are hard-capped at 2 even when more are requested and the reviewer keeps flagging issues", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "existing content");
    runtime.register(toolDefinition("write_file"), async () => "wrote file");
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    let rewriterCallCount = 0;
    let rewriterWriteCount = 0;
    let synthesizerCallCount = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return { content: "inspecting", tool_calls: [toolCallWithArgs("read_file", { path: "CONTEXT.md" })] };
      }
      if (options.stageLabel === "executor") {
        return { content: "read complete" };
      }
      // Reviewer NEVER accepts -- always flags an issue, so the loop would
      // run forever without the hard cap.
      if (options.stageLabel === "reviewer") {
        return { content: "PARTIAL: repair still needed" };
      }
      if (options.stageLabel === "rewriter") {
        // Odd calls are the "does the work" turn of a round: write to a
        // NEW path every round, so addedWriteProgress is true every time --
        // isolating the hard-cap stop condition from the no-progress stop
        // condition (Test 2 below covers that one separately). Even calls
        // are the round's follow-up turn that reports nothing more to do,
        // ending that round's inner turn loop.
        rewriterCallCount++;
        if (rewriterCallCount % 2 === 1) {
          const path = `workspace/repair-${rewriterWriteCount++}.md`;
          return {
            content: "repairing",
            tool_calls: [toolCallWithArgs("write_file", { path, content: "- fix" })],
          };
        }
        return { content: "repair round complete" };
      }
      if (options.stageLabel === "synthesizer") {
        synthesizerCallCount++;
        return { content: "Repairs applied." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.execute(
      "write workspace/thing.md and fix any issues",
      ["executor", "reviewer", "synthesizer"],
      "run-repair-hard-cap",
      () => {},
      { executionProfile: "full", maxReviewRepairRounds: 5 },
    );

    // reviewer never stops flagging issues, so the cap itself is what ends
    // the loop -- exactly 2 repair rounds ran even though 5 were requested.
    expect(rewriterWriteCount).toBeLessThanOrEqual(2);
    expect(rewriterWriteCount).toBe(2);

    const rewriterWriteRows = rows.filter(
      (row) => row.mode_id === "rewriter" && (row.tool_calls_json ?? "").includes("write_file"),
    );
    expect(rewriterWriteRows.length).toBe(2);
    expect(synthesizerCallCount).toBe(0);
  });

  test("a repair round with no new write-effect progress exits the loop immediately", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    runtime.register(toolDefinition("read_file"), async () => "existing content");
    runtime.register(toolDefinition("write_file"), async () => "wrote file");
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, require_approval: [], sandbox_mode: "permissive" };
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: process.cwd() });
    let executorTurns = 0;
    let rewriterTurns = 0;
    let rewriterWriteCalls = 0;
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor" && executorTurns++ === 0) {
        return {
          content: "inspecting",
          tool_calls: [toolCallWithArgs("write_file", { path: "workspace/thing.md", content: "- v1" })],
        };
      }
      if (options.stageLabel === "executor") {
        return { content: "wrote v1" };
      }
      // Reviewer never accepts, so only the no-progress exit (not reviewer
      // acceptance) can end this loop.
      if (options.stageLabel === "reviewer") {
        return { content: "PARTIAL: repair still needed" };
      }
      if (options.stageLabel === "rewriter" && rewriterTurns++ === 0) {
        // SAME path + SAME content as the executor's write: successfulWriteKeys()
        // produces an identical key, so addedWriteProgress(before, after) is
        // false on this very first repair round -- `before` already
        // contains this key (from the executor's write), so the rewriter
        // re-doing it adds nothing new.
        rewriterWriteCalls++;
        return {
          content: "repairing",
          tool_calls: [toolCallWithArgs("write_file", { path: "workspace/thing.md", content: "- v1" })],
        };
      }
      if (options.stageLabel === "rewriter") {
        return { content: "repair round complete" };
      }
      if (options.stageLabel === "synthesizer") {
        return { content: "Repairs applied." };
      }
      return { content: "unexpected" };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    await executor.execute(
      "write workspace/thing.md and fix any issues",
      ["executor", "reviewer", "synthesizer"],
      "run-repair-no-progress",
      () => {},
      { executionProfile: "full", maxReviewRepairRounds: 5 },
    );

    // Exactly ONE repair round ran before the no-progress exit fired -- even
    // though 5 rounds were requested and the reviewer never stopped
    // flagging issues.
    expect(rewriterWriteCalls).toBe(1);

    // One repair round == two internal rewriter turns recorded (the turn
    // that writes, and the follow-up turn where the rewriter reports
    // nothing more to do). If the no-progress exit failed to fire, the
    // reviewer (which never accepts) would trigger MORE repair rounds and
    // this count would keep growing in additional 2-turn blocks.
    const rewriterRows = rows.filter((row) => row.mode_id === "rewriter");
    expect(rewriterRows.length).toBe(2);
    const rewriterWriteRows = rewriterRows.filter((row) => (row.tool_calls_json ?? "").includes("write_file"));
    expect(rewriterWriteRows.length).toBe(1);
  });
});
