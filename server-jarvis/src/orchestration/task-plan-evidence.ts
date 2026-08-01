import type { CheckResult } from "./check-runner";
import type { ToolCallRecord } from "./stage-output";
import type { TaskPlanItem } from "./task-run";

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const READ_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "workspace_read"]);

export interface TaskPlanEvidenceGrounding {
  requiredEffect: "write" | "read" | "none";
  reviewerAccepted: boolean;
  successfulWrites: string[];
  successfulReads: string[];
  check?: Pick<CheckResult, "tier" | "ran" | "passed" | "command" | "detail">;
}

function target(call: ToolCallRecord): string {
  const value = call.arguments?.path ?? call.arguments?.file_path ?? call.arguments?.cwd;
  return typeof value === "string" ? value : call.name;
}

export function buildTaskPlanGrounding(input: {
  writeIntent: boolean;
  workspaceEvidenceRequired?: boolean;
  reviewerAccepted: boolean;
  toolCalls: readonly ToolCallRecord[];
  checkResult?: CheckResult;
}): TaskPlanEvidenceGrounding {
  const clean = input.toolCalls.filter((call) => !call.is_error);
  return {
    requiredEffect: input.writeIntent ? "write" : input.workspaceEvidenceRequired ? "read" : "none",
    reviewerAccepted: input.reviewerAccepted,
    successfulWrites: clean.filter((call) => WRITE_TOOLS.has(call.name)).map(target),
    successfulReads: clean.filter((call) => READ_TOOLS.has(call.name)).map(target),
    check: input.checkResult && {
      tier: input.checkResult.tier,
      ran: input.checkResult.ran,
      passed: input.checkResult.passed,
      command: input.checkResult.command,
      detail: input.checkResult.detail,
    },
  };
}

export function evaluateTaskPlanAcceptance(
  item: Pick<TaskPlanItem, "acceptanceChecks">,
  grounding: TaskPlanEvidenceGrounding,
): { accepted: boolean; unmet: string[] } {
  if (item.acceptanceChecks.length === 0) return { accepted: false, unmet: ["acceptance_checks_missing"] };
  const unmet: string[] = [];
  for (const check of item.acceptanceChecks) {
    if (check.kind === "diff_match" && grounding.successfulWrites.length === 0) {
      unmet.push(`${check.id}:write_evidence_required`);
    } else if (check.kind === "test_pass" && !(grounding.check?.tier !== "none" && grounding.check?.ran && grounding.check?.passed === true)) {
      unmet.push(`${check.id}:passing_check_required`);
    } else if (check.kind === "reviewer_pass" && !grounding.reviewerAccepted) {
      unmet.push(`${check.id}:reviewer_accept_required`);
    } else if (check.kind === "reviewer_pass" && grounding.requiredEffect === "write" && grounding.successfulWrites.length === 0) {
      unmet.push(`${check.id}:write_evidence_required`);
    } else if (check.kind === "reviewer_pass" && grounding.requiredEffect === "read" && grounding.successfulReads.length === 0) {
      unmet.push(`${check.id}:read_evidence_required`);
    } else if (check.kind === "manual") {
      unmet.push(`${check.id}:manual_check_required`);
    } else if (!check.kind) {
      unmet.push(`${check.id}:check_kind_required`);
    }
  }
  return { accepted: unmet.length === 0, unmet };
}
