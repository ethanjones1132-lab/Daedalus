import { describe, expect, test } from "bun:test";
import { createTurnBudget } from "./turn-budget";

describe("turn budgets", () => {
  test("reserves the finalization window before optional repair work", () => {
    const budget = createTurnBudget("full_execution", "high", 1_000);
    expect(budget.canStart("rewriter", 151_000)).toBe(false);
    expect(budget.remainingMs(151_000)).toBe(30_000);
  });

  test("caps each stage at two candidates and gives high execution a bounded extension", () => {
    const budget = createTurnBudget("full_execution", "high", 0);
    expect(budget.max_stage_attempts).toBe(2);
    expect(budget.turn_ms).toBe(180_000);
    expect(budget.stageRemainingMs("executor", 1_000)).toBe(30_000);
  });

  test("uses compact budgets for conversational turns", () => {
    const budget = createTurnBudget("conversational", "medium", 0);
    expect(budget.turn_ms).toBe(30_000);
    expect(budget.canStart("synthesizer", 16_000)).toBe(false);
  });
});
