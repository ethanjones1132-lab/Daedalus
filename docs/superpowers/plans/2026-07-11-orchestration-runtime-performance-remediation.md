# Orchestration Runtime Performance Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Jarvis orchestration latency and wasted model work while preserving truthful execution, tool safety, provider failover, and the native UI -> Bun server -> orchestrator -> inference backend architecture.

**Architecture:** Keep deterministic turn classification and route normalization authoritative. Make the Bun server enforce a requirement-aware latency budget, run Live Conductor supervision only when evidence justifies it, bound repair work by measurable progress, and prioritize interactive chat over cron workloads. Record per-attempt and per-stage evidence so routing learns from correct latency, token, and outcome data rather than inflated turn totals.

**Tech Stack:** Bun 1.3, TypeScript, Bun test, SQLite self-tuning store, Ollama persistent conductor, OpenAI-compatible OpenCode/OpenRouter APIs, Rust/Tauri cron and settings surfaces, React/Vitest health UI, PowerShell deployment and runtime probes.

## Global Constraints

- Preserve the native Jarvis split: Rust/Tauri owns persistence, IPC, and cron dispatch; the Bun server owns orchestration, inference, tools, and streaming; React owns presentation.
- Preserve the `orchestrator.enabled` master gate and the deterministic `TurnRequirement` / `normalizeRoute` authority boundary.
- Preserve the current uncommitted reliability work. Do not reset, stash, or overwrite the dirty working tree.
- Finish `docs/superpowers/plans/2026-07-11-orchestration-runtime-reliability.md` compatibility first; this plan extends it and does not replace it.
- A full-execution turn with zero successful writes remains failed; performance work must not weaken the effect gate.
- User Stop, disconnect, and same-session supersession remain authoritative cancellation signals. Stage timeouts must not be reported as user cancellation.
- Never log or persist provider secrets, raw authorization headers, or full local config.
- Build and deployment proof must identify both the Git SHA and whether the bundle was built from a dirty tree.

---

## Confirmed incident diagnosis

The evidence snapshot was taken from the live listener on `127.0.0.1:19877` on July 11, 2026. The serving process was Bun PID 45292 running `C:\Users\ethan\OneDrive\Desktop\index.js`. The deployed bundle hash and `server-jarvis/dist/index.js` hash both equaled `E2CF92B5184FB1ACC91A5C377DD68DE0661C4EC32F71E9868E0B609E197BAA09`.

### Runtime symptoms

| Signal | Confirmed value |
|---|---:|
| OpenCode Go rolling p50 | 52,731 ms |
| OpenCode Go rolling p95 | 110,348 ms |
| Rolling error rate | 30% |
| Recent refactor turn durations | 72,629 ms; 183,296 ms; 110,348 ms |
| Outcome of those three refactor turns | failed; failed; failed |
| Longest observed stage sequence | 12 stage runs in one turn |
| Flash synthesizer attempts in six-hour attribution window | 10 attempts, 4 errors |
| Pro synthesizer average / maximum | 25,076 ms / 32,247 ms |
| Live Conductor Flash coordinator outcomes | 2 successes / 20 attempts |
| Live Conductor Pro coordinator outcomes | 0 successes / 13 attempts |

### Ranked causes

1. **Unconditional and misconfigured Live Conductor supervision.** Production constructs `LiveConductor` but never calls `setContext`. Therefore `supervise_low_complexity: false` never takes effect. `PipelineExecutor.afterConductorStage` also passes `[stage]` as the remaining queue, so successful planner, executor, and synthesizer stages spend another provider call asking the conductor to supervise a queue that is not real. These calls overwhelmingly fail or return unusable output and add roughly 3-5 seconds each.

2. **Unbounded-by-progress reviewer/rewriter amplification.** `runReviewerRewriterLoop` hard-codes three review cycles. It runs a rewriter whenever the reviewer flags issues, even if the requested pipeline omitted `rewriter`, and it does not require the rewriter to produce a new successful write or other measurable progress. The 183-second failed turn ran reviewer -> rewriter three times before synthesis.

3. **Provider empty-completion and first-token delay.** OpenCode Go Flash produced empty synthesizer completions repeatedly, each consuming about 20-25 seconds before Pro was attempted. The in-progress stage health registry waits for two empty completions and clears strikes after an intervening success, so an intermittent 40% failure pattern can keep paying the full failed attempt indefinitely.

4. **Corrupted token and learning telemetry.** `server-jarvis/src/index.ts` increments `totalTokens` by the cumulative `totalTokensIn + totalTokensOut` inside the stage loop. This makes token totals grow quadratically with stage count; observed failed turns were recorded as 298,003 and 404,314 tokens despite much smaller stage totals. Orchestrated `/health/inference` records also write zero input/output tokens and omit successful fallback use. Routing and tuning are therefore learning from invalid cost signals.

5. **Interactive/background contention.** A scheduled self-improvement review began six seconds after a full-execution interactive turn and used the same OpenCode Go planner/synthesizer pool concurrently. There is no Bun-side priority or admission boundary between `surface: "chat"` and `surface: "cron"`.

6. **Repeated context payloads.** The server builds a history-augmented `contextMessage`, persists it as `agent_runs.user_request`, and replays it into planner, executor, reviewer, rewriter, synthesizer, conductor-learning, and skill-distillation inputs. The history helper is bounded, but each stage adds plans, tool summaries, and prior rewrites again. Recent stage inputs reached roughly 10,000 tokens, increasing first-token latency and provider load.

7. **Performance visibility is present but disabled/incomplete.** `runtime-monitor.ts` exists, but it starts only when `JARVIS_PERF_MONITOR=1`; the deployed runtime had no event-loop evidence. `/health/inference` exposes turn aggregates but no stage attempt timeline, so provider latency, orchestration overhead, queue delay, and fallback delay cannot be separated from one another.

### Ruled out or secondary

- The serving bundle was not stale: deployed `index.js` exactly matched `server-jarvis/dist/index.js`.
- Ollama conductor routing was not the dominant delay: recent local route calls were about 3.1-3.9 seconds and KV reuse worked on later turns.
- No server stderr failure was present in the current process.
- The process was responsive to `/health` and `/health/inference`; the evidence points primarily to model-call amplification and provider delay, not a dead Bun event loop. Event-loop monitoring still needs to be enabled to prove this continuously.

---

## File structure

### New files

- `server-jarvis/src/orchestration/turn-budget.ts` - requirement/complexity latency and attempt budgets.
- `server-jarvis/src/orchestration/turn-budget.test.ts` - pure budget and finalization-reserve tests.
- `server-jarvis/src/orchestration/admission-controller.ts` - priority leases for chat and background turns.
- `server-jarvis/src/orchestration/admission-controller.test.ts` - deterministic queue, cancellation, and fairness tests.
- `server-jarvis/src/orchestration/turn-metrics.ts` - pure stage/attempt aggregation with linear token math.
- `server-jarvis/src/orchestration/turn-metrics.test.ts` - regression for the 404,314-token overcount and fallback accounting.
- `server-jarvis/src/orchestration/performance-regression.test.ts` - call-count and no-progress loop regression harness.
- `scripts/benchmark-jarvis-runtime.ps1` - live direct-answer, workspace-read, and temporary write/read latency probe.

### Modified files

- `server-jarvis/src/index.ts` - integrate budgets, admission, truthful metrics, Live Conductor context, and raw-request persistence.
- `server-jarvis/src/orchestration/pipeline.ts` - pass real remaining queues, enforce repair progress, and reserve finalization time.
- `server-jarvis/src/orchestration/conductor.ts` - pure supervision policy and real queue handling.
- `server-jarvis/src/orchestration/conductor.test.ts` - no successful-stage inference and context-gating regressions.
- `server-jarvis/src/orchestration/stage-health.ts` - rolling failure state with immediate empty-completion cooldown.
- `server-jarvis/src/orchestration/stage-health.test.ts` - intermittent failure and success-decay tests.
- `server-jarvis/src/orchestration/context-budget.ts` - requirement-aware history and stage payload caps.
- `server-jarvis/src/orchestration/context-budget.test.ts` - multi-turn and tool-evidence payload bounds.
- `server-jarvis/src/orchestration/modes.ts` - full-execution executor and rewriter turn caps.
- `server-jarvis/src/config.ts` - defaults for repair count, turn budgets, and admission policy.
- `server-jarvis/src/config.test.ts` - config default and clamp tests.
- `server-jarvis/src/self-tuning/inference-feedback.ts` - finish the in-progress typed stage-adjustment parser.
- `server-jarvis/src/inference-metrics.ts` - stage attempts, queue delay, runtime snapshot, and truthful tokens/fallbacks.
- `server-jarvis/src/inference-metrics.test.ts` - snapshot contract and aggregation regressions.
- `server-jarvis/src/performance/runtime-monitor.ts` - always-on measurement with opt-in periodic logging.
- `src-ui/src/components/jarvis/SystemHealthView.tsx` - stage latency, queue delay, and runtime pressure visibility.
- `src-ui/src/components/jarvis/SystemHealthView.test.ts` - health rendering and empty-state tests.
- `src-tauri/src/cron_scheduler.rs` - handle background deferral as a retryable scheduling result.
- `scripts/build-and-deploy.ps1` - dirty-tree/source digest build provenance.
- `scripts/verify-deploy.ps1` - assert manifest and live provenance.
- `scripts/smoke-jarvis-runtime.ps1` - retain the in-progress write/read smoke and add latency assertions.

---

### Task 1: Stabilize the in-progress reliability baseline and provenance

**Files:**

- Modify: `server-jarvis/src/self-tuning/inference-feedback.ts:55-66`
- Modify: `server-jarvis/src/self-tuning/inference-feedback.test.ts`
- Modify: `scripts/build-and-deploy.ps1:94-100,176-190`
- Modify: `server-jarvis/src/index.ts:485-500,3640-3660`
- Modify: `scripts/verify-deploy.ps1`

**Interfaces:**

- Consumes: the existing reliability diff and `routing_policy.stage_adjustments` JSON.
- Produces: a compiling reliability baseline plus `git_dirty` and `source_tree_sha256` in both the deploy manifest and `/health`.

- [ ] **Step 1: Add a typed stage-adjustment parser regression**

```ts
test("applies typed stage adjustments and ignores malformed values", () => {
  const result = applyInferenceFeedback(validReport({
    stage_adjustments: {
      "opencode_go:deepseek-v4-flash:synthesizer": {
        sample_count: 10,
        routing_score_delta: -0.2,
      },
      malformed: "not-an-object",
    },
  }));

  expect(result).toEqual({ applied: 1, ignored: 1, reason: undefined });
  expect(getLearnedPoolState().stageModelRoutingScoreDeltas.get(
    "opencode_go:deepseek-v4-flash:synthesizer",
  )).toBe(-0.2);
});
```

- [ ] **Step 2: Narrow unknown stage adjustment values before field access**

```ts
interface StageAdjustmentInput {
  sample_count?: unknown;
  routing_score_delta?: unknown;
}

const stageAdjustments = report.routing_policy.stage_adjustments as Record<string, unknown> | undefined;
for (const [key, value] of Object.entries(stageAdjustments ?? {})) {
  if (key.split(":").length < 3 || !value || typeof value !== "object") {
    ignored += 1;
    continue;
  }
  const raw = value as StageAdjustmentInput;
  if (Number(raw.sample_count) < minSamples) {
    ignored += 1;
    continue;
  }
  const routing = finiteClamped(raw.routing_score_delta, -0.25, 0.15);
  if (routing !== undefined) state.stageModelRoutingScoreDeltas.set(key, routing);
  applied += 1;
}
```

- [ ] **Step 3: Verify the current dirty reliability patch before adding performance behavior**

Run: `cd server-jarvis; bun test src/orchestration/stage-health.test.ts src/orchestration/agent-pool.test.ts src/orchestration/conductor-routing.test.ts src/orchestration/persistent-conductor.test.ts src/orchestration/effect-gate.test.ts src/orchestration/replan-loop.test.ts src/self-tuning/inference-feedback.test.ts`

Expected: all focused tests pass.

Run: `cd server-jarvis; bunx tsc --noEmit`

Expected: exit code 0; the current `sample_count` / `routing_score_delta` errors are gone.

- [ ] **Step 4: Bake dirty-tree provenance into the server bundle and manifest**

```powershell
$buildGitDirty = -not [string]::IsNullOrWhiteSpace((git -C $repo status --porcelain))
$sourceRoots = @(
    (Join-Path $repo 'server-jarvis\src'),
    (Join-Path $repo 'src-tauri\src'),
    (Join-Path $repo 'src-ui\src'),
    (Join-Path $repo 'scripts')
)
$sourceFiles = Get-ChildItem -LiteralPath $sourceRoots -Recurse -File | Sort-Object FullName
$sourceTreeText = foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($repo.Length).TrimStart('\')
    "${relative}:$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $sourceTreeBytes = [Text.Encoding]::UTF8.GetBytes(($sourceTreeText -join "`n"))
    $sourceTreeSha256 = ([BitConverter]::ToString($sha256.ComputeHash($sourceTreeBytes))).Replace('-', '')
} finally {
    $sha256.Dispose()
}
```

Pass `JARVIS_GIT_DIRTY` and `JARVIS_SOURCE_TREE_SHA256` through Bun `--define`, return them from `/health`, and add both fields to `.jarvis-deploy-manifest.json`.

- [ ] **Step 5: Commit the completed reliability/provenance checkpoint**

```powershell
git add server-jarvis/src/self-tuning/inference-feedback.ts server-jarvis/src/self-tuning/inference-feedback.test.ts scripts/build-and-deploy.ps1 scripts/verify-deploy.ps1 server-jarvis/src/index.ts
git commit -m "fix: stabilize orchestration reliability provenance"
```

### Task 2: Make turn, stage, token, and fallback telemetry truthful

**Files:**

- Create: `server-jarvis/src/orchestration/turn-metrics.ts`
- Create: `server-jarvis/src/orchestration/turn-metrics.test.ts`
- Modify: `server-jarvis/src/index.ts:2441-2479,2560-2623`
- Modify: `server-jarvis/src/inference-metrics.ts`
- Modify: `server-jarvis/src/inference-metrics.test.ts`
- Modify: `server-jarvis/src/performance/runtime-monitor.ts`
- Modify: `src-ui/src/components/jarvis/SystemHealthView.tsx`
- Modify: `src-ui/src/components/jarvis/SystemHealthView.test.ts`

**Interfaces:**

- Consumes: `StageRun[]`, `ModelAttribution[]`, queue wait, and runtime monitor snapshots.
- Produces: `summarizeTurnMetrics`, `recordInferenceAttempt`, and a secret-safe `/health/inference` timeline.

- [ ] **Step 1: Capture the quadratic token bug in a failing test**

```ts
test("sums stage tokens exactly once", () => {
  const summary = summarizeTurnMetrics({
    stages: [
      stage({ input_tokens: 1_000, output_tokens: 100, duration_ms: 2_000 }),
      stage({ input_tokens: 2_000, output_tokens: 200, duration_ms: 3_000 }),
      stage({ input_tokens: 3_000, output_tokens: 300, duration_ms: 4_000 }),
    ],
    attributions: [],
  });

  expect(summary.tokens_in).toBe(6_000);
  expect(summary.tokens_out).toBe(600);
  expect(summary.tokens_total).toBe(6_600);
  expect(summary.stage_duration_ms).toBe(9_000);
});
```

- [ ] **Step 2: Implement the pure turn summary**

```ts
export interface TurnMetricSummary {
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  tool_calls: number;
  stage_duration_ms: number;
  failed_attempts: number;
  fallback_successes: number;
}

export function summarizeTurnMetrics(input: {
  stages: StageRun[];
  attributions: ModelAttribution[];
}): TurnMetricSummary {
  const tokens_in = input.stages.reduce((sum, stage) => sum + (stage.input_tokens ?? 0), 0);
  const tokens_out = input.stages.reduce((sum, stage) => sum + (stage.output_tokens ?? 0), 0);
  return {
    tokens_in,
    tokens_out,
    tokens_total: tokens_in + tokens_out,
    tool_calls: input.stages.reduce((sum, stage) => sum + JSON.parse(stage.tool_calls_json || "[]").length, 0),
    stage_duration_ms: input.stages.reduce((sum, stage) => sum + (stage.duration_ms ?? 0), 0),
    failed_attempts: input.attributions.filter((attempt) => attempt.had_error === 1).length,
    fallback_successes: input.attributions.filter((attempt) => attempt.fallback_used === 1 && attempt.was_successful === 1).length,
  };
}
```

- [ ] **Step 3: Replace the cumulative loop and populate orchestrated inference records**

```ts
const stageRuns = outcomeCollector["store"].getStageRuns(agentRunId);
const modelAttributions = outcomeCollector["store"].getModelAttributions(agentRunId);
const turnMetrics = summarizeTurnMetrics({ stages: stageRuns, attributions: modelAttributions });

outcomeCollector.completeAgentRun(
  agentRunId,
  finalOutputForLog,
  duration,
  turnMetrics.tool_calls,
  turnMetrics.tokens_total,
  runOutcome,
);
```

Pass `tokens_in`, `tokens_out`, `fallback_used`, and `retry_count` from `turnMetrics` into every orchestrator `recordInference` call.

- [ ] **Step 4: Record individual model attempts**

```ts
export interface InferenceAttemptRecord {
  ts: number;
  session_id: string;
  run_id?: string;
  stage: string;
  provider: Backend;
  model: string;
  outcome: "success" | "first_token_timeout" | "stream_idle_timeout" | "visible_progress_timeout" | "empty_completion" | "http_error";
  latency_ms: number;
  first_token_ms?: number;
  fallback_attempt: number;
}
```

Use a 200-entry ring. Expose only the newest 30 attempts through `recent_attempts`; never include prompt text, response text, URLs containing credentials, or headers.

- [ ] **Step 5: Start runtime measurement unconditionally but keep periodic logs opt-in**

```ts
const runtimePerformanceMonitor = createRuntimeMonitor();
runtimePerformanceMonitor.start();
const runtimePerformanceLogTimer = process.env.JARVIS_PERF_MONITOR === "1"
  ? setInterval(() => {
      console.log(`[Jarvis Perf] ${JSON.stringify(runtimePerformanceMonitor.snapshot({ reset: true }))}`);
    }, runtimePerformanceLogIntervalMs)
  : undefined;
```

Add `runtime: runtimePerformanceMonitor.snapshot({ reset: false })` to `/health/inference`.

- [ ] **Step 6: Render stage and runtime evidence in System Health**

Show the last-attempt stage, provider/model, outcome, latency, first-token latency, queue delay, event-loop p95, event-loop utilization, and RSS. Render `No attempt data yet` when the ring is empty.

- [ ] **Step 7: Verify and commit**

Run: `cd server-jarvis; bun test src/orchestration/turn-metrics.test.ts src/inference-metrics.test.ts src/performance/runtime-monitor.test.ts`

Run: `cd src-ui; bun run test -- SystemHealthView.test.ts`

Expected: all tests pass and the 6,600-token fixture is not overcounted.

```powershell
git add server-jarvis/src/orchestration/turn-metrics.ts server-jarvis/src/orchestration/turn-metrics.test.ts server-jarvis/src/index.ts server-jarvis/src/inference-metrics.ts server-jarvis/src/inference-metrics.test.ts server-jarvis/src/performance/runtime-monitor.ts src-ui/src/components/jarvis/SystemHealthView.tsx src-ui/src/components/jarvis/SystemHealthView.test.ts
git commit -m "fix: make orchestration performance telemetry truthful"
```

### Task 3: Stop successful stages from paying unconditional Live Conductor calls

**Files:**

- Modify: `server-jarvis/src/orchestration/conductor.ts`
- Modify: `server-jarvis/src/orchestration/conductor.test.ts`
- Modify: `server-jarvis/src/orchestration/pipeline.ts:308-350,392-450,454-628,866-945`
- Modify: `server-jarvis/src/index.ts:2343-2353`
- Create: `server-jarvis/src/orchestration/performance-regression.test.ts`

**Interfaces:**

- Consumes: task type, estimated complexity, real remaining stage queue, stage outcome, and tool-error count.
- Produces: `shouldSuperviseStage` and zero provider supervision calls for healthy successful stages.

- [ ] **Step 1: Write the production-wiring regression**

```ts
test("successful full execution does not spend provider calls on live supervision", async () => {
  const calls: string[] = [];
  const callModel = fakeCallModel((options) => calls.push(options.stageLabel ?? "unknown"));

  await runPipelineFixture({
    requirement: "full_execution",
    complexity: "medium",
    stages: ["executor", "reviewer", "synthesizer"],
    callModel,
  });

  expect(calls.filter((stage) => stage === "coordinator")).toHaveLength(0);
});
```

- [ ] **Step 2: Make the supervision decision pure**

```ts
export function shouldSuperviseStage(input: {
  supervisionEnabled: boolean;
  outcome: "completed" | "failed";
  remainingQueue: StageName[];
  consecutiveToolErrors: number;
}): boolean {
  if (!input.supervisionEnabled || input.remainingQueue.length === 0) return false;
  if (input.outcome === "failed") return true;
  return input.consecutiveToolErrors > 0;
}
```

The formal reviewer already evaluates successful outputs. Do not spend a second coordinator model call merely to say `continue` after a successful stage.

- [ ] **Step 3: Wire the route context in production**

```ts
const liveConductor = new LiveConductor(
  callModel,
  conductorBus,
  agentPool,
  cfg.orchestrator.conductor.supervision,
);
liveConductor.setContext(
  route.task_type,
  route.context.estimated_complexity,
  agentRunId,
);
```

- [ ] **Step 4: Pass the real remaining queue**

In `executeSegment`, compute the queue from the requested stages and pass it into each stage helper:

```ts
const remainingAfter = (stage: StageName): StageName[] => {
  const index = stages.indexOf(stage);
  return index < 0 ? [] : stages.slice(index + 1);
};
```

Change `afterConductorStage` to accept `remainingQueue` and call `live.afterStage(stage, outcome, output, remainingQueue)`. Delete the current `[stage]` placeholder.

- [ ] **Step 5: Keep heuristic reroute local**

When consecutive tool errors reach `max_tool_errors_before_reroute`, return the deterministic reroute without a model call. When the model supervisor times out or returns invalid JSON, record `continue` with `supervision_outcome: "unavailable"` and do not retry.

- [ ] **Step 6: Verify and commit**

Run: `cd server-jarvis; bun test src/orchestration/conductor.test.ts src/orchestration/performance-regression.test.ts src/orchestration.test.ts`

Expected: low-complexity gating works in production wiring; successful stages produce zero `stageLabel=coordinator` provider calls; failure/tool-error cases still reroute.

```powershell
git add server-jarvis/src/orchestration/conductor.ts server-jarvis/src/orchestration/conductor.test.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/performance-regression.test.ts server-jarvis/src/index.ts
git commit -m "perf: remove redundant live conductor calls"
```

### Task 4: Bound review and rewrite work by measurable progress

**Files:**

- Modify: `server-jarvis/src/orchestration/pipeline.ts:630-852,964-1040`
- Modify: `server-jarvis/src/orchestration/modes.ts`
- Modify: `server-jarvis/src/config.ts`
- Modify: `server-jarvis/src/config.test.ts`
- Modify: `server-jarvis/src/orchestration/performance-regression.test.ts`

**Interfaces:**

- Consumes: execution profile, reviewer verdict, successful write signatures, and `max_review_repair_rounds`.
- Produces: at most one default repair, one verification review, and immediate exit on no progress.

- [ ] **Step 1: Reproduce the three-cycle amplification**

```ts
test("stops after a rewriter makes no new write progress", async () => {
  const result = await runReviewRepairFixture({
    reviewerVerdicts: ["REJECT: requested file was not changed", "REJECT: still unchanged"],
    rewriterToolCalls: [],
    maxReviewRepairRounds: 1,
  });

  expect(result.reviewerCalls).toBe(1);
  expect(result.rewriterCalls).toBe(1);
  expect(result.effectGate.verdict).toBe("no_write_effect");
});
```

- [ ] **Step 2: Add the config default and clamp**

```ts
max_review_repair_rounds: 1,
```

Clamp loaded values to `0..2`. Zero means review once and never auto-rewrite; one means review -> rewrite -> one verification review only when the rewrite produced progress.

- [ ] **Step 3: Define progress from authoritative effects**

```ts
function successfulWriteKeys(calls: ToolCallRecord[]): Set<string> {
  return new Set(calls
    .filter((call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name))
    .map((call) => `${call.name}:${JSON.stringify(call.arguments)}`));
}

function addedWriteProgress(before: Set<string>, after: Set<string>): boolean {
  return [...after].some((key) => !before.has(key));
}
```

For `read_only` and `none` profiles, do not invoke `rewriter`; carry reviewer feedback directly into the synthesizer.

- [ ] **Step 4: Rewrite the loop around repair count, not review count**

```ts
let repairs = 0;
while (true) {
  const review = await runReviewer();
  if (!review.hasIssues || profile !== "full") break;
  if (repairs >= maxReviewRepairRounds) break;

  const before = successfulWriteKeys(allToolCalls());
  rewriterOutput = await runRewriterStage(/* existing arguments */);
  repairs += 1;
  const after = successfulWriteKeys(allToolCalls());
  if (!addedWriteProgress(before, after)) break;
}
```

Do not run the separate no-write repair at `executeSegment` if a repair was already attempted. Preserve the terminal failed effect-gate result.

- [ ] **Step 5: Tighten tool-loop caps**

Set full-profile executor `max_turns` to 4 and rewriter `max_turns` to 3. Preserve read-only executor `max_turns=2`.

- [ ] **Step 6: Verify and commit**

Run: `cd server-jarvis; bun test src/orchestration/performance-regression.test.ts src/orchestration/effect-gate.test.ts src/orchestration.test.ts src/config.test.ts`

Expected: no-progress repair uses one rewriter at most; read-only routes use none; successful write repair gets one verification review.

```powershell
git add server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/modes.ts server-jarvis/src/config.ts server-jarvis/src/config.test.ts server-jarvis/src/orchestration/performance-regression.test.ts
git commit -m "perf: bound orchestration repair loops by progress"
```

### Task 5: Add requirement-aware turn budgets and decisive stage failover

**Files:**

- Create: `server-jarvis/src/orchestration/turn-budget.ts`
- Create: `server-jarvis/src/orchestration/turn-budget.test.ts`
- Modify: `server-jarvis/src/index.ts:194-203,1223-1229,1502-2209`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/stage-health.ts`
- Modify: `server-jarvis/src/orchestration/stage-health.test.ts`
- Modify: `server-jarvis/src/first-token-timeout.test.ts`
- Modify: `server-jarvis/src/openrouter-fallback.test.ts`

**Interfaces:**

- Consumes: `TurnRequirement`, estimated complexity, current time, stage, and recent stage health.
- Produces: `TurnBudget`, finalization reserve checks, maximum attempts, and cross-turn cooldown exclusions.

- [ ] **Step 1: Define explicit safety budgets**

```ts
export interface TurnBudget {
  turn_ms: number;
  finalization_reserve_ms: number;
  max_stage_attempts: number;
  stage_ms: Record<string, number>;
}

const BUDGETS: Record<TurnRequirement, TurnBudget> = {
  conversational: { turn_ms: 30_000, finalization_reserve_ms: 15_000, max_stage_attempts: 2, stage_ms: { synthesizer: 25_000 } },
  answer_only: { turn_ms: 45_000, finalization_reserve_ms: 20_000, max_stage_attempts: 2, stage_ms: { planner: 15_000, synthesizer: 30_000 } },
  workspace_read: { turn_ms: 75_000, finalization_reserve_ms: 25_000, max_stage_attempts: 2, stage_ms: { executor: 25_000, synthesizer: 30_000 } },
  full_execution: { turn_ms: 150_000, finalization_reserve_ms: 30_000, max_stage_attempts: 2, stage_ms: { planner: 20_000, executor: 30_000, reviewer: 20_000, rewriter: 30_000, synthesizer: 35_000 } },
};
```

High complexity may add 30 seconds to the full-execution turn cap but must never exceed 180 seconds. These are server-authoritative safety caps; live p95 objectives are stricter and checked in Task 8.

- [ ] **Step 2: Test the finalization reserve**

```ts
test("does not start optional repair work inside the synthesis reserve", () => {
  const budget = createTurnBudget("full_execution", "high", 1_000);
  expect(budget.canStart("rewriter", 151_000)).toBe(false);
  expect(budget.remainingMs(151_000)).toBe(30_000);
});
```

- [ ] **Step 3: Apply per-attempt timeouts from the smaller remaining budget**

```ts
const attemptTimeoutMs = Math.max(
  1_000,
  Math.min(
    firstTokenTimeoutFor(poolModel, poolProvider, firstTokenMs, agentPool.list()),
    turnBudget.stageRemainingMs(stageName, Date.now()),
    turnBudget.remainingMs(Date.now()) - turnBudget.finalization_reserve_ms,
  ),
);
```

Do not start planner, reviewer, rewriter, recursive critique, or supervision when doing so would consume the reserved synthesizer window. Return `partial` with real execution evidence when optional work is skipped.

- [ ] **Step 4: Make one empty synthesizer completion enough for cooldown**

Store failure timestamps by `stage:provider:model`. First-token, idle, visible-progress, and empty answer failures all enter cooldown immediately. Use five minutes for transport stalls and two minutes for an empty answer. A success after cooldown clears the record; an alternating success must not erase a still-active cooldown.

```ts
const COOLDOWN_MS: Record<RecoverableFailureKind, number> = {
  first_token_timeout: 5 * 60_000,
  stream_idle_timeout: 5 * 60_000,
  empty_completion: 2 * 60_000,
};
```

- [ ] **Step 5: Cap each stage at two candidates**

Attempt the selected candidate and one distinct fallback. Never spend the entire turn walking every configured model. Record the first failure and the fallback success separately.

- [ ] **Step 6: Verify and commit**

Run: `cd server-jarvis; bun test src/orchestration/turn-budget.test.ts src/orchestration/stage-health.test.ts src/first-token-timeout.test.ts src/openrouter-fallback.test.ts src/orchestration/performance-regression.test.ts`

Expected: an empty Flash synthesizer is excluded on the next turn; optional repair does not invade the synthesis reserve; each stage attempts at most two models.

```powershell
git add server-jarvis/src/orchestration/turn-budget.ts server-jarvis/src/orchestration/turn-budget.test.ts server-jarvis/src/index.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/stage-health.ts server-jarvis/src/orchestration/stage-health.test.ts server-jarvis/src/first-token-timeout.test.ts server-jarvis/src/openrouter-fallback.test.ts
git commit -m "perf: enforce orchestration latency budgets"
```

### Task 6: Prioritize interactive chat over cron and self-improvement work

**Files:**

- Create: `server-jarvis/src/orchestration/admission-controller.ts`
- Create: `server-jarvis/src/orchestration/admission-controller.test.ts`
- Modify: `server-jarvis/src/index.ts:1223-1260,3901-3913`
- Modify: `server-jarvis/src/cron-runtime.ts`
- Modify: `src-tauri/src/cron_scheduler.rs`

**Interfaces:**

- Consumes: `SurfaceType`, abort signal, queue deadline, and lease release.
- Produces: interactive-priority turn leases and retryable `background_deferred` cron evidence.

- [ ] **Step 1: Test the observed chat/cron collision**

```ts
test("queues cron while an interactive turn owns provider capacity", async () => {
  const controller = new OrchestrationAdmissionController({ interactive: 2, background: 1 });
  const chat = await controller.acquire({ workClass: "interactive" });
  let cronStarted = false;
  const cronPromise = controller.acquire({ workClass: "background" }).then((lease) => {
    cronStarted = true;
    return lease;
  });

  await Promise.resolve();
  expect(cronStarted).toBe(false);
  chat.release();
  const cron = await cronPromise;
  expect(cronStarted).toBe(true);
  cron.release();
});
```

- [ ] **Step 2: Implement abortable priority leases**

```ts
export interface AdmissionLease {
  queue_wait_ms: number;
  release(): void;
}

export class OrchestrationAdmissionController {
  constructor(private readonly limits = { interactive: 2, background: 1 }) {}
  acquire(input: {
    workClass: "interactive" | "background";
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<AdmissionLease>;
}
```

Interactive work may start while another interactive turn is active up to the configured limit. Background work starts only when no interactive lease is active or queued. FIFO ordering applies inside each class. Aborted and expired waiters must be removed immediately.

- [ ] **Step 3: Acquire and release at the whole-turn boundary**

Map `chat`, `mcp`, and direct desktop turns to `interactive`; map `cron` to `background`. Emit an SSE `orchestrator_queue` frame containing `queue_wait_ms` and `work_class` after acquisition. Release in `streamJarvis`'s outer `finally` block.

- [ ] **Step 4: Return retryable cron deferral**

If background acquisition exceeds 30 seconds, return:

```json
{
  "success": false,
  "error": "background_deferred",
  "execution_evidence": {
    "status": "cancelled",
    "error_code": "interactive_capacity_reserved"
  }
}
```

Teach `cron_scheduler.rs` to schedule the next attempt with bounded jitter rather than recording a model failure.

- [ ] **Step 5: Verify and commit**

Run: `cd server-jarvis; bun test src/orchestration/admission-controller.test.ts src/cron-runtime.test.ts`

Run: `cargo test --manifest-path src-tauri/Cargo.toml cron_scheduler`

Expected: interactive work is never queued behind cron; background work resumes after interactive release; cancellation removes waiters.

```powershell
git add server-jarvis/src/orchestration/admission-controller.ts server-jarvis/src/orchestration/admission-controller.test.ts server-jarvis/src/index.ts server-jarvis/src/cron-runtime.ts src-tauri/src/cron_scheduler.rs
git commit -m "perf: prioritize interactive orchestration work"
```

### Task 7: Bound repeated history and cross-stage payload growth

**Files:**

- Modify: `server-jarvis/src/orchestration/context-budget.ts`
- Modify: `server-jarvis/src/orchestration/context-budget.test.ts`
- Modify: `server-jarvis/src/index.ts:1233-1245,1480-1484,2271-2276,2495-2518`
- Modify: `server-jarvis/src/orchestration/pipeline.ts`
- Modify: `server-jarvis/src/orchestration/synth-context.ts`
- Modify: `server-jarvis/src/self-tuning/collector.ts`

**Interfaces:**

- Consumes: raw current message, `TurnRequirement`, recent history, and authoritative tool-call records.
- Produces: stage-specific bounded context and raw-request training records.

- [ ] **Step 1: Classify the raw request before building history context**

Move `classifyTurnRequirements(message)` before `contextMessage`. Select these history caps:

```ts
export const HISTORY_BUDGET_TOKENS: Record<TurnRequirement, number> = {
  conversational: 0,
  answer_only: 1_200,
  workspace_read: 2_000,
  full_execution: 2_400,
};
```

Keep at most 800 characters per history message. A zero budget returns an empty history block.

- [ ] **Step 2: Persist the raw request, not the expanded conversation**

```ts
outcomeCollector.startAgentRun(
  agentRunId,
  sessionId,
  message,
  route.task_type,
  executablePipeline,
);
```

Pass `message` rather than `contextMessage` to conductor-learning and skill-distillation `userRequest`. The model pipeline may still consume `contextMessage`; training and diagnostics must identify the actual current request.

- [ ] **Step 3: Bound stage payloads by responsibility**

Add `truncateToTokenBudget(text, budget)` and use these maximum dynamic payloads excluding the stable system prompt:

| Stage | Dynamic token budget |
|---|---:|
| Coordinator route | 2,500 |
| Planner | 3,000 |
| Executor request + plan | 4,000 |
| Reviewer | 5,000 |
| Rewriter | 5,000 |
| Synthesizer evidence | 6,000 |

Always preserve the raw latest request and newest successful tool effects before older narrative text. Replace full repeated tool output with `name`, arguments hash, error code, and a 600-character result excerpt.

- [ ] **Step 4: Test a long session and many tool calls**

```ts
test("keeps synthesis payload bounded while preserving latest request and writes", () => {
  const context = buildSynthesizerContext(longRequest, stateWithTwentyToolCalls());
  expect(countTokens(context)).toBeLessThanOrEqual(6_000);
  expect(context).toContain(longRequest.slice(0, 200));
  expect(context).toContain("write_file");
  expect(context).toContain("success");
});
```

- [ ] **Step 5: Verify and commit**

Run: `cd server-jarvis; bun test src/orchestration/context-budget.test.ts src/orchestration/synth-context.test.ts src/orchestration/performance-regression.test.ts src/self-tuning/self-tuning.test.ts`

Expected: every stage fixture stays under its cap; newest request and authoritative write evidence survive truncation.

```powershell
git add server-jarvis/src/orchestration/context-budget.ts server-jarvis/src/orchestration/context-budget.test.ts server-jarvis/src/index.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/synth-context.ts server-jarvis/src/self-tuning/collector.ts
git commit -m "perf: bound orchestration context growth"
```

### Task 8: Build a repeatable live benchmark and deploy against explicit SLOs

**Files:**

- Create: `scripts/benchmark-jarvis-runtime.ps1`
- Modify: `scripts/smoke-jarvis-runtime.ps1`
- Modify: `scripts/verify-deploy.ps1`
- Create: `docs/reports/2026-07-11-orchestration-performance-evidence.md`

**Interfaces:**

- Consumes: live `/chat/stream`, `/health`, `/health/inference`, deploy manifest, and temporary test artifacts.
- Produces: JSON samples plus a source-controlled release evidence report.

- [ ] **Step 1: Implement the three-scenario benchmark**

```powershell
$scenarios = @(
    @{ Name = 'direct'; Prompt = 'Reply with exactly: benchmark ok.'; LimitMs = 30000 },
    @{ Name = 'workspace_read'; Prompt = "Read '$repo\README.md' and report only the first heading."; LimitMs = 60000 },
    @{ Name = 'full_execution'; Prompt = "Create '$artifact' with exactly JARVIS_BENCHMARK, read it, then report the exact contents."; LimitMs = 120000 }
)
```

Run each scenario five times with unique sessions. Record queue wait, route latency, stage count, model attempts, first visible token, terminal latency, fallback count, outcome, and artifact verification. Remove every temporary artifact in `finally`.

- [ ] **Step 2: Enforce structural gates before live latency gates**

Fail immediately if:

- direct uses any tool stage;
- a successful stage triggers Live Conductor provider supervision;
- workspace read has no successful read evidence;
- full execution has no successful write and read;
- any stage exceeds two provider attempts;
- a run exceeds the server safety budget;
- `/health` manifest provenance does not match the deployed file hashes.

- [ ] **Step 3: Evaluate live latency objectives**

With no other interactive workload:

| Scenario | p50 objective | p95 objective |
|---|---:|---:|
| Direct answer | <= 10 s | <= 30 s |
| Workspace read | <= 30 s | <= 60 s |
| Full execution write/read | <= 75 s | <= 120 s |

An external provider miss may make one five-sample run fail. Re-run once; if the same objective fails twice, keep the release blocked and attach `recent_attempts` evidence rather than widening the SLO.

- [ ] **Step 4: Run complete verification**

Run: `cd server-jarvis; bun test`

Expected: all Bun tests pass.

Run: `cd server-jarvis; bunx tsc --noEmit`

Expected: exit code 0.

Run: `cd src-ui; bun run test && bun run build`

Expected: Vitest and UI build pass.

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests pass.

- [ ] **Step 5: Build, deploy, and prove the real Desktop bundle**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -RestartServer
$sha = (Get-FileHash server-jarvis\dist\index.js -Algorithm SHA256).Hash
powershell -ExecutionPolicy Bypass -File scripts\verify-deploy.ps1 -ExpectSha $sha
powershell -ExecutionPolicy Bypass -File scripts\smoke-jarvis-runtime.ps1 -WriteReadSmoke
powershell -ExecutionPolicy Bypass -File scripts\benchmark-jarvis-runtime.ps1 -Iterations 5
```

Expected: deployed and dist hashes match; `/health` reports the same Git SHA, dirty flag, and source tree digest as the manifest; write/read smoke passes; benchmark structural gates and SLOs pass.

- [ ] **Step 6: Record release evidence and commit**

Include before/after p50/p95, error rate, per-stage attempt counts, queue delay, event-loop p95, token totals, fallback use, deployed bundle hash, Git SHA, dirty flag, and source tree digest in `docs/reports/2026-07-11-orchestration-performance-evidence.md`.

```powershell
git add scripts/benchmark-jarvis-runtime.ps1 scripts/smoke-jarvis-runtime.ps1 scripts/verify-deploy.ps1 docs/reports/2026-07-11-orchestration-performance-evidence.md
git commit -m "test: prove orchestration performance in deployed runtime"
```

---

## Acceptance criteria

- `/health/inference` reports non-zero orchestrated token totals, per-attempt outcomes, real fallback use, queue delay, and runtime pressure.
- The 404,314-token overcount fixture records the exact linear sum of stage input and output tokens.
- Healthy successful planner/executor/synthesizer stages make zero Live Conductor provider calls.
- Low-complexity supervision is disabled in production wiring, not only in unit tests.
- A full-execution turn performs at most one default repair and stops immediately when that repair produces no new successful write.
- Read-only and answer-only turns never invoke the mutating rewriter.
- One empty synthesizer completion excludes that stage/provider/model for the configured cooldown.
- No stage attempts more than two provider/model candidates.
- Interactive chat is never queued behind self-improvement or cron inference.
- Raw current requests, not expanded conversation transcripts, are persisted as `agent_runs.user_request` and used for learning/distillation.
- Direct, workspace-read, and full-execution stage payloads stay within their explicit token budgets.
- The live Desktop bundle passes the structural benchmark gates and the latency objectives in two consecutive five-sample runs.
- Deployment evidence identifies Git SHA, dirty state, source tree digest, Desktop bundle hash, prompts hash, and live process provenance.

## Recommended execution order

1. Task 1 is a hard prerequisite because the current reliability work is deployed but does not typecheck.
2. Task 2 lands truthful measurement before performance behavior changes.
3. Tasks 3 and 4 remove the largest deterministic amplification sources.
4. Task 5 adds bounded time/failover behavior after call count is under control.
5. Task 6 isolates interactive work from background contention.
6. Task 7 reduces provider payload cost without weakening evidence.
7. Task 8 is the release gate and must run against the deployed Desktop runtime.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-orchestration-runtime-performance-remediation.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - execute one task at a time with a fresh implementation review and checkpoint after each task.
2. **Inline Execution** - execute in this task using `superpowers:executing-plans`, batching only closely coupled steps and stopping at each verification gate.
