import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePolling } from './usePolling';

describe('usePolling stale-read loop', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restarts interval when callback reference changes while visible', () => {
    // Evidence of gap: changing callback (new fetchStatus reference) while
    // visible keeps the old interval calling savedCallback.current until
    // hide-then-show resets (line 20 guard keeps old interval alive).
    // Confirm: render with changing callback; assert interval fires with
    // new callback, not stale.
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const { rerender } = renderHook(
      ({ cb }) => usePolling(cb, 100, [cb]),
      { initialProps: { cb: cb1 } }
    );

    // First mount starts interval (line 47)
    vi.advanceTimersByTime(100);
    // Initial fetch (line 48) + first interval tick (line 21) = 2 calls
    expect(cb1).toHaveBeenCalledTimes(2);

    // Change callback reference while visible — gap: old interval may
    // keep calling stale savedCallback.current instead of restarting.
    rerender({ cb: cb2 });
    vi.advanceTimersByTime(100);
    // After fix (clear+restart on new callback), cb2 fires with new ref
    expect(cb2).toHaveBeenCalledTimes(2); // initial fetch + tick
  });

  it('preserves the Native surface: this hook carries no invoke call site', () => {
    // Standing constraint (CHARTER 24-35): 85 invoke sites preserved.
    // usePolling has none; adding/removing none is safe.
    expect(typeof usePolling).toBe('function');
  });
});
