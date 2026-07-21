import { countTokens } from "../tokens";
import type { TurnRequirement } from "./turn-requirements";

export const HISTORY_BUDGET_TOKENS: Record<TurnRequirement, number> = {
  conversational: 0,
  answer_only: 1_200,
  workspace_read: 2_000,
  full_execution: 2_400,
};

export const EXECUTOR_TOOL_RESULT_CONTEXT_CHARS = 6_000;
export const EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS = 3_000;
export const REWRITER_TOOL_RESULT_CONTEXT_CHARS = 4_000;
// Network results (web_fetch/web_search) carry the evidence for research turns,
// where the readable article is the whole point. The 5,000-char strip that
// web_fetch used truncated mid-article on any real page; this budget admits a
// full extracted article while staying well under the write-turn cap.
export const NETWORK_TOOL_RESULT_CONTEXT_CHARS = 12_000;
export const EXECUTOR_TRANSCRIPT_BUDGET_TOKENS = 12_000;
export const REWRITER_TRANSCRIPT_BUDGET_TOKENS = 8_000;

// ── Write-turn visibility (2026-07-18) ───────────────────────────────────────
// A model cannot compose a correct edit_file old_string for code it never
// saw: the live incident file (PluginProcessor.cpp) is 22,335 chars while the
// 6,000-char read cap showed the executor barely a quarter of it, making
// every real implementation task structurally impossible regardless of
// routing or nudges. Write turns therefore run with a per-result cap that
// admits real source files whole, and a transcript budget sized to hold two
// such files plus the working conversation. Read-only turns keep the tight
// caps — summarization does not need byte-exact visibility.
export const WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS = 24_000;
export const WRITE_TURN_TRANSCRIPT_BUDGET_TOKENS = 24_000;

export interface TranscriptMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
}

/**
 * Evict only old runtime payloads from a loop transcript. Messages stay in
 * place so provider tool-call pairing remains valid, and the newest assistant
 * turn plus its immediately-following results remain intact.
 */
export function enforceTranscriptBudget(
  messages: TranscriptMessage[],
  budgetTokens: number,
): { evicted: number; inputTokens: number } {
  const measure = () => countTokens(JSON.stringify(messages));
  let inputTokens = measure();
  if (inputTokens <= budgetTokens) return { evicted: 0, inputTokens };

  const lastAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
  if (lastAssistantIndex < 0) return { evicted: 0, inputTokens };

  let evicted = 0;
  for (let index = 2; index < lastAssistantIndex && inputTokens > budgetTokens; index++) {
    const message = messages[index];
    const isPreflightCarrier = message.role === "user"
      && /^\[Runtime (?:preflight:|substitution\])/i.test(message.content);
    if (message.role !== "tool" && !isPreflightCarrier) continue;
    if (message.content.includes("[elided to fit context budget:")) continue;

    const name = message.name || (isPreflightCarrier
      ? (message.content.match(/^\[Runtime ([^\]]+)/i)?.[1] ?? "runtime result")
      : "tool result");
    message.content = `[elided to fit context budget: earlier ${name} result (${message.content.length} chars) removed — re-run the tool if needed]`;
    evicted++;
    inputTokens = measure();
  }

  return { evicted, inputTokens };
}

/** Trim dynamic stage text while preserving both the newest request prefix and
 * the tail where the latest tool effects and terminal status are rendered. */
export function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (!text || budgetTokens <= 0) return "";
  if (countTokens(text) <= budgetTokens) return text;
  let headChars = Math.max(80, Math.floor(budgetTokens * 4 * 0.68));
  let tailChars = Math.max(40, Math.floor(budgetTokens * 4 * 0.24));
  const marker = "\n...[context truncated for latency budget]...\n";
  let output = "";
  while (headChars + tailChars > 120) {
    output = `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
    if (countTokens(output) <= budgetTokens) return output;
    headChars = Math.floor(headChars * 0.9);
    tailChars = Math.floor(tailChars * 0.9);
  }
  return output || text.slice(0, Math.max(1, budgetTokens * 4));
}

/** Newest-first token-budgeted history block for the orchestrator contextMessage. */
export function buildBoundedHistoryBlock(
  turnHistory: Array<{ role: string; content: string }>,
  budgetTokens = 4_000,
  perMessageChars = 1_000,
): string {
  if (budgetTokens <= 0 || turnHistory.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (let index = turnHistory.length - 1; index >= 0; index--) {
    const message = turnHistory[index];
    const line = `[${message.role.toUpperCase()}]: ${message.content.slice(0, perMessageChars)}${message.content.length > perMessageChars ? "..." : ""}`;
    const cost = countTokens(line);
    if (used + cost > budgetTokens && lines.length > 0) break;
    lines.unshift(line);
    used += cost;
  }
  const dropped = turnHistory.length - lines.length;
  return (dropped > 0 ? `[... ${dropped} earlier message(s) omitted for context budget ...]\n` : "")
    + lines.join("\n");
}
