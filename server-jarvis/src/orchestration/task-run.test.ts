import { describe, expect, test } from "bun:test";
import {
  activatePlanItem,
  advancePlanQueue,
  assessTaskRunAcceptance,
  countItemizedEvidence,
  createAcceptanceCheck,
  createTaskPlan,
  createTaskPlanItem,
  createTaskRun,
  deriveTaskStatusFromPlan,
  getActivePlanItem,
  getPlanItem,
  hasEvidencePointer,
  incrementPlanItemRepairCycle,
  isTaskRunV2,
  listBlockedPlanItems,
  listPendingPlanItems,
  listVerifiedPlanItems,
  makeEvidencePointer,
  markPlanItemBlocked,
  markPlanItemVerified,
  normalizeTaskRunOnRead,
  remainingWorkFromPlan,
  resolveDeepReadIntent,
  resolveTaskRunTurn,
  setPlanItemEvidence,
  setTaskPlan,
  terminalSubtypeForRunOutcome,
  unblockPlanItem,
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
    expect(run.schemaVersion).toBe(2);
    expect(run.reconstruction).toBe("none");
    expect(run.plan).toEqual({ items: [], activeItemId: null });
    expect(isTaskRunV2(run)).toBe(true);
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

  // F5 (2026-07-21): a paused (incomplete/partial) task-run's objective was
  // leaking into the NEXT unrelated turn's context. Root cause verified by
  // direct repro against these exact functions: isWorkOrderFollowup accepts
  // ANY short (<=160 char), non-question message as a "work order followup"
  // during a live (active/paused) full_execution task, with no check that the
  // new message has anything to do with the previous objective. A partial
  // Get-Date turn's objective was inherited verbatim by a wholly unrelated
  // "create this other file" turn two turns later, and the stale objective
  // was injected into that turn's context ("[In-progress task] Objective: ...
  // Get-Date..."), causing the executor to attempt the stale sub-task.
  test("F5 repro: an unrelated substantial follow-up after a PAUSED task does NOT inherit the stale objective", () => {
    const prev: TaskRunContract = {
      ...makeTaskRun({
        objective: "Use the powershell tool to run the command Get-Date and report the current date and time it returns.",
      }),
      status: "paused",
      lastOutcome: "outcome=partial",
    };
    const unrelated =
      "In C:\\Users\\ethan\\Downloads\\Perihelion, create a new file named SHOULD_NOT_EXIST.md containing the word test. Use a write tool.";
    const result = resolveTaskRunTurn(prev, unrelated, "full_execution");
    expect(result.isContinuation).toBe(false);
    expect(result.contract.objective).toBe(unrelated);
    expect(result.contract.objective).not.toContain("Get-Date");
  });

  test("F5 fix preserves bare continuation phrases (go/continue/re-execute) regardless of topic", () => {
    const prev: TaskRunContract = {
      ...makeTaskRun({ objective: "Use the powershell tool to run the command Get-Date." }),
      status: "paused",
    };
    for (const msg of ["re-execute", "go", "do it", "Please apply the edits oh my goodness"]) {
      const result = resolveTaskRunTurn(prev, msg, "full_execution");
      expect(result.isContinuation).toBe(true);
    }
  });

  test("F5 fix preserves a genuine same-topic follow-up that shares a token with the objective", () => {
    const prev: TaskRunContract = {
      ...makeTaskRun({ objective: "Read src/foo.ts and summarize what the exported function does." }),
      status: "paused",
    };
    const followup = "Now also add a unit test for the exported function in src/foo.ts covering the empty-input case.";
    const result = resolveTaskRunTurn(prev, followup, "full_execution");
    expect(result.isContinuation).toBe(true);
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

// ---------------------------------------------------------------------------
// TaskPlan ledger (TaskRunContract v2)
// ---------------------------------------------------------------------------

function makePlanRun(planItems: Parameters<typeof createTaskRun>[0]["planItems"]): TaskRunContract {
  return createTaskRun({
    ...BASE_INPUT,
    planItems,
  });
}

describe("task-run > TaskPlan constructors", () => {
  test("createTaskPlanItem defaults: pending, repairCycleCount 0, empty deps/checks", () => {
    const item = createTaskPlanItem({ title: " Write the adapter " });
    expect(item.title).toBe("Write the adapter");
    expect(item.status).toBe("pending");
    expect(item.repairCycleCount).toBe(0);
    expect(item.dependsOn).toEqual([]);
    expect(item.acceptanceChecks).toEqual([]);
    expect(item.id).toMatch(/^pi_/);
    expect(hasEvidencePointer(item)).toBe(false);
  });

  test("createTaskPlanItem rejects empty title", () => {
    expect(() => createTaskPlanItem({ title: "   " })).toThrow(/title/);
  });

  test("createAcceptanceCheck + string shorthand on plan item", () => {
    const check = createAcceptanceCheck("diff matches fixture", { kind: "diff_match", id: "ac_1" });
    expect(check).toEqual({
      id: "ac_1",
      description: "diff matches fixture",
      kind: "diff_match",
    });
    const item = createTaskPlanItem({
      id: "a",
      title: "A",
      acceptanceChecks: ["tests pass", check],
    });
    expect(item.acceptanceChecks).toHaveLength(2);
    expect(item.acceptanceChecks[0].description).toBe("tests pass");
    expect(item.acceptanceChecks[1].id).toBe("ac_1");
  });

  test("makeEvidencePointer requires non-empty ref and records timestamp", () => {
    expect(() => makeEvidencePointer("  ")).toThrow(/ref/);
    const pointer = makeEvidencePointer("turn_abc", "diff clean");
    expect(pointer.ref).toBe("turn_abc");
    expect(pointer.summary).toBe("diff clean");
    expect(pointer.recordedAt).toBeTruthy();
  });

  test("createTaskRun seeds plan and activates first ready item", () => {
    const run = makePlanRun([
      { id: "i1", title: "Scaffold module", acceptanceChecks: ["files exist"] },
      { id: "i2", title: "Wire tests", dependsOn: ["i1"] },
    ]);
    expect(run.schemaVersion).toBe(2);
    expect(run.plan?.items).toHaveLength(2);
    expect(run.plan?.activeItemId).toBe("i1");
    expect(getActivePlanItem(run)?.status).toBe("active");
    expect(getPlanItem(run, "i2")?.status).toBe("pending");
    expect(run.remainingWork).toEqual(["Scaffold module", "Wire tests"]);
  });

  test("createTaskPlan builds ordered items without activating", () => {
    const plan = createTaskPlan([{ id: "x", title: "Only item" }]);
    expect(plan.activeItemId).toBeNull();
    expect(plan.items[0].status).toBe("pending");
  });
});

describe("task-run > TaskPlan status transitions", () => {
  test("markPlanItemVerified stores grading mode + evidence pointer and advances queue", () => {
    let run = makePlanRun([
      { id: "i1", title: "Step one" },
      { id: "i2", title: "Step two", dependsOn: ["i1"] },
    ]);
    run = markPlanItemVerified(run, "i1", {
      gradingMode: "conductor_direct_diff",
      evidence: makeEvidencePointer("ev_1", "diff matched"),
    });
    const verified = getPlanItem(run, "i1")!;
    expect(verified.status).toBe("verified");
    expect(verified.gradingMode).toBe("conductor_direct_diff");
    expect(verified.evidence?.ref).toBe("ev_1");
    expect(verified.evidence?.summary).toBe("diff matched");
    expect(verified.verifiedAt).toBeTruthy();
    expect(verified.blockedReason).toBeUndefined();
    // Queue advances to next dep-satisfied item.
    expect(run.plan?.activeItemId).toBe("i2");
    expect(getPlanItem(run, "i2")?.status).toBe("active");
    expect(run.remainingWork).toEqual(["Step two"]);
    expect(listVerifiedPlanItems(run)).toHaveLength(1);
    expect(countItemizedEvidence(run.plan!)).toBe(1);
  });

  test("markPlanItemVerified with advance=false leaves queue on the verified item", () => {
    let run = makePlanRun([
      { id: "i1", title: "A" },
      { id: "i2", title: "B" },
    ]);
    run = markPlanItemVerified(run, "i1", {
      gradingMode: "reviewer_mediated",
      evidence: { ref: "ev_r1" },
      advance: false,
    });
    expect(getPlanItem(run, "i1")?.status).toBe("verified");
    expect(getPlanItem(run, "i1")?.gradingMode).toBe("reviewer_mediated");
    // No active item until advancePlanQueue is called.
    expect(run.plan?.activeItemId).toBeNull();
    expect(getPlanItem(run, "i2")?.status).toBe("pending");
    run = advancePlanQueue(run);
    expect(run.plan?.activeItemId).toBe("i2");
  });

  test("markPlanItemBlocked sets reason and derives overall paused status", () => {
    let run = makePlanRun([
      { id: "i1", title: "Hard step" },
      { id: "i2", title: "Later", dependsOn: ["i1"] },
    ]);
    run = markPlanItemBlocked(run, "i1", "  needs human input  ");
    expect(getPlanItem(run, "i1")?.status).toBe("blocked");
    expect(getPlanItem(run, "i1")?.blockedReason).toBe("needs human input");
    expect(listBlockedPlanItems(run)).toHaveLength(1);
    expect(run.status).toBe("paused");
    expect(deriveTaskStatusFromPlan(run.plan!)).toBe("paused");
  });

  test("unblockPlanItem returns item to pending without auto-activating", () => {
    let run = makePlanRun([{ id: "i1", title: "Step" }]);
    run = markPlanItemBlocked(run, "i1", "stuck");
    run = unblockPlanItem(run, "i1");
    expect(getPlanItem(run, "i1")?.status).toBe("pending");
    expect(getPlanItem(run, "i1")?.blockedReason).toBeUndefined();
    expect(run.plan?.activeItemId).toBeNull();
    run = advancePlanQueue(run);
    expect(run.plan?.activeItemId).toBe("i1");
  });

  test("advancePlanQueue respects dependsOn ordering", () => {
    let run = makePlanRun([
      { id: "a", title: "A" },
      { id: "b", title: "B", dependsOn: ["a"] },
      { id: "c", title: "C", dependsOn: ["b"] },
    ]);
    expect(run.plan?.activeItemId).toBe("a");
    // B cannot activate while A is still active/unverified.
    expect(() => activatePlanItem(run, "b")).toThrow(/dependencies/);

    run = markPlanItemVerified(run, "a", {
      gradingMode: "conductor_direct_diff",
      evidence: { ref: "ev_a" },
    });
    expect(run.plan?.activeItemId).toBe("b");

    run = markPlanItemVerified(run, "b", {
      gradingMode: "reviewer_mediated",
      evidence: { ref: "ev_b" },
    });
    expect(run.plan?.activeItemId).toBe("c");

    run = markPlanItemVerified(run, "c", {
      gradingMode: "conductor_direct_diff",
      evidence: { ref: "ev_c" },
    });
    expect(run.plan?.activeItemId).toBeNull();
    expect(run.status).toBe("completed");
    expect(run.remainingWork).toEqual([]);
    expect(listPendingPlanItems(run)).toEqual([]);
    expect(listVerifiedPlanItems(run)).toHaveLength(3);
  });

  test("advancePlanQueue is a no-op when an item is already active", () => {
    const run = makePlanRun([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    const again = advancePlanQueue(run);
    expect(again.plan?.activeItemId).toBe("a");
    expect(getPlanItem(again, "b")?.status).toBe("pending");
  });

  test("activatePlanItem demotes previous active back to pending", () => {
    let run = makePlanRun([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    expect(run.plan?.activeItemId).toBe("a");
    run = activatePlanItem(run, "b");
    expect(run.plan?.activeItemId).toBe("b");
    expect(getPlanItem(run, "a")?.status).toBe("pending");
    expect(getPlanItem(run, "b")?.status).toBe("active");
  });

  test("activatePlanItem rejects verified and blocked items", () => {
    let run = makePlanRun([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    run = markPlanItemVerified(run, "a", {
      gradingMode: "conductor_direct_diff",
      evidence: { ref: "ev" },
      advance: false,
    });
    expect(() => activatePlanItem(run, "a")).toThrow(/verified/);
    run = markPlanItemBlocked(run, "b", "nope");
    expect(() => activatePlanItem(run, "b")).toThrow(/blocked/);
  });

  test("incrementPlanItemRepairCycle counts Reviewer→Rewriter→Executor passes", () => {
    let run = makePlanRun([{ id: "a", title: "A" }]);
    run = incrementPlanItemRepairCycle(run, "a");
    run = incrementPlanItemRepairCycle(run, "a", 2);
    expect(getPlanItem(run, "a")?.repairCycleCount).toBe(3);
    expect(() => incrementPlanItemRepairCycle(run, "a", 0)).toThrow(/positive/);
  });

  test("setPlanItemEvidence attaches pointer without changing status", () => {
    let run = makePlanRun([{ id: "a", title: "A" }]);
    expect(getActivePlanItem(run)?.status).toBe("active");
    run = setPlanItemEvidence(run, "a", makeEvidencePointer("partial_ev", "wip"));
    const item = getPlanItem(run, "a")!;
    expect(item.status).toBe("active");
    expect(item.evidence?.ref).toBe("partial_ev");
    expect(hasEvidencePointer(item)).toBe(true);
  });

  test("setTaskPlan reconstructs a plan on a reconstruction_required contract", () => {
    const legacy = normalizeTaskRunOnRead({
      taskRunId: "task_old",
      sessionId: "sess",
      objective: "old objective",
      requirement: "full_execution",
      depth: "standard",
      estimatedComplexity: "medium",
      turnCount: 3,
      status: "paused",
      evidenceCount: 0,
      remainingWork: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })!;
    expect(legacy.reconstruction).toBe("reconstruction_required");
    expect(isTaskRunV2(legacy)).toBe(false);

    const rebuilt = setTaskPlan(legacy, [
      { id: "n1", title: "Rebuild step 1" },
      { id: "n2", title: "Rebuild step 2", dependsOn: ["n1"] },
    ]);
    expect(rebuilt.schemaVersion).toBe(2);
    expect(rebuilt.reconstruction).toBe("none");
    expect(isTaskRunV2(rebuilt)).toBe(true);
    expect(rebuilt.plan?.activeItemId).toBe("n1");
    expect(rebuilt.status).toBe("active");
  });

  test("ledger mutations throw when reconstruction is required", () => {
    const legacy = normalizeTaskRunOnRead({
      taskRunId: "task_old",
      sessionId: "sess",
      objective: "obj",
      requirement: "full_execution",
      status: "active",
      turnCount: 1,
      evidenceCount: 0,
      remainingWork: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })!;
    expect(() => advancePlanQueue(legacy)).toThrow(/reconstruction_required|schemaVersion 2/);
  });

  test("deriveTaskStatusFromPlan: empty→active, all verified→completed, blocked→paused", () => {
    expect(deriveTaskStatusFromPlan(createTaskPlan([]))).toBe("active");
    const pending = createTaskPlan([{ id: "a", title: "A" }]);
    expect(deriveTaskStatusFromPlan(pending)).toBe("active");
    let run = makePlanRun([{ id: "a", title: "A" }]);
    run = markPlanItemVerified(run, "a", {
      gradingMode: "conductor_direct_diff",
      evidence: { ref: "ev" },
    });
    expect(deriveTaskStatusFromPlan(run.plan!)).toBe("completed");
    expect(remainingWorkFromPlan(run.plan!)).toEqual([]);
  });

  test("failed/cancelled overall status is not clobbered by plan derivation", () => {
    let run = makePlanRun([{ id: "a", title: "A" }]);
    run = { ...run, status: "failed" };
    run = markPlanItemBlocked(run, "a", "x");
    expect(run.status).toBe("failed");
  });

  test("unknown item id throws on mark helpers", () => {
    const run = makePlanRun([{ id: "a", title: "A" }]);
    expect(() => markPlanItemVerified(run, "missing", {
      gradingMode: "conductor_direct_diff",
      evidence: { ref: "ev" },
    })).toThrow(/not found/);
    expect(() => markPlanItemBlocked(run, "missing", "x")).toThrow(/not found/);
  });
});

describe("task-run > normalizeTaskRunOnRead (legacy → reconstruction_required)", () => {
  test("missing schemaVersion is treated as legacy v1", () => {
    const legacy = {
      taskRunId: "task_legacy",
      sessionId: "sess_legacy",
      objective: "Refactor auth",
      requirement: "full_execution",
      depth: "standard",
      estimatedComplexity: "high",
      turnCount: 2,
      status: "active",
      evidenceCount: 0,
      remainingWork: [],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const normalized = normalizeTaskRunOnRead(legacy)!;
    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.reconstruction).toBe("reconstruction_required");
    expect(normalized.plan).toBeUndefined();
    expect(isTaskRunV2(normalized)).toBe(false);
  });

  test("schemaVersion 1 is reconstruction_required even if a plan blob is present", () => {
    const normalized = normalizeTaskRunOnRead({
      schemaVersion: 1,
      taskRunId: "task_v1",
      sessionId: "sess",
      objective: "obj",
      requirement: "workspace_read",
      depth: "deep",
      estimatedComplexity: "low",
      turnCount: 1,
      status: "paused",
      evidenceCount: 2,
      remainingWork: ["ghost"],
      plan: { items: [{ id: "x", title: "should be ignored" }], activeItemId: "x" },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    })!;
    expect(normalized.reconstruction).toBe("reconstruction_required");
    expect(normalized.plan).toBeUndefined();
    expect(normalized.remainingWork).toEqual(["ghost"]);
  });

  test("schemaVersion 2 preserves plan items, evidence, repair cycles, grading mode", () => {
    const normalized = normalizeTaskRunOnRead({
      schemaVersion: 2,
      reconstruction: "none",
      taskRunId: "task_v2",
      sessionId: "sess",
      objective: "obj",
      requirement: "full_execution",
      depth: "standard",
      estimatedComplexity: "medium",
      turnCount: 4,
      status: "active",
      evidenceCount: 3,
      remainingWork: [],
      plan: {
        activeItemId: "i2",
        items: [
          {
            id: "i1",
            title: "Done",
            dependsOn: [],
            acceptanceChecks: [{ id: "ac1", description: "ok", kind: "diff_match" }],
            status: "verified",
            gradingMode: "conductor_direct_diff",
            repairCycleCount: 0,
            evidence: { ref: "ev1", summary: "clean" },
            verifiedAt: "2026-07-20T00:00:00.000Z",
          },
          {
            id: "i2",
            title: "In progress",
            dependsOn: ["i1"],
            acceptanceChecks: [],
            status: "active",
            repairCycleCount: 2,
          },
        ],
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    })!;
    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.reconstruction).toBe("none");
    expect(isTaskRunV2(normalized)).toBe(true);
    expect(normalized.plan?.activeItemId).toBe("i2");
    expect(getPlanItem(normalized, "i1")?.gradingMode).toBe("conductor_direct_diff");
    expect(getPlanItem(normalized, "i1")?.evidence?.ref).toBe("ev1");
    expect(getPlanItem(normalized, "i2")?.repairCycleCount).toBe(2);
    expect(normalized.remainingWork).toEqual(["In progress"]);
  });

  test("invalid / incomplete raw returns undefined", () => {
    expect(normalizeTaskRunOnRead(null)).toBeUndefined();
    expect(normalizeTaskRunOnRead({})).toBeUndefined();
    expect(normalizeTaskRunOnRead({ taskRunId: "x" })).toBeUndefined();
    expect(normalizeTaskRunOnRead({ taskRunId: "x", sessionId: "s" })).toBeUndefined();
  });

  test("fresh createTaskRun round-trips through normalize without reconstruction", () => {
    const run = makePlanRun([
      { id: "a", title: "A", acceptanceChecks: ["pass"] },
    ]);
    const again = normalizeTaskRunOnRead(JSON.parse(JSON.stringify(run)))!;
    expect(again.schemaVersion).toBe(2);
    expect(again.reconstruction).toBe("none");
    expect(again.plan?.items[0].title).toBe("A");
    expect(again.plan?.activeItemId).toBe("a");
  });
});

describe("task-run > resolveTaskRunTurn preserves v2 plan on continuation", () => {
  test("continuation keeps plan ledger and increments turnCount", () => {
    const prev = makePlanRun([
      { id: "a", title: "A" },
      { id: "b", title: "B", dependsOn: ["a"] },
    ]);
    const result = resolveTaskRunTurn(prev, "continue", "full_execution");
    expect(result.isContinuation).toBe(true);
    expect(result.contract.schemaVersion).toBe(2);
    expect(result.contract.plan?.items).toHaveLength(2);
    expect(result.contract.plan?.activeItemId).toBe("a");
    expect(result.contract.turnCount).toBe(prev.turnCount + 1);
  });
});
