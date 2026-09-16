import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App from './App';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({
  MythosCompanionSprite: ({ cronAwareness }: { cronAwareness: string }) => (
    <div role="status" aria-label="Cron awareness">{cronAwareness}</div>
  ),
}));

let failedCommand: string | null;
let pending: boolean;
const job = { enabled: true, prompt: 'self-improvement review' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  localStorage.setItem('jarvis-current-view', 'sessions');
  failedCommand = null;
  pending = false;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'list_cron_jobs' || command === 'list_pending_missed_jobs') {
      if (pending) return new Promise(() => {});
      if (command === failedCommand) throw new Error('synthetic native detail');
      return command === 'list_cron_jobs' ? [job] : [];
    }
    if (command === 'list_sessions' || command === 'get_action_registry_alerts') return [];
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

async function mount() {
  await act(async () => { render(<App />); });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const awareness = () => screen.getByRole('status', { name: 'Cron awareness' });
const samples = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'list_cron_jobs');

describe('App synchronization honesty', () => {
  it('never claims synchronization on mount or from elapsed time while sampling is pending', async () => {
    pending = true;
    await mount();
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
    expect(awareness()).toHaveTextContent('Loading cron awareness…');
    await advance(30000);
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
    expect(awareness()).toHaveTextContent('Loading cron awareness…');
    expect(samples()).toEqual([['list_cron_jobs']]);
  });

  it.each(['list_cron_jobs', 'list_pending_missed_jobs'])('reports unavailable when %s rejects and recovers at the existing poll', async (command) => {
    failedCommand = command;
    await mount();
    expect(awareness()).toHaveTextContent('Cron awareness unavailable. Waiting for the next refresh.');
    expect(screen.queryByText(/synced|synthetic native detail/i)).not.toBeInTheDocument();
    await advance(10000);
    expect(awareness()).toHaveTextContent('Cron awareness unavailable.');
    expect(samples()).toHaveLength(1);
    failedCommand = null;
    await advance(50000);
    expect(awareness()).toHaveTextContent('Tracking 1 self-improvement cron.');
    expect(samples()).toEqual([['list_cron_jobs'], ['list_cron_jobs']]);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'list_pending_missed_jobs'))
      .toEqual([['list_pending_missed_jobs'], ['list_pending_missed_jobs']]);
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
  });

  it('replaces retained awareness with unavailable after a failed refresh, then recovers', async () => {
    await mount();
    expect(awareness()).toHaveTextContent('Tracking 1 self-improvement cron.');
    failedCommand = 'list_cron_jobs';
    await advance(60000);
    expect(awareness()).toHaveTextContent('Cron awareness unavailable.');
    expect(screen.queryByText('Tracking 1 self-improvement cron.')).not.toBeInTheDocument();
    expect(screen.queryByText(/synced/i)).not.toBeInTheDocument();
    failedCommand = null;
    await advance(60000);
    expect(awareness()).toHaveTextContent('Tracking 1 self-improvement cron.');
    expect(samples()).toHaveLength(3);
  });
});
