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
}

const BUDGETS: Record<TurnRequirement, Omit<TurnBudget, "requirement" | "complexity" | "startedAt" | "deadlineAt" | "remainingMs" | "stageRemainingMs" | "canStart">> = {
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
  };
  return budget;
}
