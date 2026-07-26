export type MidLoopDecisionSource =
  | "deterministic_reflex"
  | "resident_model"
  | "resident_error"
  | "no_signal"
  | "cap_exhausted";

export interface MidLoopDecisionMeta {
  /** Truthful origin for audit/replay; populated by LiveConductor.checkMidLoop. */
  decisionSource?: MidLoopDecisionSource;
  /** Shared with the model attribution when a resident escalation was attempted. */
  escalationId?: string;
}

export type LoopIntervention = (
  | { kind: "continue" }
  | { kind: "inject"; note: string }
  | { kind: "force_write"; note: string }
  | { kind: "redirect"; tool: string; note: string }
  | { kind: "abort"; reason: string }
) & MidLoopDecisionMeta;

export interface MidLoopSignal {
  writeIntent: boolean;
  successfulWrites: number;
  distinctSuccessfulReads: number;
  turnCount: number;
  maxTurns: number;
  /** Remaining wall-clock budget for the executor stage, ms. */
  stageRemainingMs: number;
  deadToolSuppressed: boolean;
  suppressedToolName?: string;
}

/** Thresholds are deliberately conservative: reflexes fire only on the
 * unambiguous cases. The middle ground (some reads, budget not yet critical)
 * is left for resident-model escalation - see conductor.ts checkMidLoop. */
const SPIRAL_READ_FLOOR = 5;
const FORCE_WRITE_BUDGET_FLOOR_MS = 150_000;
const ABORT_BUDGET_FLOOR_MS = 30_000;

/** Zero-inference reflex decision for one executor turn-loop iteration. */
export function decideMidLoopIntervention(signal: MidLoopSignal): LoopIntervention {
  if (signal.deadToolSuppressed && signal.suppressedToolName) {
    return {
      kind: "redirect",
      tool: signal.suppressedToolName,
      note: `${signal.suppressedToolName} has failed structurally and will not succeed this turn - use an alternative tool.`,
    };
  }

  if (!signal.writeIntent || signal.successfulWrites > 0) {
    return { kind: "continue" };
  }

  if (signal.distinctSuccessfulReads >= SPIRAL_READ_FLOOR) {
    if (signal.stageRemainingMs <= ABORT_BUDGET_FLOOR_MS) {
      return {
        kind: "abort",
        reason: `write-intent turn with ${signal.distinctSuccessfulReads} reads and zero writes; ` +
          `remaining budget (${Math.round(signal.stageRemainingMs / 1000)}s) is too low to recover - ` +
          "ending now with a clean partial instead of running to the timeout.",
      };
    }
    if (signal.stageRemainingMs <= FORCE_WRITE_BUDGET_FLOOR_MS) {
      return {
        kind: "force_write",
        note: `${signal.distinctSuccessfulReads} reads and zero writes so far - apply the change with a write tool now.`,
      };
    }
  }

  return { kind: "continue" };
}
