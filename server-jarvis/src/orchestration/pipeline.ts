import { loadPrompt } from "./prompt-loader";
import { BUILTIN_MODES, getToolsForMode } from "./modes";
import type { ToolRuntime, ExecutionContext } from "../tool-runtime";
import type { CallModelFn, ChatMessage } from "./router";
import { outcomeCollector } from "../self-tuning/mod";
import { countTokens } from "../tokens";
import type { ConductorBus, ConductorDirective } from "./conductor-bus";
import type { LiveConductor } from "./conductor";
import type { StageName } from "./coordinator";

export interface PipelineProgressState {
  stage: "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer";
  status: "running" | "done" | "failed";
  output?: string;
}

export interface ConductorWiring {
  bus: ConductorBus;
  live: LiveConductor;
}

export type PipelineTopology = "linear" | "speculative_parallel" | "speculative_cascade" | "recursive";

export interface PipelineExecuteOptions {
  topology?: PipelineTopology;
  maxRecursionDepth?: number;
  onRecursion?: (event: PipelineRecursionEvent) => void | Promise<void>;
  onDirective?: (directive: ConductorDirective, stage: StageName) => Promise<void> | void;
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
export interface PipelineResult {
  answer: string;
  error?: string;
  recursion_depth?: number;
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

export class PipelineExecutor {
  constructor(
    private callModel: CallModelFn,
    private runtime: ToolRuntime,
    private ctx: ExecutionContext,
    private conductor?: ConductorWiring
  ) {}

  async execute(
    request: string,
    pipeline: string[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions = {}
  ): Promise<PipelineResult> {
    if (this.canRunSpeculativeParallel(pipeline, options.topology)) {
      return this.executeSpeculativeParallel(request, pipeline, agentRunId, onStateChange);
    }
    if (this.canRunSpeculativeCascade(pipeline, options.topology)) {
      return this.executeSpeculativeCascade(request, agentRunId, onStateChange);
    }

    let plan = "No planning stage executed.";
    let executorSummary = "No execution stage executed.";
    let reviewerFeedback = "No review stage executed.";
    let rewriterSummary = "No rewriting stage executed.";

    // Conductor wiring: mutable queue and helpers (no-ops when conductor is absent)
    const remaining: StageName[] = [...pipeline].filter((s): s is StageName => s !== null && s !== undefined) as StageName[];
    const pendingInjections = new Map<StageName, string>();
    let conductorRerouted = false;

    const applyDirective = async (directive: ConductorDirective, completedStage: StageName): Promise<void> => {
      if (directive.type === "reroute") {
        remaining.length = 0;
        remaining.push(...directive.newRemaining);
        conductorRerouted = true;
      } else if (directive.type === "inject_context") {
        pendingInjections.set(directive.forStage, directive.note);
      } else if (directive.type === "abort_stage") {
        // Fire the bus-registered AbortController for the named stage.  The
        // stage must be currently registered (it always is when the conductor
        // observes an in-flight stage), but resolveAbort no-ops on unknown
        // stages so a misnamed directive degrades safely.
        this.conductor?.bus.resolveAbort(directive.stage);
      }
      // continue is a no-op (still recorded below for audit completeness —
      // skipping continue would leave a hole in the audit trail).
      if (options.onDirective && directive.type !== "continue") {
        await options.onDirective(directive, completedStage);
      }
      // Record to outcomeCollector so the run is replayable. Errors here must
      // not break the pipeline.
      try {
        const baseFields = {
          id: `dir_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          stage: completedStage,
          directive_type: directive.type,
          reason: undefined as string | undefined,
          new_remaining_json: undefined as string | undefined,
          inject_note: undefined as string | undefined,
          inject_for_stage: undefined as string | undefined,
        };
        if (directive.type === "reroute") {
          baseFields.reason = directive.reason;
          baseFields.new_remaining_json = JSON.stringify(directive.newRemaining);
        } else if (directive.type === "abort_stage") {
          baseFields.reason = directive.reason;
        } else if (directive.type === "inject_context") {
          baseFields.reason = directive.reason;
          baseFields.inject_note = directive.note;
          baseFields.inject_for_stage = directive.forStage;
        }
        outcomeCollector.recordDirective(baseFields);
      } catch (e) {
        console.warn(`[PipelineExecutor] recordDirective failed: ${errText(e)}`);
      }
    };

    /**
     * Register a stage-scoped AbortController on the bus so the conductor can
     * cancel this stage mid-stream (resolves to `bus.resolveAbort(stage)`).
     * Returns the signal for the caller to thread into `callOptions.stageAbort`.
     */
    const registerStageAbort = (stage: StageName): AbortSignal | undefined => {
      if (!this.conductor) return undefined;
      const ctrl = new AbortController();
      this.conductor.bus.registerAbortHandle(stage, ctrl);
      return ctrl.signal;
    };

    /**
     * Per-stage cumulative text length, used to populate
     * `stage_token.cumulativeLen` for the throttled bus publish. Reset per turn
     * (this map is created fresh on every execute() call).
     */
    const stageCumulativeLen = new Map<StageName, number>();

    /**
     * Helper invoked from a stage's onChunk callback. Increments the per-stage
     * cumulative length and publishes a throttled `stage_token` event to the
     * bus. Safe to call when no conductor is attached (no-op).
     */
    const publishToken = (stage: StageName, chunk: string): void => {
      if (!this.conductor) return;
      const next = (stageCumulativeLen.get(stage) ?? 0) + chunk.length;
      stageCumulativeLen.set(stage, next);
      this.conductor.bus.publishThrottled({
        type: "stage_token",
        stage,
        textDelta: chunk,
        cumulativeLen: next,
      });
    };

    const safeAfterStage = async (stage: StageName, outcome: "completed" | "failed", output: string): Promise<ConductorDirective> => {
      if (!this.conductor) return { type: "continue" };
      try {
        return await this.conductor.live.afterStage(stage, outcome, output, [...remaining]);
      } catch {
        return { type: "continue" };
      }
    };

    // 1. Planner Stage
    if (pipeline.includes("planner")) {
      onStateChange({ stage: "planner", status: "running" });
      const plannerPrompt = loadPrompt("modes/planner.md");
      const startTime = Date.now();
      this.conductor?.bus.publish({ type: "stage_started", stage: "planner", model: "", runId: agentRunId });
      try {
        const resp = await this.callModel([
          { role: "system", content: plannerPrompt },
          { role: "user", content: request }
        ] as ChatMessage[], {
          temperature: BUILTIN_MODES.planner.temperature,
          max_tokens: BUILTIN_MODES.planner.max_tokens,
          stream: true,
          stageLabel: "planner",
          stageAbort: registerStageAbort("planner"),
          onChunk: (chunk) => {
            onStateChange({ stage: "planner", status: "running", output: chunk });
            publishToken("planner", chunk);
          }
        });
        plan = resp.content;
        const plannerDurationMs = Date.now() - startTime;
        onStateChange({ stage: "planner", status: "done", output: plan });
        this.conductor?.bus.publish({ type: "stage_completed", stage: "planner", output: plan, tokens: countTokens(plan), durationMs: plannerDurationMs });

        outcomeCollector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "planner",
          turn_number: 1,
          input_tokens: Math.round((plannerPrompt.length + request.length) / 4),
          output_tokens: countTokens(plan),
          tool_calls_json: "[]",
          duration_ms: plannerDurationMs,
          was_successful: 1,
          had_error: 0,
        });

        const plannerDirective = await safeAfterStage("planner", "completed", plan);
        await applyDirective(plannerDirective, "planner");
      } catch (e: any) {
        const plannerDurationMs = Date.now() - startTime;
        onStateChange({ stage: "planner", status: "failed", output: errText(e) });
        plan = `Failed to generate plan: ${errText(e)}`;
        this.conductor?.bus.publish({ type: "stage_failed", stage: "planner", error: errText(e) });

        outcomeCollector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "planner",
          turn_number: 1,
          tool_calls_json: "[]",
          duration_ms: plannerDurationMs,
          was_successful: 0,
          had_error: 1,
          error_message: errText(e),
        });

        const plannerFailDirective = await safeAfterStage("planner", "failed", errText(e));
        await applyDirective(plannerFailDirective, "planner");
      }
    }

    // 2. Executor Stage
    if (pipeline.includes("executor") && (!conductorRerouted || remaining.includes("executor"))) {
      onStateChange({ stage: "executor", status: "running" });
      const executorPrompt = loadPrompt("modes/executor.md");
      const executorMessages: ChatMessage[] = [
        { role: "system", content: executorPrompt },
        { role: "user", content: `User Request: ${request}\n\nPlan:\n${plan}` }
      ];

      // Apply any injected context from conductor
      const executorInjection = pendingInjections.get("executor");
      if (executorInjection) {
        executorMessages[1] = { ...executorMessages[1], content: executorMessages[1].content + "\n\nAdditional context:\n" + executorInjection };
        pendingInjections.delete("executor");
      }

      let turnCount = 0;
      let executorDone = false;
      const maxTurns = BUILTIN_MODES.executor.max_turns;
      let executorTurn = 0;
      const executorStartTime = Date.now();

      this.conductor?.bus.publish({ type: "stage_started", stage: "executor", model: "", runId: agentRunId });

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
              tools: getToolsForMode("executor", this.runtime.listTools()),
              stream: true,
              stageLabel: "executor",
              stageAbort: registerStageAbort("executor"),
              onChunk: (chunk) => {
                onStateChange({ stage: "executor", status: "running", output: chunk });
                publishToken("executor", chunk);
              }
            });

            executorMessages.push({
              role: "assistant",
              content: response.content,
              tool_calls: response.tool_calls
            });

            if (response.tool_calls && response.tool_calls.length > 0) {
              for (const tc of response.tool_calls) {
                this.conductor?.bus.publish({ type: "tool_call_started", stage: "executor", name: tc.name, args: tc.arguments ?? {} });
                const toolResult = await this.runtime.execute(tc, this.ctx);
                this.conductor?.bus.publish({ type: "tool_result", stage: "executor", name: tc.name, isError: toolResult.is_error, summary: toolResult.output.slice(0, 200) });
                this.conductor?.live.onToolResult("executor", tc.name, toolResult.is_error, toolResult.output.slice(0, 200));
                executorMessages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  name: tc.name,
                  content: toolResult.output
                });
                onStateChange({
                  stage: "executor",
                  status: "running",
                  output: `\n[Tool Executed: ${tc.name}]\n`
                });
              }
            } else {
              executorDone = true;
            }

            outcomeCollector.recordStageRun({
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
            outcomeCollector.recordStageRun({
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

        // Format executor activity logs as summary
        executorSummary = executorMessages
          .filter((m) => m.role !== "system")
          .map((m) => {
            if (m.role === "assistant" && m.content) {
              return `[Executor]: ${m.content}`;
            }
            if (m.role === "tool") {
              return `[Tool Call Result (${m.name})]: ${m.content.slice(0, 1000)}${m.content.length > 1000 ? "..." : ""}`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n\n");

        const executorDurationMs = Date.now() - executorStartTime;
        onStateChange({ stage: "executor", status: "done", output: executorSummary });
        this.conductor?.bus.publish({ type: "stage_completed", stage: "executor", output: executorSummary.slice(0, 500), tokens: countTokens(executorSummary), durationMs: executorDurationMs });

        const executorDirective = await safeAfterStage("executor", "completed", executorSummary);
        await applyDirective(executorDirective, "executor");
      } catch (e: any) {
        const executorDurationMs = Date.now() - executorStartTime;
        onStateChange({ stage: "executor", status: "failed", output: errText(e) });
        executorSummary = `Executor failed: ${errText(e)}`;
        this.conductor?.bus.publish({ type: "stage_failed", stage: "executor", error: errText(e) });

        const executorFailDirective = await safeAfterStage("executor", "failed", errText(e));
        await applyDirective(executorFailDirective, "executor");
      }
    }

    // 3. Reviewer & Rewriter Correction Loop
    if (pipeline.includes("reviewer") && (!conductorRerouted || remaining.includes("reviewer"))) {
      const reviewerPrompt = loadPrompt("modes/reviewer.md");
      const rewriterPrompt = loadPrompt("modes/rewriter.md");
      let loopCount = 0;
      const maxLoops = 3;
      let hasPendingIssues = true;

      while (hasPendingIssues && loopCount < maxLoops) {
        loopCount++;
        onStateChange({ stage: "reviewer", status: "running", output: `\nReview Turn ${loopCount}...\n` });
        const revStartTime = Date.now();
        this.conductor?.bus.publish({ type: "stage_started", stage: "reviewer", model: "", runId: agentRunId });

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
            stageAbort: registerStageAbort("reviewer"),
            onChunk: (chunk) => {
              onStateChange({ stage: "reviewer", status: "running", output: chunk });
              publishToken("reviewer", chunk);
            }
          });

          reviewerFeedback = reviewerResp.content;
          const revDurationMs = Date.now() - revStartTime;
          onStateChange({ stage: "reviewer", status: "done", output: reviewerFeedback });
          this.conductor?.bus.publish({ type: "stage_completed", stage: "reviewer", output: reviewerFeedback, tokens: countTokens(reviewerFeedback), durationMs: revDurationMs });

          outcomeCollector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "reviewer",
            turn_number: loopCount,
            input_tokens: Math.round((reviewerPrompt.length + request.length + plan.length + executorSummary.length + rewriterSummary.length) / 4),
            output_tokens: countTokens(reviewerFeedback),
            tool_calls_json: "[]",
            duration_ms: revDurationMs,
            was_successful: 1,
            had_error: 0,
          });

          const reviewerDirective = await safeAfterStage("reviewer", "completed", reviewerFeedback);
          await applyDirective(reviewerDirective, "reviewer");
          if (conductorRerouted) break; // conductor issued a reroute — exit reviewer loop early

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
            const rewriterStartTime = Date.now();
            this.conductor?.bus.publish({ type: "stage_started", stage: "rewriter", model: "", runId: agentRunId });

            while (!rewriterDone && rewriterTurn < maxRewriterTurns) {
              rewriterTurn++;
              const rewStartTime = Date.now();
              let rewriteResp: any;

              try {
                rewriteResp = await this.callModel(rewriterMessages, {
                  temperature: BUILTIN_MODES.rewriter.temperature,
                  max_tokens: BUILTIN_MODES.rewriter.max_tokens,
                  tools: getToolsForMode("rewriter", this.runtime.listTools()),
                  stream: true,
                  stageLabel: "rewriter",
                  stageAbort: registerStageAbort("rewriter"),
                  onChunk: (chunk) => {
                    onStateChange({ stage: "rewriter", status: "running", output: chunk });
                    publishToken("rewriter", chunk);
                  }
                });

                rewriterMessages.push({
                  role: "assistant",
                  content: rewriteResp.content,
                  tool_calls: rewriteResp.tool_calls
                });

                if (rewriteResp.tool_calls && rewriteResp.tool_calls.length > 0) {
                  for (const tc of rewriteResp.tool_calls) {
                    this.conductor?.bus.publish({ type: "tool_call_started", stage: "rewriter", name: tc.name, args: tc.arguments ?? {} });
                    const toolResult = await this.runtime.execute(tc, this.ctx);
                    this.conductor?.bus.publish({ type: "tool_result", stage: "rewriter", name: tc.name, isError: toolResult.is_error, summary: toolResult.output.slice(0, 200) });
                    this.conductor?.live.onToolResult("rewriter", tc.name, toolResult.is_error, toolResult.output.slice(0, 200));
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

                outcomeCollector.recordStageRun({
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
                outcomeCollector.recordStageRun({
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

            const rewriterDurationMs = Date.now() - rewriterStartTime;
            onStateChange({ stage: "rewriter", status: "done", output: rewriterSummary });
            this.conductor?.bus.publish({ type: "stage_completed", stage: "rewriter", output: rewriterSummary.slice(0, 500), tokens: countTokens(rewriterSummary), durationMs: rewriterDurationMs });

            const rewriterDirective = await safeAfterStage("rewriter", "completed", rewriterSummary);
            await applyDirective(rewriterDirective, "rewriter");
            if (conductorRerouted) break; // conductor issued a reroute — exit reviewer loop early
          }
        } catch (e: any) {
          const revDurationMs = Date.now() - revStartTime;
          onStateChange({ stage: "reviewer", status: "failed", output: errText(e) });
          hasPendingIssues = false; // abort review loop on error
          this.conductor?.bus.publish({ type: "stage_failed", stage: "reviewer", error: errText(e) });

          outcomeCollector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "reviewer",
            turn_number: loopCount,
            tool_calls_json: "[]",
            duration_ms: revDurationMs,
            was_successful: 0,
            had_error: 1,
            error_message: errText(e),
          });

          const reviewerFailDirective = await safeAfterStage("reviewer", "failed", errText(e));
          await applyDirective(reviewerFailDirective, "reviewer");
        }
      }
    }

    // 4. Synthesizer Stage
    let finalAnswer = "";
    let fatalError: string | undefined;
    if (pipeline.includes("synthesizer") && (!conductorRerouted || remaining.includes("synthesizer"))) {
      onStateChange({ stage: "synthesizer", status: "running" });
      const synthesizerPrompt = loadPrompt("modes/synthesizer.md");
      const synthStartTime = Date.now();
      this.conductor?.bus.publish({ type: "stage_started", stage: "synthesizer", model: "", runId: agentRunId });
      try {
        const resp = await this.callModel([
          { role: "system", content: synthesizerPrompt },
          {
            role: "user",
            content: `User Request: ${request}\n\nOriginal Plan:\n${plan}\n\nExecutor Activity:\n${executorSummary}\n\nReviewer Feedback:\n${reviewerFeedback}\n\nRewriter Activity:\n${rewriterSummary}`
          }
        ] as ChatMessage[], {
          temperature: BUILTIN_MODES.synthesizer.temperature,
          max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
          stream: true,
          stageLabel: "synthesizer",
          surfaceAsAnswer: true,
          stageAbort: registerStageAbort("synthesizer"),
          onChunk: (chunk) => {
            onStateChange({ stage: "synthesizer", status: "running", output: chunk });
            publishToken("synthesizer", chunk);
          }
        });
        finalAnswer = resp.content;
        const synthDurationMs = Date.now() - synthStartTime;
        onStateChange({ stage: "synthesizer", status: "done", output: finalAnswer });
        this.conductor?.bus.publish({ type: "stage_completed", stage: "synthesizer", output: finalAnswer.slice(0, 500), tokens: countTokens(finalAnswer), durationMs: synthDurationMs });

        outcomeCollector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "synthesizer",
          turn_number: 1,
          input_tokens: Math.round((synthesizerPrompt.length + request.length + plan.length + executorSummary.length + reviewerFeedback.length + rewriterSummary.length) / 4),
          output_tokens: countTokens(finalAnswer),
          tool_calls_json: "[]",
          duration_ms: synthDurationMs,
          was_successful: 1,
          had_error: 0,
        });

        const synthDirective = await safeAfterStage("synthesizer", "completed", finalAnswer);
        await applyDirective(synthDirective, "synthesizer");
      } catch (e: any) {
        const synthDurationMs = Date.now() - synthStartTime;
        onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
        // The synthesizer produces the turn's actual answer. If it threw, there
        // is no answer — record the failure so the caller emits an error frame
        // instead of passing "Synthesis failed: …" off as a successful result.
        fatalError = describePipelineError(errText(e));
        finalAnswer = `Synthesis failed: ${errText(e)}`;
        this.conductor?.bus.publish({ type: "stage_failed", stage: "synthesizer", error: errText(e) });

        outcomeCollector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "synthesizer",
          turn_number: 1,
          tool_calls_json: "[]",
          duration_ms: synthDurationMs,
          was_successful: 0,
          had_error: 1,
          error_message: errText(e),
        });

        const synthFailDirective = await safeAfterStage("synthesizer", "failed", errText(e));
        await applyDirective(synthFailDirective, "synthesizer");
      }
    } else {
      // Fallback: return the last completed phase output.
      // This covers both: synthesizer not in pipeline, and conductor rerouted past it.
      finalAnswer = plan !== "No planning stage executed." ? plan : "No planning stage executed.";
    }

    const result = { answer: finalAnswer, error: fatalError, recursion_depth: 0 };
    if (!fatalError && pipeline.includes("synthesizer")) {
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
    onStateChange: (state: PipelineProgressState) => void
  ): Promise<PipelineResult> {
    const plannerPrompt = loadPrompt("modes/planner.md");
    const reviewerPrompt = loadPrompt("modes/reviewer.md");

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
    const synthesizerPrompt = loadPrompt("modes/synthesizer.md");
    const synthStartTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        {
          role: "user",
          content: `User Request: ${request}\n\nOriginal Plan:\n${plan}\n\nExecutor Activity:\n${executorSummary}\n\nReviewer Feedback:\n${reviewerFeedback}\n\nRewriter Activity:\n${rewriterSummary}`
        }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES.synthesizer.temperature,
        max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
        stream: true,
        stageLabel: "synthesizer",
        surfaceAsAnswer: true,
        onChunk: (chunk) => {
          onStateChange({ stage: "synthesizer", status: "running", output: chunk });
          publishToken("synthesizer", chunk);
        }
      });
      const finalAnswer = resp.content;
      onStateChange({ stage: "synthesizer", status: "done", output: finalAnswer });

      outcomeCollector.recordStageRun({
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

      return { answer: finalAnswer, recursion_depth: 0 };
    } catch (e: any) {
      onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
      const fatalError = describePipelineError(errText(e));

      outcomeCollector.recordStageRun({
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

      return { answer: `Synthesis failed: ${errText(e)}`, error: fatalError, recursion_depth: 0 };
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

      outcomeCollector.recordStageRun({
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

      outcomeCollector.recordStageRun({
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
    onStateChange: (state: PipelineProgressState) => void
  ): Promise<PipelineResult> {
    const executorPrompt = loadPrompt("modes/executor.md");
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
    const synthesizerPrompt = loadPrompt("modes/synthesizer.md");
    const synthStartTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        {
          role: "user",
          content: `User Request: ${request}\n\nOriginal Plan:\nSpeculative cascade: cheap executor first, strong executor only on uncertainty.\n\nExecutor Activity:\n${executorSummary}\n\nReviewer Feedback:\nNo review stage executed.\n\nRewriter Activity:\nNo rewriting stage executed.`
        }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES.synthesizer.temperature,
        max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
        stream: true,
        stageLabel: "synthesizer",
        surfaceAsAnswer: true,
        onChunk: (chunk) => {
          onStateChange({ stage: "synthesizer", status: "running", output: chunk });
          publishToken("synthesizer", chunk);
        }
      });
      const finalAnswer = resp.content;
      onStateChange({ stage: "synthesizer", status: "done", output: finalAnswer });

      outcomeCollector.recordStageRun({
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

      return { answer: finalAnswer, recursion_depth: 0 };
    } catch (e: any) {
      onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
      const fatalError = describePipelineError(errText(e));

      outcomeCollector.recordStageRun({
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

      return { answer: `Synthesis failed: ${errText(e)}`, error: fatalError, recursion_depth: 0 };
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

      outcomeCollector.recordStageRun({
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
        { topology: "linear" },
      );

      return {
        ...rerun,
        recursion_depth: nextDepth,
      };
    } catch (e: any) {
      const message = errText(e);
      await options.onRecursion?.({ depth, status: "failed", critique: message });
      outcomeCollector.recordStageRun({
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
