# Orchestration Runtime Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make Jarvis reliably execute change requests by preserving healthy stage defaults, failing over after recoverable model stalls, keeping conductor routes parseable, and failing no-write implementations.

**Architecture:** The Bun server owns stage selection, provider fallback, the persistent conductor, and Tool runtime execution. Add a testable stage-health registry at the Bun routing boundary; Rust and the UI remain unchanged except for consuming existing structured stream events.

**Tech Stack:** Bun, TypeScript, Bun test, SQLite self-tuning data, Ollama persistent conductor, OpenAI-compatible OpenCode/OpenRouter APIs.

## Global Constraints

- Keep the native UI -> Bun server -> orchestrator -> inference backend contract and the orchestrator.enabled master gate.
- Never commit provider keys, local config, or fixtures containing secrets.
- A first-token timeout is recoverable model failure, never user cancellation.
- A full_execution turn with zero successful writes must finish as failed.
- Release proof must refresh Desktop index.js and prompts with the executable.

---

## Incident basis

The July 11 live session shows that feedback promoted opencode_go:deepseek-v4-pro above every stage default; the pool resolved it for planner, executor, reviewer, rewriter, and synthesizer. The synthesizer then reached the 30-second first-token watchdog, but the wrapper only retries an empty successful response, not a timeout. The local conductor also returned a verbose routing object that was cut off within its 700-token budget; parsing fell back to generic routing and discarded its worker details. Current health metrics report 37.5% errors, about 34-second p50, zero output tokens, and no fallback use.

## Task 1: Capture the live incident as regressions

**Files:**

- Create: server-jarvis/src/orchestration/stage-health.test.ts
- Modify: server-jarvis/src/orchestration/agent-pool.test.ts
- Modify: server-jarvis/src/orchestration/coordinator.test.ts
- Modify: server-jarvis/src/orchestration/effect-gate.test.ts

**Interfaces:** Consumes AgentPool.pickFor, Coordinator.route, and evaluateEffectGate. Produces deterministic tests for default selection, cooldown exclusion, compact routing, and no-write failure.

- [ ] **Step 1: Write the stage-default test**

~~~ts
test("healthy synthesizer default is not displaced by global feedback", () => {
  applyInferenceFeedback(policyWith({
    "opencode_go:deepseek-v4-flash": { sample_count: 8, routing_score_delta: -0.05 },
    "opencode_go:deepseek-v4-pro": { sample_count: 30, routing_score_delta: 0.15 },
  }));
  const pool = new AgentPool([flashSynthesizer, proPlanner]);

  expect(pool.pickFor("synthesizer", "general")?.id).toBe("flash-synthesizer");
});
~~~

- [ ] **Step 2: Write the recoverable-timeout test**

~~~ts
test("first-token timeout excludes a model for the next stage attempt", () => {
  const health = new StageHealthRegistry(() => 10_000);
  health.recordFailure({
    provider: "opencode_go",
    modelId: "deepseek-v4-pro",
    stage: "synthesizer",
    kind: "first_token_timeout",
  });

  expect(health.excludedModelKeys("synthesizer")).toEqual(
    new Set(["opencode_go:deepseek-v4-pro"]),
  );
});
~~~

- [ ] **Step 3: Write conductor and effect-gate tests**

~~~ts
test("compact conductor route stays parseable within its output budget", async () => {
  const result = await coordinator.route("Implement the requested change", { sessionId: "compact-route" });
  expect(result.routing_parse_fallback).not.toBe(true);
  expect(result.pipeline).toContain("executor");
});

test("full execution with no successful writes is failed", () => {
  const gate = evaluateEffectGate({
    profile: "full",
    executor: { ok: true, narrative: "I would change it", toolCalls: [] },
  });
  expect(applyEffectGate("success", undefined, gate)).toEqual({
    outcome: "failed",
    errorCode: "effect_gate_no_write_effect",
  });
});
~~~

- [ ] **Step 4: Run the red suite**

Run: bun test src/orchestration/agent-pool.test.ts src/orchestration/coordinator.test.ts src/orchestration/effect-gate.test.ts src/orchestration/stage-health.test.ts

Expected: only the new assertions fail.

- [ ] **Step 5: Commit**

~~~powershell
git add server-jarvis/src/orchestration/agent-pool.test.ts server-jarvis/src/orchestration/coordinator.test.ts server-jarvis/src/orchestration/effect-gate.test.ts server-jarvis/src/orchestration/stage-health.test.ts
git commit -m "test: capture orchestration timeout and no-write regressions"
~~~

## Task 2: Preserve stage defaults and add stage-health cooldowns

**Files:**

- Create: server-jarvis/src/orchestration/stage-health.ts
- Modify: server-jarvis/src/orchestration/agent-pool.ts
- Modify: server-jarvis/src/self-tuning/learned-pool-state.ts
- Modify: server-jarvis/src/self-tuning/inference-feedback.ts
- Modify: server-jarvis/src/self-tuning/inference-feedback.test.ts

**Interfaces:** Consumes routing_policy.model_adjustments. Produces StageHealthRegistry, stageRoutingScoreDelta(agent, stage), and primary selection that cannot override a healthy explicit default.

- [ ] **Step 1: Add the health contract**

~~~ts
export type RecoverableFailureKind =
  | "first_token_timeout"
  | "stream_idle_timeout"
  | "empty_completion";

export interface StageModelFailure {
  provider: string;
  modelId: string;
  stage: string;
  kind: RecoverableFailureKind;
}

export class StageHealthRegistry {
  constructor(private readonly now: () => number = Date.now) {}
  recordFailure(failure: StageModelFailure): void;
  recordSuccess(input: Pick<StageModelFailure, "provider" | "modelId" | "stage">): void;
  excludedModelKeys(stage: string): Set<string>;
}
~~~

Use a five-minute cooldown after one timeout/idle failure and after two empty completions. Keep model-failure-memory for non-retryable HTTP failures.

- [ ] **Step 2: Keep learned scores stage-specific**

~~~ts
export function stageModelFeedbackKey(provider: string, modelId: string, stage: string): string {
  return "${provider}:${modelId}:${stage}";
}

export function stageRoutingScoreDelta(agent: OrchestratorAgent, stage: string): number {
  return globalState.stageModelRoutingScoreDeltas.get(
    stageModelFeedbackKey(agent.provider, agent.model_id, stage),
  ) ?? 0;
}
~~~

Add backward-compatible stage_adjustments. Legacy provider:model adjustments can rank fallback candidates only.

- [ ] **Step 3: Make healthy default selection deterministic**

~~~ts
const stageDefault = candidates.find((agent) => agent.default_for.includes(stage));
if (stageDefault) {
  if (stage === "synthesizer") return this.preferFastSynthesizer(stageDefault, candidates, taskType);
  return stageDefault;
}
return candidates.sort(
  (a, b) => this.scoreWithStageFeedback(b, stage, taskType) - this.scoreWithStageFeedback(a, stage, taskType),
)[0];
~~~

Exclusion is the only ordinary reason to skip an explicit stage default. Learned scores still rank the fallback chain.

- [ ] **Step 4: Verify and commit**

Run: bun test src/orchestration/agent-pool.test.ts src/self-tuning/inference-feedback.test.ts src/orchestration/stage-health.test.ts

Expected: PASS; global feedback cannot hijack a healthy synthesizer.

Run: bunx tsc --noEmit

Expected: exit code 0.

~~~powershell
git add server-jarvis/src/orchestration/stage-health.ts server-jarvis/src/orchestration/agent-pool.ts server-jarvis/src/self-tuning/learned-pool-state.ts server-jarvis/src/self-tuning/inference-feedback.ts server-jarvis/src/self-tuning/inference-feedback.test.ts
git commit -m "fix: preserve healthy orchestration stage defaults"
~~~

## Task 3: Fail over every orchestration stage after recoverable stalls

**Files:**

- Modify: server-jarvis/src/index.ts
- Modify: server-jarvis/src/orchestration/stage-health.ts
- Modify: server-jarvis/src/openrouter-fallback.test.ts
- Modify: server-jarvis/src/first-token-timeout.test.ts

**Interfaces:** Consumes FirstTokenTimeoutError, StreamIdleTimeoutError, AgentPool.pickFor. Produces bounded cross-model retry plus per-attempt metrics.

- [ ] **Step 1: Carry provider identity on stream errors**

~~~ts
class FirstTokenTimeoutError extends Error {
  constructor(
    readonly model: string,
    readonly stage: string,
    readonly windowMs: number,
    readonly provider: string,
  ) {
    super("first-token timeout");
    this.name = "FirstTokenTimeoutError";
  }
}
~~~

Construct it with actualProviderUsed in both stream loops. Add equivalent provider metadata to stream-idle and visible-progress errors after provider selection.

- [ ] **Step 2: Replace empty-only retry with bounded stage failover**

~~~ts
const RECOVERABLE_STAGE_FAILURES = new Set([
  "FirstTokenTimeoutError",
  "StreamIdleTimeoutError",
  "VisibleProgressTimeoutError",
]);

async function callWithStageFailover(messages: ChatMessage[], options?: CallModelOptions) {
  const excluded = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await callModelAttempt(messages, options, excluded);
      if (options?.surfaceAsAnswer && !result.content.trim()) {
        excluded.add("${result._provider}:${result._modelUsed}");
        stageHealth.recordFailure({ provider: result._provider, modelId: result._modelUsed, stage: options.stageLabel, kind: "empty_completion" });
        continue;
      }
      stageHealth.recordSuccess({ provider: result._provider, modelId: result._modelUsed, stage: options?.stageLabel ?? "agent" });
      return result;
    } catch (error) {
      if (!RECOVERABLE_STAGE_FAILURES.has(String((error as Error).name)) || streamAbort.signal.aborted) throw error;
      const failure = error as FirstTokenTimeoutError;
      excluded.add("${failure.provider}:${failure.model}");
      stageHealth.recordFailure({ provider: failure.provider, modelId: failure.model, stage: failure.stage, kind: "first_token_timeout" });
    }
  }
  throw new Error("all candidate models failed for the stage");
}
~~~

Do not retry when fewer than five seconds remain in the total turn budget. Emit one non-secret agent_activity event per retry.

- [ ] **Step 3: Merge cooldown exclusions into pool selection**

~~~ts
const poolExcludeModels = new Set<string>(excludeModels ?? []);
for (const key of excludedModelKeys()) poolExcludeModels.add(key);
for (const key of stageHealth.excludedModelKeys(stageLabel)) poolExcludeModels.add(key);
~~~

Use this union in pickFor and cascadeChain. Record every failed attempt, and increment fallbacks_used only when a later attempt succeeds.

- [ ] **Step 4: Add integration coverage**

~~~ts
test("synthesizer advances after a first-token timeout", async () => {
  mockStreamingModel("opencode_go", "deepseek-v4-pro", { neverFirstToken: true });
  mockStreamingModel("openrouter", "cohere/north-mini-code:free", { content: "Recovered answer" });

  const result = await streamWithOrchestration("give a direct answer");

  expect(result.text).toContain("Recovered answer");
  expect(result.attempts).toEqual([
    "opencode_go:deepseek-v4-pro",
    "openrouter:cohere/north-mini-code:free",
  ]);
});
~~~

- [ ] **Step 5: Verify and commit**

Run: bun test src/openrouter-fallback.test.ts src/first-token-timeout.test.ts src/orchestration/stage-health.test.ts

Expected: PASS; cancellation remains cancellation, but a stalled model advances to another candidate.

~~~powershell
git add server-jarvis/src/index.ts server-jarvis/src/orchestration/stage-health.ts server-jarvis/src/openrouter-fallback.test.ts server-jarvis/src/first-token-timeout.test.ts
git commit -m "fix: fail over orchestration stages after recoverable stalls"
~~~

## Task 4: Bound persistent-conductor routing without losing execution authority

**Files:**

- Modify: server-jarvis/src/orchestration/conductor-routing.ts
- Modify: server-jarvis/src/orchestration/persistent-conductor.ts
- Modify: server-jarvis/src/orchestration/coordinator.ts
- Modify: server-jarvis/src/orchestration/coordinator.test.ts
- Modify: server-jarvis/src/prompts/coordinator.md

**Interfaces:** Consumes local Ollama routing output. Produces a compact CoordinatorResult that parses within budget; raw request and stage prompts remain the work specification.

- [ ] **Step 1: Replace the verbose conductor payload with route-only schema**

~~~ts
export const COORDINATOR_ROUTE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    task_type: { type: "string", enum: ["code_review", "debug", "refactor", "general", "plan", "research", "test", "docs"] },
    pipeline: { type: "array", minItems: 1, maxItems: 5, items: { type: ["string", "null"] } },
    topology: { type: "string", enum: ["linear", "speculative_parallel", "speculative_cascade", "recursive"] },
    context: {
      type: "object",
      additionalProperties: false,
      properties: {
        needs_workspace_inspection: { type: "boolean" },
        needs_memory: { type: "boolean" },
        estimated_complexity: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["needs_workspace_inspection", "needs_memory", "estimated_complexity"],
    },
    coordinator_rationale: { type: "string", maxLength: 240 },
  },
  required: ["task_type", "pipeline", "topology", "context", "coordinator_rationale"],
} as const;
~~~

Remove worker_instructions and shared_context from conductor output. Jarvis-owned session memory and skills injection remain intact.

- [ ] **Step 2: Force structured JSON inside a 320-token ceiling**

~~~ts
const body = {
  model: target.model,
  messages,
  stream: false,
  think: false,
  format: COORDINATOR_ROUTE_JSON_SCHEMA,
  options: { temperature: 0, top_p: 0.9, top_k: 40, num_ctx: conductor.num_ctx, num_predict: 320 },
};
~~~

Do not send tools and format together. Keep tool-call extraction only for compatibility with an old response. Rewrite coordinator.md to request only route JSON, no worker detail and no markdown fence.

- [ ] **Step 3: Preserve deterministic execution after malformed output**

~~~ts
const fallback = this.defaultRoute();
fallback.context.needs_workspace_inspection = true;
fallback.coordinator_rationale =
  "Local routing output was invalid; deterministic requirement classification selects executable stages.";
~~~

The activation boundary must continue to call normalizeRoute(decision, turnReq.requirement, source), so full_execution always includes executor, reviewer, and synthesizer.

- [ ] **Step 4: Verify and commit**

Run: bun test src/orchestration/coordinator.test.ts src/orchestration/route-normalization.test.ts src/orchestration/persistent-conductor.test.ts

Expected: PASS; compact routing parses, legacy parser works, malformed routes cannot remove executor.

~~~powershell
git add server-jarvis/src/orchestration/conductor-routing.ts server-jarvis/src/orchestration/persistent-conductor.ts server-jarvis/src/orchestration/coordinator.ts server-jarvis/src/orchestration/coordinator.test.ts server-jarvis/src/prompts/coordinator.md
git commit -m "fix: bound persistent conductor routing responses"
~~~

## Task 5: Make implementation completion truthful and prove the Desktop runtime

**Files:**

- Modify: server-jarvis/src/orchestration/effect-gate.ts
- Modify: server-jarvis/src/orchestration/pipeline.ts
- Modify: server-jarvis/src/orchestration/effect-gate.test.ts
- Modify: server-jarvis/src/inference-metrics.ts
- Modify: server-jarvis/src/index.ts
- Modify: scripts/smoke-jarvis-runtime.ps1

**Interfaces:** Consumes executor/rewriter tool calls and stage attempts. Produces terminal no-write failures, attempt telemetry, and a real write/read smoke.

- [ ] **Step 1: Make no-write effect gate terminal**

~~~ts
export function applyEffectGate(outcome: "success" | "degraded" | "failed", errorCode: string | undefined, report: EffectGateReport) {
  if (outcome !== "success" || report.clean) return { outcome, errorCode };
  if (report.verdict === "no_write_effect") {
    return { outcome: "failed" as const, errorCode: "effect_gate_no_write_effect" };
  }
  return { outcome: "degraded" as const, errorCode: "effect_gate_" + report.verdict };
}
~~~

Keep the existing rewriter repair pass. If it also makes no write, return a structured failure and prohibit completion language.

- [ ] **Step 2: Add bounded attempt telemetry**

~~~ts
export interface InferenceAttemptMetric {
  backend: Backend;
  model: string;
  stage?: string;
  outcome: "success" | "first_token_timeout" | "stream_idle_timeout" | "empty_completion" | "http_error";
  fallback_attempt: number;
  latency_ms: number;
}
~~~

Expose recent_attempts and fallback_successes from /health/inference while retaining current aggregate fields.

- [ ] **Step 3: Extend smoke with temporary-file write/read**

~~~powershell
$artifact = Join-Path $env:TEMP ("jarvis-orchestration-smoke-{0}.txt" -f [guid]::NewGuid())
$prompt = "Create the file '$artifact' with exactly the text JARVIS_SMOKE, then read it and report the exact contents."
$result = Invoke-JarvisStream -Prompt $prompt
if (-not (Test-Path -LiteralPath $artifact)) { throw "Jarvis did not create the smoke artifact" }
if ((Get-Content -Raw -LiteralPath $artifact).Trim() -ne "JARVIS_SMOKE") { throw "Jarvis wrote incorrect smoke content" }
Remove-Item -LiteralPath $artifact -Force
~~~

Assert executor tool activity, a successful write, final synthesizer output, and no first_token_timeout. Use %TEMP%, never the repo.

- [ ] **Step 4: Run complete verification**

Run: bun test

Expected: all server tests pass.

Run: bunx tsc --noEmit

Expected: exit code 0.

Run: bun run build

Expected: server-jarvis/dist/index.js rebuilds.

- [ ] **Step 5: Deploy and prove the shipped runtime**

Run: powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -RestartServer

Expected: Jarvis.exe, home-base.exe, index.js, and prompts refresh together.

Run: `$sha = (Get-FileHash server-jarvis\dist\index.js -Algorithm SHA256).Hash; powershell -ExecutionPolicy Bypass -File scripts\verify-deploy.ps1 -ExpectSha $sha`

Expected: 127.0.0.1:19877 is served by the new Desktop bundle.

Run: powershell -ExecutionPolicy Bypass -File scripts\smoke-jarvis-runtime.ps1

Expected: temporary write/read succeeds and /health/inference reports fallback truthfully.

- [ ] **Step 6: Commit**

~~~powershell
git add server-jarvis/src/orchestration/effect-gate.ts server-jarvis/src/orchestration/pipeline.ts server-jarvis/src/orchestration/effect-gate.test.ts server-jarvis/src/inference-metrics.ts server-jarvis/src/index.ts scripts/smoke-jarvis-runtime.ps1
git commit -m "fix: make orchestration execution and failover observable"
~~~

## Acceptance criteria

- A stalled synthesizer tries a different eligible provider/model before terminal failure.
- A timed-out model cannot be selected again for its stage during cooldown.
- Global historical feedback cannot replace a healthy explicit stage default.
- Local conductor routing remains parseable; malformed output cannot remove full_execution stages.
- A change request with zero successful writes is failed, never reported as completed.
- The deployed desktop runtime passes a temporary-file write/read smoke and provenance check.

## Execution handoff

Plan complete and saved to docs/superpowers/plans/2026-07-11-orchestration-runtime-reliability.md. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task and review each handoff.
2. Inline Execution - Execute tasks in this session using executing-plans with review checkpoints.
