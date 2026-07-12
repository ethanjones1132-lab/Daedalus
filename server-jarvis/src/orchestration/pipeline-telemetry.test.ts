import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { StageRun } from "../self-tuning/store";
import { PipelineExecutor, type StageRunRecorder } from "./pipeline";

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
    await executor.execute("repair it", ["reviewer"], "run-rewriter-failure", () => {});

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

    // The effect gate still flags no_write_effect (full profile + only reads),
    // but the repair branch must not run for a read intent.
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
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

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
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

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
    expect(rows.find((row) => row.mode_id === "rewriter")).toBeUndefined();
  });
});
