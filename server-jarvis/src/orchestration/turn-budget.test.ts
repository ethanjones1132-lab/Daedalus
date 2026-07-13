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

  test("evidence progress extends the executor stage budget up to the ceiling", () => {
    const budget = createTurnBudget("workspace_read", "medium", 0);
    expect(budget.stage_ms.executor).toBe(25_000);
    budget.extendStageOnProgress("executor", 1);
    expect(budget.stage_ms.executor).toBe(45_000);
    budget.extendStageOnProgress("executor", 3);
    expect(budget.stage_ms.executor).toBe(90_000); // ceiling, not 45k + 60k
  });

  test("extension also relaxes the turn deadline but never past the absolute cap", () => {
    const budget = createTurnBudget("workspace_read", "medium", 0);
    const before = budget.deadlineAt;
    budget.extendStageOnProgress("executor", 1);
    expect(budget.deadlineAt).toBeGreaterThan(before);
    for (let i = 0; i < 20; i++) budget.extendStageOnProgress("executor", 1);
    expect(budget.turn_ms).toBeLessThanOrEqual(180_000);
  });

  test("stages without a configured budget and zero progress are unaffected", () => {
    const budget = createTurnBudget("conversational", "low", 0);
    budget.extendStageOnProgress("executor", 2); // conversational has no executor budget
    expect(budget.stage_ms.executor).toBeUndefined();
    const workspaceBudget = createTurnBudget("workspace_read", "medium", 0);
    workspaceBudget.extendStageOnProgress("executor", 0);
    expect(workspaceBudget.stage_ms.executor).toBe(25_000);
  });
});
