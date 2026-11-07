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

/** Shown when neither the turn nor the retry produced an answer (no tools). */
export const EMPTY_ANSWER_WITHOUT_TOOLS_FALLBACK =
  "The model returned no content. This can happen due to transient model issues, provider timeouts, or empty completions on the free tier. Please try sending your message again.";

/** Shown when tools ran but neither the turn nor the retry produced an answer. */
export const EMPTY_ANSWER_WITH_TOOL_WORK_FALLBACK =
  "I completed tool inspection, but the model returned no visible final answer after a final-answer-only retry. The streamed tool results above are preserved for review.";

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
}

/**
 * Decide the single-pass branch's honest terminal outcome.
 *
 * A non-empty answer still succeeds even after the empty-answer retry ran.
 * Only an exhausted empty outcome is non-success; its code is the existing
 * `empty_completion` vocabulary, and the fallback text stays visible.
 */
export function classifySinglePassCompletion(input: {
  answer: string;
  toolExecutionCount: number;
}): SinglePassCompletion {
  const toolWorkPreserved = input.toolExecutionCount > 0;
  if (input.answer.trim().length > 0) {
    const fields = terminalResultFields({ outcome: "success", repeated: false });
    return {
      result: input.answer,
      subtype: fields.subtype,
      memoryStatus: "completed",
      errorCode: null,
      empty: false,
      toolWorkPreserved,
    };
  }

  // No final answer after the retry. Tool work that already streamed is real
  // evidence, so the turn is partial rather than a total failure; with no
  // tool work there is nothing to show and the honest outcome is failure.
  const outcome: TerminalRunOutcome = toolWorkPreserved ? "partial" : "failed";
  const fields = terminalResultFields({
    outcome,
    errorCode: EMPTY_COMPLETION_ERROR_CODE,
    repeated: false,
  });
  return {
    result: toolWorkPreserved
      ? EMPTY_ANSWER_WITH_TOOL_WORK_FALLBACK
      : EMPTY_ANSWER_WITHOUT_TOOLS_FALLBACK,
    subtype: fields.subtype,
    ...(fields.code ? { code: fields.code } : {}),
    memoryStatus: toolWorkPreserved ? "partial" : "failed",
    errorCode: EMPTY_COMPLETION_ERROR_CODE,
    empty: true,
    toolWorkPreserved,
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
