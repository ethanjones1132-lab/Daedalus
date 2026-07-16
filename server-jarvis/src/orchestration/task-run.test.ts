import { describe, expect, test } from "bun:test";
import {
  assessTaskRunAcceptance,
  createTaskRun,
  resolveDeepReadIntent,
  resolveTaskRunTurn,
  terminalSubtypeForRunOutcome,
} from "./task-run";

describe("durable task-run contract", () => {
  test("continuation preserves the original objective, depth, workspace, and authority", () => {
    const original = createTaskRun({
      taskRunId: "task_audit_1",
      sessionId: "session_1",
      objective: "Perform a comprehensive architecture audit",
      workspacePath: "C:\\Projects\\Versutus",
      requirement: "workspace_read",
      depth: "deep",
      estimatedComplexity: "high",
    });

    const next = resolveTaskRunTurn(original, "continue", "conversational");

    expect(next.isContinuation).toBe(true);
    expect(next.contract.taskRunId).toBe(original.taskRunId);
    expect(next.contract.objective).toBe(original.objective);
    expect(next.contract.workspacePath).toBe(original.workspacePath);
    expect(next.contract.requirement).toBe("workspace_read");
    expect(next.contract.depth).toBe("deep");
    expect(next.contract.estimatedComplexity).toBe("high");
    expect(next.contract.turnCount).toBe(2);
  });

  test("a new substantive request starts a new task run contract", () => {
    const original = createTaskRun({
      taskRunId: "task_audit_1",
      sessionId: "session_1",
      objective: "Audit the runtime",
      requirement: "workspace_read",
      depth: "deep",
      estimatedComplexity: "high",
    });

    const next = resolveTaskRunTurn(original, "explain this error", "answer_only");

    expect(next.isContinuation).toBe(false);
    expect(next.contract.taskRunId).not.toBe(original.taskRunId);
    expect(next.contract.objective).toBe("explain this error");
    expect(next.contract.requirement).toBe("answer_only");
    expect(next.contract.depth).toBe("standard");
  });

  test("incomplete progress cannot be accepted or distilled as success", () => {
    const result = assessTaskRunAcceptance({
      requirement: "workspace_read",
      depth: "deep",
      pipelineOutcome: "success",
      answer: "I started the audit, but the review is incomplete and more files remain.",
      evidenceCount: 8,
    });

    expect(result.accepted).toBe(false);
    expect(result.status).toBe("paused");
    expect(result.reason).toContain("incomplete");
  });

  test("deep continuation keeps the deep-read execution contract", () => {
    expect(resolveDeepReadIntent("continue", "deep")).toBe(true);
    expect(resolveDeepReadIntent("continue", "standard")).toBe(false);
    expect(resolveDeepReadIntent("comprehensively audit the repo", "standard")).toBe(true);
  });

  test("deep workspace work is accepted only after the evidence floor and a completion answer", () => {
    const result = assessTaskRunAcceptance({
      requirement: "workspace_read",
      depth: "deep",
      pipelineOutcome: "success",
      answer: "The audit is complete. The runtime has three architectural gaps.",
      evidenceCount: 3,
    });

    expect(result.accepted).toBe(true);
    expect(result.status).toBe("completed");
  });

  test("native stream terminal subtype reflects task-level partial truth", () => {
    expect(terminalSubtypeForRunOutcome("success")).toBe("success");
    expect(terminalSubtypeForRunOutcome("degraded")).toBe("partial");
    expect(terminalSubtypeForRunOutcome("partial")).toBe("partial");
    expect(terminalSubtypeForRunOutcome("failed")).toBe("error");
  });
});
