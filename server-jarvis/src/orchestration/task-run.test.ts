import { describe, expect, test } from "bun:test";
import {
  assessTaskRunAcceptance,
  createTaskRun,
  resolveDeepReadIntent,
  resolveTaskRunTurn,
  terminalSubtypeForRunOutcome,
  type TaskRunContract,
  type TurnRequirement,
} from "./task-run";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT = {
  taskRunId: "task_test-001",
  sessionId: "session_test-001",
  objective: "Refactor the auth module to use JWT tokens",
  workspacePath: "/home/user/repo",
  requirement: "full_execution" as TurnRequirement,
  estimatedComplexity: "high" as const,
};

function makeTaskRun(overrides: Partial<Parameters<typeof createTaskRun>[0]> = {}): TaskRunContract {
  return createTaskRun({ ...BASE_INPUT, ...overrides });
}

// ---------------------------------------------------------------------------
// resolveDeepReadIntent
// ---------------------------------------------------------------------------

describe("task-run > resolveDeepReadIntent", () => {
  test("depth='deep' always returns true regardless of message", () => {
    expect(resolveDeepReadIntent("hello there", "deep")).toBe(true);
    expect(resolveDeepReadIntent("", "deep")).toBe(true);
    expect(resolveDeepReadIntent("yes", "deep")).toBe(true);
  });

  test("depth='standard' + deep-read markers returns true", () => {
    expect(resolveDeepReadIntent("comprehensively review the architecture", "standard")).toBe(true);
    expect(resolveDeepReadIntent("thoroughly audit the codebase", "standard")).toBe(true);
  });

  test("depth='standard' + plain message returns false", () => {
    expect(resolveDeepReadIntent("Refactor the auth module", "standard")).toBe(false);
    expect(resolveDeepReadIntent("yes", "standard")).toBe(false);
  });

  test("depth=undefined + plain message returns false", () => {
    expect(resolveDeepReadIntent("Refactor the auth module", undefined)).toBe(false);
  });

  test("depth=undefined + deep-read markers still returns true via isDeepReadRequest", () => {
    expect(resolveDeepReadIntent("comprehensively review the architecture", undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// terminalSubtypeForRunOutcome
// ---------------------------------------------------------------------------

describe("task-run > terminalSubtypeForRunOutcome", () => {
  test("success maps to 'success'", () => {
    expect(terminalSubtypeForRunOutcome("success")).toBe("success");
  });

  test("failed maps to 'error'", () => {
    expect(terminalSubtypeForRunOutcome("failed")).toBe("error");
  });

  test("degraded maps to 'partial'", () => {
    expect(terminalSubtypeForRunOutcome("degraded")).toBe("partial");
  });

  test("partial maps to 'partial'", () => {
    expect(terminalSubtypeForRunOutcome("partial")).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// createTaskRun
// ---------------------------------------------------------------------------

describe("task-run > createTaskRun", () => {
  test("applies all defaults: status active, turnCount 1, evidenceCount 0, remainingWork empty", () => {
    const run = createTaskRun({
      taskRunId: "task_x",
      sessionId: "sess_x",
      objective: "do the thing",
      requirement: "full_execution",
    });
    expect(run.status).toBe("active");
    expect(run.turnCount).toBe(1);
    expect(run.evidenceCount).toBe(0);
    expect(run.remainingWork).toEqual([]);
    expect(run.depth).toBe("standard");
    expect(run.estimatedComplexity).toBe("medium");
  });

  test("trims leading/trailing whitespace from objective", () => {
    const run = createTaskRun({
      taskRunId: "task_x",
      sessionId: "sess_x",
      objective: "   refactor the gateway   \n",
      requirement: "full_execution",
    });
    expect(run.objective).toBe("refactor the gateway");
  });

  test("writeIntent=true for full_execution + concrete write target", () => {
    const run = createTaskRun({
      taskRunId: "task_x",
      sessionId: "sess_x",
      objective: "Update the auth module to use JWT",
      requirement: "full_execution",
    });
    expect(run.writeIntent).toBe(true);
  });

  test("writeIntent=false for full_execution + read-only objective", () => {
    const run = createTaskRun({
      taskRunId: "task_x",
      sessionId: "sess_x",
      objective: "Review the auth module for issues",
      requirement: "full_execution",
    });
    expect(run.writeIntent).toBe(false);
  });

  test("writeIntent=false for workspace_read even with write verb in objective", () => {
    // requirement is workspace_read, not full_execution — write intent only escalates
    // when the request profile is full_execution (the only profile that allows mutation).
    const run = createTaskRun({
      taskRunId: "task_x",
      sessionId: "sess_x",
      objective: "Edit the config file",
      requirement: "workspace_read",
    });
    expect(run.writeIntent).toBe(false);
  });

  test("writeIntent=false for conversational and answer_only requirements", () => {
    const conv = createTaskRun({
      taskRunId: "task_a",
      sessionId: "sess_x",
      objective: "Edit the config file",
      requirement: "conversational",
    });
    expect(conv.writeIntent).toBe(false);
    const ans = createTaskRun({
      taskRunId: "task_b",
      sessionId: "sess_x",
      objective: "Edit the config file",
      requirement: "answer_only",
    });
    expect(ans.writeIntent).toBe(false);
  });

  test("propagates workspacePath, depth, complexity when provided", () => {
    const run = createTaskRun({
      taskRunId: "task_x",
      sessionId: "sess_x",
      objective: "do the thing",
      requirement: "full_execution",
      workspacePath: "/custom/path",
      depth: "deep",
      estimatedComplexity: "low",
    });
    expect(run.workspacePath).toBe("/custom/path");
    expect(run.depth).toBe("deep");
    expect(run.estimatedComplexity).toBe("low");
  });

  test("createdAt and updatedAt are equal at creation (both = now)", () => {
    const run = createTaskRun({
      taskRunId: "task_x",
      sessionId: "sess_x",
      objective: "do the thing",
      requirement: "full_execution",
    });
    expect(run.createdAt).toBe(run.updatedAt);
    expect(new Date(run.createdAt).toISOString()).toBe(run.createdAt);
  });
});

// ---------------------------------------------------------------------------
// resolveTaskRunTurn
// ---------------------------------------------------------------------------

describe("task-run > resolveTaskRunTurn", () => {
  test("no previous → creates fresh task run with isContinuation=false", () => {
    const result = resolveTaskRunTurn(undefined, "Refactor the gateway", "full_execution");
    expect(result.isContinuation).toBe(false);
    expect(result.contract.taskRunId).toMatch(/^task_/);
    expect(result.contract.turnCount).toBe(1);
    expect(result.contract.status).toBe("active");
    expect(result.contract.objective).toBe("Refactor the gateway");
  });

  test("terminal previous (completed) → new task run, NOT continuation", () => {
    const prev = makeTaskRun({ taskRunId: "task_old" });
    const terminal: TaskRunContract = { ...prev, status: "completed" };
    const result = resolveTaskRunTurn(terminal, "continue with the next step", "full_execution");
    expect(result.isContinuation).toBe(false);
    expect(result.contract.taskRunId).not.toBe("task_old");
  });

  test("terminal previous (failed) → new task run, NOT continuation", () => {
    const prev = makeTaskRun();
    const terminal: TaskRunContract = { ...prev, status: "failed" };
    const result = resolveTaskRunTurn(terminal, "continue", "full_execution");
    expect(result.isContinuation).toBe(false);
  });

  test("terminal previous (cancelled) → new task run, NOT continuation", () => {
    const prev = makeTaskRun();
    const terminal: TaskRunContract = { ...prev, status: "cancelled" };
    const result = resolveTaskRunTurn(terminal, "continue", "full_execution");
    expect(result.isContinuation).toBe(false);
  });

  test("active previous + explicit continuation phrase → continuation, turnCount increments, same ID", () => {
    const prev = makeTaskRun({ taskRunId: "task_xyz" });
    const result = resolveTaskRunTurn(prev, "continue with phase 2", "full_execution");
    expect(result.isContinuation).toBe(true);
    expect(result.contract.taskRunId).toBe("task_xyz");
    expect(result.contract.turnCount).toBe(prev.turnCount + 1);
    expect(result.contract.status).toBe("active");
  });

  test("active previous + work-order followup (full_execution) → continuation (2026-07-18 polarity flip)", () => {
    // Live incident: "re-execute" / "go" / "Please apply the edits" were missed by
    // finite pattern lists and silently downgraded to a new tool-less task run.
    // Under an ACTIVE full_execution task, ANY short non-question message IS a work order.
    const prev = makeTaskRun({ taskRunId: "task_xyz", requirement: "full_execution" });
    const cases = ["re-execute", "go", "do it", "Please apply the edits oh my goodness"];
    for (const msg of cases) {
      const result = resolveTaskRunTurn(prev, msg, "full_execution");
      expect(result.isContinuation).toBe(true);
      expect(result.contract.taskRunId).toBe("task_xyz");
    }
  });

  test("active previous + work-order followup (workspace_read) → NOT continuation", () => {
    // The polarity flip only applies to full_execution. workspace_read stays strict.
    const prev = makeTaskRun({ taskRunId: "task_xyz", requirement: "workspace_read" });
    const result = resolveTaskRunTurn(prev, "re-execute", "workspace_read");
    expect(result.isContinuation).toBe(false);
  });

  test("active previous + long work-order message (>160 chars) → NOT continuation", () => {
    // isWorkOrderFollowup bails on messages longer than 160 chars.
    const prev = makeTaskRun({ requirement: "full_execution" });
    const long = "x".repeat(200);
    const result = resolveTaskRunTurn(prev, long, "full_execution");
    expect(result.isContinuation).toBe(false);
  });

  test("active previous + question → NOT continuation", () => {
    const prev = makeTaskRun({ requirement: "full_execution" });
    const result = resolveTaskRunTurn(prev, "What should I do next?", "full_execution");
    expect(result.isContinuation).toBe(false);
  });

  test("continuation clears lastOutcome (paused → active should not carry stale outcome)", () => {
    const prev: TaskRunContract = {
      ...makeTaskRun(),
      status: "paused",
      lastOutcome: "answer_declares_incomplete_progress",
    };
    const result = resolveTaskRunTurn(prev, "continue", "full_execution");
    expect(result.isContinuation).toBe(true);
    expect(result.contract.status).toBe("active");
    expect(result.contract.lastOutcome).toBeUndefined();
  });

  test("write intent is monotonic: once true, stays true on continuation", () => {
    const prev: TaskRunContract = { ...makeTaskRun(), writeIntent: true };
    const result = resolveTaskRunTurn(prev, "show me the file", "full_execution");
    expect(result.contract.writeIntent).toBe(true);
  });

  test("write intent escalates on continuation: full_execution + write message", () => {
    const prev: TaskRunContract = { ...makeTaskRun(), writeIntent: false };
    const result = resolveTaskRunTurn(prev, "edit the auth module", "full_execution");
    expect(result.contract.writeIntent).toBe(true);
  });

  test("write intent does NOT escalate on continuation when requirement is not full_execution", () => {
    const prev: TaskRunContract = { ...makeTaskRun(), writeIntent: false, requirement: "workspace_read" };
    const result = resolveTaskRunTurn(prev, "edit the auth module", "workspace_read");
    expect(result.contract.writeIntent).toBe(false);
  });

  test("new task (not continuation) inherits sessionId/workspacePath from previous when not in options", () => {
    const prev = makeTaskRun({
      taskRunId: "task_old",
      sessionId: "sess_inherit",
      workspacePath: "/inherit/path",
    });
    const terminal: TaskRunContract = { ...prev, status: "completed" };
    const result = resolveTaskRunTurn(terminal, "different request entirely", "full_execution");
    expect(result.isContinuation).toBe(false);
    expect(result.contract.sessionId).toBe("sess_inherit");
    expect(result.contract.workspacePath).toBe("/inherit/path");
  });

  test("new task (not continuation) options override inherited values", () => {
    const prev = makeTaskRun({ sessionId: "sess_inherit", workspacePath: "/inherit/path" });
    const terminal: TaskRunContract = { ...prev, status: "completed" };
    const result = resolveTaskRunTurn(
      terminal,
      "fresh request",
      "full_execution",
      { sessionId: "sess_new", workspacePath: "/new/path" },
    );
    expect(result.contract.sessionId).toBe("sess_new");
    expect(result.contract.workspacePath).toBe("/new/path");
  });
});

// ---------------------------------------------------------------------------
// assessTaskRunAcceptance
// ---------------------------------------------------------------------------

describe("task-run > assessTaskRunAcceptance", () => {
  test("failed + no evidence → failed with 'pipeline_failed_or_empty'", () => {
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "failed",
      answer: "no content",
      evidenceCount: 0,
    });
    expect(r).toEqual({
      accepted: false,
      status: "failed",
      reason: "pipeline_failed_or_empty",
    });
  });

  test("failed + evidence>0 → paused with 'pipeline_failed_with_evidence' (F9)", () => {
    // F9: a failed turn that still gathered evidence must PAUSE so the user's
    // 'continue…' inherits the real objective/workspace/depth, not a fresh task
    // whose objective is the literal word "continue".
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "failed",
      answer: "I couldn't finish, but I gathered some evidence.",
      evidenceCount: 2,
    });
    expect(r.status).toBe("paused");
    expect(r.reason).toBe("pipeline_failed_with_evidence");
  });

  test("empty answer → failed when no evidence, paused when evidence present", () => {
    const noEv = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "   ",
      evidenceCount: 0,
    });
    expect(noEv.status).toBe("failed");
    expect(noEv.reason).toBe("pipeline_failed_or_empty");

    const withEv = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "",
      evidenceCount: 1,
    });
    expect(withEv.status).toBe("paused");
    expect(withEv.reason).toBe("pipeline_failed_with_evidence");
  });

  test("partial outcome → paused with 'pipeline_partial'", () => {
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "partial",
      answer: "Most of it worked.",
      evidenceCount: 2,
    });
    expect(r).toEqual({
      accepted: false,
      status: "paused",
      reason: "pipeline_partial",
    });
  });

  test("INCOMPLETE_PROGRESS_PATTERN: 'partially applied' → paused (live 2026-07-18 incident)", () => {
    // Live incident: the synthesizer wrote "partially applied" and this pattern
    // only knew "partially complete" — the half-done task was accepted as
    // completed and the user's "re-execute" minted a new objective-less task.
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "I partially applied the changes.",
      evidenceCount: 5,
    });
    expect(r.status).toBe("paused");
    expect(r.reason).toBe("answer_declares_incomplete_progress");
  });

  test("INCOMPLETE_PROGRESS_PATTERN: each phrase in the regex fires the pause", () => {
    // Pin every phrase in the regex literal so a future edit that drops one
    // (e.g. 'unable to complete' is silently lost) is caught here.
    const phrases = [
      "The work is incomplete.",
      "This task is unfinished.",
      "Process was cut short.",
      "The change is partial.",
      "This is partially done.",
      "The work could not be confirmed.",
      "Edits could not be completed.",
      "The fix could not be applied.",
      "The file could not be written.",
      "The result could not be verified.",
      "The patch was not applied.",
      "The file was not modified.",
      "The config was not updated.",
      "The script was not written.",
      "The file remains unchanged.",
      "The state remains unmodified.",
      "More files need to be processed.",
      "More work is required.",
      "More evidence is needed.",
      "I still need to look at the second file.",
      "The task still remains.",
      "Some work is still pending.",
      "There is not enough evidence to conclude.",
      "I could not gather the full picture.",
      "I was unable to complete the implementation.",
      "There is remaining work to be done.",
    ];
    for (const phrase of phrases) {
      const r = assessTaskRunAcceptance({
        requirement: "full_execution",
        depth: "standard",
        pipelineOutcome: "success",
        answer: phrase,
        evidenceCount: 5,
      });
      expect(r.status).toBe("paused");
      expect(r.reason).toBe("answer_declares_incomplete_progress");
    }
  });

  test("INCOMPLETE_PROGRESS_PATTERN negative pin: 'fully verified and applied' does NOT pause", () => {
    // Regression guard: the regex must not over-match. A clean success
    // vocabulary with no incompleteness signal must pass through.
    const positives = [
      "Task fully verified and applied. All tests pass.",
      "I confirmed the changes work correctly.",
      "Implementation completed successfully.",
    ];
    for (const answer of positives) {
      const r = assessTaskRunAcceptance({
        requirement: "full_execution",
        depth: "standard",
        pipelineOutcome: "success",
        answer,
        evidenceCount: 5,
      });
      expect(r.status).toBe("completed");
    }
  });

  test("deep + evidenceCount<3 → paused with 'deep_task_evidence_floor_not_met'", () => {
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "deep",
      pipelineOutcome: "success",
      answer: "I read one file thoroughly.",
      evidenceCount: 1,
    });
    expect(r.status).toBe("paused");
    expect(r.reason).toBe("deep_task_evidence_floor_not_met");
  });

  test("deep + evidenceCount=3 (boundary) → completed", () => {
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "deep",
      pipelineOutcome: "success",
      answer: "I read the three files I needed.",
      evidenceCount: 3,
    });
    expect(r.status).toBe("completed");
    expect(r.reason).toBe("objective_completion_contract_met");
  });

  test("workspace_read + evidenceCount=0 → paused with 'workspace_task_has_no_evidence'", () => {
    const r = assessTaskRunAcceptance({
      requirement: "workspace_read",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "Looks like there's a bug in the gateway.",
      evidenceCount: 0,
    });
    expect(r.status).toBe("paused");
    expect(r.reason).toBe("workspace_task_has_no_evidence");
  });

  test("workspace_read + evidenceCount=1 (boundary) → completed", () => {
    const r = assessTaskRunAcceptance({
      requirement: "workspace_read",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "There is a bug in the gateway.",
      evidenceCount: 1,
    });
    expect(r.status).toBe("completed");
  });

  test("full_execution + evidenceCount=0 → paused with 'workspace_task_has_no_evidence'", () => {
    // The workspace task evidence floor also covers full_execution — a full
    // task with zero evidence is just a hallucination.
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "Done.",
      evidenceCount: 0,
    });
    expect(r.status).toBe("paused");
    expect(r.reason).toBe("workspace_task_has_no_evidence");
  });

  test("conversational + no evidence + clean answer → completed (no floor)", () => {
    const r = assessTaskRunAcceptance({
      requirement: "conversational",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "Sure, happy to help.",
      evidenceCount: 0,
    });
    expect(r.status).toBe("completed");
  });

  test("answer_only + no evidence + clean answer → completed (no floor)", () => {
    const r = assessTaskRunAcceptance({
      requirement: "answer_only",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "The capital of France is Paris.",
      evidenceCount: 0,
    });
    expect(r.status).toBe("completed");
  });

  test("happy path: full_execution + deep + 3 evidence + clean answer → completed", () => {
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "deep",
      pipelineOutcome: "success",
      answer: "The refactor is complete. All tests pass.",
      evidenceCount: 5,
    });
    expect(r).toEqual({
      accepted: true,
      status: "completed",
      reason: "objective_completion_contract_met",
    });
  });

  test("answer whitespace trimmed before INCOMPLETE_PROGRESS_PATTERN matching", () => {
    const r = assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "success",
      answer: "   partially applied   ",
      evidenceCount: 5,
    });
    expect(r.status).toBe("paused");
  });
});
