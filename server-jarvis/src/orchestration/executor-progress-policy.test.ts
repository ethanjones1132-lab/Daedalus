import { describe, expect, test } from "bun:test";
import {
  NO_TOOL_RATIO_CEILING,
  NO_TOOL_RATIO_MIN_TURNS,
} from "./executor-progress-policy";

// 2026-08-01, measured on the 8-run post-deploy window after the completion
// integrity merge: executor no-tool turns were 42.9% against a <=10% target.
// The consecutive-streak bound could not see it. Two reasons:
//   1. pipeline.ts short-circuited with
//      `anyModelToolCallThisStage ? "continue" : decideExecutorProgress(...)`,
//      so ONE tool call anywhere in the stage disabled the bound permanently.
//   2. even reached, the streak resets on any tool call, and the observed
//      pattern is INTERLEAVED (tool, prose, tool, prose), never consecutive.
//
// A ratio bound sees the interleaved shape. It is deliberately safe against
// read spirals: a read spiral is a mostly-TOOL stage (its no-tool ratio is
// low), so it still reaches the effect gate as the original comment intended.
// Only mostly-prose, zero-write stages trip this.
describe("interleaved no-tool turns (ratio bound)", () => {
  const prose = (over: Partial<Parameters<typeof decideExecutorProgress>[0]> = {}) =>
    decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: false,
      successfulWrites: 0,
      consecutiveNoToolTurns: 1,
      stageRemainingMs: 300_000,
      anyToolCallThisStage: true,
      noToolTurns: 6,
      executorTurns: 10,
      ...over,
    });

  test("a mostly-prose stage stops even when tool calls happened earlier", () => {
    expect(prose()).toBe("stop_partial");
  });

  test("a read spiral (mostly tool calls) is not stopped by the ratio bound", () => {
    // 2 prose turns out of 10 — below the ceiling. Must still reach the
    // effect gate, which is what the original short-circuit protected.
    expect(prose({ noToolTurns: 2, consecutiveNoToolTurns: 1 })).toBe("continue");
  });

  test("the ratio bound needs a minimum sample before it fires", () => {
    expect(prose({ noToolTurns: 2, executorTurns: 2 })).toBe("continue");
    expect(prose({ noToolTurns: NO_TOOL_RATIO_MIN_TURNS, executorTurns: NO_TOOL_RATIO_MIN_TURNS }))
      .toBe("stop_partial");
  });

  test("a landed write disables the ratio bound", () => {
    // Once something was actually written the stage is productive; ending on
    // prose is legitimate and the completion policy judges the rest.
    expect(prose({ successfulWrites: 1 })).toBe("continue");
  });

  test("read-only turns are never stopped", () => {
    expect(prose({ writeIntent: false })).toBe("continue");
  });

  test("the ceiling is a real fraction so the bound cannot be trivially true", () => {
    expect(NO_TOOL_RATIO_CEILING).toBeGreaterThan(0);
    expect(NO_TOOL_RATIO_CEILING).toBeLessThan(1);
  });
});
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
