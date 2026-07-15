# Orchestration Live-Session Gaps Implementation Plan (2026-07-15)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the six root-caused defects observed in the 2026-07-15 10:05–10:12am live session (Versutus workspace, session `2cde9d4b`) that make the orchestrator slow, silently lossy, and self-mislearning.

**Architecture:** Every fix lands at an existing seam: `pipeline.ts` stage runners, `index.ts`'s `callModel`/`callModelAttempt` wrapper, `stage-health.ts`, `turn-requirements.ts`, `route-normalization.ts`, and a new `model-scorecard.ts`. No new subsystems; the theme is *integrity* — empty output is failure, strikes hit the model that actually ran, exclusions reach every selection layer, and learning reads truthful labels.

**Tech Stack:** Bun + TypeScript (server-jarvis), bun:test, SQLite (`self-tuning.db`).

---

## Evidence (read this first — it is the spec)

All timestamps UTC (local = UTC−4). Telemetry DB: `C:\Users\ethan\.openclaw\jarvis\self-tuning.db`. Server log: `C:\Users\ethan\AppData\Local\com.jarvis.desktop\logs\server-jarvis.self.log` lines 1265–1344.

### F1 — Planner stage silently dead; empty completions recorded as success
- Last 3 days, `model_attributions`: planner via `opencode_go:deepseek-v4-pro` = **13 attempts, 12 `had_error=1`, 12 `first_token_ms=null`**.
- Same runs in `stage_runs`: **all 15 planner rows today `was_successful=1`, 8 of 15 `output_tokens=0`** (7/12–7/13: 26/202 and 43/248 empty).
- Cause: `runPlannerStage` (pipeline.ts:585–646) hardcodes `was_successful: 1` whenever `callModel` resolves — even when `resp.content` is `""`. The empty-completion cascade-advance in `callModel` (index.ts:2408–2455) is gated on `surfaceAsAnswer === true`, i.e. synthesizer only.
- Effect: every plan-pipeline run executed with `Plan:\n` + nothing; the executor and synthesizer improvised; **the self-tuner rewarded the dead planner model every run** (same failure-reinforcement class as the 2026-07-04 tool-call leak and the 2026-07-12 repetition incident).

### F2 — Stage-health cooldowns never reach the fallback cascade
- run_b78fc067 14:06:14: synthesizer resolved `deepseek-v4-flash` → 30s first-token timeout → strike recorded (`stage-health.ts`, 5-min cooldown).
- run_53f65f06 14:09:08 (2.5 min later, cooldown active): pool pick correctly resolved `deepseek-v4-pro` — **but the actual request went to flash again** (watchdog at 14:09:39: `model=deepseek-v4-flash`) and burned another 30s.
- Cause: `chatCompletionWithFallback` (openrouter.ts:785) picks from `resolveFallbackCascade(cfg, options)` and consults only `isTemporarilyExcluded` (hard-failure memory). The stage-health union built at index.ts:1655–1657 feeds **only** `pool.pickFor`; the fallback call at index.ts:1828–1835 passes the raw per-call `excludeModels`. The cascade's first candidate overrides the pool's resolution, so cooldowns are bypassed whenever `useFallback` is true.
- Cost observed: 30s wasted per plan-run, twice in one session.

### F3 — Trivial interjections clobber continuation-requirement memory
- Turn 1 (`Identify all remaining gaps…`) → `full_execution`. Turn 2 `continue` → `continuation_inherit:full_execution` ✓. Turn `all finished up?` → `answer_only` (trivial short-circuit) — and index.ts:2617 `rememberContinuationRequirement(sessionId, turnReq.requirement)` runs unconditionally, overwriting the memory. Turn 3 `proceed with that deep dive now` matched a continuation pattern but inherited **answer_only** → 45s budget for a 4-stage recursive pipeline.
- Result: run_e683da27 — coordinator 4.1s + planner 16s (empty, F1) left the executor **4.775s** before `Total turn deadline (45000ms) exceeded at stage=executor`; outcome `degraded`.

### F4 — Conductor routes pipelines that cannot fit the turn budget
- Same run: `answer_only` = 45s total, 20s finalization reserve, yet the route was `planner→executor→reviewer→synthesizer/recursive`. Nothing reconciles pipeline depth against `turn-budget.ts` `BUDGETS`. The budget starves the *valuable* stages (executor/synthesizer) last-in-line.

### F5 — Reasoning deltas are invisible (`reasoning_content` unhandled)
- `grep reasoning_content server-jarvis/src` → **zero hits**. The SSE loop reads only `choice.delta?.content` (index.ts:2107; agent loop index.ts:3544).
- A reasoning model that streams thinking first (a) never sets `firstTokenReceived`, so the first-token watchdog kills an actively-working stream, and (b) a thinking-only completion ends as `content=""` → F1's silent empty. Explains planner's `first_token_ms=null` at ~15s durations and the 8:27–8:51am block of `empty_completion` + `stop_reason=length` synthesizer failures ("try again, back to no output").

### F6 — Model selection never learns; trivial turns get the slowest model
- `deepseek-v4-flash` synthesizer: 24 errors / 78 attempts (31%) — still the default every run. `deepseek-v4-pro` synthesizer avg first-token **19.3s** (max 29s). `deepseek-v4-flash` coordinator: **7/7 failures** — re-picked after every 5-min cooldown lapse. Local conductor routing timeout is 30s (persistent-conductor.ts:640) though warm p50 is 2.8–4.1s; the 09:33 turn burned 30s local + 8s API-parse-failure = **38.9s before a deterministic fallback route**.
- `all finished up?` short-circuited to synthesizer-only ✓ but picked `deepseek-v4-pro` → **29.4s** for a status question. The short-circuit path never requests the cheap/fast cascade tier.

**Out of scope, noted for backlog:** skill-distillation candidates are 100% rejected (`body_length_out_of_range`) or stuck `awaiting operator promote` — the distillation loop has never promoted anything; and `Ollama: Could not resolve Windows host IP` warns every ~30s.

---

## File Structure

| File | Change |
|---|---|
| `server-jarvis/src/orchestration/stage-output.ts` | Add `isEmptyStageOutput()` helper |
| `server-jarvis/src/orchestration/pipeline.ts` | Empty-output guards in planner/reviewer/rewriter runners; `advanceOnEmpty`; fast-tier synthesizer flag |
| `server-jarvis/src/index.ts` | `advanceOnEmpty` gate; exclusion union threaded into `chatCompletionWithFallback`; reasoning-delta liveness; remember-requirement gating; route/budget reconcile call; scorecard wiring |
| `server-jarvis/src/sse-delta.ts` (new) | Pure delta extractor (visible vs reasoning) |
| `server-jarvis/src/orchestration/stage-health.ts` | `combinedStageExclusions()` |
| `server-jarvis/src/orchestration/turn-requirements.ts` | `updateContinuationRequirement()` (trivial-turn-proof memory) |
| `server-jarvis/src/orchestration/route-normalization.ts` | `reconcileRouteWithBudget()` |
| `server-jarvis/src/orchestration/model-scorecard.ts` (new) | Rolling per-stage/model error+latency scorecard |
| `server-jarvis/src/orchestration/persistent-conductor.ts` | Routing timeout 30s → 10s |
| `scripts/retro-correct-empty-stages.ts` (new) | One-off label backfill for poisoned `stage_runs` rows |

---

### Task 1: Empty stage output is a failure (F1)

**Files:**
- Modify: `server-jarvis/src/orchestration/stage-output.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:585-646` (`runPlannerStage`) and the analogous reviewer/rewriter runners
- Modify: `server-jarvis/src/index.ts:2408-2412` (`callModel` empty-advance gate)
- Test: `server-jarvis/src/orchestration/stage-output.test.ts`, `server-jarvis/src/orchestration.test.ts`

- [x] **Step 1: Write the failing helper test**

Append to `server-jarvis/src/orchestration/stage-output.test.ts`:

```ts
import { isEmptyStageOutput } from "./stage-output";

describe("isEmptyStageOutput", () => {
  test("empty and whitespace-only content is empty", () => {
    expect(isEmptyStageOutput("")).toBe(true);
    expect(isEmptyStageOutput("   \n\t ")).toBe(true);
    expect(isEmptyStageOutput(undefined)).toBe(true);
    expect(isEmptyStageOutput(null)).toBe(true);
  });
  test("real content is not empty", () => {
    expect(isEmptyStageOutput("1. Read the repo")).toBe(false);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/stage-output.test.ts`
Expected: FAIL — `isEmptyStageOutput` is not exported.

- [x] **Step 3: Implement the helper**

Append to `server-jarvis/src/orchestration/stage-output.ts`:

```ts
/**
 * 2026-07-15 live finding (F1): a model-only stage that resolves with a
 * semantically-empty completion must be treated as a FAILED stage, not a
 * successful one — 12/13 planner attempts over 3 days returned "" while
 * stage_runs recorded success, so the self-tuner kept rewarding the model.
 */
export function isEmptyStageOutput(content: string | null | undefined): boolean {
  return !content || content.trim().length === 0;
}
```

- [x] **Step 4: Run the helper test — expect PASS**

Run: `cd server-jarvis && bun test src/orchestration/stage-output.test.ts`

- [x] **Step 5: Write the failing pipeline test**

Append to `server-jarvis/src/orchestration.test.ts`, following the existing `PipelineExecutor` fixture pattern (see the fixture at lines ~118–133 that fakes `callModel` per `options.stageLabel` and constructs `new PipelineExecutor(callModel as any, runtime, ctx, testCollector)`). Adjust the collector-capture idiom to match whatever `testCollector` in this file provides:

```ts
test("planner empty completion is recorded as a failed stage and the run degrades", async () => {
  const recorded: any[] = [];
  const collector = {
    ...testCollector,
    recordStageRun: (row: any) => { recorded.push(row); },
  };
  const callModel = async (_messages: any[], options: any) => {
    if (options.stageLabel === "planner") return { content: "" };          // the F1 case
    if (options.stageLabel === "executor") return { content: "did work" };
    if (options.stageLabel === "reviewer") return { content: "ACCEPT: fine" };
    return { content: "final answer" };
  };
  const executor = new PipelineExecutor(callModel as any, runtime, ctx, collector as any);
  await executor.execute("plan something", ["planner", "executor", "reviewer", "synthesizer"], () => {}, baseOptions);

  const plannerRow = recorded.find((r) => r.mode_id === "planner");
  expect(plannerRow.was_successful).toBe(0);
  expect(plannerRow.had_error).toBe(1);
  expect(plannerRow.error_message).toBe("empty_completion");
});
```

- [x] **Step 6: Run it to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration.test.ts -t "planner empty completion"`
Expected: FAIL — `was_successful` is `1`.

- [x] **Step 7: Guard the planner runner**

In `server-jarvis/src/orchestration/pipeline.ts` `runPlannerStage`, replace lines 611–627 (`const narrative = resp.content;` through `return { ok: true, narrative };`) with:

```ts
      const narrative = resp.content;
      if (isEmptyStageOutput(narrative)) {
        // F1: empty completion = failed stage. The cascade-advance in
        // callModel (advanceOnEmpty) already tried an alternate model;
        // if we still have nothing, record the truth so the tuner stops
        // rewarding a dead planner, and let the pipeline continue planless.
        onStateChange({ stage: "planner", status: "failed", output: "empty_completion" });
        await this.afterConductorStage("planner", "failed", "empty_completion", agentRunId, options, remainingQueue);
        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "planner",
          turn_number: 1,
          input_tokens: Math.round((plannerPrompt.length + request.length) / 4),
          output_tokens: 0,
          tool_calls_json: "[]",
          duration_ms: Date.now() - startTime,
          was_successful: 0,
          had_error: 1,
          error_message: "empty_completion",
        });
        return { ok: false, narrative: "Failed to generate plan: the planner model returned an empty completion." };
      }
      onStateChange({ stage: "planner", status: "completed", output: narrative });
      await this.afterConductorStage("planner", "completed", narrative, agentRunId, options, remainingQueue);

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "planner",
        turn_number: 1,
        input_tokens: Math.round((plannerPrompt.length + request.length) / 4),
        output_tokens: countTokens(narrative),
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 1,
        had_error: 0,
      });
      return { ok: true, narrative };
```

Import the helper at the top of pipeline.ts alongside the existing stage-output imports: `isEmptyStageOutput`.

- [x] **Step 8: Apply the same guard to reviewer and rewriter runners**

Locate them: `grep -n "stageLabel: \"reviewer\"\|stageLabel: \"rewriter\"" server-jarvis/src/orchestration/pipeline.ts`. In each runner, immediately after the model response's content is extracted, insert the same shape: if `isEmptyStageOutput(content)` → `onStateChange(failed)`, `afterConductorStage(..., "failed", "empty_completion", ...)`, `recordStageRun` with `was_successful: 0, had_error: 1, error_message: "empty_completion"`, and return that stage's typed failure output (`{ ok: false, feedback: "", hasIssues: false }` for reviewer; the rewriter's existing pass-through-original fallback for rewriter). Do NOT alter the executor (tool-call turns legitimately emit zero visible tokens) or the synthesizer (already guarded by `empty_completion` + deferral machinery).

- [x] **Step 9: Extend the empty-advance gate to model-only stages**

In `server-jarvis/src/index.ts:2408-2412`, the wrapper currently reads:

```ts
        const callModel = async (messages: any[], callOptions?: any) => {
          const canRetryStage = Boolean(callOptions?.stageLabel) && cfg.active_backend !== "ollama" && cfg.openrouter.enable_fallbacks;
          const canAdvanceEmpty = callOptions?.surfaceAsAnswer === true && canRetryStage;
```

Change the third line to:

```ts
          const canAdvanceEmpty = (callOptions?.surfaceAsAnswer === true || callOptions?.advanceOnEmpty === true) && canRetryStage;
```

Then in `pipeline.ts`, add `advanceOnEmpty: true` to the `callModel` options objects of the planner, reviewer, and rewriter runners (next to their existing `stageLabel`). Inside the empty-advance loop in index.ts (starting ~line 2451), confirm the advanced-past model receives a `stageHealth.recordFailure({ provider, modelId, stage, kind: "empty_completion" })` strike; if the loop only adds it to the `exclude` set, add the `recordFailure` call beside it.

- [x] **Step 10: Run the pipeline test — expect PASS, then full suite**

Run: `cd server-jarvis && bun test src/orchestration.test.ts -t "planner empty completion" && bun test`
Expected: new test PASS; no regressions (some existing tests may stub planner with `{ content: "" }` as a *success* — update those stubs to return real content, since empty-planner-is-success was the bug).

- [x] **Step 11: Commit**

```bash
git add server-jarvis/src/orchestration/stage-output.ts server-jarvis/src/orchestration/stage-output.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/index.ts server-jarvis/src/orchestration.test.ts
git commit -m "fix(orchestrator): empty model-stage output is a failed stage, not a silent success (F1)"
```

---

### Task 2: Stage-health exclusions must reach the fallback cascade (F2)

**Files:**
- Modify: `server-jarvis/src/orchestration/stage-health.ts`
- Modify: `server-jarvis/src/index.ts:1636-1673` (exclusion build) and `index.ts:1827-1835` (fallback call)
- Test: `server-jarvis/src/orchestration/stage-health.test.ts`

- [x] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/stage-health.test.ts`:

```ts
import { combinedStageExclusions, StageHealthRegistry } from "./stage-health";

describe("combinedStageExclusions", () => {
  test("unions active cooldowns with caller and memory sets", () => {
    const health = new StageHealthRegistry(() => 10_000);
    health.recordFailure({ provider: "opencode_go", modelId: "deepseek-v4-flash", stage: "synthesizer", kind: "first_token_timeout" });
    const result = combinedStageExclusions(
      health,
      "synthesizer",
      new Set(["openrouter:foo"]),
      new Set(["opencode_zen:bar"]),
      undefined,
    );
    expect(result).toEqual(new Set([
      "opencode_go:deepseek-v4-flash",
      "openrouter:foo",
      "opencode_zen:bar",
    ]));
  });
  test("different stage sees only the extra sets", () => {
    const health = new StageHealthRegistry(() => 10_000);
    health.recordFailure({ provider: "opencode_go", modelId: "deepseek-v4-flash", stage: "synthesizer", kind: "first_token_timeout" });
    expect(combinedStageExclusions(health, "executor", new Set(["openrouter:foo"])))
      .toEqual(new Set(["openrouter:foo"]));
  });
});
```

- [x] **Step 2: Run it — expect FAIL (not exported)**

Run: `cd server-jarvis && bun test src/orchestration/stage-health.test.ts`

- [x] **Step 3: Implement the union helper**

Append to `server-jarvis/src/orchestration/stage-health.ts`:

```ts
/**
 * F2 (2026-07-15): stage-health cooldowns previously fed ONLY pool.pickFor.
 * chatCompletionWithFallback picked its own first cascade candidate, so a
 * model in cooldown (flash, struck at 14:06:45) was re-requested at 14:09:08
 * and burned another 30s first-token timeout. Every selection layer must see
 * the SAME exclusion union — build it here, pass it everywhere.
 */
export function combinedStageExclusions(
  registry: StageHealthRegistry,
  stage: string,
  ...extra: Array<ReadonlySet<string> | undefined>
): Set<string> {
  const result = new Set<string>(registry.excludedModelKeys(stage));
  for (const set of extra) {
    if (!set) continue;
    for (const key of set) result.add(key);
  }
  return result;
}
```

- [x] **Step 4: Run the test — expect PASS**

Run: `cd server-jarvis && bun test src/orchestration/stage-health.test.ts`

- [x] **Step 5: Wire the union into both selection layers**

In `server-jarvis/src/index.ts` `callModelAttempt`: hoist the exclusion build out of the `if (stageLabel && cfg.orchestrator?.enabled)` block so the fallback call can see it. Immediately after `const cascadeTier = ...` (line ~1637), add:

```ts
          // F2: one exclusion union for BOTH the pool pick and the fallback
          // cascade. Previously the cascade saw only the per-call exclude set
          // and re-selected models in active stage-health cooldown.
          const stageExclusions = stageLabel
            ? combinedStageExclusions(stageHealth, stageLabel, excludeModels, excludedModelKeys())
            : new Set<string>(excludeModels ?? []);
```

Replace the existing three-line `poolExcludeModels` construction (lines 1655–1657) with `const poolExcludeModels = stageExclusions;` (keep the explanatory comment). Then in the fallback call (line ~1832), change `excludeModels,` to `excludeModels: stageExclusions,`.

Import `combinedStageExclusions` from `./orchestration/stage-health` next to the existing `StageHealthRegistry` import.

- [x] **Step 6: Add a cascade-override observability line**

Right after `actualModelUsed = result.model_used;` (index.ts:1837), add:

```ts
              if (poolModel && result.model_used !== poolModel) {
                console.warn(
                  `[Jarvis Orchestrator] cascade override: pool resolved ${poolModel} but fallback served ` +
                  `${result.provider_used}:${result.model_used} for stage=${callOptions?.stageLabel ?? "agent"}`,
                );
              }
```

This is the line that would have exposed F2 on day one.

- [x] **Step 7: Full suite + typecheck**

Run: `cd server-jarvis && bun test && bunx tsc --noEmit`
Expected: all green.

- [x] **Step 8: Commit**

```bash
git add server-jarvis/src/orchestration/stage-health.ts server-jarvis/src/orchestration/stage-health.test.ts server-jarvis/src/index.ts
git commit -m "fix(orchestrator): thread stage-health cooldowns into the fallback cascade (F2)"
```

---

### Task 3: Reasoning deltas count as liveness (F5)

**Files:**
- Create: `server-jarvis/src/sse-delta.ts`
- Test: `server-jarvis/src/sse-delta.test.ts`
- Modify: `server-jarvis/src/index.ts:2107` (orchestrator read loop) and `index.ts:3544` (agent loop)

- [x] **Step 1: Write the failing test**

Create `server-jarvis/src/sse-delta.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { extractDeltaText } from "./sse-delta";

describe("extractDeltaText", () => {
  test("visible content only", () => {
    expect(extractDeltaText({ delta: { content: "hi" } }))
      .toEqual({ visible: "hi", reasoning: "" });
  });
  test("deepseek-style reasoning_content", () => {
    expect(extractDeltaText({ delta: { reasoning_content: "thinking…" } }))
      .toEqual({ visible: "", reasoning: "thinking…" });
  });
  test("openrouter-style reasoning field", () => {
    expect(extractDeltaText({ delta: { reasoning: "hmm" } }))
      .toEqual({ visible: "", reasoning: "hmm" });
  });
  test("both present", () => {
    expect(extractDeltaText({ delta: { content: "a", reasoning_content: "b" } }))
      .toEqual({ visible: "a", reasoning: "b" });
  });
  test("missing delta", () => {
    expect(extractDeltaText({})).toEqual({ visible: "", reasoning: "" });
    expect(extractDeltaText(undefined)).toEqual({ visible: "", reasoning: "" });
  });
});
```

- [x] **Step 2: Run it — expect FAIL (module missing)**

Run: `cd server-jarvis && bun test src/sse-delta.test.ts`

- [x] **Step 3: Implement the extractor**

Create `server-jarvis/src/sse-delta.ts`:

```ts
// ═══════════════════════════════════════════════════════════════
// F5 (2026-07-15): reasoning models (DeepSeek v4, MiniMax M3, …) stream
// `delta.reasoning_content` (or OpenRouter's `delta.reasoning`) BEFORE any
// visible `delta.content`. The read loops previously saw only `content`, so
// (a) the first-token watchdog killed actively-thinking streams, and (b) a
// thinking-only completion resolved as content="" — the F1 silent-empty.
// This extractor is the single place both loops read a delta from.
// ═══════════════════════════════════════════════════════════════

export interface DeltaText {
  visible: string;
  reasoning: string;
}

export function extractDeltaText(choice: any): DeltaText {
  const delta = choice?.delta;
  return {
    visible: typeof delta?.content === "string" ? delta.content : "",
    reasoning: typeof delta?.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta?.reasoning === "string"
        ? delta.reasoning
        : "",
  };
}
```

- [x] **Step 4: Run the test — expect PASS**

Run: `cd server-jarvis && bun test src/sse-delta.test.ts`

- [x] **Step 5: Wire into the orchestrator read loop**

At `server-jarvis/src/index.ts:2107`, replace `let chunkText = choice.delta?.content || "";` with:

```ts
                const deltaText = extractDeltaText(choice);
                let chunkText = deltaText.visible;
                if (deltaText.reasoning && !firstTokenReceived) {
                  // F5: a reasoning delta proves the model is alive. Disarm the
                  // first-token watchdog (visible-progress watchdog still bounds
                  // how long thinking may run without output). Do NOT set
                  // firstTokenLatencyMs — that metric means VISIBLE first token.
                  firstTokenReceived = true;
                }
```

Preserve everything downstream of `chunkText` unchanged. If `firstTokenReceived = true` currently also assigns `firstTokenLatencyMs` at the same site for visible tokens, keep that assignment attached to the *visible* path only. Import `extractDeltaText` from `./sse-delta`.

- [x] **Step 6: Wire into the agent loop**

At `index.ts:3544`, replace `let content: string | undefined = json.choices?.[0]?.delta?.content;` with:

```ts
                const agentDelta = extractDeltaText(json.choices?.[0]);
                let content: string | undefined = agentDelta.visible || undefined;
                if (agentDelta.reasoning && !firstTokenReceived) {
                  firstTokenReceived = true;
                }
```

- [x] **Step 7: Full suite + typecheck, then commit**

Run: `cd server-jarvis && bun test && bunx tsc --noEmit`

```bash
git add server-jarvis/src/sse-delta.ts server-jarvis/src/sse-delta.test.ts server-jarvis/src/index.ts
git commit -m "fix(orchestrator): reasoning deltas count for stream liveness (F5)"
```

---

### Task 4: Trivial turns must not clobber requirement memory (F3)

**Files:**
- Modify: `server-jarvis/src/orchestration/turn-requirements.ts`
- Modify: `server-jarvis/src/index.ts:2617`
- Test: `server-jarvis/src/orchestration/turn-requirements.test.ts`

- [x] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/turn-requirements.test.ts`:

```ts
import { shouldRememberRequirement } from "./turn-requirements";

describe("shouldRememberRequirement", () => {
  test("substantive turns update memory", () => {
    expect(shouldRememberRequirement(false)).toBe(true);
  });
  test("short-circuited trivial turns do NOT update memory", () => {
    // F3: "all finished up?" (answer_only, trivial short-circuit) overwrote
    // the remembered full_execution; the next "proceed with that deep dive
    // now" continuation then inherited a 45s answer_only budget and degraded.
    expect(shouldRememberRequirement(true)).toBe(false);
  });
});
```

- [x] **Step 2: Run it — expect FAIL (not exported)**

Run: `cd server-jarvis && bun test src/orchestration/turn-requirements.test.ts`

- [x] **Step 3: Implement**

Append to `server-jarvis/src/orchestration/turn-requirements.ts`:

```ts
/**
 * F3 (2026-07-15): continuation-requirement memory exists so "continue"-class
 * turns inherit the last SUBSTANTIVE requirement. A trivial short-circuited
 * interjection ("all finished up?") must not overwrite it — the interjection
 * carries no task signal of its own.
 */
export function shouldRememberRequirement(wasShortCircuited: boolean): boolean {
  return !wasShortCircuited;
}
```

- [x] **Step 4: Run the test — expect PASS**

- [x] **Step 5: Gate the call site**

In `server-jarvis/src/index.ts:2617`, replace:

```ts
        rememberContinuationRequirement(sessionId, turnReq.requirement);
```

with:

```ts
        if (shouldRememberRequirement(shortCircuit)) {
          rememberContinuationRequirement(sessionId, turnReq.requirement);
        }
```

Add `shouldRememberRequirement` to the existing `./orchestration/turn-requirements` import at index.ts:123.

- [x] **Step 6: Full suite, then commit**

Run: `cd server-jarvis && bun test && bunx tsc --noEmit`

```bash
git add server-jarvis/src/orchestration/turn-requirements.ts server-jarvis/src/orchestration/turn-requirements.test.ts server-jarvis/src/index.ts
git commit -m "fix(orchestrator): trivial short-circuit turns no longer clobber continuation-requirement memory (F3)"
```

---

### Task 5: Reconcile the routed pipeline against the turn budget (F4)

**Files:**
- Modify: `server-jarvis/src/orchestration/route-normalization.ts`
- Modify: `server-jarvis/src/index.ts` (immediately after `normalizeRoute` at line 2610)
- Test: `server-jarvis/src/orchestration/route-normalization.test.ts`

- [x] **Step 1: Write the failing test**

Append to `server-jarvis/src/orchestration/route-normalization.test.ts`:

```ts
import { reconcileRouteWithBudget } from "./route-normalization";

describe("reconcileRouteWithBudget", () => {
  test("a 4-stage pipeline under a 45s answer_only budget sheds reviewer then planner", () => {
    // F4: run_e683da27 — answer_only (45s turn, 20s reserve) was routed
    // planner→executor→reviewer→synthesizer; the executor got 4.775s.
    const { pipeline, dropped } = reconcileRouteWithBudget(
      ["planner", "executor", "reviewer", "synthesizer"],
      45_000,
      20_000,
      4_000, // coordinator already spent
    );
    expect(pipeline).toEqual(["executor", "synthesizer"]);
    expect(dropped).toEqual(["reviewer", "planner"]);
  });
  test("a full_execution budget keeps the full pipeline", () => {
    const { pipeline, dropped } = reconcileRouteWithBudget(
      ["planner", "executor", "reviewer", "synthesizer"],
      150_000,
      30_000,
      4_000,
    );
    expect(pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
    expect(dropped).toEqual([]);
  });
  test("executor and synthesizer are never dropped", () => {
    const { pipeline } = reconcileRouteWithBudget(["executor", "synthesizer"], 20_000, 15_000, 4_000);
    expect(pipeline).toEqual(["executor", "synthesizer"]);
  });
});
```

- [x] **Step 2: Run it — expect FAIL (not exported)**

Run: `cd server-jarvis && bun test src/orchestration/route-normalization.test.ts`

- [x] **Step 3: Implement**

Append to `server-jarvis/src/orchestration/route-normalization.ts`:

```ts
/**
 * F4 (2026-07-15): the conductor can route a pipeline whose stages cannot
 * possibly fit the turn budget (answer_only = 45s got a 4-stage recursive
 * route; the executor was left 4.775s). Reconcile depth against the budget
 * BEFORE execution: shed advisory stages (rewriter → reviewer → planner, in
 * that order) until the floor-cost estimate fits. Executor and synthesizer —
 * the stages that produce the answer — are never shed. Best-effort: if the
 * irreducible pair still exceeds the budget, return it anyway (the turn
 * budget's own deadline machinery remains the hard bound).
 */
const STAGE_FLOOR_MS: Record<string, number> = {
  planner: 12_000,
  executor: 15_000,
  reviewer: 12_000,
  rewriter: 8_000,
  synthesizer: 20_000,
};
const BUDGET_DROP_ORDER = ["rewriter", "reviewer", "planner"] as const;

export function reconcileRouteWithBudget(
  pipeline: string[],
  turnMs: number,
  finalizationReserveMs: number,
  alreadySpentMs: number,
): { pipeline: string[]; dropped: string[] } {
  const available = turnMs - finalizationReserveMs - Math.max(0, alreadySpentMs);
  const cost = (stages: string[]) =>
    stages.reduce((sum, s) => sum + (STAGE_FLOOR_MS[s] ?? 10_000), 0);
  const result = [...pipeline];
  const dropped: string[] = [];
  for (const candidate of BUDGET_DROP_ORDER) {
    if (cost(result) <= available) break;
    const idx = result.indexOf(candidate);
    if (idx >= 0) {
      result.splice(idx, 1);
      dropped.push(candidate);
    }
  }
  return { pipeline: result, dropped };
}
```

- [x] **Step 4: Run the test — expect PASS**

- [x] **Step 5: Call it at the route boundary**

In `server-jarvis/src/index.ts`, after `const executablePipeline = normalized.pipeline;` (line 2615), the turn budget for this requirement is derivable from `createTurnBudget(turnReq.requirement, …)` — locate where `turnBudget` is created for this turn (grep `createTurnBudget(` in index.ts) and, once it exists alongside `coordinatorDurationMs` (line 2585), insert:

```ts
        // F4: shed advisory stages the budget cannot possibly fit.
        const reconciled = reconcileRouteWithBudget(
          executablePipeline,
          turnBudget.turn_ms,
          turnBudget.finalization_reserve_ms,
          coordinatorDurationMs,
        );
        if (reconciled.dropped.length > 0) {
          console.warn(
            `[Jarvis Orchestrator] route_budget_reconciled: dropped ${reconciled.dropped.join(",")} ` +
            `(requirement=${turnReq.requirement} turn_ms=${turnBudget.turn_ms})`,
          );
        }
```

and use `reconciled.pipeline` wherever `executablePipeline` is consumed downstream (including `outcomeCollector.startAgentRun` at line 2631 and the pipeline executor invocation). If `turnBudget` is created *after* this block in the current code, move the reconcile to just after its creation — the requirement is only that reconciliation happens before the first stage runs. Note: `normalizeRoute` may have *added* reviewer to satisfy `full_execution` invariants — reconcile runs after normalization on purpose, and full_execution's 150s budget never triggers drops, so the invariant survives.

Import `reconcileRouteWithBudget` next to the existing `normalizeRoute` import.

- [x] **Step 6: Full suite + typecheck, then commit**

Run: `cd server-jarvis && bun test && bunx tsc --noEmit`

```bash
git add server-jarvis/src/orchestration/route-normalization.ts server-jarvis/src/orchestration/route-normalization.test.ts server-jarvis/src/index.ts
git commit -m "feat(orchestrator): reconcile routed pipeline depth against the turn budget (F4)"
```

---

### Task 6: Model scorecard — selection learns from its own telemetry (F6)

**Files:**
- Create: `server-jarvis/src/orchestration/model-scorecard.ts`
- Test: `server-jarvis/src/orchestration/model-scorecard.test.ts`
- Modify: `server-jarvis/src/index.ts` (record at the `recordInferenceAttempt` site ~line 2384; exclude via Task 2's union; cheap tier for short-circuit synthesizer)
- Modify: `server-jarvis/src/orchestration/pipeline.ts` (synthesizer `cascadeTier` plumb)

- [x] **Step 1: Write the failing scorecard test**

Create `server-jarvis/src/orchestration/model-scorecard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ModelScorecard } from "./model-scorecard";

const KEY = "opencode_go:deepseek-v4-flash";

describe("ModelScorecard", () => {
  test("below the minimum sample size nothing is unfit", () => {
    const sc = new ModelScorecard();
    for (let i = 0; i < 5; i++) sc.record("coordinator", KEY, { ok: false });
    expect(sc.unfitKeys("coordinator").size).toBe(0);
  });
  test("a model failing >=50% of >=6 attempts is unfit for that stage only", () => {
    const sc = new ModelScorecard();
    // The live coordinator evidence: deepseek-v4-flash 7/7 failures.
    for (let i = 0; i < 7; i++) sc.record("coordinator", KEY, { ok: false });
    expect(sc.unfitKeys("coordinator")).toEqual(new Set([KEY]));
    expect(sc.unfitKeys("reviewer").size).toBe(0);
  });
  test("recovery: recent successes push the window below the threshold", () => {
    const sc = new ModelScorecard();
    for (let i = 0; i < 6; i++) sc.record("coordinator", KEY, { ok: false });
    for (let i = 0; i < 14; i++) sc.record("coordinator", KEY, { ok: true });
    // window of 20: 6 fails / 20 = 30% < 50%
    expect(sc.unfitKeys("coordinator").size).toBe(0);
  });
  test("window trims to the most recent 20 attempts", () => {
    const sc = new ModelScorecard();
    for (let i = 0; i < 20; i++) sc.record("synthesizer", KEY, { ok: false });
    for (let i = 0; i < 20; i++) sc.record("synthesizer", KEY, { ok: true });
    expect(sc.unfitKeys("synthesizer").size).toBe(0);
  });
  test("p50 first-token latency", () => {
    const sc = new ModelScorecard();
    for (const ms of [1000, 2000, 30000]) sc.record("synthesizer", KEY, { ok: true, firstTokenMs: ms });
    expect(sc.p50FirstToken("synthesizer", KEY)).toBe(2000);
  });
});
```

- [x] **Step 2: Run it — expect FAIL (module missing)**

Run: `cd server-jarvis && bun test src/orchestration/model-scorecard.test.ts`

- [x] **Step 3: Implement the scorecard**

Create `server-jarvis/src/orchestration/model-scorecard.ts`:

```ts
// ═══════════════════════════════════════════════════════════════
// F6 (2026-07-15): the self-tuning DB knew deepseek-v4-flash was 0/7 on
// coordinator parses and 24/78 on synthesizer attempts — and the pool kept
// picking it anyway. This scorecard is the in-process rolling memory that
// turns attempt telemetry into selection pressure: a model failing ≥50% of
// its last ≥6 attempts AT A STAGE is excluded from that stage until recent
// successes dilute the window. Keys are `provider:model_id` to match the
// exclusion-set format used by pickFor and chatCompletionWithFallback.
// ═══════════════════════════════════════════════════════════════

export interface ScorecardAttempt {
  ok: boolean;
  firstTokenMs?: number;
}

const WINDOW_SIZE = 20;
const MIN_SAMPLES = 6;
const UNFIT_ERROR_RATE = 0.5;

export class ModelScorecard {
  private readonly attempts = new Map<string, ScorecardAttempt[]>();

  private slot(stage: string, providerModelKey: string): ScorecardAttempt[] {
    const key = `${stage}|${providerModelKey}`;
    let list = this.attempts.get(key);
    if (!list) {
      list = [];
      this.attempts.set(key, list);
    }
    return list;
  }

  record(stage: string, providerModelKey: string, attempt: ScorecardAttempt): void {
    const list = this.slot(stage, providerModelKey);
    list.push(attempt);
    if (list.length > WINDOW_SIZE) list.splice(0, list.length - WINDOW_SIZE);
  }

  errorRate(stage: string, providerModelKey: string): number | undefined {
    const list = this.slot(stage, providerModelKey);
    if (list.length < MIN_SAMPLES) return undefined;
    return list.filter((a) => !a.ok).length / list.length;
  }

  unfitKeys(stage: string): Set<string> {
    const result = new Set<string>();
    const prefix = `${stage}|`;
    for (const key of this.attempts.keys()) {
      if (!key.startsWith(prefix)) continue;
      const providerModelKey = key.slice(prefix.length);
      const rate = this.errorRate(stage, providerModelKey);
      if (rate !== undefined && rate >= UNFIT_ERROR_RATE) result.add(providerModelKey);
    }
    return result;
  }

  p50FirstToken(stage: string, providerModelKey: string): number | undefined {
    const latencies = this.slot(stage, providerModelKey)
      .map((a) => a.firstTokenMs)
      .filter((ms): ms is number => typeof ms === "number")
      .sort((a, b) => a - b);
    if (latencies.length === 0) return undefined;
    return latencies[Math.floor((latencies.length - 1) / 2)];
  }
}
```

- [x] **Step 4: Run the test — expect PASS**

- [x] **Step 5: Wire recording and exclusion in index.ts**

1. Near `const stageHealth = new StageHealthRegistry();` (index.ts:238), add:

```ts
const modelScorecard = new ModelScorecard();
```

2. In `callModelAttempt`'s `finally` block (index.ts:2383–2396), beside the existing `recordInferenceAttempt` call, add:

```ts
              modelScorecard.record(attemptStage, `${attemptProvider}:${attemptModel}`, {
                ok: attemptOutcome === "success" || attemptOutcome === "truncated",
                firstTokenMs: attemptFirstTokenMs,
              });
```

(Check `InferenceAttemptOutcome`'s members in `inference-metrics.ts:87` — count only genuine completions as ok; `truncated` counts as an arrival, not a hang, which is what the scorecard measures. If in doubt, `ok: attemptOutcome === "success"` is the conservative choice.)

3. In Task 2's exclusion union (the `stageExclusions` construction), add the scorecard set:

```ts
          const stageExclusions = stageLabel
            ? combinedStageExclusions(stageHealth, stageLabel, excludeModels, excludedModelKeys(), modelScorecard.unfitKeys(stageLabel))
            : new Set<string>(excludeModels ?? []);
```

Safety valve is already present in both consumers: `pickFor` returns `undefined` when everything is excluded (config default takes over) and `chatCompletionWithFallback` falls back to the original cascade when exclusions empty it (openrouter.ts:807–813).

- [x] **Step 6: Fast tier for trivial short-circuit synthesizer**

Evidence: `all finished up?` → synthesizer-only route, `deepseek-v4-pro`, 29.4s.

1. In `server-jarvis/src/orchestration/pipeline.ts`, add to `PipelineExecuteOptions` (the interface consumed as `options` in the stage runners): `preferFastSynthesizer?: boolean;`.
2. Find the synthesizer's `callModel` invocation (`grep -n "stageLabel: \"synthesizer\"" server-jarvis/src/orchestration/pipeline.ts`) and add to its options object:

```ts
        cascadeTier: options.preferFastSynthesizer ? "cheap" : undefined,
```

3. In `index.ts`, where the pipeline execute options are assembled for this turn (the object that already carries `turnRequirement`), add:

```ts
          preferFastSynthesizer: routeSource === "trivial_short_circuit",
```

`cascadeTier: "cheap"` selects `cascadeChain(...)[0]` — the fastest/cheapest agent (index.ts:1658–1660) — instead of the stage default.

- [x] **Step 7: Full suite + typecheck, then commit**

Run: `cd server-jarvis && bun test && bunx tsc --noEmit`

```bash
git add server-jarvis/src/orchestration/model-scorecard.ts server-jarvis/src/orchestration/model-scorecard.test.ts server-jarvis/src/index.ts server-jarvis/src/orchestration/pipeline.ts
git commit -m "feat(orchestrator): rolling model scorecard drives stage exclusion + fast tier for trivial turns (F6)"
```

---

### Task 7: Cut the coordinator failure ladder from 38s to <12s (F6/F7)

**Files:**
- Modify: `server-jarvis/src/orchestration/persistent-conductor.ts:640`
- Modify: `server-jarvis/src/index.ts:2558-2575` (deterministic skip condition)
- Test: `server-jarvis/src/orchestration/persistent-conductor.test.ts`

- [x] **Step 1: Write the failing timeout test**

Append to `server-jarvis/src/orchestration/persistent-conductor.test.ts` (follow the file's existing fixture style for constructing the conductor):

```ts
test("routing call timeout is 10s — a hung local conductor must not burn 30s before API fallback", () => {
  // 2026-07-15 09:33 local: warm conductor p50 is 2.8–4.1s, but a hung call
  // held the turn for the full 30s, then the API coordinator parse-failed,
  // totalling 38.9s before the deterministic route. 10s covers p99 warm
  // latency with margin while capping the hang tax.
  expect(ROUTING_TIMEOUT_MS).toBe(10_000);
});
```

Export the constant in the next step so it is testable.

- [x] **Step 2: Run it — expect FAIL**

Run: `cd server-jarvis && bun test src/orchestration/persistent-conductor.test.ts -t "routing call timeout"`

- [x] **Step 3: Implement**

In `server-jarvis/src/orchestration/persistent-conductor.ts`, replace the inline `timeoutMs: 30_000,` at line 640 with a named exported constant near the top of the file:

```ts
/** F7 (2026-07-15): routing must fail fast — warm p50 is 2.8–4.1s. */
export const ROUTING_TIMEOUT_MS = 10_000;
```

and at line 640: `timeoutMs: ROUTING_TIMEOUT_MS,`. Leave `warmUp`'s 30s (line 382) alone — cold-start warming legitimately takes longer.

- [x] **Step 4: Run the test — expect PASS**

- [x] **Step 5: Skip the API coordinator when its candidates are scorecard-unfit**

In `server-jarvis/src/index.ts`, the current skip (lines 2558–2575) only fires for advisory `workspace_read`. Broaden using Task 6's scorecard — replace:

```ts
        const coordinatorParseExcluded = stageHealth.excludedModelKeys("coordinator").size > 0;
        const skipAdvisoryCoordinator =
          !shortCircuit &&
          coordinatorIsAdvisoryOnly(turnReq.requirement) &&
          !localConductorAvailable &&
          coordinatorParseExcluded;
```

with:

```ts
        const coordinatorParseExcluded = stageHealth.excludedModelKeys("coordinator").size > 0;
        // F7: the API coordinator's default (deepseek-v4-flash) was 0/7 on
        // JSON parses over the last 3 days — when the local conductor is down
        // AND the API candidates are struck or scorecard-unfit, an API round
        // trip is pure latency before the same deterministic route.
        const coordinatorUnfit = modelScorecard.unfitKeys("coordinator").size > 0;
        const skipAdvisoryCoordinator =
          !shortCircuit &&
          !localConductorAvailable &&
          (coordinatorParseExcluded || coordinatorUnfit) &&
          (coordinatorIsAdvisoryOnly(turnReq.requirement) || coordinatorUnfit);
```

and extend the deterministic branch (line 2570) from `skipAdvisoryCoordinator && turnReq.requirement === "workspace_read"` to plain `skipAdvisoryCoordinator`, calling `buildDeterministicRoute(turnReq.requirement)`. Check `buildDeterministicRoute`'s signature — if it currently only accepts `"workspace_read"`, extend it to map each `TurnRequirement` to its canonical normalized pipeline (the same shapes `normalizeRoute` would enforce: `conversational`/`answer_only` → `["synthesizer"]`, `workspace_read` → `["executor","synthesizer"]`, `full_execution` → `["planner","executor","reviewer","synthesizer"]`), and add a unit test for each mapping in its test file.

- [x] **Step 6: Full suite + typecheck, then commit**

Run: `cd server-jarvis && bun test && bunx tsc --noEmit`

```bash
git add server-jarvis/src/orchestration/persistent-conductor.ts server-jarvis/src/orchestration/persistent-conductor.test.ts server-jarvis/src/index.ts
git commit -m "feat(orchestrator): fast-fail conductor ladder — 10s routing timeout + scorecard-gated API skip (F7)"
```

---

### Task 8: Retro-correct the poisoned learning labels

**Files:**
- Create: `scripts/retro-correct-empty-stages.ts`

The tuner has days of `stage_runs` rows scoring empty planner/reviewer/rewriter output as success (F1). Mirror the 2026-07-04 tool-call-leak retro-mark so learned stats stop reinforcing the dead configuration.

- [x] **Step 1: Write the script**

Create `scripts/retro-correct-empty-stages.ts`:

```ts
// One-off retro-correction (run manually with: bun scripts/retro-correct-empty-stages.ts)
// F1 (2026-07-15): model-only stages that returned empty completions were
// recorded was_successful=1 — 8/15 planner rows on 7/15 alone, 43/248 on
// 7/13. Re-label them so the self-tuner stops rewarding dead stages.
// Executor rows are NOT touched: tool-call turns legitimately emit 0 tokens.
import { Database } from "bun:sqlite";

const DB_PATH = "C:/Users/ethan/.openclaw/jarvis/self-tuning.db";
const db = new Database(DB_PATH);

const preview = db.query(`
  SELECT mode_id, COUNT(*) AS n FROM stage_runs
  WHERE mode_id IN ('planner','reviewer','rewriter')
    AND (output_tokens = 0 OR output_tokens IS NULL)
    AND tool_calls_json = '[]'
    AND was_successful = 1
    AND created_at >= '2026-07-10'
  GROUP BY mode_id
`).all();
console.log("Rows to re-label:", JSON.stringify(preview));

db.run(`
  UPDATE stage_runs
  SET was_successful = 0,
      had_error = 1,
      error_message = 'empty_completion_retro_20260715'
  WHERE mode_id IN ('planner','reviewer','rewriter')
    AND (output_tokens = 0 OR output_tokens IS NULL)
    AND tool_calls_json = '[]'
    AND was_successful = 1
    AND created_at >= '2026-07-10'
`);
console.log("Done. Restart the server so heuristics re-read corrected labels.");
```

- [x] **Step 2: Dry-run the preview query only**

Run: `cd "$HOME" && bun -e "const {Database}=require('bun:sqlite');const db=new Database('C:/Users/ethan/.openclaw/jarvis/self-tuning.db',{readonly:true});console.log(JSON.stringify(db.query(\"SELECT mode_id,COUNT(*) n FROM stage_runs WHERE mode_id IN ('planner','reviewer','rewriter') AND (output_tokens=0 OR output_tokens IS NULL) AND tool_calls_json='[]' AND was_successful=1 AND created_at>='2026-07-10'\").all()))"`
Expected: non-zero planner count (≈80+ rows across 7/10–7/15).

- [x] **Step 3: Operator step — run the script once against the LIVE db (server stopped), then commit the script**

```bash
git add scripts/retro-correct-empty-stages.ts
git commit -m "chore(self-tuning): retro-correct empty-stage rows mislabeled as success (F1 backfill)"
```

---

### Task 9: Verification gate

- [x] **Step 1: Full suites**

Run: `cd server-jarvis && bun test && bunx tsc --noEmit`
Run: `cd src-tauri && cargo test` (if the working tree touches nothing under src-tauri this is confirmatory only)
Expected: everything green (baseline was 1043/1043 bun + 85/85 cargo).

- [x] **Step 2: Live smoke — replay today's failure session shape**

Start the dev server, then via the UI or API replay the four-turn shape against a real workspace:
1. A `full_execution`-class request ("Identify all remaining gaps in <repo> for X") — assert in the self-log: planner either produces tokens or logs `empty_completion` with a `failed` stage (never `completed` with 0 tokens); no `cascade override` warning naming a cooled-down model.
2. `continue` — assert `continuation_inherit:full_execution`.
3. `all finished up?` — assert `trivial_short_circuit`, cheap-tier synthesizer, wall time well under 15s.
4. `proceed with that deep dive now` — assert the requirement inherits `full_execution` (not `default_answer_only`) and no `Total turn deadline (45000ms)` error.

Check with: `grep -E "empty_completion|cascade override|continuation_inherit|route_budget_reconciled|trivial_short_circuit" "C:\Users\ethan\AppData\Local\com.jarvis.desktop\logs\server-jarvis.self.log" | tail -30` (or the repo-dev-server equivalent under `~/.openclaw/jarvis/logs/`).

- [x] **Step 3: Post-deploy telemetry check (operator, next session)**

After a day of use: `stage_runs` planner rows must show `output_tokens=0 → was_successful=0` correlation; `model_attributions` vs `stage_runs` disagreement on planner should be gone; coordinator `deepseek-v4-flash` attempts should approach zero.

---

## Self-Review Notes

- **Spec coverage:** F1→Task 1+8, F2→Task 2, F3→Task 4, F4→Task 5, F5→Task 3, F6→Task 6, F7 (ladder)→Task 7. Backlog items (skill-distillation dead loop, Ollama host-IP warn spam) intentionally excluded — flagged in the Evidence section.
- **Known in-situ checks the executor must do (anchored, not open-ended):** the empty-advance loop's `recordFailure` presence (Task 1 Step 9), `turnBudget` creation order relative to the route block (Task 5 Step 5), `buildDeterministicRoute`'s signature (Task 7 Step 5), and the exact reviewer/rewriter runner shapes (Task 1 Step 8). Each has a grep anchor and target shape specified.
- **Type consistency:** exclusion keys are `provider:model_id` everywhere (`stage-health.ts:39-41`, `agent-pool.ts:300-301`, scorecard); `ScorecardAttempt.ok` is boolean; `reconcileRouteWithBudget` returns `{ pipeline, dropped }`; `extractDeltaText` returns `{ visible, reasoning }` in both call sites.
