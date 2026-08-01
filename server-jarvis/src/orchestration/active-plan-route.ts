// ═══════════════════════════════════════════════════════════════
// Active-plan continuation fast path — skip Coordinator + Planner
// when an explicit continuation already has an open TaskPlan item.
// ═══════════════════════════════════════════════════════════════

import type { StageName } from "./coordinator";
import type { TaskPlanAcceptanceCheck, TaskRunStatus } from "./task-run";

export interface ActivePlanContinuationInput {
  /** True when the user message is an explicit / work-order continuation. */
  explicitContinuation: boolean;
  /** Live TaskRun status — only active/paused continue mid-plan. */
  status: TaskRunStatus | string;
  /** Task-run turn count (1 = first turn of the task). */
  turnCount: number;
  /** Currently active plan item, if any. */
  activeItem?: {
    acceptanceChecks: Array<Pick<TaskPlanAcceptanceCheck, "id" | "description" | "kind">>;
  } | null;
}

/**
 * Deterministic pipeline for resuming an already-expanded TaskPlan item.
 *
 * - Returns `null` when the fast path does not apply.
 * - Never includes Planner (plan is already expanded).
 * - Includes Reviewer only when an acceptance check requires `reviewer_pass`.
 * - Always ends with synthesizer.
 */
export function activePlanContinuationPipeline(
  input: ActivePlanContinuationInput,
): StageName[] | null {
  if (!input.explicitContinuation) return null;
  if (input.status !== "active" && input.status !== "paused") return null;
  if (input.turnCount < 2) return null;
  if (!input.activeItem) return null;

  const needsReviewer = input.activeItem.acceptanceChecks.some(
    (check) => check.kind === "reviewer_pass",
  );

  if (needsReviewer) {
    return ["executor", "reviewer", "synthesizer"];
  }
  return ["executor", "synthesizer"];
}
