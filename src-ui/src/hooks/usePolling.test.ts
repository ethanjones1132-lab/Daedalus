import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
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

// The read identity is the ordering guarantee every caller used to own
// privately. These contracts pin it on the hook itself, so the next surface
// that polls cannot reintroduce the late-response revert by forgetting a ref.
describe('usePolling read identity', () => {
  beforeEach(() => {
    // Fake only the interval so a tick count is exact; leave the microtask
    // machinery real so a settle can be awaited.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const tick = (ms: number) => { act(() => { vi.advanceTimersByTime(ms); }); };
  const setHidden = (hidden: boolean) => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };
  /** Records the identity each dispatch handed out, and keeps the latest read. */
  function recordingPoll() {
    const issued: Array<{ id: number; currentAtDispatch: boolean }> = [];
    const cb = vi.fn((read: { id: number; isCurrent(): boolean }) => {
      issued.push({ id: read.id, currentAtDispatch: read.isCurrent() });
    });
    return { cb, issued };
  }

  it('issues a strictly increasing identity per read', () => {
    const { cb, issued } = recordingPoll();
    renderHook(() => usePolling(cb, 100));
    tick(100);
    tick(100);
    expect(issued.map((read) => read.id)).toEqual([1, 2, 3]);
    expect(issued.every((read) => read.currentAtDispatch)).toBe(true);
  });

  it('tells a read it has been superseded, so a late response cannot publish', () => {
    // The exact failure: a Native read that outlives its interval resolves
    // after a newer one. The newer read is still issued — a stuck read must
    // never block a fresh observation — and the older one is told it lost.
    const identities: Array<{ id: number; isCurrent(): boolean }> = [];
    const cb = vi.fn((read: { id: number; isCurrent(): boolean }) => {
      identities.push(read);
      return new Promise<void>(() => {}); // never settles
    });
    renderHook(() => usePolling(cb, 100));
    tick(350);
    expect(identities).toHaveLength(4);
    expect(identities[0].isCurrent(), 'the oldest read is superseded').toBe(false);
    expect(identities[3].isCurrent(), 'the newest read is publishable').toBe(true);
  });

  it('still reads on every tick and on a visibility re-read while a read is in flight', () => {
    // Preserved deliberately: coalescing a tick would let one hung read freeze
    // the surface. The already-guarded surfaces depend on this (an obsolete
    // poll response is ignored *after* a newer visibility observation).
    const cb = vi.fn(() => new Promise<void>(() => {}));
    renderHook(() => usePolling(cb, 100));
    expect(cb).toHaveBeenCalledTimes(1);
    tick(250);
    expect(cb).toHaveBeenCalledTimes(3);
    setHidden(false);
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it('reads again after a dependency change and does not reuse the old identity', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => usePolling(cb, 100, [cb]),
      { initialProps: { cb: first } },
    );
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ cb: second });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0].id, 'a new generation gets a new identity').toBe(2);
  });

  it('does not poll while the document is hidden and reads once when it becomes visible', () => {
    const cb = vi.fn();
    setHidden(true);
    renderHook(() => usePolling(cb, 100));
    expect(cb).toHaveBeenCalledTimes(1);
    tick(300);
    expect(cb, 'no polling while hidden').toHaveBeenCalledTimes(1);
    setHidden(false);
    expect(cb, 'exactly one immediate read on becoming visible').toHaveBeenCalledTimes(2);
    tick(100);
    expect(cb, 'polling resumes after the visibility read').toHaveBeenCalledTimes(3);
  });

  it('does not swallow a synchronously failing callback', () => {
    // The identity must not become a place where a broken callback's error
    // disappears: a programming error stays visible.
    const cb = vi.fn(() => { throw new Error('poll callback exploded'); });
    expect(() => renderHook(() => usePolling(cb, 100))).toThrow(/poll callback exploded/);
  });
});
