/**
 * Session-scroll persistence (Jarvis scroll-state exception, Phase 0).
 * Stores scroll offset per session id so rename / reload preserves position.
 * User-facing outcome: scroll preserved; not a restructuring.
 */
export interface ScrollState {
  offset: number;
  pinnedToBottom: boolean;
}

const store = new Map<string, ScrollState>();

export const sessionScroll = {
  save(sessionId: string, state: ScrollState) {
    store.set(sessionId, state);
  },
  load(sessionId: string): ScrollState | undefined {
    return store.get(sessionId);
  },
  clear(sessionId: string) {
    store.delete(sessionId);
  },
};
