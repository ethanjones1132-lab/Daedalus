import { describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "./stage-output";
import { addedWriteProgress, PipelineExecutor, repairBudgetExhausted, successfulWriteKeys } from "./pipeline";
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

  describe("progress-gated repair budget (A3)", () => {
    // Default config: baseCap = 2 unconditional rounds, plus ONE conditional
    // "progress" round (a 3rd) granted only when the prior round changed bytes.
    test("allows the base rounds unconditionally", () => {
      expect(repairBudgetExhausted({ repairs: 0, baseCap: 2, lastRoundHadContentDelta: false })).toBe(false);
      expect(repairBudgetExhausted({ repairs: 1, baseCap: 2, lastRoundHadContentDelta: false })).toBe(false);
    });

    test("grants the conditional 3rd round only on a real content delta", () => {
      // At the base cap (repairs === 2) the bonus round hinges on progress.
      expect(repairBudgetExhausted({ repairs: 2, baseCap: 2, lastRoundHadContentDelta: true })).toBe(false);
      expect(repairBudgetExhausted({ repairs: 2, baseCap: 2, lastRoundHadContentDelta: false })).toBe(true);
    });

    test("never grants more than one bonus round beyond the base cap", () => {
      // Even if the 3rd (bonus) round also changed bytes, a 4th is refused.
      expect(repairBudgetExhausted({ repairs: 3, baseCap: 2, lastRoundHadContentDelta: true })).toBe(true);
    });

    test("the ceiling holds even well past it and regardless of delta", () => {
      // Defensive: a caller that somehow overshoots the ceiling is still
      // stopped, and a lingering delta signal cannot reopen the budget.
      expect(repairBudgetExhausted({ repairs: 4, baseCap: 2, lastRoundHadContentDelta: true })).toBe(true);
      expect(repairBudgetExhausted({ repairs: 9, baseCap: 3, lastRoundHadContentDelta: true })).toBe(true);
    });

    test("a zero base cap disables repair entirely", () => {
      expect(repairBudgetExhausted({ repairs: 0, baseCap: 0, lastRoundHadContentDelta: false })).toBe(true);
      // A stray delta signal cannot resurrect a disabled budget.
      expect(repairBudgetExhausted({ repairs: 0, baseCap: 0, lastRoundHadContentDelta: true })).toBe(true);
    });
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
