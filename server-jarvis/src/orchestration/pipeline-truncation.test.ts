import { describe, expect, test } from "bun:test";
import { PipelineExecutor, type StageRunRecorder } from "./pipeline";
import { createTurnBudget } from "./turn-budget";
import type { StageRun } from "../self-tuning/store";
import { createToolRuntime } from "../tool-runtime";
import { makeExecutionContext } from "../tool-runtime";
import { defaultConfig } from "../config";

/**
 * T1.3 / T1.4: truncated-clean ⇒ partial; length continuation behavior.
 * Uses a minimal callModel that returns finish metadata without HTTP.
 */

function makeExecutor(callModel: any, rows: StageRun[] = []) {
  const collector: StageRunRecorder = {
    recordStageRun: (row) => rows.push(row as StageRun),
  };
  const runtime = createToolRuntime();
  const ctx = makeExecutionContext("agent", defaultConfig(), { workspace_path: process.cwd() });
  return new PipelineExecutor(callModel, runtime, ctx, collector);
}

describe("pipeline truncation honesty (T1.3 / T1.4)", () => {
  test("truncated-clean with provider_cut ⇒ partialErrorCode stream_cut", async () => {
    const rows: StageRun[] = [];
    const callModel = async () => ({
      content: "Partial answer mid-senten",
      _finishReason: null,
      _stopReason: "provider_cut",
      _truncated: true,
    });
    const ex = makeExecutor(callModel, rows);
    const result = await ex.execute(
      "summarize the plan",
      ["synthesizer"],
      "run-stream-cut",
      () => {},
      {},
    );
    expect(result.outcome).toBe("partial");
    expect(result.error_code).toBe("stream_cut");
    expect(result.answer).toContain("Partial answer");
    const synth = rows.find((r) => r.mode_id === "synthesizer");
    expect(synth?.partial_error_code).toBe("stream_cut");
    expect(synth?.was_successful).toBe(0);
  });

  test("finish_reason length with budget does exactly one continuation", async () => {
    const rows: StageRun[] = [];
    let calls = 0;
    const callModel = async (_msgs: any[], options: any = {}) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "First half of the answer which got cut at the ",
          _finishReason: "length",
          _stopReason: "length",
          _truncated: true,
        };
      }
      // Continuation: clean stop.
      return {
        content: "token boundary. Here is the rest.",
        _finishReason: "stop",
        _stopReason: "stop",
        _truncated: false,
      };
    };
    const ex = makeExecutor(callModel, rows);
    const budget = createTurnBudget("workspace_read", "medium", Date.now());
    const result = await ex.execute(
      "write a long analysis",
      ["synthesizer"],
      "run-length-cont",
      () => {},
      { turnBudget: budget },
    );
    expect(calls).toBe(2);
    expect(result.outcome).toBe("success");
    expect(result.answer).toContain("First half");
    expect(result.answer).toContain("token boundary");
    const cont = rows.filter((r) => r.mode_id === "synthesizer" && r.turn_number === 2);
    expect(cont).toHaveLength(1);
    expect(cont[0].stop_reason).toBe("length_continuation");
  });

  test("length continuation skipped when grace budget exhausted", async () => {
    const rows: StageRun[] = [];
    let calls = 0;
    const callModel = async () => {
      calls += 1;
      return {
        content: "Cut short",
        _finishReason: "length",
        _stopReason: "length",
        _truncated: true,
      };
    };
    const ex = makeExecutor(callModel, rows);
    // Budget already past: started far in the past so finalStreamDeadline is gone.
    const budget = createTurnBudget("conversational", "low", Date.now() - 200_000);
    const result = await ex.execute(
      "hi",
      ["synthesizer"],
      "run-length-no-budget",
      () => {},
      { turnBudget: budget },
    );
    expect(calls).toBe(1);
    expect(result.outcome).toBe("partial");
    expect(result.error_code).toBe("token_cap");
  });

  test("deadline-partial keeps visible prose and returns typed turn_deadline", async () => {
    const rows: StageRun[] = [];
    const callModel = async (_m: any, options: any = {}) => {
      options.onChunk?.("partial stream content here ");
      const err = new Error("Total turn deadline (30000ms) exceeded at stage=synthesizer");
      err.name = "TurnDeadlineExceededError";
      throw err;
    };
    const ex = makeExecutor(callModel, rows);
    const result = await ex.execute(
      "answer me",
      ["synthesizer"],
      "run-deadline-partial",
      () => {},
      {},
    );
    expect(result.outcome).toBe("partial");
    expect(result.error_code).toBe("turn_deadline");
    expect(result.answer).toContain("partial stream");
  });

  test("reasoning-only turn deadline returns empty answer with typed turn_deadline", async () => {
    const rows: StageRun[] = [];
    const callModel = async () => {
      const err = new Error("Total turn deadline (30000ms) exceeded at stage=synthesizer");
      err.name = "TurnDeadlineExceededError";
      throw err;
    };
    const ex = makeExecutor(callModel, rows);
    const result = await ex.execute(
      "answer me",
      ["synthesizer"],
      "run-deadline-reasoning-only",
      () => {},
      {},
    );
    expect(result.outcome).toBe("partial");
    expect(result.error_code).toBe("turn_deadline");
    expect(result.answer).toBe("");
    const synth = rows.find((r) => r.mode_id === "synthesizer");
    expect(synth?.stop_reason).toBe("turn_deadline");
    expect(synth?.partial_error_code).toBe("turn_deadline");
  });
});
