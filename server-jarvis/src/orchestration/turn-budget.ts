import type { TurnRequirement } from "./turn-requirements";

export interface TurnBudget {
  requirement: TurnRequirement;
  complexity: "low" | "medium" | "high";
  startedAt: number;
  turn_ms: number;
  finalization_reserve_ms: number;
  max_stage_attempts: number;
  stage_ms: Record<string, number>;
  deadlineAt: number;
  remainingMs(now?: number): number;
  stageRemainingMs(stage: string, now?: number): number;
  canStart(stage: string, now?: number): boolean;
  /**
   * Grant extra stage time when a stage turn produced new successful
   * evidence (Task 2.4). The 2026-07-12 incident's structural starvation:
   * a 25s executor budget against a ~52s-p50 provider pool makes "read a
   * repo" impossible. Rather than blanket-raising budgets (which trades
   * away interactive latency), a stage that is demonstrably making
   * progress earns more time, up to a hard ceiling that still respects
   * the absolute turn cap. No-ops for stages without a configured budget
   * and for zero/negative progress.
   */
  extendStageOnProgress(stage: string, newEvidenceCount: number): void;
}

const PROGRESS_EXTENSION_MS = 20_000;      // per evidence-producing stage turn
const STAGE_EXTENSION_CEILING_MS = 90_000; // a stage may never exceed this
const ABSOLUTE_TURN_CAP_MS = 180_000;      // matches the high-complexity full_execution cap

const BUDGETS: Record<TurnRequirement, Omit<TurnBudget, "requirement" | "complexity" | "startedAt" | "deadlineAt" | "remainingMs" | "stageRemainingMs" | "canStart" | "extendStageOnProgress">> = {
  conversational: { turn_ms: 30_000, finalization_reserve_ms: 15_000, max_stage_attempts: 2, stage_ms: { coordinator: 15_000 } },
  answer_only: { turn_ms: 45_000, finalization_reserve_ms: 20_000, max_stage_attempts: 2, stage_ms: { coordinator: 15_000, planner: 15_000 } },
  // workspace_read's executor ceiling: 60_000 (not the original 25_000) — same
  // bug class as the full_execution planner/reviewer fix above. The agent pool's
  // DEFAULT_ORCHESTRATOR_AGENTS gives slow-start Nemotron models a
  // first_token_timeout_ms: 55_000 override; if the executor route ever resolves
  // to such a model (or any future executor-defaulted model with a similar
  // override), the static 25_000 ceiling would silently undercut it via the
  // same Math.min(requestBudgetMs, firstTokenTimeoutFor(...)) combinator. The
  // runtime caps the actual delay at remainingMs (75_000 turn budget −
  // 25_000 reserve = 50_000), so the wider ceiling just stops the override
  // being inert — it does NOT extend the turn beyond its total budget.
  workspace_read: { turn_ms: 75_000, finalization_reserve_ms: 25_000, max_stage_attempts: 2, stage_ms: { coordinator: 15_000, executor: 60_000 } },
  // planner/reviewer: 60_000 (not the original 20_000) — see the
  // 2026-07-13 finding below. full_execution's 150-180s total turn_ms
  // leaves ample room; the per-stage ceilings are independent caps bounded
  // by overall remaining time, not a strict partition of the total, so
  // this doesn't starve later stages under normal (non-Nemotron) latency.
  // reviewer's default agent (or-nemotron-ultra-free) shares the exact
  // same 55_000ms override and is currently disabled in live config (a
  // separate, already-correct "disabled models don't inherit overrides"
  // behavior — see agent-pool.test.ts), so this specific ceiling isn't
  // actively biting today. Raised proactively: it's the identical bug
  // class as planner's, and would silently recur the moment that model
  // (or any future reviewer-stage model with a similarly large override)
  // is enabled.
  full_execution: { turn_ms: 150_000, finalization_reserve_ms: 30_000, max_stage_attempts: 2, stage_ms: { coordinator: 15_000, planner: 60_000, executor: 30_000, reviewer: 60_000, rewriter: 30_000 } },
};

// 2026-07-13 finding: agent-pool.ts's DEFAULT_ORCHESTRATOR_AGENTS gives
// nemotron-3-ultra-free (the planner/synthesizer default) a
// first_token_timeout_ms: 55_000 override specifically because it's a
// known slow-starting model — that fix shipped 2026-06-26/27 with its own
// passing regression test asserting firstTokenTimeoutFor resolves to
// 55_000. But index.ts's watchdog setup computes
// `Math.min(requestBudgetMs, firstTokenTimeoutFor(...))`, and
// requestBudgetMs is bounded by THIS file's stage_ms.planner — which was
// 20_000 for full_execution (15_000 for answer_only), both far below
// 55_000. The override's own unit test passed (it correctly resolves the
// function in isolation) while being completely inert in the actual
// end-to-end path: Math.min(20_000, 55_000) is always 20_000. Confirmed
// live via self-tuning.db: a real "create a full comprehensive
// implementation plan" (full_execution) turn failed with "First-token
// timeout (20000ms) on model=nemotron-3-ultra-free stage=planner" — the
// exact 20s value, not the intended 55s. Raised full_execution's planner
// ceiling above (to 60_000, matching firstTokenTimeoutFor's own capMs) so
// the override the pool advertises is the override that's actually
// enforced. answer_only's planner cap (15_000) is deliberately left alone:
// that tier's 45_000ms total turn budget has no room for a 55s allowance
// without starving synthesizer entirely, and it's a "fast tier" by design
// — a slow model there should fall back faster, not wait longer.

export function createTurnBudget(
  requirement: TurnRequirement,
  complexity: "low" | "medium" | "high" = "medium",
  startedAt = Date.now(),
): TurnBudget {
  const base = BUDGETS[requirement];
  const turn_ms = requirement === "full_execution" && complexity === "high"
    ? Math.min(180_000, base.turn_ms + 30_000)
    : base.turn_ms;
  const budget: TurnBudget = {
    requirement,
    complexity,
    startedAt,
    turn_ms,
    finalization_reserve_ms: base.finalization_reserve_ms,
    max_stage_attempts: base.max_stage_attempts,
    stage_ms: { ...base.stage_ms },
    deadlineAt: startedAt + turn_ms,
    remainingMs(now = Date.now()) {
      return Math.max(0, this.deadlineAt - now);
    },
    stageRemainingMs(stage, now = Date.now()) {
      const stageBudget = this.stage_ms[stage];
      if (stageBudget === undefined) return this.remainingMs(now);
      return Math.max(0, Math.min(stageBudget, this.remainingMs(now)));
    },
    canStart(stage, now = Date.now()) {
      if (this.remainingMs(now) <= this.finalization_reserve_ms) return false;
      return this.stage_ms[stage] === undefined || this.stageRemainingMs(stage, now) > 0;
    },
    extendStageOnProgress(stage, newEvidenceCount) {
      if (newEvidenceCount <= 0) return;
      const current = this.stage_ms[stage];
      if (current === undefined) return;
      const extension = Math.min(newEvidenceCount, 3) * PROGRESS_EXTENSION_MS;
      const next = Math.min(STAGE_EXTENSION_CEILING_MS, current + extension);
      const granted = next - current;
      if (granted <= 0) return;
      this.stage_ms[stage] = next;
      this.turn_ms = Math.min(ABSOLUTE_TURN_CAP_MS, this.turn_ms + granted);
      this.deadlineAt = this.startedAt + this.turn_ms;
    },
  };
  return budget;
}
