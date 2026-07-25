# Trustworthy In-Turn Conductor (Rungs 1+2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the conductor's completion verdicts topology-invariant (Rung 1), and give it real-time ownership of the executor's tool-call loop — deterministic reflexes for the obvious cases, resident-model escalation for the ambiguous middle (Rung 2, Approach C) — then A/B two candidate local models in the resident-conductor role to validate the "better supervision lifts a sub-par executor" thesis.

**Architecture:** Two one-line fixes close the Rung-1 fence gap in `PipelineExecutor.execute()`. A new pure `mid-loop-intervention.ts` module decides a `LoopIntervention` from turn-loop counters (zero inference); `LiveConductor` gains a `checkMidLoop` method that applies the reflex and, only when it's inconclusive, escalates once through the *already-wired* resident conductor (`supervisorModel` → `PersistentConductor.supervise`). The executor turn loop in `pipeline.ts` calls it alongside the existing write-effect nudge check and enacts whatever it returns — inject, force-write, redirect, or abort-with-clean-partial. A final phase stands up both downloaded GGUFs as swappable resident-conductor configs and A/B's them.

**Tech Stack:** TypeScript, Bun (`bun test`), Ollama (resident conductor model swap). Spec: `docs/superpowers/specs/2026-07-25-trustworthy-in-turn-conductor-design.md`.

---

## File Structure

**New files:**
- `server-jarvis/src/orchestration/mid-loop-intervention.ts` — `LoopIntervention` type + pure `decideMidLoopIntervention()` reflex function.
- `server-jarvis/src/orchestration/mid-loop-intervention.test.ts` — unit tests for the reflex rules.

**Modified files:**
- `server-jarvis/src/orchestration/pipeline.ts` — Rung 1: two `evaluateEffectGate` fixes in `execute()` (~L3941, ~L3983). Rung 2: wire `checkMidLoop` into `runExecutorStage`'s turn loop (~L2141-2168) and enact its result.
- `server-jarvis/src/orchestration/conductor.ts` — new `checkMidLoop()` method on `LiveConductor`, reusing `this.supervisorModel` for escalation; new escalation counter (reset in `setContext`).
- `server-jarvis/src/orchestration/conductor.test.ts` — tests for `checkMidLoop` (reflex fast-paths + escalation).
- `server-jarvis/src/orchestration.test.ts` — new cross-topology Rung-1 regression test.
- `server-jarvis/src/config.ts` — new `orchestrator.conductor.in_turn_driver` block (default off).
- `server-jarvis/prompts/conductor.md` — short section for the new mid-loop escalation prompt.

**Operational (no new source files):** Ollama Modelfiles for the two candidate GGUFs; an eval-harness A/B run.

---

## Phase 1 — Rung 1: topology-invariant trust

### Task 1.1: Thread write-intent into both `execute()` fallback gate calls

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts:3941-3947` and `:3983-3988`
- Test: `server-jarvis/src/orchestration.test.ts`

Context: `PipelineExecutor.execute(request, pipeline, agentRunId, onStateChange, options)` has two `evaluateEffectGate({...})` fallback calls that omit `request`/`assumeWriteIntent` — every other call site in the file passes both (e.g. `evaluateEffectGate({ profile, executor: candidateOne, request: intentText, assumeWriteIntent: options.taskRunWriteIntent, ... })` at ~L3452). Without them, write-intent collapses to "is the profile `full`?", so a zero-write turn on a non-`full`/recursive route sails through as `success`.

- [ ] **Step 1: Write the failing test**

In `orchestration.test.ts`, add (near the other effect-gate / topology tests — search for `"topology"` or `"recursive"` for a nearby anchor):
```ts
test("a zero-write, write-intent turn is caught regardless of topology", async () => {
  const runtime = createToolRuntime();
  const ctx = makeExecutionContext("agent", defaultConfig());
  const callModel = async (_messages: any[], options: any = {}) => {
    if (options.stageLabel === "executor") return { content: "Here is what I would change...", tool_calls: [] };
    return { content: "done", tool_calls: [] };
  };
  const ex = new PipelineExecutor(callModel as any, runtime, ctx, { collector: testCollector });

  for (const topology of ["linear", "recursive"] as const) {
    const result = await ex.execute(
      "please fix the bug in solution.py",
      ["executor", "synthesizer"],
      `run-topology-${topology}`,
      () => {},
      { executionProfile: "full", topology },
    );
    expect(result.outcome).not.toBe("success");
    expect(result.error_code).toBe("effect_gate_no_write_effect");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration.test.ts -t "regardless of topology"`
Expected: FAIL on the `"recursive"` iteration (or both) — `outcome` comes back `"success"` instead of gated.

- [ ] **Step 3: Fix both call sites**

In `pipeline.ts`, the first fallback (~L3941):
```ts
        segment.effectGate ?? evaluateEffectGate({
          profile: options.executionProfile ?? "full",
          executor: state.executor,
          rewriter: state.rewriter,
          request,
          assumeWriteIntent: options.taskRunWriteIntent,
          contentEffects: this.ctx.write_effects,
        }),
```
The second fallback (~L3983):
```ts
      segment.effectGate ?? evaluateEffectGate({
        profile: options.executionProfile ?? "full",
        executor: state.executor,
        rewriter: state.rewriter,
        request,
        assumeWriteIntent: options.taskRunWriteIntent,
        contentEffects: this.ctx.write_effects,
      }),
```
(`request` is `execute()`'s own parameter — already in scope; no new plumbing needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration.test.ts -t "regardless of topology"`
Expected: PASS (both topology iterations gated).

- [ ] **Step 5: Run the full suite**

Run: `cd server-jarvis && bun test`
Expected: all pass (no other test depended on the old under-gated behavior).

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration.test.ts
git commit -m "fix(pipeline): thread write-intent into execute()'s fallback effect-gate calls"
```

---

## Phase 2 — Rung 2: the intervention vocabulary + deterministic reflexes

### Task 2.1: `LoopIntervention` type + pure reflex decision

**Files:**
- Create: `server-jarvis/src/orchestration/mid-loop-intervention.ts`
- Test: `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { decideMidLoopIntervention } from "./mid-loop-intervention";

const base = {
  writeIntent: true,
  successfulWrites: 0,
  distinctSuccessfulReads: 0,
  turnCount: 3,
  maxTurns: 20,
  stageRemainingMs: 300_000,
  deadToolSuppressed: false,
  suppressedToolName: undefined as string | undefined,
};

describe("decideMidLoopIntervention", () => {
  test("no signal → continue", () => {
    expect(decideMidLoopIntervention(base)).toEqual({ kind: "continue" });
  });

  test("dead tool suppressed → redirect", () => {
    const d = decideMidLoopIntervention({ ...base, deadToolSuppressed: true, suppressedToolName: "glob" });
    expect(d).toMatchObject({ kind: "redirect", tool: "glob" });
  });

  test("write-intent, many reads, zero writes, budget still comfortable → force_write", () => {
    const d = decideMidLoopIntervention({
      ...base, distinctSuccessfulReads: 6, stageRemainingMs: 120_000,
    });
    expect(d.kind).toBe("force_write");
  });

  test("write-intent, zero writes, budget critical → abort (not a timeout)", () => {
    const d = decideMidLoopIntervention({
      ...base, distinctSuccessfulReads: 10, stageRemainingMs: 20_000,
    });
    expect(d).toMatchObject({ kind: "abort" });
    expect((d as any).reason).toContain("budget");
  });

  test("no write intent → never forces or aborts on write grounds", () => {
    const d = decideMidLoopIntervention({
      ...base, writeIntent: false, distinctSuccessfulReads: 20, stageRemainingMs: 5_000,
    });
    expect(d).toEqual({ kind: "continue" });
  });

  test("writes already happened → continue even with low budget", () => {
    const d = decideMidLoopIntervention({
      ...base, successfulWrites: 2, distinctSuccessfulReads: 10, stageRemainingMs: 5_000,
    });
    expect(d).toEqual({ kind: "continue" });
  });

  test("ambiguous middle (some reads, budget not yet critical) is NOT a reflex decision", () => {
    const d = decideMidLoopIntervention({
      ...base, distinctSuccessfulReads: 3, stageRemainingMs: 200_000,
    });
    expect(d).toEqual({ kind: "continue" }); // reflex stays quiet; escalation handled by the conductor, not this pure function
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the type + reflex function**

```ts
export type LoopIntervention =
  | { kind: "continue" }
  | { kind: "inject"; note: string }
  | { kind: "force_write"; note: string }
  | { kind: "redirect"; tool: string; note: string }
  | { kind: "abort"; reason: string };

export interface MidLoopSignal {
  writeIntent: boolean;
  successfulWrites: number;
  distinctSuccessfulReads: number;
  turnCount: number;
  maxTurns: number;
  /** Remaining wall-clock budget for the executor stage, ms. */
  stageRemainingMs: number;
  deadToolSuppressed: boolean;
  suppressedToolName?: string;
}

/** Thresholds are deliberately conservative: reflexes fire only on the
 * unambiguous cases. The middle ground (some reads, budget not yet critical)
 * is left for resident-model escalation — see conductor.ts checkMidLoop. */
const SPIRAL_READ_FLOOR = 5;
const FORCE_WRITE_BUDGET_FLOOR_MS = 150_000;   // still time to recover after a nudge
const ABORT_BUDGET_FLOOR_MS = 30_000;          // not enough runway left to recover

/** Zero-inference reflex decision for one executor turn-loop iteration. */
export function decideMidLoopIntervention(signal: MidLoopSignal): LoopIntervention {
  if (signal.deadToolSuppressed && signal.suppressedToolName) {
    return {
      kind: "redirect",
      tool: signal.suppressedToolName,
      note: `${signal.suppressedToolName} has failed structurally and will not succeed this turn — use an alternative tool.`,
    };
  }

  if (!signal.writeIntent || signal.successfulWrites > 0) {
    return { kind: "continue" };
  }

  if (signal.distinctSuccessfulReads >= SPIRAL_READ_FLOOR) {
    if (signal.stageRemainingMs <= ABORT_BUDGET_FLOOR_MS) {
      return {
        kind: "abort",
        reason: `write-intent turn with ${signal.distinctSuccessfulReads} reads and zero writes; ` +
          `remaining budget (${Math.round(signal.stageRemainingMs / 1000)}s) is too low to recover — ` +
          `ending now with a clean partial instead of running to the timeout.`,
      };
    }
    if (signal.stageRemainingMs <= FORCE_WRITE_BUDGET_FLOOR_MS) {
      return {
        kind: "force_write",
        note: `${signal.distinctSuccessfulReads} reads and zero writes so far — apply the change with a write tool now.`,
      };
    }
  }

  return { kind: "continue" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/mid-loop-intervention.ts server-jarvis/src/orchestration/mid-loop-intervention.test.ts
git commit -m "feat(conductor): pure mid-loop intervention reflex (Rung 2 deterministic path)"
```

---

## Phase 3 — Resident-model escalation on `LiveConductor`

### Task 3.1: `LiveConductor.checkMidLoop` — reflex fast-path + bounded escalation

**Files:**
- Modify: `server-jarvis/src/orchestration/conductor.ts`
- Modify: `server-jarvis/src/orchestration/conductor.test.ts`

Context: `LiveConductor` already has `private supervisorModel: CallModelFn` wired in its constructor (bound in `index.ts` to `persistentConductor.supervise(...)` via `localSupervisor`), and a private `supervise()` method that builds a prompt, races a timeout, and parses a directive. `checkMidLoop` reuses the same `this.supervisorModel` call path with its own compact prompt — no new wiring to `index.ts` is needed.

- [ ] **Step 1: Write the failing test**

In `conductor.test.ts` (mirror the existing `new LiveConductor(...)` fixture pattern already in the file):
```ts
describe("checkMidLoop", () => {
  const baseSignal = {
    writeIntent: true, successfulWrites: 0, distinctSuccessfulReads: 3,
    turnCount: 5, maxTurns: 20, stageRemainingMs: 200_000,
    deadToolSuppressed: false, suppressedToolName: undefined,
  };

  test("reflex fast-path never calls the supervisor model", async () => {
    let called = false;
    const conductor = new LiveConductor(
      async () => ({ content: "{}" }), new ConductorBus(), new AgentPool([]),
      { supervision_timeout_ms: 1000, max_tool_errors_before_reroute: 3, supervise_low_complexity: true },
      async () => { called = true; return { content: "{}" }; },
    );
    conductor.setContext("general", "medium", "run-1");
    const result = await conductor.checkMidLoop({ ...baseSignal, deadToolSuppressed: true, suppressedToolName: "glob" });
    expect(result).toMatchObject({ kind: "redirect", tool: "glob" });
    expect(called).toBe(false);
  });

  test("ambiguous middle escalates to the resident supervisor and applies its directive", async () => {
    const supervisorModel = async () => ({ content: JSON.stringify({ directive: "abort_stage", stage: "executor", reason: "spiral" }) });
    const conductor = new LiveConductor(
      async () => ({ content: "{}" }), new ConductorBus(), new AgentPool([]),
      { supervision_timeout_ms: 2000, max_tool_errors_before_reroute: 3, supervise_low_complexity: true },
      supervisorModel,
    );
    conductor.setContext("general", "medium", "run-2");
    const result = await conductor.checkMidLoop(baseSignal); // 3 reads, budget comfortable → ambiguous
    expect(result.kind).toBe("abort");
  });

  test("escalation is capped per turn — further ambiguous calls fall back to continue", async () => {
    let calls = 0;
    const supervisorModel = async () => { calls++; return { content: JSON.stringify({ directive: "continue" }) }; };
    const conductor = new LiveConductor(
      async () => ({ content: "{}" }), new ConductorBus(), new AgentPool([]),
      { supervision_timeout_ms: 2000, max_tool_errors_before_reroute: 3, supervise_low_complexity: true },
      supervisorModel,
    );
    conductor.setContext("general", "medium", "run-3");
    for (let i = 0; i < 5; i++) await conductor.checkMidLoop(baseSignal);
    expect(calls).toBeLessThanOrEqual(3); // bounded, mirrors the existing 4/run stage-supervision cap
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/conductor.test.ts -t "checkMidLoop"`
Expected: FAIL — `checkMidLoop` not defined.

- [ ] **Step 3: Implement `checkMidLoop` on `LiveConductor`**

Add the import at the top of `conductor.ts`:
```ts
import { decideMidLoopIntervention, type LoopIntervention, type MidLoopSignal } from "./mid-loop-intervention";
```
Add a field (near the other per-run counters, alongside `supervisionCallsUsed`):
```ts
  /** Rung 2: per-run cap on mid-loop resident-model escalations. */
  private midLoopEscalationsUsed = 0;
  private static readonly MAX_MID_LOOP_ESCALATIONS = 3;
```
Reset it in `setContext` alongside `this.supervisionCallsUsed = 0;`:
```ts
    this.midLoopEscalationsUsed = 0;
```
Add the public method (near `onToolResult`/`afterStage`):
```ts
  /**
   * Rung 2: real-time in-turn ownership. Deterministic reflexes handle the
   * unambiguous cases with zero inference; only the ambiguous middle (some
   * signal, but not enough to trust a reflex) escalates to the resident
   * conductor, bounded per run so cost stays predictable.
   */
  async checkMidLoop(signal: MidLoopSignal): Promise<LoopIntervention> {
    const reflex = decideMidLoopIntervention(signal);
    if (reflex.kind !== "continue") return reflex;

    // Only escalate when there is SOME signal worth asking about — a clean
    // turn with no reads/writes yet must not spend an inference for nothing.
    const worthAsking = signal.writeIntent && signal.successfulWrites === 0 && signal.distinctSuccessfulReads > 0;
    if (!worthAsking || this.midLoopEscalationsUsed >= LiveConductor.MAX_MID_LOOP_ESCALATIONS) {
      return { kind: "continue" };
    }
    this.midLoopEscalationsUsed += 1;

    try {
      const userContent = [
        "Mid-loop checkpoint — the executor is still running.",
        `Turn ${signal.turnCount}/${signal.maxTurns}, stage budget remaining: ${Math.round(signal.stageRemainingMs / 1000)}s.`,
        `Write intent: true. Successful writes so far: ${signal.successfulWrites}. Distinct successful reads: ${signal.distinctSuccessfulReads}.`,
        "Decide: is this productive exploration (continue), should the executor be pressed to write now (force_write), " +
          "or has it spiraled beyond recovery (abort_stage)?",
      ].join("\n");
      const conductorPrompt = loadPrompt("conductor.md");
      const result = await Promise.race([
        this.supervisorModel(
          [{ role: "system", content: conductorPrompt }, { role: "user", content: userContent }],
          { temperature: 0.1, max_tokens: 120, stageLabel: "coordinator", suppressActivity: true },
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mid-loop escalation timeout")), this.cfg.supervision_timeout_ms)),
      ]);
      const parsed = extractJson<{ directive: string; reason?: string }>(result.content);
      if (parsed.directive === "abort_stage") {
        return { kind: "abort", reason: parsed.reason ?? "resident conductor judged the turn unrecoverable" };
      }
      if (parsed.directive === "force_write") {
        return { kind: "force_write", note: parsed.reason ?? "resident conductor: apply the change now" };
      }
      return { kind: "continue" };
    } catch {
      return { kind: "continue" }; // fail-open: a broken/slow escalation must never itself abort a turn
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/conductor.test.ts -t "checkMidLoop"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full conductor test file**

Run: `cd server-jarvis && bun test src/orchestration/conductor.test.ts`
Expected: all pass (no regression in existing `afterStage`/`supervise` tests).

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/conductor.ts server-jarvis/src/orchestration/conductor.test.ts
git commit -m "feat(conductor): checkMidLoop — reflex fast-path + bounded resident escalation"
```

### Task 3.2: Add the mid-loop escalation section to the conductor prompt

**Files:**
- Modify: `server-jarvis/prompts/conductor.md`

- [ ] **Step 1: Add the section**

Append:
```
## Mid-loop checkpoint (Rung 2)
If the input is a "Mid-loop checkpoint" (not an end-of-stage digest), you are
being asked whether an IN-PROGRESS executor turn should continue, be pressed
to write now, or be aborted. Respond with directive "continue", "force_write",
or "abort_stage" plus a one-line "reason". Prefer "force_write" over "abort_stage"
whenever there is still meaningful budget remaining — aborting is for turns that
cannot recover in time, not merely turns that have not written yet.
```

- [ ] **Step 2: Commit**

```bash
git add server-jarvis/prompts/conductor.md
git commit -m "docs(conductor): add mid-loop checkpoint guidance to the conductor prompt"
```

---

## Phase 4 — Wire into the executor turn loop

### Task 4.1: Call `checkMidLoop` and enact its result in `runExecutorStage`

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (`runExecutorStage`, ~L2141-2168)

Context: this is the exact spot the existing `shouldPressWriteEffect` nudge already lives, using the same `successfulWriteCount()` (~L1336), `distinctSuccessfulReadCount()` (~L1415), and `duplicateReadDeflectionCount()` (~L1412) closures already in scope. `this.conductor?.live` is the `LiveConductor` instance (may be undefined in tests using a minimal mock — guard accordingly, matching the existing `?.` convention used for `toolIsSuppressed`).

- [ ] **Step 1: Add the config gate + signal assembly, right before the existing write-effect-nudge block**

Insert immediately before the `let writeEffectNudgeSentThisTurn = false;` block (~L2141):
```ts
          // Rung 2 (2026-07-25): real-time in-turn ownership. Gated behind
          // orchestrator.conductor.in_turn_driver so it stays inert until
          // canaried, mirroring the verification-gate rollout pattern.
          const inTurnDriverEnabled = this.ctx.config.orchestrator?.conductor?.in_turn_driver?.enabled === true;
          if (inTurnDriverEnabled && this.conductor?.live && requiresWriteEffect) {
            const midLoop = await this.conductor.live.checkMidLoop({
              writeIntent: requiresWriteEffect,
              successfulWrites: successfulWriteCount(),
              distinctSuccessfulReads: distinctSuccessfulReadCount(),
              turnCount,
              maxTurns,
              stageRemainingMs: options.turnBudget?.stageRemainingMs("executor") ?? Number.POSITIVE_INFINITY,
              deadToolSuppressed: false,
              suppressedToolName: undefined,
            });
            if (midLoop.kind === "abort") {
              executorDone = true;
              narratives.push(`[Conductor] ${midLoop.reason}`);
              onStateChange({ stage: "executor", status: "running", detail: "mid_loop_abort" });
            } else if (midLoop.kind === "force_write" && !writeEffectNudgeSentThisTurn) {
              writeEffectNudgeCount++;
              writeEffectNudgeSentThisTurn = true;
              executorMessages.push({ role: "user", content: midLoop.note });
            } else if (midLoop.kind === "inject") {
              executorMessages.push({ role: "user", content: midLoop.note });
            } else if (midLoop.kind === "redirect") {
              executorMessages.push({ role: "user", content: midLoop.note });
            }
          }
```

**Note on ordering:** this reads `writeEffectNudgeSentThisTurn`/`writeEffectNudgeCount` which are declared by the *existing* block right after this insertion point. Declare them (`let writeEffectNudgeSentThisTurn = false;` and the `writeEffectNudgeCount++` counter already exists earlier in the function per the existing code) **before** this new block instead — i.e., insert this new block **after** the existing `shouldPressWriteEffect` block (after line ~2165, before the `if (!emittedToolCalls && ...) { executorDone = true; }` check at ~L2167), not before it. This lets the new block skip its own `force_write` push when the existing nudge already fired this turn (`!writeEffectNudgeSentThisTurn` guard), avoiding a double nudge in the same turn.

- [ ] **Step 2: Typecheck**

Run: `cd server-jarvis && bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Run the full test suite**

Run: `cd server-jarvis && bun test`
Expected: all pass — the block is inert (`inTurnDriverEnabled` false by default) so no existing test's behavior changes.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts
git commit -m "feat(pipeline): wire checkMidLoop into the executor turn loop"
```

### Task 4.2: Config — `orchestrator.conductor.in_turn_driver`

**Files:**
- Modify: `server-jarvis/src/config.ts`

- [ ] **Step 1: Add the type + default**

Find the `conductor: { ... }` block in the `orchestrator` config interface (near `supervision`, `enabled`, `model`) and add:
```ts
  in_turn_driver: {
    enabled: boolean;
  };
```
In the default-config factory, inside the `conductor: { ... }` object (alongside `enabled: true, model: "qwen3.5:4b", ...`):
```ts
      in_turn_driver: {
        enabled: false,
      },
```

- [ ] **Step 2: Typecheck**

Run: `cd server-jarvis && bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server-jarvis/src/config.ts
git commit -m "feat(config): add orchestrator.conductor.in_turn_driver block (default off)"
```

---

## Phase 5 — Model A/B: both candidates as the resident conductor

### Task 5.1: Register both GGUFs with Ollama

**Files:** none (operational — Ollama Modelfiles, not repo source)

- [ ] **Step 1: Create a Modelfile for each candidate**

```powershell
@"
FROM E:\models\gguf\Qwythos-9B-Claude-Mythos-5-1M-MTP-Q4_K_M.gguf
PARAMETER temperature 1.0
PARAMETER num_ctx 8192
"@ | Set-Content -Encoding utf8 "$env:TEMP\Modelfile.qwythos9b"

@"
FROM E:\models\gguf\nanbeige4.2-3b-Q6_K.gguf
PARAMETER temperature 1.0
PARAMETER num_ctx 8192
"@ | Set-Content -Encoding utf8 "$env:TEMP\Modelfile.nanbeige42-3b"
```

- [ ] **Step 2: Import both into Ollama**

```powershell
ollama create qwythos9b-conductor -f "$env:TEMP\Modelfile.qwythos9b"
ollama create nanbeige42-3b-conductor -f "$env:TEMP\Modelfile.nanbeige42-3b"
ollama list
```
Expected: both `qwythos9b-conductor` and `nanbeige42-3b-conductor` appear in the list.

### Task 5.2: A/B each as the resident conductor, executor held constant

**Files:** none (operational config swap + eval run — do not commit the config swap, it's a local canary)

- [ ] **Step 1: Point the live config at the first candidate**

In `~/.openclaw/jarvis/config.json`, set:
```json
"conductor": { "model": "qwythos9b-conductor", "fallback_model": "qwen3.5:4b", ... }
```
Restart the server (per the deploy notes from the verification-gated conductor work — stop the current `bun run src/index.ts`, start a fresh one so the new model is picked up).

- [ ] **Step 2: Run the eval harness against candidate 1**

Run: `cd server-jarvis && bun run eval`
Record: pass rate, and specifically any coordinator/conductor routing-JSON-parse failures (these show up as `[Coordinator] Routing parse failed` in logs) — schema adherence is the primary risk with an off-family merge like Qwythos.

- [ ] **Step 3: Live-fire the mid-loop driver against a read-heavy fixture**

With `orchestrator.conductor.in_turn_driver.enabled: true`, replay a Perihelion-shaped large-phase request (or the existing tier-2B `pkg_discount`/`pkg_auth` fixtures for a controlled version) and confirm `checkMidLoop` escalations resolve sensibly (query `self-tuning.db` `conductor_directives`/`model_attributions` for `stage_id='conductor_supervision'` rows tagged from this run).

- [ ] **Step 4: Repeat Steps 1-3 for candidate 2** (`nanbeige42-3b-conductor`)

- [ ] **Step 5: Repeat Steps 1-3 for the current baseline** (`qwen3.5:4b`) to have a fair three-way comparison

- [ ] **Step 6: Record the comparison**

Update `PRIORITIES.md` (or a scratch note) with: eval pass rate, routing-parse failure rate, mid-loop escalation decision quality (subjectively reviewed), and latency (tokens/sec) for all three candidates. This is the evidence that decides which model — if any — becomes the new default `orchestrator.conductor.model`.

---

## Self-Review

- **Spec coverage:** §3 Rung 1 → Phase 1; §4.1 vocabulary → Task 2.1; §4.2 reflexes → Task 2.1; §4.3 escalation → Task 3.1/3.2; §4.4 config → Task 4.2; wiring → Task 4.1; §5 model A/B → Phase 5; §6 success criteria → the Phase 1 regression test + Phase 5 Step 3's live-fire. All covered. §7 out-of-scope (Rung 3+, decomposition, Approach B) is honored — nothing in this plan builds cross-turn sequencing or hands the resident model the whole loop.
- **Type consistency:** `LoopIntervention`/`MidLoopSignal` defined once in `mid-loop-intervention.ts` (Task 2.1) and used identically in `conductor.ts` (Task 3.1) and `pipeline.ts` (Task 4.1) — no renaming drift. `checkMidLoop` signature (`(signal: MidLoopSignal) => Promise<LoopIntervention>`) is consistent across its definition and both call/test sites.
- **Placeholder scan:** none — every step has complete code. Task 4.1's insertion-order note is a real constraint (variable declaration order), not a deferred detail — it's resolved explicitly (insert after, not before, the existing nudge block).
- **Known scope notes (not placeholders):** `deadToolSuppressed`/`suppressedToolName` are wired into the `MidLoopSignal` type and reflex logic in Phase 2, but Task 4.1's call site passes `false`/`undefined` for them (the executor loop doesn't yet expose a per-turn "which tool just got suppressed" signal distinct from the conductor's own `toolIsSuppressed` tracker) — wiring that through is a small, isolated follow-up and does not block this plan's success criteria, since the redirect reflex is still exercised and tested in Task 2.1/3.1's unit tests.
