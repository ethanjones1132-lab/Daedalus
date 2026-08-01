import { describe, expect, test } from "bun:test";
import { decideCompletion } from "./completion-policy";

const none = {
  tier: "none" as const,
  ran: false,
  passed: null,
  detail: "",
  command: "",
  durationMs: 0,
};

const green = {
  tier: "builtin" as const,
  ran: true,
  passed: true,
  detail: "",
  command: "cmake --build C:\\cache\\perihelion",
  durationMs: 12,
};

describe("decideCompletion", () => {
  test("open TaskPlan prevents a successful run", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "active",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "active", runOutcome: "partial", reason: "task_plan_open" });
  });

  test("write task with tier none stays resumable", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: none,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" });
  });

  test("completed plan and authoritative green check can succeed", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "completed", runOutcome: "success", reason: "verified_complete" });
  });

  test("repetition remains degraded even with a green check", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: true,
      checkResult: green,
    }).runOutcome).toBe("degraded");
  });

  test("partial pipeline cannot become complete through a drained ledger", () => {
    expect(decideCompletion({
      pipelineOutcome: "partial",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "pipeline_partial" });
  });

  test("degraded pipeline cannot become a successful write run", () => {
    expect(decideCompletion({
      pipelineOutcome: "degraded",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "paused", runOutcome: "degraded", reason: "pipeline_degraded" });
  });
});
