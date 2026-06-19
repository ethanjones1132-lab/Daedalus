import { useEffect, useRef, useCallback } from 'react';

/**
 * Visibility-aware polling hook.
 * Only polls when the document is visible (tab is active).
 * Immediately fetches on mount, then polls at the given interval.
 * Cleans up on unmount.
 */
export function usePolling(
  callback: () => void,
  intervalMs: number,
  deps: unknown[] = []
) {
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback(() => {
    if (intervalRef.current) return; // already polling
    intervalRef.current = setInterval(() => {
      savedCallback.current();
    }, intervalMs);
  }, [intervalMs]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Start/stop based on visibility
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        savedCallback.current(); // immediate fetch when becoming visible
        startPolling();
      }
    };

    // Initial fetch + start polling if visible
    savedCallback.current();
    if (!document.hidden) {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [startPolling, stopPolling, ...deps]);
}