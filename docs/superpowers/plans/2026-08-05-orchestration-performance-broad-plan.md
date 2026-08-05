# Orchestration Performance — Broad Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the measured performance and integrity gaps across the whole orchestration stack — verification coverage, executor waste, model-pool health, telemetry blind spots, supervision cost, and delegate reliability.

**Architecture:** Six independent themes, each anchored to a number measured from `~/.openclaw/jarvis/self-tuning.db` over the 2026-07-20 → 2026-08-05 window (364 runs, 3,542 stage turns, 51,339s of stage time). Telemetry tasks come first because three of the other themes are currently unmeasurable.

**Tech Stack:** TypeScript, Bun (`bun test`), SQLite evidence store, existing replay harness (`scripts/replay-conductor.ts`) and benchmark (`scripts/benchmark-conductor-completion.ts`).

---

## Measured Baseline

| Metric | Measured | Source |
|---|---:|---|
| Runs in window | 364 | `agent_runs` |
| Success / partial / degraded / failed | 182 / 97 / 72 / 13 | `agent_runs.outcome` |
| Total stage time | 51,339s | `stage_runs` |
| Executor share of stage time | **57.4%** (29,478s) | `stage_runs` |
| Executor turns emitting no tool call | **44%** (942/2,130), **9,883s** | `stage_runs` |
| Successes that wrote code and were never checked | **73 of 182 (40%)** | joined `agent_runs` + `stage_runs` |
| Successes that wrote code and WERE checked | 87 | same |
| Typed-failure stage time | ~6,200s | `stage_runs.partial_error_code` |
| Avg stage turns per run | 9.6 (max 54) | `stage_runs` |
| `mid_loop_continue` directives | 498 across 46 runs (10.8/run) | `conductor_directives` |

Worst model error rates (`model_attributions`, n≥15):

| Model | Calls | Errors | Rate |
|---|---:|---:|---:|
| `claude_cli:cohere/north-mini-code:free` | 33 | 30 | **91%** |
| `claude_cli:gemma4:e2b` | 67 | 57 | **85%** |
| `opencode_zen:nemotron-3-ultra-free` | 342 | 70 | 20% (**69% fallback**) |

Top typed failures by wasted time: `mid_loop_handoff` 1,242s · `delegate_cleanup_unconfirmed` 1,100s · `delegate_no_write` 1,022s · `executor_no_tool` 899s · `stage_window_exhausted` 611s.

**Scope note:** this plan does not attempt to raise raw model capability. Every task targets runtime behaviour that wastes a capable model's turn or fails to measure it.

**On user-visible latency:** `time_to_first_visible_token` is 2.08 min and the synthesizer holds 16.3% of stage time (8,368s, 24.5s/turn). That metric is measured run-start → synthesizer-start, so it is dominated by everything *before* synthesis — overwhelmingly the executor's 57.4% share and its 9,883s of no-tool turns. Theme 3 is therefore the TTFT fix; a separate synthesizer-latency task would target 16% while leaving the 57% untouched. Re-measure TTFT after Task 5 before considering synthesizer work, and note that `preferFastSynthesizer` (`SYNTHESIZER_MIN_SPEED = 0.7`) already demotes slow models on that stage.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server-jarvis/src/self-tuning/store.ts` | Evidence schema | Add `stage_run_id` to `model_attributions`; add `failure_detail` to `stage_runs` |
| `server-jarvis/src/self-tuning/collector.ts` | Telemetry writes | Thread the new columns |
| `server-jarvis/src/orchestration/claude-delegate.ts` | Delegate lifecycle | Persist snapshot exception; separate infra failure from model evidence |
| `server-jarvis/src/orchestration/model-health.ts` | **NEW** — error-rate benching | New module |
| `server-jarvis/src/orchestration/agent-pool.ts` | Model selection | Consume error-rate bench |
| `server-jarvis/src/orchestration/directive-budget.ts` | **NEW** — per-turn supervision cap | New module |
| `server-jarvis/src/orchestration/pipeline.ts` | Stage orchestration | Wire budget + check-attempt record |
| `server-jarvis/src/orchestration/check-runner.ts` | Verification tiers | Record decline reason |
| `server-jarvis/src/eval/conductor-performance.ts` | Benchmark | New gate axes |

---

# THEME 1 — Telemetry (do first; three later themes depend on it)

## Task 1: Link model attributions to the stage row they describe

**Why:** `model_attributions.stage_id` holds a stage *name* (`"executor"`), not a row id. Joining attributions to `stage_runs` fans out — a query for per-model no-tool rate reported 15,926 executor turns in a window containing 2,130. **Per-model no-tool rate, the input to Task 5, is currently uncomputable.**

**Files:**
- Modify: `server-jarvis/src/self-tuning/store.ts`
- Modify: `server-jarvis/src/self-tuning/collector.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (attribution call sites)
- Test: `server-jarvis/src/self-tuning/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("model_attributions carry a stage_run_id", () => {
  test("attribution links to exactly one stage row", () => {
    const store = new SelfTuningStore(":memory:");
    store.startAgentRun("run_1", "sess_1", "req", "refactor", ["executor"]);
    const stageId = "stage_abc";
    store.recordStageRun({
      id: stageId, agent_run_id: "run_1", mode_id: "executor", turn_number: 1,
      input_tokens: 10, output_tokens: 10, tool_calls_json: "[]",
      duration_ms: 100, was_successful: 1, had_error: 0,
    });
    store.recordModelAttribution({
      id: "attr_1", agent_run_id: "run_1", stage_id: "executor",
      stage_run_id: stageId, agent_id: "a", provider: "openrouter",
      model_id: "m", was_successful: 1, had_error: 0, duration_ms: 100,
      fallback_used: 0,
    });
    const rows = store.db
      .query("SELECT stage_run_id FROM model_attributions WHERE id='attr_1'")
      .all() as Array<{ stage_run_id: string }>;
    expect(rows[0]!.stage_run_id).toBe(stageId);
  });
});
```

Match `SelfTuningStore`'s actual constructor and public surface used by neighbouring tests in that file; the assertion is what must hold.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/self-tuning/store.test.ts -t "stage_run_id"
```

Expected: FAIL — no such column.

- [ ] **Step 3: Add the column with a migration**

In `store.ts`, beside the existing `ALTER TABLE` migrations (the file already uses this pattern for `decision_source` and `escalation_id`):

```ts
        try {
          db.exec(`ALTER TABLE model_attributions ADD COLUMN stage_run_id TEXT`);
        } catch { /* already applied */ }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_model_attributions_stage_run_id
                 ON model_attributions(stage_run_id)`);
```

Add `stage_run_id?: string` to the attribution insert type and include it in the `INSERT` column list and bindings.

- [ ] **Step 4: Thread it at the call sites**

Every `recordModelAttribution` call in `pipeline.ts` and `index.ts` already computes a `stageId` (e.g. `const stageId = \`stage_${crypto.randomUUID()}\``) for its paired `recordStageRun`. Pass that same id as `stage_run_id`. Where a call site has no stage row (e.g. `conductor_supervision`), omit the field — it stays null.

- [ ] **Step 5: Run it and confirm it passes**

```bash
cd server-jarvis && bun test src/self-tuning/store.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/self-tuning server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/index.ts && git commit -m "feat(telemetry): link model attributions to their stage row"
```

## Task 2: Persist the failure text that explains a typed error

**Why:** `delegate_snapshot_error` cost two live-fire runs on 2026-08-05 and produced one incorrect root-cause diagnosis. `claude-delegate.ts` builds the string `Delegate ground-truth snapshot failed: ${error}` and then discards it — `stage_runs.error_message` holds only the bare code and `diagnostic_json` is empty. Six occurrences in the store, all unexplained.

**Files:**
- Modify: `server-jarvis/src/self-tuning/store.ts` (add `failure_detail`)
- Modify: `server-jarvis/src/orchestration/claude-delegate.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (delegate stage row)
- Test: `server-jarvis/src/orchestration/claude-delegate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("snapshot failure preserves the underlying exception", () => {
  test("delegate_snapshot_error carries the thrown message", async () => {
    const result = await runClaudeDelegate({
      ...baseDelegateInput(),
      snapshotFactory: {
        capture: async () => { throw new Error("EMFILE: too many open files"); },
      },
    });
    expect(result.errorCode).toBe("delegate_snapshot_error");
    expect(result.failureDetail).toContain("EMFILE");
  });
});
```

Build `baseDelegateInput()` from the existing delegate tests in this file — they already construct a full `RunClaudeDelegateInput` with injected process and snapshot factories.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/orchestration/claude-delegate.test.ts -t "underlying exception"
```

Expected: FAIL — `failureDetail` is undefined.

- [ ] **Step 3: Carry the detail on the delegate result**

Add `failureDetail?: string` to the delegate output type, and set it in `delegateFailure`:

```ts
  const delegateFailure = (errorCode: string, narrative: string, detail?: string) => ({
    ok: false as const,
    narrative,
    toolCalls: [],
    terminalStatus: "failed" as const,
    errorCode,
    failureDetail: detail?.slice(0, 600),
  });
```

At the snapshot site (`claude-delegate.ts:1266`):

```ts
    if (beforeResult.kind === "error") {
      const detail = beforeResult.error instanceof Error
        ? `${beforeResult.error.name}: ${beforeResult.error.message}`
        : String(beforeResult.error);
      return delegateFailure(
        "delegate_snapshot_error",
        `Delegate ground-truth snapshot failed: ${detail}`,
        detail,
      );
    }
```

- [ ] **Step 4: Add the column and persist it**

In `store.ts`, next to the other migrations:

```ts
        try {
          db.exec(`ALTER TABLE stage_runs ADD COLUMN failure_detail TEXT`);
        } catch { /* already applied */ }
```

Include `failure_detail` in the `recordStageRun` insert. In `pipeline.ts`, where the delegate stage row is recorded, pass `failure_detail: delegated.failureDetail`.

- [ ] **Step 5: Run it and confirm it passes**

```bash
cd server-jarvis && bun test src/orchestration/claude-delegate.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/claude-delegate.ts server-jarvis/src/orchestration/claude-delegate.test.ts server-jarvis/src/self-tuning/store.ts server-jarvis/src/orchestration/pipeline.ts && git commit -m "feat(telemetry): persist the exception behind a typed stage failure"
```

## Task 3: Record why a verification check declined

**Why:** 73 of 182 successes wrote code and were never checked. Today a decline is indistinguishable from "no code written" — both land as `check_tier: none` or a null tier. Without the reason, Theme 2's coverage gate cannot be enforced or debugged.

**Files:**
- Modify: `server-jarvis/src/orchestration/check-runner.ts`
- Modify: `server-jarvis/src/self-tuning/store.ts` (`agent_runs.check_declined_reason`)
- Test: `server-jarvis/src/orchestration/check-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("CheckResult explains a none tier", () => {
  test("no code written is distinguished from a declined detector", () => {
    const noCode = mergeToCheckResult({
      run: { status: "skipped", issues: [], reason: undefined, target: undefined } as any,
      build: { kind: "not_applicable", reason: "no build system matched" },
      hadWrittenCode: false,
    });
    expect(noCode.tier).toBe("none");
    expect(noCode.declinedReason).toBe("no_code_written");

    const declined = mergeToCheckResult({
      run: { status: "skipped", issues: [], reason: undefined, target: undefined } as any,
      build: { kind: "not_applicable", reason: "no build system matched" },
      hadWrittenCode: true,
    });
    expect(declined.tier).toBe("none");
    expect(declined.declinedReason).toBe("no build system matched");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/orchestration/check-runner.test.ts -t "explains a none tier"
```

- [ ] **Step 3: Add the field**

In `check-runner.ts`, add `declinedReason?: string` to `CheckResult`, then set it in the two `none` branches of `mergeToCheckResult`:

```ts
  if (!input.hadWrittenCode) {
    return { tier: "none", ran: false, passed: null, detail: "", command: "",
             durationMs, declinedReason: "no_code_written" };
  }
```

```ts
    case "not_applicable":
      return { tier: "none", ran: false, passed: null, detail: "", command: "",
               durationMs, declinedReason: input.build.reason };
```

Do the same in `runVerificationCheck`'s early return.

- [ ] **Step 4: Persist it**

Add `check_declined_reason TEXT` to `agent_runs` via the same `ALTER TABLE` pattern, and pass `result.checkResult?.declinedReason` through `completeAgentRun`.

- [ ] **Step 5: Run it and confirm it passes**

```bash
cd server-jarvis && bun run typecheck && bun test src/orchestration/check-runner.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/check-runner.ts server-jarvis/src/orchestration/check-runner.test.ts server-jarvis/src/self-tuning server-jarvis/src/index.ts && git commit -m "feat(verification): record why a check declined"
```

---

# THEME 2 — Verification coverage

## Task 4: Make an unchecked write a benchmark gate failure

**Why:** 73/182 successes (40%) wrote code with no runtime check. `06caafb` fail-closes the *completion decision*, but nothing fails the *release gate* on coverage, so regressions are invisible between manual audits.

**Files:**
- Modify: `server-jarvis/src/eval/conductor-performance.ts`
- Modify: `server-jarvis/scripts/benchmark-conductor-completion.ts`
- Test: `server-jarvis/src/eval/conductor-performance.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("unchecked-write coverage gate", () => {
  test("successes that wrote code without a check fail the gate", () => {
    const report = analyzeConductorPerformance({
      runs: [
        makeRun({ outcome: "success", wroteCode: true, checkTier: "none" }),
        makeRun({ outcome: "success", wroteCode: true, checkTier: "builtin" }),
      ],
      thresholds: { ...defaultThresholds, maxUncheckedWriteRatio: 0 },
    });
    expect(report.uncheckedWriteRuns).toBe(1);
    expect(report.gateFailures).toContain("unchecked_write_ratio");
  });

  test("read-only successes are not counted as unchecked", () => {
    const report = analyzeConductorPerformance({
      runs: [makeRun({ outcome: "success", wroteCode: false, checkTier: "none" })],
      thresholds: { ...defaultThresholds, maxUncheckedWriteRatio: 0 },
    });
    expect(report.uncheckedWriteRuns).toBe(0);
    expect(report.gateFailures).not.toContain("unchecked_write_ratio");
  });
});
```

Use the module's existing fixture builder for runs; if none exists, construct the same shape the other tests in the file use.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/eval/conductor-performance.test.ts -t "unchecked-write"
```

- [ ] **Step 3: Implement the axis**

Add `"unchecked_write_ratio"` to `GateFailureCode`. Compute, using the same write-tool set the module already defines:

```ts
  const uncheckedWriteRuns = runs.filter((r) =>
    r.outcome === "success"
    && runWroteCode(r)
    && r.check_tier !== "builtin"
    && r.check_tier !== "existing",
  ).length;
```

Push the failure when `uncheckedWriteRuns / max(1, successfulWriteRuns) > thresholds.maxUncheckedWriteRatio`. Default the threshold to `0`.

- [ ] **Step 4: Print it in the CLI**

In `benchmark-conductor-completion.ts`, beside the existing `unverified successes` line:

```ts
  console.log(`  unchecked writes:             ${report.uncheckedWriteRuns}  [max 0]`);
```

- [ ] **Step 5: Run it and confirm it passes**

```bash
cd server-jarvis && bun test src/eval/conductor-performance.test.ts
```

- [ ] **Step 6: Record the live baseline**

```bash
cd server-jarvis && bun scripts/benchmark-conductor-completion.ts --limit 500
```

Expected today: ~73 unchecked writes. Record the number in the commit message.

- [ ] **Step 7: Commit**

```bash
git add server-jarvis/src/eval server-jarvis/scripts/benchmark-conductor-completion.ts && git commit -m "feat(eval): gate on successes that wrote code without a runtime check"
```

---

# THEME 3 — Executor waste (largest time sink: 9,883s)

## Task 5: Demote models by measured no-tool rate

**Why:** 44% of executor turns emit no tool call, costing 9,883s of 51,339s total stage time. `docs/delegate-era-baseline.md` lists "W3.4 routing by no-tool rate" as an open TODO. Task 1 makes the per-model rate computable for the first time.

**Files:**
- Create: `server-jarvis/src/orchestration/model-health.ts`
- Create: `server-jarvis/src/orchestration/model-health.test.ts`
- Modify: `server-jarvis/src/orchestration/agent-pool.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import {
  NO_TOOL_DEMOTION_THRESHOLD,
  MIN_NO_TOOL_SAMPLE,
  shouldDemoteForNoTool,
} from "./model-health";

describe("shouldDemoteForNoTool", () => {
  test("demotes a model above the threshold with enough samples", () => {
    expect(shouldDemoteForNoTool({ noToolTurns: 30, executorTurns: 40 })).toBe(true);
  });

  test("does not demote below the sample floor, however bad the rate", () => {
    expect(shouldDemoteForNoTool({ noToolTurns: MIN_NO_TOOL_SAMPLE - 1, executorTurns: MIN_NO_TOOL_SAMPLE - 1 }))
      .toBe(false);
  });

  test("does not demote a healthy model", () => {
    expect(shouldDemoteForNoTool({ noToolTurns: 2, executorTurns: 40 })).toBe(false);
  });

  test("threshold is a rate, not a count", () => {
    const rate = NO_TOOL_DEMOTION_THRESHOLD;
    const turns = 100;
    expect(shouldDemoteForNoTool({ noToolTurns: Math.ceil(rate * turns) + 1, executorTurns: turns })).toBe(true);
    expect(shouldDemoteForNoTool({ noToolTurns: Math.floor(rate * turns) - 1, executorTurns: turns })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/orchestration/model-health.test.ts
```

Expected: FAIL — `Cannot find module './model-health'`.

- [ ] **Step 3: Implement the module**

```ts
/**
 * Executor-stage health signals used to demote models that burn turns.
 *
 * Measured 2026-07-20 → 08-05: 44% of executor turns (942/2130) emitted no tool
 * call at all, costing 9,883s of 51,339s total stage time. Selection has never
 * consumed this signal — `docs/delegate-era-baseline.md` lists it as the open
 * W3.4 TODO. Per-model rates only became computable once attributions carried
 * a stage_run_id (Task 1).
 */

/** Executor turns a model needs before its no-tool rate is actionable. */
export const MIN_NO_TOOL_SAMPLE = 12;

/**
 * No-tool rate above which a model stops being a preferred executor pick.
 * Set above the 44% fleet average so this demotes the tail, not the field —
 * demoting everything would empty the pool.
 */
export const NO_TOOL_DEMOTION_THRESHOLD = 0.6;

export interface NoToolStats {
  noToolTurns: number;
  executorTurns: number;
}

export function shouldDemoteForNoTool(stats: NoToolStats): boolean {
  if (stats.executorTurns < MIN_NO_TOOL_SAMPLE) return false;
  return stats.noToolTurns / stats.executorTurns > NO_TOOL_DEMOTION_THRESHOLD;
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd server-jarvis && bun test src/orchestration/model-health.test.ts
```

- [ ] **Step 5: Consume it in selection**

In `agent-pool.ts`, in `pickFor`, after the existing exclusion filter and before ranking, drop demoted agents from the *preferred* set while leaving them in the cascade — mirroring how `benchedModels` is already handled in `enumerateDelegateModelCandidates`:

```ts
    const demoted = new Set(
      candidates
        .filter((a) => shouldDemoteForNoTool(noToolStatsFor(a.provider, a.model_id)))
        .map((a) => `${a.provider}:${a.model_id}`),
    );
    if (demoted.size > 0 && demoted.size < candidates.length) {
      candidates = candidates.filter((a) => !demoted.has(`${a.provider}:${a.model_id}`));
    }
```

No in-memory per-model no-tool aggregate exists today, so add one in `model-health.ts` alongside the predicate:

```ts
const noToolStats = new Map<string, NoToolStats>();

/** Record one executor stage outcome for a model. Call where stage rows are written. */
export function recordExecutorTurn(
  provider: string,
  modelId: string,
  emittedToolCall: boolean,
): void {
  const key = `${provider}:${modelId}`;
  const e = noToolStats.get(key) ?? { noToolTurns: 0, executorTurns: 0 };
  e.executorTurns++;
  if (!emittedToolCall) e.noToolTurns++;
  noToolStats.set(key, e);
}

export function noToolStatsFor(provider: string, modelId: string): NoToolStats {
  return noToolStats.get(`${provider}:${modelId}`) ?? { noToolTurns: 0, executorTurns: 0 };
}
```

Call `recordExecutorTurn` in `pipeline.ts` where the executor stage row is recorded — the same site that now supplies `stage_run_id` (Task 1) already holds both the model identity and the tool-call array, so `emittedToolCall` is `toolCalls.length > 0`.

The guard `demoted.size < candidates.length` is required — never empty the pool.

- [ ] **Step 6: Full suite and commit**

```bash
cd server-jarvis && bun run typecheck && bun test
```

```bash
git add server-jarvis/src/orchestration/model-health.ts server-jarvis/src/orchestration/model-health.test.ts server-jarvis/src/orchestration/agent-pool.ts && git commit -m "feat(routing): demote executor models by measured no-tool rate"
```

## Task 6: Bench models on error rate, not only write evidence

**Why:** `claude_cli:cohere/north-mini-code:free` failed 30 of 33 calls (91%); `claude_cli:gemma4:e2b` failed 57 of 67 (85%). The existing scoreboard benches only on *write evidence*, so a model that errors outright is never benched and keeps being selected.

**Files:**
- Modify: `server-jarvis/src/orchestration/model-health.ts`
- Modify: `server-jarvis/src/orchestration/delegate-model-select.ts`
- Test: `server-jarvis/src/orchestration/model-health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("shouldBenchForErrorRate", () => {
  test("benches a model failing most calls", () => {
    expect(shouldBenchForErrorRate({ errors: 30, calls: 33 })).toBe(true);
  });

  test("respects a sample floor", () => {
    expect(shouldBenchForErrorRate({ errors: 3, calls: 3 })).toBe(false);
  });

  test("leaves a mostly-healthy model alone", () => {
    expect(shouldBenchForErrorRate({ errors: 70, calls: 342 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/orchestration/model-health.test.ts -t "shouldBenchForErrorRate"
```

- [ ] **Step 3: Implement**

```ts
/** Calls before an error rate is actionable. */
export const MIN_ERROR_RATE_SAMPLE = 10;

/**
 * Error rate above which a model is benched outright. Deliberately high: this
 * targets models that are broken (claude_cli:cohere/north-mini-code:free at
 * 91%, claude_cli:gemma4:e2b at 85%), not merely unreliable
 * (nemotron-3-ultra-free at 20% stays in the pool).
 */
export const ERROR_RATE_BENCH_THRESHOLD = 0.7;

export interface ErrorRateStats { errors: number; calls: number; }

export function shouldBenchForErrorRate(stats: ErrorRateStats): boolean {
  if (stats.calls < MIN_ERROR_RATE_SAMPLE) return false;
  return stats.errors / stats.calls > ERROR_RATE_BENCH_THRESHOLD;
}
```

- [ ] **Step 4: Feed it into the bench set**

In `delegate-model-select.ts`, where `getBenchedDelegateModels()` is assembled, union the write-evidence bench with models failing `shouldBenchForErrorRate`. Keep the two reasons distinct in the returned metadata so the replay harness can tell them apart.

- [ ] **Step 5: Run it and confirm it passes**

```bash
cd server-jarvis && bun run typecheck && bun test src/orchestration
```

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/model-health.ts server-jarvis/src/orchestration/model-health.test.ts server-jarvis/src/orchestration/delegate-model-select.ts && git commit -m "feat(routing): bench models by error rate, not only write evidence"
```

---

# THEME 4 — Delegate reliability (3,364s of typed failure)

## Task 7: Do not bench the delegate for an infrastructure failure

**Why:** `mid_loop_handoff` (1,242s), `delegate_cleanup_unconfirmed` (1,100s), and `delegate_no_write` (1,022s) are the three largest typed failures. Worse, one failure of any kind adds the run to `delegateNoWriteRuns`, and the log then shows `delegate skipped: prior attempt produced no verified write` for the rest of the run. On 2026-08-05 a `delegate_snapshot_error` — a crash *before the model ran* — benched `minimax-m3` for four subsequent attempts and dropped every write to free models that produced none.

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Test: `server-jarvis/src/orchestration/pipeline-delegate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("delegate benching distinguishes infrastructure from capability", () => {
  test("a pre-launch snapshot failure does not bench the delegate for the run", () => {
    expect(shouldBenchDelegateForRun("delegate_snapshot_error")).toBe(false);
    expect(shouldBenchDelegateForRun("delegate_integration_error")).toBe(false);
    expect(shouldBenchDelegateForRun("delegate_aborted")).toBe(false);
  });

  test("a model that ran and produced no write is still benched", () => {
    expect(shouldBenchDelegateForRun("delegate_no_write")).toBe(true);
    expect(shouldBenchDelegateForRun("mid_loop_handoff")).toBe(true);
    expect(shouldBenchDelegateForRun(undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/orchestration/pipeline-delegate.test.ts -t "infrastructure from capability"
```

- [ ] **Step 3: Implement the predicate**

Export from `pipeline.ts` beside the other delegate helpers:

```ts
/**
 * Error codes that describe the RUNTIME failing before or around the model,
 * not the model failing to write. Benching on these punishes a capable model
 * for a crash it never saw (2026-08-05: delegate_snapshot_error benched
 * minimax-m3 for four subsequent attempts in run_6e924106).
 */
const DELEGATE_INFRASTRUCTURE_FAILURES = new Set([
  "delegate_snapshot_error",
  "delegate_integration_error",
  "delegate_aborted",
  "delegate_no_events",
]);

export function shouldBenchDelegateForRun(errorCode: string | undefined): boolean {
  return !(errorCode && DELEGATE_INFRASTRUCTURE_FAILURES.has(errorCode));
}
```

Replace the unconditional `if (!hasVerifiedWrite) this.delegateNoWriteRuns.add(agentRunId);` with:

```ts
      if (!hasVerifiedWrite && shouldBenchDelegateForRun(downgradeCode ?? delegated.errorCode)) {
        this.delegateNoWriteRuns.add(agentRunId);
      }
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd server-jarvis && bun run typecheck && bun test src/orchestration
```

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/pipeline-delegate.test.ts && git commit -m "fix(delegate): infrastructure failures no longer bench the model for the run"
```

---

# THEME 5 — Supervision cost

## Task 8: Per-turn directive budget

**Why:** `mid_loop_continue` fired 498 times across 46 runs (10.8/run); the worst runs carry 88, 87, and 83 directives, and one run reached 54 stage turns. Individual reflexes are capped (`FORCE_WRITE_NUDGE_CAP`, `PLAN_REMAINDER_NUDGE_CAP`), but nothing bounds the *total*, so the spin relocates from one reflex to another — exactly what the 2026-08-01 comment in `mid-loop-intervention.ts` records happening once already.

**Files:**
- Create: `server-jarvis/src/orchestration/directive-budget.ts`
- Create: `server-jarvis/src/orchestration/directive-budget.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { DirectiveBudget, MAX_DIRECTIVES_PER_TURN } from "./directive-budget";

describe("DirectiveBudget", () => {
  test("allows directives up to the cap", () => {
    const b = new DirectiveBudget();
    for (let i = 0; i < MAX_DIRECTIVES_PER_TURN; i++) expect(b.claim("mid_loop_continue")).toBe(true);
  });

  test("refuses past the cap", () => {
    const b = new DirectiveBudget();
    for (let i = 0; i < MAX_DIRECTIVES_PER_TURN; i++) b.claim("mid_loop_continue");
    expect(b.claim("mid_loop_continue")).toBe(false);
    expect(b.exhausted()).toBe(true);
  });

  test("terminal directives are never refused", () => {
    const b = new DirectiveBudget();
    for (let i = 0; i < MAX_DIRECTIVES_PER_TURN + 5; i++) b.claim("mid_loop_continue");
    expect(b.claim("mid_loop_abort")).toBe(true);
    expect(b.claim("mark_verified")).toBe(true);
  });

  test("reports what consumed the budget", () => {
    const b = new DirectiveBudget();
    b.claim("mid_loop_continue");
    b.claim("mid_loop_force_write");
    b.claim("mid_loop_continue");
    expect(b.tally()).toEqual({ mid_loop_continue: 2, mid_loop_force_write: 1 });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd server-jarvis && bun test src/orchestration/directive-budget.test.ts
```

- [ ] **Step 3: Implement**

```ts
/**
 * Total supervision directives one turn may spend.
 *
 * Measured 2026-07-20 → 08-05: mid_loop_continue fired 498 times across 46 runs
 * (10.8/run); the worst runs carry 88, 87 and 83 directives. Per-reflex caps
 * exist but nothing bounds the sum, so a capped reflex just relocates the spin
 * to an uncapped one — mid-loop-intervention.ts records that happening on
 * 2026-08-01 when the plan-remainder cap pushed the loop into force_write.
 *
 * 24 is roughly 2x the observed healthy per-run rate: generous for a real
 * multi-stage repair, decisively short of a spin.
 */
export const MAX_DIRECTIVES_PER_TURN = 24;

/** Directives that end or record a turn — never budget-refused. */
const TERMINAL_DIRECTIVES = new Set([
  "mid_loop_abort",
  "mark_verified",
  "continue",
  "delegate_skip",
]);

export class DirectiveBudget {
  private counts = new Map<string, number>();
  private spent = 0;

  claim(directiveType: string): boolean {
    if (TERMINAL_DIRECTIVES.has(directiveType)) return true;
    if (this.spent >= MAX_DIRECTIVES_PER_TURN) return false;
    this.spent++;
    this.counts.set(directiveType, (this.counts.get(directiveType) ?? 0) + 1);
    return true;
  }

  exhausted(): boolean {
    return this.spent >= MAX_DIRECTIVES_PER_TURN;
  }

  tally(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
cd server-jarvis && bun test src/orchestration/directive-budget.test.ts
```

- [ ] **Step 5: Wire it at the recording choke point**

`pipeline.ts` already funnels decisions through `recordMidLoopDirective`. Construct one `DirectiveBudget` per turn beside `SemanticPressureBudget`, and at the top of that function:

```ts
      if (!directiveBudget.claim(midLoop.kind)) {
        this.collector.recordDirective?.({
          id: `dir_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          stage: "executor",
          directive_type: "directive_budget_exhausted",
          decision_source: "deterministic_reflex",
          reason: JSON.stringify(directiveBudget.tally()).slice(0, 300),
        });
        return { kind: "continue" };
      }
```

Recording the exhaustion once (not per suppressed directive) is deliberate — the point is to stop the spin, not to log it 60 more times.

- [ ] **Step 6: Full suite and commit**

```bash
cd server-jarvis && bun run typecheck && bun test
```

```bash
git add server-jarvis/src/orchestration/directive-budget.ts server-jarvis/src/orchestration/directive-budget.test.ts server-jarvis/src/orchestration/pipeline.ts && git commit -m "feat(supervision): bound total directives per turn"
```

---

# THEME 6 — Verification

## Task 9: Re-measure and record the new baseline

**Files:** run only.

- [ ] **Step 1: Full suite**

```bash
cd server-jarvis && bun run typecheck && bun test
```

Expected: clean. Any failure means an earlier task broke an existing invariant — fix before continuing.

- [ ] **Step 2: Replay harness**

```bash
cd server-jarvis && bun scripts/replay-conductor.ts --limit 500
```

Compare against today's baseline: 309 violations across 188 runs (38%). `repeated_nudge` (56) and `stage_deadline_exceeded` (49) should not grow.

- [ ] **Step 3: Benchmark, including the new axis**

```bash
cd server-jarvis && bun scripts/benchmark-conductor-completion.ts --limit 500
```

Record: executor no-tool ratio (baseline 42.5%), unchecked writes (baseline ~73), unverified successes (93), false-complete (27).

- [ ] **Step 4: Live-fire, then date-slice**

Restart the server on the new build, run one full-execution turn against a real workspace, then:

```bash
cd server-jarvis && bun scripts/benchmark-conductor-completion.ts --since 2026-08-06T00:00:00Z --limit 200
```

The whole-window numbers are dominated by historical rows and will mask any improvement — slice or the measurement is meaningless.

- [ ] **Step 5: Commit the recorded baseline**

```bash
git add docs && git commit -m "chore(eval): record post-improvement baseline"
```

---

## Execution Order

Theme 1 (Tasks 1-3) → Theme 2 (Task 4) → Theme 3 (Tasks 5-6) → Theme 4 (Task 7) → Theme 5 (Task 8) → Theme 6 (Task 9).

Tasks 1-3 are prerequisites: Task 5 cannot compute per-model no-tool rate without Task 1, Task 4's gate cannot explain its failures without Task 3, and Task 7's root cause is unexplained without Task 2. Tasks 5-8 are independent of each other and may run in parallel once Theme 1 lands.

## Out of Scope

- **Raw model capability.** The free pool's inability to compose correct edits is the standing ceiling named in the 2026-06-30 audit. Every task here targets runtime waste around a capable model, not the model itself.
- **`delegate_snapshot_error` root cause.** Task 2 makes it diagnosable; it does not fix it, because the cause is still unknown and does not reproduce.
- **Historical replay violations.** The 93 unverified successes and 27 false-completes already in the store are immutable. Future measurements must be date-sliced.
- **`mid_loop_continue` semantics.** Task 8 bounds the volume; why the conductor emits `continue` 10.8 times per run is a separate investigation.
