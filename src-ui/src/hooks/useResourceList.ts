// ═══════════════════════════════════════════════════════════════
// ── useResourceList<T> — DRY fetch/loading/error/refetch pattern
// ═══════════════════════════════════════════════════════════════
//
// Encapsulates the boilerplate that appeared in all 9 list views added in the
// restore session (Skills, Agents, Channels, Devices, Nodes, Hooks,
// Commitments, Approvals, Plugins). Views that need it just call:
//
//   const { items, loading, error, refetch } = useResourceList<Skill>(
//     () => invoke<Skill[]>('list_skills'),
//   );
//
// For views that fetch multiple lists (e.g. AgentsView fetches agents AND
// channels), use two hook calls or pass a mapper that returns an array from a
// multi-fetch.

import { useCallback, useEffect, useState } from 'react';

export interface ResourceListState<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetches a list of resources on mount and exposes a `refetch` callback.
 * @param fetchFn - async function that resolves to T[]; called on mount + refetch.
 * @param deps    - additional dependency array for the fetch function (default []).
 */
export function useResourceList<T>(
  fetchFn: () => Promise<T[]>,
  deps: readonly unknown[] = [],
): ResourceListState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchFn());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { fetch(); }, [fetch]);

  return { items, loading, error, refetch: fetch };
}
