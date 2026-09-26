import { useEffect, useRef, useCallback } from 'react';
import { createReadGuard, type ReadIdentity } from '../lib/read-identity';

/**
 * Visibility-aware polling hook.
 * Only polls when the document is visible (tab is active).
 * Immediately fetches on mount, then polls at the given interval.
 * Cleans up on unmount.
 *
 * Every dispatch — mount, interval tick, visibility re-read — issues a read,
 * because a read that hangs must never be able to block a newer observation.
 * What the hook now owns is the read's *identity*: each callback receives a
 * `ReadIdentity` and can test `read.isCurrent()` before it publishes, so a
 * response that resolves after a newer one is dropped instead of reverting the
 * surface. That guard used to be a hand-rolled `requestId` ref in each caller
 * (and was missing entirely from one of them), so it is here now.
 */
export function usePolling(
  callback: (read: ReadIdentity) => void | PromiseLike<unknown>,
  intervalMs: number,
  deps: unknown[] = []
) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const guardRef = useRef(createReadGuard());

  const run = useCallback(() => {
    savedCallback.current(guardRef.current.issue());
  }, []);

  const startPolling = useCallback(() => {
    if (intervalRef.current) return; // already polling
    intervalRef.current = setInterval(() => {
      run();
    }, intervalMs);
  }, [intervalMs, run]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Start/stop based on visibility; also restart on dependency change
  // so a new callback reference (e.g., new fetchStatus) does not keep
  // calling a stale savedCallback.current (stale-read loop, line 20).
  useEffect(() => {
    stopPolling(); // restart on any dependency change (clear old interval first)
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        run(); // immediate fetch when becoming visible
        startPolling();
      }
    };

    // Initial fetch + start polling if visible
    run();
    if (!document.hidden) {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [startPolling, stopPolling, run, ...deps]);
}
