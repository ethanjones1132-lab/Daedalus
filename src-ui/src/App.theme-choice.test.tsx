// The header's theme toggle, and the one thing it could not say before.
//
// The operator flips the toggle, the UI changes immediately, and nothing in the
// app could tell them whether the choice was stored. `useTheme` wrote to
// localStorage in a `try`/`catch` that ignored the failure and then to
// `invoke('set_setting', …).catch(() => { /* best-effort */ })`, so a write that
// never landed was indistinguishable from one that did, and the next launch's
// reconcile applied the durable value silently over the local one.
//
// These contracts are written against the header first: the fixed sentence has to
// appear on the toggle, be announced, and not outlive its own failure as a toast.
// The confirmed half is the other side of the same row — a confirmed write
// announces nothing at all and a confirmed light theme still renders light.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
// The exact sentences the operator reads beside the toggle, as literals rather
// than imports: a copy change has to fail these contracts instead of following
// the code silently.
const SAVING = 'Saving theme choice…';
const NOT_STORED =
  'Daedalus could not store this theme in its own settings, so it is only kept by this browser profile.';
const STORED_UNKNOWN =
  'Daedalus could not read its stored theme, so the choice shown here may not be the one you saved.';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
// Both have their own read and their own liveness contracts; this row is about
// the header's theme control, and a live strip would add announcements to every
// query in this file.
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));

const NATIVE_DETAIL = 'SQLITE_BUSY: Native store is locked (/Users/operator/.jarvis/daedalus.sqlite3)';

interface Pending<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Pending<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let store: Record<string, string>;
let reads: Pending<unknown>[];
let writes: Pending<void>[];

// A fake settings store, not an always-resolving mock: the claim under test is
// what the store holds afterwards, and a mock that always resolved could not tell
// a stored value from an attempt. A write commits only once it resolves.
beforeEach(() => {
  localStorage.setItem('jarvis-current-view', 'sessions');
  store = {};
  reads = [];
  writes = [];
  listenMock.mockReset();
  listenMock.mockImplementation(async () => () => {});
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args?: Record<string, string>) => {
    if (command === 'get_setting') {
      const pending = deferred<unknown>();
      reads.push(pending);
      return pending.promise;
    }
    if (command === 'set_setting') {
      const pending = deferred<void>();
      writes.push(pending);
      return pending.promise.then(() => {
        store[args?.key ?? ''] = args?.value ?? '';
      });
    }
    if (command === 'get_action_registry_alerts') return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const mount = async () => { await act(async () => { render(<App />); }); };
const toggle = () => screen.getByRole('button', { name: /Switch to .* theme/ });
// The announcement belongs to the toggle, so the query is scoped to the header
// control group the toggle lives in — a toast is somewhere else entirely.
const controls = () => toggle().parentElement as HTMLElement;
const announcement = () => within(controls()).queryByRole('status');
const answerRead = async (index: number, outcome: 'resolve' | 'reject', value: unknown = null) => {
  const read = reads[index];
  if (!read) throw new Error(`no get_setting attempt #${index}`);
  await act(async () => {
    if (outcome === 'resolve') read.resolve(value);
    else read.reject(new Error(NATIVE_DETAIL));
  });
};
const answerWrite = async (index: number, outcome: 'resolve' | 'reject') => {
  const write = writes[index];
  if (!write) throw new Error(`no set_setting attempt #${index}`);
  await act(async () => {
    if (outcome === 'resolve') write.resolve();
    else write.reject(new Error(NATIVE_DETAIL));
  });
};

describe('the theme toggle reports whether the choice was stored', () => {
  it('says what it is doing while the write is in flight, and keeps the toggle usable', async () => {
    await mount();
    await answerRead(0, 'resolve');

    fireEvent.click(toggle());
    await waitFor(() => expect(writes).toHaveLength(1));

    await waitFor(() => expect(announcement()).toHaveTextContent(SAVING));
    // An in-flight write is not a failure, and it must not stop the operator
    // from changing their mind again.
    expect(toggle()).toBeEnabled();
    expect(toggle()).toHaveAccessibleName('Switch to dark theme');
  });

  it('announces a rejected write once, on the toggle, without the native reason', async () => {
    await mount();
    await answerRead(0, 'resolve');

    fireEvent.click(toggle());
    await answerWrite(0, 'reject');

    await waitFor(() => expect(announcement()).toHaveTextContent(NOT_STORED));
    // Polite, not an interrupting alert: a toast that outlives its own failure
    // is the alternative this row rejects.
    expect(announcement()).toHaveAttribute('role', 'status');
    expect(screen.getAllByText(NOT_STORED)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('SQLITE_BUSY');
    expect(document.body.textContent).not.toContain('daedalus.sqlite3');
    // The toggle is still the operator's: its label and its glyph keep working.
    expect(toggle()).toHaveAccessibleName('Switch to dark theme');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('says nothing beside the toggle once the store has confirmed the choice', async () => {
    await mount();
    await answerRead(0, 'resolve');

    fireEvent.click(toggle());
    await waitFor(() => expect(writes).toHaveLength(1));
    await answerWrite(0, 'resolve');

    await waitFor(() => expect(announcement()).toBeNull());
    // The confirmed half of this row: light is light, and a confirmed write
    // raises nothing at all.
    expect(store.theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(toggle()).toHaveTextContent('☀');
  });

  it('announces a durable read it could not make', async () => {
    await mount();
    await answerRead(0, 'reject');

    await waitFor(() => expect(announcement()).toHaveTextContent(STORED_UNKNOWN));
    expect(document.body.textContent).not.toContain('SQLITE_BUSY');
  });

  it('makes no claim about storage before the durable read has answered', async () => {
    await mount();

    // The mount read has not come back, so the toggle knows neither whether a
    // stored theme exists nor whether the local choice matches it.
    expect(announcement()).toBeNull();
    expect(reads).toHaveLength(1);
  });

  it('lets a confirmed stored theme win over the browser profile on launch', async () => {
    localStorage.setItem('jarvis-theme', 'light');
    await mount();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await answerRead(0, 'resolve', 'dark');

    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBeNull());
    expect(toggle()).toHaveAccessibleName('Switch to light theme');
  });
});
