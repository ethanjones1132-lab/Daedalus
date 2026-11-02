// ═══════════════════════════════════════════════════════════════
// ── Verified web-search state ──
// ═══════════════════════════════════════════════════════════════
// DD-048 / DD-T2: the Ollama/OpenRouter single-pass loop treated the NAME of a
// tool call as proof that the required web search had happened. All three live
// consumers — the forced search, the text-fallback tool loop, and the native
// tool loop — assigned `verifiedWebSearchDone = true` unconditionally, so a
// failed search (provider outage, timeout, cancellation, handler error) was
// still reported as verified evidence and suppressed the honest "not verified"
// path for the rest of the turn.
//
// This module owns the one transition those consumers share:
//
//   next state = prior state || this result is a successful web_search
//
// "Successful" means the canonical ToolRuntime returned a non-error result for
// the `web_search` tool. A failed search, an unrelated tool, or a rejected call
// leaves the flag untouched. Once a search has succeeded the flag stays true
// even if a later search fails: prior successful evidence is not erased by a
// later failure.
//
// This is not a search or retry policy. The forced-attempt guard
// (`forcedWebSearchDone`), the tool attempt counts, the error frames/history,
// cancellation, and the turn ceiling still bound the loop exactly as before.

/** The canonical tool name whose successful result is verified evidence. */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * The part of a canonical `ToolResult` this transition reads. Kept structural
 * so callers can pass the runtime envelope directly and tests can pin the same
 * shape without importing the server entry point.
 */
export interface ToolOutcomeLike {
  is_error?: boolean;
}

/**
 * Whether one executed tool result is successful `web_search` evidence.
 *
 * Fail-closed: only an explicit `is_error: false` from the runtime counts. A
 * missing/unknown flag is not proof that a search succeeded.
 */
export function isSuccessfulWebSearchResult(
  toolName: string,
  result: ToolOutcomeLike | null | undefined,
): boolean {
  return toolName === WEB_SEARCH_TOOL_NAME && result?.is_error === false;
}

/**
 * The verified-web-search flag after recording one executed tool result.
 *
 * Sticky: a previously verified turn stays verified. Otherwise only a
 * successful `web_search` result can turn the flag on; failures and unrelated
 * tools return the prior state unchanged.
 */
export function nextVerifiedWebSearchState(
  current: boolean,
  toolName: string,
  result: ToolOutcomeLike | null | undefined,
): boolean {
  if (current) return true;
  return isSuccessfulWebSearchResult(toolName, result);
}
