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
