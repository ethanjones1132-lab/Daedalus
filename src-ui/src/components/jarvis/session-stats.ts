/**
 * Session stats — pure formatting helpers for the cumulative
 * per-session token/turn rollup surfaced in the JarvisView chat header.
 *
 * The session total is computed client-side from the `orchestration_metrics`
 * SSE frame's `tokens_total` field that arrives at the end of each turn
 * (already wired into JarvisView as `runMetrics.tokens`). The helper below
 * just formats the cumulative number for display and is intentionally
 * independent of React / Tauri / state so it can be unit-tested in isolation.
 *
 * Format policy (pinned so the surface can't silently drift):
 *   tokens < 1_000       -> "<n> tok"          (e.g. "423 tok")
 *   tokens < 1_000_000   -> "<n.n>k tok"       (one decimal, e.g. "12.4k tok")
 *   tokens >= 1_000_000  -> "<n.nn>M tok"      (two decimals, e.g. "1.23M tok")
 *
 * `turnCount` formatting:
 *   0            -> ""  (no display, the pill is hidden entirely at 0)
 *   1            -> "1 turn"
 *   N >= 2       -> "<N> turns"
 *
 * `formatSessionStatsLine({tokens, turnCount})` is the canonical string
 * used by the Session Stats pill. It combines the token formatter and the
 * turn counter with a "·" separator (omits the separator when turns=0
 * or turns=1 to avoid the visual "1.2k tok · 1 turn" noise on a fresh
 * session where the user just finished their first response).
 */

export const SESSION_STATS_HIDDEN_TURN_THRESHOLD = 0;
export const SESSION_STATS_TURN_SINGULAR_CAP = 1;

export interface SessionStatsInput {
  /** Cumulative tokens across all completed turns in the active session. */
  tokens: number;
  /** Number of completed turns in the active session. */
  turnCount: number;
}

export function formatSessionTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0 tok';
  if (tokens < 1_000) return `${Math.round(tokens)} tok`;
  if (tokens < 1_000_000) {
    const k = tokens / 1_000;
    // Always one decimal in the k range (e.g. "1.2k tok", "12.4k tok", "100.0k tok",
    // "999.9k tok"). Using a fixed one-decimal width keeps the column visually stable
    // as the count grows.
    const rounded = Math.round(k * 10) / 10;
    return `${rounded.toFixed(1)}k tok`;
  }
  const m = tokens / 1_000_000;
  const rounded = Math.round(m * 100) / 100;
  return `${rounded.toFixed(2)}M tok`;
}

export function formatSessionTurnCount(turnCount: number): string {
  // We intentionally hide the turn counter when the user has only 1 completed
  // turn in the session — surfacing "12.4k tok · 1 turn" right after the
  // assistant's first reply adds visual noise without useful signal. The
  // counter becomes informative at 2+ where the user is having a back-and-forth
  // and the rollup shows how many turns of context have accumulated.
  if (!Number.isFinite(turnCount) || turnCount < 2) return '';
  return `${turnCount} turns`;
}

export function shouldShowSessionStats(turnCount: number): boolean {
  return Number.isFinite(turnCount) && turnCount > SESSION_STATS_HIDDEN_TURN_THRESHOLD;
}

export function formatSessionStatsLine({ tokens, turnCount }: SessionStatsInput): string {
  const tokenPart = formatSessionTokenCount(tokens);
  const turnPart = formatSessionTurnCount(turnCount);
  if (!turnPart) return tokenPart;
  return `${tokenPart} · ${turnPart}`;
}
