/**
 * Session list search/filter — pure helper for the Jarvis SessionsPanel.
 *
 * The SessionsPanel used to render every session the backend returned with no
 * way to narrow it down. With a few dozen sessions that becomes a wall of
 * buttons the user has to scroll through to find anything. This helper
 * filters by:
 *   - session name (the user-facing label, takes precedence when set)
 *   - session title (the alternate label, same precedence rules)
 *   - session id prefix (so a user can paste a UUID slice to jump to a row)
 *   - model name (so "find my gemma session" works without remembering titles)
 *   - backend (so "all my openrouter sessions" works)
 *
 * Subsequence-fuzzy match (same idea as CommandPalette.filterNavItems):
 * characters in the query must appear in order in the target string,
 * case-insensitive, after trimming. This is permissive enough that a query
 * like "gemma" matches "Gemma 3 27B" and "gemma4:e2b" without forcing the
 * user to type the full token.
 *
 * Empty / whitespace-only query is a no-op (returns the input array verbatim,
 * preserving order and identity so React's keying is stable).
 *
 * Exports a few pin-able thresholds so the surface can't silently drift:
 *   - `MIN_QUERY_LENGTH = 1` — single-character queries are honored, since
 *     a 1-char query is still useful when you have 200 sessions and remember
 *     "the one that started with Q".
 *   - `MAX_RESULTS = 200` — caps the rendered list so a degenerate query
 *     (e.g. just a space) doesn't materialize every session if a future
 *     change relaxes the empty-query no-op.
 */
export const MIN_QUERY_LENGTH = 1;
export const MAX_RESULTS = 200;

/** A single normalized target string, lowercased and trimmed. */
function normalize(s: string | undefined | null): string {
  return (s ?? '').toString().toLowerCase().trim();
}

/** Subsequence-fuzzy match. `query` must be a non-empty trimmed string. */
function matchesQuery(target: string, query: string): boolean {
  // Already lowercased by normalize, but defensive.
  const t = target.toLowerCase();
  let i = 0;
  for (const ch of query) {
    i = t.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

export interface FilterableSession {
  id: string;
  name?: string | null | undefined;
  title?: string | null | undefined;
  model: string;
  backend: string;
}

/**
 * Filter a list of sessions by a free-text query. Pure — does not mutate the
 * input array. Returns the same reference when the query is empty/whitespace
 * so React's keying stays stable (no spurious remounts while the user is
 * typing-then-deleting the search box).
 *
 * The result is capped at `MAX_RESULTS` to bound render cost. When the cap
 * is hit, the returned array is the FIRST `MAX_RESULTS` matches in input
 * order (not a sorted subset) — the sessions list is already newest-first
 * in practice, so this is the natural ordering.
 */
export function filterSessions<T extends FilterableSession>(
  sessions: T[],
  rawQuery: string,
): T[] {
  const query = normalize(rawQuery);
  if (query.length < MIN_QUERY_LENGTH) return sessions;
  const out: T[] = [];
  for (const s of sessions) {
    // A session matches if ANY of the five searchable fields is a
    // subsequence-match. The fields are joined into a single haystack so we
    // only allocate one string per session per filter call.
    const haystack = [
      normalize(s.name),
      normalize(s.title),
      normalize(s.id),
      normalize(s.model),
      normalize(s.backend),
    ].join('\n');
    if (matchesQuery(haystack, query)) {
      out.push(s);
      if (out.length >= MAX_RESULTS) break;
    }
  }
  return out;
}

/** Human-readable result count, used by the panel for the "(N filtered)" line. */
export function formatFilterResultCount(filtered: number, total: number): string {
  if (filtered === total) return `(${total})`;
  return `(${filtered} of ${total})`;
}
