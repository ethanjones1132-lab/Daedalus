# Orchestrator Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four post-audit gaps in the Jarvis orchestrator (skipping the "swap to a frontier model" option by explicit user direction — the point of this architecture is to make cheap/free models outperform their solo benchmark) so that: (5) pipeline stages stop losing information at hand-offs, (1) `conductor_replan` (B-02) actually re-invokes the conductor instead of being silently dropped, (4) the eval harness can catch answer-quality regressions, not just routing-plumbing regressions, and (3) per-model capability scores are measured instead of hand-authored, and survive a server restart.

**Architecture:** Four dependent groups, built in this order because each unlocks the next:
- **Group A** — refactor `PipelineExecutor` to carry structured stage state (`PipelineStageState`) instead of ad-hoc truncated strings, and add a reusable `executeSegment()` that can run a bounded slice of the pipeline. This is Priority 5, and it's the prerequisite for Priority 1 (B-02 needs a way to run "half a pipeline" and carry real state into a replan).
- **Group B** — B-02: wire `conductor_replan` to actually pause, re-invoke the conductor with summarized state, and continue with a revised route. Priority 1.
- **Group C** — a live-model semantic eval track (`judge.ts` + a small golden-task suite) that scores real answers against a rubric, separate from the existing deterministic structural harness. Priority 4.
- **Group D** — a benchmark script that runs Group C's judge against every pool model, feeds results into the *already-wired* `SelfTuningStore`/`ConductorLearningLoop` machinery (reused, not reinvented), and persists the resulting learned capability deltas to disk so they survive a restart. Priority 3.

Groups C and D are independent of A and B and could be built in parallel by a second engineer; they're sequenced here for a single linear worker.

**Tech Stack:** Bun + TypeScript, `bun:sqlite` (existing `SelfTuningStore`, unmodified schema), existing OpenRouter/OpenCode Zen/Go provider plumbing, `bun test`.

**Ground truth already confirmed (2026-06-30 audit):** 391 bun tests pass, `tsc --noEmit` clean, eval harness 35/35. Every task below ends with a full `bun test` run — treat any new failure as a real regression, not noise.

---

## Group A — Structured stage output + `executeSegment` (Priority 5)

### Task A1: Create the structured stage-output types and renderers

**Files:**
- Create: `server-jarvis/src/orchestration/stage-output.ts`
- Test: `server-jarvis/src/orchestration/stage-output.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// server-jarvis/src/orchestration/stage-output.test.ts
import { describe, expect, test } from "bun:test";
import {
  renderExecutorSummary,
  renderPlanSummary,
  renderReviewerSummary,
  renderRewriterSummary,
  type ExecutorStageOutput,
  type PlannerStageOutput,
  type ReviewerStageOutput,
  type RewriterStageOutput,
} from "./stage-output";

describe("stage-output renderers", () => {
  test("renderPlanSummary returns the sentinel when no planner ran", () => {
    expect(renderPlanSummary(undefined)).toBe("No planning stage executed.");
  });

  test("renderPlanSummary returns the narrative when present", () => {
    const plan: PlannerStageOutput = { ok: true, narrative: "Step 1: read config.ts" };
    expect(renderPlanSummary(plan)).toBe("Step 1: read config.ts");
  });

  test("renderExecutorSummary returns the sentinel when no executor ran", () => {
    expect(renderExecutorSummary(undefined)).toBe("No execution stage executed.");
  });

  test("renderExecutorSummary includes narrative and tool call results", () => {
    const executor: ExecutorStageOutput = {
      ok: true,
      narrative: "Read the config file.",
      toolCalls: [
        { name: "read_file", arguments: { path: "config.ts" }, output: "export const x = 1;", is_error: false, duration_ms: 12 },
      ],
    };
    const rendered = renderExecutorSummary(executor);
    expect(rendered).toContain("[Executor]: Read the config file.");
    expect(rendered).toContain("[Tool Call Result (read_file)]");
    expect(rendered).toContain("export const x = 1;");
  });

  test("renderExecutorSummary truncates long tool output with a length marker", () => {
    const longOutput = "x".repeat(1500);
    const executor: ExecutorStageOutput = {
      ok: true,
      narrative: "",
      toolCalls: [{ name: "read_file", arguments: {}, output: longOutput, is_error: false, duration_ms: 1 }],
    };
    const rendered = renderExecutorSummary(executor);
    expect(rendered).toContain("more chars, truncated");
    expect(rendered.length).toBeLessThan(longOutput.length);
  });

  test("renderExecutorSummary marks failed tool calls", () => {
    const executor: ExecutorStageOutput = {
      ok: true,
      narrative: "",
      toolCalls: [{ name: "read_file", arguments: {}, output: "not found", is_error: true, duration_ms: 1 }],
    };
    expect(renderExecutorSummary(executor)).toContain("[Tool Call Result (read_file)] FAILED");
  });

  test("renderReviewerSummary returns the sentinel when no reviewer ran", () => {
    expect(renderReviewerSummary(undefined)).toBe("No review stage executed.");
  });

  test("renderReviewerSummary returns feedback when present", () => {
    const reviewer: ReviewerStageOutput = { ok: true, feedback: "Looks complete.", hasIssues: false };
    expect(renderReviewerSummary(reviewer)).toBe("Looks complete.");
  });

  test("renderRewriterSummary returns the sentinel when no rewriter ran", () => {
    expect(renderRewriterSummary(undefined)).toBe("No rewriting stage executed.");
  });

  test("renderRewriterSummary includes narrative and tool calls", () => {
    const rewriter: RewriterStageOutput = {
      ok: true,
      narrative: "Patched the login handler.",
      toolCalls: [{ name: "edit_file", arguments: { path: "login.ts" }, output: "ok", is_error: false, duration_ms: 5 }],
    };
    const rendered = renderRewriterSummary(rewriter);
    expect(rendered).toContain("[Rewriter]: Patched the login handler.");
    expect(rendered).toContain("[Tool Call Result (edit_file)]");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/stage-output.test.ts`
Expected: FAIL — `Cannot find module './stage-output'` (file doesn't exist yet).

- [x] **Step 3: Write the implementation**

```typescript
// server-jarvis/src/orchestration/stage-output.ts
// ═══════════════════════════════════════════════════════════════
// Structured pipeline stage output — replaces the ad-hoc truncated
// string concatenation that used to flow between planner/executor/
// reviewer/rewriter/synthesizer. Each stage produces a typed record
// (with an explicit `ok` flag instead of string-prefix sniffing like
// `plan.startsWith("Failed to generate plan")`), and the render*
// functions turn that record into the exact text the next stage's
// prompt needs. This is also the carry-state type used by the B-02
// conductor_replan loop (see replan.ts / replan-loop.ts) — a replan
// needs to hand the conductor summarized findings, not raw strings.
// ═══════════════════════════════════════════════════════════════

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  is_error: boolean;
  duration_ms: number;
}

export interface PlannerStageOutput {
  ok: boolean;
  narrative: string;
}

export interface ExecutorStageOutput {
  ok: boolean;
  narrative: string;
  toolCalls: ToolCallRecord[];
}

export interface ReviewerStageOutput {
  ok: boolean;
  feedback: string;
  hasIssues: boolean;
}

export interface RewriterStageOutput {
  ok: boolean;
  narrative: string;
  toolCalls: ToolCallRecord[];
}

/** Accumulated state across a pipeline (or pipeline segment). */
export interface PipelineStageState {
  plan?: PlannerStageOutput;
  executor?: ExecutorStageOutput;
  reviewer?: ReviewerStageOutput;
  rewriter?: RewriterStageOutput;
}

const TOOL_OUTPUT_TRUNCATE_AT = 1000;

function renderToolCalls(toolCalls: ToolCallRecord[]): string {
  return toolCalls
    .map((call) => {
      const body = call.output.length > TOOL_OUTPUT_TRUNCATE_AT
        ? `${call.output.slice(0, TOOL_OUTPUT_TRUNCATE_AT)}... (${call.output.length - TOOL_OUTPUT_TRUNCATE_AT} more chars, truncated)`
        : call.output;
      return `[Tool Call Result (${call.name})]${call.is_error ? " FAILED" : ""}: ${body}`;
    })
    .join("\n\n");
}

export function renderPlanSummary(stage: PlannerStageOutput | undefined): string {
  if (!stage) return "No planning stage executed.";
  return stage.narrative;
}

export function renderExecutorSummary(stage: ExecutorStageOutput | undefined): string {
  if (!stage) return "No execution stage executed.";
  const parts = [
    stage.narrative ? `[Executor]: ${stage.narrative}` : "",
    renderToolCalls(stage.toolCalls),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : "No execution stage executed.";
}

export function renderReviewerSummary(stage: ReviewerStageOutput | undefined): string {
  if (!stage) return "No review stage executed.";
  return stage.feedback;
}

export function renderRewriterSummary(stage: RewriterStageOutput | undefined): string {
  if (!stage) return "No rewriting stage executed.";
  const parts = [
    stage.narrative ? `[Rewriter]: ${stage.narrative}` : "",
    renderToolCalls(stage.toolCalls),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : "No rewriting stage executed.";
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/stage-output.test.ts`
Expected: PASS — 9 tests.

- [x] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/stage-output.ts server-jarvis/src/orchestration/stage-output.test.ts
git commit -m "feat(orchestrator): add structured pipeline stage-output types"
```

---

### Task A2: Add `buildSynthesizerContextFromStageState`

**Files:**
- Modify: `server-jarvis/src/orchestration/synth-context.ts`
- Test: `server-jarvis/src/orchestration/synth-context.test.ts` (create if it doesn't already exist; check first)

- [ ] **Step 1: Check for an existing test file**

Run: `ls server-jarvis/src/orchestration/synth-context.test.ts 2>/dev/null || echo "none"`

If it exists, add the new test into it; otherwise create it fresh with just this suite.

- [ ] **Step 2: Write the failing test**

```typescript
// Add to server-jarvis/src/orchestration/synth-context.test.ts
import { describe, expect, test } from "bun:test";
import { buildSynthesizerContextFromStageState } from "./synth-context";
import type { PipelineStageState } from "./stage-output";

describe("buildSynthesizerContextFromStageState", () => {
  test("omits sections with no meaningful stage output", () => {
    const state: PipelineStageState = {};
    const context = buildSynthesizerContextFromStageState("hello", state);
    expect(context).toBe("User Request: hello");
  });

  test("renders plan/executor/reviewer/rewriter sections from structured state", () => {
    const state: PipelineStageState = {
      plan: { ok: true, narrative: "Read config.ts first." },
      executor: {
        ok: true,
        narrative: "Read the file.",
        toolCalls: [{ name: "read_file", arguments: { path: "config.ts" }, output: "export const x = 1;", is_error: false, duration_ms: 3 }],
      },
      reviewer: { ok: true, feedback: "Complete.", hasIssues: false },
    };
    const context = buildSynthesizerContextFromStageState("read config.ts", state);
    expect(context).toContain("Original Plan:\nRead config.ts first.");
    expect(context).toContain("Executor Activity:");
    expect(context).toContain("export const x = 1;");
    expect(context).toContain("Reviewer Feedback:\nComplete.");
    expect(context).not.toContain("Rewriter Activity:");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/synth-context.test.ts`
Expected: FAIL — `buildSynthesizerContextFromStageState` is not exported.

- [ ] **Step 4: Implement (additive — existing `buildSynthesizerContext` is untouched)**

Add to `server-jarvis/src/orchestration/synth-context.ts` (after the existing `buildSynthesizerContext` function):

```typescript
import type { PipelineStageState } from "./stage-output";
import {
  renderExecutorSummary,
  renderPlanSummary,
  renderReviewerSummary,
  renderRewriterSummary,
} from "./stage-output";

/**
 * Structured-state variant of `buildSynthesizerContext`. Renders each stage's
 * typed output through stage-output.ts and delegates to the existing
 * string-based builder so the `SKIP_SENTINELS` filtering stays in one place.
 */
export function buildSynthesizerContextFromStageState(request: string, state: PipelineStageState): string {
  return buildSynthesizerContext(request, {
    plan: renderPlanSummary(state.plan),
    executorSummary: renderExecutorSummary(state.executor),
    reviewerFeedback: renderReviewerSummary(state.reviewer),
    rewriterSummary: renderRewriterSummary(state.rewriter),
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/synth-context.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/synth-context.ts server-jarvis/src/orchestration/synth-context.test.ts
git commit -m "feat(orchestrator): add structured-state synthesizer context builder"
```

---

### Task A3: Extract `runPlannerStage` from `PipelineExecutor.execute()`

This is a **behavior-preserving extraction** — same prompts, same telemetry, same `onStateChange` calls. The only semantic change is the return type: instead of a plain string that sometimes starts with `"Failed to generate plan: "`, it returns `{ ok, narrative }`.

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`

- [ ] **Step 1: Run the full existing test suite first to get a clean baseline**

Run: `cd server-jarvis && bun test src/orchestration.test.ts src/orchestration/`
Expected: all currently-passing tests pass (this is your regression baseline — re-run after every sub-step below).

- [ ] **Step 2: Add the import**

In `server-jarvis/src/orchestration/pipeline.ts`, add to the top imports:

```typescript
import type { PipelineStageState, PlannerStageOutput, ExecutorStageOutput, ReviewerStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";
import { renderExecutorSummary, renderPlanSummary, renderReviewerSummary, renderRewriterSummary } from "./stage-output";
import { buildSynthesizerContextFromStageState } from "./synth-context";
```

(The existing `import { buildSynthesizerContext } from "./synth-context";` can stay — `synth-context.ts` now exports both.)

- [ ] **Step 3: Add the `runPlannerStage` private method to the `PipelineExecutor` class**

Add this method to the class (anywhere after the constructor, e.g. right after `runToolCall`):

```typescript
  private async runPlannerStage(
    request: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<PlannerStageOutput> {
    onStateChange({ stage: "planner", status: "running" });
    const plannerPrompt = stageSystemPrompt("planner", options);
    const startTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: plannerPrompt },
        { role: "user", content: request }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES.planner.temperature,
        max_tokens: BUILTIN_MODES.planner.max_tokens,
        stream: true,
        stageLabel: "planner",
        suppressActivity: false,
        onChunk: (chunk) => {
          onStateChange({ stage: "planner", status: "running", output: chunk });
        }
      });
      const narrative = resp.content;
      onStateChange({ stage: "planner", status: "done", output: narrative });

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
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "planner", status: "failed", output: message });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "planner",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
      });
      return { ok: false, narrative: `Failed to generate plan: ${message}` };
    }
  }
```

- [ ] **Step 4: Replace the inline "1. Planner Stage" block in `execute()` with a call to the new method**

In `execute()`, replace lines 236-286 (the `if (pipeline.includes("planner")) { ... }` block that assigns to the local `plan` variable) with:

```typescript
    let state: PipelineStageState = {};
    if (pipeline.includes("planner")) {
      state.plan = await this.runPlannerStage(request, agentRunId, onStateChange, options);
    }
```

Do **not** delete the rest of `execute()` yet — the executor/reviewer/synthesizer blocks still reference the old `plan` string variable. For this step only, add a compatibility line immediately after so the rest of the method keeps compiling:

```typescript
    const plan = renderPlanSummary(state.plan);
```

(This compatibility line gets deleted in Task A6 once every block is migrated. Leaving it in for now keeps each extraction step independently testable.)

- [ ] **Step 5: Run the test suite**

Run: `cd server-jarvis && bun test src/orchestration.test.ts src/orchestration/`
Expected: PASS, identical results to Step 1's baseline.

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts
git commit -m "refactor(orchestrator): extract runPlannerStage helper (behavior-preserving)"
```

---

### Task A4: Extract `runExecutorStage` (adds structured tool-call collection)

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`

This extraction adds one real behavior change worth calling out: tool call results are now collected into a typed `ToolCallRecord[]` array (via `toolResult.is_error` / `toolResult.duration_ms`, which the existing `runToolCall` already returns) instead of being re-derived later from string-formatted chat messages. The rendered text (`renderExecutorSummary`) groups narrative-then-tool-calls rather than the original's strict chronological interleaving of assistant text and tool results — the *content* is identical, only the ordering within the text blob changes. Run the full suite after this step; if any test asserts exact interleaved ordering of executor output text, that's the one place this plan intentionally diverges — fix the test to check for presence/content instead of exact ordering, don't revert the refactor.

- [ ] **Step 1: Add the `runExecutorStage` method**

```typescript
  private async runExecutorStage(
    request: string,
    planSummary: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
  ): Promise<ExecutorStageOutput> {
    onStateChange({ stage: "executor", status: "running" });
    const executorPrompt = stageSystemPrompt("executor", options);
    const executorMessages: ChatMessage[] = [
      { role: "system", content: executorPrompt },
      { role: "user", content: `User Request: ${request}\n\nPlan:\n${planSummary}` }
    ];
    const toolCalls: ToolCallRecord[] = [];
    const narratives: string[] = [];
    let turnCount = 0;
    let executorDone = false;
    const maxTurns = BUILTIN_MODES.executor.max_turns;
    let executorTurn = 0;

    try {
      while (!executorDone && turnCount < maxTurns) {
        turnCount++;
        executorTurn++;
        const turnStartTime = Date.now();
        let response: any;

        try {
          response = await this.callModel(executorMessages, {
            temperature: BUILTIN_MODES.executor.temperature,
            max_tokens: BUILTIN_MODES.executor.max_tokens,
            tools: getToolsForMode("executor", this.runtime.listTools(), profile),
            stream: true,
            stageLabel: "executor",
            suppressActivity: false,
            onChunk: (chunk) => {
              onStateChange({ stage: "executor", status: "running", output: chunk });
            }
          });

          executorMessages.push({ role: "assistant", content: response.content, tool_calls: response.tool_calls });
          if (response.content) narratives.push(response.content);

          if (response.tool_calls && response.tool_calls.length > 0) {
            for (const tc of response.tool_calls) {
              const toolResult = await this.runToolCall(tc, options);
              const call = parseStreamedToolCall(tc);
              toolCalls.push({
                name: call.name,
                arguments: call.arguments,
                output: toolResult.output,
                is_error: toolResult.is_error,
                duration_ms: toolResult.duration_ms ?? 0,
              });
              executorMessages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: toolResult.output });
              onStateChange({
                stage: "executor",
                status: "running",
                output: `\n[Tool Executed: ${tc.name}]\n`
              });
            }
          } else {
            executorDone = true;
          }

          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "executor",
            turn_number: executorTurn,
            input_tokens: countTokens(JSON.stringify(executorMessages)),
            output_tokens: countTokens(response?.content || ""),
            tool_calls_json: JSON.stringify(response?.tool_calls || []),
            duration_ms: Date.now() - turnStartTime,
            was_successful: 1,
            had_error: 0,
          });
        } catch (err: any) {
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "executor",
            turn_number: executorTurn,
            tool_calls_json: "[]",
            duration_ms: Date.now() - turnStartTime,
            was_successful: 0,
            had_error: 1,
            error_message: errText(err),
          });
          throw err;
        }
      }

      const narrative = narratives.join("\n\n");
      onStateChange({ stage: "executor", status: "done", output: narrative });
      return { ok: true, narrative, toolCalls };
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "executor", status: "failed", output: message });
      return { ok: false, narrative: `Executor failed: ${message}`, toolCalls };
    }
  }
```

- [ ] **Step 2: Replace the inline "2. Executor Stage" block in `execute()`**

Replace the original executor block (the code that built `executorSummary` by filtering `executorMessages`) with:

```typescript
    if (pipeline.includes("executor")) {
      state.executor = await this.runExecutorStage(request, plan, agentRunId, onStateChange, options, profile);
    }
    const executorSummary = renderExecutorSummary(state.executor);
```

(`profile` is already computed earlier in `execute()` as `const profile: ExecutionProfile = options.executionProfile ?? "full";` — keep that line where it is.)

- [ ] **Step 3: Run the test suite**

Run: `cd server-jarvis && bun test src/orchestration.test.ts src/orchestration/`
Expected: PASS. If a test fails on exact executor-summary text ordering, update that assertion to check `toContain(...)` for the relevant substrings instead of exact string equality — do not revert the structured collection.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts
git commit -m "refactor(orchestrator): extract runExecutorStage with structured tool-call records"
```

---

### Task A5: Extract `runRewriterStage` and `runReviewerRewriterLoop`

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`

- [ ] **Step 1: Add `runRewriterStage`**

```typescript
  private async runRewriterStage(
    request: string,
    reviewerFeedback: string,
    executorSummary: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
  ): Promise<RewriterStageOutput> {
    const rewriterPrompt = stageSystemPrompt("rewriter", options);
    const rewriterMessages: ChatMessage[] = [
      { role: "system", content: rewriterPrompt },
      {
        role: "user",
        content: `User Request: ${request}\n\nReviewer Feedback:\n${reviewerFeedback}\n\nExecutor Activity:\n${executorSummary}`
      }
    ];
    const toolCalls: ToolCallRecord[] = [];
    const narratives: string[] = [];
    let rewriterDone = false;
    let rewriterTurn = 0;
    const maxRewriterTurns = BUILTIN_MODES.rewriter.max_turns;

    try {
      while (!rewriterDone && rewriterTurn < maxRewriterTurns) {
        rewriterTurn++;
        const rewStartTime = Date.now();
        let rewriteResp: any;

        try {
          rewriteResp = await this.callModel(rewriterMessages, {
            temperature: BUILTIN_MODES.rewriter.temperature,
            max_tokens: BUILTIN_MODES.rewriter.max_tokens,
            tools: getToolsForMode("rewriter", this.runtime.listTools(), profile),
            stream: true,
            stageLabel: "rewriter",
            suppressActivity: false,
            onChunk: (chunk) => {
              onStateChange({ stage: "rewriter", status: "running", output: chunk });
            }
          });

          rewriterMessages.push({ role: "assistant", content: rewriteResp.content, tool_calls: rewriteResp.tool_calls });
          if (rewriteResp.content) narratives.push(rewriteResp.content);

          if (rewriteResp.tool_calls && rewriteResp.tool_calls.length > 0) {
            for (const tc of rewriteResp.tool_calls) {
              const toolResult = await this.runToolCall(tc, options);
              const call = parseStreamedToolCall(tc);
              toolCalls.push({
                name: call.name,
                arguments: call.arguments,
                output: toolResult.output,
                is_error: toolResult.is_error,
                duration_ms: toolResult.duration_ms ?? 0,
              });
              rewriterMessages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: toolResult.output });
              onStateChange({
                stage: "rewriter",
                status: "running",
                output: `\n[Tool Executed: ${tc.name}]\n`
              });
            }
          } else {
            rewriterDone = true;
          }

          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "rewriter",
            turn_number: rewriterTurn,
            input_tokens: countTokens(JSON.stringify(rewriterMessages)),
            output_tokens: countTokens(rewriteResp?.content || ""),
            tool_calls_json: JSON.stringify(rewriteResp?.tool_calls || []),
            duration_ms: Date.now() - rewStartTime,
            was_successful: 1,
            had_error: 0,
          });
        } catch (err: any) {
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "rewriter",
            turn_number: rewriterTurn,
            tool_calls_json: "[]",
            duration_ms: Date.now() - rewStartTime,
            was_successful: 0,
            had_error: 1,
            error_message: errText(err),
          });
          throw err;
        }
      }

      const narrative = narratives.join("\n\n");
      onStateChange({ stage: "rewriter", status: "done", output: narrative });
      return { ok: true, narrative, toolCalls };
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "rewriter", status: "failed", output: message });
      return { ok: false, narrative: message, toolCalls };
    }
  }
```

- [ ] **Step 2: Add `runReviewerRewriterLoop`**

```typescript
  private async runReviewerRewriterLoop(
    request: string,
    planSummary: string,
    executorSummary: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
  ): Promise<{ reviewer: ReviewerStageOutput; rewriter?: RewriterStageOutput }> {
    const reviewerPrompt = stageSystemPrompt("reviewer", options);
    let loopCount = 0;
    const maxLoops = 3;
    let hasPendingIssues = true;
    let reviewerFeedback = "No review stage executed.";
    let reviewerOk = true;
    let rewriterOutput: RewriterStageOutput | undefined;
    let rewriterSummaryForPrompt = "No rewriting stage executed.";

    while (hasPendingIssues && loopCount < maxLoops) {
      loopCount++;
      onStateChange({ stage: "reviewer", status: "running", output: `\nReview Turn ${loopCount}...\n` });
      const revStartTime = Date.now();

      try {
        const reviewerResp = await this.callModel([
          { role: "system", content: reviewerPrompt },
          {
            role: "user",
            content: `User Request: ${request}\n\nOriginal Plan:\n${planSummary}\n\nExecutor Activity:\n${executorSummary}\n\nRewriter Activity:\n${rewriterSummaryForPrompt}`
          }
        ] as ChatMessage[], {
          temperature: BUILTIN_MODES.reviewer.temperature,
          max_tokens: BUILTIN_MODES.reviewer.max_tokens,
          stream: true,
          stageLabel: "reviewer",
          suppressActivity: false,
          onChunk: (chunk) => {
            onStateChange({ stage: "reviewer", status: "running", output: chunk });
          }
        });

        reviewerFeedback = reviewerResp.content;
        onStateChange({ stage: "reviewer", status: "done", output: reviewerFeedback });

        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "reviewer",
          turn_number: loopCount,
          input_tokens: Math.round((reviewerPrompt.length + request.length + planSummary.length + executorSummary.length + rewriterSummaryForPrompt.length) / 4),
          output_tokens: countTokens(reviewerFeedback),
          tool_calls_json: "[]",
          duration_ms: Date.now() - revStartTime,
          was_successful: 1,
          had_error: 0,
        });

        // NOTE (found during extraction, not changed): this mirrors existing
        // behavior exactly — the rewriter can run whenever the reviewer flags
        // issues, even on a pipeline that didn't request the "rewriter" stage.
        // Gating this on stage inclusion is a legitimate follow-up but is out
        // of scope for this refactor (extract, don't change behavior).
        hasPendingIssues = this.hasIssues(reviewerFeedback);
        if (hasPendingIssues) {
          onStateChange({ stage: "rewriter", status: "running", output: `\nReviewer flagged issues. Rewriting...\n` });
          rewriterOutput = await this.runRewriterStage(request, reviewerFeedback, executorSummary, agentRunId, onStateChange, options, profile);
          rewriterSummaryForPrompt = renderRewriterSummary(rewriterOutput);
        }
      } catch (e: any) {
        const message = errText(e);
        onStateChange({ stage: "reviewer", status: "failed", output: message });
        hasPendingIssues = false;
        reviewerOk = false;

        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "reviewer",
          turn_number: loopCount,
          tool_calls_json: "[]",
          duration_ms: Date.now() - revStartTime,
          was_successful: 0,
          had_error: 1,
          error_message: message,
        });
      }
    }

    return {
      reviewer: { ok: reviewerOk, feedback: reviewerFeedback, hasIssues: this.hasIssues(reviewerFeedback) },
      rewriter: rewriterOutput,
    };
  }
```

- [ ] **Step 3: Replace the inline "3. Reviewer & Rewriter Correction Loop" block in `execute()`**

```typescript
    if (pipeline.includes("reviewer")) {
      const { reviewer, rewriter } = await this.runReviewerRewriterLoop(
        request, plan, executorSummary, agentRunId, onStateChange, options, profile,
      );
      state.reviewer = reviewer;
      if (rewriter) state.rewriter = rewriter;
    }
    const reviewerFeedback = renderReviewerSummary(state.reviewer);
    const rewriterSummary = renderRewriterSummary(state.rewriter);
```

- [ ] **Step 4: Run the test suite**

Run: `cd server-jarvis && bun test src/orchestration.test.ts src/orchestration/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts
git commit -m "refactor(orchestrator): extract runRewriterStage + runReviewerRewriterLoop"
```

---

### Task A6: Extract `runSynthesizerStage`, widen `PipelineProgressState`, add `executeSegment`, and simplify `execute()` to delegate to it

This is the task that actually enables B-02: `executeSegment` can run any bounded slice of `{planner, executor, reviewer, rewriter, synthesizer}` and hand back typed `PipelineStageState`, which is exactly what a mid-pipeline replan needs to carry forward. `execute()`'s linear branch is rewritten to just call `executeSegment()` once — removing the duplicate outcome-computation logic that used to live inline.

**Files:**
- Modify: `server-jarvis/src/orchestration/pipeline.ts`

- [ ] **Step 1: Widen `PipelineProgressState.stage` to include `"conductor_replan"`**

```typescript
export interface PipelineProgressState {
  stage: "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer" | "conductor_replan";
  status: "running" | "done" | "failed";
  output?: string;
}
```

- [ ] **Step 2: Add `runSynthesizerStage`**

```typescript
  private async runSynthesizerStage(
    request: string,
    state: PipelineStageState,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<{ answer: string; fatalError?: string; emptyCompletion: boolean }> {
    onStateChange({ stage: "synthesizer", status: "running" });
    const synthesizerPrompt = stageSystemPrompt("synthesizer", options);
    const synthStartTime = Date.now();
    const contextText = buildSynthesizerContextFromStageState(request, state);
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        { role: "user", content: contextText }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES.synthesizer.temperature,
        max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
        stream: true,
        stageLabel: "synthesizer",
        surfaceAsAnswer: true,
        onChunk: (chunk) => {
          onStateChange({ stage: "synthesizer", status: "running", output: chunk });
        }
      });
      const finalAnswer = resp.content ?? "";

      if (!finalAnswer.trim()) {
        onStateChange({ stage: "synthesizer", status: "failed", output: "(empty completion)" });
        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "synthesizer",
          turn_number: 1,
          input_tokens: Math.round((synthesizerPrompt.length + contextText.length) / 4),
          output_tokens: 0,
          tool_calls_json: "[]",
          duration_ms: Date.now() - synthStartTime,
          was_successful: 0,
          had_error: 1,
          error_message: "empty_completion",
        });
        return { answer: "", emptyCompletion: true };
      }

      onStateChange({ stage: "synthesizer", status: "done", output: finalAnswer });
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        input_tokens: Math.round((synthesizerPrompt.length + contextText.length) / 4),
        output_tokens: countTokens(finalAnswer),
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 1,
        had_error: 0,
      });
      return { answer: finalAnswer, emptyCompletion: false };
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "synthesizer", status: "failed", output: message });
      const fatalError = describePipelineError(message);
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
      });
      return { answer: `Synthesis failed: ${message}`, fatalError, emptyCompletion: false };
    }
  }
```

- [ ] **Step 3: Add `PipelineSegmentResult` and `executeSegment`**

```typescript
export interface PipelineSegmentResult {
  state: PipelineStageState;
  synthesizerAnswer?: string;
  synthesizerFatalError?: string;
  synthesizerEmptyCompletion?: boolean;
}
```

(add this interface near the other exported interfaces, above the `PipelineExecutor` class)

```typescript
  /**
   * Run a bounded slice of {planner, executor, reviewer, rewriter, synthesizer}
   * against a `carry`-forward state. Used directly by `execute()`'s linear
   * branch (with the full pipeline as `stages`) and by the B-02 replan loop
   * (`replan-loop.ts`) to run one segment between `conductor_replan` markers.
   * Synthesizer only runs if `"synthesizer"` is in `stages` — a non-terminal
   * segment stops right after reviewer/rewriter so the replan loop can
   * re-invoke the conductor with the accumulated state.
   */
  async executeSegment(
    request: string,
    stages: StageName[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    carry: PipelineStageState = {},
  ): Promise<PipelineSegmentResult> {
    const state: PipelineStageState = { ...carry };
    const profile: ExecutionProfile = options.executionProfile ?? "full";

    if (stages.includes("planner")) {
      state.plan = await this.runPlannerStage(request, agentRunId, onStateChange, options);
    }
    if (stages.includes("executor")) {
      state.executor = await this.runExecutorStage(request, renderPlanSummary(state.plan), agentRunId, onStateChange, options, profile);
    }
    if (stages.includes("reviewer")) {
      const { reviewer, rewriter } = await this.runReviewerRewriterLoop(
        request, renderPlanSummary(state.plan), renderExecutorSummary(state.executor),
        agentRunId, onStateChange, options, profile,
      );
      state.reviewer = reviewer;
      if (rewriter) state.rewriter = rewriter;
    }

    if (!stages.includes("synthesizer")) {
      return { state };
    }

    const synth = await this.runSynthesizerStage(request, state, agentRunId, onStateChange, options);
    return {
      state,
      synthesizerAnswer: synth.answer,
      synthesizerFatalError: synth.fatalError,
      synthesizerEmptyCompletion: synth.emptyCompletion,
    };
  }
```

- [ ] **Step 4: Rewrite `execute()`'s linear branch to delegate to `executeSegment`**

Replace the ENTIRE body of `execute()` from the `let plan = "No planning stage executed.";` line down through the `const result: PipelineResult = { ... };` / `applyRecursiveCritique` return at the end (i.e. everything after the `canRunSpeculativeCascade` check and before the closing brace of `execute()`) with:

```typescript
    const segment = await this.executeSegment(request, pipeline as StageName[], agentRunId, onStateChange, options);
    const { state } = segment;
    const upstreamDegraded = Boolean((state.plan && !state.plan.ok) || (state.executor && !state.executor.ok));

    if (segment.synthesizerAnswer === undefined) {
      // No synthesizer in this pipeline: fall back to the last completed phase.
      return {
        answer: state.plan ? renderPlanSummary(state.plan) : "No planning stage executed.",
        recursion_depth: 0,
        outcome: upstreamDegraded ? "degraded" : "success",
        error_code: upstreamDegraded ? "upstream_stage_failed" : undefined,
      };
    }

    let outcome: PipelineOutcome;
    let errorCode: string | undefined;
    if (segment.synthesizerFatalError) {
      outcome = "failed";
      errorCode = "stage_error";
    } else if (segment.synthesizerEmptyCompletion) {
      outcome = "failed";
      errorCode = "empty_completion";
    } else if (upstreamDegraded) {
      outcome = "degraded";
      errorCode = "upstream_stage_failed";
    } else {
      outcome = "success";
    }

    const result: PipelineResult = {
      answer: segment.synthesizerEmptyCompletion ? "" : segment.synthesizerAnswer,
      error: segment.synthesizerFatalError,
      recursion_depth: 0,
      outcome,
      error_code: errorCode,
    };
    if (!segment.synthesizerFatalError && !segment.synthesizerEmptyCompletion && pipeline.includes("synthesizer")) {
      return this.applyRecursiveCritique(request, result, agentRunId, onStateChange, options);
    }
    return result;
```

Also delete the now-dead `hasIssues` private method's caller mismatch check — no, leave `hasIssues` in place, it's still called from `runReviewerRewriterLoop`. Just delete the old local variable declarations (`let plan = ...`, `let executorSummary = ...`, `let reviewerFeedback = ...`, `let rewriterSummary = ...`, `const profile = ...` — wait, `profile` is now computed inside `executeSegment`, so also remove the standalone `const profile: ExecutionProfile = options.executionProfile ?? "full";` line from `execute()` if it's left dangling unused) and the compatibility lines added in Tasks A3–A5 (`const plan = renderPlanSummary(...)`, `const executorSummary = renderExecutorSummary(...)`, etc.) — all of that is replaced by the single `executeSegment` call above.

- [ ] **Step 5: Run the full test suite**

Run: `cd server-jarvis && bun test`
Expected: all 391+ tests pass. This is the highest-risk step in Group A — if anything fails, read the failing assertion carefully; it is almost certainly checking either (a) exact executor-summary text ordering (see Task A4's note — fix the assertion) or (b) a leftover unused variable causing a TS error (remove it).

- [ ] **Step 6: Run `tsc --noEmit`**

Run: `cd server-jarvis && bunx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 7: Commit**

```bash
git add server-jarvis/src/orchestration/pipeline.ts
git commit -m "refactor(orchestrator): extract runSynthesizerStage, add executeSegment, simplify execute()"
```

---

### Task A7: Add a focused `executeSegment` test

**Files:**
- Modify: `server-jarvis/src/orchestration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server-jarvis/src/orchestration.test.ts` (reuse the file's existing `testCollector`/`runtime`/`ctx` test fixtures — read the top of the file for their exact construction before writing this test, since they're already defined there for the other `PipelineExecutor` tests):

```typescript
  test("executeSegment carries prior state forward and can stop before synthesizer", async () => {
    const calls: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      calls.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    const first = await executor.executeSegment(
      "do the thing", ["planner", "executor"], "run-segment-1", () => {}, {},
    );
    expect(first.state.plan?.narrative).toBe("output for planner");
    expect(first.state.executor?.narrative).toBe("output for executor");
    expect(first.synthesizerAnswer).toBeUndefined();

    const second = await executor.executeSegment(
      "do the thing", ["reviewer", "synthesizer"], "run-segment-2", () => {}, {}, first.state,
    );
    // Carried-forward state survives into the second segment.
    expect(second.state.plan?.narrative).toBe("output for planner");
    expect(second.state.executor?.narrative).toBe("output for executor");
    expect(second.synthesizerAnswer).toBe("output for synthesizer");
    expect(calls).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration.test.ts -t "executeSegment"`
Expected: FAIL if `executeSegment` isn't public/exported correctly, or PASS immediately if Task A6 already made it correct (in which case this step confirms the behavior rather than driving new code — still valuable as a regression pin, commit it either way).

- [ ] **Step 3: Fix and re-run until green**

Run: `cd server-jarvis && bun test src/orchestration.test.ts -t "executeSegment"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/orchestration.test.ts
git commit -m "test(orchestrator): pin executeSegment carry-forward + partial-pipeline behavior"
```

---

## Group B — B-02: `conductor_replan` actual re-invocation (Priority 1)

Implements `docs/issues/post-phase-4-conductor-evolution.md` B-02's acceptance criteria:
- Replan stage calls local persistent conductor.
- Revised worker instructions flow to subsequent stages.
- `read_only` execution profile cannot escalate to `full`.
- SSE `orchestrator_stage` events include replan (internal status).

### Task B1: `splitPipelineAtReplan` and `buildReplanRequest`

**Files:**
- Create: `server-jarvis/src/orchestration/replan.ts`
- Test: `server-jarvis/src/orchestration/replan.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server-jarvis/src/orchestration/replan.test.ts
import { describe, expect, test } from "bun:test";
import { splitPipelineAtReplan, buildReplanRequest } from "./replan";
import type { PipelineStageState } from "./stage-output";

describe("splitPipelineAtReplan", () => {
  test("returns one segment when there is no replan marker", () => {
    expect(splitPipelineAtReplan(["planner", "executor", "synthesizer"]))
      .toEqual([["planner", "executor", "synthesizer"]]);
  });

  test("splits into ordered segments at each conductor_replan marker", () => {
    const result = splitPipelineAtReplan([
      "planner", "executor", "conductor_replan", "executor", "reviewer", "synthesizer",
    ]);
    expect(result).toEqual([
      ["planner", "executor"],
      ["executor", "reviewer", "synthesizer"],
    ]);
  });

  test("strips re-enter: prefixes and drops nulls, matching Coordinator.executablePipeline", () => {
    const result = splitPipelineAtReplan([null, "re-enter:executor", "conductor_replan", "synthesizer"]);
    expect(result).toEqual([["executor"], ["synthesizer"]]);
  });

  test("drops empty segments (e.g. two replan markers in a row)", () => {
    const result = splitPipelineAtReplan(["executor", "conductor_replan", "conductor_replan", "synthesizer"]);
    expect(result).toEqual([["executor"], ["synthesizer"]]);
  });
});

describe("buildReplanRequest", () => {
  test("includes the original request, carried state, and remaining stages", () => {
    const state: PipelineStageState = {
      plan: { ok: true, narrative: "Step 1: inspect the schema." },
      executor: { ok: true, narrative: "Found an unexpected schema.", toolCalls: [] },
    };
    const text = buildReplanRequest("migrate the users table", state, ["reviewer", "synthesizer"]);
    expect(text).toContain("[MID-PIPELINE REPLAN]");
    expect(text).toContain("migrate the users table");
    expect(text).toContain("Step 1: inspect the schema.");
    expect(text).toContain("Found an unexpected schema.");
    expect(text).toContain("reviewer, synthesizer");
  });

  test("handles an empty carried state without throwing", () => {
    const text = buildReplanRequest("do something", {}, []);
    expect(text).toContain("[MID-PIPELINE REPLAN]");
    expect(text).toContain("re-derive from scratch");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/replan.test.ts`
Expected: FAIL — `Cannot find module './replan'`.

- [ ] **Step 3: Implement**

```typescript
// server-jarvis/src/orchestration/replan.ts
// ═══════════════════════════════════════════════════════════════
// B-02 (Track B, Conductor Recursive Self-Selection): the actual
// re-invocation behavior for the `conductor_replan` meta decision.
// See docs/issues/post-phase-4-conductor-evolution.md B-02.
// ═══════════════════════════════════════════════════════════════

import type { CoordinatorResult, StageName } from "./coordinator";
import type { PipelineStageState } from "./stage-output";
import { renderExecutorSummary, renderPlanSummary, renderReviewerSummary } from "./stage-output";

/**
 * Split a coordinator's raw pipeline into ordered stage-name segments at each
 * `conductor_replan` marker. `re-enter:<stage>` entries collapse to their
 * target stage (matching `Coordinator.executablePipeline`); nulls and empty
 * segments (e.g. two replan markers back to back) are dropped. A pipeline
 * with no `conductor_replan` marker returns exactly one segment.
 */
export function splitPipelineAtReplan(pipeline: CoordinatorResult["pipeline"]): StageName[][] {
  const segments: StageName[][] = [[]];
  for (const step of pipeline) {
    if (!step) continue;
    if (step === "conductor_replan") {
      segments.push([]);
      continue;
    }
    const stage = step.startsWith("re-enter:") ? step.slice("re-enter:".length) : step;
    segments[segments.length - 1].push(stage as StageName);
  }
  return segments.filter((segment) => segment.length > 0);
}

/**
 * Build the mid-pipeline replan request text sent back to the conductor.
 * Feeds SUMMARIZED stage outputs — never raw tool trajectories — per B-02's
 * "enforce intra-workflow isolation" acceptance note.
 */
export function buildReplanRequest(
  originalRequest: string,
  state: PipelineStageState,
  remainingStages: StageName[],
): string {
  const parts = [
    `[MID-PIPELINE REPLAN] Original request:\n${originalRequest}`,
    `Plan so far:\n${renderPlanSummary(state.plan)}`,
    `Executor findings so far:\n${renderExecutorSummary(state.executor)}`,
    state.reviewer ? `Reviewer feedback so far:\n${renderReviewerSummary(state.reviewer)}` : "",
    remainingStages.length > 0
      ? `Stages the previous route still had queued after this replan point: ${remainingStages.join(", ")}`
      : "No stages were queued after this replan point — re-derive from scratch.",
    "The current plan has proven wrong or incomplete given what was just discovered. Re-derive worker_instructions (and pipeline/shared_context if the stage list itself must change) for the remaining work.",
  ].filter(Boolean);
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/replan.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/replan.ts server-jarvis/src/orchestration/replan.test.ts
git commit -m "feat(orchestrator): add B-02 pipeline splitting + replan request builder"
```

---

### Task B2: `max_conductor_replans` config field

**Files:**
- Modify: `server-jarvis/src/config.ts`
- Modify: `server-jarvis/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server-jarvis/src/config.test.ts` (near the existing `expect(defaultConfig().orchestrator.max_recursion_depth).toBe(2);` assertion at line 171):

```typescript
  test("orchestrator.max_conductor_replans defaults to 2 (B-02 replan budget)", () => {
    expect(defaultConfig().orchestrator.max_conductor_replans).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/config.test.ts -t "max_conductor_replans"`
Expected: FAIL — `undefined` is not `2`.

- [ ] **Step 3: Implement**

In `server-jarvis/src/config.ts`, add the field to the `OrchestratorConfig` interface (line 253-261):

```typescript
export interface OrchestratorConfig {
  enabled: boolean;
  agents: OrchestratorAgent[];
  max_recursion_depth: number;
  /** B-02: bound on how many times a single turn may re-invoke the conductor
   *  via `conductor_replan` before the replan loop just runs the remaining
   *  normalized pipeline to completion. Prevents an unbounded replan loop. */
  max_conductor_replans: number;
  conductor: ConductorConfig;
  session_memory: SessionMemoryConfig;
  conductor_learning: ConductorLearningConfig;
  skill_distillation: SkillDistillationConfig;
}
```

And the default value next to `max_recursion_depth: 2,` (around line 423):

```typescript
      max_recursion_depth: 2,
      max_conductor_replans: 2,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/config.test.ts`
Expected: PASS, all config tests green.

- [ ] **Step 5: Run `tsc --noEmit`**

Run: `cd server-jarvis && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/config.ts server-jarvis/src/config.test.ts
git commit -m "feat(config): add orchestrator.max_conductor_replans (B-02 replan budget)"
```

---

### Task B3: `runPipelineWithReplanning`

**Files:**
- Create: `server-jarvis/src/orchestration/replan-loop.ts`
- Test: `server-jarvis/src/orchestration/replan-loop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server-jarvis/src/orchestration/replan-loop.test.ts
import { describe, expect, test } from "bun:test";
import { runPipelineWithReplanning } from "./replan-loop";
import { PipelineExecutor } from "./pipeline";
import { Coordinator } from "./coordinator";
import { ToolRuntime } from "../tool-runtime";
import type { StageRunRecorder } from "./pipeline";
import type { CoordinatorResult } from "./coordinator";

// In-memory collector so this test can never touch the production self-tuning DB.
const testCollector: StageRunRecorder = { recordStageRun: () => {} };
const runtime = new ToolRuntime([]);
const ctx = { session_id: "s1", workspace_path: process.cwd(), surface: "chat" as const };

function baseDecision(overrides: Partial<CoordinatorResult> = {}): CoordinatorResult {
  return {
    task_type: "debug",
    pipeline: ["executor", "conductor_replan", "reviewer", "synthesizer"],
    topology: "linear",
    context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
    coordinator_rationale: "fixture",
    ...overrides,
  };
}

describe("runPipelineWithReplanning", () => {
  test("runs the first segment, re-invokes the conductor, then finishes with the revised route", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      stageLabels.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    let coordinatorCalls = 0;
    const coordinatorCallModel = async () => ({ content: "unused" }); // Coordinator not exercised via API path here
    const coordinator = new Coordinator(coordinatorCallModel as any);
    coordinator.route = (async (request: string) => {
      coordinatorCalls += 1;
      expect(request).toContain("[MID-PIPELINE REPLAN]");
      return {
        task_type: "debug",
        pipeline: ["reviewer", "synthesizer"],
        topology: "linear",
        context: { needs_workspace_inspection: true, needs_memory: false, estimated_complexity: "medium" },
        coordinator_rationale: "revised after discovering the real schema",
        worker_instructions: { reviewer: "focus on the new schema" },
      } as CoordinatorResult;
    }) as typeof coordinator.route;

    const stateEvents: string[] = [];
    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "workspace_read",
      coordinator,
      routeOptions: { sessionId: "s1" },
      executor,
      agentRunId: "run-replan-1",
      onStateChange: (state) => stateEvents.push(`${state.stage}:${state.status}`),
      baseOptions: {},
      maxReplans: 2,
    });

    expect(coordinatorCalls).toBe(1);
    expect(stageLabels).toEqual(["executor", "reviewer", "synthesizer"]);
    expect(stateEvents).toContain("conductor_replan:running");
    expect(stateEvents).toContain("conductor_replan:done");
    expect(result.outcome).toBe("success");
    expect(result.answer).toBe("output for synthesizer");
  });

  test("stops replanning once maxReplans is exhausted and runs the remaining pipeline to completion", async () => {
    const stageLabels: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      stageLabels.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    let coordinatorCalls = 0;
    coordinator.route = (async () => {
      coordinatorCalls += 1;
      // Every replan response ALSO asks to replan again — the budget must win.
      return baseDecision() as CoordinatorResult;
    }) as typeof coordinator.route;

    const result = await runPipelineWithReplanning({
      contextMessage: "migrate the users table",
      initialDecision: baseDecision(),
      turnRequirement: "workspace_read",
      coordinator,
      routeOptions: { sessionId: "s1" },
      executor,
      agentRunId: "run-replan-2",
      onStateChange: () => {},
      baseOptions: {},
      maxReplans: 1,
    });

    expect(coordinatorCalls).toBe(1); // exactly one replan invocation, then budget exhausted
    expect(result.outcome).toBe("success");
  });

  test("read_only profile cannot escalate to full even if the replanned decision implies more authority", async () => {
    const profiles: Array<string | undefined> = [];
    const callModel = async () => ({ content: "ok" });
    const runtimeSpy = new ToolRuntime([]);
    const executor = new PipelineExecutor(callModel as any, runtimeSpy, ctx, testCollector);
    const originalExecuteSegment = executor.executeSegment.bind(executor);
    executor.executeSegment = (async (request, stages, agentRunId, onStateChange, options, carry) => {
      profiles.push(options.executionProfile);
      return originalExecuteSegment(request, stages, agentRunId, onStateChange, options, carry);
    }) as typeof executor.executeSegment;

    const coordinator = new Coordinator((async () => ({ content: "unused" })) as any);
    coordinator.route = (async () => baseDecision({ pipeline: ["reviewer", "synthesizer"] })) as typeof coordinator.route;

    await runPipelineWithReplanning({
      contextMessage: "read the config",
      initialDecision: baseDecision(),
      turnRequirement: "workspace_read", // maps to read_only via normalizeRoute
      coordinator,
      routeOptions: { sessionId: "s1" },
      executor,
      agentRunId: "run-replan-3",
      onStateChange: () => {},
      baseOptions: { executionProfile: "full" }, // caller-supplied "full" must NOT win
      maxReplans: 2,
    });

    expect(profiles.every((p) => p === "read_only")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/orchestration/replan-loop.test.ts`
Expected: FAIL — `Cannot find module './replan-loop'`.

- [ ] **Step 3: Implement**

```typescript
// server-jarvis/src/orchestration/replan-loop.ts
// ═══════════════════════════════════════════════════════════════
// B-02 (Track B, Conductor Recursive Self-Selection): runs a pipeline
// that contains one or more `conductor_replan` meta-decisions.
// See docs/issues/post-phase-4-conductor-evolution.md B-02.
// ═══════════════════════════════════════════════════════════════

import type { Coordinator, CoordinatorResult, CoordinatorRouteOptions } from "./coordinator";
import type { PipelineExecuteOptions, PipelineExecutor, PipelineOutcome, PipelineProgressState, PipelineResult } from "./pipeline";
import type { TurnRequirement } from "./turn-requirements";
import { normalizeRoute } from "./route-normalization";
import { splitPipelineAtReplan, buildReplanRequest } from "./replan";
import type { PipelineStageState } from "./stage-output";

export interface ReplanLoopArgs {
  contextMessage: string;
  initialDecision: CoordinatorResult;
  turnRequirement: TurnRequirement;
  coordinator: Coordinator;
  routeOptions: CoordinatorRouteOptions;
  executor: PipelineExecutor;
  agentRunId: string;
  onStateChange: (state: PipelineProgressState) => void;
  baseOptions: PipelineExecuteOptions;
  maxReplans: number;
}

/**
 * Executes up to the first `conductor_replan` marker, re-invokes the
 * conductor with summarized stage outputs, and continues with the revised
 * route — bounded by `maxReplans`. Once the budget is exhausted, runs the
 * remaining normalized pipeline to completion instead of replanning again,
 * so a turn can never hang on an unbounded replan loop.
 *
 * `turnRequirement` is fixed for the whole turn (it's derived from the raw
 * user message, which doesn't change mid-turn), so re-deriving the execution
 * profile from it on every iteration guarantees a `read_only` turn can never
 * escalate to `full` no matter what the replanned decision asks for.
 */
export async function runPipelineWithReplanning(args: ReplanLoopArgs): Promise<PipelineResult> {
  let decision = args.initialDecision;
  let carry: PipelineStageState = {};
  let replans = 0;

  while (true) {
    const normalized = normalizeRoute(decision, args.turnRequirement, "model");
    const hasReplanMarker = decision.pipeline.includes("conductor_replan");
    const budgetExhausted = replans >= args.maxReplans;

    if (!hasReplanMarker || budgetExhausted) {
      const segment = await args.executor.executeSegment(
        args.contextMessage,
        normalized.pipeline,
        args.agentRunId,
        args.onStateChange,
        {
          ...args.baseOptions,
          topology: normalized.topology,
          executionProfile: normalized.profile,
          workerInstructions: decision.worker_instructions ?? args.baseOptions.workerInstructions,
          sharedContext: decision.shared_context ?? args.baseOptions.sharedContext,
        },
        carry,
      );
      return finalizeSegment(segment);
    }

    const segments = splitPipelineAtReplan(decision.pipeline);
    const firstSegmentStages = segments[0] ?? [];
    args.onStateChange({ stage: "conductor_replan", status: "running", output: "Re-planning remaining stages…" });

    const segment = await args.executor.executeSegment(
      args.contextMessage,
      firstSegmentStages,
      args.agentRunId,
      args.onStateChange,
      {
        ...args.baseOptions,
        topology: "linear",
        executionProfile: normalized.profile,
        workerInstructions: decision.worker_instructions ?? args.baseOptions.workerInstructions,
        sharedContext: decision.shared_context ?? args.baseOptions.sharedContext,
      },
      carry,
    );
    carry = segment.state;

    const remainingStagesHint = segments.slice(1).flat();
    const replanRequestText = buildReplanRequest(args.contextMessage, carry, remainingStagesHint);
    decision = await args.coordinator.route(replanRequestText, args.routeOptions);
    replans += 1;
    args.onStateChange({ stage: "conductor_replan", status: "done", output: decision.coordinator_rationale });
  }
}

function finalizeSegment(segment: Awaited<ReturnType<PipelineExecutor["executeSegment"]>>): PipelineResult {
  const upstreamDegraded = Boolean(
    (segment.state.plan && !segment.state.plan.ok) || (segment.state.executor && !segment.state.executor.ok),
  );

  if (segment.synthesizerAnswer === undefined) {
    return {
      answer: segment.state.plan ? segment.state.plan.narrative : "No planning stage executed.",
      recursion_depth: 0,
      outcome: upstreamDegraded ? "degraded" : "success",
      error_code: upstreamDegraded ? "upstream_stage_failed" : undefined,
    };
  }

  let outcome: PipelineOutcome;
  let errorCode: string | undefined;
  if (segment.synthesizerFatalError) {
    outcome = "failed";
    errorCode = "stage_error";
  } else if (segment.synthesizerEmptyCompletion) {
    outcome = "failed";
    errorCode = "empty_completion";
  } else if (upstreamDegraded) {
    outcome = "degraded";
    errorCode = "upstream_stage_failed";
  } else {
    outcome = "success";
  }

  return {
    answer: segment.synthesizerEmptyCompletion ? "" : (segment.synthesizerAnswer as string),
    error: segment.synthesizerFatalError,
    recursion_depth: 0,
    outcome,
    error_code: errorCode,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/orchestration/replan-loop.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/orchestration/replan-loop.ts server-jarvis/src/orchestration/replan-loop.test.ts
git commit -m "feat(orchestrator): implement B-02 conductor_replan re-invocation loop"
```

---

### Task B4: Wire the replan loop into `index.ts`

This change is conditional and additive — when `route.pipeline` doesn't contain `"conductor_replan"` (100% of current traffic, since B-02 wiring didn't exist until this task), the exact existing `executor.execute(...)` call still runs. Zero behavior change for the non-replan path.

**Files:**
- Modify: `server-jarvis/src/index.ts`

- [ ] **Step 1: Add the import**

Near the existing orchestration imports (around line 73-75):

```typescript
import { PipelineExecutor } from "./orchestration/pipeline";
import { classifyTurnRequirements } from "./orchestration/turn-requirements";
import { normalizeRoute, type ExecutionProfile } from "./orchestration/route-normalization";
import { runPipelineWithReplanning } from "./orchestration/replan-loop";
```

- [ ] **Step 2: Replace the single `executor.execute(...)` call**

The current code (around line 1768-1795) is:

```typescript
        const executor = new PipelineExecutor(callModel, runtime, ctx);
        const result = await executor.execute(contextMessage, executablePipeline, agentRunId, async (state) => {
          // Stream stage progress back to client
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "orchestrator_stage",
            stage: state.stage,
            status: state.status,
            session_id: sessionId
          })}\n\n`));
        }, {
          topology: normalized.topology,
          executionProfile,
          workerInstructions: instructionSelection.instructions,
          sharedContext: mergedSharedContext,
          sessionMemory: sessionMemory,
          distilledSkillsBlock: resolvedSkills.promptBlock,
          maxRecursionDepth: cfg.orchestrator.max_recursion_depth,
          onRecursion: async (event) => {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "orchestrator_recursion",
              depth: event.depth,
              status: event.status,
              reenter_stage: event.reenter_stage,
              critique: event.critique,
              session_id: sessionId
            })}\n\n`));
          },
        });
```

Replace it with:

```typescript
        const executor = new PipelineExecutor(callModel, runtime, ctx);
        const onOrchestratorStateChange = async (state: Parameters<Parameters<typeof executor.execute>[3]>[0]) => {
          // Stream stage progress back to client — "conductor_replan" (B-02)
          // rides the same event type as an internal, non-user-facing status.
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "orchestrator_stage",
            stage: state.stage,
            status: state.status,
            session_id: sessionId
          })}\n\n`));
        };
        const pipelineOptions = {
          topology: normalized.topology,
          executionProfile,
          workerInstructions: instructionSelection.instructions,
          sharedContext: mergedSharedContext,
          sessionMemory: sessionMemory,
          distilledSkillsBlock: resolvedSkills.promptBlock,
          maxRecursionDepth: cfg.orchestrator.max_recursion_depth,
          onRecursion: async (event: any) => {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "orchestrator_recursion",
              depth: event.depth,
              status: event.status,
              reenter_stage: event.reenter_stage,
              critique: event.critique,
              session_id: sessionId
            })}\n\n`));
          },
        };
        const result = route.pipeline.includes("conductor_replan")
          ? await runPipelineWithReplanning({
              contextMessage,
              initialDecision: route,
              turnRequirement: turnReq.requirement,
              coordinator,
              routeOptions: {
                sessionId,
                history: turnHistory,
                lastOutcome: sessionMemory.getLastOutcome(sessionId),
                sessionMemoryHints: memoryHints,
              },
              executor,
              agentRunId,
              onStateChange: onOrchestratorStateChange,
              baseOptions: pipelineOptions,
              maxReplans: cfg.orchestrator.max_conductor_replans,
            })
          : await executor.execute(contextMessage, executablePipeline, agentRunId, onOrchestratorStateChange, pipelineOptions);
```

Note: `route.pipeline` (checked here) is the RAW decision from `coordinator.route()`, before `normalizeRoute` strips `conductor_replan` — that's exactly why this check works: `route.pipeline` still contains the literal string, while `executablePipeline`/`normalized.pipeline` never do.

- [ ] **Step 3: Run the full test suite**

Run: `cd server-jarvis && bun test`
Expected: all tests pass, no new failures.

- [ ] **Step 4: Run `tsc --noEmit`**

Run: `cd server-jarvis && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/index.ts
git commit -m "feat(orchestrator): wire B-02 replan loop into the chat orchestration path"
```

---

### Task B5: Update the coordinator prompt and B-02 docs

**Files:**
- Modify: `server-jarvis/src/prompts/coordinator.md`
- Modify: `docs/issues/post-phase-4-conductor-evolution.md`
- Modify: `PRIORITIES.md`

- [ ] **Step 1: Update the prompt's now-stale claim**

In `server-jarvis/src/prompts/coordinator.md`, find this line (in the routing rules section):

```
- If the executor's output reveals the WHOLE plan was wrong (not just one stage — e.g. the user asked to refactor X but the repo is actually a different language, or the reviewer's feedback requires a completely different decomposition), emit a pipeline with "conductor_replan" instead of `re-enter:<stage>`. Example: ["planner", "executor", "conductor_replan", "executor", "reviewer", "synthesizer"] — the second `executor` runs only after the conductor re-derives worker_instructions based on what the first executor discovered. The runtime strips `conductor_replan` from the executable stage list; B-02 (Track B) handles the actual re-invocation.
```

Replace the final sentence:

```
- If the executor's output reveals the WHOLE plan was wrong (not just one stage — e.g. the user asked to refactor X but the repo is actually a different language, or the reviewer's feedback requires a completely different decomposition), emit a pipeline with "conductor_replan" instead of `re-enter:<stage>`. Example: ["planner", "executor", "conductor_replan", "executor", "reviewer", "synthesizer"] — the second `executor` runs only after the conductor re-derives worker_instructions based on what the first executor discovered. The runtime pauses at `conductor_replan`, re-invokes you with a summary of what happened so far, and continues with your revised route.
```

- [ ] **Step 2: Mark B-02 done in the roadmap doc**

In `docs/issues/post-phase-4-conductor-evolution.md`, change the B-02 acceptance criteria checkboxes from `- [ ]` to `- [x]`:

```
- [x] Replan stage calls local persistent conductor
- [x] Revised worker instructions flow to subsequent stages
- [x] `read_only` execution profile cannot escalate to `full`
- [x] SSE `orchestrator_stage` events include replan (internal status)
```

- [ ] **Step 3: Append a PRIORITIES.md entry**

Follow the existing convention at the top of `PRIORITIES.md` (see the entries dated 2026-06-29/2026-06-30 for the exact style: what changed, why, files touched, test counts, commit hash). Add a new entry above the current top entry summarizing: B-02 implemented (executeSegment + replan-loop.ts + index.ts wiring), structured stage-output refactor that made it possible, new test counts, and the commit hash of Task B4's commit.

- [ ] **Step 4: Commit**

```bash
git add server-jarvis/src/prompts/coordinator.md docs/issues/post-phase-4-conductor-evolution.md PRIORITIES.md
git commit -m "docs(track-b02): record conductor_replan re-invocation completion"
```

---

## Group C — Semantic/quality eval track (Priority 4)

The existing `eval/harness.ts` is 100% deterministic and mocked (no live model calls) — perfect for a fast CI gate, but it only catches routing/plumbing regressions, never "the synthesizer's answer is wrong." This group adds a **separate, opt-in, live-model** track that scores real answers against a rubric. It's intentionally NOT wired into `bun test` (it needs API keys, costs money, and is non-deterministic) — it's a manually/nightly-run script, matching the existing pattern of `automate_inference_metrics.py`.

### Task C1: `judgeAnswer` — the LLM-judge scoring function

**Files:**
- Create: `server-jarvis/src/eval/judge.ts`
- Test: `server-jarvis/src/eval/judge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server-jarvis/src/eval/judge.test.ts
import { describe, expect, test } from "bun:test";
import { judgeAnswer } from "./judge";

describe("judgeAnswer", () => {
  test("scores 1.0 when the judge model reports every rubric item covered", async () => {
    const callModel = async () => ({
      content: JSON.stringify({ covered: ["mentions the fix", "names the file"], missed: [] }),
    });
    const verdict = await judgeAnswer(callModel as any, "fix the bug", "I fixed it in login.ts", [
      "mentions the fix", "names the file",
    ]);
    expect(verdict.score).toBe(1);
    expect(verdict.missed).toEqual([]);
  });

  test("scores partial coverage proportionally", async () => {
    const callModel = async () => ({
      content: JSON.stringify({ covered: ["mentions the fix"], missed: ["names the file"] }),
    });
    const verdict = await judgeAnswer(callModel as any, "fix the bug", "I fixed it.", [
      "mentions the fix", "names the file",
    ]);
    expect(verdict.score).toBe(0.5);
    expect(verdict.missed).toEqual(["names the file"]);
  });

  test("scores 0 and surfaces a rationale when the judge output is unparseable", async () => {
    const callModel = async () => ({ content: "not json" });
    const verdict = await judgeAnswer(callModel as any, "fix the bug", "I fixed it.", ["mentions the fix"]);
    expect(verdict.score).toBe(0);
    expect(verdict.rationale).toContain("unparseable");
  });

  test("handles an empty rubric as a vacuous pass", async () => {
    const callModel = async () => ({ content: JSON.stringify({ covered: [], missed: [] }) });
    const verdict = await judgeAnswer(callModel as any, "hi", "hello!", []);
    expect(verdict.score).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/eval/judge.test.ts`
Expected: FAIL — `Cannot find module './judge'`.

- [ ] **Step 3: Implement**

```typescript
// server-jarvis/src/eval/judge.ts
// ═══════════════════════════════════════════════════════════════
// LLM-judge: scores a live model answer against a rubric of required
// facts/behaviors. Deliberately NOT exact-string matching (live model
// output varies) — asks a judge model which rubric items are covered.
// ═══════════════════════════════════════════════════════════════

import type { CallModelFn } from "../orchestration/coordinator";

export interface JudgeVerdict {
  score: number; // covered.length / rubric.length, in [0, 1]
  covered: string[];
  missed: string[];
  rationale: string;
}

function buildJudgePrompt(request: string, answer: string, rubric: string[]): string {
  return [
    "You are grading an AI assistant's answer against a rubric of required facts or behaviors.",
    "Respond with ONLY a single JSON object of the shape:",
    `{"covered": ["<rubric item text>", ...], "missed": ["<rubric item text>", ...]}`,
    "Every rubric item must appear in exactly one of the two arrays. No other text.",
    "",
    `User request:\n${request}`,
    "",
    `Assistant answer:\n${answer}`,
    "",
    `Rubric items (must each be classified as covered or missed):\n${rubric.map((r) => `- ${r}`).join("\n")}`,
  ].join("\n");
}

function extractJudgeJson(text: string): { covered: string[]; missed: string[] } | null {
  try {
    return JSON.parse(text.trim());
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export async function judgeAnswer(
  callModel: CallModelFn,
  request: string,
  answer: string,
  rubric: string[],
): Promise<JudgeVerdict> {
  if (rubric.length === 0) {
    return { score: 1, covered: [], missed: [], rationale: "Empty rubric — vacuous pass." };
  }

  const resp = await callModel([
    { role: "system", content: "You are a strict, literal grading judge. Output only JSON." },
    { role: "user", content: buildJudgePrompt(request, answer, rubric) },
  ], { temperature: 0, max_tokens: 500 });

  const parsed = extractJudgeJson(resp.content);
  if (!parsed || !Array.isArray(parsed.covered) || !Array.isArray(parsed.missed)) {
    return { score: 0, covered: [], missed: rubric, rationale: `Judge output unparseable: ${resp.content.slice(0, 200)}` };
  }

  const covered = parsed.covered.filter((item) => rubric.includes(item));
  const missed = rubric.filter((item) => !covered.includes(item));
  return {
    score: covered.length / rubric.length,
    covered,
    missed,
    rationale: `${covered.length}/${rubric.length} rubric items covered.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/eval/judge.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server-jarvis/src/eval/judge.ts server-jarvis/src/eval/judge.test.ts
git commit -m "feat(eval): add LLM-judge rubric scoring for semantic eval"
```

---

### Task C2: Golden semantic task suite

**Files:**
- Create: `server-jarvis/src/eval/semantic-cases.ts`

- [ ] **Step 1: Implement (no test needed — this is a data file; it's exercised by Task C3's harness)**

```typescript
// server-jarvis/src/eval/semantic-cases.ts
// ═══════════════════════════════════════════════════════════════
// Golden tasks for the LIVE semantic eval track (semantic-harness.ts).
// Unlike eval/cases.ts (deterministic, mocked), these run through the
// REAL orchestrator against REAL models and are graded by judge.ts.
// Keep this list small (5-10 cases) — every run costs real API calls.
// ═══════════════════════════════════════════════════════════════

import type { TaskType } from "../orchestration/coordinator";

export interface SemanticCase {
  id: string;
  task_type: TaskType;
  request: string;
  /** Facts/behaviors the final answer MUST include to be graded correct. */
  rubric: string[];
  /** Relative-path -> file content. Materialized into a temp workspace before the turn runs. */
  workspaceFixture?: Record<string, string>;
}

export const SEMANTIC_CASES: SemanticCase[] = [
  {
    id: "semantic/read-named-file",
    task_type: "general",
    request: "What does config.ts export? Read the file and tell me.",
    rubric: [
      "names the exported identifier(s) from config.ts",
      "does not claim the file couldn't be read",
    ],
    workspaceFixture: {
      "config.ts": "export const MAX_RETRIES = 3;\nexport function resolveTimeout(ms: number) { return Math.max(1000, ms); }\n",
    },
  },
  {
    id: "semantic/summarize-two-files",
    task_type: "docs",
    request: "Give me a one-paragraph summary of what this small project does, based on the files here.",
    rubric: [
      "mentions the greet function or greeting behavior",
      "mentions the add/sum function or arithmetic behavior",
      "does not invent a framework or language that isn't present",
    ],
    workspaceFixture: {
      "greet.ts": "export function greet(name: string) { return `Hello, ${name}!`; }\n",
      "math.ts": "export function add(a: number, b: number) { return a + b; }\n",
    },
  },
  {
    id: "semantic/plain-knowledge-question",
    task_type: "general",
    request: "In one sentence, what is the difference between TCP and UDP?",
    rubric: [
      "mentions TCP is connection-oriented or reliable",
      "mentions UDP is connectionless or unreliable/faster",
    ],
  },
  {
    id: "semantic/debug-from-error-text",
    task_type: "debug",
    request: "This throws `TypeError: Cannot read properties of undefined (reading 'name')` in user.ts — what's the likely cause and fix?",
    rubric: [
      "identifies that something is undefined/null before .name is accessed",
      "suggests a guard, optional chaining, or ensuring the value is defined",
    ],
    workspaceFixture: {
      "user.ts": "function printName(user) {\n  console.log(user.name);\n}\nprintName(getUser());\nfunction getUser() { return undefined; }\n",
    },
  },
  {
    id: "semantic/trivial-greeting",
    task_type: "general",
    request: "hey, how's it going?",
    rubric: [
      "responds conversationally without pretending to inspect a workspace",
    ],
  },
];
```

- [ ] **Step 2: Commit**

```bash
git add server-jarvis/src/eval/semantic-cases.ts
git commit -m "feat(eval): add golden semantic task suite for live-model quality scoring"
```

---

### Task C3: Semantic harness (live, opt-in, gated behind `JARVIS_EVAL_LIVE=1`)

**Files:**
- Create: `server-jarvis/src/eval/semantic-harness.ts`

- [ ] **Step 1: Implement**

```typescript
// server-jarvis/src/eval/semantic-harness.ts
// ═══════════════════════════════════════════════════════════════
// LIVE semantic eval runner. Requires real API keys in the loaded config
// and `JARVIS_EVAL_LIVE=1` — NOT part of `bun test` (costs money, is
// non-deterministic). Run manually or on a schedule:
//   JARVIS_EVAL_LIVE=1 bun run src/eval/semantic-harness.ts
//   JARVIS_EVAL_LIVE=1 bun run src/eval/semantic-harness.ts --write-baseline
// ═══════════════════════════════════════════════════════════════

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { loadConfig } from "../config";
import { ToolRuntime } from "../tool-runtime";
import { Coordinator } from "../orchestration/coordinator";
import { AgentPool } from "../orchestration/agent-pool";
import { PipelineExecutor } from "../orchestration/pipeline";
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import { normalizeRoute } from "../orchestration/route-normalization";
import { chatCompletionWithFallback } from "../openrouter";
import { judgeAnswer } from "./judge";
import { SEMANTIC_CASES, type SemanticCase } from "./semantic-cases";
import type { CallModelFn, ChatMessage } from "../orchestration/coordinator";

export interface SemanticCaseResult {
  id: string;
  score: number;
  covered: string[];
  missed: string[];
  answer: string;
}

export interface SemanticReport {
  total: number;
  averageScore: number;
  results: SemanticCaseResult[];
}

function materializeFixture(root: string, fixture: Record<string, string> | undefined): void {
  if (!fixture) return;
  for (const [relPath, content] of Object.entries(fixture)) {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

/** Minimal callModel that goes through the real fallback cascade for a fixed stage. */
function makeCallModel(cfg: ReturnType<typeof loadConfig>, stage: string): CallModelFn {
  return async (messages, options) => {
    const { response } = await chatCompletionWithFallback(cfg, {
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.max_tokens ?? 1024,
      stream: false,
      tools: options?.tools,
    }, undefined, { stage });
    const json = await response.json();
    const choice = json.choices?.[0]?.message ?? {};
    return { content: choice.content ?? "", tool_calls: choice.tool_calls };
  };
}

async function runSemanticCase(cfg: ReturnType<typeof loadConfig>, c: SemanticCase): Promise<SemanticCaseResult> {
  const workspace = mkdtempSync(join(tmpdir(), "jarvis-semantic-eval-"));
  try {
    materializeFixture(workspace, c.workspaceFixture);

    const callModel = makeCallModel(cfg, "orchestrator");
    const pool = new AgentPool(cfg.orchestrator.agents);
    const coordinator = new Coordinator(callModel);
    const route = await coordinator.route(c.request, { sessionId: `semantic-${c.id}` });
    const turnReq = classifyTurnRequirements(c.request);
    const normalized = normalizeRoute(route, turnReq.requirement, turnReq.requirement === "conversational" ? "trivial_short_circuit" : "model");

    const runtime = new ToolRuntime([]); // filesystem bundle registration matches production wiring in index.ts
    const ctx = { session_id: `semantic-${c.id}`, workspace_path: workspace, surface: "chat" as const };
    const executor = new PipelineExecutor(callModel, runtime, ctx, { recordStageRun: () => {} });

    const result = await executor.execute(c.request, normalized.pipeline, `semantic_${c.id}`, () => {}, {
      topology: normalized.topology,
      executionProfile: normalized.profile,
    });

    const judgeModel = makeCallModel(cfg, "reviewer"); // reuse the pool's strongest reasoning default as judge
    const verdict = await judgeAnswer(judgeModel, c.request, result.answer, c.rubric);

    return { id: c.id, score: verdict.score, covered: verdict.covered, missed: verdict.missed, answer: result.answer };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function runSemanticEval(cfg: ReturnType<typeof loadConfig>): Promise<SemanticReport> {
  const results: SemanticCaseResult[] = [];
  for (const c of SEMANTIC_CASES) {
    results.push(await runSemanticCase(cfg, c));
  }
  const averageScore = results.reduce((sum, r) => sum + r.score, 0) / Math.max(1, results.length);
  return { total: results.length, averageScore, results };
}

export interface SemanticBaseline {
  version: number;
  averageScore: number;
  scores: Record<string, number>;
}

export function toSemanticBaseline(report: SemanticReport): SemanticBaseline {
  const scores: Record<string, number> = {};
  for (const r of report.results) scores[r.id] = r.score;
  return { version: 1, averageScore: report.averageScore, scores };
}

// A live model is non-deterministic — only fail on a real regression, not noise.
const REGRESSION_DROP_THRESHOLD = 0.15;
const REGRESSION_ABSOLUTE_FLOOR = 0.6;

export function diffSemanticBaseline(report: SemanticReport, baseline: SemanticBaseline): string[] {
  const diffs: string[] = [];
  for (const [id, prevScore] of Object.entries(baseline.scores)) {
    const now = report.results.find((r) => r.id === id);
    if (!now) {
      diffs.push(`case removed: ${id}`);
      continue;
    }
    if (now.score < prevScore - REGRESSION_DROP_THRESHOLD && now.score < REGRESSION_ABSOLUTE_FLOOR) {
      diffs.push(`case ${id}: score dropped ${prevScore.toFixed(2)} -> ${now.score.toFixed(2)} (missed: ${now.missed.join(", ")})`);
    }
  }
  return diffs;
}

if (import.meta.main) {
  if (process.env.JARVIS_EVAL_LIVE !== "1") {
    console.error("Refusing to run: this hits live model APIs and costs money. Set JARVIS_EVAL_LIVE=1 to proceed.");
    process.exit(1);
  }
  const cfg = loadConfig();
  const report = await runSemanticEval(cfg);
  const baselinePath = join(import.meta.dir, "semantic-baseline.json");

  for (const r of report.results) {
    console.log(`${r.score >= REGRESSION_ABSOLUTE_FLOOR ? "OK  " : "LOW "} ${r.id}  score=${r.score.toFixed(2)}${r.missed.length ? `  missed=[${r.missed.join(", ")}]` : ""}`);
  }
  console.log(`\nAverage score: ${report.averageScore.toFixed(3)} across ${report.total} cases`);

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(baselinePath, JSON.stringify(toSemanticBaseline(report), null, 2) + "\n");
    console.log(`Wrote semantic baseline to ${baselinePath}`);
  } else {
    try {
      const { readFileSync } = await import("fs");
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as SemanticBaseline;
      const drift = diffSemanticBaseline(report, baseline);
      if (drift.length) {
        console.log("\nSemantic regressions detected:");
        for (const d of drift) console.log(`  - ${d}`);
        process.exit(1);
      }
    } catch (e) {
      console.log(`\n(no baseline yet — run with --write-baseline to create one: ${e})`);
    }
  }
}
```

- [ ] **Step 2: Verify it typechecks (do NOT run it live yet — no API cost without explicit opt-in)**

Run: `cd server-jarvis && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server-jarvis/src/eval/semantic-harness.ts
git commit -m "feat(eval): add opt-in live semantic quality harness with regression-band gating"
```

- [ ] **Step 4 (manual, not part of the automated task — run once real API keys are confirmed live):**

Run: `cd server-jarvis && JARVIS_EVAL_LIVE=1 bun run src/eval/semantic-harness.ts --write-baseline`
Expected: prints a score per case and writes `src/eval/semantic-baseline.json`. Inspect the scores manually — anything near 0 on a case that should be easy indicates a live orchestrator problem, not a harness bug.

---

## Group D — Measured capability priors + persistence (Priority 3)

Today `DEFAULT_ORCHESTRATOR_AGENTS`' `capabilities` scores are hand-authored guesses, and `LearnedPoolState` (the online-learning deltas) lives in a plain in-memory module-level object — **every value learned during live traffic is lost on restart.** This group fixes both: (D1) persistence so learning survives a restart, (D2) a benchmark script that runs Group C's judge against every real pool model and feeds the results through the *already-wired* `SelfTuningStore` / `ConductorLearningLoop` machinery — reusing existing, tested infrastructure rather than inventing a parallel scoring system.

### Task D1: Persist `LearnedPoolState` to disk

**Files:**
- Modify: `server-jarvis/src/self-tuning/learned-pool-state.ts`
- Test: `server-jarvis/src/self-tuning/learned-pool-state.test.ts` (create if it doesn't exist — check first)

- [ ] **Step 1: Check for an existing test file**

Run: `ls server-jarvis/src/self-tuning/learned-pool-state.test.ts 2>/dev/null || echo "none"`

- [ ] **Step 2: Write the failing test**

```typescript
// server-jarvis/src/self-tuning/learned-pool-state.test.ts
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getLearnedPoolState,
  resetLearnedPoolStateForTests,
  persistLearnedPoolState,
  loadLearnedPoolState,
} from "./learned-pool-state";

describe("learned pool state persistence", () => {
  afterEach(() => {
    resetLearnedPoolStateForTests();
  });

  test("persists capability deltas and fallback boosts to disk and reloads them", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-learned-state-"));
    try {
      const state = getLearnedPoolState();
      state.capabilityDeltas.set("zen-nemotron-ultra-free", { reasoning: 0.06, code: -0.03 });
      state.fallbackBoosts.set("zen-nemotron-ultra-free:planner:debug", 0.12);

      persistLearnedPoolState(root);
      resetLearnedPoolStateForTests();
      expect(getLearnedPoolState().capabilityDeltas.size).toBe(0);

      loadLearnedPoolState(root);
      const reloaded = getLearnedPoolState();
      expect(reloaded.capabilityDeltas.get("zen-nemotron-ultra-free")).toEqual({ reasoning: 0.06, code: -0.03 });
      expect(reloaded.fallbackBoosts.get("zen-nemotron-ultra-free:planner:debug")).toBe(0.12);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadLearnedPoolState is a no-op when no persisted file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-learned-state-empty-"));
    try {
      loadLearnedPoolState(root); // must not throw
      expect(getLearnedPoolState().capabilityDeltas.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server-jarvis && bun test src/self-tuning/learned-pool-state.test.ts`
Expected: FAIL — `persistLearnedPoolState`/`loadLearnedPoolState` not exported.

- [ ] **Step 4: Implement**

Add to `server-jarvis/src/self-tuning/learned-pool-state.ts` (after the existing `resetLearnedPoolStateForTests` function):

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SESSIONS_DIR } from "../config";

function learnedStatePath(root: string): string {
  return join(root, "self-tuning", "learned-pool-state.json");
}

/** Serialize the current learned state (capability deltas + fallback boosts) to disk. */
export function persistLearnedPoolState(root: string = SESSIONS_DIR): void {
  try {
    mkdirSync(join(root, "self-tuning"), { recursive: true });
    const serializable = {
      capabilityDeltas: Object.fromEntries(globalState.capabilityDeltas),
      fallbackBoosts: Object.fromEntries(globalState.fallbackBoosts),
    };
    writeFileSync(learnedStatePath(root), JSON.stringify(serializable, null, 2), "utf-8");
  } catch (e) {
    console.warn(`[LearnedPoolState] Failed to persist: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Load persisted learned state from disk, if present. No-op (not an error) when missing. */
export function loadLearnedPoolState(root: string = SESSIONS_DIR): void {
  const path = learnedStatePath(root);
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      capabilityDeltas?: Record<string, Partial<Record<keyof OrchestratorAgent["capabilities"], number>>>;
      fallbackBoosts?: Record<string, number>;
    };
    globalState.capabilityDeltas = new Map(Object.entries(raw.capabilityDeltas ?? {}));
    globalState.fallbackBoosts = new Map(Object.entries(raw.fallbackBoosts ?? {}));
  } catch (e) {
    console.warn(`[LearnedPoolState] Failed to load persisted state: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server-jarvis && bun test src/self-tuning/learned-pool-state.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/self-tuning/learned-pool-state.ts server-jarvis/src/self-tuning/learned-pool-state.test.ts
git commit -m "feat(self-tuning): persist learned pool state across restarts"
```

---

### Task D2: Load/save learned state at server lifecycle points in `index.ts`

**Files:**
- Modify: `server-jarvis/src/index.ts`

- [ ] **Step 1: Add the import**

```typescript
import { loadLearnedPoolState, persistLearnedPoolState } from "./self-tuning/learned-pool-state";
```

- [ ] **Step 2: Load at startup**

Find where the server initializes config/starts listening (search for the top-level startup sequence — e.g. near where `Bun.serve(...)` is called or near the top-level `const cfg = loadConfig();` at module scope). Add immediately after config is first loaded at module scope:

```typescript
loadLearnedPoolState();
console.log("[Jarvis] Loaded persisted learned pool state (if any).");
```

- [ ] **Step 3: Persist after each heuristic optimization pass**

In the block added around line 1847-1857 (the `conductorLearning.optimizeAndApply(...)` call and its `if (heuristic.proposals.length > 0)` block), add a persist call inside the `if`:

```typescript
          const heuristic = await conductorLearning.optimizeAndApply(
            agentRunId,
            route.task_type,
            cfg.orchestrator.agents ?? [],
          );
          if (heuristic.proposals.length > 0) {
            console.log(
              `[Jarvis Orchestrator] Phase 4 heuristics applied: ${heuristic.proposals.length} proposals, ` +
              `${heuristic.agentsAdjusted} agent adjustments, ${heuristic.fallbackBoostsApplied} fallback boosts`,
            );
            persistLearnedPoolState();
          }
```

- [ ] **Step 4: Run the full test suite**

Run: `cd server-jarvis && bun test`
Expected: PASS. (Tests use `resetLearnedPoolStateForTests()`/mock configs, not the real `SESSIONS_DIR`, so this wiring shouldn't affect them — if any test unexpectedly writes to a real directory, track down why its config resolves `SESSIONS_DIR` to a non-temp path and fix the test fixture, don't skip this step.)

- [ ] **Step 5: Run `tsc --noEmit`**

Run: `cd server-jarvis && bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server-jarvis/src/index.ts
git commit -m "feat(orchestrator): load learned pool state at startup, persist after each heuristic pass"
```

---

### Task D3: Model benchmark script — measured priors instead of hand-authored guesses

**Files:**
- Create: `server-jarvis/src/eval/model-benchmark.ts`

This reuses the *existing* `SelfTuningStore.upsertAgentPerformance` / `ConductorLearningLoop.optimizeAndApply` machinery (already implemented, already tested, already wired into live traffic in Group D's Task D2) — the benchmark script's only job is to generate real `agent_performance` rows from live calls instead of waiting for organic traffic to accumulate them. This is intentionally a live, opt-in, manually-run script (same `JARVIS_EVAL_LIVE=1` gate as Group C), never part of `bun test`.

- [ ] **Step 1: Implement**

```typescript
// server-jarvis/src/eval/model-benchmark.ts
// ═══════════════════════════════════════════════════════════════
// LIVE per-model capability benchmark. Runs a small fixed battery of
// stage-representative tasks against every enabled pool agent, scores
// each result (JSON validity for routing-shaped tasks, judge.ts for
// code/reasoning quality), and feeds the results into the SAME
// agent_performance table / ConductorLearningLoop.optimizeAndApply()
// pipeline that live traffic already uses — so a single run establishes
// a MEASURED prior instead of the hand-authored capability guesses in
// DEFAULT_ORCHESTRATOR_AGENTS. Persists the resulting learned deltas so
// they survive a restart (see learned-pool-state.ts).
//
// Requires real API keys + JARVIS_EVAL_LIVE=1. Run manually/periodically:
//   JARVIS_EVAL_LIVE=1 bun run src/eval/model-benchmark.ts
// ═══════════════════════════════════════════════════════════════

import { loadConfig } from "../config";
import { chatCompletionWithFallback } from "../openrouter";
import { resolveProviderTarget } from "../providers";
import { AgentPool, DEFAULT_ORCHESTRATOR_AGENTS, type OrchestratorAgent } from "../orchestration/agent-pool";
import { judgeAnswer } from "./judge";
import { persistLearnedPoolState } from "../self-tuning/learned-pool-state";
import { SelfTuningStore } from "../self-tuning/store";
import { ConductorLearningLoop } from "../self-tuning/conductor-learning";
import type { CallModelFn, TaskType } from "../orchestration/coordinator";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

interface BenchmarkTask {
  stage: "planner" | "executor" | "reviewer" | "coordinator";
  taskType: TaskType;
  prompt: string;
  rubric: string[]; // empty rubric => scored purely on non-empty + parses, not judged
}

const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    stage: "planner",
    taskType: "refactor",
    prompt: "Break this into concrete steps: add input validation to a login form's email field.",
    rubric: ["mentions validating the email format", "produces a numbered or ordered set of steps"],
  },
  {
    stage: "executor",
    taskType: "debug",
    prompt: "Explain in a few sentences how you would find the cause of a null pointer exception in a Node.js service, without running any tools.",
    rubric: ["mentions checking where the value could be undefined/null", "mentions logging or a debugger/stack trace"],
  },
  {
    stage: "reviewer",
    taskType: "code_review",
    prompt: "A PR adds a function that divides two numbers but never checks for division by zero. List the issues you'd flag.",
    rubric: ["flags the missing division-by-zero check"],
  },
  {
    stage: "coordinator",
    taskType: "general",
    prompt: "Respond with ONLY this JSON object, verbatim: {\"ok\": true}",
    rubric: [], // scored purely on JSON validity, not judged
  },
];

async function callSingleModel(
  cfg: ReturnType<typeof loadConfig>,
  agent: OrchestratorAgent,
  prompt: string,
): Promise<{ content: string; latencyMs: number; ok: boolean }> {
  const target = resolveProviderTarget(cfg, agent.provider);
  if (!target.api_key) {
    return { content: "", latencyMs: 0, ok: false };
  }
  const start = Date.now();
  try {
    const { response } = await chatCompletionWithFallback(cfg, {
      messages: [{ role: "user", content: prompt }],
      model: agent.model_id,
      temperature: 0.2,
      max_tokens: 400,
      stream: false,
    }, undefined, { stage: "planner" }); // stage hint only affects fallback cascade ordering, not the forced model
    const json = await response.json();
    const content = json.choices?.[0]?.message?.content ?? "";
    return { content, latencyMs: Date.now() - start, ok: content.trim().length > 0 };
  } catch {
    return { content: "", latencyMs: Date.now() - start, ok: false };
  }
}

async function main() {
  if (process.env.JARVIS_EVAL_LIVE !== "1") {
    console.error("Refusing to run: this hits live model APIs and costs money. Set JARVIS_EVAL_LIVE=1 to proceed.");
    process.exit(1);
  }

  const cfg = loadConfig();
  const pool = new AgentPool(cfg.orchestrator.agents ?? DEFAULT_ORCHESTRATOR_AGENTS);
  const agents = pool.enabled();

  // Dedicated store + a LOW min_samples_for_heuristics: a benchmark run is
  // explicitly establishing priors, not waiting for organic traffic volume.
  const benchDbPath = join(mkdtempSync(join(tmpdir(), "jarvis-benchmark-")), "bench.db");
  const store = new SelfTuningStore(benchDbPath);
  const learning = new ConductorLearningLoop(store, {
    enabled: true,
    min_samples_for_heuristics: 1,
    capability_adjustment_step: 0.03,
    trajectory_export: false,
    instruction_ab_epsilon: 0,
    max_trajectory_snapshots: 0,
  });

  const judgeAgent = agents.find((a) => a.default_for.includes("reviewer")) ?? agents[0];
  const judgeCallModel: CallModelFn = async (messages) => {
    const prompt = messages[messages.length - 1]?.content ?? "";
    const res = await callSingleModel(cfg, judgeAgent, prompt);
    return { content: res.content };
  };

  console.log(`Benchmarking ${agents.length} agents across ${BENCHMARK_TASKS.length} tasks (${agents.length * BENCHMARK_TASKS.length} live calls)...`);

  for (const agent of agents) {
    for (const task of BENCHMARK_TASKS) {
      const res = await callSingleModel(cfg, agent, task.prompt);
      let success: boolean;
      if (!res.ok) {
        success = false;
      } else if (task.rubric.length === 0) {
        // Coordinator-style structural task: success = parses as JSON.
        try {
          JSON.parse(res.content.trim());
          success = true;
        } catch {
          success = false;
        }
      } else {
        const verdict = await judgeAnswer(judgeCallModel, task.prompt, res.content, task.rubric);
        success = verdict.score >= 0.5;
      }
      store.upsertAgentPerformance(agent.id, task.stage, task.taskType, success, res.latencyMs);
      console.log(`  ${agent.id} / ${task.stage} / ${task.taskType}: ${success ? "PASS" : "FAIL"} (${res.latencyMs}ms)`);
    }
  }

  console.log("\nConverting measured performance into capability priors...");
  let totalAdjusted = 0;
  for (const taskType of new Set(BENCHMARK_TASKS.map((t) => t.taskType))) {
    const result = await learning.optimizeAndApply(`bench_${Date.now()}`, taskType, agents);
    totalAdjusted += result.agentsAdjusted;
  }
  console.log(`Adjusted capability deltas for ${totalAdjusted} (agent, stage) pairs.`);

  persistLearnedPoolState();
  console.log("Persisted learned pool state — live traffic will start from these measured priors.");

  rmSync(dirname(benchDbPath), { recursive: true, force: true });
}

if (import.meta.main) {
  await main();
}
```

Note: `dirname` needs an import from `"path"` — add `dirname` to the existing `import { join } from "path";` line, making it `import { dirname, join } from "path";`.

- [ ] **Step 2: Verify it typechecks**

Run: `cd server-jarvis && bunx tsc --noEmit`
Expected: clean. If `chatCompletionWithFallback`'s request-body shape doesn't accept a top-level `model` field the way this draft assumes, check `buildAttemptBody` in `openrouter.ts` for the exact field name the cascade uses to force a specific model, and adjust `callSingleModel`'s request body to match — the goal is "call exactly this one agent's model_id with no fallback," so if `chatCompletionWithFallback` doesn't support forcing a single model_id + provider directly, add a minimal `{ stage: task.stage, taskType: task.taskType }`-scoped `FallbackResolveOptions` override instead, or fall back to a direct `fetch(providerChatUrl(target), ...)` call using `providerHeaders(cfg, target)` (both already imported from `../providers`) — this keeps the benchmark decoupled from cascade/fallback behavior entirely, which is more correct anyway (a benchmark should measure ONE model, not "whichever model the fallback cascade landed on").

- [ ] **Step 3: Commit**

```bash
git add server-jarvis/src/eval/model-benchmark.ts
git commit -m "feat(eval): add live per-model capability benchmark feeding measured priors"
```

- [ ] **Step 4 (manual, not part of the automated task):**

Run: `cd server-jarvis && JARVIS_EVAL_LIVE=1 bun run src/eval/model-benchmark.ts`
Expected: prints PASS/FAIL per (agent, task), then a summary of adjusted capability deltas, then confirms the learned state was persisted. Restart the server and confirm (via a log line or `/health/inference`'s `conductor_cache`/pool state, if surfaced) that routing reflects the measured priors rather than resetting to the hand-authored defaults.

---

## Self-Review

**Spec coverage:**
- Priority 5 (structured stage output, no more string-soup between stages) → Group A, Tasks A1-A7. ✅
- Priority 1 (B-02 conductor_replan actually re-invokes) → Group B, Tasks B1-B5, satisfies all four acceptance criteria in `docs/issues/post-phase-4-conductor-evolution.md`. ✅
- Priority 4 (semantic/quality eval, not just structural) → Group C, Tasks C1-C3. ✅
- Priority 3 (measured capability priors + persistence across restarts) → Group D, Tasks D1-D3. ✅
- Priority 2 (frontier model swap) — explicitly excluded per user direction; not in scope. ✅

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate error handling" language; every code step has complete, concrete code; every test step has real assertions, not `// write tests for the above`.

**Type consistency check:** `PipelineStageState`/`ExecutorStageOutput`/etc. (Task A1) are used with the exact same field names throughout Groups A and B (`state.plan`, `state.executor`, `.ok`, `.narrative`, `.toolCalls`) — verified against `executeSegment` (A6), `replan.ts` (B1), and `replan-loop.ts` (B3). `executeSegment`'s return shape (`PipelineSegmentResult`) is consumed identically by `execute()` (A6 Step 4) and `finalizeSegment()` (B3) — both compute `upstreamDegraded` the same way. `max_conductor_replans` (B2) is read at exactly one call site (B4) with the same name. `judgeAnswer` (C1) is called with the same signature from `semantic-harness.ts` (C3) and `model-benchmark.ts` (D3).

---

