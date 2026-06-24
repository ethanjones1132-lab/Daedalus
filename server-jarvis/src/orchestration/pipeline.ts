import { loadPrompt } from "./prompt-loader";
import { BUILTIN_MODES, getToolsForMode } from "./modes";
import type { ToolRuntime, ExecutionContext } from "../tool-runtime";
import type { CallModelFn, ChatMessage } from "./router";
import { outcomeCollector } from "../self-tuning/mod";
import { countTokens } from "../tokens";

export interface PipelineProgressState {
  stage: "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer";
  status: "running" | "done" | "failed";
  output?: string;
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
    private ctx: ExecutionContext
  ) {}

  async execute(
    request: string,
    pipeline: string[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void
  ): Promise<PipelineResult> {
    let plan = "No planning stage executed.";
    let executorSummary = "No execution stage executed.";
    let reviewerFeedback = "No review stage executed.";
    let rewriterSummary = "No rewriting stage executed.";

    // 1. Planner Stage
    if (pipeline.includes("planner")) {
      onStateChange({ stage: "planner", status: "running" });
      const plannerPrompt = loadPrompt("modes/planner.md");
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
          onChunk: (chunk) => {
            onStateChange({ stage: "planner", status: "running", output: chunk });
          }
        });
        plan = resp.content;
        onStateChange({ stage: "planner", status: "done", output: plan });

        outcomeCollector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "planner",
          turn_number: 1,
          input_tokens: Math.round((plannerPrompt.length + request.length) / 4),
          output_tokens: countTokens(plan),
          tool_calls_json: "[]",
          duration_ms: Date.now() - startTime,
          was_successful: 1,
          had_error: 0,
        });
      } catch (e: any) {
        onStateChange({ stage: "planner", status: "failed", output: errText(e) });
        plan = `Failed to generate plan: ${errText(e)}`;

        outcomeCollector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "planner",
          turn_number: 1,
          tool_calls_json: "[]",
          duration_ms: Date.now() - startTime,
          was_successful: 0,
          had_error: 1,
          error_message: errText(e),
        });
      }
    }

    // 2. Executor Stage
    if (pipeline.includes("executor")) {
      onStateChange({ stage: "executor", status: "running" });
      const executorPrompt = loadPrompt("modes/executor.md");
      const executorMessages: ChatMessage[] = [
        { role: "system", content: executorPrompt },
        { role: "user", content: `User Request: ${request}\n\nPlan:\n${plan}` }
      ];

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
              tools: getToolsForMode("executor", this.runtime.listTools()),
              stream: true,
              stageLabel: "executor",
              onChunk: (chunk) => {
                onStateChange({ stage: "executor", status: "running", output: chunk });
              }
            });

            executorMessages.push({
              role: "assistant",
              content: response.content,
              tool_calls: response.tool_calls
            });

            if (response.tool_calls && response.tool_calls.length > 0) {
              for (const tc of response.tool_calls) {
                const toolResult = await this.runtime.execute(tc, this.ctx);
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

        onStateChange({ stage: "executor", status: "done", output: executorSummary });
      } catch (e: any) {
        onStateChange({ stage: "executor", status: "failed", output: errText(e) });
        executorSummary = `Executor failed: ${errText(e)}`;
      }
    }

    // 3. Reviewer & Rewriter Correction Loop
    if (pipeline.includes("reviewer")) {
      const reviewerPrompt = loadPrompt("modes/reviewer.md");
      const rewriterPrompt = loadPrompt("modes/rewriter.md");
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
            onChunk: (chunk) => {
              onStateChange({ stage: "reviewer", status: "running", output: chunk });
            }
          });

          reviewerFeedback = reviewerResp.content;
          onStateChange({ stage: "reviewer", status: "done", output: reviewerFeedback });

          outcomeCollector.recordStageRun({
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
                  tools: getToolsForMode("rewriter", this.runtime.listTools()),
                  stream: true,
                  stageLabel: "rewriter",
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
                    const toolResult = await this.runtime.execute(tc, this.ctx);
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

            onStateChange({ stage: "rewriter", status: "done", output: rewriterSummary });
          }
        } catch (e: any) {
          onStateChange({ stage: "reviewer", status: "failed", output: errText(e) });
          hasPendingIssues = false; // abort review loop on error

          outcomeCollector.recordStageRun({
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
    if (pipeline.includes("synthesizer")) {
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
          }
        });
        finalAnswer = resp.content;
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
      } catch (e: any) {
        onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
        // The synthesizer produces the turn's actual answer. If it threw, there
        // is no answer — record the failure so the caller emits an error frame
        // instead of passing "Synthesis failed: …" off as a successful result.
        fatalError = describePipelineError(errText(e));
        finalAnswer = `Synthesis failed: ${errText(e)}`;

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
      }
    } else {
      // Fallback: return the last completed phase output.
      finalAnswer = plan !== "No planning stage executed." ? plan : "No planning stage executed.";
    }

    return { answer: finalAnswer, error: fatalError };
  }

  private hasIssues(reviewText: string): boolean {
    const normalized = reviewText.toUpperCase();
    return normalized.includes("PARTIAL") || normalized.includes("MISSING");
  }
}

