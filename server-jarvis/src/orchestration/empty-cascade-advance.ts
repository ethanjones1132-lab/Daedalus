// Bounded empty-completion cascade-advance.
//
// If a USER-VISIBLE stage returns a semantically-empty 200 (no content and no
// tool calls) and a fallback cascade is configured, this loop advances PAST that
// model and tries the next one. A model that just returned empty will almost
// always return empty again, so the loop excludes it instead of retrying it.
//
// This is the ONLY place a stage spends an extra provider call, which makes it
// the only place a stage the Conductor had already ordered to stop could have
// kept working: the loop consulted the turn-wide abort alone, so a stage-local
// `abort_stage` landing between attempts still advanced the cascade onto another
// model, and that model's result was then health-attributed as if it had been
// asked. The `settlement` probe is re-read on every pass for exactly that
// reason — the abort can land while an attempt is in flight.
//
// A stopped attempt is not a model failure: it records neither a success nor an
// `empty_completion` strike, because the model was not the reason the stage
// stopped. Ordinary transport behaviour is unchanged: an empty completion from a
// live stage still advances, still strikes the model, and still stops at the
// first prose (or, for a model-only stage, the first tool call).

import type { StageSettlement } from "./stage-abort-link";

/** One message of the stage prompt. The caller's array is never mutated. */
export interface CascadeMessage {
  role?: string;
  content?: string;
  [key: string]: unknown;
}

/** The subset of a call-model result the cascade inspects. */
export interface EmptyAdvanceResult {
  content?: string;
  tool_calls?: any[];
  _provider?: string;
  _modelUsed?: string;
}

/** The health registry writes the cascade makes (structurally `StageHealthRegistry`). */
export interface EmptyCascadeHealth {
  recordSuccess(input: { provider: string; modelId: string; stage: string }): void;
  recordFailure(failure: { provider: string; modelId: string; stage: string; kind: "empty_completion" }): void;
}

export interface EmptyCascadeDeps<T extends EmptyAdvanceResult> {
  /** The prompt this stage is answering. */
  messages: Array<CascadeMessage>;
  /** A user-visible (synthesizer) stage: only prose counts as done. */
  surfaceAsAnswer: boolean;
  /** Stage label used for health attribution. */
  stage: string;
  /** Provider/model keys the cascade must not reuse. Mutated as it advances. */
  exclude: Set<string>;
  /** Upper bound on extra provider calls. */
  maxAdvances: number;
  /** Run one attempt against the next candidate model. */
  attempt: (messages: Array<CascadeMessage>) => Promise<T>;
  stageHealth: EmptyCascadeHealth;
  /**
   * Why the stage is still eligible to work, re-read every pass. A stopped
   * stage (`stage_aborted` / `turn_cancelled`) gets no further attempt and no
   * health record.
   */
  settlement: () => StageSettlement;
  /** Fewer than 15s of turn budget remains. */
  budgetExhausted: () => boolean;
  /** Operator-facing diagnostic sink. */
  warn: (message: string) => void;
}

/**
 * Nudge a candidate that returned empty toward a usable answer. For a tool stage
 * the nudge asks for a tool call; for an answer stage it forbids tool syntax,
 * because the leaked call text was previously accepted as the answer itself
 * (session 1d4727cf) and then reinforced by the tuning loop as a success.
 */
export function buildEmptyAdvanceNudge(surfaceAsAnswer: boolean): string {
  return surfaceAsAnswer
    ? "You have no tools available. Answer the user in plain prose now. Do not emit tool_call syntax, tool JSON, or any function-call markup."
    : "If you need a tool, emit a valid tool call; otherwise answer in plain prose. Do not emit tool-call syntax as visible text.";
}

/**
 * Splice the nudge into the LEADING system message rather than appending it to
 * the array: `normalizeMessagesForLLM` only merges leading system messages, so a
 * trailing system message would land mid-array and be demoted to a wrapped user
 * message instead of reaching the actual system prompt. The caller's messages
 * are copied, never mutated.
 */
export function withEmptyAdvanceNudge(
  messages: Array<CascadeMessage>,
  nudge: string,
): Array<CascadeMessage> {
  const nudged = [...messages];
  const leadingSystemIdx = nudged.findIndex((m) => m?.role === "system");
  if (leadingSystemIdx >= 0) {
    nudged[leadingSystemIdx] = {
      ...nudged[leadingSystemIdx],
      content: `${nudged[leadingSystemIdx].content ?? ""}\n\n${nudge}`,
    };
  } else {
    nudged.unshift({ role: "system", content: nudge });
  }
  return nudged;
}

/**
 * Advance past empty completions until the stage produces something usable, the
 * pool runs out, the turn budget runs out, or somebody stops the stage.
 *
 * `first` is the result the caller already has; the loop never re-issues that
 * call. It returns the last result it actually obtained, so a stopped stage
 * returns the empty completion it had rather than a fabricated one.
 */
export async function runEmptyCompletionCascade<T extends EmptyAdvanceResult>(
  deps: EmptyCascadeDeps<T>,
  first: T,
): Promise<T> {
  const { messages, surfaceAsAnswer, stage, exclude, maxAdvances, attempt, stageHealth, settlement, budgetExhausted, warn } =
    deps;
  const nudge = buildEmptyAdvanceNudge(surfaceAsAnswer);
  let last = first;

  for (let advance = 0; advance < maxAdvances; advance++) {
    const hasContent = typeof last?.content === "string" && last.content.trim().length > 0;
    const hasToolCalls = !surfaceAsAnswer && Array.isArray(last?.tool_calls) && last.tool_calls.length > 0;
    // Somebody stopped this stage. Its result is not a model outcome, so it is
    // neither rewarded nor struck, and no further provider call is spent.
    const stopped = settlement();
    if (stopped !== "in_flight") {
      warn(`empty-completion cascade-advance stopped: stage ${stage} was settled as ${stopped}`);
      break;
    }
    // A user-visible stage is only "done" when it produced clean prose. Tool
    // calls count for model-only stages; synthesizer tool calls do not.
    if (hasContent || hasToolCalls) {
      if (last?._provider && last?._modelUsed) {
        stageHealth.recordSuccess({ provider: last._provider, modelId: last._modelUsed, stage });
      }
      break;
    }
    if (last?._provider && last?._modelUsed) {
      const key = `${last._provider}:${last._modelUsed}`;
      if (exclude.has(key)) {
        warn(`empty-completion cascade-advance has no different model left in pool (only ${key} available) — stopping`);
        break;
      }
      exclude.add(key);
      stageHealth.recordFailure({
        provider: last._provider,
        modelId: last._modelUsed,
        stage,
        kind: "empty_completion",
      });
    }
    if (exclude.size === 0) break; // no exclusion built → nothing to advance past
    if (budgetExhausted()) {
      warn("empty-completion cascade-advance stopped: <15s of turn budget remaining");
      break;
    }
    warn(
      `empty completion from ${last?._provider}:${last?._modelUsed} stage=${stage} — advancing cascade (excluding it)`,
    );
    // Re-read the settlement immediately before the call as well: the abort can
    // land between the guard above and this await.
    const stoppedBeforeCall = settlement();
    if (stoppedBeforeCall !== "in_flight") {
      warn(`empty-completion cascade-advance stopped: stage ${stage} was settled as ${stoppedBeforeCall}`);
      break;
    }
    last = await attempt(withEmptyAdvanceNudge(messages, nudge));
  }

  return last;
}
