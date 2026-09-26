/**
 * Read identity — the ordering guard shared by every self-refreshing surface.
 *
 * Ordering used to be each caller's private responsibility. `usePolling` fired
 * its callback on a bare `setInterval` with no identity of any kind, so a Native
 * read that outlived its interval could resolve *after* a newer one and silently
 * revert the surface — no error, no stale marker, just a list that goes
 * backwards. Four callers survived it only because someone remembered a
 * `requestId` or `pending` ref written by hand, and the one caller that did not
 * could render one Session's header over another Session's transcript.
 *
 * The property that matters is newest-wins, not coalescing: a read that hangs
 * must never be able to block a newer observation, so a tick or a visibility
 * re-read is always issued and the older response is the one that is dropped.
 * The four already-guarded surfaces pin exactly that (an obsolete poll response
 * ignored after a newer visibility observation), so this module supplies the
 * identity rather than changing which reads happen.
 *
 * Pure: no React, no Tauri, no clock.
 */

/** The identity handed to one read, and the test of whether it is still newest. */
export interface ReadIdentity {
  /** Monotonic within the guard that issued it; never reused. */
  readonly id: number;
  /** True only while no newer read has been issued. */
  isCurrent(): boolean;
}

export interface ReadGuard {
  /** Issue the identity for a read that is starting now. */
  issue(): ReadIdentity;
  /** The newest identity issued so far (0 before the first read). */
  latest(): number;
  /** Whether `id` is still the newest identity issued. */
  isCurrent(id: number): boolean;
  /**
   * Run `apply` only while `id` is the newest identity, and report whether it
   * ran. A superseded observation is dropped here rather than published.
   */
  publish(id: number, apply: () => void): boolean;
}

export function createReadGuard(): ReadGuard {
  let newest = 0;
  const isCurrent = (id: number) => id > 0 && id === newest;
  return {
    issue() {
      newest += 1;
      const id = newest;
      return { id, isCurrent: () => isCurrent(id) };
    },
    latest() {
      return newest;
    },
    isCurrent,
    publish(id, apply) {
      if (!isCurrent(id)) return false;
      apply();
      return true;
    },
  };
}
