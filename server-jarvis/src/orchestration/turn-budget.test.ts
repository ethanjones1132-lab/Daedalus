import { describe, expect, test } from "bun:test";
import { createTurnBudget } from "./turn-budget";
import { AgentPool, firstTokenTimeoutFor } from "./agent-pool";

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

  // 2026-07-13 finding: index.ts's first-token watchdog computes
  // Math.min(requestBudgetMs, firstTokenTimeoutFor(...)), and
  // requestBudgetMs is bounded by stageRemainingMs('planner'). Before this
  // fix, full_execution's planner ceiling (20_000) was always BELOW the
  // Nemotron pool override (55_000), so Math.min always picked 20_000 —
  // the override's own unit test passed in isolation while being
  // completely inert end-to-end. Confirmed live: a real full_execution
  // turn failed with "First-token timeout (20000ms)" on nemotron, not the
  // intended 55s. This test reproduces the actual end-to-end computation
  // (not just one half of it) to pin the fix.
  test("full_execution's planner ceiling no longer undercuts the Nemotron first-token override", () => {
    // Mirrors DEFAULT_ORCHESTRATOR_AGENTS's zen-nemotron-ultra-free entry but
    // enabled — the real-world state as of the 2026-07-13 config fix that
    // re-enabled the opencode_zen agents (a disabled model intentionally
    // does NOT inherit its override; that's separately correct behavior,
    // not what this test is about — see agent-pool.test.ts for that
    // contract). This test isolates the OTHER bug: even once the model is
    // enabled and its override resolves, the stage's own static ceiling
    // must not silently undercut it.
    const pool = new AgentPool([{
      id: "zen-nemotron-ultra-free",
      provider: "opencode_zen",
      model_id: "nemotron-3-ultra-free",
      capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
      default_for: [],
      first_token_timeout_ms: 55_000,
      enabled: true,
    }]);
    const budget = createTurnBudget("full_execution", "medium", 0);

    const stageRemainingMs = budget.stageRemainingMs("planner", 0);
    const resolvedFirstTokenMs = firstTokenTimeoutFor(pool, "nemotron-3-ultra-free", 30_000);
    expect(resolvedFirstTokenMs).toBe(55_000); // the pool's own advertised override

    // This is the EXACT combinator index.ts applies to the watchdog delay.
    const actualWatchdogDelayMs = Math.min(stageRemainingMs, resolvedFirstTokenMs);
    expect(actualWatchdogDelayMs).toBe(55_000); // was 20_000 before the fix
  });

  test("full_execution's reviewer ceiling no longer undercuts a same-family Nemotron override", () => {
    // or-nemotron-ultra-free (the reviewer default) shares the identical
    // 55_000ms override and is currently disabled in live config, but the
    // ceiling bug is proactively fixed regardless — see the comment on
    // BUDGETS.full_execution.stage_ms.reviewer in turn-budget.ts.
    const pool = new AgentPool([{
      id: "or-nemotron-ultra-free",
      provider: "openrouter",
      model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      capabilities: { code: 0.78, reasoning: 0.96, speed: 0.42, cost: 1, json_reliability: 0.88 },
      default_for: [],
      first_token_timeout_ms: 55_000,
      enabled: true,
    }]);
    const budget = createTurnBudget("full_execution", "medium", 0);

    const stageRemainingMs = budget.stageRemainingMs("reviewer", 0);
    const resolvedFirstTokenMs = firstTokenTimeoutFor(pool, "nvidia/nemotron-3-ultra-550b-a55b:free", 30_000);
    expect(resolvedFirstTokenMs).toBe(55_000);

    const actualWatchdogDelayMs = Math.min(stageRemainingMs, resolvedFirstTokenMs);
    expect(actualWatchdogDelayMs).toBe(55_000); // was 20_000 before the fix
  });
});
