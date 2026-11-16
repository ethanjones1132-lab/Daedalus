// ═══════════════════════════════════════════════════════════════
// ── Single-pass final-answer completion ──
// ═══════════════════════════════════════════════════════════════
// DD-045: the Ollama/OpenRouter single-pass loop retries once with a
// final-answer-only prompt when the model returns no visible text. Until now
// that branch settled EVERY exhausted outcome as a successful completion:
// `recordMemoryTerminal("completed")` plus `session.finish(resultText)` with no
// subtype/code, even when the only thing shown was the explanatory fallback.
// An empty answer therefore reinforced a false successful memory receipt.
//
// This module owns the terminal selection for that branch so the visible
// fallback, the SSE `result` subtype/code and the memory receipt cannot
// disagree:
//
//   • a visible answer (initial or after the retry) succeeds normally;
//   • tool work happened but no final answer followed the retry → `partial`
//     with `empty_completion`, preserving the streamed tool results;
//   • no tool work and no final answer → `error`/`failed` with
//     `empty_completion`, keeping the explanatory fallback visible.
//
// Retry counts, retry prompts, turn budgets and execution paths stay in
// index.ts and are untouched by this seam.
import type { MemoryTurnTerminalStatus } from "./memory-contract";
import type { StreamSession } from "./stream-emitter";
import type { RoutePlanSummary } from "./orchestration/route-plan";
import {
  terminalResultFields,
  type TerminalFinishOptions,
  type TerminalResultFields,
  type TerminalRunOutcome,
} from "./orchestration/terminal-outcome";

/** The existing run-error code for a model that produced no visible answer. */
export const EMPTY_COMPLETION_ERROR_CODE = "empty_completion";

/**
 * Code for the existing `partial` outcome when the model emitted a tool call
 * that the text parser could not turn into a call (DD-088). The call was
 * discarded, so the turn cannot settle as a clean success.
 */
export const REJECTED_TOOL_CALL_ERROR_CODE = "rejected_tool_call";

/** Shown when neither the turn nor the retry produced an answer (no tools). */
export const EMPTY_ANSWER_WITHOUT_TOOLS_FALLBACK =
  "The model returned no content. This can happen due to transient model issues, provider timeouts, or empty completions on the free tier. Please try sending your message again.";

/** Shown when tools ran but neither the turn nor the retry produced an answer. */
export const EMPTY_ANSWER_WITH_TOOL_WORK_FALLBACK =
  "I completed tool inspection, but the model returned no visible final answer after a final-answer-only retry. The streamed tool results above are preserved for review.";

/** Shown when the turn's only tool call was rejected and no answer followed. */
export const REJECTED_TOOL_CALL_FALLBACK =
  "The model emitted a tool call that could not be parsed, so it did not run. The rejected call is shown above.";

export interface SinglePassCompletion {
  /** Visible text for the terminal `result` frame (answer or honest fallback). */
  result: string;
  /** Terminal SSE subtype, via the shared terminal vocabulary. */
  subtype: TerminalResultFields["subtype"];
  /** Present only for a non-success outcome with a real server reason. */
  code?: string;
  /** Memory receipt status; always consistent with `subtype`. */
  memoryStatus: MemoryTurnTerminalStatus;
  /** Stored on the receipt, null when the turn succeeded. */
  errorCode: string | null;
  /** True when the model produced no visible answer after the retry. */
  empty: boolean;
  /** True when tool work happened and its streamed results are preserved. */
  toolWorkPreserved: boolean;
  /** `<tool_call>` blocks this turn discarded without executing (DD-088). */
  rejectedToolCallCount: number;
}

/**
 * Decide the single-pass branch's honest terminal outcome.
 *
 * A non-empty answer still succeeds even after the empty-answer retry ran,
 * unless the turn also discarded the only tool call it emitted. An exhausted
 * empty outcome stays non-success; its code is the existing `empty_completion`
 * vocabulary, and the fallback text stays visible.
 */
export function classifySinglePassCompletion(input: {
  answer: string;
  toolExecutionCount: number;
  /**
   * Calls the text parser rejected as unparseable (DD-088). A discarded call
   * with no other executed call settles `partial`, never `success`.
   */
  rejectedToolCallCount?: number;
}): SinglePassCompletion {
  const toolWorkPreserved = input.toolExecutionCount > 0;
  const rejectedToolCallCount = Math.max(0, Math.trunc(input.rejectedToolCallCount ?? 0));
  const discardedCall = rejectedToolCallCount > 0;

  if (input.answer.trim().length > 0) {
    // The answer is real, but the turn still threw away a call the model
    // appeared to make. With no other executed call there is no successful
    // work to stand on, so the honest outcome is the existing `partial`.
    if (discardedCall && !toolWorkPreserved) {
      const fields = terminalResultFields({
        outcome: "partial",
        errorCode: REJECTED_TOOL_CALL_ERROR_CODE,
        repeated: false,
      });
      return {
        result: input.answer,
        subtype: fields.subtype,
        ...(fields.code ? { code: fields.code } : {}),
        memoryStatus: "partial",
        errorCode: REJECTED_TOOL_CALL_ERROR_CODE,
        empty: false,
        toolWorkPreserved: false,
        rejectedToolCallCount,
      };
    }
    const fields = terminalResultFields({ outcome: "success", repeated: false });
    return {
      result: input.answer,
      subtype: fields.subtype,
      memoryStatus: "completed",
      errorCode: null,
      empty: false,
      toolWorkPreserved,
      rejectedToolCallCount,
    };
  }

  // No final answer after the retry. Tool work that already streamed is real
  // evidence, so the turn is partial rather than a total failure; a discarded
  // call is also evidence of a real attempt, so it is partial too. With
  // neither, there is nothing to show and the honest outcome is failure.
  const outcome: TerminalRunOutcome =
    toolWorkPreserved || discardedCall ? "partial" : "failed";
  const errorCode = toolWorkPreserved || !discardedCall
    ? EMPTY_COMPLETION_ERROR_CODE
    : REJECTED_TOOL_CALL_ERROR_CODE;
  const fallback = toolWorkPreserved
    ? EMPTY_ANSWER_WITH_TOOL_WORK_FALLBACK
    : discardedCall
      ? REJECTED_TOOL_CALL_FALLBACK
      : EMPTY_ANSWER_WITHOUT_TOOLS_FALLBACK;
  const fields = terminalResultFields({
    outcome,
    errorCode,
    repeated: false,
  });
  return {
    result: fallback,
    subtype: fields.subtype,
    ...(fields.code ? { code: fields.code } : {}),
    memoryStatus: outcome === "partial" ? "partial" : "failed",
    errorCode,
    empty: true,
    toolWorkPreserved,
    rejectedToolCallCount,
  };
}

/**
 * Settle the single-pass branch: record the receipt and emit the ONE terminal
 * stream outcome from the same classification. `StreamSession.finish` remains
 * the sole owner of the transport terminator and is idempotent.
 */
export async function finishSinglePassCompletion(input: {
  answer: string;
  toolExecutionCount: number;
  /** Calls discarded unparsed this turn (DD-088); defaults to none. */
  rejectedToolCallCount?: number;
  session: Pick<StreamSession, "finish">;
  recordMemoryTerminal: (
    status: MemoryTurnTerminalStatus,
    errorCode?: string | null,
  ) => void;
  route?: RoutePlanSummary;
}): Promise<SinglePassCompletion> {
  const completion = classifySinglePassCompletion({
    answer: input.answer,
    toolExecutionCount: input.toolExecutionCount,
    rejectedToolCallCount: input.rejectedToolCallCount ?? 0,
  });
  input.recordMemoryTerminal(completion.memoryStatus, completion.errorCode);
  const options: TerminalFinishOptions = {
    subtype: completion.subtype,
    isError: completion.subtype === "error",
    ...(completion.code ? { code: completion.code } : {}),
    ...(input.route ? { route: input.route } : {}),
  };
  await input.session.finish(completion.result, options);
  return completion;
}
