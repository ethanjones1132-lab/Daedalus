import { describe, expect, test } from "bun:test";
import {
  createTurnBudget,
  computeBoundedRequestTimeoutMs,
  computeRequestTimeoutMs,
  EXTENDED_DEEP_EXECUTOR_MS,
  EXTENDED_DEEP_TURN_MS,
  FINAL_STREAM_GRACE_MS,
  FORCED_DEEP_READ_EXECUTOR_MS,
  FORCED_DEEP_READ_TURN_MS,
  requestTimeoutMessage,
} from "./turn-budget";
import { AgentPool, firstTokenTimeoutFor } from "./agent-pool";
import { resolveTurnRequirement } from "./turn-requirements";

describe("turn budgets", () => {
  test("request timeouts follow stage remaining time with a 60s floor", () => {
    const budget = {
      turn_ms: 150_000,
      stageRemainingMs: () => 42_000,
    } as any;
    expect(computeRequestTimeoutMs("planner", budget, 300_000)).toBe(60_000);
  });

  test("extended-deep request timeouts are capped at 180s", () => {
    const budget = createTurnBudget("full_execution", "high", Date.now(), { deepTask: true });
    expect(computeRequestTimeoutMs("executor", budget, 300_000)).toBe(180_000);
  });

  test("fallback retry recomputes against the actual remaining stage and turn budget", () => {
    let stageRemaining = 150_000;
    let turnRemaining = 200_000;
    const budget = {
      turn_ms: EXTENDED_DEEP_TURN_MS,
      stageRemainingMs: () => stageRemaining,
      remainingMs: () => turnRemaining,
    } as any;

    expect(computeBoundedRequestTimeoutMs("agent_loop", budget, 300_000)).toBe(150_000);
    stageRemaining = 12_000;
    turnRemaining = 18_000;
    expect(computeBoundedRequestTimeoutMs("agent_loop", budget, 300_000)).toBe(12_000);
  });

  test("request timeout diagnostic reports the computed watchdog duration", () => {
    expect(requestTimeoutMessage(12_000)).toContain("12s");
    expect(requestTimeoutMessage(12_000)).not.toContain("300s");
  });
  test("reserves the finalization window before optional repair work", () => {
    const budget = createTurnBudget("full_execution", "high", 1_000);
    expect(budget.canStart("rewriter", 151_000)).toBe(false);
    expect(budget.remainingMs(151_000)).toBe(30_000);
  });

  test("caps each stage at two candidates and gives high execution a bounded extension", () => {
    const budget = createTurnBudget("full_execution", "high", 0);
    expect(budget.max_stage_attempts).toBe(2);
    expect(budget.turn_ms).toBe(180_000);
    expect(budget.stageRemainingMs("executor", 1_000)).toBe(60_000);
  });

  // F5: "force deep read" is a real budget contract, not a prompt slogan.
  test("forced deep read grants 240s turn deadline and 150s executor budget", () => {
    const forced = createTurnBudget("full_execution", "high", 0, { forcedDeepRead: true });
    expect(forced.turn_ms).toBe(FORCED_DEEP_READ_TURN_MS);
    expect(forced.deadlineAt).toBe(FORCED_DEEP_READ_TURN_MS);
    expect(forced.stage_ms.executor).toBe(FORCED_DEEP_READ_EXECUTOR_MS);
    expect(forced.stageRemainingMs("executor", 0)).toBe(FORCED_DEEP_READ_EXECUTOR_MS);
    expect(forced.finalStreamDeadlineAt()).toBe(FORCED_DEEP_READ_TURN_MS + FINAL_STREAM_GRACE_MS);

    const unforced = createTurnBudget("full_execution", "high", 0);
    expect(unforced.turn_ms).toBe(180_000);
    expect(unforced.stage_ms.executor).toBe(60_000);
  });

  test("forced deep read extendStageOnProgress never shrinks the extended executor ceiling", () => {
    const budget = createTurnBudget("workspace_read", "high", 0, { forcedDeepRead: true });
    expect(budget.stage_ms.executor).toBe(FORCED_DEEP_READ_EXECUTOR_MS);
    budget.extendStageOnProgress("executor", 1);
    expect(budget.stage_ms.executor).toBeGreaterThanOrEqual(FORCED_DEEP_READ_EXECUTOR_MS);
    expect(budget.turn_ms).toBeLessThanOrEqual(FORCED_DEEP_READ_TURN_MS);
  });

  // 2026-07-16 evening: deep-classified turns (fresh deep-read intent or a
  // continuation of a deep task run) share the forced hatch's long-haul
  // contract — 600s ceiling, 420s executor — without needing the magic phrase.
  test("deepTask option grants the same extended contract as the forced hatch", () => {
    const deep = createTurnBudget("full_execution", "high", 0, { deepTask: true });
    expect(deep.turn_ms).toBe(EXTENDED_DEEP_TURN_MS);
    expect(deep.turn_ms).toBe(600_000);
    expect(deep.stage_ms.executor).toBe(EXTENDED_DEEP_EXECUTOR_MS);
    expect(deep.finalStreamDeadlineAt()).toBe(EXTENDED_DEEP_TURN_MS + FINAL_STREAM_GRACE_MS);

    const forced = createTurnBudget("full_execution", "high", 0, { forcedDeepRead: true });
    expect(forced.turn_ms).toBe(deep.turn_ms);
    expect(forced.stage_ms.executor).toBe(deep.stage_ms.executor);

    const standard = createTurnBudget("full_execution", "high", 0);
    expect(standard.turn_ms).toBe(180_000);
  });

  test("uses compact budgets for conversational turns", () => {
    const budget = createTurnBudget("conversational", "medium", 0);
    expect(budget.turn_ms).toBe(30_000);
    expect(budget.canStart("synthesizer", 16_000)).toBe(false);
  });

  test("continuation budgets inherit the same requirement as their route", () => {
    const resolved = resolveTurnRequirement("Continue synthesizing the plan", "full_execution");
    const budget = createTurnBudget(resolved.result.requirement, "medium", 0);

    expect(resolved.continuation).toBe(true);
    expect(budget.requirement).toBe("full_execution");
    expect(budget.turn_ms).toBe(150_000);
  });

  test("caps coordinator work while leaving the terminal synthesizer to the turn deadline", () => {
    for (const requirement of ["conversational", "answer_only", "workspace_read"] as const) {
      const budget = createTurnBudget(requirement, "medium", 0);
      expect(budget.stageRemainingMs("coordinator", 0)).toBe(15_000);
      expect(budget.stage_ms.synthesizer).toBeUndefined();
      expect(budget.stageRemainingMs("synthesizer", 0)).toBe(budget.remainingMs(0));
    }
    // full_execution grants the coordinator 20s: mid-run replans share the
    // coordinator window with the initial route, and the live pool's first
    // token alone runs 10-20s (2026-07-17 run_cce0482e died here at 15s).
    const fullBudget = createTurnBudget("full_execution", "medium", 0);
    expect(fullBudget.stageRemainingMs("coordinator", 0)).toBe(20_000);
    expect(fullBudget.stage_ms.synthesizer).toBeUndefined();
  });

  // 2026-07-17: the rewriter is the effect-gate write-repair stage on change
  // turns; its former 30s window died mid-repair on live free-tier latency.
  test("full_execution rewriter window matches the executor-class 60s", () => {
    const budget = createTurnBudget("full_execution", "high", 0);
    expect(budget.stage_ms.rewriter).toBe(60_000);
  });

  test("evidence progress extends the executor stage budget up to the ceiling", () => {
    const budget = createTurnBudget("workspace_read", "medium", 0);
    expect(budget.stage_ms.executor).toBe(60_000);
    budget.extendStageOnProgress("executor", 1);
    expect(budget.stage_ms.executor).toBe(80_000); // 60k + 1*20k = 80k
    budget.extendStageOnProgress("executor", 3);
    expect(budget.stage_ms.executor).toBe(90_000); // 80k + 3*20k = 140k, clamped to 90k ceiling
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
    expect(workspaceBudget.stage_ms.executor).toBe(60_000);
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

  test("full_execution executor has parity with workspace_read at 60s", () => {
    const budget = createTurnBudget("full_execution", "medium", 0);
    expect(budget.stage_ms.executor).toBe(60_000);
    expect(budget.stageRemainingMs("executor", 0)).toBe(60_000);
  });

  // workspace_read's executor is the third stage affected by the same bug
  // class as the planner/reviewer fixes above. Before the fix, the static
  // 25_000 ceiling would always pick itself via the Math.min combinator
  // when a slow-start Nemotron-family model (override 55_000) was the
  // executor route — the same kind of silent inertness the planner test
  // reproduces. The executor default (go-deepseek-v4-pro) doesn't carry an
  // override today, but raising the ceiling proactively matches the
  // pattern set by the two prior commits so a future executor-defaulted
  // model with a 55_000+ override won't silently under-apply its window.
  // Note: the actual runtime delay is also bounded by remainingMs (turn
  // budget − reserve), so the wider ceiling just stops the override being
  // inert — it does not extend the turn beyond its 75_000ms total.
  test("workspace_read's executor ceiling no longer undercuts a same-family Nemotron override", () => {
    const pool = new AgentPool([{
      id: "zen-nemotron-ultra-free",
      provider: "opencode_zen",
      model_id: "nemotron-3-ultra-free",
      capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
      default_for: [],
      first_token_timeout_ms: 55_000,
      enabled: true,
    }]);
    const budget = createTurnBudget("workspace_read", "medium", 0);

    const stageRemainingMs = budget.stageRemainingMs("executor", 0);
    const resolvedFirstTokenMs = firstTokenTimeoutFor(pool, "nemotron-3-ultra-free", 30_000);
    expect(resolvedFirstTokenMs).toBe(55_000);

    // The EXACT combinator index.ts applies to the orchestrator watchdog.
    // The static executor ceiling (60_000) is above the override (55_000),
    // so the override wins the Math.min — the bug the old 25_000 ceiling
    // caused was that Math.min(25_000, 55_000) always picked 25_000,
    // making the override completely inert end-to-end.
    const actualWatchdogDelayMs = Math.min(stageRemainingMs, resolvedFirstTokenMs);
    expect(actualWatchdogDelayMs).toBe(55_000); // was 25_000 before the fix
  });

  // T1.1: retries within one inflight window share stage budget (cannot
  // re-arm a full 15s coordinator budget — 37s serial parse-fail chain).
  test("beginStage elapsed accounting shrinks stageRemainingMs across retries", () => {
    const budget = createTurnBudget("workspace_read", "medium", 0);
    budget.beginStage("coordinator", 1_000);
    // 10s into the stage → 5s of the 15s budget remain.
    expect(budget.stageRemainingMs("coordinator", 11_000)).toBe(5_000);
    // Second "attempt" at t=11s must NOT reset the budget (still inflight).
    budget.beginStage("coordinator", 11_000);
    expect(budget.stageRemainingMs("coordinator", 14_000)).toBe(2_000);
    expect(budget.stageRemainingMs("coordinator", 16_000)).toBe(0);
  });

  // F2: usage-based accounting — idle between ended attempts is free.
  test("two 20s planner attempts separated by 60s idle leave 20s remaining", () => {
    const budget = createTurnBudget("full_execution", "high", 0);
    budget.beginStage("planner", 0);
    budget.endStage("planner", 20_000);
    // 60s idle gap (replan / supervision) does not consume planner budget.
    budget.beginStage("planner", 80_000);
    budget.endStage("planner", 100_000);
    expect(budget.stageUsedMs("planner", 100_000)).toBe(40_000);
    expect(budget.stageRemainingMs("planner", 100_000)).toBe(20_000);
  });

  test("a stage never begun has full budget at any wall-clock time", () => {
    const budget = createTurnBudget("full_execution", "high", 0);
    expect(budget.stageRemainingMs("reviewer", 100_000)).toBe(60_000);
    expect(budget.canStart("reviewer", 100_000)).toBe(true);
  });

  test("stageStreamDeadlineAt is now+remaining and bounded by turn deadline", () => {
    const budget = createTurnBudget("conversational", "medium", 0);
    budget.beginStage("coordinator", 0);
    expect(budget.stageStreamDeadlineAt("coordinator", 0)).toBe(15_000);
    // Synthesizer has no stage budget.
    expect(budget.stageStreamDeadlineAt("synthesizer", 0)).toBeUndefined();
    // After partial use + end, a later re-entry gets a fresh absolute deadline
    // from *now*, not first-begin wall clock.
    budget.endStage("coordinator", 5_000);
    expect(budget.stageStreamDeadlineAt("coordinator", 20_000)).toBe(30_000);
  });

  // T1.3: final stream grace window.
  test("finalStreamDeadlineAt extends past deadlineAt by FINAL_STREAM_GRACE_MS", () => {
    const budget = createTurnBudget("workspace_read", "medium", 0);
    expect(budget.finalStreamDeadlineAt()).toBe(budget.deadlineAt + FINAL_STREAM_GRACE_MS);
  });
});
