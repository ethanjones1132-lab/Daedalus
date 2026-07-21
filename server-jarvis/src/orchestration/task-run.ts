import { isContinuationTurn, isWorkOrderFollowup } from "./turn-triage";
import { hasWriteIntent, type TurnRequirement } from "./turn-requirements";
import { isDeepReadRequest } from "./evidence-sufficiency";

export type TaskRunDepth = "standard" | "deep";
export type TaskRunStatus = "active" | "paused" | "completed" | "failed" | "cancelled";

export interface TaskRunContract {
  taskRunId: string;
  sessionId: string;
  objective: string;
  workspacePath?: string;
  /** Absolute filesystem roots explicitly granted during this task run. */
  sessionGrants?: string[];
  requirement: TurnRequirement;
  depth: TaskRunDepth;
  estimatedComplexity: "low" | "medium" | "high";
  turnCount: number;
  status: TaskRunStatus;
  evidenceCount: number;
  remainingWork: string[];
  /**
   * 2026-07-18: sticky write intent for the whole task run. Derived from the
   * objective at creation and escalated by any later write-phrased turn, so
   * mid-task follow-ups ("re-execute", "continue") keep the executor's write
   * contract even though the follow-up text itself names no mutation.
   * Optional because pre-existing persisted sessions lack the field.
   */
  writeIntent?: boolean;
  lastOutcome?: string;
  lastTurnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRunInput {
  taskRunId: string;
  sessionId: string;
  objective: string;
  workspacePath?: string;
  sessionGrants?: string[];
  requirement: TurnRequirement;
  depth?: TaskRunDepth;
  estimatedComplexity?: "low" | "medium" | "high";
}

export interface TaskRunAcceptanceInput {
  requirement: TurnRequirement;
  depth: TaskRunDepth;
  pipelineOutcome: "success" | "degraded" | "failed" | "partial";
  answer: string;
  evidenceCount: number;
}

export interface TaskRunAcceptanceResult {
  accepted: boolean;
  status: Extract<TaskRunStatus, "completed" | "paused" | "failed">;
  reason: string;
}

export function resolveDeepReadIntent(message: string, depth: TaskRunDepth | undefined): boolean {
  return depth === "deep" || isDeepReadRequest(message);
}

export function terminalSubtypeForRunOutcome(
  outcome: "success" | "degraded" | "failed" | "partial",
): "success" | "partial" | "error" {
  if (outcome === "success") return "success";
  if (outcome === "failed") return "error";
  return "partial";
}

// 2026-07-18 live gap: the synthesizer honestly wrote "partially applied"
// and "could not be confirmed as completed", but this pattern only knew
// "partially complete" — the half-done write task was ACCEPTED as completed,
// the task run's objective/workspace evaporated, and the user's "re-execute"
// minted a fresh objective-less task that wandered into the default
// workspace. Match the honesty vocabulary broadly: a false "paused" merely
// keeps continuation stickiness armed (cheap), a false "completed" strands
// the task (expensive).
const INCOMPLETE_PROGRESS_PATTERN =
  /\b(?:incomplete|unfinished|cut short|partial(?:ly)?|could not be (?:confirmed|completed|applied|written|verified)|not (?:yet )?(?:applied|completed|confirmed|written)|was not (?:applied|modified|updated|written)|remains? (?:unchanged|unmodified|unapplied|to be)|more (?:files|work|evidence)|still (?:need|needs|needed|remains?|pending)|not enough evidence|could not gather|unable to complete|remaining work)\b/i;

function newTaskRunId(): string {
  return `task_${crypto.randomUUID()}`;
}

// 2026-07-21 (F5): isWorkOrderFollowup is deliberately topic-agnostic — any
// short, non-question message during a live task IS a work order, by design
// (see the comment above isWorkOrderFollowup). That is correct for bare
// continuation cues ("go", "continue", "re-execute") which carry no topic of
// their own to compare. It is NOT correct once the message is substantial
// enough to express its own distinct objective: a live repro against a
// PAUSED (incomplete/partial) task run showed an unrelated new request
// ("create a different file in a different directory") being classified as a
// continuation and inheriting the previous, unrelated objective verbatim —
// which then got injected into the new turn's context ("[In-progress task]
// Objective: ...") and drove the executor to attempt the stale sub-task.
//
// This gate only applies to the isWorkOrderFollowup branch of the
// continuation OR-condition; isContinuationTurn (the narrow, explicit
// continuation-phrase list) is untouched — bare cues always continue.
const GENERIC_FOLLOWUP_MAX_CHARS = 48;
const OBJECTIVE_STOPWORDS = new Set([
  "this", "that", "with", "from", "into", "onto", "then", "just", "please",
  "also", "using", "make", "makes", "made", "have", "having", "does", "each",
  "your", "will", "would", "could", "should", "about", "which", "there",
]);

function significantTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_./\\-]+/i)
      .filter((tok) => tok.length >= 4 && !OBJECTIVE_STOPWORDS.has(tok)),
  );
}

/**
 * Whether `message` plausibly continues `objective`'s topic. A short/generic
 * message (<=48 chars — "go", "continue", "re-execute", "please apply the
 * edits") has no topic of its own to conflict with, so it passes through
 * unconditionally — that preserves the bare-continuation use case this
 * heuristic exists for. A longer, substantial message must share at least one
 * significant token (>=4 chars, path-like tokens included) with the previous
 * objective; otherwise it is treated as an unrelated new request rather than
 * a continuation, so its own objective is not silently discarded.
 */
export function sharesObjectiveSignal(objective: string, message: string): boolean {
  const trimmedMessage = message.trim();
  if (trimmedMessage.length <= GENERIC_FOLLOWUP_MAX_CHARS) return true;
  const objectiveTokens = significantTokens(objective);
  const messageTokens = significantTokens(trimmedMessage);
  // Fail open when there is nothing concrete to compare — do not regress a
  // case this heuristic previously admitted just because both sides happen
  // to be token-poor.
  if (objectiveTokens.size === 0 || messageTokens.size === 0) return true;
  for (const token of messageTokens) {
    if (objectiveTokens.has(token)) return true;
  }
  return false;
}

export function createTaskRun(input: CreateTaskRunInput): TaskRunContract {
  const now = new Date().toISOString();
  return {
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
    objective: input.objective.trim(),
    workspacePath: input.workspacePath,
    sessionGrants: input.sessionGrants ?? [],
    requirement: input.requirement,
    depth: input.depth ?? "standard",
    estimatedComplexity: input.estimatedComplexity ?? "medium",
    turnCount: 1,
    status: "active",
    evidenceCount: 0,
    remainingWork: [],
    writeIntent: input.requirement === "full_execution" && hasWriteIntent(input.objective),
    createdAt: now,
    updatedAt: now,
  };
}

export function resolveTaskRunTurn(
  previous: TaskRunContract | undefined,
  message: string,
  classifiedRequirement: TurnRequirement,
  options: Partial<Pick<CreateTaskRunInput, "sessionId" | "workspacePath" | "sessionGrants" | "estimatedComplexity" | "depth">> = {},
): { contract: TaskRunContract; isContinuation: boolean } {
  const previousLive = Boolean(
    previous && !["completed", "failed", "cancelled"].includes(previous.status),
  );
  // 2026-07-18 polarity flip (mirrors resolveTurnRequirement): during a live
  // full-execution task, any short non-question work order resumes the task
  // run — otherwise "re-execute" mints a NEW task whose objective is the
  // literal word "re-execute" and every sticky property (workspace, depth,
  // write intent) is lost.
  const continuation = previousLive && (
    isContinuationTurn(message) ||
    (previous!.requirement === "full_execution" &&
      isWorkOrderFollowup(message) &&
      sharesObjectiveSignal(previous!.objective, message))
  );

  if (continuation && previous) {
    return {
      isContinuation: true,
      contract: {
        ...previous,
        sessionGrants: Array.from(new Set([
          ...(previous.sessionGrants ?? []),
          ...(options.sessionGrants ?? []),
        ])),
        turnCount: previous.turnCount + 1,
        status: "active",
        // A write-phrased follow-up escalates a read task's contract; write
        // intent never de-escalates while the same task run is live.
        writeIntent: previous.writeIntent === true ||
          (previous.requirement === "full_execution" && hasWriteIntent(message)),
        lastOutcome: undefined,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  return {
    isContinuation: false,
    contract: createTaskRun({
      taskRunId: newTaskRunId(),
      sessionId: options.sessionId ?? previous?.sessionId ?? "unknown",
      objective: message,
      workspacePath: options.workspacePath ?? previous?.workspacePath,
      sessionGrants: options.sessionGrants,
      requirement: classifiedRequirement,
      depth: options.depth ?? "standard",
      estimatedComplexity: options.estimatedComplexity ?? "medium",
    }),
  };
}

export function assessTaskRunAcceptance(input: TaskRunAcceptanceInput): TaskRunAcceptanceResult {
  const answer = input.answer.trim();
  // F9: a failed/empty turn that still gathered evidence must *pause* so
  // "continue…" resumes the real objective/workspace/depth instead of minting
  // a new task run whose objective is the literal word "continue".
  if (input.pipelineOutcome === "failed" || !answer) {
    return input.evidenceCount > 0
      ? { accepted: false, status: "paused", reason: "pipeline_failed_with_evidence" }
      : { accepted: false, status: "failed", reason: "pipeline_failed_or_empty" };
  }
  if (input.pipelineOutcome === "partial") {
    return { accepted: false, status: "paused", reason: "pipeline_partial" };
  }
  if (INCOMPLETE_PROGRESS_PATTERN.test(answer)) {
    return { accepted: false, status: "paused", reason: "answer_declares_incomplete_progress" };
  }
  if (input.depth === "deep" && input.evidenceCount < 3) {
    return { accepted: false, status: "paused", reason: "deep_task_evidence_floor_not_met" };
  }
  if ((input.requirement === "workspace_read" || input.requirement === "full_execution") && input.evidenceCount < 1) {
    return { accepted: false, status: "paused", reason: "workspace_task_has_no_evidence" };
  }
  return { accepted: true, status: "completed", reason: "objective_completion_contract_met" };
}
