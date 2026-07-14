import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import type { StageRun } from "../self-tuning/store";
import { PipelineExecutor, type StageRunRecorder } from "./pipeline";

function toolDefinition(name: string) {
  return {
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  };
}

function toolCall(name: string, id: string) {
  return { id, type: "function", function: { name, arguments: JSON.stringify({ path: "src/a.ts" }) } };
}

describe("orchestrator transcript context", () => {
  test("bounds model-facing tool results while preserving raw evidence records", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    const rawOutput = "x".repeat(50_000);
    runtime.register(toolDefinition("read_file"), async () => rawOutput);
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const executorInputs: any[][] = [];
    let executorTurns = 0;
    const callModel = async (messages: any[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") {
        executorInputs.push(messages.map((message) => ({ ...message })));
        if (executorTurns++ === 0) {
          return { content: "reading", tool_calls: [toolCall("read_file", "read-1")] };
        }
        return { content: "read complete" };
      }
      return { content: "The file contains the requested evidence." };
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "read src/a.ts",
      ["executor", "synthesizer"],
      "run-context-boundary",
      () => {},
      { executionProfile: "read_only" },
    );

    const toolMessage = executorInputs[1].find((message) => message.role === "tool");
    expect(toolMessage.content.length).toBeLessThanOrEqual(6_000);
    expect(toolMessage.content).toContain("Result recorded in full for verification");
    expect(result.toolCalls?.[0].output.length).toBe(rawOutput.length);
    expect(rows.find((row) => row.mode_id === "executor")?.input_tokens).toBeGreaterThan(0);
  });

  test("does not spawn a rewriter for reviewer issues on a read-intent turn", async () => {
    const rows: StageRun[] = [];
    const collector: StageRunRecorder = { recordStageRun: (row) => rows.push(row) };
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
    const callModel = async (_messages: unknown[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "executor") return { content: "read complete" };
      if (options.stageLabel === "reviewer") return { content: "PARTIAL: issue remains" };
      if (options.stageLabel === "synthesizer") return { content: "Read-only answer." };
      throw new Error(`unexpected stage: ${options.stageLabel}`);
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector);
    const result = await executor.execute(
      "create a comprehensive implementation plan. Do not modify files.",
      ["executor", "reviewer", "synthesizer"],
      "run-read-review-no-rewriter",
      () => {},
      { executionProfile: "full", maxReviewRepairRounds: 2 },
    );

    expect(result.outcome).toBe("success");
    expect(rows.some((row) => row.mode_id === "rewriter")).toBe(false);
  });
});
