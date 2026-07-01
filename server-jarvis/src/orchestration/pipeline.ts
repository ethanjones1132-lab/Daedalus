import { loadPrompt } from "./prompt-loader";
import { BUILTIN_MODES, getToolsForMode } from "./modes";
import type { ToolRuntime, ExecutionContext } from "../tool-runtime";
import type { CallModelFn, ChatMessage } from "./router";
import type { SharedContextHints, StageName, WorkerInstructions } from "./coordinator";
import type { SessionMemory } from "./session-memory";
import { resolveStagePrompt, stagePromptFile } from "./worker-prompt";
import type { ToolCall, ToolResult } from "../tool-types";
import { outcomeCollector } from "../self-tuning/mod";
import type { StageRun } from "../self-tuning/store";
import { countTokens } from "../tokens";
import { buildSynthesizerContext, buildSynthesizerContextFromStageState } from "./synth-context";
import type { ExecutionProfile } from "./route-normalization";
import type { PipelineStageState, PlannerStageOutput, ExecutorStageOutput, ReviewerStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";
import { renderExecutorSummary, renderPlanSummary, renderReviewerSummary, renderRewriterSummary } from "./stage-output";

/**
 * The slice of the outcome collector the pipeline depends on. Injecting this
 * (rather than importing the global singleton) lets tests pass an in-memory
 * collector so `bun test` can never pollute the production self-tuning DB.
 */
export interface StageRunRecorder {
  recordStageRun(stage: StageRun): void;
}

export interface PipelineProgressState {
  stage: "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer";
  status: "running" | "done" | "failed";
  output?: string;
}

export type PipelineTopology = "linear" | "speculative_parallel" | "speculative_cascade" | "recursive";

export interface PipelineExecuteOptions {
  topology?: PipelineTopology;
  maxRecursionDepth?: number;
  onRecursion?: (event: PipelineRecursionEvent) => void | Promise<void>;
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
}

const READ_CACHE_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "web_fetch"]);

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

export interface PipelineRecursionEvent {
  depth: number;
  status: "critique" | "reenter" | "max_depth" | "done" | "failed";
  reenter_stage?: "executor";
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
export type PipelineOutcome = "success" | "degraded" | "failed";

export interface PipelineResult {
  answer: string;
  error?: string;
  recursion_depth?: number;
  /** Truthful run outcome. Absent is treated as "success" by legacy callers. */
  outcome?: PipelineOutcome;
  /** Machine-readable failure reason (e.g. "empty_completion", "auth_401"). */
  error_code?: string;
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
  constructor(
    private callModel: CallModelFn,
    private runtime: ToolRuntime,
    private ctx: ExecutionContext,
    // Injected so tests can supply an in-memory collector. Defaults to the
    // global production singleton for the live runtime.
    private collector: StageRunRecorder = outcomeCollector
  ) {}

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
              toolCalls.push({
                name: tc.name,
                arguments: (tc as any).arguments ?? {},
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

  async execute(
    request: string,
    pipeline: string[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions = {}
  ): Promise<PipelineResult> {
    if (this.canRunSpeculativeParallel(pipeline, options.topology)) {
      return this.executeSpeculativeParallel(request, pipeline, agentRunId, onStateChange, options);
    }
    if (this.canRunSpeculativeCascade(pipeline, options.topology)) {
      return this.executeSpeculativeCascade(request, agentRunId, onStateChange, options);
    }

    let reviewerFeedback = "No review stage executed.";
    let rewriterSummary = "No rewriting stage executed.";

    // Least-authority tool profile for executor/rewriter. `full` keeps the legacy
    // behavior; `read_only` caps a workspace-read turn to read-only tools so a
    // misclassified read can never mutate the workspace.
    const profile: ExecutionProfile = options.executionProfile ?? "full";

    // 1. Planner Stage
    let state: PipelineStageState = {};
    if (pipeline.includes("planner")) {
      state.plan = await this.runPlannerStage(request, agentRunId, onStateChange, options);
    }
    // Compatibility shim — the executor/reviewer/synthesizer blocks below
    // still reference the old `plan` string. This re-derives it from the
    // structured state via the canonical renderer. Deleted in A6 once
    // every block is migrated to read `state` directly.
    const plan = renderPlanSummary(state.plan);

    // 2. Executor Stage
    if (pipeline.includes("executor")) {
      state.executor = await this.runExecutorStage(request, plan, agentRunId, onStateChange, options, profile);
    }
    // Compatibility shim — the reviewer/synthesizer blocks below still
    // reference the old `executorSummary` string. Re-derived from the
    // structured state via the canonical renderer. Deleted in A6 once
    // every block is migrated to read `state` directly.
    const executorSummary = renderExecutorSummary(state.executor);

    // 3. Reviewer & Rewriter Correction Loop
    if (pipeline.includes("reviewer")) {
      const reviewerPrompt = stageSystemPrompt("reviewer", options);
      const rewriterPrompt = stageSystemPrompt("rewriter", options);
      let loopCount = 0;
      const maxLoops = 3;
      let hasPendingIssues = true;

      while (hasPendingIssues && loopCount < maxLoops) {
        loopCount++;
        onStateChange({ stage: "reviewer", status: "running", output: `\nReview Turn ${loopCount}...\n` });
        const revStartTime = Date.now();

        try {
          const reviewerResp = await this.callModel([
            { role: "system", content: reviewerPrompt },
            {
              role: "user",
              content: `User Request: ${request}\n\nOriginal Plan:\n${plan}\n\nExecutor Activity:\n${executorSummary}\n\nRewriter Activity:\n${rewriterSummary}`
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
            input_tokens: Math.round((reviewerPrompt.length + request.length + plan.length + executorSummary.length + rewriterSummary.length) / 4),
            output_tokens: countTokens(reviewerFeedback),
            tool_calls_json: "[]",
            duration_ms: Date.now() - revStartTime,
            was_successful: 1,
            had_error: 0,
          });

          hasPendingIssues = this.hasIssues(reviewerFeedback);
          if (hasPendingIssues) {
            onStateChange({ stage: "rewriter", status: "running", output: `\nReviewer flagged issues. Rewriting...\n` });
            const rewriterMessages: ChatMessage[] = [
              { role: "system", content: rewriterPrompt },
              {
                role: "user",
                content: `User Request: ${request}\n\nReviewer Feedback:\n${reviewerFeedback}\n\nExecutor Activity:\n${executorSummary}`
              }
            ];

            let rewriterDone = false;
            let rewriterTurn = 0;
            const maxRewriterTurns = BUILTIN_MODES.rewriter.max_turns;

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

                rewriterMessages.push({
                  role: "assistant",
                  content: rewriteResp.content,
                  tool_calls: rewriteResp.tool_calls
                });

                if (rewriteResp.tool_calls && rewriteResp.tool_calls.length > 0) {
                  for (const tc of rewriteResp.tool_calls) {
                    const toolResult = await this.runToolCall(tc, options);
                    rewriterMessages.push({
                      role: "tool",
                      tool_call_id: tc.id,
                      name: tc.name,
                      content: toolResult.output
                    });
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

            rewriterSummary = rewriterMessages
              .filter((m) => m.role !== "system")
              .map((m) => {
                if (m.role === "assistant" && m.content) {
                  return `[Rewriter]: ${m.content}`;
                }
                if (m.role === "tool") {
                  return `[Tool Call Result (${m.name})]: ${m.content.slice(0, 1000)}${m.content.length > 1000 ? "..." : ""}`;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n\n");

            onStateChange({ stage: "rewriter", status: "done", output: rewriterSummary });
          }
        } catch (e: any) {
          onStateChange({ stage: "reviewer", status: "failed", output: errText(e) });
          hasPendingIssues = false; // abort review loop on error

          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "reviewer",
            turn_number: loopCount,
            tool_calls_json: "[]",
            duration_ms: Date.now() - revStartTime,
            was_successful: 0,
            had_error: 1,
            error_message: errText(e),
          });
        }
      }
    }

    // 4. Synthesizer Stage
    let finalAnswer = "";
    let fatalError: string | undefined;
    let emptyCompletion = false;
    if (pipeline.includes("synthesizer")) {
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
        finalAnswer = resp.content ?? "";

        // Semantic emptiness is a FAILURE, not a success. A 200-OK with empty
        // visible content (free-tier zero-token completion, model spent its
        // budget on reasoning, etc.) previously recorded was_successful:1 with
        // output_tokens:0 — poisoning the self-tuning signal and surfacing a
        // blank turn. Record it as a failed stage; the caller still shows the
        // friendly "try again" notice (we leave `fatalError` unset so it is not
        // an error banner) but the run outcome is truthfully failed.
        if (!finalAnswer.trim()) {
          emptyCompletion = true;
          onStateChange({ stage: "synthesizer", status: "failed", output: "(empty completion)" });
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "synthesizer",
            turn_number: 1,
            input_tokens: Math.round((synthesizerPrompt.length + request.length + plan.length + executorSummary.length + reviewerFeedback.length + rewriterSummary.length) / 4),
            output_tokens: 0,
            tool_calls_json: "[]",
            duration_ms: Date.now() - synthStartTime,
            was_successful: 0,
            had_error: 1,
            error_message: "empty_completion",
          });
        } else {
          onStateChange({ stage: "synthesizer", status: "done", output: finalAnswer });
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
        }
      } catch (e: any) {
        onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
        // The synthesizer produces the turn's actual answer. If it threw, there
        // is no answer — record the failure so the caller emits an error frame
        // instead of passing "Synthesis failed: …" off as a successful result.
        fatalError = describePipelineError(errText(e));
        finalAnswer = `Synthesis failed: ${errText(e)}`;

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
      }
    } else {
      // Fallback: return the last completed phase output.
      finalAnswer = plan !== "No planning stage executed." ? plan : "No planning stage executed.";
    }

    // Truthful run outcome. A failed synthesizer (threw OR empty) is `failed`.
    // A run whose answer came through but an upstream stage failed is `degraded`.
    const upstreamDegraded =
      plan.startsWith("Failed to generate plan") || executorSummary.startsWith("Executor failed");
    let outcome: PipelineOutcome;
    let errorCode: string | undefined;
    if (fatalError) {
      outcome = "failed";
      errorCode = "stage_error";
    } else if (emptyCompletion) {
      outcome = "failed";
      errorCode = "empty_completion";
    } else if (upstreamDegraded) {
      outcome = "degraded";
      errorCode = "upstream_stage_failed";
    } else {
      outcome = "success";
    }

    const result: PipelineResult = {
      answer: emptyCompletion ? "" : finalAnswer,
      error: fatalError,
      recursion_depth: 0,
      outcome,
      error_code: errorCode,
    };
    if (!fatalError && !emptyCompletion && pipeline.includes("synthesizer")) {
      return this.applyRecursiveCritique(request, result, agentRunId, onStateChange, options);
    }
    return result;
  }

  private hasIssues(reviewText: string): boolean {
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
      onStateChange({ stage: "synthesizer", status: "done", output: finalAnswer });

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

      return { answer: `Synthesis failed: ${errText(e)}`, error: fatalError, recursion_depth: 0, outcome: "failed", error_code: "stage_error" };
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
      args.onStateChange({ stage: args.stage, status: "done", output });

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
      onStateChange({ stage: "synthesizer", status: "done", output: finalAnswer });

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

      return { answer: `Synthesis failed: ${errText(e)}`, error: fatalError, recursion_depth: 0, outcome: "failed", error_code: "stage_error" };
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

    const depth = result.recursion_depth ?? 0;
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

      if (decision.reenter_stage !== "executor") {
        await options.onRecursion?.({ depth, status: "done", critique: decision.critique });
        return result;
      }

      const maxDepth = Math.max(0, options.maxRecursionDepth ?? 2);
      if (depth >= maxDepth) {
        await options.onRecursion?.({ depth, status: "max_depth", reenter_stage: "executor", critique: decision.critique });
        return result;
      }

      const nextDepth = depth + 1;
      await options.onRecursion?.({ depth: nextDepth, status: "reenter", reenter_stage: "executor", critique: decision.critique });
      const recursiveRequest = [
        `Original User Request:\n${request}`,
        `Candidate Answer:\n${result.answer}`,
        `Recursive Critique:\n${decision.critique}`,
        "Re-enter executor to verify or repair the answer, then synthesize the final response.",
      ].join("\n\n");

      const rerun = await this.execute(
        recursiveRequest,
        ["executor", "synthesizer"],
        agentRunId,
        onStateChange,
        // Preserve the least-authority profile through recursive re-entry — a
        // read-only turn must stay read-only when the critique re-runs executor.
        {
          topology: "linear",
          executionProfile: options.executionProfile,
          workerInstructions: options.workerInstructions,
          sharedContext: options.sharedContext,
          sessionMemory: options.sessionMemory,
        },
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
    reenter_stage?: "executor";
    critique: string;
  } {
    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      const parsed = JSON.parse(jsonStart >= 0 && jsonEnd >= jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw);
      const reenterStage = parsed?.reenter_stage === "executor" ? "executor" : undefined;
      return {
        needs_more_work: Boolean(parsed?.needs_more_work),
        reenter_stage: reenterStage,
        critique: typeof parsed?.critique === "string" ? parsed.critique : raw,
      };
    } catch {
      return {
        needs_more_work: /\bneeds?_more_work\b|\bre-?enter\b|\bmissing\b|\bincomplete\b/i.test(raw),
        reenter_stage: /\bexecutor\b/i.test(raw) ? "executor" : undefined,
        critique: raw,
      };
    }
  }
}
