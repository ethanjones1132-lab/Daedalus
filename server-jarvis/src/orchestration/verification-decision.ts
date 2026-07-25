import type { StageName } from "./coordinator";
import type { ConductorDirective } from "./conductor-bus";
import type { CheckResult } from "./check-runner";

export type VerificationDecision =
  | { kind: "directive"; directive: ConductorDirective; dropReviewer?: boolean }
  | { kind: "defer_to_resident" };

export function decideVerificationDirective(input: {
  check: CheckResult;
  item: { id: string };
  runId: string;
  remainingQueue: StageName[];
}): VerificationDecision {
  const { check, item, runId, remainingQueue } = input;

  // Fast-path: a check the model did NOT author, and it ran red → repair now.
  if (check.ran && check.passed === false) {
    return {
      kind: "directive",
      directive: {
        type: "start_repair_chain",
        itemId: item.id,
        reason: `verification failed (${check.tier}): ${check.detail.slice(0, 120)}`,
        flaggedIssues: check.detail,
        newRemaining: remainingQueue,
      },
    };
  }

  // Fast-path: a trustworthy tier passed → mark verified without a reviewer.
  if (check.ran && check.passed === true && (check.tier === "existing" || check.tier === "builtin")) {
    return {
      kind: "directive",
      dropReviewer: remainingQueue.includes("reviewer" as StageName),
      directive: {
        type: "mark_verified",
        itemId: item.id,
        evidenceRef: `${runId || "run"}:runtime_check:${item.id}`,
        evidenceSummary: check.command,
        gradingMode: "runtime_check",
        reason: `verified by ${check.tier} check (${check.command})`,
      },
    };
  }

  // synth pass, or nothing runnable, or ambiguous → resident conductor decides.
  return { kind: "defer_to_resident" };
}
