import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';
import type { BackendSession } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const MEASURED_MEMORY = { total_mb: 16384, available_mb: 12288, used_mb: 4096, used_percent: 25 };
// Exactly what Native's `memory_health` returns when the probe cannot run: a
// zeroed record whose `used_percent: 0` means "not measured", not "0% in use".
const UNPROBED_MEMORY = { total_mb: 0, available_mb: 0, used_mb: 0, used_percent: 0 };

const health = {
  ollama: { running: true, model: 'observed-model', url: '' },
  bun_server: { running: true, url: '' }, bridge: { running: false, port: 19878 },
  disk: { total: '100', used: '25', available: '75', use_percent: '25%' },
  memory: MEASURED_MEMORY,
  timestamp: '2026-09-16T10:00:00Z',
};
const alpha: BackendSession = {
  id: 'session-alpha', agent_id: 'agent-alpha', title: 'Alpha', backend: 'ollama',
  model: 'test-model', context_tokens: 1000, total_tokens: 250,
  created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T11:00:00Z',
  archived: false, message_count: 7,
};
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
const publish = async (memory: unknown, index = 0) => {
  await act(async () => {
    requests.get_system_health[index].resolve({ ...health, memory });
    requests.list_agents[index].resolve([{ id: 'agent-alpha', name: 'Agent', model: 'test-model', enabled: true }]);
    requests.list_sessions[index].resolve([alpha]);
  });
};

// The System card is the one Overview card that reads `health.memory`, so the
// query is scoped to it: the sidebar carries its own `Memory` nav item.
const systemCard = () => {
  const heading = screen.getByRole('heading', { name: 'System' });
  const card = heading.parentElement?.parentElement;
  if (!card) throw new Error('the Overview System card is not rendered');
  return within(card);
};
const memoryValue = () => systemCard().getByText(/^(\d+\.\d%|Not measured)$/);

describe('Overview memory reading', () => {
  it('keeps a real memory reading as the percentage the record returned', async () => {
    await mount();
    await publish(MEASURED_MEMORY);
    expect(memoryValue()).toHaveTextContent('25.0%');
    expect(systemCard().queryByText('Not measured')).not.toBeInTheDocument();
    expect(systemCard().queryByText(/probe reported no total/)).not.toBeInTheDocument();
  });

  it('stops printing a zeroed, unprobed memory record as a measured percentage', async () => {
    await mount();
    await publish(UNPROBED_MEMORY);
    // The record returned `used_percent: 0`, so an unfixed surface printed
    // `0.0%` in the same muted tone as a real reading.
    expect(systemCard().queryByText('0.0%')).not.toBeInTheDocument();
    expect(systemCard().queryByText(/^0%$/)).not.toBeInTheDocument();
    expect(memoryValue()).toHaveTextContent('Not measured');
  });

  it('names the unprobed basis beside the reading rather than only in the body', async () => {
    await mount();
    await publish(UNPROBED_MEMORY);
    expect(systemCard().getByText('The memory probe reported no total, so memory use cannot be measured.')).toBeInTheDocument();
  });

  it('leaves the sibling disk row on its own honest convention', async () => {
    await mount();
    await publish(UNPROBED_MEMORY);
    expect(systemCard().getByText('25%')).toBeInTheDocument();
  });

  it('keeps a genuine zero a zero when the record carries a real total', async () => {
    await mount();
    await publish({ total_mb: 16384, available_mb: 16384, used_mb: 0, used_percent: 0 });
    expect(memoryValue()).toHaveTextContent('0.0%');
    expect(systemCard().queryByText('Not measured')).not.toBeInTheDocument();
  });

  it('reaches the honest reading from a live refresh, not only from mount', async () => {
    await mount();
    await publish(MEASURED_MEMORY, 0);
    expect(memoryValue()).toHaveTextContent('25.0%');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }));
    await publish(UNPROBED_MEMORY, 1);
    expect(memoryValue()).toHaveTextContent('Not measured');
    expect(systemCard().queryByText('0.0%')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh overview' }));
    await publish(MEASURED_MEMORY, 2);
    expect(memoryValue()).toHaveTextContent('25.0%');
  });
});
