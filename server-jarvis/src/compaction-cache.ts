// ── Cached compaction application for the agent loop ──────────────
// A compaction cache entry records the pre-turn history slice it replaced
// (`originalLength` + `prefixHash`) and the summary message it produced from
// that slice. The entry is safe to re-apply only on the first iteration of a
// user turn, while `activeHistory` still mirrors the pre-turn history.
//
// Once the loop appends this turn's user ask, assistant tool call, or tool
// result to `activeHistory`, rebuilding from `originalHistory` would replace
// that in-turn tool history with the pre-turn slice and drop the ask (the ask
// is only carried by `currentPrompt` until it is appended). Cross-turn cache
// reuse is unchanged: a later user turn starts a fresh `originalHistory`, so
// its first iteration may still rebuild from the cached summary.

export interface CompactionCacheEntry {
  originalLength: number;
  prefixHash: string;
  summary: any;
}

/** Stable hash of the role/content prefix a cache entry was built from. */
export function getMessagesHash(messages: Array<any>): string {
  return messages.map((m) => `${m.role}:${m.content || ""}`).join("|");
}

export interface ApplyCachedCompactionInput {
  /** Live working history for the current agent-loop iteration. */
  activeHistory: Array<any>;
  /** Snapshot of history taken before this user turn began. */
  originalHistory: Array<any>;
  cached: CompactionCacheEntry | undefined;
  /**
   * True once this turn has appended its own ask, assistant tool call, or
   * tool result to `activeHistory`. Such messages never land in
   * `originalHistory`, so the pre-turn rebuild must not run again.
   */
  inTurnHistoryAppended: boolean;
}

export interface ApplyCachedCompactionResult {
  /** `activeHistory` unchanged, or the rebuilt summary prefix plus tail. */
  history: Array<any>;
  applied: boolean;
}

/**
 * Apply a cached compaction prefix only while the current turn still matches
 * the pre-turn history it was built from. Returns the live history untouched
 * on every later loop iteration of the same turn.
 */
export function applyCachedCompaction(
  input: ApplyCachedCompactionInput,
): ApplyCachedCompactionResult {
  const { activeHistory, originalHistory, cached, inTurnHistoryAppended } = input;
  if (!cached || inTurnHistoryAppended) {
    return { history: activeHistory, applied: false };
  }
  if (originalHistory.length < cached.originalLength) {
    return { history: activeHistory, applied: false };
  }
  const prefix = originalHistory.slice(0, cached.originalLength);
  if (getMessagesHash(prefix) !== cached.prefixHash) {
    return { history: activeHistory, applied: false };
  }
  return {
    history: [cached.summary, ...originalHistory.slice(cached.originalLength)],
    applied: true,
  };
}
