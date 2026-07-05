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
});
