/**
 * DD-102: request-side context-window fitting for the direct (Ollama /
 * llama.cpp / OpenRouter) chat loop.
 *
 * This logic used to live in `index.ts`. The entrypoint binds a real socket and
 * installs the self-log tee at import time (see the comments in
 * `request-error-log.test.ts` and `empty-completion-terminal.test.ts`), so a
 * pure function defined there could never be exercised by a test — which is how
 * the "clear the history when the budget is tiny" defect survived. The function
 * now lives here; `index.ts` imports it and re-exports `optimizeContextWindow`
 * so the entrypoint's public surface is unchanged.
 *
 * Invariants (DD-102):
 * - The turn being answered is never evicted. When the caller supplies
 *   `currentPrompt` it is returned as the final user turn; when the caller has
 *   already folded that turn into `history` (the native tool-call loop leaves
 *   `currentPrompt` empty), the newest history group carries it instead.
 * - The minimal-history path may drop every *prior* turn, but only after the
 *   current turn has been accounted for.
 * - Pinned leading system messages are kept while they fit. When they alone
 *   overflow the window, the oldest text is truncated first, then the oldest
 *   messages are dropped — each with an explicit log line.
 * - If the system prompt plus the current turn cannot fit at all, the result
 *   fails closed with the `context_too_small` reason and an empty message list.
 *   It never fabricates a user turn to make the request look valid.
 */

export interface ContextWindowMessage {
  role: string;
  content?: string | null;
  [key: string]: any;
}

/**
 * Fail-closed reason code. Mirrors the `HISTORY_BUDGET_TOKENS` vocabulary in
 * `orchestration/context-budget.ts`: the direct path reports the same
 * budget-shaped failure the orchestrated path names, rather than inventing a
 * second spelling for "there is no room for this turn".
 */
export const CONTEXT_TOO_SMALL = "context_too_small" as const;

/** Below this remaining history budget only the turn being answered is sent. */
export const MIN_HISTORY_BUDGET_TOKENS = 500;

/** Cap on the output reserve withheld from the context window. */
export const MAX_GENERATION_RESERVE_TOKENS = 2048;

/** Smallest useful remainder (tokens) for a partially kept system message. */
const MIN_TRUNCATED_SYSTEM_TOKENS = 32;

/** Same marker family as `orchestration/context-budget.ts` payload eviction. */
const SYSTEM_ELISION_MARKER = "\n[elided to fit context budget: system message truncated]";

export interface ContextWindowFit {
  ok: true;
  /** System messages (pinned first) + retained prior turns + the current turn. */
  messages: ContextWindowMessage[];
  /** Prior history messages this fit discarded. */
  droppedHistoryMessages: number;
  droppedHistoryTokens: number;
  droppedHistoryGroups: number;
  /** Pinned system messages discarded / partially truncated by this fit. */
  systemMessagesDropped: number;
  systemMessagesTruncated: number;
  /** True when the history floor forced every prior turn to be dropped. */
  minimalHistory: boolean;
  historyBudgetTokens: number;
}

export interface ContextWindowTooSmall {
  ok: false;
  reason: typeof CONTEXT_TOO_SMALL;
  /**
   * Deliberately empty. There is no room for the turn being answered, so
   * sending anything here would be a silent, user-less request; the caller
   * must fail the turn instead.
   */
  messages: [];
  numCtx: number;
  generationReserve: number;
  availableTokens: number;
  requiredTokens: number;
  detail: string;
}

export type ContextWindowResult = ContextWindowFit | ContextWindowTooSmall;

/**
 * Thrown by the entrypoint when {@link optimizeContextWindow} cannot fit the
 * turn being answered. The stream error handler maps its `name` to the
 * `context_too_small` SSE error code, so the client sees a real reason instead
 * of an empty assistant bubble.
 */
export class ContextTooSmallError extends Error {
  readonly reason = CONTEXT_TOO_SMALL;
  readonly numCtx: number;
  readonly availableTokens: number;
  readonly requiredTokens: number;
  readonly detail: string;

  constructor(failure: ContextWindowTooSmall) {
    super(`${CONTEXT_TOO_SMALL}: ${failure.detail}`);
    this.name = "ContextTooSmallError";
    this.numCtx = failure.numCtx;
    this.availableTokens = failure.availableTokens;
    this.requiredTokens = failure.requiredTokens;
    this.detail = failure.detail;
  }
}

/**
 * Fit `history` into `numCtx`, always keeping the turn being answered.
 *
 * `effectiveSystemPrompt` is the stage/tool system text the caller sends on its
 * own; it is not ours to drop, so it is reserved before any history sizing.
 */
export function optimizeContextWindow(
  history: ContextWindowMessage[],
  effectiveSystemPrompt: string,
  currentPrompt: string,
  numCtx: number,
): ContextWindowResult {
  const estimateTokens = (text: string) => Math.ceil((text || "").length / 4);
  const generationReserve = Math.min(MAX_GENERATION_RESERVE_TOKENS, Math.floor(numCtx * 0.2));
  const availableTokens = Math.max(0, numCtx - generationReserve);

  // Leading system messages carry the compaction summary and memory carriers;
  // pin them (subject to the window) rather than treating them as history.
  let startIndex = 0;
  const pinnedSystemMessages: ContextWindowMessage[] = [];
  while (startIndex < history.length && history[startIndex]?.role === "system") {
    pinnedSystemMessages.push(history[startIndex]);
    startIndex++;
  }

  const systemPromptTokens = estimateTokens(effectiveSystemPrompt);
  const currentTurnTokens = estimateTokens(currentPrompt);

  const tooSmall = (detail: string, requiredTokens: number): ContextWindowTooSmall => {
    console.warn(
      `[ContextOpt] Failing closed (${CONTEXT_TOO_SMALL}): ${detail} ` +
      `num_ctx=${numCtx} generation_reserve=${generationReserve} available=${availableTokens} ` +
      `required=${requiredTokens} system_prompt=${systemPromptTokens} current_turn=${currentTurnTokens}`,
    );
    return {
      ok: false,
      reason: CONTEXT_TOO_SMALL,
      messages: [],
      numCtx,
      generationReserve,
      availableTokens,
      requiredTokens,
      detail,
    };
  };

  // The caller always sends the stage system prompt, and the turn being
  // answered is non-negotiable: if those two alone overflow the window there is
  // nothing this function can drop to make the request valid.
  if (systemPromptTokens + currentTurnTokens > availableTokens) {
    return tooSmall(
      `the system prompt plus the current turn need ~${systemPromptTokens + currentTurnTokens} ` +
      `tokens but only ${availableTokens} are available after the generation reserve`,
      systemPromptTokens + currentTurnTokens,
    );
  }

  // Reserve the current turn BEFORE pinning system text: a pinned system
  // message may never evict the turn being answered.
  const systemAllowance = availableTokens - systemPromptTokens - currentTurnTokens;

  const keptSystemMessages: ContextWindowMessage[] = [];
  let systemTokens = 0;
  let systemMessagesTruncated = 0;
  const droppedSystemMessages: Array<{ index: number; chars: number; tokens: number }> = [];
  let remainingSystemTokens = systemAllowance;

  // Newest system message first: the oldest text is the one worth truncating.
  for (let i = pinnedSystemMessages.length - 1; i >= 0; i--) {
    const message = pinnedSystemMessages[i];
    const content = message.content ?? "";
    const tokens = estimateTokens(content);

    if (droppedSystemMessages.length === 0 && systemMessagesTruncated === 0 && tokens <= remainingSystemTokens) {
      keptSystemMessages.unshift(message);
      remainingSystemTokens -= tokens;
      systemTokens += tokens;
      continue;
    }

    // First overflow: keep as much of this (oldest still-fitting) system text
    // as the window allows, then drop everything older than it.
    if (
      droppedSystemMessages.length === 0
      && systemMessagesTruncated === 0
      && remainingSystemTokens >= MIN_TRUNCATED_SYSTEM_TOKENS
    ) {
      const budgetChars = Math.max(0, remainingSystemTokens * 4 - SYSTEM_ELISION_MARKER.length);
      const truncatedContent = `${content.slice(0, budgetChars)}${SYSTEM_ELISION_MARKER}`;
      const truncatedTokens = estimateTokens(truncatedContent);
      if (budgetChars > 0 && truncatedTokens <= remainingSystemTokens) {
        keptSystemMessages.unshift({ ...message, content: truncatedContent });
        remainingSystemTokens -= truncatedTokens;
        systemTokens += truncatedTokens;
        systemMessagesTruncated++;
        console.warn(
          `[ContextOpt] Truncated the oldest pinned system message (index=${i}) from ` +
          `${content.length} to ${truncatedContent.length} chars (~${tokens} -> ~${truncatedTokens} tokens) ` +
          `to fit num_ctx=${numCtx} (system allowance=${systemAllowance})`,
        );
        continue;
      }
    }

    droppedSystemMessages.push({ index: i, chars: content.length, tokens });
  }

  if (droppedSystemMessages.length > 0 || systemMessagesTruncated > 0) {
    const droppedTokens = droppedSystemMessages.reduce((sum, entry) => sum + entry.tokens, 0);
    console.warn(
      `[ContextOpt] Pinned system messages exceed the window: kept ${keptSystemMessages.length}/` +
      `${pinnedSystemMessages.length}, truncated ${systemMessagesTruncated}, dropped ` +
      `${droppedSystemMessages.length} (~${droppedTokens} tokens, oldest first; ` +
      `indexes=${droppedSystemMessages.map((entry) => `${entry.index}:${entry.chars}ch`).join(",") || "none"}); ` +
      `num_ctx=${numCtx} generation_reserve=${generationReserve} system_allowance=${systemAllowance}`,
    );
  }

  // Group history so a tool call and its results are never split.
  const groups: Array<Array<ContextWindowMessage>> = [];
  let currentGroup: Array<ContextWindowMessage> = [];

  for (let i = startIndex; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "tool") {
      // Tool responses belong to the previous assistant tool call group
      currentGroup.push(msg);
    } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      // Start a new group for assistant tool call
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [msg];
    } else {
      // Standard message starts a new group
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [msg];
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  const groupTokens = groups.map((group) => {
    let tokens = 0;
    for (const msg of group) {
      let msgStr = msg.content || "";
      if (msg.tool_calls) msgStr += JSON.stringify(msg.tool_calls);
      if (msg.tool_call_id) msgStr += msg.tool_call_id;
      tokens += estimateTokens(msgStr);
    }
    return tokens;
  });
  const totalHistoryTokens = groupTokens.reduce((sum, tokens) => sum + tokens, 0);
  const totalHistoryMessages = groups.reduce((sum, group) => sum + group.length, 0);

  const historyBudget = availableTokens - systemPromptTokens - currentTurnTokens - systemTokens;
  const currentTurn: ContextWindowMessage[] = currentPrompt
    ? [{ role: "user", content: currentPrompt }]
    : [];

  let retainedGroups: Array<Array<ContextWindowMessage>> = [];
  let usedTokens = 0;
  const minimalHistory = historyBudget <= MIN_HISTORY_BUDGET_TOKENS;
  // With no explicit current turn, the newest group IS the turn being answered
  // (the native tool loop folds its prompt into history before re-entering).
  const currentTurnIsNewestGroup = !currentPrompt && groups.length > 0;

  if (minimalHistory) {
    // DD-102: the history budget is gone. Drop every PRIOR turn; the turn being
    // answered survives as `currentTurn`, or as the newest group when the
    // caller already folded it into history.
    if (currentTurnIsNewestGroup) {
      const newestTokens = groupTokens[groupTokens.length - 1];
      if (newestTokens > historyBudget) {
        return tooSmall(
          `no prior turn fits the remaining history budget (~${newestTokens} tokens needed, ` +
          `${historyBudget} available) and the caller supplied no current turn`,
          newestTokens,
        );
      }
      retainedGroups = [groups[groups.length - 1]];
      usedTokens = newestTokens;
    }
    const droppedGroups = groups.length - retainedGroups.length;
    console.warn(
      `[ContextOpt] History budget below the floor (${historyBudget} <= ${MIN_HISTORY_BUDGET_TOKENS} tokens; ` +
      `num_ctx=${numCtx} generation_reserve=${generationReserve} system_prompt=${systemPromptTokens} ` +
      `pinned_system=${systemTokens} current_turn=${currentTurnTokens}): dropping ${droppedGroups} prior ` +
      `group(s) / ${totalHistoryMessages - retainedGroups.flat().length} message(s) ` +
      `(~${totalHistoryTokens - usedTokens} tokens); keeping ${keptSystemMessages.length} pinned system ` +
      `message(s)` +
      (currentPrompt
        ? " and the current turn"
        : retainedGroups.length > 0
          ? " and the newest group as the turn being answered"
          : " (no current turn was supplied)"),
    );
  } else {
    // Newest-first retention: oldest groups fall off the front.
    for (let i = groups.length - 1; i >= 0; i--) {
      if (usedTokens + groupTokens[i] > historyBudget) {
        break;
      }
      usedTokens += groupTokens[i];
      retainedGroups.unshift(groups[i]);
    }

    // Sending only system text would be the silent empty-history failure
    // DD-102 exists to prevent. Fail closed instead of faking a user turn.
    if (currentTurnIsNewestGroup && retainedGroups.length === 0) {
      const needed = groupTokens[groupTokens.length - 1];
      return tooSmall(
        `no prior turn fits the remaining history budget (~${needed} tokens needed, ` +
        `${historyBudget} available) and the caller supplied no current turn`,
        needed,
      );
    }
  }

  const retained = retainedGroups.flat();
  const droppedHistoryMessages = totalHistoryMessages - retained.length;
  const droppedHistoryTokens = totalHistoryTokens - usedTokens;
  const droppedHistoryGroups = groups.length - retainedGroups.length;

  if (droppedHistoryGroups > 0 && !minimalHistory) {
    console.warn(
      `[ContextOpt] Dropped ${droppedHistoryGroups}/${groups.length} oldest prior group(s) ` +
      `(${droppedHistoryMessages} message(s), ~${droppedHistoryTokens} tokens) to fit num_ctx=${numCtx} ` +
      `(history_budget=${historyBudget}, generation_reserve=${generationReserve})`,
    );
  }

  return {
    ok: true,
    messages: [...keptSystemMessages, ...retained, ...currentTurn],
    droppedHistoryMessages,
    droppedHistoryTokens,
    droppedHistoryGroups,
    systemMessagesDropped: droppedSystemMessages.length,
    systemMessagesTruncated,
    minimalHistory,
    historyBudgetTokens: historyBudget,
  };
}
