import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryTierCounts from './MemoryTierCounts';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => { invokeMock.mockReset(); });
afterEach(cleanup);

describe('memory tier count request ownership', () => {
  it('restarts its mount read in StrictMode and ignores the retired response', async () => {
    const retired = deferred<unknown>();
    const current = deferred<unknown>();
    const refresh = deferred<unknown>();
    invokeMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise).mockReturnValueOnce(refresh.promise);
    render(<StrictMode><MemoryTierCounts /></StrictMode>);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'jarvis_get_tier_stats');
    const retry = screen.getByRole('button', { name: 'Retry tier counts' });
    expect(retry).toBeDisabled();
    await act(async () => retired.resolve({ hot: 99, warm: 99, cold: 99 }));
    expect(retry).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Reading memory tier counts');
    await act(async () => current.resolve({ hot: 3, warm: 2, cold: 1 }));
    expect(retry).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Memory tier counts' })).getByText('hot')).toHaveTextContent('hot 3');
    fireEvent.click(retry);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    await act(async () => refresh.resolve({ hot: 4, warm: 2, cold: 1 }));
    expect(retry).toBeEnabled();
    expect(within(screen.getByRole('region', { name: 'Memory tier counts' })).getByText('hot')).toHaveTextContent('hot 4');
  });

  it('enables retry after StrictMode read failure and retains ownership during retry', async () => {
    const retired = deferred<unknown>();
    const current = deferred<unknown>();
    const refresh = deferred<unknown>();
    invokeMock.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise).mockReturnValueOnce(refresh.promise);
    render(<StrictMode><MemoryTierCounts /></StrictMode>);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await act(async () => current.reject(new Error('unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the memory tier counts.');
    const retry = screen.getByRole('button', { name: 'Retry tier counts' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    await act(async () => retired.reject(new Error('retired failure')));
    expect(retry).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => refresh.resolve({ hot: 1, warm: 0, cold: 0 }));
    expect(retry).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
