import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the Tauri IPC layer — useTheme persists via invoke('set_setting') and
// reconciles via invoke('get_setting'); neither exists outside the Tauri runtime.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { useTheme } from './useTheme';

function dataTheme(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null); // get_setting -> no stored preference
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('useTheme', () => {
  it('defaults to dark with no data-theme attribute', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(dataTheme()).toBeNull();
  });

  it('toggles to light: sets data-theme, persists to localStorage and set_setting', () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggle());

    expect(result.current.theme).toBe('light');
    expect(dataTheme()).toBe('light');
    expect(localStorage.getItem('jarvis-theme')).toBe('light');
    expect(invokeMock).toHaveBeenCalledWith('set_setting', { key: 'theme', value: 'light' });
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

describe('useTheme across instances', () => {
  it('keeps every mounted instance in sync when one changes the theme', () => {
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());
    act(() => a.result.current.setTheme('light'));
    expect(b.result.current.theme).toBe('light');
    act(() => b.result.current.toggle());
    expect(a.result.current.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('shared theme mount-read ownership', () => {
  it('preserves initial durable reconciliation while instances broadcast their boot theme', async () => {
    const aRead = deferred<string | null>();
    const bRead = deferred<string | null>();
    const reads = [aRead, bRead];
    invokeMock.mockImplementation(() => reads.shift()!.promise);
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());
    await act(async () => aRead.resolve('light'));
    await act(async () => bRead.resolve('light'));
    expect(a.result.current.theme).toBe('light');
    expect(b.result.current.theme).toBe('light');
    expect(a.result.current.choice.readStatus).toBe('confirmed');
    expect(b.result.current.choice.readStatus).toBe('confirmed');
    expect(a.result.current.choice.durable).toBe('light');
    expect(b.result.current.choice.durable).toBe('light');
  });

  it.each(['resolve', 'reject'] as const)('retires a peer mount read that %s after a newer theme choice', async (completion) => {
    const shellRead = deferred<string | null>();
    const peerRead = deferred<string | null>();
    const write = deferred<void>();
    const reads = [shellRead, peerRead];
    invokeMock.mockImplementation((command: string) => command === 'get_setting' ? reads.shift()!.promise : write.promise);
    const shell = renderHook(() => useTheme());
    const peer = renderHook(() => useTheme());
    act(() => shell.result.current.setTheme('light'));
    await act(async () => write.resolve());
    await act(async () => {
      if (completion === 'resolve') peerRead.resolve('dark');
      else peerRead.reject(new Error('old read failed'));
      shellRead.resolve('dark');
    });
    expect(shell.result.current.theme).toBe('light');
    expect(peer.result.current.theme).toBe('light');
    expect(dataTheme()).toBe('light');
    expect(shell.result.current.choice.confirmed).toBe(true);
    expect(shell.result.current.choice.durable).toBe('light');
    expect(peer.result.current.choice.status).toBe('quiet');
  });

  it('retires peer mount reads when an explicit choice keeps the current theme', async () => {
    const shellRead = deferred<string | null>();
    const peerRead = deferred<string | null>();
    const reads = [shellRead, peerRead];
    invokeMock.mockImplementation((command: string) => command === 'get_setting' ? reads.shift()!.promise : Promise.resolve());
    const shell = renderHook(() => useTheme());
    const peer = renderHook(() => useTheme());
    act(() => shell.result.current.setTheme('dark'));
    await act(async () => { peerRead.resolve('light'); shellRead.resolve('light'); });
    expect(shell.result.current.theme).toBe('dark');
    expect(peer.result.current.theme).toBe('dark');
    expect(dataTheme()).toBeNull();
    expect(shell.result.current.choice.durable).toBe('dark');
  });

  it('preserves the writing instance refusal after retiring a peer mount read', async () => {
    const shellRead = deferred<string | null>();
    const peerRead = deferred<string | null>();
    const write = deferred<void>();
    const reads = [shellRead, peerRead];
    invokeMock.mockImplementation((command: string) => command === 'get_setting' ? reads.shift()!.promise : write.promise);
    const shell = renderHook(() => useTheme());
    const peer = renderHook(() => useTheme());
    act(() => shell.result.current.setTheme('light'));
    await act(async () => write.reject(new Error('store refused')));
    await act(async () => { peerRead.resolve('dark'); shellRead.resolve('dark'); });
    expect(shell.result.current.theme).toBe('light');
    expect(peer.result.current.theme).toBe('light');
    expect(shell.result.current.choice.confirmed).toBe(false);
    expect(shell.result.current.choice.status).toBe('not-stored');
    expect(shell.result.current.choice.message).toBe('Daedalus could not store this theme in its own settings, so it is only kept by this browser profile.');
  });
});
