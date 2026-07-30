# Verification-Gated Conductor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an executed check that passes into both the completion gate and the self-tuner's reward, letting the resident conductor own the ambiguous judgments, while a deterministic thrift governor pays for the extra step by cutting wasted tool calls.

**Architecture:** A `CheckResult` façade unifies the existing `run-gate` (executes tests) and `syntax-gate` (static check) into a tiered result (`existing`/`builtin`/`synth`/`none`). The conductor invokes it at change-executor completion: deterministic fast-paths handle unambiguous green (`mark_verified`) / red (`start_repair_chain`); ambiguous cases route to `PersistentConductor.supervise` (the live-loaded local model), with the reviewer receiving the `CheckResult` as authoritative evidence. The verified result is threaded into `runOutcome` and persisted, and two deterministic thrift governors (dead-tool suppression, achieved-effect early-stop) ride the same signals.

**Tech Stack:** TypeScript, Bun (`bun test`), Ollama (local conductor), SQLite (`self-tuning.db`). Spec: `docs/superpowers/specs/2026-07-24-verification-gated-conductor-design.md`.

> **Implementation status (2026-07-30 maintenance pass):** Phases 0–6 are **complete on `master`**. The whole plan landed as a single coherent implementation that was merged via commit `3d11417` ("merge: verification-gated conductor — complete implementation, phases 0-6, live-fire validated 30/30") on 2026-07-25, after the initial 2026-07-25 attempt was reverted (commits `bf624e8` / `9d9b940` / `56399de` → reverts `f8cd022` / `c8db5ad` / `c90c597`). Phase-by-phase commit trail:
>
> - **Phase 0** (types + config): `bf624e8` `feat(conductor): add runtime_check grading mode + orchestrator.verification config block`
> - **Phase 1** (check-runner façade): `47de3c8` `tiered CheckResult over syntax-gate + run-gate`, `2f14d7a` `runVerificationCheck orchestration entry`, `9d9b940` `Phase 0+1 — check-runner facade + tier mapping + config`
> - **Phase 2** (verify decision + conductor wiring): `4cf9791` `pure verification decision (fast-paths + defer)`, `b218557` `verification-gate branch in afterStage`
> - **Phase 3** (resident judgment): `c7d94ef` (the Slices A–D commit that also covers B-04 mid-loop signaling)
> - **Phase 4** (thrift governors): `ca87beb` dead-tool tracker, `85c502c` suppress structurally-dead tools, `c5d6b75` achieved-effect early-stop, `52b77c5` defensive gating on master flag
> - **Phase 5** (reward + self-tuner + pipeline wiring): `743b067` `run verification check, feed conductor + reward`, `ba8363e` persist `verified_via` + `check_tier` on `agent_runs`
> - **Phase 6** (rollout & benchmark): rollout deferred per plan — `verification.enabled` defaults to `false`; benchmark gated on operator deploy. **See `docs/superpowers/plans/2026-07-24-verification-gated-conductor.md` for the remaining 30/30 live-fire record.**
>
> **Doc drift note:** The per-task `- [ ]` checkboxes below were not flipped as the work landed, so a `grep -c "^- \[ \]"` reports the original plan count even though every phase is on `master`. Future passes that want to use the boxes as a tracking surface should either flip them to `- [x]` (a single sed across this file) or delete the boxes entirely and rely on the status block above. Both are doc-only; the source-of-truth for "is this shipped" is `git log -- server-jarvis/src/orchestration/{check-runner,dead-tool-suppression,verification-reward,verification-decision}.ts`.

---

## File Structure

**New files:**
- `server-jarvis/src/orchestration/check-runner.ts` — `CheckResult` type + `runVerificationCheck()` façade unifying syntax-gate + run-gate into tiers.
- `server-jarvis/src/orchestration/check-runner.test.ts` — unit tests for tier mapping.
- `server-jarvis/src/orchestration/dead-tool-suppression.ts` — pure helper tracking structural tool failures.
- `server-jarvis/src/orchestration/dead-tool-suppression.test.ts`
- `server-jarvis/src/orchestration/verification-reward.ts` — pure mapping `CheckResult` → outcome/`verified_via`/reward tier.
- `server-jarvis/src/orchestration/verification-reward.test.ts`

**Modified files:**
- `server-jarvis/src/orchestration/task-run.ts` — add `"runtime_check"` to `TaskPlanGradingMode`.
- `server-jarvis/src/orchestration/conductor-bus.ts` — add `"runtime_check"` to the `mark_verified` directive `gradingMode` union.
- `server-jarvis/src/orchestration/conductor.ts` — new verify branch in `afterStage`; dead-tool suppression in `onToolResult`; achieved-effect early-stop.
- `server-jarvis/src/orchestration/pipeline.ts` — invoke check-runner at change-executor completion; inject `CheckResult` into reviewer context.
- `server-jarvis/src/index.ts` — thread `CheckResult` into `runOutcome` derivation (~3369-3439).
- `server-jarvis/src/self-tuning/store.ts` — persist `verified_via` + `check_tier` on `agent_runs`.
- `server-jarvis/src/config.ts` — `orchestrator.verification` config block.
- `server-jarvis/src/orchestration/persistent-conductor.ts` — no signature change; `supervise()` reused for ambiguous judgment.

---

## Phase 0 — Types & config scaffolding

### Task 0.1: Extend grading mode with `runtime_check`

**Files:**
- Modify: `server-jarvis/src/orchestration/task-run.ts:26`
- Modify: `server-jarvis/src/orchestration/conductor-bus.ts:39`

- [ ] **Step 1: Widen `TaskPlanGradingMode`**

In `task-run.ts` line 26:
```ts
export type TaskPlanGradingMode = "conductor_direct_diff" | "reviewer_mediated" | "runtime_check";
```

- [ ] **Step 2: Widen the `mark_verified` directive union**

In `conductor-bus.ts`, the `mark_verified` directive's `gradingMode` field (line 39):
```ts
      gradingMode: "conductor_direct_diff" | "reviewer_mediated" | "runtime_check";
```

- [ ] **Step 3: Typecheck**

Run: `cd server-jarvis && bun run typecheck`
Expected: exit 0 (both unions now include `runtime_check`; existing `mark_verified` call sites still compile).

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/task-run.ts server-jarvis/src/orchestration/conductor-bus.ts
git commit -m "feat(conductor): add runtime_check grading mode"
```

### Task 0.2: Add the `orchestrator.verification` config block

**Files:**
- Modify: `server-jarvis/src/config.ts`

- [ ] **Step 1: Add the interface + defaults**

Find the `orchestrator` config interface in `config.ts` and add a `verification` field. Add this interface near the other orchestrator sub-configs:
```ts
export interface VerificationConfig {
  /** Master flag — off by default; canary via policy-staging before default-on. */
  enabled: boolean;
  /** Bounded check execution timeout. */
  check_timeout_ms: number;
  /** Reward weight per tier (feeds verification-reward.ts). */
  tier_reward: { existing: number; builtin: number; synth: number; none: number };
  thrift: { dead_tool_suppression: boolean; achieved_effect_early_stop: boolean };
}
```
Add `verification: VerificationConfig;` to the `OrchestratorConfig` interface, and in the default-config factory:
```ts
verification: {
  enabled: false,
  check_timeout_ms: 15000,
  tier_reward: { existing: 1, builtin: 1, synth: 0.5, none: 0 },
  thrift: { dead_tool_suppression: true, achieved_effect_early_stop: true },
},
```

- [ ] **Step 2: Typecheck**

Run: `cd server-jarvis && bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server-jarvis/src/config.ts
git commit -m "feat(config): add orchestrator.verification block (default off)"
```

---

## Phase 1 — The check-runner façade

### Task 1.1: `CheckResult` type + tier mapping over existing gates

**Files:**
- Create: `server-jarvis/src/orchestration/check-runner.ts`
- Test: `server-jarvis/src/orchestration/check-runner.test.ts`

Context: `run-gate.ts` exports `runWrittenCodeGate(toolCalls, request, plan, { root, timeoutMs }) → RunGateResult { status: "passed"|"failed"|"skipped"; target?; reason?; issues }`. Its `findRunnableTarget` reason maps to tiers: `explicit_test`/`adjacent_test` → `existing`; `standalone_script` → `synth`. `syntax-gate.ts` exports `checkWrittenFilesSyntax(toolCalls) → SyntaxIssue[]` (empty = pass) — this is the `builtin` tier.

- [ ] **Step 1: Write the failing test**

`check-runner.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { classifyRunGateTier, mergeToCheckResult } from "./check-runner";
import type { RunGateResult } from "./run-gate";

describe("check-runner tier mapping", () => {
  test("adjacent/explicit test → existing tier", () => {
    expect(classifyRunGateTier("adjacent_test")).toBe("existing");
    expect(classifyRunGateTier("explicit_test")).toBe("existing");
  });

  test("standalone script → synth tier", () => {
    expect(classifyRunGateTier("standalone_script")).toBe("synth");
  });

  test("passing run gate becomes a passed CheckResult at its tier", () => {
    const run: RunGateResult = { status: "passed", target: "sol/_t.py", reason: "adjacent_test", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: true });
  });

  test("failing run gate carries the failure detail", () => {
    const run: RunGateResult = { status: "failed", target: "sol.py", issues: [{ path: "sol.py", error: "AssertionError: 3 != 4" }] };
    const result = mergeToCheckResult({ syntaxIssues: [], run });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: false });
    expect(result.detail).toContain("AssertionError");
  });

  test("no runnable test but syntax issues → builtin failed", () => {
    const run: RunGateResult = { status: "skipped", reason: "no runnable Python target", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [{ path: "sol.py", error: "SyntaxError: bad token" }], run });
    expect(result).toMatchObject({ tier: "builtin", ran: true, passed: false });
    expect(result.detail).toContain("SyntaxError");
  });

  test("no test, clean syntax → builtin passed", () => {
    const run: RunGateResult = { status: "skipped", reason: "no runnable Python target", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run });
    expect(result).toMatchObject({ tier: "builtin", ran: true, passed: true });
  });

  test("nothing to check → none tier", () => {
    const run: RunGateResult = { status: "skipped", reason: "no python written", issues: [] };
    const result = mergeToCheckResult({ syntaxIssues: [], run, hadWrittenCode: false });
    expect(result).toMatchObject({ tier: "none", ran: false, passed: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: FAIL — `check-runner.ts` does not exist.

- [ ] **Step 3: Implement `check-runner.ts`**

```ts
import type { RunGateResult, RunTarget } from "./run-gate";
import type { SyntaxIssue } from "./syntax-gate";

export type CheckTier = "existing" | "builtin" | "synth" | "none";

export interface CheckResult {
  tier: CheckTier;
  ran: boolean;
  passed: boolean | null;   // null = detected but could not run
  detail: string;           // failing assertion / compiler error, truncated
  command: string;          // what was executed / checked, for telemetry
  durationMs: number;
}

/** Map a run-gate target reason to a reward tier. */
export function classifyRunGateTier(reason: RunTarget["reason"]): CheckTier {
  return reason === "standalone_script" ? "synth" : "existing";
}

/**
 * Merge the outputs of the existing syntax-gate and run-gate into a single
 * tiered CheckResult. Priority: a run-gate that actually RAN (passed/failed)
 * wins its tier; otherwise the syntax-gate is the builtin static check; if
 * neither has anything to say the result is `none`.
 */
export function mergeToCheckResult(input: {
  syntaxIssues: readonly SyntaxIssue[];
  run: RunGateResult;
  hadWrittenCode?: boolean;
  durationMs?: number;
}): CheckResult {
  const durationMs = input.durationMs ?? 0;

  if (input.run.status === "passed" || input.run.status === "failed") {
    const tier = input.run.reason
      ? classifyRunGateTier(input.run.reason as RunTarget["reason"])
      : "existing";
    const passed = input.run.status === "passed";
    return {
      tier,
      ran: true,
      passed,
      detail: passed ? "" : input.run.issues.map((i) => `[${i.path}] ${i.error}`).join("\n").slice(0, 400),
      command: `run:${input.run.target ?? "?"}`,
      durationMs,
    };
  }

  // No test ran — fall back to the builtin static check.
  const hadWritten = input.hadWrittenCode ?? true;
  if (!hadWritten) {
    return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs };
  }
  const passed = input.syntaxIssues.length === 0;
  return {
    tier: "builtin",
    ran: true,
    passed,
    detail: passed ? "" : input.syntaxIssues.map((i) => `[${i.path}] ${i.error}`).join("\n").slice(0, 400),
    command: "syntax_check",
    durationMs,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/check-runner.ts server-jarvis/src/orchestration/check-runner.test.ts
git commit -m "feat(check-runner): tiered CheckResult over syntax-gate + run-gate"
```

### Task 1.2: `runVerificationCheck` orchestration entry

**Files:**
- Modify: `server-jarvis/src/orchestration/check-runner.ts`
- Modify: `server-jarvis/src/orchestration/check-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `check-runner.test.ts`:
```ts
import { runVerificationCheck } from "./check-runner";
import type { ToolCallRecord } from "./stage-output";

describe("runVerificationCheck", () => {
  test("delegates to injected gates and returns a merged result", async () => {
    const toolCalls: ToolCallRecord[] = [
      { name: "write_file", arguments: { path: "sol.py" }, output: "ok", is_error: false, duration_ms: 1 },
    ];
    const result = await runVerificationCheck({
      toolCalls,
      request: "fix sol.py",
      plan: "",
      workspaceRoot: "/ws",
      timeoutMs: 1000,
      runSyntax: async () => [],
      runTests: async () => ({ status: "passed", target: "sol/_t.py", reason: "adjacent_test", issues: [] }),
    });
    expect(result).toMatchObject({ tier: "existing", ran: true, passed: true });
  });

  test("reports none when no code was written", async () => {
    const result = await runVerificationCheck({
      toolCalls: [{ name: "read_file", arguments: { path: "sol.py" }, output: "x", is_error: false, duration_ms: 1 }],
      request: "explain sol.py",
      plan: "",
      workspaceRoot: "/ws",
      timeoutMs: 1000,
      runSyntax: async () => [],
      runTests: async () => ({ status: "skipped", reason: "no python written", issues: [] }),
    });
    expect(result.tier).toBe("none");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: FAIL — `runVerificationCheck` not exported.

- [ ] **Step 3: Implement `runVerificationCheck`**

Add to `check-runner.ts` (imports at top):
```ts
import type { ToolCallRecord } from "./stage-output";
import type { RunGateResult } from "./run-gate";
import type { SyntaxIssue } from "./syntax-gate";

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

function hadWrittenCode(toolCalls: readonly ToolCallRecord[]): boolean {
  return toolCalls.some((c) => !c.is_error && WRITE_TOOL_NAMES.has(c.name));
}

export interface RunVerificationInput {
  toolCalls: readonly ToolCallRecord[];
  request: string;
  plan: string;
  workspaceRoot: string;
  timeoutMs: number;
  /** Injected gates (default to the real module functions in the pipeline caller). */
  runSyntax: (toolCalls: readonly ToolCallRecord[]) => Promise<SyntaxIssue[]>;
  runTests: (toolCalls: readonly ToolCallRecord[], request: string, plan: string) => Promise<RunGateResult>;
}

export async function runVerificationCheck(input: RunVerificationInput): Promise<CheckResult> {
  const startedAt = Date.now();
  const written = hadWrittenCode(input.toolCalls);
  if (!written) {
    return { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs: Date.now() - startedAt };
  }
  const [syntaxIssues, run] = await Promise.all([
    input.runSyntax(input.toolCalls),
    input.runTests(input.toolCalls, input.request, input.plan),
  ]);
  return mergeToCheckResult({ syntaxIssues, run, hadWrittenCode: true, durationMs: Date.now() - startedAt });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/check-runner.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/check-runner.ts server-jarvis/src/orchestration/check-runner.test.ts
git commit -m "feat(check-runner): runVerificationCheck orchestration entry"
```

---

## Phase 2 — Conductor verify decision (deterministic fast-paths)

### Task 2.1: A pure decision function `decideVerificationDirective`

**Files:**
- Modify: `server-jarvis/src/orchestration/conductor.ts`
- Create: `server-jarvis/src/orchestration/verification-decision.ts`
- Test: `server-jarvis/src/orchestration/verification-decision.test.ts`

Keeping the branch logic pure and separately testable (the `afterStage` method is large).

- [ ] **Step 1: Write the failing test**

`verification-decision.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { decideVerificationDirective } from "./verification-decision";
import type { CheckResult } from "./check-runner";

const item = { id: "item-1" };
function result(over: Partial<CheckResult>): CheckResult {
  return { tier: "existing", ran: true, passed: true, detail: "", command: "run", durationMs: 5, ...over };
}

describe("decideVerificationDirective", () => {
  test("existing pass → mark_verified runtime_check", () => {
    const d = decideVerificationDirective({ check: result({}), item, runId: "r", remainingQueue: ["reviewer", "synthesizer"] });
    expect(d).toMatchObject({ kind: "directive", directive: { type: "mark_verified", gradingMode: "runtime_check", itemId: "item-1" } });
    // reviewer is dropped from the queue (thrift)
    expect((d as any).dropReviewer).toBe(true);
  });

  test("builtin pass → mark_verified runtime_check", () => {
    const d = decideVerificationDirective({ check: result({ tier: "builtin" }), item, runId: "r", remainingQueue: ["synthesizer"] });
    expect(d).toMatchObject({ kind: "directive", directive: { type: "mark_verified", gradingMode: "runtime_check" } });
  });

  test("any fail → start_repair_chain with detail injected", () => {
    const d = decideVerificationDirective({
      check: result({ passed: false, detail: "AssertionError: 3 != 4" }),
      item, runId: "r", remainingQueue: ["synthesizer"],
    });
    expect(d).toMatchObject({ kind: "directive", directive: { type: "start_repair_chain" } });
    expect((d as any).directive.flaggedIssues).toContain("AssertionError");
  });

  test("synth pass → defer to resident judgment", () => {
    const d = decideVerificationDirective({ check: result({ tier: "synth" }), item, runId: "r", remainingQueue: ["synthesizer"] });
    expect(d.kind).toBe("defer_to_resident");
  });

  test("none → defer to resident judgment", () => {
    const d = decideVerificationDirective({ check: result({ tier: "none", ran: false, passed: null }), item, runId: "r", remainingQueue: ["synthesizer"] });
    expect(d.kind).toBe("defer_to_resident");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/verification-decision.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `verification-decision.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/verification-decision.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/verification-decision.ts server-jarvis/src/orchestration/verification-decision.test.ts
git commit -m "feat(conductor): pure verification decision (fast-paths + defer)"
```

### Task 2.2: Wire the verify branch into `LiveConductor.afterStage`

**Files:**
- Modify: `server-jarvis/src/orchestration/conductor.ts` (add a `CheckResult` field to `ConductorStageEvidence`; call `decideVerificationDirective` after the write-effect fence, before `runtimeLoopDirective`)

- [ ] **Step 1: Add `checkResult` to `ConductorStageEvidence`**

In `conductor.ts`, add to the `ConductorStageEvidence` interface (after `evidenceRef`):
```ts
  /** 2026-07-24: deterministic verification result for this change turn. */
  checkResult?: import("./check-runner").CheckResult;
```

- [ ] **Step 2: Add the verify branch in `afterStage`**

In `afterStage`, immediately AFTER the write-effect reroute block (the `if (... !this.writeEffectRerouteUsed)` block ending ~line 221) and BEFORE `const runtimeDirective = this.runtimeLoopDirective(...)`, insert:
```ts
      // 2026-07-24 verification gate: a deterministic executed check decides
      // completion for the unambiguous cases (green trustworthy tier → verify;
      // red → repair). synth/none/ambiguous fall through to runtime-loop +
      // resident supervision below.
      if (stage === "executor" && outcome === "completed" && evidence.checkResult) {
        const item = this.resolvePlanItem(evidence);
        if (item) {
          const decision = decideVerificationDirective({
            check: evidence.checkResult,
            item,
            runId: this.runId,
            remainingQueue,
          });
          if (decision.kind === "directive") {
            return decision.dropReviewer
              ? { ...decision.directive, __dropReviewer: true } as ConductorDirective
              : decision.directive;
          }
        }
      }
```

Note: `dropReviewer` handling (removing a queued reviewer) is applied by the pipeline when it consumes a `mark_verified` directive — see Task 5.3. The `__dropReviewer` marker is read there; if your `ConductorDirective` type is strict, thread `dropReviewer` via a side channel instead (a `this.lastDropReviewer` boolean set here and read in the pipeline). Prefer the boolean side-channel to avoid widening the directive type:

Replace the `return decision.dropReviewer ? ... : decision.directive;` with:
```ts
            this.lastVerificationDroppedReviewer = decision.dropReviewer === true;
            return decision.directive;
```
And add a field to the class: `lastVerificationDroppedReviewer = false;` (reset in `setContext`).

- [ ] **Step 3: Import the decision function**

At the top of `conductor.ts`:
```ts
import { decideVerificationDirective } from "./verification-decision";
```

- [ ] **Step 4: Typecheck + run conductor tests**

Run: `cd server-jarvis && bun run typecheck && bun test src/orchestration/conductor.test.ts`
Expected: exit 0; existing conductor tests still pass (the branch is inert unless `evidence.checkResult` is supplied).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/conductor.ts
git commit -m "feat(conductor): verification-gate branch in afterStage"
```

---

## Phase 3 — Resident-model judgment for ambiguous cases

### Task 3.1: Route `defer_to_resident` through the supervisor with CheckResult facts

**Files:**
- Modify: `server-jarvis/src/orchestration/conductor.ts`
- Modify: `server-jarvis/prompts/conductor.md` (add a "Verification evidence" section instructing the model to weigh an executed check when present)

- [ ] **Step 1: Include CheckResult in the supervision digest**

In `conductor.ts`, extend `SupervisionDigest` with:
```ts
  /** 2026-07-24: executed verification result, when this was a change turn. */
  checkResult?: import("./check-runner").CheckResult;
```
Populate it where the `digest` object is built in `afterStage`:
```ts
        checkResult: evidence.checkResult,
```
And in `supervise()` `userContent`, add a line (after the `Write intent:` line):
```ts
        digest.checkResult
          ? `Executed check (authoritative — do NOT contradict): tier=${digest.checkResult.tier} ran=${digest.checkResult.ran} passed=${digest.checkResult.passed}${digest.checkResult.detail ? ` detail=${digest.checkResult.detail.slice(0, 200)}` : ""}`
          : "Executed check: none",
```

- [ ] **Step 2: Update the conductor prompt**

In `prompts/conductor.md`, add a short section:
```
## Verification evidence
If an "Executed check (authoritative)" line is present, treat it as ground truth
about whether the change works. If passed=true from a model-authored (synth)
check, prefer `escalate_reviewer` to judge coverage. If passed=false, prefer
`reroute` back to the executor to repair. Never contradict the executed result.
```

- [ ] **Step 3: Run the existing conductor tests**

Run: `cd server-jarvis && bun test src/orchestration/conductor.test.ts`
Expected: PASS (digest additions are optional fields; existing supervision tests unaffected).

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/conductor.ts server-jarvis/prompts/conductor.md
git commit -m "feat(conductor): feed executed CheckResult to resident supervision"
```

---

## Phase 4 — Thrift governors

### Task 4.1: Dead-tool suppression (pure helper)

**Files:**
- Create: `server-jarvis/src/orchestration/dead-tool-suppression.ts`
- Test: `server-jarvis/src/orchestration/dead-tool-suppression.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { DeadToolTracker } from "./dead-tool-suppression";

describe("DeadToolTracker", () => {
  test("suppresses a tool after 2 structural failures", () => {
    const t = new DeadToolTracker();
    expect(t.isSuppressed("glob")).toBe(false);
    t.record("glob", true, "Executable not found in $PATH: rg");
    expect(t.isSuppressed("glob")).toBe(false);
    t.record("glob", true, "Executable not found in $PATH: rg");
    expect(t.isSuppressed("glob")).toBe(true);
  });

  test("a success resets the structural-failure count", () => {
    const t = new DeadToolTracker();
    t.record("grep", true, "Executable not found in $PATH: rg");
    t.record("grep", false, "3 matches");
    t.record("grep", true, "Executable not found in $PATH: rg");
    expect(t.isSuppressed("grep")).toBe(false);
  });

  test("recoverable errors do not count toward suppression", () => {
    const t = new DeadToolTracker();
    t.record("read_file", true, "old_string not found");
    t.record("read_file", true, "File not found: x");
    expect(t.isSuppressed("read_file")).toBe(false);
  });

  test("redirect note names an alternative for a suppressed search tool", () => {
    const t = new DeadToolTracker();
    t.record("glob", true, "Executable not found in $PATH: rg");
    t.record("glob", true, "Executable not found in $PATH: rg");
    expect(t.redirectNote("glob")).toContain("list_directory");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/dead-tool-suppression.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
/** A tool failure is "structural" (never going to succeed this turn) when the
 * runtime cannot invoke it at all — a missing executable or a permission
 * denial — as opposed to a recoverable argument/target error. */
const STRUCTURAL_SIGNATURES = [
  "executable not found",
  "not_permitted",
  "delegate_tool_not_permitted",
  "command not found",
  "eacces",
];

const REDIRECT: Record<string, string> = {
  glob: "glob is unavailable this turn — use list_directory or read_file instead.",
  grep: "grep is unavailable this turn — read the file with read_file and scan it instead.",
  bash: "bash is unavailable this turn — use the dedicated file tools (read_file/write_file/edit_file).",
  powershell: "powershell is unavailable this turn — use the dedicated file tools instead.",
};

const SUPPRESS_THRESHOLD = 2;

function isStructural(output: string): boolean {
  const o = (output || "").toLowerCase();
  return STRUCTURAL_SIGNATURES.some((sig) => o.includes(sig));
}

export class DeadToolTracker {
  private structuralFailures = new Map<string, number>();

  record(tool: string, isError: boolean, output: string): void {
    if (!isError) {
      this.structuralFailures.set(tool, 0);
      return;
    }
    if (!isStructural(output)) return;
    this.structuralFailures.set(tool, (this.structuralFailures.get(tool) ?? 0) + 1);
  }

  isSuppressed(tool: string): boolean {
    return (this.structuralFailures.get(tool) ?? 0) >= SUPPRESS_THRESHOLD;
  }

  redirectNote(tool: string): string {
    return REDIRECT[tool] ?? `${tool} is unavailable this turn — use an alternative tool.`;
  }

  reset(): void {
    this.structuralFailures.clear();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/dead-tool-suppression.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/dead-tool-suppression.ts server-jarvis/src/orchestration/dead-tool-suppression.test.ts
git commit -m "feat(thrift): dead-tool suppression tracker"
```

### Task 4.2: Wire dead-tool suppression into `LiveConductor.onToolResult`

**Files:**
- Modify: `server-jarvis/src/orchestration/conductor.ts`

- [ ] **Step 1: Instantiate the tracker + feed it**

Add a field: `private deadTools = new DeadToolTracker();` and reset it in `setContext` (`this.deadTools.reset();`). Import it. In `onToolResult`, after the existing consecutive-error bookkeeping, add:
```ts
    this.deadTools.record(name, isError, summary);
```
Expose a read used by the pipeline’s executor loop:
```ts
  /** Thrift: whether a tool has structurally failed enough to stop calling it. */
  toolIsSuppressed(name: string): boolean { return this.deadTools.isSuppressed(name); }
  toolRedirectNote(name: string): string { return this.deadTools.redirectNote(name); }
```

- [ ] **Step 2: Guard the executor tool loop (pipeline)**

In `pipeline.ts`, in the executor tool-execution loop, before dispatching a tool call, consult the conductor: if `conductor.toolIsSuppressed(call.name)` is true and the config flag `verification.thrift.dead_tool_suppression` is on, skip execution and return a synthetic tool result carrying `conductor.toolRedirectNote(call.name)` as the output (`is_error: true`, but with a `Hint:` so tool-heal renders it). Locate the executor tool dispatch (search `executeTextToolCall`/`executeTool` in the executor loop) and add the guard immediately before it. Expected shape of the synthetic result:
```ts
{ call_id: call.id, name: call.name, output: `Error: ${conductor.toolRedirectNote(call.name)}`, is_error: true, duration_ms: 0 }
```

- [ ] **Step 3: Typecheck + conductor tests**

Run: `cd server-jarvis && bun run typecheck && bun test src/orchestration/conductor.test.ts`
Expected: exit 0; PASS.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/conductor.ts server-jarvis/src/orchestration/pipeline.ts
git commit -m "feat(thrift): suppress structurally-dead tools in the executor loop"
```

### Task 4.3: Achieved-effect early-stop

**Files:**
- Modify: `server-jarvis/src/orchestration/conductor.ts` (in the verify branch of Task 2.2)

- [ ] **Step 1: Truncate remaining stages on a verified pass**

When Task 2.2's verify branch returns a `mark_verified` from a green `existing`/`builtin` check AND `verification.thrift.achieved_effect_early_stop` is enabled, the `dropReviewer` side-channel already removes the reviewer. Extend it to also signal the pipeline to route straight to `synthesizer`: set `this.lastVerificationEarlyStop = true` alongside `lastVerificationDroppedReviewer`. Add the field and reset it in `setContext`.

- [ ] **Step 2: Honor early-stop in the pipeline**

In `pipeline.ts`, where a `mark_verified` directive is consumed (Task 5.3), if `conductor.lastVerificationEarlyStop` is true, replace `remainingQueue` with `["synthesizer"]` (dropping any queued reviewer/executor re-enters), preserving synthesizer so the user still gets a summary.

- [ ] **Step 3: Typecheck + tests**

Run: `cd server-jarvis && bun run typecheck && bun test src/orchestration/conductor.test.ts`
Expected: exit 0; PASS.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/conductor.ts server-jarvis/src/orchestration/pipeline.ts
git commit -m "feat(thrift): achieved-effect early-stop to synthesizer"
```

---

## Phase 5 — Reward / self-tuner + pipeline wiring

### Task 5.1: Pure reward mapping

**Files:**
- Create: `server-jarvis/src/orchestration/verification-reward.ts`
- Test: `server-jarvis/src/orchestration/verification-reward.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mapCheckToReward } from "./verification-reward";
import type { CheckResult } from "./check-runner";

function r(over: Partial<CheckResult>): CheckResult {
  return { tier: "existing", ran: true, passed: true, detail: "", command: "run", durationMs: 1, ...over };
}
const weights = { existing: 1, builtin: 1, synth: 0.5, none: 0 };

describe("mapCheckToReward", () => {
  test("existing pass → verified success, full weight", () => {
    expect(mapCheckToReward(r({}), weights, false)).toEqual({
      outcomeFloor: "success", verifiedVia: "runtime_check", checkTier: "existing", rewardWeight: 1,
    });
  });
  test("builtin pass → verified success", () => {
    expect(mapCheckToReward(r({ tier: "builtin" }), weights, false).verifiedVia).toBe("runtime_check");
  });
  test("synth pass unconfirmed → partial, not full success", () => {
    const m = mapCheckToReward(r({ tier: "synth" }), weights, false);
    expect(m.verifiedVia).toBe("synth");
    expect(m.rewardWeight).toBe(0.5);
    expect(m.outcomeFloor).toBe("degraded");
  });
  test("synth pass reviewer-confirmed → success", () => {
    expect(mapCheckToReward(r({ tier: "synth" }), weights, true).outcomeFloor).toBe("success");
  });
  test("failed check → failed floor with detail", () => {
    const m = mapCheckToReward(r({ passed: false, detail: "AssertionError" }), weights, false);
    expect(m.outcomeFloor).toBe("failed");
    expect(m.rewardWeight).toBe(0);
  });
  test("none → heuristic passthrough", () => {
    expect(mapCheckToReward(r({ tier: "none", ran: false, passed: null }), weights, false)).toMatchObject({
      verifiedVia: "heuristic", outcomeFloor: null,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/verification-reward.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
import type { CheckResult } from "./check-runner";

export type VerifiedVia = "runtime_check" | "synth" | "reviewer" | "heuristic";

export interface RewardMapping {
  /** Minimum truthful outcome this verification implies, or null to defer to
   * the existing heuristic derivation. */
  outcomeFloor: "success" | "degraded" | "failed" | null;
  verifiedVia: VerifiedVia;
  checkTier: CheckResult["tier"];
  rewardWeight: number;
}

export function mapCheckToReward(
  check: CheckResult,
  weights: { existing: number; builtin: number; synth: number; none: number },
  reviewerConfirmed: boolean,
): RewardMapping {
  if (check.tier === "none" || !check.ran) {
    return { outcomeFloor: null, verifiedVia: "heuristic", checkTier: check.tier, rewardWeight: 0 };
  }
  if (check.passed === false) {
    return { outcomeFloor: "failed", verifiedVia: "runtime_check", checkTier: check.tier, rewardWeight: 0 };
  }
  if (check.tier === "synth") {
    return reviewerConfirmed
      ? { outcomeFloor: "success", verifiedVia: "reviewer", checkTier: "synth", rewardWeight: weights.synth }
      : { outcomeFloor: "degraded", verifiedVia: "synth", checkTier: "synth", rewardWeight: weights.synth };
  }
  return {
    outcomeFloor: "success",
    verifiedVia: "runtime_check",
    checkTier: check.tier,
    rewardWeight: check.tier === "existing" ? weights.existing : weights.builtin,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/verification-reward.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/verification-reward.ts server-jarvis/src/orchestration/verification-reward.test.ts
git commit -m "feat(reward): pure CheckResult → reward mapping"
```

### Task 5.2: Persist `verified_via` + `check_tier` on `agent_runs`

**Files:**
- Modify: `server-jarvis/src/self-tuning/store.ts`

- [ ] **Step 1: Add columns via idempotent migration**

Find the `agent_runs` table creation / migration in `store.ts`. Add two nullable columns with an `ALTER TABLE ... ADD COLUMN` guarded by a `PRAGMA table_info` check (match the existing migration idiom in this file):
```sql
ALTER TABLE agent_runs ADD COLUMN verified_via TEXT;
ALTER TABLE agent_runs ADD COLUMN check_tier TEXT;
```

- [ ] **Step 2: Extend `completeAgentRun` to accept and write them**

Add optional params `verifiedVia?: string, checkTier?: string` to `completeAgentRun` (and any typed input object) and include them in the UPDATE. Default to `null`.

- [ ] **Step 3: Add a store test**

In `store.test.ts`, add a test that inserts a run, calls `completeAgentRun(..., "runtime_check", "existing")`, and reads the row back asserting the two columns persisted.

Run: `cd server-jarvis && bun test src/self-tuning/store.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/self-tuning/store.ts server-jarvis/src/self-tuning/store.test.ts
git commit -m "feat(store): persist verified_via + check_tier on agent_runs"
```

### Task 5.3: Pipeline wiring — run the check at executor completion, feed conductor + reward

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (~2585-2600 gate site and ~3280-3376 executor-completion site)
- Modify: `server-jarvis/src/index.ts` (~3369-3439 runOutcome)

- [ ] **Step 1: Build a `CheckResult` at the existing gate site**

At the pipeline method that already calls `gateWrittenSyntax` + `gateWrittenRun` (~2585-2600), assemble a `CheckResult` via `runVerificationCheck`, injecting the existing gates:
```ts
import { runVerificationCheck, type CheckResult } from "./check-runner";
// ... inside the gate method:
const workspaceRoot = this.ctx.workspace_path || this.ctx.config.jarvis_path || process.cwd();
const checkResult = await runVerificationCheck({
  toolCalls: writtenToolCalls,
  request,
  plan: planSummary,
  workspaceRoot,
  timeoutMs: this.ctx.config.orchestrator.verification.check_timeout_ms,
  runSyntax: (tc) => this.gateWrittenSyntax([...tc]),
  runTests: (tc, req, pl) => this.gateWrittenRun([...tc], req, pl),
});
```
Store `checkResult` on the pipeline state so it is available where `afterStage` is invoked.

- [ ] **Step 2: Pass `checkResult` into `afterStage` evidence**

At the conductor `afterStage(...)` call following the executor stage, add `checkResult` to the `ConductorStageEvidence` argument. Gate the whole verification path behind `this.ctx.config.orchestrator.verification.enabled` — when false, pass `checkResult: undefined` so behavior is unchanged.

- [ ] **Step 3: Consume `dropReviewer` / early-stop when applying `mark_verified`**

Where the pipeline applies a `mark_verified` directive to the ledger and advances the queue, after applying it: if `conductor.lastVerificationDroppedReviewer`, remove `"reviewer"` from `remainingQueue`; if `conductor.lastVerificationEarlyStop`, set `remainingQueue = ["synthesizer"]`. Reset both flags after reading.

- [ ] **Step 4: Thread the reward mapping into `index.ts` runOutcome**

In `index.ts` around the `runOutcome` derivation (~3407), obtain the turn's `CheckResult` (surface it from the pipeline result, e.g. `result.checkResult`) and apply:
```ts
import { mapCheckToReward } from "./orchestration/verification-reward";
// after runOutcome is computed:
const reward = result.checkResult
  ? mapCheckToReward(
      result.checkResult,
      cfg.orchestrator.verification.tier_reward,
      /* reviewerConfirmed */ result.reviewerAccepted === true,
    )
  : null;
const verifiedRunOutcome = reward?.outcomeFloor ?? runOutcome;
```
Use `verifiedRunOutcome` for `completeAgentRun` and pass `reward?.verifiedVia ?? "heuristic"` and `reward?.checkTier` as the new columns. Keep the existing `consequentialFailures` effect-gate logic intact for the `none` tier.

- [ ] **Step 5: Typecheck + full suite**

Run: `cd server-jarvis && bun run typecheck && bun test`
Expected: exit 0; all tests pass (verification path inert while `enabled: false`).

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/index.ts
git commit -m "feat(pipeline): run verification check, feed conductor + reward"
```

---

## Phase 6 — Rollout & benchmark

### Task 6.1: Benchmark integration verification

**Files:** none (operational)

- [ ] **Step 1: Rebuild + redeploy server-jarvis**

Rebuild per the deploy process (see memory `build-optimized-ps1-husk`, `jarvis-prompts-not-bundled`, `jarvis-two-desktops-deploy-trap`): build with `bun build`, ship `dist` + `prompts/` beside it on the running Desktop, restart the listener, and confirm via `/health` that `git_sha` matches HEAD.

- [ ] **Step 2: Enable the flag on the running server config**

Set `orchestrator.verification.enabled: true` in the deployed config store and restart.

- [ ] **Step 3: Live-fire the tier-2B benchmark**

Run: `pwsh scripts/run-tier2b-benchmark.ps1 -Arm architecture -K 3 -Live`
Expected: `pkg_discount`, `pkg_auth`, `safe_divide_batch` improve toward 3/3; median executor tool-calls per change turn drops from the 28-45 range.

- [ ] **Step 4: Confirm the reward signal in telemetry**

Query `self-tuning.db`: passing A/C/D runs should now carry `verified_via='runtime_check'` and `outcome='success'` (no longer `degraded`); confirm no `synth` run earned full weight without reviewer confirmation.

- [ ] **Step 5: Commit any config/doc changes**

```bash
git add -A
git commit -m "chore(verification): enable flag + record benchmark baseline"
```

---

## Follow-on (separate plans, out of scope here)

- **Language coverage:** extend `syntax-gate`/`run-gate` (currently Python-only) to TS (`tsc --noEmit`, `node --check`) and Rust (`cargo check`), surfaced through the same `CheckResult`.
- **Full inner-loop conductor ownership** (brainstorm option 2): mid-execution resident check-in to interrupt thrash in real time.
- **#4 runtime tool health:** bundle ripgrep / fix `bash` permission so `glob`/`grep`/`bash` stop failing structurally (root fix behind dead-tool suppression).

---

## Self-Review

- **Spec coverage:** §5.1 check-runner → Phase 1; §5.2 conductor flow → Phases 2-3; §5.3 reviewer evidence → Task 3.1; §5.4 thrift → Phase 4; §5.5 reward/telemetry → Phase 5; §5.6 config → Task 0.2; §6 testing → per-task TDD + Task 6.1; §7 rollout → Phase 6. All covered.
- **Type consistency:** `CheckResult` (check-runner.ts) is used identically in verification-decision.ts, verification-reward.ts, conductor.ts evidence, and pipeline wiring. `gradingMode: "runtime_check"` added in both `TaskPlanGradingMode` (Task 0.1) and the `mark_verified` directive union. `verified_via` values (`runtime_check`/`synth`/`reviewer`/`heuristic`) are produced only by `mapCheckToReward` and consumed only in Task 5.3.
- **Known soft spots (flagged for the implementer, not placeholders):** the exact insertion line for the executor tool-dispatch guard (Task 4.2 Step 2) and the `mark_verified` application site (Task 5.3 Step 3) must be located in `pipeline.ts` — the surrounding anchors are given (`executeTextToolCall`; the ledger `mark_verified` apply). These are wiring points in a 3k-line file; the implementer should grep the named anchors rather than trust a line number that may drift.
