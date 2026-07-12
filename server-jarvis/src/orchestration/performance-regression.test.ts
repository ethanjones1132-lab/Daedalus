import { describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "./stage-output";
import { addedWriteProgress, PipelineExecutor, successfulWriteKeys } from "./pipeline";
import { createToolRuntime, makeExecutionContext } from "../tool-runtime";
import { defaultConfig } from "../config";
import { SessionOutcomeCollector, SelfTuningStore } from "../self-tuning/mod";

function writeCall(name: string, args: Record<string, unknown>, is_error = false): ToolCallRecord {
  return { name, arguments: args, output: is_error ? "failed" : "ok", is_error, duration_ms: 1 };
}

describe("orchestration performance guardrails", () => {
  test("recognizes only newly successful write effects as repair progress", () => {
    const before = successfulWriteKeys([writeCall("write_file", { path: "src/a.ts", content: "old" })]);
    const unchanged = successfulWriteKeys([writeCall("write_file", { path: "src/a.ts", content: "old" })]);
    const after = successfulWriteKeys([
      writeCall("write_file", { path: "src/a.ts", content: "old" }),
      writeCall("edit_file", { path: "src/a.ts", old_string: "old", new_string: "new" }),
    ]);

    expect(addedWriteProgress(before, unchanged)).toBe(false);
    expect(addedWriteProgress(before, after)).toBe(true);
  });

  test("stops after a rewriter makes no new write progress", async () => {
    const calls: string[] = [];
    let reviewerCalls = 0;
    const callModel = async (_messages: any[], options: any = {}) => {
      const stage = options.stageLabel ?? "unknown";
      calls.push(stage);
      if (stage === "reviewer") {
        reviewerCalls++;
        return { content: "REJECT: requested file was not changed" };
      }
      if (stage === "rewriter") return { content: "Still unchanged." };
      if (stage === "executor") return { content: "I did not make a change." };
      return { content: "The requested change was not applied." };
    };
    const executor = new PipelineExecutor(
      callModel as any,
      createToolRuntime(),
      makeExecutionContext("agent", defaultConfig()),
      new SessionOutcomeCollector(new SelfTuningStore(":memory:")),
    );

    await executor.execute(
      "Change file src/a.ts",
      ["executor", "reviewer", "synthesizer"],
      "run-no-progress",
      () => {},
      { executionProfile: "full", maxReviewRepairRounds: 1 },
    );

    expect(reviewerCalls).toBe(1);
    expect(calls.filter((stage) => stage === "rewriter")).toHaveLength(1);
  });
});
