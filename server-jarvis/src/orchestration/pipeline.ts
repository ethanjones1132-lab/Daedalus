import { loadPrompt } from "./prompt-loader";
import { BUILTIN_MODES, executorTurnLimit, getToolsForMode } from "./modes";
import { toolResultModelText, type ToolRuntime, type ExecutionContext } from "../tool-runtime";
import type { CallModelFn, ChatMessage } from "./router";
import type { SharedContextHints, StageName, WorkerInstructions } from "./coordinator";
import type { SessionMemory } from "./session-memory";
import { resolveStagePrompt, stagePromptFile } from "./worker-prompt";
import type { ToolCall, ToolResult } from "../tool-types";
import { outcomeCollector } from "../self-tuning/mod";
import type { StageRun } from "../self-tuning/store";
import { countTokens } from "../tokens";
import type { ConductorBus, ConductorDirective } from "./conductor-bus";
import type { LiveConductor } from "./conductor";
import { buildSynthesizerContext, buildSynthesizerContextFromStageState } from "./synth-context";
import { applyEffectGate, evaluateEffectGate, WRITE_EFFECT_TOOLS, type EffectGateReport } from "./effect-gate";
import type { ExecutionProfile } from "./route-normalization";
import type { TurnRequirement } from "./turn-requirements";
import type { PipelineStageState, PlannerStageOutput, ExecutorStageOutput, ReviewerStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";
import { parseReviewerVerdict, renderExecutorSummary, renderPlanSummary, renderReviewerSummary, renderRewriterSummary } from "./stage-output";
import { assessWorkspaceEvidence } from "./evidence-sufficiency";
import { truncateToTokenBudget } from "./context-budget";

/**
 * The slice of the outcome collector the pipeline depends on. Injecting this
 * (rather than importing the global singleton) lets tests pass an in-memory
 * collector so `bun test` can never pollute the production self-tuning DB.
 */
export interface StageRunRecorder {
  recordStageRun(stage: StageRun): void;
}

export interface ConductorWiring {
  bus: ConductorBus;
  live: LiveConductor;
  /** Optional collector override; defaults to the global outcome collector. */
  collector?: StageRunRecorder;
}

export interface PipelineProgressState {
  stage: "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer" | "conductor_replan";
  status: StageTerminalStatus | "running" | "done";
  output?: string;
  detail?: string;
}

export type StageTerminalStatus = "completed" | "failed" | "timed_out" | "cancelled" | "partial";

export type PipelineTopology = "linear" | "speculative_parallel" | "speculative_cascade" | "recursive";

export interface PipelineExecuteOptions {
  topology?: PipelineTopology;
  maxRecursionDepth?: number;
  /**
   * B-03: starting recursion depth when this `execute()` is itself a
   * recursive re-entry from `applyRecursiveCritique`. The inner pipeline
   * reads `result.recursion_depth ?? 0` to check against the depth cap, so
   * passing the current depth through ensures the shared budget counts
   * ALL re-entries on a turn (planner + executor + conductor_replan),
   * not just the ones inside any single `execute()` call.
   */
  initialRecursionDepth?: number;
  onRecursion?: (event: PipelineRecursionEvent) => void | Promise<void>;
  onDirective?: (directive: ConductorDirective, stage: StageName) => void | Promise<void>;
  /**
   * Least-authority tool profile for the executor/rewriter stages. Set by the
   * route-normalization layer from the turn's capability class. Defaults to
   * `full` so legacy callers are unaffected.
   */
  executionProfile?: ExecutionProfile;
  /** Conductor-generated per-stage instructions; falls back to static prompts when absent. */
  workerInstructions?: WorkerInstructions;
  /** Cross-turn context hints to inject into worker prompts. */
  sharedContext?: SharedContextHints;
  /** Inter-workflow session memory for tool-cache recording and read short-circuit. */
  sessionMemory?: SessionMemory;
  /** Promoted distilled skills block for planner/executor injection. */
  distilledSkillsBlock?: string;
  /**
   * Deterministic capability requirement for the raw current turn. The index
   * activation boundary passes the classifier result here so PipelineExecutor
   * can enforce evidence invariants without reclassifying history-augmented
   * request text.
   */
  turnRequirement?: TurnRequirement;
  /** Maximum automatic full-profile review -> rewrite repair rounds. */
  maxReviewRepairRounds?: number;
}

const READ_CACHE_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "web_fetch"]);
const WORKSPACE_EVIDENCE_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "git_metadata"]);
const MISSING_WORKSPACE_EVIDENCE =
  "Workspace inspection failed: no successful workspace read tool result was produced, so Jarvis will not synthesize repository claims from ungrounded model text.";

export function successfulWriteKeys(calls: ToolCallRecord[]): Set<string> {
  return new Set(
    calls
      .filter((call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name))
      .map((call) => `${call.name}:${JSON.stringify(call.arguments)}`),
  );
}

export function addedWriteProgress(before: Set<string>, after: Set<string>): boolean {
  for (const key of after) {
    if (!before.has(key)) return true;
  }
  return false;
}

function isStageTimeout(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
  return /timeout/i.test(name) || /(?:first-token|stream idle|visible-progress|request) timeout/i.test(errText(error));
}

function hasMutationIntent(request: string): boolean {
  const text = request.toLowerCase();
  const mutationVerb = /\b(write|create|add|edit|modify|update|change|patch|fix|implement|generate|save|replace|delete|remove)\b/.test(text);
  const targetHint = /\b(file|repo|code|source|workspace|path|doc|document|config|test|script)\b/.test(text)
    || /(?:^|[\s"'`])[\w.-]+\/[\w./-]+/.test(text)
    || /\.[a-z0-9]{1,12}\b/.test(text);
  return mutationVerb && targetHint;
}

function parseStreamedToolCall(raw: any): ToolCall {
  const name = raw?.function?.name ?? raw?.name ?? "";
  let args: Record<string, unknown> = {};
  const rawArgs = raw?.function?.arguments ?? raw?.arguments;
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  return {
    id: raw?.id ?? `call_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}

/**
 * Recursion re-enter targets. The critic (recursion-critique.md) may now
 * decide to re-enter any of: `planner` (re-plan with a synthesized brief),
 * `executor` (re-execute / verify / repair), or `conductor_replan` (defer the
 * revision to the conductor's own mid-pipeline replan path — surfaces as a
 * typed event so the SSE relay can render the recurse decision, and the
 * existing `runPipelineWithReplanning` budget applies because the planner
 * re-entry triggers a fresh `coordinator.route()` via the normal route).
 *
 * Track B B-03 (post-phase-4 conductor evolution).
 */
export type RecursionReenterStage = "planner" | "executor" | "conductor_replan";

export interface PipelineRecursionEvent {
  depth: number;
  status: "critique" | "reenter" | "max_depth" | "done" | "failed";
  reenter_stage?: RecursionReenterStage;
  critique?: string;
}

/**
 * Result of a pipeline run. `answer` is the text to surface; `error` is set
 * only when that text is a failure notice rather than a real answer (e.g. the
 * synthesizer threw on a hard auth/network error). Callers MUST check `error`
 * and surface it as an error frame — otherwise a turn-fatal failure looks like
 * a successful (but nonsensical) response, which is exactly how an invalid
 * OpenRouter key used to present as a silent stall.
 */
/**
 * Outcome classification for a pipeline run.
 *   success  — produced a non-empty, validated answer.
 *   degraded — produced an answer but a stage failed / was repaired / empty-and-
 *              recovered along the way (the user still gets a real answer).
 *   failed   — no usable answer (hard error, or every model returned empty).
 */
export type PipelineOutcome = "success" | "degraded" | "failed" | "partial";

export interface PipelineResult {
  answer: string;
  error?: string;
  recursion_depth?: number;
  /** Truthful run outcome. Absent is treated as "success" by legacy callers. */
  outcome?: PipelineOutcome;
  /** Machine-readable failure reason (e.g. "empty_completion", "auth_401"). */
  error_code?: string;
  /**
   * Successful/failed tool calls from the final segment's executor stage, if
   * one ran this turn. Populated so callers (the cross-turn no-progress
   * guard in orchestration/repetition-guard.ts) can tell whether a turn
   * gathered any new evidence without re-deriving it from stage state.
   * Undefined/absent when the executor stage never ran (e.g. a
   * conversational turn that only hit the synthesizer, or a speculative
   * topology that has no ToolCallRecord[] to report).
   */
  toolCalls?: ToolCallRecord[];
}

/**
 * Result of running a bounded slice of the pipeline (one or more stages from
 * `{planner, executor, reviewer, rewriter, synthesizer}`). Carries the typed
 * `PipelineStageState` forward so a B-02 replan loop can hand the conductor
 * real findings, not truncated strings. Synthesizer outputs are populated
 * only when `"synthesizer"` was in the segment's `stages` list.
 */
export interface PipelineSegmentResult {
  state: PipelineStageState;
  synthesizerAnswer?: string;
  synthesizerFatalError?: string;
  /** Precise code for a pre-synthesis runtime fence such as missing evidence. */
  fatalErrorCode?: string;
  synthesizerEmptyCompletion?: boolean;
  effectGate?: EffectGateReport;
  partialStage?: { stage: StageName; errorCode: string };
}

/**
 * Safe error-to-string. Thrown values are not always `Error` instances — a
 * streaming/parse path can `throw` a non-Error (or even `undefined`), and a
 * bare `e.message` then crashes the catch block itself with a confusing
 * "undefined is not an object (evaluating 'e.message')" that masks the real
 * failure. Always funnel caught values through this.
 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

/**
 * Turn a raw model/transport error into a user-readable one-liner. Hard auth
 * and quota failures are the common turn-killers and deserve an actionable hint
 * instead of a bare `API 401: {...}` dump.
 */
export function describePipelineError(raw: string): string {
  const msg = raw || "Unknown error";
  if (/\b401\b/.test(msg) || /unauthor/i.test(msg) || /user not found/i.test(msg) || /invalid api key/i.test(msg)) {
    return "Authentication failed (401): the inference provider rejected the API key. Check your OpenRouter API key in Settings.";
  }
  if (/\b403\b/.test(msg) || /forbidden/i.test(msg)) {
    return "Access denied (403): the API key lacks permission for this model. Check your provider plan or model access.";
  }
  if (/\b429\b/.test(msg) || /rate limit/i.test(msg) || /quota/i.test(msg)) {
    return "Rate limited or out of quota (429): the provider is throttling requests or your credit is exhausted. Try again shortly.";
  }
  if (/\b5\d\d\b/.test(msg) || /bad gateway/i.test(msg) || /unavailable/i.test(msg)) {
    return `The inference provider returned a server error. ${msg}`;
  }
  // First-token / inter-token stalls (index.ts's FirstTokenTimeoutError and the
  // stream-idle watchdog) are a hung model, not a user mistake — the bare
  // "First-token timeout (30000ms) on model=..." text read like a crash to
  // operators. Keep the raw message in parens so the detail isn't lost.
  if (/visible output or tool-call progress/i.test(msg)) {
    return `The model kept producing hidden reasoning but made no visible answer or tool-call progress, so I stopped the stalled stage. Try again — the router can pick a different model. (${msg})`;
  }
  if (/total turn deadline|turn_deadline_exceeded/i.test(msg)) {
    return `The server-authoritative turn deadline expired before Jarvis could finish. The turn was stopped cleanly instead of stalling indefinitely. (${msg})`;
  }
  if (/first-token timeout|stream idle timeout/i.test(msg)) {
    return `The answering model stalled before responding, so I aborted it. Try again — the router will pick a different model. (${msg})`;
  }
  // Intra-stream decoding-loop degeneration (index.ts's DegenerateStreamError,
  // driven by stream-degeneration.ts's periodic tail check). A stage-level
  // catch (e.g. the synthesizer) absorbs this the same way it absorbs a
  // first-token/stream-idle timeout, so it needs the same friendly rewrite
  // instead of the bare "Degenerate stream detected on model=..." text.
  if (/degenerate stream detected/i.test(msg)) {
    return `The model got stuck repeating the same phrase instead of producing a real answer, so I stopped the stalled generation. Try again — the router can pick a different model. (${msg})`;
  }
  return msg;
}

function stageSystemPrompt(
  stage: StageName,
  options: PipelineExecuteOptions,
): string {
  const skillsBlock = stage === "planner" || stage === "executor"
    ? options.distilledSkillsBlock
    : undefined;
  return resolveStagePrompt(
    stage,
    loadPrompt(stagePromptFile(stage)),
    options.workerInstructions,
    options.sharedContext,
    skillsBlock,
  );
}

export class PipelineExecutor {
  private collector: StageRunRecorder;
  private conductor?: ConductorWiring;

  constructor(
    private callModel: CallModelFn,
    private runtime: ToolRuntime,
    private ctx: ExecutionContext,
    // Injected so tests can supply an in-memory collector. Defaults to the
    // global production singleton for the live runtime. The conductor wiring
    // is deliberately accepted in this slot too for backwards compatibility
    // with the staged live-conductor work; both paths are opt-in.
    collectorOrConductor: StageRunRecorder | ConductorWiring = outcomeCollector,
  ) {
    if ("recordStageRun" in collectorOrConductor) {
      this.collector = collectorOrConductor;
    } else {
      this.collector = collectorOrConductor.collector ?? outcomeCollector;
      this.conductor = collectorOrConductor;
    }
  }

  private registerStageAbort(stage: StageName): AbortSignal | undefined {
    if (!this.conductor) return undefined;
    const controller = new AbortController();
    this.conductor.bus.registerAbortHandle(stage, controller);
    return controller.signal;
  }

  private publishStageToken(stage: StageName, chunk: string): void {
    this.conductor?.bus.publishThrottled({
      type: "stage_token",
      stage,
      textDelta: chunk,
      cumulativeLen: chunk.length,
    });
  }

  private async afterConductorStage(
    stage: StageName,
    outcome: "completed" | "failed",
    output: string,
    agentRunId: string,
    options: PipelineExecuteOptions,
    remainingQueue: StageName[],
  ): Promise<void> {
    if (!this.conductor) return;
    let directive: ConductorDirective;
    try {
      // The executor owns the real stage ordering; pass the actual remaining
      // queue so the conductor can avoid work when a stage completed cleanly.
      directive = await this.conductor.live.afterStage(stage, outcome, output, remainingQueue);
    } catch {
      return;
    }

    if (directive.type === "abort_stage") {
      this.conductor.bus.resolveAbort(directive.stage);
    }
    if (directive.type !== "continue") {
      await options.onDirective?.(directive, stage);
    }
    const audit = this.collector as StageRunRecorder & {
      recordDirective?: (row: {
        id: string;
        agent_run_id: string;
        stage: string;
        directive_type: string;
        reason?: string;
        new_remaining_json?: string;
        inject_note?: string;
        inject_for_stage?: string;
      }) => void;
    };
    audit.recordDirective?.({
      id: `dir_${crypto.randomUUID()}`,
      agent_run_id: agentRunId,
      stage,
      directive_type: directive.type,
      reason: "reason" in directive ? directive.reason : undefined,
      new_remaining_json: directive.type === "reroute" ? JSON.stringify(directive.newRemaining) : undefined,
      inject_note: directive.type === "inject_context" ? directive.note : undefined,
      inject_for_stage: directive.type === "inject_context" ? directive.forStage : undefined,
    });
  }

  private async runToolCall(raw: any, options: PipelineExecuteOptions): Promise<ToolResult> {
    const call = parseStreamedToolCall(raw);
    const sessionId = this.ctx.session_id;
    const memory = options.sessionMemory;

    if (memory && sessionId && READ_CACHE_TOOLS.has(call.name)) {
      const cached = memory.lookupCachedToolResult(
        sessionId,
        call.name,
        call.arguments,
        this.ctx.workspace_path,
      );
      if (cached) {
        return {
          call_id: call.id,
          name: call.name,
          output: cached,
          is_error: false,
          duration_ms: 0,
        };
      }
    }

    const result = await this.runtime.execute(call, this.ctx);
    if (memory && sessionId) {
      memory.recordToolResult({
        sessionId,
        toolName: call.name,
        args: call.arguments,
        result,
        workspacePath: this.ctx.workspace_path,
      });
    }
    return result;
  }

  private async runPlannerStage(
    request: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    remainingQueue: StageName[],
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
        stageAbort: this.registerStageAbort("planner"),
        onChunk: (chunk) => {
          onStateChange({ stage: "planner", status: "running", output: chunk });
          this.publishStageToken("planner", chunk);
        }
      });
      const narrative = resp.content;
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
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "planner", status: "failed", output: message });
      await this.afterConductorStage("planner", "failed", message, agentRunId, options, remainingQueue);

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

  private async runExecutorStage(
    request: string,
    planSummary: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
    remainingQueue: StageName[],
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
    let workspaceEvidenceNudgeSent = false;
    const requiresWorkspaceEvidence = options.turnRequirement === "workspace_read";
    const maxTurns = executorTurnLimit(profile);
    let executorTurn = 0;

    // Git/SHA requests are deterministic read-only metadata requests. Some
    // text-protocol providers decline to emit a tool block even after the
    // runtime advertises one, so seed the executor with the constrained
    // capability's real result. This is still scoped to workspace_read and
    // never falls back to arbitrary shell execution.
    if (
      requiresWorkspaceEvidence
      && /\b(git|sha|commit|branch|dirty)\b/i.test(request)
      && this.runtime.listTools().some((tool) => tool.function.name === "git_metadata")
    ) {
      const preflightCall: ToolCall = {
        id: `call_${crypto.randomUUID()}`,
        name: "git_metadata",
        arguments: { include: ["head", "branch", "dirty"] },
      };
      const preflightResult = await this.runToolCall(preflightCall, options);
      const preflightOutput = toolResultModelText(preflightResult);
      toolCalls.push({
        name: preflightCall.name,
        arguments: preflightCall.arguments,
        output: preflightOutput,
        is_error: preflightResult.is_error,
        error_code: preflightResult.error_code,
        duration_ms: preflightResult.duration_ms ?? 0,
      });
      executorMessages.push({
        role: "user",
        content: `[Runtime preflight: git_metadata]\n${preflightOutput}\nUse this exact metadata in your answer; do not claim the tool is unavailable.`,
      });
      onStateChange({
        stage: "executor",
        status: "running",
        output: "\n[Tool Executed: git_metadata]\n",
        detail: "tool:git_metadata",
      });
    }

    try {
      while (!executorDone && turnCount < maxTurns) {
        turnCount++;
        executorTurn++;
        const turnStartTime = Date.now();
        const turnStartIdx = toolCalls.length;
        let response: any;

        try {
          response = await this.callModel(executorMessages, {
            temperature: BUILTIN_MODES.executor.temperature,
            max_tokens: BUILTIN_MODES.executor.max_tokens,
            tools: getToolsForMode("executor", this.runtime.listTools(), profile),
            stream: true,
            stageLabel: "executor",
            suppressActivity: false,
            stageAbort: this.registerStageAbort("executor"),
            onChunk: (chunk) => {
              onStateChange({ stage: "executor", status: "running", output: chunk });
              this.publishStageToken("executor", chunk);
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
                output: toolResultModelText(toolResult),
                is_error: toolResult.is_error,
                error_code: toolResult.error_code,
                duration_ms: toolResult.duration_ms ?? 0,
              });
              executorMessages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: toolResultModelText(toolResult) });
              onStateChange({
                stage: "executor",
                status: "running",
                output: `\n[Tool Executed: ${tc.name}]\n`
              });
            }
          } else if (
            requiresWorkspaceEvidence &&
            !assessWorkspaceEvidence(toolCalls, request).sufficient &&
            !workspaceEvidenceNudgeSent &&
            turnCount < maxTurns
          ) {
            // A workspace_read stage is not grounded merely because an executor
            // model produced prose. Give it one bounded repair round to call a
            // real read tool; if it declines again, the runtime fence below
            // blocks synthesis instead of laundering stale prose as repo facts.
            //
            // The assessment scales with request depth (Phase 2 Task 2.1): a
            // "comprehensively diagnose this repo" turn needs 3+ content reads
            // before synthesis is allowed, so the nudge message tells the
            // executor model exactly what is missing instead of asking for
            // a single read.
            const assessment = assessWorkspaceEvidence(toolCalls, request);
            workspaceEvidenceNudgeSent = true;
            executorMessages.push({
              role: "user",
              content:
                `Workspace evidence is required for this turn. ${assessment.reason}. Call the relevant read-only workspace tools (read_file, list_directory, glob, grep, or git_metadata) and ground your findings in their results before answering.`,
            });
          } else {
            executorDone = true;
          }

          const turnToolErrors = toolCalls.slice(turnStartIdx).filter((call) => call.is_error);
          const missingRequiredEvidence = requiresWorkspaceEvidence && !assessWorkspaceEvidence(toolCalls, request).sufficient;
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "executor",
            turn_number: executorTurn,
            input_tokens: countTokens(JSON.stringify(executorMessages)),
            output_tokens: countTokens(response?.content || ""),
            tool_calls_json: JSON.stringify(response?.tool_calls || []),
            duration_ms: Date.now() - turnStartTime,
            was_successful: turnToolErrors.length === 0 && !missingRequiredEvidence ? 1 : 0,
            had_error: turnToolErrors.length === 0 && !missingRequiredEvidence ? 0 : 1,
            error_message: turnToolErrors[0]
              ? `${turnToolErrors[0].name}: ${(turnToolErrors[0].output || "").slice(0, 200)}`
              : missingRequiredEvidence
                ? "missing_workspace_evidence"
                : undefined,
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
      if (requiresWorkspaceEvidence && !assessWorkspaceEvidence(toolCalls, request).sufficient) {
        onStateChange({ stage: "executor", status: "failed", output: MISSING_WORKSPACE_EVIDENCE });
        return { ok: false, narrative: MISSING_WORKSPACE_EVIDENCE, toolCalls };
      }
      onStateChange({ stage: "executor", status: "completed", output: narrative });
      await this.afterConductorStage("executor", "completed", narrative, agentRunId, options, remainingQueue);
      return { ok: true, narrative, toolCalls };
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "executor", status: "failed", output: message });
      await this.afterConductorStage("executor", "failed", message, agentRunId, options, remainingQueue);
      return { ok: false, narrative: `Executor failed: ${message}`, toolCalls };
    }
  }

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
    const boundedReviewerFeedback = truncateToTokenBudget(reviewerFeedback, 2_000);
    const boundedExecutorSummary = truncateToTokenBudget(executorSummary, 3_000);
    const rewriterMessages: ChatMessage[] = [
      { role: "system", content: rewriterPrompt },
      {
        role: "user",
        content: `User Request: ${truncateToTokenBudget(request, 1_000)}\n\nReviewer Feedback:\n${boundedReviewerFeedback}\n\nExecutor Activity:\n${boundedExecutorSummary}`
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
        const turnStartIdx = toolCalls.length;
        let rewriteResp: any;

        try {
          rewriteResp = await this.callModel(rewriterMessages, {
            temperature: BUILTIN_MODES.rewriter.temperature,
            max_tokens: BUILTIN_MODES.rewriter.max_tokens,
            tools: getToolsForMode("rewriter", this.runtime.listTools(), profile),
            stream: true,
            stageLabel: "rewriter",
            stageAbort: this.registerStageAbort("rewriter"),
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
                output: toolResultModelText(toolResult),
                is_error: toolResult.is_error,
                error_code: toolResult.error_code,
                duration_ms: toolResult.duration_ms ?? 0,
              });
              rewriterMessages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: toolResultModelText(toolResult) });
              onStateChange({
                stage: "rewriter",
                status: "running",
                output: `\n[Tool Executed: ${tc.name}]\n`
              });
            }
          } else {
            rewriterDone = true;
          }

          const turnToolErrors = toolCalls.slice(turnStartIdx).filter((call) => call.is_error);
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "rewriter",
            turn_number: rewriterTurn,
            input_tokens: countTokens(JSON.stringify(rewriterMessages)),
            output_tokens: countTokens(rewriteResp?.content || ""),
            tool_calls_json: JSON.stringify(rewriteResp?.tool_calls || []),
            duration_ms: Date.now() - rewStartTime,
            was_successful: turnToolErrors.length === 0 ? 1 : 0,
            had_error: turnToolErrors.length === 0 ? 0 : 1,
            error_message: turnToolErrors[0]
              ? `${turnToolErrors[0].name}: ${(turnToolErrors[0].output || "").slice(0, 200)}`
              : undefined,
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
      onStateChange({ stage: "rewriter", status: "completed", output: narrative });
      return { ok: true, narrative, toolCalls };
    } catch (e: any) {
      // NOTE (intentional, reviewed change from pre-extraction behavior): before
      // this refactor, a rewriter-turn failure rethrew out of the inline rewrite
      // block and was caught by the outer reviewer-loop catch, which mislabeled
      // it as a "reviewer" failure (wrong onStateChange stage, a duplicate
      // mode_id:"reviewer" telemetry row) and aborted the review/rewrite loop
      // immediately. Catching it here instead gives correct stage attribution
      // and lets the loop continue past a transient rewriter failure.
      const message = errText(e);
      const timedOut = isStageTimeout(e);
      onStateChange({
        stage: "rewriter",
        status: timedOut ? "timed_out" : "failed",
        output: message,
        detail: timedOut ? "stage_timeout" : undefined,
      });
      return {
        ok: false,
        narrative: message,
        toolCalls,
        terminalStatus: timedOut ? "timed_out" : "failed",
        errorCode: timedOut ? "stage_timeout" : "stage_error",
      };
    }
  }

  private async runReviewerRewriterLoop(
    request: string,
    planSummary: string,
    executorSummary: string,
    executorToolCalls: ToolCallRecord[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
  ): Promise<{ reviewer: ReviewerStageOutput; rewriter?: RewriterStageOutput }> {
    const reviewerPrompt = stageSystemPrompt("reviewer", options);
    const boundedRequest = truncateToTokenBudget(request, 1_000);
    const boundedPlanSummary = truncateToTokenBudget(planSummary, 1_000);
    const boundedExecutorSummary = truncateToTokenBudget(executorSummary, 3_000);
    const configuredRepairRounds = Number(options.maxReviewRepairRounds ?? 1);
    const maxRepairRounds = Number.isFinite(configuredRepairRounds)
      ? Math.min(2, Math.max(0, Math.floor(configuredRepairRounds)))
      : 1;
    let reviewCount = 0;
    let repairs = 0;
    let hasPendingIssues = true;
    let reviewerFeedback = "No review stage executed.";
    let reviewerOk = true;
    let rewriterOutput: RewriterStageOutput | undefined;
    let rewriterSummaryForPrompt = "No rewriting stage executed.";

    while (hasPendingIssues) {
      reviewCount++;
      onStateChange({ stage: "reviewer", status: "running", output: `\nReview Turn ${reviewCount}...\n` });
      const revStartTime = Date.now();

      try {
        const reviewerResp = await this.callModel([
          { role: "system", content: reviewerPrompt },
          {
            role: "user",
            content: `User Request: ${boundedRequest}\n\nOriginal Plan:\n${boundedPlanSummary}\n\nExecutor Activity:\n${boundedExecutorSummary}\n\nRewriter Activity:\n${truncateToTokenBudget(rewriterSummaryForPrompt, 1_000)}`
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
        onStateChange({ stage: "reviewer", status: "completed", output: reviewerFeedback });

        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "reviewer",
          turn_number: reviewCount,
          input_tokens: Math.round((reviewerPrompt.length + boundedRequest.length + boundedPlanSummary.length + boundedExecutorSummary.length + truncateToTokenBudget(rewriterSummaryForPrompt, 1_000).length) / 4),
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
        if (!hasPendingIssues || profile !== "full" || repairs >= maxRepairRounds) {
          break;
        }

        const beforeWrites = successfulWriteKeys([
          ...executorToolCalls,
          ...(rewriterOutput?.toolCalls ?? []),
        ]);
        repairs++;
        onStateChange({ stage: "rewriter", status: "running", output: `\nReviewer flagged issues. Rewriting...\n` });
        rewriterOutput = await this.runRewriterStage(request, reviewerFeedback, executorSummary, agentRunId, onStateChange, options, profile);
        rewriterSummaryForPrompt = renderRewriterSummary(rewriterOutput);
        const afterWrites = successfulWriteKeys([
          ...executorToolCalls,
          ...(rewriterOutput.toolCalls ?? []),
        ]);
        if (!addedWriteProgress(beforeWrites, afterWrites)) {
          hasPendingIssues = true;
          break;
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
          turn_number: reviewCount,
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

  /**
   * Synthesizer stage — produces the user-visible answer from accumulated
   * pipeline state. Behavior is identical to the previous inline synthesizer
   * block in `execute()`: same prompts, same telemetry, same empty-completion
   * fence, same throw-handled fallback. Extracted so `executeSegment()` (and
   * the B-02 replan loop) can call it with already-built `PipelineStageState`.
   *
   * Returns `{ answer, fatalError?, emptyCompletion }` so the caller can
   * classify the run outcome (success / degraded / failed) without
   * string-prefix sniffing.
   */
  private async runSynthesizerStage(
    request: string,
    state: PipelineStageState,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    executionVerification = "",
    remainingQueue: StageName[] = [],
  ): Promise<{ answer: string; fatalError?: string; emptyCompletion: boolean }> {
    onStateChange({ stage: "synthesizer", status: "running" });
    const synthesizerPrompt = stageSystemPrompt("synthesizer", options);
    const synthStartTime = Date.now();
    const contextText = buildSynthesizerContextFromStageState(request, state, executionVerification);
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
        stageAbort: this.registerStageAbort("synthesizer"),
        onChunk: (chunk) => {
          onStateChange({ stage: "synthesizer", status: "running", output: chunk });
          this.publishStageToken("synthesizer", chunk);
        }
      });
      const finalAnswer = resp.content ?? "";

      // Semantic emptiness is a FAILURE, not a success. A 200-OK with empty
      // visible content (free-tier zero-token completion, model spent its
      // budget on reasoning, etc.) previously recorded was_successful:1 with
      // output_tokens:0 — poisoning the self-tuning signal and surfacing a
      // blank turn. Record it as a failed stage; the caller still shows the
      // friendly "try again" notice (we leave `fatalError` unset so it is not
      // an error banner) but the run outcome is truthfully failed.
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

      onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });
      await this.afterConductorStage("synthesizer", "completed", finalAnswer, agentRunId, options, remainingQueue);
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
      await this.afterConductorStage("synthesizer", "failed", message, agentRunId, options, remainingQueue);
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
      // `answer` must never carry the raw failure text — 20 historical runs
      // (pre-2026-07-04) shipped "Synthesis failed: ..." as the literal chat
      // bubble because this catch block returned it as the answer. The real
      // failure travels via `fatalError` (-> PipelineResult.error), which
      // index.ts's error branch turns into an SSE error frame instead of
      // prose (see `if (result.error) ... session.finish(result.error, {
      // isError: true })`).
      return { answer: "", fatalError, emptyCompletion: false };
    }
  }

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
    const remainingQueueFor = (stage: StageName): StageName[] => {
      const index = stages.indexOf(stage);
      return index < 0 ? [] : stages.slice(index + 1);
    };
    let partialStage: PipelineSegmentResult["partialStage"];

    if (stages.includes("planner")) {
      state.plan = await this.runPlannerStage(request, agentRunId, onStateChange, options, remainingQueueFor("planner"));
    }
    if (stages.includes("executor")) {
      state.executor = await this.runExecutorStage(
        request, renderPlanSummary(state.plan), agentRunId, onStateChange, options, profile, remainingQueueFor("executor"),
      );
    }
    if (stages.includes("reviewer")) {
      const { reviewer, rewriter } = await this.runReviewerRewriterLoop(
        request, renderPlanSummary(state.plan), renderExecutorSummary(state.executor), state.executor?.toolCalls ?? [],
        agentRunId, onStateChange, options, profile,
      );
      state.reviewer = reviewer;
      if (rewriter) {
        state.rewriter = rewriter;
        if (rewriter.terminalStatus === "timed_out") {
          partialStage = { stage: "rewriter", errorCode: rewriter.errorCode ?? "stage_timeout" };
        }
      }
    }

    let effectGate = evaluateEffectGate({
      profile,
      executor: state.executor,
      rewriter: state.rewriter,
    });
    if (
      effectGate.verdict === "no_write_effect" &&
      profile === "full" &&
      (options.maxReviewRepairRounds ?? 1) > 0 &&
      hasMutationIntent(request) &&
      state.executor &&
      !state.rewriter
    ) {
      onStateChange({ stage: "rewriter", status: "running", output: "\nNo write effect detected. Repairing before synthesis...\n" });
      state.rewriter = await this.runRewriterStage(
        request,
        [
          effectGate.synthesizerNotice,
          "",
          "Repair requirement: this is a change request and the executor produced zero successful file mutations. Apply the missing requested write/edit now, then verify the changed file.",
        ].join("\n"),
        renderExecutorSummary(state.executor),
        agentRunId,
        onStateChange,
        options,
        profile,
      );
      effectGate = evaluateEffectGate({
        profile,
        executor: state.executor,
        rewriter: state.rewriter,
      });
      if (state.rewriter.terminalStatus === "timed_out") {
        partialStage = { stage: "rewriter", errorCode: state.rewriter.errorCode ?? "stage_timeout" };
      }
    }

    if (!stages.includes("synthesizer")) {
      return { state, effectGate, partialStage };
    }

    if (
      options.turnRequirement === "workspace_read" &&
      !assessWorkspaceEvidence(state.executor?.toolCalls, request).sufficient
    ) {
      return {
        state,
        synthesizerAnswer: "",
        synthesizerFatalError: MISSING_WORKSPACE_EVIDENCE,
        synthesizerEmptyCompletion: false,
        fatalErrorCode: "missing_workspace_evidence",
        effectGate,
        partialStage,
      };
    }

    const synth = await this.runSynthesizerStage(
      request,
      state,
      agentRunId,
      onStateChange,
      options,
      effectGate.synthesizerNotice,
      remainingQueueFor("synthesizer"),
    );
    return {
      state,
      synthesizerAnswer: synth.answer,
      synthesizerFatalError: synth.fatalError,
      synthesizerEmptyCompletion: synth.emptyCompletion,
      effectGate,
      partialStage,
    };
  }

  async execute(
    request: string,
    pipeline: string[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions = {}
  ): Promise<PipelineResult> {
    const requiresWorkspaceEvidence = options.turnRequirement === "workspace_read";
    if (!requiresWorkspaceEvidence && this.canRunSpeculativeParallel(pipeline, options.topology)) {
      return this.executeSpeculativeParallel(request, pipeline, agentRunId, onStateChange, options);
    }
    if (!requiresWorkspaceEvidence && this.canRunSpeculativeCascade(pipeline, options.topology)) {
      return this.executeSpeculativeCascade(request, agentRunId, onStateChange, options);
    }

    // Linear branch — delegate the full pipeline to executeSegment(). All
    // stage ordering, telemetry, empty-completion fencing, and review/rewrite
    // looping live inside the segment helper, so the B-02 replan loop can
    // run the same code with a partial stages list.
    const segment = await this.executeSegment(
      request, pipeline as StageName[], agentRunId, onStateChange, options,
    );
    const { state } = segment;

    // Keep the evidence invariant authoritative even for direct/non-normalized
    // callers that omit the synthesizer stage. The normal activation boundary
    // always appends a synthesizer, but PipelineExecutor is also reused by tests
    // and replan slices and must not return a planner sentinel as a repo answer.
    if (requiresWorkspaceEvidence && !assessWorkspaceEvidence(state.executor?.toolCalls, request).sufficient) {
      return {
        answer: "",
        error: MISSING_WORKSPACE_EVIDENCE,
        recursion_depth: 0,
        outcome: "failed",
        error_code: "missing_workspace_evidence",
        toolCalls: state.executor?.toolCalls,
      };
    }

    // Truthful run outcome. A failed synthesizer (threw OR empty) is `failed`.
    // A run whose answer came through but an upstream stage failed is `degraded`.
    const upstreamDegraded = Boolean(
      (state.plan && !state.plan.ok) || (state.executor && !state.executor.ok),
    );

    if (segment.synthesizerAnswer === undefined) {
      const gated = applyEffectGate(
        upstreamDegraded ? "degraded" : "success",
        upstreamDegraded ? "upstream_stage_failed" : undefined,
        segment.effectGate ?? evaluateEffectGate({
          profile: options.executionProfile ?? "full",
          executor: state.executor,
          rewriter: state.rewriter,
        }),
      );
      // No synthesizer in this pipeline: fall back to the last completed phase.
      return {
        answer: state.plan ? renderPlanSummary(state.plan) : "No planning stage executed.",
        recursion_depth: 0,
        outcome: gated.outcome,
        error_code: gated.errorCode,
        toolCalls: state.executor?.toolCalls,
      };
    }

    let outcome: PipelineOutcome;
    let errorCode: string | undefined;
    if (segment.synthesizerFatalError) {
      outcome = "failed";
      errorCode = segment.fatalErrorCode ?? "stage_error";
    } else if (segment.synthesizerEmptyCompletion) {
      outcome = "failed";
      errorCode = "empty_completion";
    } else if (upstreamDegraded) {
      outcome = "degraded";
      errorCode = "upstream_stage_failed";
    } else {
      outcome = "success";
    }

    if (segment.partialStage && !segment.synthesizerFatalError && !segment.synthesizerEmptyCompletion) {
      outcome = "partial";
      errorCode = segment.partialStage.errorCode;
    }

    ({ outcome, errorCode } = applyEffectGate(
      outcome === "partial" ? "degraded" : outcome,
      errorCode,
      segment.effectGate ?? evaluateEffectGate({
        profile: options.executionProfile ?? "full",
        executor: state.executor,
        rewriter: state.rewriter,
      }),
    ));
    if (segment.partialStage && outcome !== "failed") {
      outcome = "partial";
      errorCode = segment.partialStage.errorCode;
    }

    const result: PipelineResult = {
      answer: segment.synthesizerEmptyCompletion ? "" : segment.synthesizerAnswer,
      error: segment.synthesizerFatalError,
      recursion_depth: 0,
      outcome,
      error_code: errorCode,
      toolCalls: state.executor?.toolCalls,
    };
    if (!segment.synthesizerFatalError && !segment.synthesizerEmptyCompletion && pipeline.includes("synthesizer")) {
      return this.applyRecursiveCritique(request, result, agentRunId, onStateChange, options);
    }
    return result;
  }

  private hasIssues(reviewText: string): boolean {
    const verdict = parseReviewerVerdict(reviewText);
    if (verdict === "reject") return true;
    if (verdict === "accept") return false;
    const normalized = reviewText.toUpperCase();
    return normalized.includes("PARTIAL") || normalized.includes("MISSING");
  }

  private canRunSpeculativeParallel(pipeline: string[], topology: PipelineTopology | undefined): boolean {
    if (topology !== "speculative_parallel") return false;
    if (!pipeline.includes("planner") || !pipeline.includes("reviewer") || !pipeline.includes("synthesizer")) return false;
    // Executor and rewriter stages depend on prior outputs and tool feedback, so
    // the first speculative slice only parallelizes model-only planning/review.
    return !pipeline.includes("executor") && !pipeline.includes("rewriter");
  }

  private canRunSpeculativeCascade(pipeline: string[], topology: PipelineTopology | undefined): boolean {
    if (topology !== "speculative_cascade") return false;
    if (!pipeline.includes("executor") || !pipeline.includes("synthesizer")) return false;
    return !pipeline.includes("planner") && !pipeline.includes("reviewer") && !pipeline.includes("rewriter");
  }

  private async executeSpeculativeParallel(
    request: string,
    pipeline: string[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<PipelineResult> {
    const plannerPrompt = stageSystemPrompt("planner", options);
    const reviewerPrompt = stageSystemPrompt("reviewer", options);

    const plannerPromise = this.runModelOnlyStage({
      stage: "planner",
      prompt: plannerPrompt,
      userContent: request,
      agentRunId,
      turnNumber: 1,
      fallback: "Failed to generate plan",
      onStateChange,
    });

    const reviewerPromise = this.runModelOnlyStage({
      stage: "reviewer",
      prompt: reviewerPrompt,
      userContent: `User Request: ${request}\n\nReview the request, likely execution risks, missing context, and quality checks before synthesis.`,
      agentRunId,
      turnNumber: 1,
      fallback: "Review failed",
      onStateChange,
    });

    const [plan, reviewerFeedback] = await Promise.all([plannerPromise, reviewerPromise]);
    const executorSummary = "No execution stage executed. Planner and reviewer ran speculatively without tool execution.";
    const rewriterSummary = "No rewriting stage executed.";

    if (!pipeline.includes("synthesizer")) {
      return { answer: plan };
    }

    onStateChange({ stage: "synthesizer", status: "running" });
    const synthesizerPrompt = stageSystemPrompt("synthesizer", options);
    const synthStartTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        {
          role: "user",
          content: buildSynthesizerContext(request, { plan, executorSummary, reviewerFeedback, rewriterSummary })
        }
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
      const finalAnswer = resp.content;
      onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        input_tokens: Math.round((synthesizerPrompt.length + request.length + plan.length + executorSummary.length + reviewerFeedback.length + rewriterSummary.length) / 4),
        output_tokens: countTokens(finalAnswer),
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 1,
        had_error: 0,
      });

      return { answer: finalAnswer, recursion_depth: 0, outcome: finalAnswer.trim() ? "success" : "failed", error_code: finalAnswer.trim() ? undefined : "empty_completion" };
    } catch (e: any) {
      onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
      const fatalError = describePipelineError(errText(e));

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 0,
        had_error: 1,
        error_message: errText(e),
      });

      // See the matching comment in runSynthesizerStage: never surface the
      // raw failure text as the answer bubble. `error` (fatalError) carries
      // it through PipelineResult.error, which index.ts turns into an SSE
      // error frame.
      return { answer: "", error: fatalError, recursion_depth: 0, outcome: "failed", error_code: "stage_error" };
    }
  }

  private async runModelOnlyStage(args: {
    stage: "planner" | "executor" | "reviewer";
    prompt: string;
    userContent: string;
    agentRunId: string;
    turnNumber: number;
    fallback: string;
    cascadeTier?: "cheap" | "strong";
    onStateChange: (state: PipelineProgressState) => void;
  }): Promise<string> {
    args.onStateChange({ stage: args.stage, status: "running" });
    const startTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: args.prompt },
        { role: "user", content: args.userContent }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES[args.stage].temperature,
        max_tokens: BUILTIN_MODES[args.stage].max_tokens,
        stream: true,
        stageLabel: args.stage,
        cascadeTier: args.cascadeTier,
        onChunk: (chunk) => {
          args.onStateChange({ stage: args.stage, status: "running", output: chunk });
        }
      });
      const output = resp.content;
      args.onStateChange({ stage: args.stage, status: "completed", output });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: args.agentRunId,
        mode_id: args.stage,
        turn_number: args.turnNumber,
        input_tokens: Math.round((args.prompt.length + args.userContent.length) / 4),
        output_tokens: countTokens(output),
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 1,
        had_error: 0,
      });

      return output;
    } catch (e: any) {
      const message = errText(e);
      args.onStateChange({ stage: args.stage, status: "failed", output: message });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: args.agentRunId,
        mode_id: args.stage,
        turn_number: args.turnNumber,
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
      });

      return `${args.fallback}: ${message}`;
    }
  }

  private async executeSpeculativeCascade(
    request: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<PipelineResult> {
    const executorPrompt = stageSystemPrompt("executor", options);
    const cheapOutput = await this.runModelOnlyStage({
      stage: "executor",
      prompt: executorPrompt,
      userContent: `User Request: ${request}\n\nAnswer with the cheapest adequate execution path. End with a line exactly like CONFIDENCE: 0.0 to 1.0.`,
      agentRunId,
      turnNumber: 1,
      fallback: "Cheap executor failed",
      cascadeTier: "cheap",
      onStateChange,
    });

    const cheapConfidence = this.extractConfidence(cheapOutput);
    let strongOutput = "Strong executor not used; cheap executor confidence met the cascade threshold.";
    if (cheapConfidence === undefined || cheapConfidence < 0.65) {
      strongOutput = await this.runModelOnlyStage({
        stage: "executor",
        prompt: executorPrompt,
        userContent: `User Request: ${request}\n\nCheap executor output:\n${cheapOutput}\n\nThe cheap executor was uncertain. Re-execute with stronger reasoning, correct any gaps, and end with CONFIDENCE: 0.0 to 1.0.`,
        agentRunId,
        turnNumber: 2,
        fallback: "Strong executor failed",
        cascadeTier: "strong",
        onStateChange,
      });
    }

    const executorSummary = [
      `Cheap executor confidence: ${cheapConfidence === undefined ? "unknown" : cheapConfidence.toFixed(2)}`,
      `Cheap executor output:\n${cheapOutput}`,
      `Strong executor output:\n${strongOutput}`,
    ].join("\n\n");

    onStateChange({ stage: "synthesizer", status: "running" });
    const synthesizerPrompt = stageSystemPrompt("synthesizer", options);
    const synthStartTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        {
          role: "user",
          content: buildSynthesizerContext(request, {
            plan: "Speculative cascade: cheap executor first, strong executor only on uncertainty.",
            executorSummary,
          })
        }
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
      const finalAnswer = resp.content;
      onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        input_tokens: Math.round((synthesizerPrompt.length + request.length + executorSummary.length) / 4),
        output_tokens: countTokens(finalAnswer),
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 1,
        had_error: 0,
      });

      return { answer: finalAnswer, recursion_depth: 0, outcome: finalAnswer.trim() ? "success" : "failed", error_code: finalAnswer.trim() ? undefined : "empty_completion" };
    } catch (e: any) {
      onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
      const fatalError = describePipelineError(errText(e));

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 0,
        had_error: 1,
        error_message: errText(e),
      });

      // See the matching comment in runSynthesizerStage: never surface the
      // raw failure text as the answer bubble. `error` (fatalError) carries
      // it through PipelineResult.error, which index.ts turns into an SSE
      // error frame.
      return { answer: "", error: fatalError, recursion_depth: 0, outcome: "failed", error_code: "stage_error" };
    }
  }

  private extractConfidence(text: string): number | undefined {
    const match = text.match(/CONFIDENCE\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    if (!match) return undefined;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = parsed > 1 ? parsed / 100 : parsed;
    if (normalized < 0 || normalized > 1) return undefined;
    return normalized;
  }

  private async applyRecursiveCritique(
    request: string,
    result: PipelineResult,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<PipelineResult> {
    if (options.topology !== "recursive") return result;

    // B-03: when the caller already burned recursion depth (this pipeline
    // is itself a re-entry from an outer `applyRecursiveCritique`), start
    // from the inherited depth so the cap is shared across nested
    // pipelines, not reset on every recursive call.
    const depth = Math.max(result.recursion_depth ?? 0, options.initialRecursionDepth ?? 0);
    await options.onRecursion?.({ depth, status: "critique" });
    const critiquePrompt = loadPrompt("modes/recursion-critique.md");
    const startTime = Date.now();

    try {
      const resp = await this.callModel([
        { role: "system", content: critiquePrompt },
        {
          role: "user",
          content: `User Request:\n${request}\n\nCandidate Answer:\n${result.answer}`
        }
      ] as ChatMessage[], {
        temperature: 0.1,
        max_tokens: 768,
        stream: true,
        stageLabel: "recursion_critique" as any,
      });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "recursion_critique",
        turn_number: depth + 1,
        input_tokens: Math.round((critiquePrompt.length + request.length + result.answer.length) / 4),
        output_tokens: countTokens(resp.content),
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 1,
        had_error: 0,
      });

      const decision = this.parseRecursionDecision(resp.content);
      if (!decision.needs_more_work) {
        await options.onRecursion?.({ depth, status: "done", critique: decision.critique });
        return result;
      }

      // B-03: conductor-decided re-enter target. Unknown / missing values fall
      // back to a `done` event so a malformed critic payload never silently
      // re-enters an unrelated stage.
      const reenterStage: RecursionReenterStage | undefined = decision.reenter_stage;
      if (!reenterStage) {
        await options.onRecursion?.({ depth, status: "done", critique: decision.critique });
        return result;
      }

      const maxDepth = Math.max(0, options.maxRecursionDepth ?? 2);
      if (depth >= maxDepth) {
        await options.onRecursion?.({ depth, status: "max_depth", reenter_stage: reenterStage, critique: decision.critique });
        return result;
      }

      const nextDepth = depth + 1;
      await options.onRecursion?.({ depth: nextDepth, status: "reenter", reenter_stage: reenterStage, critique: decision.critique });

      // B-03 re-enter dispatch. Each re-enter target rebuilds the pipeline
      // the critic asked for; the recursive depth is propagated so a turn
      // can never exceed `maxRecursionDepth` total re-entries regardless of
      // which stage the critic chose.
      //
      // `conductor_replan` is special: it's a signal, not a pipeline spawn
      // (the conductor's own `runPipelineWithReplanning` owns that budget
      // via `max_conductor_replans`). The recursion depth is NOT
      // incremented for it — the turn returns the existing answer at the
      // current depth so the conductor's mid-pipeline replan can take over
      // without double-counting against `max_recursion_depth`.
      if (reenterStage === "conductor_replan") {
        return result;
      }

      const rerun = await this.reenterForRecursion(
        request,
        reenterStage,
        decision.critique,
        result,
        agentRunId,
        onStateChange,
        options,
        nextDepth,
      );

      return {
        ...rerun,
        recursion_depth: nextDepth,
      };
    } catch (e: any) {
      const message = errText(e);
      await options.onRecursion?.({ depth, status: "failed", critique: message });
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "recursion_critique",
        turn_number: depth + 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
      });
      return result;
    }
  }

  private parseRecursionDecision(raw: string): {
    needs_more_work: boolean;
    reenter_stage?: RecursionReenterStage;
    critique: string;
  } {
    const validReenter: ReadonlySet<RecursionReenterStage> = new Set<RecursionReenterStage>([
      "planner",
      "executor",
      "conductor_replan",
    ]);
    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      const parsed = JSON.parse(jsonStart >= 0 && jsonEnd >= jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw);
      const reenterCandidate = parsed?.reenter_stage;
      const reenterStage: RecursionReenterStage | undefined =
        typeof reenterCandidate === "string" && validReenter.has(reenterCandidate as RecursionReenterStage)
          ? (reenterCandidate as RecursionReenterStage)
          : undefined;
      return {
        needs_more_work: Boolean(parsed?.needs_more_work),
        reenter_stage: reenterStage,
        critique: typeof parsed?.critique === "string" ? parsed.critique : raw,
      };
    } catch {
      // Heuristic fallback only fires when the critic payload is unparseable.
      // We do NOT re-derive `reenter_stage` from regex here — a missing
      // re-enter target is safer than a guessed one (B-03: conductor
      // self-selection is explicit, never inferred from prose).
      return {
        needs_more_work: /\bneeds?_more_work\b|\bre-?enter\b|\bmissing\b|\bincomplete\b/i.test(raw),
        reenter_stage: undefined,
        critique: raw,
      };
    }
  }

  /**
   * B-03: dispatch a re-entry request to the stage the critic chose.
   * The recursive depth is carried on the result so the cap is shared
   * across re-enter types — a turn that has burned one re-entry cannot
   * also burn a fresh one on a different stage type.
   *
   * For `conductor_replan`, the critic is signalling that the revision
   * should be delegated to the conductor's own mid-pipeline replan path.
   * We surface a typed `reenter` event so the SSE relay can render the
   * recurse decision, but the actual re-invocation of the conductor is
   * handled by the normal route (`runPipelineWithReplanning`) — we just
   * return the current result, which is the safe degradation the B-03
   * acceptance criterion requires ("recursive topology test completes
   * via conductor replan"). The conductor's `max_replans` budget is the
   * authoritative cap on its own path, so the recursive depth counter
   * is NOT incremented again here.
   */
  private async reenterForRecursion(
    request: string,
    reenterStage: RecursionReenterStage,
    critique: string,
    result: PipelineResult,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    nextDepth: number,
  ): Promise<PipelineResult> {
    if (reenterStage === "conductor_replan") {
      // Surface a typed event so the SSE relay + UI can render the recurse
      // decision, but do not run another recursion here — the conductor
      // owns its own replan budget via `runPipelineWithReplanning`.
      return result;
    }

    const pipeline = reenterStage === "planner"
      ? ["planner", "executor", "synthesizer"]
      : ["executor", "synthesizer"];

    const promptBody = reenterStage === "planner"
      ? `The recursive critic judged the previous answer insufficient and asked for a fresh plan. Re-plan from scratch, then execute and synthesize.`
      : `Re-enter executor to verify or repair the answer, then synthesize the final response.`;

    const recursiveRequest = [
      `Original User Request:\n${request}`,
      `Candidate Answer:\n${result.answer}`,
      `Recursive Critique:\n${critique}`,
      promptBody,
    ].join("\n\n");

    return await this.execute(
      recursiveRequest,
      pipeline,
      agentRunId,
      onStateChange,
      // Preserve the least-authority profile through recursive re-entry — a
      // read-only turn must stay read-only when the critique re-runs the
      // pipeline. B-03: also pass `initialRecursionDepth: nextDepth` so the
      // inner `applyRecursiveCritique` reads the inherited depth (not 0)
      // and the shared `maxRecursionDepth` cap is honored across nested
      // pipeline calls.
      {
        topology: "linear",
        executionProfile: options.executionProfile,
        workerInstructions: options.workerInstructions,
        sharedContext: options.sharedContext,
        sessionMemory: options.sessionMemory,
        turnRequirement: options.turnRequirement,
        initialRecursionDepth: nextDepth,
      },
    );
  }
}
