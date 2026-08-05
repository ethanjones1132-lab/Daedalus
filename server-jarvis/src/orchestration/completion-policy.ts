import type { CheckResult } from "./check-runner";
import type { TaskRunStatus } from "./task-run";

export type PersistedRunOutcome = "success" | "degraded" | "failed" | "partial";

export interface CompletionDecisionInput {
  pipelineOutcome: PersistedRunOutcome;
  reconciledStatus: TaskRunStatus;
  writeIntent: boolean;
  repeated: boolean;
  checkResult?: CheckResult;
  /**
   * True when at least one write-effect tool call landed successfully this turn.
   *
   * 2026-08-05: verification used to hinge on `writeIntent` alone. That flag
   * lives on the task-run contract, and a continuation that mints a fresh
   * contract sets it false — so a turn that wrote 21 files to a JUCE plugin and
   * never compiled fell through to `non_write_complete` and persisted as
   * success with `check_tier="none"`. Landed writes are ground truth; a
   * classification is not.
   */
  wroteCode?: boolean;
  /**
   * The turn's classified requirement. `full_execution` demands verification
   * on its own, so a write turn whose contract flag was lost still fails
   * closed rather than reporting success unverified.
   */
  requirement?: string;
}

/**
 * Whether this turn must produce an authoritative check before it may persist
 * as success. Any one of: the sticky contract flag, a landed write, or a
 * full_execution requirement.
 */
export function requiresVerification(input: CompletionDecisionInput): boolean {
  return input.writeIntent
    || input.wroteCode === true
    || input.requirement === "full_execution";
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
  const mustVerify = requiresVerification(input);
  if (mustVerify && input.checkResult?.passed === false) {
    return { taskStatus: "paused", runOutcome: "partial", reason: "verification_failed" };
  }
  if (mustVerify && !isAuthoritativelyGreen(input.checkResult)) {
    return { taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" };
  }
  if (mustVerify) {
    return { taskStatus: "completed", runOutcome: "success", reason: "verified_complete" };
  }
  // pipelineOutcome is "success" here — failed/partial/degraded already returned.
  return {
    taskStatus: "completed",
    runOutcome: "success",
    reason: "non_write_complete",
  };
}
