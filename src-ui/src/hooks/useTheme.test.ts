import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the Tauri IPC layer — useTheme persists via invoke('set_setting') and
// reconciles via invoke('get_setting'); neither exists outside the Tauri runtime.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { useTheme, type Theme } from './useTheme';

// The exact sentences the operator reads, as literals rather than imports: a copy
// change has to fail these contracts instead of following the code silently.
const SAVING = 'Saving theme choice…';
const NOT_STORED =
  'Daedalus could not store this theme in its own settings, so it is only kept by this browser profile.';
const NOT_KEPT =
  'Daedalus could not store this theme anywhere. It may not be there next time you open the app.';
const STORED_UNKNOWN =
  'Daedalus could not read its stored theme, so the choice shown here may not be the one you saved.';

function dataTheme(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null); // get_setting -> no stored preference
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTheme', () => {
  it('defaults to dark with no data-theme attribute', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(dataTheme()).toBeNull();
  });

  it('toggles to light: sets data-theme, keeps it locally, and confirms it in the settings store', async () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggle());

    expect(result.current.theme).toBe('light');
    expect(dataTheme()).toBe('light');
    expect(localStorage.getItem('jarvis-theme')).toBe('light');
    expect(invokeMock).toHaveBeenCalledWith('set_setting', { key: 'theme', value: 'light' });

    // The command being *called* is the attempt, not the outcome. This case used
    // to stop at the call while its name promised a persisted choice, and the
    // always-resolving mock meant a rejecting write was unreachable from any of
    // the six cases — so the name asserted a guarantee nothing checked.
    await waitFor(() => expect(result.current.choice.confirmed).toBe(true));
    expect(result.current.choice.status).toBe('quiet');
    expect(result.current.choice.message).toBeNull();
  });

  it('toggles back to dark: removes the data-theme override', () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggle());
    act(() => result.current.toggle());

    expect(result.current.theme).toBe('dark');
    expect(dataTheme()).toBeNull();
    expect(localStorage.getItem('jarvis-theme')).toBe('dark');
  });

  it('honors an existing localStorage preference on init (flash-free)', () => {
    localStorage.setItem('jarvis-theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(dataTheme()).toBe('light');
  });

  it('reconciles with the durable backend setting on mount', async () => {
    invokeMock.mockResolvedValue('light'); // get_setting -> light
    const { result } = renderHook(() => useTheme());

    // Starts dark from localStorage, then the async get_setting reconciles it.
    expect(result.current.theme).toBe('dark');
    await waitFor(() => expect(result.current.theme).toBe('light'));
    expect(dataTheme()).toBe('light');
  });

  it('setTheme applies and persists an explicit choice', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('light'));
    expect(result.current.theme).toBe('light');
    expect(invokeMock).toHaveBeenCalledWith('set_setting', { key: 'theme', value: 'light' });
  });
});

// The rest of this row. The write is attempted, settled and confirmed are three
// separate facts, and the operator can only see the difference if the hook says
// so. Every case below drives the two real commands through one fake settings
// store, because the claim under test is what survives a relaunch — and a mock
// that always resolved could not tell a stored value from an attempt.
describe('the theme choice says whether it was stored', () => {
  let store: Record<string, string>;
  let reads: Array<ReturnType<typeof deferred<unknown>>>;
  let writes: Array<{ value: string; attempt: ReturnType<typeof deferred<void>> }>;
  let issued: number;
  let newest: Record<string, number>;

  // The fake store only commits a write once it resolves, and only the newest
  // command for a key can win — so a rejected write leaves the store alone and
  // an older write answering late cannot overwrite a newer choice.
  const scriptStore = () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string, args?: Record<string, string>) => {
      const key = args?.key ?? '';
      if (command === 'get_setting') {
        const pending = deferred<unknown>();
        reads.push(pending);
        return pending.promise;
      }
      if (command === 'set_setting') {
        const attempt = deferred<void>();
        const seq = (issued += 1);
        newest[key] = seq;
        writes.push({ value: args?.value ?? '', attempt });
        return attempt.promise.then(() => {
          if (newest[key] === seq) store[key] = args?.value ?? '';
        });
      }
      return Promise.resolve(null);
    });
  };

  const mount = () => renderHook(() => useTheme());
  const readAt = (index: number) => {
    const pending = reads[index];
    if (!pending) throw new Error(`no get_setting attempt #${index}`);
    return pending;
  };
  const writeAt = (index: number) => {
    const write = writes[index];
    if (!write) throw new Error(`no set_setting attempt #${index}`);
    return write;
  };
  const answer = async <T,>(pending: ReturnType<typeof deferred<T>>, outcome: 'resolve' | 'reject', value?: T) => {
    await act(async () => {
      if (outcome === 'resolve') pending.resolve(value as T);
      else pending.reject(new Error('SQLITE_BUSY: Native store is locked'));
    });
  };

  beforeEach(() => {
    store = {};
    reads = [];
    writes = [];
    issued = 0;
    newest = {};
    scriptStore();
  });

  it('announces nothing alarming while the write is in flight, and nothing once it is confirmed', async () => {
    const { result } = mount();
    await answer(readAt(0), 'resolve', null);

    act(() => result.current.toggle());

    // Attempted, not settled, not confirmed — and it says so without claiming a
    // failure that has not happened.
    expect(result.current.choice.attempted).toBe(true);
    expect(result.current.choice.settled).toBe(false);
    expect(result.current.choice.confirmed).toBe(false);
    expect(result.current.choice.status).toBe('saving');
    expect(result.current.choice.message).toBe(SAVING);

    await answer(writeAt(0).attempt, 'resolve');

    expect(result.current.choice.confirmed).toBe(true);
    expect(result.current.choice.status).toBe('quiet');
    expect(result.current.choice.message).toBeNull();
    expect(result.current.choice.durable).toBe('light');
  });

  it('announces a rejected write in one fixed sentence and keeps the choice applied', async () => {
    const { result } = mount();
    await answer(readAt(0), 'resolve', null);

    act(() => result.current.toggle());
    await answer(writeAt(0).attempt, 'reject');

    expect(result.current.choice.status).toBe('not-stored');
    expect(result.current.choice.message).toBe(NOT_STORED);
    expect(result.current.choice.confirmed).toBe(false);
    // The toggle did what the operator asked in this window; only the store
    // refused, so the sentence must not read as "your toggle failed".
    expect(result.current.theme).toBe('light');
    expect(dataTheme()).toBe('light');
    // A native message is not the operator's to read, and the fixed sentence
    // keeps the reason off the surface.
    expect(result.current.choice.message).not.toContain('SQLITE');
  });

  it('says the stronger sentence when the local copy did not land either', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = mount();
    await answer(readAt(0), 'resolve', null);

    act(() => result.current.toggle());
    await answer(writeAt(0).attempt, 'reject');

    // "only kept by this browser profile" is false when the profile kept nothing.
    expect(result.current.choice.message).toBe(NOT_KEPT);
    expect(result.current.theme).toBe('light');
  });

  it('keeps a newer toggle from being confirmed by an older write that answers last', async () => {
    const { result } = mount();
    await answer(readAt(0), 'resolve', null);

    act(() => result.current.toggle()); // -> light, write attempt 0
    act(() => result.current.toggle()); // -> dark,  write attempt 1
    expect(writes.map((write) => write.value)).toEqual(['light', 'dark']);

    await answer(writeAt(1).attempt, 'resolve');
    await answer(writeAt(0).attempt, 'resolve');

    expect(result.current.theme).toBe('dark');
    expect(result.current.choice.durable).toBe('dark');
    expect(result.current.choice.status).toBe('quiet');
    expect(store.theme).toBe('dark');
  });

  it('does not report a failure for a write a newer toggle has replaced', async () => {
    const { result } = mount();
    await answer(readAt(0), 'resolve', null);

    act(() => result.current.toggle());
    act(() => result.current.toggle());

    await answer(writeAt(0).attempt, 'reject');

    // The stale rejection is not news about the choice the operator ended on,
    // and the newer write is still in flight: no alarm, no "saved".
    expect(result.current.choice.confirmed).toBe(false);
    expect(result.current.choice.status).toBe('saving');
    expect(result.current.choice.message).toBe(SAVING);

    await answer(writeAt(1).attempt, 'resolve');

    expect(result.current.choice.confirmed).toBe(true);
    expect(result.current.choice.status).toBe('quiet');
  });

  it('tells a read that could not be made from a store that holds no preference', async () => {
    const unreadable = mount();
    await answer(readAt(0), 'reject');

    // A failed read is announced…
    expect(unreadable.result.current.choice.readStatus).toBe('failed');
    expect(unreadable.result.current.choice.status).toBe('stored-unknown');
    expect(unreadable.result.current.choice.message).toBe(STORED_UNKNOWN);
    // …and it keeps the local choice rather than pretending the store is empty.
    expect(unreadable.result.current.theme).toBe('dark');
    unreadable.unmount();

    const empty = mount();
    await answer(readAt(1), 'resolve', null);

    // The same surface, one confirmed read that simply holds no preference:
    // nothing is announced, because nothing is wrong.
    expect(empty.result.current.choice.readStatus).toBe('confirmed');
    expect(empty.result.current.choice.status).toBe('quiet');
    expect(empty.result.current.choice.message).toBeNull();
  });

  it('lets the durable setting win when it disagrees with the local choice', async () => {
    localStorage.setItem('jarvis-theme', 'light');
    const { result } = mount();

    await answer(readAt(0), 'resolve', 'dark');

    expect(result.current.theme).toBe('dark');
    expect(dataTheme()).toBeNull();
    expect(result.current.choice.durable).toBe('dark');
    expect(result.current.choice.status).toBe('quiet');
  });

  it('keeps a confirmed choice across a relaunch, with the store as the only record', async () => {
    const first = mount();
    await answer(readAt(0), 'resolve', null);
    act(() => first.result.current.setTheme('light'));
    await answer(writeAt(0).attempt, 'resolve');
    expect(first.result.current.choice.confirmed).toBe(true);
    first.unmount();

    // The relaunch. The browser profile still holds the choice, which is exactly
    // why clearing it here is the interesting case: without the settings store
    // the choice is gone, and that is what the durable write is for.
    localStorage.clear();
    const second = mount();
    await answer(readAt(1), 'resolve', null);

    expect(second.result.current.theme).toBe('dark');
    expect(store.theme).toBe('light');

    const third = mount();
    await answer(readAt(2), 'resolve', store.theme);

    expect(third.result.current.theme).toBe('light');
    expect(dataTheme()).toBe('light');
    expect(third.result.current.choice.status).toBe('quiet');
  });

  it('keeps its exported shape', () => {
    const { result } = mount();
    const theme: Theme = result.current.theme;

    expect(theme).toBe('dark');
    expect(typeof result.current.setTheme).toBe('function');
    expect(typeof result.current.toggle).toBe('function');
  });
});
