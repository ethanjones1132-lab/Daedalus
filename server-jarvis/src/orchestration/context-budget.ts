import { countTokens } from "../tokens";

/** Newest-first token-budgeted history block for the orchestrator contextMessage. */
export function buildBoundedHistoryBlock(
  turnHistory: Array<{ role: string; content: string }>,
  budgetTokens = 4_000,
  perMessageChars = 1_000,
): string {
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
