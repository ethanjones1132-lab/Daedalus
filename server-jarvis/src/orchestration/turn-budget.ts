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
  conversational: { turn_ms: 30_000, finalization_reserve_ms: 15_000, max_stage_attempts: 2, stage_ms: { synthesizer: 25_000 } },
  answer_only: { turn_ms: 45_000, finalization_reserve_ms: 20_000, max_stage_attempts: 2, stage_ms: { planner: 15_000, synthesizer: 30_000 } },
  workspace_read: { turn_ms: 75_000, finalization_reserve_ms: 25_000, max_stage_attempts: 2, stage_ms: { executor: 25_000, synthesizer: 30_000 } },
  full_execution: { turn_ms: 150_000, finalization_reserve_ms: 30_000, max_stage_attempts: 2, stage_ms: { planner: 20_000, executor: 30_000, reviewer: 20_000, rewriter: 30_000, synthesizer: 35_000 } },
};

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
