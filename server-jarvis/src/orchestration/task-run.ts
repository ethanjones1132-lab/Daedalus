import { isContinuationTurn } from "./turn-triage";
import type { TurnRequirement } from "./turn-requirements";
import { isDeepReadRequest } from "./evidence-sufficiency";

export type TaskRunDepth = "standard" | "deep";
export type TaskRunStatus = "active" | "paused" | "completed" | "failed" | "cancelled";

export interface TaskRunContract {
  taskRunId: string;
  sessionId: string;
  objective: string;
  workspacePath?: string;
  requirement: TurnRequirement;
  depth: TaskRunDepth;
  estimatedComplexity: "low" | "medium" | "high";
  turnCount: number;
  status: TaskRunStatus;
  evidenceCount: number;
  remainingWork: string[];
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

const INCOMPLETE_PROGRESS_PATTERN = /\b(?:incomplete|unfinished|cut short|more (?:files|work|evidence)|still need|not enough evidence|could not gather|unable to complete|remaining work|partially complete)\b/i;

function newTaskRunId(): string {
  return `task_${crypto.randomUUID()}`;
}

export function createTaskRun(input: CreateTaskRunInput): TaskRunContract {
  const now = new Date().toISOString();
  return {
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
    objective: input.objective.trim(),
    workspacePath: input.workspacePath,
    requirement: input.requirement,
    depth: input.depth ?? "standard",
    estimatedComplexity: input.estimatedComplexity ?? "medium",
    turnCount: 1,
    status: "active",
    evidenceCount: 0,
    remainingWork: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function resolveTaskRunTurn(
  previous: TaskRunContract | undefined,
  message: string,
  classifiedRequirement: TurnRequirement,
  options: Partial<Pick<CreateTaskRunInput, "sessionId" | "workspacePath" | "estimatedComplexity" | "depth">> = {},
): { contract: TaskRunContract; isContinuation: boolean } {
  const continuation = Boolean(
    previous &&
    !["completed", "failed", "cancelled"].includes(previous.status) &&
    isContinuationTurn(message),
  );

  if (continuation && previous) {
    return {
      isContinuation: true,
      contract: {
        ...previous,
        turnCount: previous.turnCount + 1,
        status: "active",
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
      requirement: classifiedRequirement,
      depth: options.depth ?? "standard",
      estimatedComplexity: options.estimatedComplexity ?? "medium",
    }),
  };
}

export function assessTaskRunAcceptance(input: TaskRunAcceptanceInput): TaskRunAcceptanceResult {
  const answer = input.answer.trim();
  if (input.pipelineOutcome === "failed" || !answer) {
    return { accepted: false, status: "failed", reason: "pipeline_failed_or_empty" };
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
