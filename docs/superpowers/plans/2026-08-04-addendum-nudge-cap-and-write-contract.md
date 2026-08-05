# Addendum: Nudge Cap and Write-Contract Root Causes

> **Status:** scoped, not started. Apply **after** `2026-08-04-orchestration-morning-session-fixes.md` completes — that plan is in flight.
>
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Why this exists:** the parent plan carried two acknowledged holes — the Task 3 "deviation" and the "Known Limitation". Both were flags standing in for unfinished diagnosis. This document closes both with line-level root causes and corrects two claims the parent plan gets wrong.

---

## Finding A — the force-write nudge cap cannot engage (fully root-caused)

`mid-loop-intervention.ts` has **two** branches that return `kind: "force_write"`, and they are not built the same way.

**Branch 1 — failed-write (lines 676-686). Correct.**

```ts
    (signal.forceWriteNudgesSent ?? 0) < FORCE_WRITE_NUDGE_CAP &&    // ← capped
    signal.writeEffectPressureAvailable !== false
  ) {
    return {
      kind: "force_write",
      noteKind: "force_write",                                        // ← tagged
      note: buildFailedWriteNote(signal),
    };
```

**Branch 2 — read-spiral (lines 710-715). Neither capped nor tagged.**

```ts
    if (signal.writeEffectPressureAvailable !== false) {
      return {
        kind: "force_write",
        note: buildReadSpiralNote(signal),        // ← no cap guard, no noteKind
      };
    }
```

Two consequences, and they compound:

1. `pipeline.ts:2179` increments `writeEffectNudgeCount` only when `midLoop.noteKind === "force_write"`. Branch 2 never sets it, so the counter never advances.
2. Branch 2 has no cap guard of its own, so even a correct counter would not stop it.

`buildReadSpiralNote` (line 834) escalates on `const sent = signal.forceWriteNudgesSent ?? 0` — `sent === 0` returns *"Call edit_file or write_file now. You have made N reads and zero writes…"*. Because the counter is frozen at 0, that first variant is the **only** variant ever produced.

**The live evidence matches exactly.** In `run_cc660a4d`, ~30 directives carry that string with only the read count changing (5, 6, 6, 6, 7, 8 … 21). The escalation ladder at lines 844+ was never reached. Code and DB agree; this is closed.

### Correction to the parent plan

Parent Task 3, Step 5 says to "confirm the same guard exists on the builders at lines 838 and 885". That is wrong — 838 and 885 are inside `buildReadSpiralNote` / its sibling note builder, which only *read* `sent` to choose wording. They are not decision sites and a cap there would do nothing. **The missing guard belongs at the decision branch, line 710.** Parent Step 4 ("search the file for `kind: \"force_write\"`") does correctly reach line 712 for the tag.

### Task A1: cap and tag the read-spiral branch

**Files:**
- Modify: `server-jarvis/src/orchestration/mid-loop-intervention.ts:710-715`
- Test: `server-jarvis/src/orchestration/mid-loop-intervention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("read-spiral force_write is capped and tagged", () => {
  const spiral = (forceWriteNudgesSent: number): MidLoopSignal => ({
    writeIntent: true,
    successfulWrites: 0,
    failedWrites: 0,
    distinctSuccessfulReads: 9,
    toolCallsEmitted: true,
    turnCount: 3,
    maxTurns: 12,
    stageRemainingMs: 90_000,
    forceWriteNudgesSent,
  } as MidLoopSignal);

  test("read-spiral force_write carries noteKind so the host counter advances", () => {
    const d = decideMidLoopIntervention(spiral(0));
    expect(d.kind).toBe("force_write");
    expect(d.noteKind).toBe("force_write");
  });

  test("read-spiral stops firing at the cap", () => {
    expect(decideMidLoopIntervention(spiral(FORCE_WRITE_NUDGE_CAP)).kind)
      .not.toBe("force_write");
  });

  test("the escalated wording is reachable once the counter advances", () => {
    const first = decideMidLoopIntervention(spiral(0));
    const second = decideMidLoopIntervention(spiral(1));
    expect("note" in first && "note" in second).toBe(true);
    expect((first as { note: string }).note)
      .not.toBe((second as { note: string }).note);
  });
});
```

Fill any `MidLoopSignal` fields the type requires from the neighbouring tests in the file. The three assertions are what must hold.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts -t "read-spiral force_write"
```

Expected: FAIL — `noteKind` is undefined, and the cap case still returns `force_write`.

- [ ] **Step 3: Fix the branch**

Replace lines 710-715:

```ts
    // 2026-08-04 (run_cc660a4d): this branch had neither the cap guard nor the
    // noteKind tag its failed-write sibling carries, so `writeEffectNudgeCount`
    // never advanced and ~30 byte-identical "Call edit_file or write_file now"
    // notes were decided in one stage. buildReadSpiralNote's escalation ladder
    // was unreachable because `sent` was frozen at 0.
    if (
      signal.writeEffectPressureAvailable !== false &&
      (signal.forceWriteNudgesSent ?? 0) < FORCE_WRITE_NUDGE_CAP
    ) {
      return {
        kind: "force_write",
        noteKind: "force_write",
        note: buildReadSpiralNote(signal),
      };
    }
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd server-jarvis && bun test src/orchestration/mid-loop-intervention.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/mid-loop-intervention.ts server-jarvis/src/orchestration/mid-loop-intervention.test.ts && git commit -m "fix(supervision): cap and tag the read-spiral force_write branch"
```

---

## Finding B — how the write contract was actually lost

The parent plan's Known Limitation calls this "sticky `writeIntent` de-escalation". **That is wrong.** `writeIntent` never de-escalates — `resolveTaskRunTurn:1191` explicitly ORs it forward. The contract was not de-escalated; it was **replaced**.

### The chain

1. `resolveTaskRunTurn:1134` — a run only continues when
   `previousLive = !["completed","failed","cancelled"].includes(previous.status)`.
2. `assessTaskRunAcceptance:1221` — a failed turn *pauses* (staying live) **only if `evidenceCount > 0`**. This is the existing F9 mitigation, written for exactly this hazard: *"so 'continue…' resumes the real objective … instead of minting a new task run whose objective is the literal word 'continue'."*
3. `index.ts:3496` — but `evidenceCount` is keyed to the turn's **classified requirement**, not to what the turn did:

```ts
const evidenceCount = turnReq.requirement === "workspace_read"
  ? (…)
  : turnReq.requirement === "full_execution"
    ? new Set(successfulToolCalls.map(…)).size
    : 0;                                    // ← everything else scores zero
```

4. `run_085afdac` routed through the deterministic fallback — *"Local conductor cold/abort (The operation was aborted.); using deterministic answer_only route."* Its requirement was therefore not `full_execution`, so `evidenceCount` was **0**.
5. F9's pause did not apply → status terminal → `previousLive` false on the next turn.
6. `resolveTaskRunTurn:1202` minted a fresh contract with `objective: message` = `"continue please"`, and `createTaskRun:1118` set
   `writeIntent = requirement === "full_execution" && hasWriteIntent("continue please")` = **false**.
7. Downstream: `delegate_skip reason=write_not_required`, and `deepTask` false → 150 s budget instead of 600 s.

### The measured contradiction

`run_085afdac` made **30 successful tool calls** — `list_directory`, `read_file`, `grep`, `git_metadata`, `todo_write`, `bash` — against 5 failures. The runtime recorded its evidence as **zero**, purely because the coordinator had fallen back to `answer_only`. A turn that did substantial real work was scored as having done none, and that is what destroyed the contract.

This also corrects the parent plan's framing that Task 1 alone restores continuation. Task 1 carries plan items and write targets *when a contract survives*. In this session the contract did not survive at all, so Task 1's carry would have been computed from a freshly-minted empty contract.

### One link not confirmable from the DB

`turnReq.requirement` is not persisted — `conductor_runs.routing_json` records the route, not the requirement. Step 4 above is inferred from the `answer_only` rationale, and it is the only inferred link in the chain. Task B1 makes it observable so this is never re-inferred.

### Task B1: persist the turn requirement

**Files:**
- Modify: `server-jarvis/src/self-tuning/conductor-learning.ts` (`recordRouting`)
- Modify: `server-jarvis/src/index.ts` (pass `turnReq.requirement`)
- Test: `server-jarvis/src/self-tuning/conductor-learning.test.ts`

- [ ] **Step 1: Write the failing test** asserting `recordRouting` persists a `requirement` field into `conductor_runs.routing_json`, readable back via the store.
- [ ] **Step 2: Run it; confirm it fails** (`bun test src/self-tuning/conductor-learning.test.ts`).
- [ ] **Step 3:** add `requirement` to the routing payload written by `recordRouting`, and pass `turnReq.requirement` at the `conductorLearning.recordRouting({ agentRunId, … })` call site in `index.ts` (~line 3168).
- [ ] **Step 4: Run it; confirm it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(telemetry): persist turn requirement on conductor_runs"`

### Task B2: score evidence on what the turn did, not how it was classified

**Files:**
- Modify: `server-jarvis/src/index.ts:3496-3502`
- Test: `server-jarvis/src/orchestration/task-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("evidence scoring is requirement-independent for terminal decisions", () => {
  test("a failed turn with real successful tool calls pauses rather than fails", () => {
    const contract = createTaskRun({
      taskRunId: "tr_b2",
      sessionId: "s",
      objective: "execute the Perihelion plan",
      requirement: "full_execution",
    });
    const result = assessTaskRunAcceptance({
      requirement: "answer_only",
      depth: contract.depth,
      pipelineOutcome: "failed",
      answer: "",
      evidenceCount: 30,
    });
    expect(result.status).toBe("paused");
  });
});
```

Match `TaskRunAcceptanceInput`'s exact field names when writing this; the assertion is that a 30-evidence failed turn does not go terminal.

- [ ] **Step 2: Run it; confirm the current behaviour.** If it already passes, the defect is purely in the *caller* (`index.ts` zeroing the count) and not in `assessTaskRunAcceptance` — proceed to Step 3 regardless, and note it.

- [ ] **Step 3: Fix the caller.** In `index.ts:3496`, replace the requirement-keyed ternary so that non-`workspace_read`, non-`full_execution` turns still count distinct successful tool calls instead of hard-coding `0`:

```ts
        // 2026-08-04 (run_085afdac): this scored 0 for any requirement outside
        // workspace_read / full_execution. The deterministic answer_only
        // fallback therefore recorded a turn with 30 successful tool calls as
        // zero-evidence, F9's pause did not apply, the contract went terminal,
        // and the next "continue please" minted a fresh run with writeIntent
        // false. Evidence is what the turn DID, not how it was classified.
        const distinctSuccessful = new Set(
          successfulToolCalls.map((call) => `${call.name}:${JSON.stringify(call.arguments)}`),
        ).size;
        const evidenceCount = turnReq.requirement === "workspace_read"
          ? (activeTaskRun.depth === "deep"
            ? evidenceAssessment.contentReads
            : evidenceAssessment.contentReads + evidenceAssessment.listings)
          : distinctSuccessful;
```

- [ ] **Step 4: Run the full suite** — `bun run typecheck && bun test`. Several acceptance tests may assert the old zero-scoring; each such assertion must be re-read against this root cause before being updated, not blanket-changed.

- [ ] **Step 5: Commit** — `git commit -m "fix(task-run): score turn evidence on tool calls, not turn classification"`

### Task B3: reconcile the two write-contract authorities

One turn currently carries two contradictory answers to "does this write?":

| Authority | Source | `run_94cdcfdf` |
|---|---|---|
| Budget / requirement | `turn-budget.ts:237` | `full_execution` |
| Delegate eligibility | `claude-delegate.ts:350` via `pipeline.ts:1808` | `write_not_required` |

- [ ] **Step 1: Write the failing test** in `server-jarvis/src/orchestration/pipeline-delegate.test.ts` asserting that when the turn requirement is `full_execution`, `delegateEligibility` is not refused with `write_not_required` — even when `hasWriteIntent(message)` is false and the contract's `writeIntent` is false.
- [ ] **Step 2: Run it; confirm it fails.**
- [ ] **Step 3:** extend `requiresWriteEffect` at `pipeline.ts:1808` to accept the turn requirement as a third arming signal:

```ts
    const requiresWriteEffect = profile === "full" &&
      (hasWriteIntent(intentText)
        || options.taskRunWriteIntent === true
        || options.turnRequirement === "full_execution");
```

`options.turnRequirement` is the field the parent plan's Task 5 adds to `ExecutorStageOptions`. **Sequence B3 after parent Task 5** or add the field here.

- [ ] **Step 4: Run it; confirm it passes.**
- [ ] **Step 5: Verify no false arming** — run `bun test src/orchestration` and confirm no `workspace_read` or `answer_only` test now expects a delegate launch.
- [ ] **Step 6: Commit** — `git commit -m "fix(delegate): full_execution requirement arms the write contract"`

---

## Execution order

B1 → B2 → A1 → B3. B1 first so the requirement is observable before B2 changes behaviour that depends on it; B3 last because it depends on parent Task 5's `turnRequirement` field.

## Corrections this document makes to the parent plan

| Parent claim | Correction |
|---|---|
| Task 3 Step 5: "confirm the guard on builders at 838 and 885" | Those are note builders, not decision sites. The missing guard is the decision branch at line 710. |
| Known Limitation: "sticky `writeIntent` de-escalation" | `writeIntent` never de-escalates (`resolveTaskRunTurn:1191` ORs it forward). The contract was **replaced** after going terminal. |
| Task 1 restores continuation | Only when a contract survives. In this session it did not — B2 is the prerequisite. |
