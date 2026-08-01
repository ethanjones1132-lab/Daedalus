import type { CheckResult } from "./check-runner";
import type { TaskRunStatus } from "./task-run";

export type PersistedRunOutcome = "success" | "degraded" | "failed" | "partial";

export interface CompletionDecisionInput {
  pipelineOutcome: PersistedRunOutcome;
  reconciledStatus: TaskRunStatus;
  writeIntent: boolean;
  repeated: boolean;
  checkResult?: CheckResult;
}

export interface CompletionDecision {
  taskStatus: TaskRunStatus;
  runOutcome: PersistedRunOutcome;
  reason:
    | "pipeline_failed"
    | "pipeline_partial"
    | "pipeline_degraded"
    | "repetition_detected"
    | "task_plan_open"
    | "write_unverified"
    | "verification_failed"
    | "verified_complete"
    | "non_write_complete";
}

export function isAuthoritativelyGreen(check: CheckResult | undefined): boolean {
  return Boolean(check && check.tier !== "none" && check.ran && check.passed === true);
}

/** Severity rank for outcome floors: higher means stricter / worse. */
const OUTCOME_SEVERITY: Record<PersistedRunOutcome, number> = {
  success: 0,
  degraded: 1,
  partial: 2,
  failed: 3,
};

/**
 * Apply a verification reward floor only when it makes the outcome stricter.
 * Prevents mapCheckToReward success floors from promoting partial/degraded
 * fail-closed decisions (e.g. write_unverified, pipeline_partial) to success.
 */
export function applyStricterOutcomeFloor(
  base: PersistedRunOutcome,
  floor: PersistedRunOutcome | null | undefined,
): PersistedRunOutcome {
  if (floor == null) return base;
  return OUTCOME_SEVERITY[floor] > OUTCOME_SEVERITY[base] ? floor : base;
}

export function decideCompletion(input: CompletionDecisionInput): CompletionDecision {
  if (input.pipelineOutcome === "failed" || input.reconciledStatus === "failed") {
    return { taskStatus: "failed", runOutcome: "failed", reason: "pipeline_failed" };
  }
  if (input.repeated) {
    return { taskStatus: "paused", runOutcome: "degraded", reason: "repetition_detected" };
  }
  if (input.pipelineOutcome === "partial") {
    return { taskStatus: "paused", runOutcome: "partial", reason: "pipeline_partial" };
  }
  if (input.pipelineOutcome === "degraded") {
    return { taskStatus: "paused", runOutcome: "degraded", reason: "pipeline_degraded" };
  }
  if (input.reconciledStatus !== "completed") {
    return { taskStatus: input.reconciledStatus, runOutcome: "partial", reason: "task_plan_open" };
  }
  if (input.writeIntent && input.checkResult?.passed === false) {
    return { taskStatus: "paused", runOutcome: "partial", reason: "verification_failed" };
  }
  if (input.writeIntent && !isAuthoritativelyGreen(input.checkResult)) {
    return { taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" };
  }
  if (input.writeIntent) {
    return { taskStatus: "completed", runOutcome: "success", reason: "verified_complete" };
  }
  // pipelineOutcome is "success" here — failed/partial/degraded already returned.
  return {
    taskStatus: "completed",
    runOutcome: "success",
    reason: "non_write_complete",
  };
}
