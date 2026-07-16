/** Maximum number of conductor queue rewrites allowed in one execution segment. */
export const DEFAULT_MAX_REROUTES_PER_SEGMENT = 3;

/** Stages that can produce tool calls and legitimately re-enter on evidence gaps. */
export const EVIDENCE_CAPABLE_STAGES = new Set<string>(["executor", "rewriter"]);

export function canApplyConductorReroute(
  applied: number,
  max = DEFAULT_MAX_REROUTES_PER_SEGMENT,
): boolean {
  return Number.isFinite(applied) && applied >= 0 && applied < Math.max(1, Math.floor(max));
}

export interface RerouteValidationInput {
  triggerStage: string;
  triggerOutcome: "completed" | "failed";
  newRemaining: string[];
  reason: string;
}

const EVIDENCE_RUBRIC_REASON = /\bevidence\b|\btool (?:calls?|results?|outputs?)\b|\bworkspace\b/i;

/**
 * Deterministic reroute admission.
 * Returns null when admissible, else a stable rejection reason code.
 */
export function rejectReroute(input: RerouteValidationInput): string | null {
  const reentersSelf = input.newRemaining.some(
    (s) => s === `re-enter:${input.triggerStage}` || s === input.triggerStage,
  );
  // A stage that just completed cleanly may not be re-entered by directive —
  // EXCEPT the evidence-capable stages, whose completed-with-evidence-gap
  // re-entry is the legitimate deterministic deep-read top-up pattern
  // (conductor.ts emits re-enter:executor and it flows through this gate).
  if (
    input.triggerOutcome === "completed" &&
    reentersSelf &&
    !EVIDENCE_CAPABLE_STAGES.has(input.triggerStage)
  ) {
    return "self_reroute_after_clean_completion";
  }
  // Evidence-motivated reroutes may only target evidence-capable stages.
  if (
    EVIDENCE_RUBRIC_REASON.test(input.reason) &&
    input.newRemaining.some((s) => s.replace(/^re-enter:/, "") === "planner")
  ) {
    return "evidence_reroute_targeting_toolless_stage";
  }
  return null;
}
