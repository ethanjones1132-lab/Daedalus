# Orchestration Morning-Session Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five runtime faults observed in the 2026-08-04 morning session (session `dec0a92e`) — continuation contract loss, blind native fallback after delegate handoff, force-write nudge spam, local-stage deadline burn, and no-tool executor turns consuming the whole turn budget.

**Architecture:** Five independent fixes across the orchestration layer. Each targets a distinct seam: route entry (plan inheritance), delegate handoff (read-set seeding), mid-loop supervision (nudge counting), agent pool + stage budget (fail-fast local), and executor progress policy (typed early abort). All are pure-function-first so they unit-test without a live model, then wired at their single call site.

**Tech Stack:** TypeScript, Bun (`bun test`), SQLite evidence store (`~/.openclaw/jarvis/self-tuning.db`), existing replay harness (`scripts/replay-conductor.ts`).

---

## Evidence Baseline

All five faults are drawn from `~/.openclaw/jarvis/self-tuning.db`, session `dec0a92e-b323-4673-8d75-b120fa4836a8`, 2026-08-04:

| Run | Request | Observed fault |
|---|---|---|
| `run_cc660a4d` | Perihelion plan → execute | planner model timed out at 56.3s, stage burned 158s; reviewer failed at 33s, stage burned to `Stage deadline exceeded (120000ms)`; ~30 near-identical force-write directives; 87 directives total |
| `run_085afdac` | "continue please" | `plan_items: [{title: "continue please"}]`; executor `stop=mid_loop_handoff`, then `executor_no_tool` with zero tool calls |
| `run_94cdcfdf` | "continue please" | `delegate_skip reason=write_not_required`; executor 0 tools; `Total turn deadline (150000ms) exceeded at stage=synthesizer` |
| `run_541d4bf0` | "whats the current state" | correct trivial short-circuit (no fault) |

**Deviation from source assessment (deliberate, see Task 3):** the source review asked to "cap identical `mid_loop_force_write` notes at 2". That cap already exists (`FORCE_WRITE_NUDGE_CAP = 3`, added 2026-08-01) and did not engage live, because its counter only advances for decisions tagged `noteKind === "force_write"`. Lowering the constant alone changes nothing. Task 3 implements the stated goal — stop the repeats, escalate then stop — by fixing the counter, and *also* lowers the cap to 2 as requested.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server-jarvis/src/orchestration/task-run.ts` | TaskRun contract + plan ledger | Add `lastWriteTargets`; add `unfinishedPlanItemInputs()`, `recordWriteTargets()` |
| `server-jarvis/src/orchestration/coordinator-route-entry.ts` | Turn's first routing boundary | `ensureOwnedPlanningOnRoute` inherits unfinished items instead of authoring from follow-up text |
| `server-jarvis/src/orchestration/delegate-handoff-seed.ts` | **NEW** — pure: which paths to re-read after a handoff | New module |
| `server-jarvis/src/orchestration/mid-loop-intervention.ts` | Supervision reflex decisions | Lower cap to 2; tag deterministic force-write notes with `noteKind` |
| `server-jarvis/src/orchestration/agent-pool.ts` | Stage model selection | Refuse a local pick that cannot finish in the remaining stage window |
| `server-jarvis/src/orchestration/executor-progress-policy.ts` | Bound no-tool executor turns | Typed early abort on `full_execution` with zero tools |
| `server-jarvis/src/orchestration/pipeline.ts` | Executor stage orchestration | Wire handoff seeding, nudge counting, early abort |
| `server-jarvis/src/index.ts` | Orchestrator entry | Thread continuation carry + persist write targets |

---

## Task 1: Continuation inherits unfinished plan items and last write targets

**Root cause:** `ensureOwnedPlanningOnRoute` calls `attachOwnedPlanning(message, complexity ?? "low")` whenever the route carries no `plan_authorship`. On the deterministic-fallback path the message is "continue please", complexity defaults to `"low"`, so `authorSimplePlanItems` mints exactly one item titled "continue please" — overwriting the real plan.

**Files:**
- Modify: `server-jarvis/src/orchestration/task-run.ts` (add field + two helpers)
- Modify: `server-jarvis/src/orchestration/coordinator-route-entry.ts:124-140`
- Modify: `server-jarvis/src/index.ts` (call site + write-target persistence)
- Test: `server-jarvis/src/orchestration/task-run.test.ts`
- Test: `server-jarvis/src/orchestration/coordinator-route-entry.test.ts`

- [ ] **Step 1: Write the failing test for the contract helpers**

Append to `server-jarvis/src/orchestration/task-run.test.ts`:

```ts
describe("continuation carry helpers", () => {
  test("unfinishedPlanItemInputs returns non-verified items preserving ids", () => {
    const contract = createTaskRun({
      taskRunId: "tr_1",
      sessionId: "s1",
      objective: "execute the Perihelion plan",
      requirement: "full_execution",
      planItems: [
        { id: "pi_a1", title: "A1 gain staging" },
        { id: "pi_a2", title: "A2 parameter smoothing" },
        { id: "pi_a3", title: "A3 editor layout" },
      ],
    });
    contract.plan!.items[0]!.status = "verified";
    contract.plan!.items[1]!.status = "active";

    const carried = unfinishedPlanItemInputs(contract);

    expect(carried.map((i) => i.id)).toEqual(["pi_a2", "pi_a3"]);
    expect(carried[0]!.title).toBe("A2 parameter smoothing");
  });

  test("unfinishedPlanItemInputs returns empty when every item is verified", () => {
    const contract = createTaskRun({
      taskRunId: "tr_2",
      sessionId: "s2",
      objective: "done work",
      requirement: "full_execution",
      planItems: [{ id: "pi_a", title: "A" }],
    });
    contract.plan!.items[0]!.status = "verified";

    expect(unfinishedPlanItemInputs(contract)).toEqual([]);
  });

  test("recordWriteTargets keeps the most recent targets, newest first, deduped", () => {
    const contract = createTaskRun({
      taskRunId: "tr_3",
      sessionId: "s3",
      objective: "edit files",
      requirement: "full_execution",
    });

    const once = recordWriteTargets(contract, ["C:\\p\\PluginProcessor.cpp"]);
    const twice = recordWriteTargets(once, [
      "C:\\p\\PluginEditor.h",
      "C:\\p\\PluginProcessor.cpp",
    ]);

    expect(twice.lastWriteTargets).toEqual([
      "C:\\p\\PluginEditor.h",
      "C:\\p\\PluginProcessor.cpp",
    ]);
  });

  test("recordWriteTargets caps the list at MAX_TRACKED_WRITE_TARGETS", () => {
    let contract = createTaskRun({
      taskRunId: "tr_4",
      sessionId: "s4",
      objective: "edit many",
      requirement: "full_execution",
    });
    for (let i = 0; i < MAX_TRACKED_WRITE_TARGETS + 3; i++) {
      contract = recordWriteTargets(contract, [`C:\\p\\file${i}.cpp`]);
    }
    expect(contract.lastWriteTargets!.length).toBe(MAX_TRACKED_WRITE_TARGETS);
    expect(contract.lastWriteTargets![0]).toBe(
      `C:\\p\\file${MAX_TRACKED_WRITE_TARGETS + 2}.cpp`,
    );
  });
});
```

Add these names to the existing import block at the top of the file:

```ts
import {
  MAX_TRACKED_WRITE_TARGETS,
  recordWriteTargets,
  unfinishedPlanItemInputs,
} from "./task-run";
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/task-run.test.ts -t "continuation carry helpers"
```

Expected: FAIL — `SyntaxError` or `undefined is not a function`, because `unfinishedPlanItemInputs`, `recordWriteTargets`, and `MAX_TRACKED_WRITE_TARGETS` are not exported yet.

- [ ] **Step 3: Add the contract field**

In `server-jarvis/src/orchestration/task-run.ts`, inside `interface TaskRunContract` (after the `writeIntent` field, around line 128):

```ts
  /**
   * 2026-08-04: absolute paths most recently targeted by a successful write
   * tool call in this task run, newest first. Carried across continuation
   * turns so a follow-up ("continue please") can re-read what it was editing
   * instead of restarting discovery blind. Bounded by
   * {@link MAX_TRACKED_WRITE_TARGETS}.
   */
  lastWriteTargets?: string[];
```

- [ ] **Step 4: Implement the helpers**

Add to `server-jarvis/src/orchestration/task-run.ts`, directly after `remainingWorkFromPlan` (around line 426):

```ts
/** How many recent write targets a contract carries across turns. */
export const MAX_TRACKED_WRITE_TARGETS = 5;

/**
 * Non-verified plan items as re-seedable inputs, order preserved.
 *
 * 2026-08-04 (run_085afdac): a "continue please" follow-up reached
 * `ensureOwnedPlanningOnRoute` with no `plan_authorship`, which authored a
 * fresh single item titled "continue please" over a real multi-item plan.
 * Continuation turns carry the surviving ledger through here instead.
 */
export function unfinishedPlanItemInputs(
  contract: TaskRunContract,
): CreateTaskPlanItemInput[] {
  return (contract.plan?.items ?? [])
    .filter((item) => item.status !== "verified")
    .map((item) => ({
      id: item.id,
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      dependsOn: [...item.dependsOn],
      acceptanceChecks: item.acceptanceChecks.map((check) => ({ ...check })),
    }));
}

/**
 * Record write targets on the contract, newest first, deduped and bounded.
 * Returns a new contract — never mutates the input.
 */
export function recordWriteTargets(
  contract: TaskRunContract,
  paths: readonly string[],
): TaskRunContract {
  const fresh = paths.map((p) => p.trim()).filter(Boolean);
  if (fresh.length === 0) return contract;
  const merged: string[] = [];
  for (const path of [...fresh, ...(contract.lastWriteTargets ?? [])]) {
    if (!merged.includes(path)) merged.push(path);
  }
  return {
    ...contract,
    lastWriteTargets: merged.slice(0, MAX_TRACKED_WRITE_TARGETS),
    updatedAt: nowIso(),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server-jarvis && bun test src/orchestration/task-run.test.ts -t "continuation carry helpers"
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/task-run.ts server-jarvis/src/orchestration/task-run.test.ts && git commit -m "feat(task-run): carry unfinished plan items and write targets across turns"
```

- [ ] **Step 7: Write the failing route-entry test**

Append to `server-jarvis/src/orchestration/coordinator-route-entry.test.ts`:

```ts
describe("ensureOwnedPlanningOnRoute continuation carry", () => {
  const bareRoute = (): CoordinatorResult => ({
    task_type: "general",
    pipeline: ["synthesizer"],
    topology: "linear",
    context: {
      needs_workspace_inspection: false,
      needs_memory: true,
      estimated_complexity: "low",
    },
    coordinator_rationale: "Local conductor cold/abort; deterministic answer_only route.",
    conductor_source: "deterministic",
  });

  test("inherits unfinished items instead of authoring from the follow-up text", () => {
    const route = ensureOwnedPlanningOnRoute(bareRoute(), "continue please", {
      items: [
        { id: "pi_a2", title: "A2 parameter smoothing", dependsOn: [] },
        { id: "pi_a3", title: "A3 editor layout", dependsOn: [] },
      ],
      lastWriteTargets: ["C:\\p\\PluginProcessor.cpp"],
    });

    expect(route.plan_authorship).toBe("conductor_direct");
    expect(route.plan_items?.map((i) => i.id)).toEqual(["pi_a2", "pi_a3"]);
    expect(route.plan_items?.some((i) => i.title === "continue please")).toBe(false);
    expect(route.continuation_write_targets).toEqual(["C:\\p\\PluginProcessor.cpp"]);
  });

  test("falls back to authoring when the carry has no unfinished items", () => {
    const route = ensureOwnedPlanningOnRoute(bareRoute(), "continue please", {
      items: [],
      lastWriteTargets: [],
    });

    expect(route.plan_items?.length).toBe(1);
    expect(route.plan_items?.[0]!.title).toBe("continue please");
  });

  test("carry is ignored when the route already declares plan authorship", () => {
    const authored: CoordinatorResult = {
      ...bareRoute(),
      plan_authorship: "planner_mediated",
      plan_items: [],
    };
    const route = ensureOwnedPlanningOnRoute(authored, "continue please", {
      items: [{ id: "pi_a2", title: "A2", dependsOn: [] }],
      lastWriteTargets: [],
    });

    expect(route.plan_authorship).toBe("planner_mediated");
    expect(route.plan_items).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/coordinator-route-entry.test.ts -t "continuation carry"
```

Expected: FAIL — `ensureOwnedPlanningOnRoute` takes 2 arguments and returns a route whose single item is titled "continue please".

- [ ] **Step 9: Add the carry type and the route field**

In `server-jarvis/src/orchestration/coordinator-route-entry.ts`, add after the imports:

```ts
import type { CreateTaskPlanItemInput } from "./task-run";

/**
 * Surviving plan state handed to route entry on a continuation turn.
 *
 * 2026-08-04 (run_085afdac): without this, a "continue please" follow-up on
 * the deterministic-fallback path authored a fresh single plan item from the
 * follow-up text and discarded the real multi-item ledger.
 */
export interface ContinuationPlanCarry {
  /** Non-verified items from the live TaskRun ledger, order preserved. */
  items: CreateTaskPlanItemInput[];
  /** Absolute paths most recently written in this task run, newest first. */
  lastWriteTargets: string[];
}
```

In `server-jarvis/src/orchestration/coordinator.ts`, add to the `CoordinatorResult` interface (beside the existing `plan_items` field around line 110):

```ts
  /** Write targets carried from the prior turn of a continuing task run. */
  continuation_write_targets?: string[];
```

- [ ] **Step 10: Implement the carry in `ensureOwnedPlanningOnRoute`**

Replace the whole function in `server-jarvis/src/orchestration/coordinator-route-entry.ts:124-140`:

```ts
export function ensureOwnedPlanningOnRoute(
  route: CoordinatorResult,
  message: string,
  carry?: ContinuationPlanCarry,
): CoordinatorResult {
  if (route.plan_authorship) return route;
  // Continuation turns re-seed the surviving ledger. Authoring from the
  // follow-up text here is what produced `plan_items: [{title:"continue
  // please"}]` live (2026-08-04, run_085afdac).
  if (carry && carry.items.length > 0) {
    return {
      ...route,
      plan_authorship: "conductor_direct",
      plan_items: carry.items,
      ...(carry.lastWriteTargets.length > 0
        ? { continuation_write_targets: carry.lastWriteTargets }
        : {}),
    };
  }
  const planning = attachOwnedPlanning(
    message,
    route.context?.estimated_complexity ?? "low",
    { taskType: route.task_type },
  );
  return {
    ...route,
    plan_authorship: planning.plan_authorship,
    plan_items: planning.plan_items,
    plan_brief: planning.plan_brief,
  };
}
```

Thread it through the entry orchestrator — add to `ResolveCoordinatorRouteEntryInput`:

```ts
  /** Surviving plan state when this turn continues a live task run. */
  continuationCarry?: ContinuationPlanCarry;
```

and change the call inside `resolveCoordinatorRouteEntry` (currently `route = ensureOwnedPlanningOnRoute(route, input.message);`):

```ts
  route = ensureOwnedPlanningOnRoute(route, input.message, input.continuationCarry);
```

- [ ] **Step 11: Run the test to verify it passes**

```bash
cd server-jarvis && bun test src/orchestration/coordinator-route-entry.test.ts
```

Expected: PASS — all tests in the file, including the 3 new ones.

- [ ] **Step 12: Wire the call site in the orchestrator**

In `server-jarvis/src/index.ts`, at the `resolveCoordinatorRouteEntry({...})` call (around line 2980), add the carry argument after `taskRunTurnCount`:

```ts
          continuationCarry: {
            items: unfinishedPlanItemInputs(activeTaskRun),
            lastWriteTargets: activeTaskRun.lastWriteTargets ?? [],
          },
```

Add `unfinishedPlanItemInputs` to the existing `./orchestration/task-run` import block in `index.ts`.

- [ ] **Step 13: Persist write targets after each turn**

In `server-jarvis/src/index.ts`, immediately after the `const evidenceCount = ...` assignment (around line 3496-3502), insert:

```ts
        // 2026-08-04: carry what this turn actually mutated into the contract so
        // the next continuation turn can re-read it instead of rediscovering.
        const turnWriteTargets = successfulToolCalls
          .filter((call) => TURN_WRITE_TOOLS.has(call.name))
          .flatMap((call) => collectToolPathTargets(call.arguments));
        if (turnWriteTargets.length > 0) {
          sessionMemory.updateTaskRun(sessionId, {
            lastWriteTargets: recordWriteTargets(
              sessionMemory.getTaskRun(sessionId) ?? activeTaskRun,
              turnWriteTargets,
            ).lastWriteTargets,
          });
        }
```

Add to the `index.ts` imports:

```ts
import { collectToolPathTargets } from "./orchestration/mid-loop-intervention";
import { recordWriteTargets } from "./orchestration/task-run";
```

`WRITE_EFFECT_TOOLS` exists in `pipeline.ts` and the eval modules but is declared module-private in each, so do not import it. Declare the set next to the other module-level constants at the top of `index.ts`:

```ts
/** Write-effect tools, for carrying this turn's mutation targets forward. */
const TURN_WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
```

This mirrors the existing private declarations in `conductor-replay.ts:125` and `conductor-performance.ts:144` — the codebase already repeats this set per module rather than sharing one export.

- [ ] **Step 14: Typecheck and run the full suite**

```bash
cd server-jarvis && bun run typecheck && bun test
```

Expected: typecheck clean; all tests pass.

- [ ] **Step 15: Commit**

```bash
git add server-jarvis/src/orchestration/coordinator-route-entry.ts server-jarvis/src/orchestration/coordinator-route-entry.test.ts server-jarvis/src/orchestration/coordinator.ts server-jarvis/src/index.ts && git commit -m "fix(orchestration): continuation turns inherit unfinished plan items and write targets"
```

---

## Task 2: Seed the read-set after a delegate handoff

**Root cause:** on `mid_loop_handoff` the native fallback receives the handoff note and the delegate's raw tool outputs, but nothing re-reads the file the delegate failed to write. In `run_085afdac` the fallback made zero tool calls and ended `executor_no_tool`.

**Files:**
- Create: `server-jarvis/src/orchestration/delegate-handoff-seed.ts`
- Create: `server-jarvis/src/orchestration/delegate-handoff-seed.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:2716-2725`

- [ ] **Step 1: Write the failing test**

Create `server-jarvis/src/orchestration/delegate-handoff-seed.test.ts`:

```ts
/**
 * 2026-08-04 (run_085afdac): after mid_loop_handoff the native fallback made
 * zero tool calls. It received the delegate transcript but never a fresh read
 * of the file the delegate had failed to write.
 */
import { describe, expect, test } from "bun:test";
import { selectHandoffSeedPaths } from "./delegate-handoff-seed";
import type { ToolCallRecord } from "./pipeline";

const call = (
  name: string,
  args: Record<string, unknown>,
  isError = false,
  output = "",
): ToolCallRecord =>
  ({ name, arguments: args, output, is_error: isError }) as ToolCallRecord;

describe("selectHandoffSeedPaths", () => {
  test("returns the failed write target", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [
        call("edit_file", { path: "C:\\p\\PluginEditor.h" }, true, "no match"),
      ],
      carriedWriteTargets: [],
    });
    expect(paths).toEqual(["C:\\p\\PluginEditor.h"]);
  });

  test("skips targets already read successfully in the delegate stream", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [
        call("read_file", { path: "C:\\p\\PluginEditor.h" }, false, "contents"),
        call("edit_file", { path: "C:\\p\\PluginEditor.h" }, true, "no match"),
      ],
      carriedWriteTargets: [],
    });
    expect(paths).toEqual([]);
  });

  test("falls back to carried write targets when no write was attempted", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [call("list_directory", { path: "C:\\p" })],
      carriedWriteTargets: ["C:\\p\\PluginProcessor.cpp"],
    });
    expect(paths).toEqual(["C:\\p\\PluginProcessor.cpp"]);
  });

  test("failed write targets rank before carried targets and dedupe", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [
        call("write_file", { path: "C:\\p\\A.cpp" }, true, "denied"),
      ],
      carriedWriteTargets: ["C:\\p\\B.cpp", "C:\\p\\A.cpp"],
    });
    expect(paths).toEqual(["C:\\p\\A.cpp", "C:\\p\\B.cpp"]);
  });

  test("is bounded to MAX_HANDOFF_SEED_PATHS", () => {
    const paths = selectHandoffSeedPaths({
      delegateCalls: [],
      carriedWriteTargets: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(paths.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/delegate-handoff-seed.test.ts
```

Expected: FAIL — `Cannot find module './delegate-handoff-seed'`.

- [ ] **Step 3: Implement the module**

Create `server-jarvis/src/orchestration/delegate-handoff-seed.ts`:

```ts
/**
 * Which files the native fallback must re-read after a delegate handoff.
 *
 * 2026-08-04 (run_085afdac): the delegate handed off after two failed writes
 * to `PluginEditor.h`; the native fallback then produced zero tool calls. It
 * had the delegate transcript but no current on-disk text to compose an edit
 * against. `edit_file` needs exact text to match, so the handoff seeds a fresh
 * read of the targets the delegate was working on.
 */

import type { ToolCallRecord } from "./pipeline";
import { collectToolPathTargets } from "./mid-loop-intervention";

/** Upper bound on seeded reads — the handoff must not become its own spiral. */
export const MAX_HANDOFF_SEED_PATHS = 3;

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const READ_TOOLS = new Set(["read_file", "Read"]);

export interface HandoffSeedInput {
  /** Tool calls observed on the delegate stream, in order. */
  delegateCalls: readonly ToolCallRecord[];
  /** Write targets carried from earlier turns of this task run, newest first. */
  carriedWriteTargets: readonly string[];
}

/**
 * Paths the native fallback should read before attempting a write, ordered
 * failed-write-targets first, then carried targets. Paths already read
 * successfully during the delegate stream are omitted — their contents are
 * already in the carried transcript.
 */
export function selectHandoffSeedPaths(input: HandoffSeedInput): string[] {
  const alreadyRead = new Set<string>();
  for (const call of input.delegateCalls) {
    if (!READ_TOOLS.has(call.name) || call.is_error) continue;
    for (const path of collectToolPathTargets(call.arguments)) {
      alreadyRead.add(path);
    }
  }

  const failedWriteTargets: string[] = [];
  for (const call of input.delegateCalls) {
    if (!WRITE_TOOLS.has(call.name) || !call.is_error) continue;
    for (const path of collectToolPathTargets(call.arguments)) {
      failedWriteTargets.push(path);
    }
  }

  const ordered: string[] = [];
  for (const path of [...failedWriteTargets, ...input.carriedWriteTargets]) {
    if (!path || alreadyRead.has(path) || ordered.includes(path)) continue;
    ordered.push(path);
  }
  return ordered.slice(0, MAX_HANDOFF_SEED_PATHS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server-jarvis && bun test src/orchestration/delegate-handoff-seed.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Wire the seed into the handoff path**

In `server-jarvis/src/orchestration/pipeline.ts`, replace the handoff block at lines 2716-2721:

```ts
        if (conductorHandoff && midLoopStop?.kind === "handoff") {
          executorMessages.push({
            role: "user",
            content: `[Conductor mid-loop] ${midLoopStop.note}`,
          });
          // Seed current on-disk text for the targets the delegate was editing.
          // Without this the native fallback starts blind and (2026-08-04,
          // run_085afdac) emits nothing at all.
          const seedPaths = selectHandoffSeedPaths({
            delegateCalls: delegated.toolCalls,
            carriedWriteTargets: options.taskRunContract?.lastWriteTargets ?? [],
          });
          for (const path of seedPaths) {
            const seeded = await this.readFileForSeed(path, options);
            if (!seeded) continue;
            toolCalls.push(seeded);
            executorMessages.push({
              role: "user",
              content:
                `[Runtime handoff seed] Current contents of ${path} — ` +
                `match this text exactly when composing edit_file.\n${seeded.output}`,
            });
          }
        }
```

Add to the `pipeline.ts` imports:

```ts
import { selectHandoffSeedPaths } from "./delegate-handoff-seed";
```

- [ ] **Step 6: Add the seed reader helper**

Add this private method to the pipeline class, directly above `runDelegate`'s enclosing method (place it beside the existing `markReadLedgerForCall` helper so the file's read-path helpers stay together):

```ts
  /**
   * Read one file as a runtime-issued tool call for handoff seeding. Returns
   * undefined when the read fails or the path is outside evidence roots — a
   * failed seed must never block the fallback attempt.
   */
  private async readFileForSeed(
    path: string,
    options: ExecutorStageOptions,
  ): Promise<ToolCallRecord | undefined> {
    try {
      const records = await this.dispatchToolCalls(
        [{ name: "read_file", arguments: { path } }],
        options,
      );
      const record = records[0];
      if (!record || record.is_error || !record.output?.trim()) return undefined;
      this.markReadLedgerForCall(record, record.output);
      return record;
    } catch {
      return undefined;
    }
  }
```

If `dispatchToolCalls` has a different arity in this class, match the existing call site used by the native executor loop — the requirement is only that the seed goes through the same tool dispatch (so scope enforcement and the read ledger both apply), not that it uses any particular overload.

- [ ] **Step 7: Typecheck and run the orchestration suite**

```bash
cd server-jarvis && bun run typecheck && bun test src/orchestration
```

Expected: typecheck clean; all orchestration tests pass.

- [ ] **Step 8: Commit**

```bash
git add server-jarvis/src/orchestration/delegate-handoff-seed.ts server-jarvis/src/orchestration/delegate-handoff-seed.test.ts server-jarvis/src/orchestration/pipeline.ts && git commit -m "fix(delegate): seed current file contents into native fallback after handoff"
```

---

## Task 3: Make the force-write nudge cap actually engage, at 2

**Root cause:** `FORCE_WRITE_NUDGE_CAP` is 3, and `writeEffectNudgeCount` only advances when a decision carries `noteKind === "force_write"` (`pipeline.ts:2179`). The deterministic-reflex notes that fired ~30 times in `run_cc660a4d` do not set `noteKind`, so the counter stayed near zero and the cap never bound. Lowering the constant alone is inert.

**Files:**
- Modify: `server-jarvis/src/orchestration/mid-loop-intervention.ts:173` and the force-write decision builders
- Test: `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`:

```ts
describe("force-write nudge cap engages on every force_write decision", () => {
  const writeSignal = (forceWriteNudgesSent: number) => ({
    writeIntent: true,
    successfulWrites: 0,
    failedWrites: 0,
    distinctSuccessfulReads: 8,
    toolCallsEmitted: true,
    turnCount: 3,
    maxTurns: 12,
    forceWriteNudgesSent,
    planItemsTotal: 1,
    planItemsRemaining: 1,
  });

  test("every force_write decision is tagged noteKind so the host can count it", () => {
    const decision = decideMidLoopIntervention(writeSignal(0));
    if (decision.kind !== "force_write") {
      throw new Error(`expected force_write, got ${decision.kind}`);
    }
    expect(decision.noteKind).toBe("force_write");
  });

  test("stops deciding force_write once the cap is reached", () => {
    const decision = decideMidLoopIntervention(writeSignal(FORCE_WRITE_NUDGE_CAP));
    expect(decision.kind).not.toBe("force_write");
  });

  test("cap is 2 — one statement, one escalation", () => {
    expect(FORCE_WRITE_NUDGE_CAP).toBe(2);
  });
});
```

`decideMidLoopIntervention` is exported from `./mid-loop-intervention:640` and takes a `MidLoopSignal`. Add it and `FORCE_WRITE_NUDGE_CAP` to the file's existing import block. If `MidLoopSignal` requires fields beyond those in `writeSignal`, copy the defaults from the neighbouring tests in this file — the three assertions above are what must hold.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts -t "force-write nudge cap engages"
```

Expected: FAIL — `FORCE_WRITE_NUDGE_CAP` is 3, and at least one force-write branch returns a decision with `noteKind` undefined.

- [ ] **Step 3: Lower the cap**

In `server-jarvis/src/orchestration/mid-loop-intervention.ts`, replace lines 161-173:

```ts
/**
 * Same discipline for the force-write reflex.
 *
 * 2026-08-01: introduced at 3, matched to the press path.
 * 2026-08-04 (run_cc660a4d): the cap never engaged — ~30 near-identical
 * force-write notes were decided in one stage because `writeEffectNudgeCount`
 * only advances for decisions tagged `noteKind === "force_write"`, and the
 * deterministic-reflex branches left that tag unset. Every force-write branch
 * now sets the tag, and the cap drops to 2: one statement, one escalation,
 * matching PLAN_REMAINDER_NUDGE_CAP. A note ignored twice will not work a
 * third time, and each repeat costs a model round-trip plus transcript
 * re-upload.
 */
export const FORCE_WRITE_NUDGE_CAP = 2;
```

- [ ] **Step 4: Tag every force-write decision**

In `server-jarvis/src/orchestration/mid-loop-intervention.ts`, find every `return` that produces `{ kind: "force_write", ... }` (the builders around lines 678, 838, and 885 are the known sites — search the file for `kind: "force_write"` to catch all). Ensure each carries the tag:

```ts
      return {
        kind: "force_write",
        note,
        noteKind: "force_write",
        decisionSource: "deterministic_reflex",
      };
```

Preserve each site's existing `decisionSource` where it already sets one (e.g. `resident_model`); only `noteKind` is being added.

- [ ] **Step 5: Guard the decision branch on the cap**

At the force-write decision branch (`mid-loop-intervention.ts:678`), the condition already reads `(signal.forceWriteNudgesSent ?? 0) < FORCE_WRITE_NUDGE_CAP`. Confirm the same guard exists on the builders at lines 838 and 885; where it is missing, add an early return before the note is built:

```ts
  const sent = signal.forceWriteNudgesSent ?? 0;
  if (sent >= FORCE_WRITE_NUDGE_CAP) return { kind: "continue" };
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts
```

Expected: PASS — the full file, including the 3 new tests.

- [ ] **Step 7: Verify the host counter advances on the delegate path**

In `server-jarvis/src/orchestration/pipeline.ts:2179`, the increment is already gated on `midLoop.noteKind === "force_write"`. With Step 4 applied, deferred delegate interventions now advance it too. Confirm no second gate suppresses it by reading the surrounding `recordMidLoopDirective` body, and leave it unchanged if the increment is unconditional on that tag.

- [ ] **Step 8: Run the full suite**

```bash
cd server-jarvis && bun run typecheck && bun test
```

Expected: typecheck clean; all tests pass. If a pre-existing test asserts `FORCE_WRITE_NUDGE_CAP === 3`, update that assertion to 2 and note the date in its comment — do not weaken the new tests.

- [ ] **Step 9: Commit**

```bash
git add server-jarvis/src/orchestration/mid-loop-intervention.ts server-jarvis/src/orchestration/mid-loop-intervention.test.ts && git commit -m "fix(supervision): tag every force_write decision so the nudge cap engages, lower cap to 2"
```

---

## Task 4: Fail fast instead of burning the stage window on a slow local model

**Root cause:** `preferLocalForStage` routes planner and reviewer to local Ollama whenever Ollama is healthy, with no check that the local model can finish inside the remaining stage window. In `run_cc660a4d` the reviewer's local call errored at 33s and the stage still burned to `Stage deadline exceeded (120000ms)`; planner timed out at 56.3s inside a 158s stage.

**Files:**
- Modify: `server-jarvis/src/orchestration/agent-pool.ts:453-457`
- Test: `server-jarvis/src/orchestration/agent-pool.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/agent-pool.test.ts`:

```ts
describe("local stage picks respect the remaining stage window", () => {
  test("refuses a local pick when the window cannot fit a local attempt", () => {
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    const pick = pool.pickFor("reviewer", "refactor", undefined, {
      ollamaAvailable: true,
      localModels: ["qwen3.5:4b"],
      remainingStageMs: LOCAL_STAGE_MIN_WINDOW_MS - 1,
    });
    expect(pick?.provider).not.toBe("ollama");
  });

  test("allows a local pick when the window is wide enough", () => {
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    const pick = pool.pickFor("reviewer", "refactor", undefined, {
      ollamaAvailable: true,
      localModels: ["qwen3.5:4b"],
      remainingStageMs: LOCAL_STAGE_MIN_WINDOW_MS + 1,
    });
    expect(pick?.provider).toBe("ollama");
  });

  test("an unspecified window still allows local (no regression for callers without budgets)", () => {
    const pool = new AgentPool(DEFAULT_ORCHESTRATOR_AGENTS);
    const pick = pool.pickFor("reviewer", "refactor", undefined, {
      ollamaAvailable: true,
      localModels: ["qwen3.5:4b"],
    });
    expect(pick?.provider).toBe("ollama");
  });
});
```

Match the import block and `AgentPool` construction to the existing tests in that file; add `LOCAL_STAGE_MIN_WINDOW_MS` to the `./agent-pool` import.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/agent-pool.test.ts -t "local stage picks respect"
```

Expected: FAIL — `LOCAL_STAGE_MIN_WINDOW_MS` is not exported, and the narrow-window case currently returns an ollama agent.

- [ ] **Step 3: Add the window floor**

In `server-jarvis/src/orchestration/agent-pool.ts`, directly after `DEFAULT_LOCAL_STAGE_MODELS` (line 322):

```ts
/**
 * Minimum remaining stage window for a local Ollama pick to be worth taking.
 *
 * 2026-08-04 (run_cc660a4d): reviewer routed to qwen3.5:4b, the call errored
 * at 33s, and the stage still burned to its 120s deadline with nothing to show.
 * Planner showed the same shape (56.3s model timeout inside a 158s stage). A
 * local lane that cannot plausibly complete AND leave room for the remote
 * cascade is worse than going remote immediately.
 */
export const LOCAL_STAGE_MIN_WINDOW_MS = 75_000;
```

- [ ] **Step 4: Enforce it at the local-preference branch**

Replace `agent-pool.ts:453-457`:

```ts
    if (preferLocalForStage(stage) && selection.ollamaAvailable) {
      // Fail fast rather than spend the stage window on a local lane that
      // cannot finish and still leave room for the remote cascade.
      const window = selection.remainingStageMs;
      const windowAllowsLocal =
        typeof window !== "number"
        || !Number.isFinite(window)
        || window >= LOCAL_STAGE_MIN_WINDOW_MS;
      if (windowAllowsLocal) {
        candidates = this.injectLocalStageCandidates(candidates, exclude, selection);
        const localPick = this.pickPreferredLocal(candidates, stage, selection);
        if (localPick) return localPick;
      }
    }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server-jarvis && bun test src/orchestration/agent-pool.test.ts
```

Expected: PASS — the full file, including the 3 new tests.

- [ ] **Step 6: Confirm the caller already passes a window**

`index.ts` computes `remainingStageMsForPick` (around line 1805) and passes it as `modelSelection.remainingStageMs`. Read that block and confirm it is threaded into the `pickFor` call for planner and reviewer. If it is not, pass it — the guard is inert without a real window.

- [ ] **Step 7: Typecheck and run the full suite**

```bash
cd server-jarvis && bun run typecheck && bun test
```

Expected: typecheck clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add server-jarvis/src/orchestration/agent-pool.ts server-jarvis/src/orchestration/agent-pool.test.ts && git commit -m "fix(routing): refuse local stage lane when the remaining stage window is too narrow"
```

---

## Task 5: Abort early when a full_execution executor produces zero tools

**Root cause:** `decideExecutorProgress` returns `"continue"` immediately when `writeIntent` is false. In `run_94cdcfdf` the contract's write intent was lost, so a `full_execution` turn ran an executor that emitted zero tool calls, then planner, reviewer, and synthesizer, and died at `Total turn deadline (150000ms) exceeded at stage=synthesizer`. Keying the bound to the turn *requirement* — which was correctly `full_execution` — catches this independently of the contract.

**Files:**
- Modify: `server-jarvis/src/orchestration/executor-progress-policy.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (pass requirement, emit typed frame)
- Test: `server-jarvis/src/orchestration/executor-progress-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/executor-progress-policy.test.ts`:

```ts
describe("full_execution zero-tool early abort", () => {
  const base = {
    writeIntent: false,
    emittedToolCalls: false,
    successfulWrites: 0,
    consecutiveNoToolTurns: 1,
    stageRemainingMs: 60_000,
    anyToolCallThisStage: false,
    noToolTurns: 1,
    executorTurns: 1,
  };

  test("stops partial when a full_execution turn produced no tools, even without writeIntent", () => {
    expect(
      decideExecutorProgress({ ...base, requirement: "full_execution" }),
    ).toBe("stop_partial");
  });

  test("does not fire once a tool call has landed", () => {
    expect(
      decideExecutorProgress({
        ...base,
        requirement: "full_execution",
        emittedToolCalls: true,
      }),
    ).toBe("continue");
  });

  test("does not fire for non-full_execution requirements", () => {
    expect(
      decideExecutorProgress({ ...base, requirement: "workspace_read" }),
    ).toBe("continue");
  });

  test("existing writeIntent behaviour is unchanged when requirement is absent", () => {
    expect(
      decideExecutorProgress({ ...base, writeIntent: true, consecutiveNoToolTurns: 1 }),
    ).toBe("retry_strong");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server-jarvis && bun test src/orchestration/executor-progress-policy.test.ts -t "full_execution zero-tool"
```

Expected: FAIL — `requirement` is not on `ExecutorProgressInput`, and the first case returns `"continue"`.

- [ ] **Step 3: Extend the input type**

In `server-jarvis/src/orchestration/executor-progress-policy.ts`, add to `ExecutorProgressInput` (after `executorTurns`):

```ts
  /**
   * This turn's classified requirement. When `full_execution`, a stage that
   * emits no tool call at all is a failure regardless of `writeIntent`.
   *
   * 2026-08-04 (run_94cdcfdf): the task-run contract's write intent was lost
   * on a continuation, so `writeIntent` was false while the requirement was
   * correctly `full_execution`. The executor emitted zero tools and the turn
   * still ran planner, reviewer, and synthesizer into the 150s turn deadline.
   */
  requirement?: string;
```

- [ ] **Step 4: Add the early-abort branch**

In the same file, insert at the very top of `decideExecutorProgress`, before the `writeIntent` guard:

```ts
  // Requirement-keyed floor: independent of the write contract, which is the
  // thing that failed in run_94cdcfdf.
  if (
    input.requirement === "full_execution"
    && !input.emittedToolCalls
    && input.successfulWrites === 0
    && !input.anyToolCallThisStage
    && (input.consecutiveNoToolTurns ?? 0) >= 1
  ) {
    return "stop_partial";
  }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server-jarvis && bun test src/orchestration/executor-progress-policy.test.ts
```

Expected: PASS — the full file, including the 4 new tests.

- [ ] **Step 6: Pass the requirement at the call site**

In `server-jarvis/src/orchestration/pipeline.ts`, find the `decideExecutorProgress({` call and add the requirement to the argument object:

```ts
              requirement: options.turnRequirement,
```

If `ExecutorStageOptions` has no `turnRequirement` field, add it:

```ts
  /** This turn's classified requirement, for the requirement-keyed no-tool floor. */
  turnRequirement?: string;
```

and populate it from `index.ts` where the pipeline options object is built, using the existing `turnReq.requirement` value.

- [ ] **Step 7: Emit a clear error frame instead of a silent partial**

At the `stop_partial` handling site in `pipeline.ts` (search for the branch that sets `partial_error_code` to `executor_no_tool`), ensure the narrative names the cause rather than ending empty:

```ts
            narratives.push(
              "[Runtime] Execution stopped: this turn required file changes but the " +
              "executor produced no tool calls. No files were modified.",
            );
```

Leave the existing `executor_no_tool` error code unchanged — the replay harness and `conductor-performance.ts` both key on it.

- [ ] **Step 8: Typecheck and run the full suite**

```bash
cd server-jarvis && bun run typecheck && bun test
```

Expected: typecheck clean; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add server-jarvis/src/orchestration/executor-progress-policy.ts server-jarvis/src/orchestration/executor-progress-policy.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/index.ts && git commit -m "fix(executor): abort full_execution turns that produce zero tool calls"
```

---

## Task 6: Verify against the replay harness and the live evidence store

**Files:**
- Run only — no source changes unless a regression appears.

- [ ] **Step 1: Full suite and typecheck**

```bash
cd server-jarvis && bun run typecheck && bun test
```

Expected: typecheck clean; the whole suite green. Fix any failure before continuing — a red suite here means one of Tasks 1-5 broke an existing invariant.

- [ ] **Step 2: Replay the recorded production classes**

```bash
cd server-jarvis && bun scripts/replay-conductor.ts --limit 500 --json
```

Expected: no new violation classes versus the pre-change run. The harness already catches nudge spam, delegate no-write, and reviewer deadline — those counts should fall, not rise.

- [ ] **Step 3: Capture the before/after benchmark**

```bash
cd server-jarvis && bun scripts/benchmark-conductor-completion.ts --limit 500 --json
```

Record `executorNoToolRatio`, `writesLandedPerRun`, and the delegate verified-write rate. These are the release-gate axes in `docs/delegate-era-baseline.md`.

- [ ] **Step 4: Re-query the morning session to confirm the fixtures still reproduce**

```bash
cd server-jarvis && bun scripts/replay-conductor.ts --limit 50 --json
```

The four runs from session `dec0a92e` must still be present in the evidence store — this plan changes runtime behaviour, not history. If they are absent, the DB path is wrong; check `~/.openclaw/jarvis/self-tuning.db`.

- [ ] **Step 5: Commit any harness threshold updates**

```bash
git add -A && git commit -m "chore(eval): record post-fix replay and benchmark baseline"
```

---

## Verification Checklist

Each fault maps to a task and a test that fails before the change:

| Fault (evidence) | Task | Failing test |
|---|---|---|
| `plan_items: [{title:"continue please"}]` (`run_085afdac`) | 1 | `ensureOwnedPlanningOnRoute continuation carry` |
| `executor_no_tool` after `mid_loop_handoff` (`run_085afdac`) | 2 | `selectHandoffSeedPaths` |
| ~30 near-identical force-write notes (`run_cc660a4d`) | 3 | `force-write nudge cap engages` |
| `Stage deadline exceeded (120000ms)` on reviewer (`run_cc660a4d`) | 4 | `local stage picks respect the remaining stage window` |
| Zero-tool executor into `turn_deadline` (`run_94cdcfdf`) | 5 | `full_execution zero-tool early abort` |

## Known Limitation

Tasks 1-5 fix the five faults as scoped. Task 1 restores the plan ledger and write targets across continuations, but the sticky `writeIntent` de-escalation that caused `delegate_skip reason=write_not_required` in `run_94cdcfdf` is **not** addressed here — the contract-authority reconciliation between `turn-budget.ts` (`full_execution`) and `claude-delegate.ts` (`write_not_required`) is out of scope for this plan. Task 5's requirement-keyed floor bounds the damage (the turn now aborts in one stage instead of four) but does not restore the delegate. Track separately.
