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

  // ── 2026-07-18 sticky write authority (live incident 04:43Z–04:53Z) ──
  // "re-execute" mid-implementation minted a NEW task run whose objective was
  // the literal word "re-execute", losing workspace, depth, and write intent.
  test("write task: creation derives sticky writeIntent from the objective", () => {
    const writeTask = createTaskRun({
      taskRunId: "task_write_1",
      sessionId: "session_1",
      objective: "Apply the Phase 1 smoothing changes to PluginProcessor.h and PluginProcessor.cpp",
      requirement: "full_execution",
    });
    expect(writeTask.writeIntent).toBe(true);

    const planTask = createTaskRun({
      taskRunId: "task_plan_1",
      sessionId: "session_1",
      objective: "create a comprehensive implementation plan. Do not modify files.",
      requirement: "full_execution",
    });
    expect(planTask.writeIntent).toBe(false);
  });

  test("active full-execution task: a bare work order resumes the run and keeps writeIntent", () => {
    const original = createTaskRun({
      taskRunId: "task_write_2",
      sessionId: "session_1",
      objective: "Apply the Phase 1 smoothing changes to PluginProcessor.h and PluginProcessor.cpp",
      workspacePath: "C:\\Users\\ethan\\Downloads\\Perihelion",
      requirement: "full_execution",
    });

    const next = resolveTaskRunTurn(original, "re-execute", "full_execution");

    expect(next.isContinuation).toBe(true);
    expect(next.contract.taskRunId).toBe(original.taskRunId);
    expect(next.contract.objective).toBe(original.objective);
    expect(next.contract.workspacePath).toBe(original.workspacePath);
    expect(next.contract.writeIntent).toBe(true);
  });

  test("a write-phrased follow-up escalates a non-write full task's contract", () => {
    const original = createTaskRun({
      taskRunId: "task_plan_2",
      sessionId: "session_1",
      objective: "create a comprehensive implementation plan. Do not modify files.",
      requirement: "full_execution",
    });
    expect(original.writeIntent).toBe(false);

    const next = resolveTaskRunTurn(original, "now apply the changes to the config file", "full_execution");

    expect(next.isContinuation).toBe(true);
    expect(next.contract.writeIntent).toBe(true);
  });

  test("completed task: a work order starts fresh instead of resuming", () => {
    const original = {
      ...createTaskRun({
        taskRunId: "task_done_1",
        sessionId: "session_1",
        objective: "Apply the smoothing changes to PluginProcessor.cpp",
        requirement: "full_execution",
      }),
      status: "completed" as const,
    };

    const next = resolveTaskRunTurn(original, "polish it up", "answer_only");
    expect(next.isContinuation).toBe(false);
    expect(next.contract.taskRunId).not.toBe(original.taskRunId);
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

  // F9: failed-with-evidence pauses so continuation inherits the real objective.
  test("pipeline failed with evidence pauses the task run for continuation", () => {
    const result = assessTaskRunAcceptance({
      requirement: "workspace_read",
      depth: "deep",
      pipelineOutcome: "failed",
      answer: "",
      evidenceCount: 2,
    });

    expect(result.accepted).toBe(false);
    expect(result.status).toBe("paused");
    expect(result.reason).toBe("pipeline_failed_with_evidence");
  });

  test("pipeline failed with zero evidence still terminates as failed", () => {
    const result = assessTaskRunAcceptance({
      requirement: "workspace_read",
      depth: "deep",
      pipelineOutcome: "failed",
      answer: "",
      evidenceCount: 0,
    });

    expect(result.accepted).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("pipeline_failed_or_empty");
  });

  test("continue after paused failure inherits the original objective (F9)", () => {
    const original = createTaskRun({
      taskRunId: "task_audit_fail",
      sessionId: "session_1",
      objective: "Identify all remaining gaps in the repo",
      workspacePath: "C:\\Projects\\Versutus",
      requirement: "workspace_read",
      depth: "deep",
      estimatedComplexity: "high",
    });
    // Simulate acceptance marking the run paused after a failed pipeline with evidence.
    const paused: typeof original = {
      ...original,
      status: "paused",
      evidenceCount: 2,
      lastOutcome: "failed",
    };

    const next = resolveTaskRunTurn(paused, "continue, force deep read", "conversational");

    expect(next.isContinuation).toBe(true);
    expect(next.contract.taskRunId).toBe(original.taskRunId);
    expect(next.contract.objective).toBe(original.objective);
    expect(next.contract.workspacePath).toBe(original.workspacePath);
    expect(next.contract.depth).toBe("deep");
    expect(next.contract.requirement).toBe("workspace_read");
    expect(next.contract.evidenceCount).toBe(2);
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
