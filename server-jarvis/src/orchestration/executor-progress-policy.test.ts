import { describe, expect, test } from "bun:test";
import { decideExecutorProgress, SemanticPressureBudget } from "./executor-progress-policy";

describe("decideExecutorProgress", () => {
  test("first no-tool write turn retries once with a different strong model", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: false,
      successfulWrites: 0,
      consecutiveNoToolTurns: 1,
      stageRemainingMs: 60_000,
    })).toBe("retry_strong");
  });

  test("second no-tool write turn ends partial", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: false,
      successfulWrites: 0,
      consecutiveNoToolTurns: 2,
      stageRemainingMs: 45_000,
    })).toBe("stop_partial");
  });

  test("read/write progress resets the no-tool streak", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: true,
      successfulWrites: 1,
      consecutiveNoToolTurns: 0,
      stageRemainingMs: 45_000,
    })).toBe("continue");
  });

  test("first no-tool write turn without budget stops partial instead of retrying", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: false,
      successfulWrites: 0,
      consecutiveNoToolTurns: 1,
      stageRemainingMs: 20_000,
    })).toBe("stop_partial");
  });

  test("read-only prose ending continues normally", () => {
    expect(decideExecutorProgress({
      writeIntent: false,
      emittedToolCalls: false,
      successfulWrites: 0,
      consecutiveNoToolTurns: 3,
      stageRemainingMs: 60_000,
    })).toBe("continue");
  });

  test("successful write with prose finish continues without no-tool partial", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: false,
      successfulWrites: 1,
      consecutiveNoToolTurns: 1,
      stageRemainingMs: 60_000,
    })).toBe("continue");
  });
});

test("semantic pressure is claimed once per logical run", () => {
  const budget = new SemanticPressureBudget();
  expect(budget.claim("write_effect")).toBe(true);
  expect(budget.claim("write_effect")).toBe(false);
  expect(budget.claim("quality_after_correctness")).toBe(true);
});
