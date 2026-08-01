# Conductor Performance and Completion Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jarvis finish multi-item implementation work truthfully and materially faster by grounding TaskPlan verification, protecting delegate execution, cutting no-op model turns, and requiring authoritative checks before a write task can be called successful.

**Architecture:** Keep Jarvis's native Tauri + Bun server + React UI architecture intact. Put deterministic policy in small pure orchestration modules, leave `pipeline.ts` as the integration boundary, persist enough evidence for replay to prove behavior, and use the existing build/check and self-tuning stores instead of introducing a second execution system. Ship the work in independently testable phases: completion truth first, then plan evidence, delegate reliability, executor efficiency, verification readiness, and finally live rollout gates.

**Tech Stack:** Bun, TypeScript 6, `bun:test`, Bun SQLite, Python 3 proxy, PowerShell deployment/smoke scripts, CMake verification for C++ workspaces.

## Global Constraints

- Read `CONTEXT.md` and `README.md` before implementation; use the repository's Jarvis, Conductor, TaskRun, TaskPlan, Bun server, and Claude delegate terminology.
- Implement in an isolated worktree created with `superpowers:using-git-worktrees`; preserve unrelated changes in `C:\Projects\home-base-recovered`.
- Keep `qwen3.5:4b` as the local resident Conductor. Do not replace it with a cloud coordinator.
- Preserve the Claude CLI proxy launch path and local-only safety defaults; improve observability without logging credentials, authorization headers, prompts containing secrets, or full environment blocks.
- Treat `C:\Users\ethan\.openclaw\jarvis\self-tuning.db` as the authoritative runtime evidence store.
- Use TDD for every behavioral change: failing focused test, minimal implementation, focused green test, then broader regression.
- A write-intent run may be `success` only when its TaskPlan is complete and an authoritative check ran and passed. `check_tier=none` must produce `partial` and keep the TaskRun resumable.
- Reviewer prose is advisory. It cannot independently prove a write, readback, test, or completed child task.
- Preserve cancellation safety: user Stop, supersession, unconfirmed process cleanup, and failed ground-truth verification remain terminal and must never launch a duplicate native writer.
- Use one delegate process maximum per logical agent run unless a later task explicitly changes that invariant with new idempotency proof.
- Do not cold-configure CMake inside a model loop. Deterministic verification preparation may run outside the model loop in a bounded workspace cache.
- The rollout is incomplete until deployed provenance, a real delegated write/readback, a multi-item completion smoke, and a post-deploy replay window all pass.

---

## Measured Baseline and Release Targets

Capture the baseline again immediately before Task 1 and preserve its JSON output as a local execution artifact. The 2026-08-01 diagnosis found:

| Metric | Baseline | Release target |
|---|---:|---:|
| Six-run aggregate duration | 23.41 min | at least 30% lower on a comparable fixture |
| Executor share | 73.8% | below 60% |
| Executor no-tool turns | 49.2% | at most 10% |
| No-tool executor time | 7.30 min | at most 1.5 min per six comparable runs |
| Delegate verified-write rate | 0/6 | at least 8/10 live write fixtures |
| Successful write runs with `check_tier=none` | 3 observed false-success candidates | 0 |
| False-complete multi-item runs | observed | 0 |
| Duplicate semantic write pressure | 5 recent replay violations | 0 |

Baseline commands:

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun scripts/replay-conductor.ts --limit 500 --json
bun scripts/replay-conductor.ts --since 2026-08-01T10:00:00Z --json
```

## File and Responsibility Map

### New focused modules

- `server-jarvis/src/orchestration/completion-policy.ts` — the only mapping from pipeline, TaskPlan, repetition, and verification state to persisted TaskRun status and run outcome.
- `server-jarvis/src/orchestration/task-plan-evidence.ts` — builds durable evidence grounding and evaluates every acceptance-check kind.
- `server-jarvis/src/orchestration/task-plan-discovery.ts` — parses explicit numbered/checklist plan documents and expands one broad active item into durable child items without erasing prior progress.
- `server-jarvis/src/orchestration/delegate-intervention-policy.ts` — decides whether a mid-loop delegate signal is observed, deferred, handed off, or aborted.
- `server-jarvis/src/orchestration/executor-progress-policy.ts` — owns no-tool retry, model escalation, terminal partial, and semantic pressure budgets.
- `server-jarvis/src/orchestration/verification-workspace.ts` — prepares and caches bounded CMake verification directories outside model loops.
- `server-jarvis/src/eval/conductor-performance.ts` — computes release metrics from replay rows without network or model calls.
- `server-jarvis/scripts/benchmark-conductor-completion.ts` — read-only CLI over `self-tuning.db` with release thresholds.

### Existing integration surfaces

- `server-jarvis/src/orchestration/pipeline.ts` — wires evidence, plan expansion, delegate control, executor progress, transcript compaction, and verification into stage execution.
- `server-jarvis/src/index.ts` — uses one completion decision and takes the active-plan continuation fast path.
- `server-jarvis/src/orchestration/task-run.ts` — persists grounded evidence and applies safe plan item expansion.
- `server-jarvis/src/orchestration/runtime-loop.ts` — rejects vague planner decomposition and passes grounded verification through reviewer/direct-diff paths.
- `server-jarvis/src/orchestration/conductor.ts` and `conductor-bus.ts` — carry structured grounding in `mark_verified` directives.
- `server-jarvis/src/orchestration/claude-delegate.ts` — captures bounded sanitized process diagnostics and request correlation.
- `server-jarvis/src/orchestration/delegate-model-select.ts` — session-scoped, expiring thrash promotion.
- `server-jarvis/src/orchestration/context-budget.ts` — compacts completed executor cycles while preserving current tool-call pairing.
- `server-jarvis/src/orchestration/build-check.ts` and `check-runner.ts` — consume prepared verification workspaces and retain honest `none` semantics.
- `server-jarvis/src/self-tuning/store.ts` and `collector.ts` — persist diagnostic and verification provenance.
- `server-jarvis/src/eval/conductor-replay.ts` and `scripts/replay-conductor.ts` — enforce delegate-specific and completion-specific invariants.
- `scripts/claude_cli_proxy.py` — logs a sanitized correlation ID for each proxied request.
- `scripts/smoke-jarvis-runtime.ps1` — adds a multi-item completion-integrity smoke.

---

### Task 1: Make Persisted Completion a Single Fail-Closed Decision

**Files:**
- Create: `server-jarvis/src/orchestration/completion-policy.ts`
- Create: `server-jarvis/src/orchestration/completion-policy.test.ts`
- Modify: `server-jarvis/src/index.ts:3408-3458`
- Modify: `server-jarvis/src/orchestration/task-run.test.ts:430-520`

**Interfaces:**
- Consumes: `TaskRunStatus`, `TaskRunAcceptanceResult`, `CheckResult`, pipeline outcome, repetition verdict, and sticky TaskRun write intent.
- Produces: `decideCompletion(input: CompletionDecisionInput): CompletionDecision`, returning one persisted `taskStatus`, `runOutcome`, and machine-readable `reason`.

- [ ] **Step 1: Write failing completion-policy tests**

Create the test with explicit false-success reproductions:

```ts
import { describe, expect, test } from "bun:test";
import { decideCompletion } from "./completion-policy";

const none = {
  tier: "none" as const,
  ran: false,
  passed: null,
  detail: "",
  command: "",
  durationMs: 0,
};

const green = {
  tier: "builtin" as const,
  ran: true,
  passed: true,
  detail: "",
  command: "cmake --build C:\\cache\\perihelion",
  durationMs: 12,
};

describe("decideCompletion", () => {
  test("open TaskPlan prevents a successful run", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "active",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "active", runOutcome: "partial", reason: "task_plan_open" });
  });

  test("write task with tier none stays resumable", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: none,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" });
  });

  test("completed plan and authoritative green check can succeed", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "completed", runOutcome: "success", reason: "verified_complete" });
  });

  test("repetition remains degraded even with a green check", () => {
    expect(decideCompletion({
      pipelineOutcome: "success",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: true,
      checkResult: green,
    }).runOutcome).toBe("degraded");
  });

  test("partial pipeline cannot become complete through a drained ledger", () => {
    expect(decideCompletion({
      pipelineOutcome: "partial",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "paused", runOutcome: "partial", reason: "pipeline_partial" });
  });

  test("degraded pipeline cannot become a successful write run", () => {
    expect(decideCompletion({
      pipelineOutcome: "degraded",
      reconciledStatus: "completed",
      writeIntent: true,
      repeated: false,
      checkResult: green,
    })).toEqual({ taskStatus: "paused", runOutcome: "degraded", reason: "pipeline_degraded" });
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/completion-policy.test.ts
```

Expected: FAIL because `completion-policy.ts` does not exist.

- [ ] **Step 3: Implement the pure completion policy**

Use this public contract and decision order:

```ts
import type { CheckResult } from "./check-runner";
import type { TaskRunStatus } from "./task-run";

export type PersistedRunOutcome = "success" | "degraded" | "failed" | "partial";

export interface CompletionDecisionInput {
  pipelineOutcome: PersistedRunOutcome;
  reconciledStatus: TaskRunStatus;
  writeIntent: boolean;
  repeated: boolean;
  checkResult?: CheckResult;
}

export interface CompletionDecision {
  taskStatus: TaskRunStatus;
  runOutcome: PersistedRunOutcome;
  reason:
    | "pipeline_failed"
    | "pipeline_partial"
    | "pipeline_degraded"
    | "repetition_detected"
    | "task_plan_open"
    | "write_unverified"
    | "verification_failed"
    | "verified_complete"
    | "non_write_complete";
}

export function isAuthoritativelyGreen(check: CheckResult | undefined): boolean {
  return Boolean(check && check.tier !== "none" && check.ran && check.passed === true);
}

export function decideCompletion(input: CompletionDecisionInput): CompletionDecision {
  if (input.pipelineOutcome === "failed" || input.reconciledStatus === "failed") {
    return { taskStatus: "failed", runOutcome: "failed", reason: "pipeline_failed" };
  }
  if (input.repeated) {
    return { taskStatus: "paused", runOutcome: "degraded", reason: "repetition_detected" };
  }
  if (input.pipelineOutcome === "partial") {
    return { taskStatus: "paused", runOutcome: "partial", reason: "pipeline_partial" };
  }
  if (input.pipelineOutcome === "degraded") {
    return { taskStatus: "paused", runOutcome: "degraded", reason: "pipeline_degraded" };
  }
  if (input.reconciledStatus !== "completed") {
    return { taskStatus: input.reconciledStatus, runOutcome: "partial", reason: "task_plan_open" };
  }
  if (input.writeIntent && input.checkResult?.passed === false) {
    return { taskStatus: "paused", runOutcome: "partial", reason: "verification_failed" };
  }
  if (input.writeIntent && !isAuthoritativelyGreen(input.checkResult)) {
    return { taskStatus: "paused", runOutcome: "partial", reason: "write_unverified" };
  }
  if (input.writeIntent) {
    return { taskStatus: "completed", runOutcome: "success", reason: "verified_complete" };
  }
  return {
    taskStatus: "completed",
    runOutcome: input.pipelineOutcome === "degraded" ? "degraded" : "success",
    reason: "non_write_complete",
  };
}
```

- [ ] **Step 4: Replace the split outcome logic in `index.ts`**

After `reconcileTaskRunStatus`, call `decideCompletion` once. Persist `decision.taskStatus` and use `decision.runOutcome` as the reward boundary input. Remove the independent nested ternary that currently computes `runOutcome` without consulting `reconciledStatus`. Include `completion_reason` in the structured pipeline outcome record so replay can explain why a run paused.

- [ ] **Step 5: Pin the incomplete-language backstop**

Add table tests to `task-run.test.ts` for:

```ts
for (const answer of [
  "Group A has not yet been completed.",
  "The implementation is not yet complete.",
  "A1, A3, and A4 have not yet been started.",
]) {
  test(`incomplete answer pauses: ${answer}`, () => {
    expect(assessTaskRunAcceptance({
      requirement: "full_execution",
      depth: "standard",
      pipelineOutcome: "success",
      answer,
      evidenceCount: 3,
    }).status).toBe("paused");
  });
}
```

Extend the regex only as a backstop; do not use prose matching as the primary completion authority.

- [ ] **Step 6: Run focused and adjacent tests**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/completion-policy.test.ts src/orchestration/task-run.test.ts src/orchestration/verification-reward.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add server-jarvis/src/orchestration/completion-policy.ts server-jarvis/src/orchestration/completion-policy.test.ts server-jarvis/src/orchestration/task-run.test.ts server-jarvis/src/index.ts
git commit -m "fix(orchestrator): fail closed on incomplete write tasks"
```

---

### Task 2: Require Grounded Evidence for Every TaskPlan Verification

**Files:**
- Create: `server-jarvis/src/orchestration/task-plan-evidence.ts`
- Create: `server-jarvis/src/orchestration/task-plan-evidence.test.ts`
- Modify: `server-jarvis/src/orchestration/task-run.ts:29-64,162-166,628-651`
- Modify: `server-jarvis/src/orchestration/runtime-loop.ts:567-579,755-764`
- Modify: `server-jarvis/src/orchestration/conductor-bus.ts:29-41`
- Modify: `server-jarvis/src/orchestration/conductor.ts:350-410`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:1003-1023,4418-4441`
- Test: `server-jarvis/src/orchestration/runtime-loop.test.ts`
- Test: `server-jarvis/src/orchestration/conductor.test.ts`
- Test: `server-jarvis/src/orchestration/pipeline-plan-wiring.test.ts`

**Interfaces:**
- Consumes: `TaskPlanItem.acceptanceChecks`, `ToolCallRecord[]`, `CheckResult`, reviewer verdict, and write intent.
- Produces: `TaskPlanEvidenceGrounding`, `buildTaskPlanGrounding`, and `evaluateTaskPlanAcceptance`.

- [ ] **Step 1: Write failing evidence-policy tests**

Cover all supported acceptance kinds and the exact false reviewer acceptance:

```ts
import { describe, expect, test } from "bun:test";
import { buildTaskPlanGrounding, evaluateTaskPlanAcceptance } from "./task-plan-evidence";

const item = (kind: string) => ({
  id: "pi_a1",
  title: "Implement A1",
  dependsOn: [],
  acceptanceChecks: [{ id: "ac_a1", description: "A1 done", kind }],
  status: "active" as const,
  repairCycleCount: 0,
});

describe("evaluateTaskPlanAcceptance", () => {
  test("reviewer intent without a write does not verify a write item", () => {
    const grounding = buildTaskPlanGrounding({
      writeIntent: true,
      reviewerAccepted: true,
      toolCalls: [{ name: "read_file", arguments: { path: "PLAN.md" }, output: "A1", is_error: false, duration_ms: 1 }],
    });
    expect(evaluateTaskPlanAcceptance(item("reviewer_pass"), grounding)).toEqual({
      accepted: false,
      unmet: ["ac_a1:write_evidence_required"],
    });
  });

  test("diff_match requires a successful mutation", () => {
    const grounding = buildTaskPlanGrounding({
      writeIntent: true,
      reviewerAccepted: false,
      toolCalls: [{ name: "edit_file", arguments: { path: "a.cpp" }, output: "ok", is_error: false, duration_ms: 2 }],
    });
    expect(evaluateTaskPlanAcceptance(item("diff_match"), grounding).accepted).toBe(true);
  });

  test("test_pass requires a real passing check", () => {
    const grounding = buildTaskPlanGrounding({
      writeIntent: true,
      reviewerAccepted: true,
      toolCalls: [{ name: "write_file", arguments: { path: "a.cpp" }, output: "ok", is_error: false, duration_ms: 2 }],
      checkResult: { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs: 0 },
    });
    expect(evaluateTaskPlanAcceptance(item("test_pass"), grounding).accepted).toBe(false);
  });

  test("manual checks cannot be autonomously verified", () => {
    const grounding = buildTaskPlanGrounding({ writeIntent: false, reviewerAccepted: true, toolCalls: [] });
    expect(evaluateTaskPlanAcceptance(item("manual"), grounding).unmet).toEqual(["ac_a1:manual_check_required"]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/task-plan-evidence.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement durable grounding**

Define the persisted shape without importing runtime classes:

```ts
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
```

- [ ] **Step 4: Persist grounding and enforce it at the ledger boundary**

Add `grounding?: TaskPlanEvidenceGrounding` to `TaskPlanEvidencePointer`. In `markPlanItemVerified`, call `evaluateTaskPlanAcceptance` for the target item before changing its status. Throw `plan_item_acceptance_unmet:<comma-separated reasons>` if the verdict is red. Persist the grounding beside `ref`, `summary`, and `recordedAt` when green.

- [ ] **Step 5: Carry grounding through Conductor directives**

Extend only the `mark_verified` variant:

```ts
| {
    type: "mark_verified";
    itemId: string;
    evidenceRef: string;
    evidenceSummary?: string;
    grounding: TaskPlanEvidenceGrounding;
    gradingMode: "conductor_direct_diff" | "reviewer_mediated" | "runtime_check";
    reason: string;
  }
```

Build grounding from the exact `toolCalls`, `writeIntent`, workspace-evidence requirement, `checkResult`, and reviewer verdict already available to `LiveConductor.afterStage`. Pass it through `applySufficientVerdict` and `applyReviewerAccept`.

- [ ] **Step 6: Fail reviewer acceptance closed in `pipeline.ts`**

Before line 4428 marks the active item, evaluate the accumulated executor tool calls and `lastCheckResult`. If unmet checks remain, leave the item active, set the segment to partial with `errorCode: "plan_item_acceptance_unmet"`, and enqueue a repair only when the remaining repair budget permits it. Never catch the evidence rejection and continue to a success-producing synthesizer.

- [ ] **Step 7: Update existing tests that currently pin ungrounded acceptance**

Change reviewer-accept fixtures to include a successful write and, when the item uses `test_pass`, a real passing `CheckResult`. Add a negative pipeline test whose reviewer says `ACCEPT` while the only executor tool was `read_file`; assert the item remains active and the segment is partial.

- [ ] **Step 8: Run focused tests**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/task-plan-evidence.test.ts src/orchestration/task-run.test.ts src/orchestration/runtime-loop.test.ts src/orchestration/conductor.test.ts src/orchestration/pipeline-plan-wiring.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit**

```powershell
git add server-jarvis/src/orchestration/task-plan-evidence.ts server-jarvis/src/orchestration/task-plan-evidence.test.ts server-jarvis/src/orchestration/task-run.ts server-jarvis/src/orchestration/runtime-loop.ts server-jarvis/src/orchestration/conductor-bus.ts server-jarvis/src/orchestration/conductor.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/task-run.test.ts server-jarvis/src/orchestration/runtime-loop.test.ts server-jarvis/src/orchestration/conductor.test.ts server-jarvis/src/orchestration/pipeline-plan-wiring.test.ts
git commit -m "fix(task-plan): require grounded acceptance evidence"
```

---

### Task 3: Expand Broad Plan Items from Explicit Workspace Plans

**Files:**
- Create: `server-jarvis/src/orchestration/task-plan-discovery.ts`
- Create: `server-jarvis/src/orchestration/task-plan-discovery.test.ts`
- Modify: `server-jarvis/src/orchestration/task-run.ts:540-651`
- Modify: `server-jarvis/src/orchestration/runtime-loop.ts:216-315,444-472`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:1970-2018,2572-2635`
- Test: `server-jarvis/src/orchestration/pipeline-plan-wiring.test.ts`

**Interfaces:**
- Consumes: successful `read_file` results from explicitly plan-like files and the active TaskPlan item.
- Produces: `discoverPlanItems(input): DiscoveredPlanItem[]` and `expandActivePlanItem(contract, activeItemId, discovered): TaskRunContract`.

- [ ] **Step 1: Write failing plan-discovery tests**

Use a compact Group A fixture and a progress-preservation fixture:

```ts
import { describe, expect, test } from "bun:test";
import { discoverPlanItems } from "./task-plan-discovery";

const markdown = `
# Execution Plan
## Group A
### A1 — Add the bypass invariant
- [ ] Implement the invariant
### A2 — Replace volatility depth
- [ ] Update the calculation
### A3 — Add regression coverage
- [ ] Run the focused suite
### A4 — Verify the full group
- [ ] Build and smoke
## Group B
### B1 — Later work
`;

describe("discoverPlanItems", () => {
  test("extracts only the requested numbered group", () => {
    expect(discoverPlanItems({ path: "GROUP_A_EXECUTION.md", content: markdown, requestedGroup: "A" })
      .map((item) => item.externalKey)).toEqual(["A1", "A2", "A3", "A4"]);
  });

  test("ignores ordinary source files", () => {
    expect(discoverPlanItems({ path: "PluginProcessor.cpp", content: markdown, requestedGroup: "A" })).toEqual([]);
  });
});
```

Add a `task-run.test.ts` case that starts with verified inspection items plus one active broad item, expands that active item to A1–A4, and asserts verified predecessors remain verified.

- [ ] **Step 2: Run tests and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/task-plan-discovery.test.ts src/orchestration/task-run.test.ts
```

Expected: FAIL because discovery and expansion do not exist.

- [ ] **Step 3: Implement guarded Markdown discovery**

Accept only basenames matching `plan`, `execution`, `checklist`, `roadmap`, or `tasks` with `.md`/`.txt`. Parse headings matching `A1`, `A2`, and equivalent alphanumeric keys. Stop at the next top-level group. Give each discovered code-work item these checks:

```ts
acceptanceChecks: [
  { id: `ac_${externalKey.toLowerCase()}_diff`, description: `${externalKey} produced a verified workspace mutation`, kind: "diff_match" },
  { id: `ac_${externalKey.toLowerCase()}_check`, description: `${externalKey} passed an authoritative runtime/build check`, kind: "test_pass" },
]
```

Deduplicate by normalized `externalKey`; do not infer tasks from prose paragraphs.

- [ ] **Step 4: Implement safe active-item expansion**

Add a pure `expandActivePlanItem` mutation that:

1. Requires the target item to be `active`.
2. Requires at least two discovered children.
3. Replaces only that active item at the same list position.
4. Gives the first child the parent's dependencies and chains later children in order.
5. Redirects downstream dependencies from the parent ID to the final child ID.
6. Activates the first child.
7. Preserves every verified/blocked sibling and its evidence.
8. Stores the source path in each child description so the ledger can explain where decomposition came from.

- [ ] **Step 5: Tighten planner validation**

In `conductorValidatePlanItems`, reject a single broad item matching `execute|complete|implement` plus `tasks|group|plan` when the brief names a workspace plan. Preserve the ledger until plan-file evidence arrives; do not mark the broad item verified.

- [ ] **Step 6: Wire discovery to native and delegated reads**

After each successful `read_file`, call discovery with the requested group parsed from `rawMessage`. When children are found, update `opts.taskRunContract`, call `onTaskPlanUpdate`, and refresh `LiveConductor` plan context. Apply the same callback to delegate `onToolResult` so delegation and native execution use one TaskPlan.

- [ ] **Step 7: Add the integration regression**

In `pipeline-plan-wiring.test.ts`, simulate reading `GROUP_A_EXECUTION.md` and then writing only A2. Assert:

```ts
expect(contract.plan?.items.map((item) => [item.id, item.status])).toEqual([
  ["pi_a1", "active"],
  ["pi_a2", "pending"],
  ["pi_a3", "pending"],
  ["pi_a4", "pending"],
]);
expect(contract.status).toBe("active");
```

The exact point is that one A2 mutation cannot verify the broad Group A parent.

- [ ] **Step 8: Run focused tests and typecheck**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/task-plan-discovery.test.ts src/orchestration/task-run.test.ts src/orchestration/runtime-loop.test.ts src/orchestration/pipeline-plan-wiring.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit**

```powershell
git add server-jarvis/src/orchestration/task-plan-discovery.ts server-jarvis/src/orchestration/task-plan-discovery.test.ts server-jarvis/src/orchestration/task-run.ts server-jarvis/src/orchestration/runtime-loop.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/task-run.test.ts server-jarvis/src/orchestration/runtime-loop.test.ts server-jarvis/src/orchestration/pipeline-plan-wiring.test.ts
git commit -m "feat(task-plan): expand explicit workspace plans"
```

---

### Task 4: Let the Delegate Finish Normal Exploration and Repair Promotion

**Files:**
- Create: `server-jarvis/src/orchestration/delegate-intervention-policy.ts`
- Create: `server-jarvis/src/orchestration/delegate-intervention-policy.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:1566-1577,1763-1782,1785-2115`
- Modify: `server-jarvis/src/orchestration/delegate-model-select.ts:84-103`
- Modify: `server-jarvis/src/orchestration/delegate-model-select.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline-delegate.test.ts:1120-1242`
- Modify: `server-jarvis/src/config.ts`
- Modify: `server-jarvis/src/config-regression.test.ts`

**Interfaces:**
- Consumes: `LoopIntervention`, elapsed delegate time, stage budget, successful reads/writes, failed writes, and policy-denied calls.
- Produces: `decideDelegateIntervention(input): "observe" | "defer" | "handoff" | "abort"` and session-scoped expiring delegate thrash.

- [ ] **Step 1: Write failing intervention-policy tests**

```ts
import { describe, expect, test } from "bun:test";
import { decideDelegateIntervention } from "./delegate-intervention-policy";

const base = {
  intervention: { kind: "force_write", note: "write now", decisionSource: "deterministic_reflex" } as const,
  successfulReads: 2,
  successfulWrites: 0,
  failedWrites: 0,
  policyDenied: false,
  elapsedMs: 20_000,
  stageRemainingMs: 100_000,
  explorationLimitMs: 45_000,
  nativeFallbackReserveMs: 30_000,
};

describe("decideDelegateIntervention", () => {
  test("defers write pressure during productive exploration", () => {
    expect(decideDelegateIntervention(base)).toBe("defer");
  });

  test("hands off after the exploration limit", () => {
    expect(decideDelegateIntervention({ ...base, elapsedMs: 45_001 })).toBe("handoff");
  });

  test("hands off after a policy denial", () => {
    expect(decideDelegateIntervention({ ...base, policyDenied: true })).toBe("handoff");
  });

  test("never discards a verified write", () => {
    expect(decideDelegateIntervention({ ...base, successfulWrites: 1 })).toBe("observe");
  });

  test("explicit abort remains terminal", () => {
    expect(decideDelegateIntervention({ ...base, intervention: { kind: "abort", reason: "user stop", decisionSource: "deterministic_reflex" } })).toBe("abort");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/delegate-intervention-policy.test.ts
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement the deterministic delegate policy**

Use this order: explicit abort, verified write, policy denial/repeated failed writes, nearly exhausted native-fallback reserve, exploration deadline, then defer. A deferred directive is still persisted as `mid_loop_*`, plus a `delegate_intervention_deferred` directive whose reason records reads and elapsed time; it does not abort the CLI process.

- [ ] **Step 4: Add bounded configuration**

Add and validate:

```ts
claude_cli.delegate.exploration_limit_ms = 45_000;
claude_cli.delegate.native_fallback_reserve_ms = 30_000;
claude_cli.delegate.thrash_ttl_ms = 30 * 60_000;
```

Keep the existing total delegate timeout as the outer safety limit.

- [ ] **Step 5: Replace unconditional mid-loop handoff**

At `pipeline.ts:1995`, call the policy. Only `handoff` sets `midLoopStop` and aborts. `defer` lets the delegate continue with its original write-contract prompt. `observe` records the directive after a verified write without altering process state. `abort` preserves current terminal cancellation behavior.

- [ ] **Step 6: Make thrash survive agent-run boundaries**

Replace numeric map entries with expiring state:

```ts
interface DelegateThrashState { count: number; updatedAt: number }
const thrashByKey = new Map<string, DelegateThrashState>();

export function delegateThrashKey(sessionId: string): string {
  return sessionId.trim() || "unknown-session";
}
```

Use `delegateThrashKey(this.ctx.session_id)` in `pipeline.ts`, expire entries after `thrash_ttl_ms`, increment on verified no-write/handoff, and clear after a verified delegate write. Keep one process per logical run.

- [ ] **Step 7: Reverse the old handoff regression**

Update `pipeline-delegate.test.ts` so a fake delegate emits two reads, receives `force_write`, continues, emits a verified `write_file`, and completes with `nativeCalls === 0`. Keep separate tests proving deadline/policy-denial handoff and explicit-abort terminal behavior.

- [ ] **Step 8: Run focused tests**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/delegate-intervention-policy.test.ts src/orchestration/delegate-model-select.test.ts src/orchestration/pipeline-delegate.test.ts src/config-regression.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit**

```powershell
git add server-jarvis/src/orchestration/delegate-intervention-policy.ts server-jarvis/src/orchestration/delegate-intervention-policy.test.ts server-jarvis/src/orchestration/delegate-model-select.ts server-jarvis/src/orchestration/delegate-model-select.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/pipeline-delegate.test.ts server-jarvis/src/config.ts server-jarvis/src/config-regression.test.ts
git commit -m "fix(delegate): preserve productive exploration and promotion"
```

---

### Task 5: Persist Delegate Diagnostics and Make Replay Delegate-Specific

**Files:**
- Modify: `server-jarvis/src/orchestration/claude-delegate.ts:483-518`
- Modify: `server-jarvis/src/orchestration/claude-delegate.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:2085-2135`
- Modify: `server-jarvis/src/self-tuning/store.ts:36-60,293-308,519-527,589-610`
- Modify: `server-jarvis/src/self-tuning/collector.ts`
- Modify: `server-jarvis/src/self-tuning/self-tuning.test.ts`
- Modify: `server-jarvis/src/eval/conductor-replay.ts:35-50,102-120,269-286`
- Modify: `server-jarvis/src/eval/conductor-replay.test.ts:230-299`
- Modify: `server-jarvis/scripts/replay-conductor.ts:36-59`
- Modify: `scripts/claude_cli_proxy.py`
- Create: `scripts/test_claude_cli_proxy_correlation.py`

**Interfaces:**
- Consumes: delegate process stderr, exit code, launch auth mode/base URL, generated request ID, delegate stage row, and final run verification fields.
- Produces: bounded `diagnostic_json`, correlated proxy logs, and replay rules that cannot be hidden by later native writes.

- [ ] **Step 1: Write failing delegate diagnostic tests**

Add a process-factory test that emits more than 4 KiB on stderr and assert diagnostics retain only the sanitized tail. Include strings resembling `Authorization: Bearer secret-value` and assert neither the header nor value survives.

Add a store round-trip test:

```ts
store.recordStageRun({
  id: "stage-diagnostic",
  agent_run_id: "run-diagnostic",
  mode_id: "executor",
  turn_number: 1,
  was_successful: 0,
  had_error: 1,
  diagnostic_json: JSON.stringify({ delegate_request_id: "req-123", exit_code: 1, stderr_tail: "proxy refused" }),
});
expect(JSON.parse(store.getStageRuns("run-diagnostic")[0]!.diagnostic_json!)).toMatchObject({
  delegate_request_id: "req-123",
  exit_code: 1,
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/claude-delegate.test.ts src/self-tuning/self-tuning.test.ts
```

Expected: FAIL because diagnostics are not exposed or persisted.

- [ ] **Step 3: Capture bounded, sanitized diagnostics**

Replace `child.stderr?.resume()` with a draining listener that retains the newest 4,096 UTF-8 characters. Sanitize case-insensitive `authorization`, `api-key`, `x-api-key`, `token`, and `Bearer` values before returning the tail. Extend `DelegateProcess` with `diagnostics(): { stderrTail: string; exitCode?: number }` and copy it into the delegate result.

Generate `delegateRequestId = crypto.randomUUID()` at launch, pass it as `JARVIS_DELEGATE_REQUEST_ID`, and persist only:

```ts
{
  delegate_request_id: delegateRequestId,
  auth_mode: launch.authMode,
  base_url: launch.baseUrl,
  exit_code: delegated.diagnostics?.exitCode,
  stderr_tail: delegated.diagnostics?.stderrTail,
}
```

- [ ] **Step 4: Add the guarded SQLite column**

Add nullable `diagnostic_json TEXT` to `stage_runs`, a guarded `ALTER TABLE`, the TypeScript interface, insert statement, and collector pass-through. Do not put diagnostics in `final_output` or user-visible SSE.

- [ ] **Step 5: Correlate proxy requests**

In `claude_cli_proxy.py`, read `JARVIS_DELEGATE_REQUEST_ID` once per process and include `delegate_request_id=<id-or-missing>` in request start, upstream result, and error log records. The Python test must patch the environment and assert the correlation field appears while a fake authorization header does not.

- [ ] **Step 6: Replace the false-green replay rule**

Keep the existing turn-level `delegate_never_wrote` rule for total failure and add:

```ts
| "delegate_failed_before_fallback"
| "success_without_runtime_check"
| "success_declares_incomplete";
```

For `delegate_failed_before_fallback`, identify each delegate stage row by `delegate_cleanup` in that row and look for a successful write in the same row only. A native write in a later row must not suppress the violation.

Extend `ReplayRun` and the loader query with `finalOutput`, `verifiedVia`, and `checkTier`. Flag a successful write-intent run when `checkTier` is null/`none`, and flag successful final output matching the incomplete phrases pinned in Task 1.

- [ ] **Step 7: Update replay tests**

Change the old “does not flag when a write landed later in the run” expectation: it must produce `delegate_failed_before_fallback` while not producing the total-failure `delegate_never_wrote`. Add green fixtures for an actual write inside the delegate row and for a success with `check_tier=builtin`.

- [ ] **Step 8: Run focused tests and replay**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/claude-delegate.test.ts src/self-tuning/self-tuning.test.ts src/eval/conductor-replay.test.ts
python ..\scripts\test_claude_cli_proxy_correlation.py
bun scripts/replay-conductor.ts --since 2026-08-01T10:00:00Z --json
bun run typecheck
```

Expected: tests pass; historical replay now truthfully flags all six delegate fallbacks and unverified successes.

- [ ] **Step 9: Commit**

```powershell
git add server-jarvis/src/orchestration/claude-delegate.ts server-jarvis/src/orchestration/claude-delegate.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/self-tuning/store.ts server-jarvis/src/self-tuning/collector.ts server-jarvis/src/self-tuning/self-tuning.test.ts server-jarvis/src/eval/conductor-replay.ts server-jarvis/src/eval/conductor-replay.test.ts server-jarvis/scripts/replay-conductor.ts scripts/claude_cli_proxy.py scripts/test_claude_cli_proxy_correlation.py
git commit -m "feat(telemetry): expose delegate failures to replay"
```

---

### Task 6: Bound No-Tool Executor Turns and Deduplicate Write Pressure

**Files:**
- Create: `server-jarvis/src/orchestration/executor-progress-policy.ts`
- Create: `server-jarvis/src/orchestration/executor-progress-policy.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:2529-2910`
- Modify: `server-jarvis/src/orchestration/effect-gate.ts`
- Modify: `server-jarvis/src/orchestration/mid-loop-intervention.ts`
- Test: `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`
- Test: `server-jarvis/src/orchestration/pipeline-telemetry.test.ts`
- Test: `server-jarvis/src/orchestration/pipeline-context.test.ts`

**Interfaces:**
- Consumes: write intent, current-turn tool calls, successful writes, consecutive no-tool count, last model key, stage budget, and semantic pressure history.
- Produces: `decideExecutorProgress`, `SemanticPressureBudget`, one bounded model escalation, and typed `executor_no_tool` partial telemetry.

- [ ] **Step 1: Write failing progress-policy tests**

```ts
import { describe, expect, test } from "bun:test";
import { decideExecutorProgress, SemanticPressureBudget } from "./executor-progress-policy";

describe("decideExecutorProgress", () => {
  test("first no-tool write turn retries once with a different strong model", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: false,
      successfulWrites: 0,
      consecutiveNoToolTurns: 1,
      stageRemainingMs: 60_000,
    })).toBe("retry_strong");
  });

  test("second no-tool write turn ends partial", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: false,
      successfulWrites: 0,
      consecutiveNoToolTurns: 2,
      stageRemainingMs: 45_000,
    })).toBe("stop_partial");
  });

  test("read/write progress resets the no-tool streak", () => {
    expect(decideExecutorProgress({
      writeIntent: true,
      emittedToolCalls: true,
      successfulWrites: 1,
      consecutiveNoToolTurns: 0,
      stageRemainingMs: 45_000,
    })).toBe("continue");
  });
});

test("semantic pressure is claimed once per logical run", () => {
  const budget = new SemanticPressureBudget();
  expect(budget.claim("write_effect")).toBe(true);
  expect(budget.claim("write_effect")).toBe(false);
  expect(budget.claim("quality_after_correctness")).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/executor-progress-policy.test.ts
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement the policy**

The first no-tool write turn may retry only if more than 20 seconds remain. It excludes `lastModelKey`, sets `preferStrongModel=true`, and emits one `write_effect` pressure note. The second consecutive no-tool turn stops with partial `executor_no_tool`. Any real tool call resets the streak. Read-only stages may still end normally with prose.

- [ ] **Step 4: Share one semantic pressure budget across reroutes**

Support these keys:

```ts
export type SemanticPressure =
  | "workspace_evidence"
  | "write_effect"
  | "plan_remainder"
  | "quality_after_correctness";
```

Create the budget once per `agentRunId` and pass it through segment/replan options. Both the pre-mid-loop effect gate and resident mid-loop path must call `claim("write_effect")`; only the first caller injects text. Record suppressed duplicates as `directive_type="semantic_pressure_suppressed"` without another note.

- [ ] **Step 5: Persist typed no-tool telemetry**

For no-tool write turns, set `was_successful=0`, `had_error=1`, `stop_reason="no_tool"`, and `partial_error_code="executor_no_tool"`. Preserve output-token and first-token attribution so model selection can learn from it.

- [ ] **Step 6: Add pipeline regressions**

Use a model fake that returns prose without tools three times. Assert only two calls occur, the second excludes the first model, only one semantic write-pressure note is added, and the executor returns partial. Add a successful-write fixture proving the policy does not add a needless retry.

- [ ] **Step 7: Run focused tests**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/executor-progress-policy.test.ts src/orchestration/mid-loop-intervention.test.ts src/orchestration/pipeline-telemetry.test.ts src/orchestration/pipeline-context.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add server-jarvis/src/orchestration/executor-progress-policy.ts server-jarvis/src/orchestration/executor-progress-policy.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/effect-gate.ts server-jarvis/src/orchestration/mid-loop-intervention.ts server-jarvis/src/orchestration/mid-loop-intervention.test.ts server-jarvis/src/orchestration/pipeline-telemetry.test.ts server-jarvis/src/orchestration/pipeline-context.test.ts
git commit -m "perf(executor): bound no-tool retries and write pressure"
```

---

### Task 7: Compact Completed Executor Cycles and Fast-Path Active Plans

**Files:**
- Modify: `server-jarvis/src/orchestration/context-budget.ts:34-74`
- Modify: `server-jarvis/src/orchestration/context-budget.test.ts:52-102`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:2537-2569`
- Create: `server-jarvis/src/orchestration/active-plan-route.ts`
- Create: `server-jarvis/src/orchestration/active-plan-route.test.ts`
- Modify: `server-jarvis/src/index.ts:2810-3004`
- Test: `server-jarvis/src/orchestration/pipeline-context.test.ts`

**Interfaces:**
- Consumes: executor transcript, accumulated tool records, active TaskPlan item, explicit continuation signal, and acceptance-check kinds.
- Produces: `compactCompletedExecutorCycles` and `activePlanContinuationPipeline`.

- [ ] **Step 1: Write failing transcript-compaction tests**

Add a transcript containing three completed assistant/tool cycles, duplicate write-pressure user messages, and one current tool-call pair. Assert compaction:

- keeps system and original user request;
- replaces old completed read cycles with one `[Evidence checkpoint]` message listing paths;
- removes superseded assistant prose and duplicate pressure messages;
- keeps the newest assistant plus matching tool results unchanged;
- remains below the requested token budget.

The expected checkpoint must be concrete:

```ts
expect(messages.some((message) => message.content ===
  "[Evidence checkpoint]\nreads: src/a.cpp, src/b.cpp\nwrites: src/a.cpp\nfailed: none"
)).toBe(true);
```

- [ ] **Step 2: Run context tests and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/context-budget.test.ts
```

Expected: FAIL because cycle compaction does not exist.

- [ ] **Step 3: Implement completed-cycle compaction**

Add:

```ts
export function compactCompletedExecutorCycles(
  messages: TranscriptMessage[],
  toolCalls: readonly ToolCallRecord[],
  budgetTokens: number,
): { compactedCycles: number; inputTokens: number };
```

Compact whole assistant/tool cycles only; never separate a retained `tool` message from its assistant `tool_calls`. Keep the newest two assistant cycles. Derive the checkpoint from clean tool records and cap it at 2,000 characters. Run existing payload eviction afterward as the final size fence.

- [ ] **Step 4: Wire compaction before every executor model call**

Replace the direct `enforceTranscriptBudget` call with cycle compaction followed by the existing enforcement. Emit `detail="context_compacted:<count>"` when cycles are removed. Continue recording exact input token counts after compaction.

- [ ] **Step 5: Write failing active-plan-route tests**

```ts
import { expect, test } from "bun:test";
import { activePlanContinuationPipeline } from "./active-plan-route";

test("explicit continuation of an open reviewer item skips coordinator and planner", () => {
  expect(activePlanContinuationPipeline({
    explicitContinuation: true,
    status: "active",
    turnCount: 2,
    activeItem: { acceptanceChecks: [{ id: "ac", description: "review", kind: "reviewer_pass" }] },
  })).toEqual(["executor", "reviewer", "synthesizer"]);
});

test("runtime-check item needs only executor and synthesizer", () => {
  expect(activePlanContinuationPipeline({
    explicitContinuation: true,
    status: "paused",
    turnCount: 3,
    activeItem: { acceptanceChecks: [{ id: "ac", description: "test", kind: "test_pass" }] },
  })).toEqual(["executor", "synthesizer"]);
});
```

- [ ] **Step 6: Implement and wire the active-plan fast path**

Before calling the Coordinator, detect an explicit continuation with an active/paused TaskRun and active item. Build a deterministic route using the returned pipeline. Preserve reviewer only when an acceptance check requires `reviewer_pass`; never rerun Planner for an already-expanded plan. Record `route_source="active_plan_continuation"`.

- [ ] **Step 7: Run focused tests and typecheck**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/context-budget.test.ts src/orchestration/pipeline-context.test.ts src/orchestration/active-plan-route.test.ts src/orchestration/route-normalization.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add server-jarvis/src/orchestration/context-budget.ts server-jarvis/src/orchestration/context-budget.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/active-plan-route.ts server-jarvis/src/orchestration/active-plan-route.test.ts server-jarvis/src/orchestration/pipeline-context.test.ts server-jarvis/src/index.ts
git commit -m "perf(orchestrator): compact executor context and resume active plans"
```

---

### Task 8: Prepare Authoritative CMake Verification Outside Model Loops

**Files:**
- Create: `server-jarvis/src/orchestration/verification-workspace.ts`
- Create: `server-jarvis/src/orchestration/verification-workspace.test.ts`
- Modify: `server-jarvis/src/orchestration/build-check.ts:45-90`
- Modify: `server-jarvis/src/orchestration/build-check.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:809-866`
- Modify: `server-jarvis/src/config.ts`
- Modify: `server-jarvis/src/config-regression.test.ts`

**Interfaces:**
- Consumes: workspace root, project markers, verification configuration, timeout, and an injectable command runner.
- Produces: `ensureVerificationWorkspace(input): Promise<VerificationWorkspaceResult>` and a reusable CMake build directory under Jarvis state, never the user's source tree.

- [ ] **Step 1: Write failing verification-workspace tests**

Use an injectable filesystem and command runner to prove:

1. Non-CMake workspaces return `not_applicable` without spawning.
2. Existing workspace `build/CMakeCache.txt` returns `ready` without configuring.
3. Unconfigured CMake uses `<stateRoot>/build-cache/<sha256(root)>` and runs exactly `cmake -S <root> -B <cacheDir>`.
4. A second call reuses the cache.
5. Configure timeout/failure returns `unavailable` with bounded diagnostics.

The central assertion:

```ts
expect(calls).toEqual([{
  command: "cmake",
  args: ["-S", "C:\\work\\Perihelion", "-B", expectedCache],
  cwd: "C:\\work\\Perihelion",
  timeoutMs: 120_000,
}]);
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/verification-workspace.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement bounded workspace preparation**

Default state root to `~/.openclaw/jarvis/build-cache`. Hash the normalized absolute workspace root. Use the current workspace build directory first; only create the Jarvis cache when CMake exists and no configured build is available. Return:

```ts
export type VerificationWorkspaceResult =
  | { kind: "ready"; buildDir: string; prepared: boolean; command: string }
  | { kind: "not_applicable" }
  | { kind: "unavailable"; detail: string; command: string };
```

Keep this deterministic operation outside every model callback.

- [ ] **Step 4: Add opt-in configuration with safe defaults**

Add:

```ts
orchestrator.verification.prepare_cmake = true;
orchestrator.verification.prepare_timeout_ms = 120_000;
orchestrator.verification.check_timeout_ms = 90_000;
```

Honor explicit user overrides. Add regression tests for parsing, defaults, and secret-safe serialization.

- [ ] **Step 5: Feed the prepared directory into build checking**

Extend `runBuildCheck` input with `configuredBuildDirs?: string[]`. CMake detection checks those paths after normal workspace candidates. In `runVerificationCheckCore`, prepare once per workspace per process, cache the result, and pass a ready directory to the build check. If preparation is unavailable, return honest `tier=none`; Task 1 will keep the run partial.

- [ ] **Step 6: Run focused verification tests**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/verification-workspace.test.ts src/orchestration/build-check.test.ts src/orchestration/check-runner.test.ts src/config-regression.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add server-jarvis/src/orchestration/verification-workspace.ts server-jarvis/src/orchestration/verification-workspace.test.ts server-jarvis/src/orchestration/build-check.ts server-jarvis/src/orchestration/build-check.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/config.ts server-jarvis/src/config-regression.test.ts
git commit -m "feat(verification): prepare reusable CMake checks"
```

---

### Task 9: Add Performance Gates and a Multi-Item Runtime Smoke

**Files:**
- Create: `server-jarvis/src/eval/conductor-performance.ts`
- Create: `server-jarvis/src/eval/conductor-performance.test.ts`
- Create: `server-jarvis/scripts/benchmark-conductor-completion.ts`
- Modify: `scripts/smoke-jarvis-runtime.ps1`
- Modify: `docs/sse-stream-contract.md`
- Create: `docs/conductor-completion-contract.md`

**Interfaces:**
- Consumes: `AgentRun[]`, `StageRun[]`, model attributions, conductor directives, and replay violations from a bounded post-deploy window.
- Produces: `summarizeConductorPerformance`, a JSON benchmark CLI, and `-CompletionIntegritySmoke`.

- [ ] **Step 1: Write failing performance-summary tests**

Build fixtures for ten write runs and assert exact metrics:

```ts
expect(summarizeConductorPerformance(fixtures)).toMatchObject({
  runs: 10,
  executorNoToolRatio: 0.1,
  delegateVerifiedWriteRate: 0.8,
  unverifiedSuccesses: 0,
  falseCompleteRuns: 0,
  duplicateWritePressureRuns: 0,
});
```

Also assert `meetsReleaseGate` is false at 20% no-tool turns, 79% delegate writes, one unverified success, or one false-complete run.

- [ ] **Step 2: Run the focused test and verify failure**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/eval/conductor-performance.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure metrics module and CLI**

Expose:

```ts
export interface ConductorPerformanceThresholds {
  maxExecutorNoToolRatio: number;
  minDelegateVerifiedWriteRate: number;
  maxUnverifiedSuccesses: number;
  maxFalseCompleteRuns: number;
  maxDuplicateWritePressureRuns: number;
}

export const RELEASE_THRESHOLDS: ConductorPerformanceThresholds = {
  maxExecutorNoToolRatio: 0.10,
  minDelegateVerifiedWriteRate: 0.80,
  maxUnverifiedSuccesses: 0,
  maxFalseCompleteRuns: 0,
  maxDuplicateWritePressureRuns: 0,
};
```

The CLI accepts `--db`, `--since`, `--limit`, and `--json`, opens SQLite read-only, and prints metrics. It always exits 1 for a failed no-tool, unverified-success, false-complete, or duplicate-pressure threshold. Apply the delegate-rate threshold once at least five delegate fixtures exist; below five, report `delegate_gate="insufficient_sample"` without claiming delegate success.

- [ ] **Step 4: Add `-CompletionIntegritySmoke`**

The smoke creates a temporary workspace with `GROUP_A_EXECUTION.md` containing four deterministic file tasks. It sends one request to execute Group A, follows with `continue` in the same session until terminal completion or four turns, and verifies:

- all four expected files exist with exact contents;
- terminal success appears only after the fourth artifact;
- an intermediate turn is partial/paused rather than success;
- `/health` SHA still matches the deployed manifest;
- post-smoke replay reports no completion/delegate/write-pressure invariant for the smoke session.

Use a temporary directory under `%TEMP%`, validate its resolved path before cleanup, and remove only that exact smoke directory in `finally`.

- [ ] **Step 5: Document the completion contract**

`docs/conductor-completion-contract.md` must state:

1. TaskPlan ledger completion is authoritative over synthesizer prose.
2. Every autonomous plan verification needs structured grounding.
3. Write success needs a non-`none`, ran, passing check.
4. Delegate success requires delegate-row write evidence and ground-truth metadata.
5. Partial keeps the TaskRun resumable.
6. Replay and benchmark thresholds are release gates.

Update the SSE contract with `completion_reason` and the distinction between terminal transport completion and TaskRun completion.

- [ ] **Step 6: Run focused tests and a dry benchmark**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/eval/conductor-performance.test.ts src/eval/conductor-replay.test.ts
bun scripts/benchmark-conductor-completion.ts --since 2026-08-01T10:00:00Z --json
```

Expected: unit tests pass; the historical benchmark exits nonzero and reports the diagnosed baseline failures.

- [ ] **Step 7: Commit**

```powershell
git add server-jarvis/src/eval/conductor-performance.ts server-jarvis/src/eval/conductor-performance.test.ts server-jarvis/scripts/benchmark-conductor-completion.ts scripts/smoke-jarvis-runtime.ps1 docs/sse-stream-contract.md docs/conductor-completion-contract.md
git commit -m "test(orchestrator): gate completion integrity and performance"
```

---

### Task 10: Full Regression, Deployment, and Live Proof

**Files:**
- Modify only if a test exposes a defect: files already owned by Tasks 1–9.
- Runtime evidence: `C:\Users\ethan\.openclaw\jarvis\self-tuning.db`
- Runtime logs: deployed Bun server and Claude CLI proxy logs under the Desktop runtime resources.

**Interfaces:**
- Consumes: completed implementation commits, deployment script, health endpoints, runtime smokes, replay, and benchmark CLI.
- Produces: a provenance-matched deployed build and a bounded post-deploy evidence window.

- [ ] **Step 1: Run focused suites serially**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun test src/orchestration/completion-policy.test.ts src/orchestration/task-plan-evidence.test.ts src/orchestration/task-plan-discovery.test.ts
bun test src/orchestration/delegate-intervention-policy.test.ts src/orchestration/delegate-model-select.test.ts src/orchestration/pipeline-delegate.test.ts
bun test src/orchestration/executor-progress-policy.test.ts src/orchestration/context-budget.test.ts src/orchestration/active-plan-route.test.ts
bun test src/orchestration/verification-workspace.test.ts src/orchestration/build-check.test.ts src/orchestration/check-runner.test.ts
bun test src/eval/conductor-replay.test.ts src/eval/conductor-performance.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run the complete server gate**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun run typecheck
bun test
bun run build
```

Expected: exit 0 for all commands.

- [ ] **Step 3: Run repository build/deploy regressions**

```powershell
Set-Location C:\Projects\home-base-recovered
Invoke-Pester .\scripts\build-and-deploy.Tests.ps1
.\scripts\build-and-deploy.ps1 -RestartServer
```

Expected: deployment succeeds, manifest SHA matches the implementation commit, Bun serves the deployed Desktop `index.js`, and the proxy listener is healthy.

- [ ] **Step 4: Record the post-deploy cutoff**

```powershell
$cutoff = (Get-Date).ToUniversalTime().ToString('o')
$cutoff
```

Keep the emitted timestamp for every replay and benchmark command below.

- [ ] **Step 5: Run provenance and basic write/read smoke**

```powershell
Set-Location C:\Projects\home-base-recovered
.\scripts\smoke-jarvis-runtime.ps1 -WriteReadSmoke -WorkspaceRoot C:\Projects\home-base-recovered -TimeoutSeconds 240
```

Expected: manifest/health SHA match, one result terminal, exact artifact write/readback, and no fatal fallback.

- [ ] **Step 6: Run a real delegated write proof**

Run a write fixture in a disposable Git workspace with delegate-first enabled. Query `self-tuning.db` and require all of the following under one `agent_run_id`:

- model attribution provider is `claude_cli`;
- delegate stage row contains a successful write tool;
- `git_metadata` is present and successful;
- `diagnostic_json.delegate_request_id` appears in the proxy log;
- native executor fallback is absent;
- an authoritative check ran and passed.

Proxy `/health` alone does not satisfy this gate.

- [ ] **Step 7: Run the multi-item completion smoke**

```powershell
Set-Location C:\Projects\home-base-recovered
.\scripts\smoke-jarvis-runtime.ps1 -CompletionIntegritySmoke -TimeoutSeconds 600
```

Expected: all four child items complete, no intermediate false success, final success only after authoritative verification.

- [ ] **Step 8: Run post-deploy replay and performance gates**

```powershell
Set-Location C:\Projects\home-base-recovered\server-jarvis
bun scripts/replay-conductor.ts --since $cutoff --json
bun scripts/benchmark-conductor-completion.ts --since $cutoff --limit 100 --json
```

Expected: zero high-severity replay violations; no unverified or false-complete successes; no duplicate semantic pressure; executor no-tool ratio at most 10%. Run enough disposable delegated fixtures to reach a sample of ten and require at least eight verified delegate writes.

- [ ] **Step 9: Compare latency and tokens against baseline**

Require at least a 30% reduction in aggregate duration on the comparable six-run fixture, executor share below 60%, and no-tool time below 1.5 minutes. If completion integrity passes but a performance threshold misses, keep the correctness changes and open a narrowly scoped performance follow-up; do not relax completion gates.

- [ ] **Step 10: Verify source and deployed state**

```powershell
Set-Location C:\Projects\home-base-recovered
git status --short
git log -10 --oneline
Invoke-RestMethod http://127.0.0.1:19877/health
Invoke-RestMethod http://127.0.0.1:19878/health
```

Expected: clean intended worktree, expected commits, matching deployed SHA, and healthy listeners.

- [ ] **Step 11: Commit any test-discovered corrections, then rerun affected gates**

Use a commit message naming the actual corrected invariant. Do not create a generic cleanup commit, and do not mark the plan complete until every affected focused test and live proof has been rerun.

---

## Rollback Boundaries

- Tasks 1–3 are the completion-integrity floor and should remain even if later performance work is rolled back.
- Task 4 delegate deferral can be disabled with its configuration gate while retaining diagnostics and truthful replay.
- Task 6 no-tool escalation can be reverted independently without reverting TaskPlan or completion truth.
- Task 7 active-plan fast routing can fall back to the existing Coordinator route without changing persisted ledger semantics.
- Task 8 CMake preparation can be disabled; the system must then return `partial/write_unverified`, never success.
- Never roll back schema columns destructively. Older builds must tolerate nullable `diagnostic_json`.

## Self-Review

- **Spec coverage:** The plan covers false completion, broad-plan collapse, ungrounded reviewer acceptance, delegate mid-loop aborts, inert thrash promotion, absent stderr/proxy evidence, replay false-greens, no-tool latency, duplicate nudges, context growth, continuation ceremony, CMake `none`, performance measurement, deployment provenance, and live proof.
- **Subsystem boundary:** One umbrella plan is appropriate because completion policy consumes TaskPlan, delegate/native evidence, verification, and replay state. Each task still produces independently testable software and a rollback boundary.
- **Placeholder scan:** No deferred implementation markers are present. Every code-producing task names exact interfaces, tests, commands, expected failures, expected passes, and commit boundaries.
- **Type consistency:** `CompletionDecision`, `TaskPlanEvidenceGrounding`, `VerificationWorkspaceResult`, `SemanticPressure`, and replay/performance fields have one definition and are consumed by later tasks under the same names.
- **Safety:** Cancellation, process cleanup, workspace isolation, secret redaction, SQLite compatibility, CMake cache isolation, and bounded temporary-directory cleanup are explicit.
- **Truthfulness:** No path permits a write-intent run to become successful with an open TaskPlan or `check_tier=none`.
