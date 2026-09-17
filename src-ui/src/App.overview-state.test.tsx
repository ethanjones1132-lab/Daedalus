import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import type { BackendSession } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));

const health = {
  ollama: { running: true, model: 'observed-model', url: '' },
  bun_server: { running: true, url: '' }, bridge: { running: false, port: 19878 },
  disk: { total: '100', used: '25', available: '75', use_percent: '25%' },
  memory: { total_mb: 100, available_mb: 75, used_mb: 25, used_percent: 25 },
  timestamp: '2026-09-16T10:00:00Z',
};
const alpha: BackendSession = {
  id: 'session-alpha', agent_id: 'agent-alpha', title: 'Alpha', backend: 'ollama',
  model: 'test-model', context_tokens: 1000, total_tokens: 250,
  created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T11:00:00Z',
  archived: false, message_count: 7,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const commands = ['get_system_health', 'list_agents', 'list_sessions'];
let requests: Record<string, ReturnType<typeof deferred<unknown>>[]>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  localStorage.setItem('jarvis-current-view', 'overview');
  requests = Object.fromEntries(commands.map((command) => [command, []]));
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (commands.includes(command)) {
      const request = deferred<unknown>();
      requests[command].push(request);
      return request.promise;
    }
    if (['list_cron_jobs', 'list_pending_missed_jobs', 'get_action_registry_alerts'].includes(command)) return [];
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });
const mount = async () => { await act(async () => { render(<App />); }); };
const settle = async (index: number, title = 'Alpha') => {
  await act(async () => {
    requests.get_system_health[index].resolve({ ...health, ollama: { ...health.ollama, model: `${title}-model` } });
    requests.list_agents[index].resolve([{ id: 'agent-alpha', name: 'Agent', model: 'test-model', enabled: true }]);
    requests.list_sessions[index].resolve([{ ...alpha, title }]);
  });
};
const fail = async (index: number, command = 'get_system_health') => {
  await act(async () => { requests[command][index].reject(new Error('synthetic private native detail')); });
};
const advance = async (ms = 15000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const status = () => screen.getByRole('status', { name: 'Overview snapshot' });
const refresh = () => screen.getByRole('button', { name: 'Refresh overview' });

describe('Overview snapshot recovery', () => {
  it('publishes only a complete request group, with accessible pending feedback', async () => {
    await mount();
    expect(status()).toHaveTextContent('Loading overview');
    expect(refresh()).toBeDisabled();
    await act(async () => {
      requests.get_system_health[0].resolve(health);
      requests.list_sessions[0].resolve([alpha]);
    });
    expect(screen.queryByText('observed-model')).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(status()).toBeInTheDocument();
    await act(async () => { requests.list_agents[0].resolve([]); });
    expect(screen.getByText('observed-model')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(refresh()).toBeEnabled();
    expect(screen.queryByRole('status', { name: 'Overview snapshot' })).not.toBeInTheDocument();
  });

  it.each(commands)('recovers immediately after %s rejects without publishing partial data', async (command) => {
    await mount();
    await fail(0, command);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load overview.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(screen.queryByText('Recent Sessions')).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(status()).toHaveTextContent('Loading overview');
    for (const name of commands) expect(requests[name]).toHaveLength(2);
    await settle(1);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retains an explicitly stale complete snapshot until recovery succeeds', async () => {
    await mount();
    await settle(0);
    fireEvent.click(refresh());
    expect(status()).toHaveTextContent('Refreshing overview');
    await act(async () => { requests.get_system_health[1].resolve({ ...health, ollama: { ...health.ollama, model: 'partial-model' } }); });
    await fail(1, 'list_agents');
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded overview; it may be stale.');
    expect(screen.getByText('Alpha-model')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('partial-model')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert')).toHaveTextContent('may be stale');
    expect(refresh()).toBeDisabled();
    await settle(2, 'Beta');
    expect(screen.getByText('Beta-model')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('ignores obsolete %s after a newer poll result', async (outcome) => {
    await mount();
    await settle(0);
    fireEvent.click(refresh());
    await advance();
    expect(requests.get_system_health).toHaveLength(3);
    await settle(2, 'Newest');
    if (outcome === 'success') await settle(1, 'Obsolete');
    else await fail(1);
    expect(screen.getByText('Newest-model')).toBeInTheDocument();
    expect(screen.getByText('Newest')).toBeInTheDocument();
    expect(screen.queryByText('Obsolete')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(refresh()).toBeEnabled();
  });

  it('keeps the newest request pending when an older group completes and respects visibility', async () => {
    await mount();
    await advance();
    await settle(0, 'Obsolete');
    expect(status()).toHaveTextContent('Loading overview');
    expect(screen.queryByText('Obsolete')).not.toBeInTheDocument();
    expect(refresh()).toBeDisabled();
    await settle(1, 'Newest');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    await advance(30000);
    expect(requests.get_system_health).toHaveLength(2);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(requests.get_system_health).toHaveLength(3);
    await settle(2);
    await advance(14999);
    expect(requests.get_system_health).toHaveLength(3);
    await advance(1);
    expect(requests.get_system_health).toHaveLength(4);
    await settle(3);
    for (const command of commands) {
      expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === command))
        .toEqual(Array.from({ length: 4 }, () => [command]));
    }
  });
});
