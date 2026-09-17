import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import type { BackendSession } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));

const alpha: BackendSession = {
  id: 'session-alpha', agent_id: 'agent-alpha', title: 'Alpha', backend: 'ollama',
  model: 'test-model', context_tokens: 1000, total_tokens: 250,
  created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T11:00:00Z',
  archived: false, message_count: 7,
};
function deferred() {
  let resolve!: (value: BackendSession[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<BackendSession[]>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
let requests: ReturnType<typeof deferred>[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  localStorage.setItem('jarvis-current-view', 'sessions');
  requests = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'list_sessions') {
      const request = deferred();
      requests.push(request);
      return request.promise;
    }
    if (['list_cron_jobs', 'list_pending_missed_jobs', 'get_action_registry_alerts'].includes(command)) return [];
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });
const mount = async () => { await act(async () => { render(<App />); }); };
const settle = async (index: number, rows: BackendSession[]) => {
  await act(async () => { requests[index].resolve(rows); });
};
const fail = async (index: number) => {
  await act(async () => { requests[index].reject(new Error('synthetic private native detail')); });
};
const advance = async (ms: number) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const status = () => screen.getByRole('status', { name: 'Session list' });
const refresh = () => screen.getByRole('button', { name: 'Refresh sessions' });
const row = () => screen.getByRole('button', { name: 'Session details: Alpha' });

describe('native Session list recovery', () => {
  it('distinguishes pending from successful empty and makes pending refresh inaccessible', async () => {
    await mount();
    expect(status()).toHaveTextContent('Loading sessions');
    expect(refresh()).toBeDisabled();
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument();
    await settle(0, []);
    expect(screen.queryByRole('status', { name: 'Session list' })).not.toBeInTheDocument();
    expect(screen.getByText('No sessions yet.')).toBeInTheDocument();
    expect(refresh()).toBeEnabled();
  });

  it('offers immediate guarded Retry after initial rejection without exposing native detail', async () => {
    await mount();
    await fail(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sessions.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(screen.queryByText('No sessions yet.')).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(status()).toHaveTextContent('Loading sessions');
    expect(requests).toHaveLength(2);
    await settle(1, [alpha]);
    expect(row()).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains expanded disclosure identity through failed polling and pending recovery', async () => {
    await mount();
    await settle(0, [alpha]);
    fireEvent.click(row());
    const regionId = row().getAttribute('aria-controls')!;
    await advance(15000);
    expect(status()).toHaveTextContent('Refreshing sessions');
    expect(row()).toHaveAttribute('aria-expanded', 'true');
    await fail(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded sessions; they may be stale.');
    expect(row()).toHaveAttribute('aria-controls', regionId);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert')).toHaveTextContent('may be stale');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(document.getElementById(regionId)).not.toHaveAttribute('hidden');
    await settle(2, [{ ...alpha, message_count: 8 }]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(row()).toHaveAttribute('aria-expanded', 'true');
    expect(row()).toHaveAttribute('aria-controls', regionId);
    expect(within(document.getElementById(regionId)!).getByText('8')).toBeInTheDocument();
  });

  it('serializes manual, polling and visibility retrieval and preserves the visible 15s cadence', async () => {
    await mount();
    await settle(0, [alpha]);
    fireEvent.click(refresh());
    fireEvent.click(refresh());
    await advance(30000);
    fireEvent(document, new Event('visibilitychange'));
    expect(requests).toHaveLength(2);
    expect(refresh()).toBeDisabled();
    await fail(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(15000);
    fireEvent(document, new Event('visibilitychange'));
    expect(requests).toHaveLength(3);
    await settle(2, [alpha]);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    await advance(30000);
    expect(requests).toHaveLength(3);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(requests).toHaveLength(4);
    await settle(3, [alpha]);
    await advance(14999);
    expect(requests).toHaveLength(4);
    await advance(1);
    expect(requests).toHaveLength(5);
    await settle(4, []);
    expect(screen.getByText('No sessions yet.')).toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'list_sessions'))
      .toEqual(Array.from({ length: 5 }, () => ['list_sessions']));
  });
});
