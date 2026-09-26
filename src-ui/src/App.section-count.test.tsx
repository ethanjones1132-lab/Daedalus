// The two section headers in the shell, and the read each of their numbers rests on.
//
// `Chat Feeds` kept its Session list in a `useState<BackendSession[]>([])` and
// passed `count={filtered.length}` from a header that renders whether or not the
// read beneath it answered, so `Chat Feeds(0)` sat above "Loading sessions…" and
// above "Could not load sessions." — a confident zero produced by a read that
// returned nothing. `Recent Sessions` counts the same store through a display
// clamp, `Math.min(sessions.length, 5)`, which is the rows the header titles
// rather than any value the record returned.
//
// Both now ask the shared tally (`lib/list-tally.ts`) what they may state. The
// Overview's own early return already kept its header off the screen until the
// snapshot reducer had published one, so the visible half of that site was
// gated before this change; the contracts below pin that as a fact rather than
// assume it, and pin the confirmed count it does state.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import App, { ChatFeedsView } from './App';
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
const beta: BackendSession = { ...alpha, id: 'session-beta', title: 'Beta', agent_id: 'agent-beta' };
const health = {
  ollama: { running: true, model: 'observed-model', url: '' },
  bun_server: { running: true, url: '' }, bridge: { running: false, port: 19878 },
  disk: { total: '100', used: '25', available: '75', use_percent: '25%' },
  memory: { total_mb: 100, available_mb: 75, used_mb: 25, used_percent: 25 },
  timestamp: '2026-09-16T10:00:00Z',
};
const agent = { id: 'agent-alpha', name: 'Agent', model: 'test-model', enabled: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const OVERVIEW_READS = ['get_system_health', 'list_agents', 'list_sessions'] as const;
let overviewRequests: Record<string, Array<ReturnType<typeof deferred<unknown>>>>;
let sessionRequests: Array<ReturnType<typeof deferred<BackendSession[]>>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  // jsdom has no layout engine, so the transcript pane's scroll-into-view has
  // nothing behind it. These contracts are about which number a header states.
  vi.stubGlobal('scrollIntoView', vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  overviewRequests = Object.fromEntries(OVERVIEW_READS.map((command) => [command, []]));
  sessionRequests = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'list_sessions') {
      const request = deferred<BackendSession[]>();
      sessionRequests.push(request);
      return request.promise;
    }
    if ((OVERVIEW_READS as readonly string[]).includes(command)) {
      const request = deferred<unknown>();
      overviewRequests[command].push(request);
      return request.promise;
    }
    if (['list_cron_jobs', 'list_pending_missed_jobs', 'get_action_registry_alerts'].includes(command)) return [];
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

const headingText = (name: string | RegExp) =>
  screen.getByRole('heading', { level: 2, name }).textContent ?? '';

describe('Chat Feeds: the header count answers for the Session list read', () => {
  const mount = async () => { await act(async () => { render(<ChatFeedsView />); }); };

  it('states no count while the read is unanswered', async () => {
    await mount();
    expect(headingText(/^Chat Feeds/)).toBe('Chat Feeds');
    expect(screen.getByText('Loading sessions…')).toBeInTheDocument();
  });

  it('states no count once the read has failed, and the failure is stated in the body', async () => {
    await mount();
    await act(async () => { sessionRequests[0].reject(new Error('synthetic private native detail')); });
    expect(headingText(/^Chat Feeds/)).toBe('Chat Feeds');
    expect(screen.getByText('Could not load sessions.')).toBeInTheDocument();
  });

  it('states the confirmed count, and a confirmed empty read a real zero', async () => {
    await mount();
    await act(async () => { sessionRequests[0].resolve([alpha, beta]); });
    expect(headingText(/^Chat Feeds/)).toBe('Chat Feeds(2)');
    await screen.findByText('Alpha');

    cleanup();
    sessionRequests = [];
    await mount();
    await act(async () => { sessionRequests[0].resolve([]); });
    expect(headingText(/^Chat Feeds/)).toBe('Chat Feeds(0)');
  });

  it('follows the filter with the rows, so the number keeps describing what is on screen', async () => {
    await mount();
    await act(async () => { sessionRequests[0].resolve([alpha, beta]); });
    fireEvent.change(screen.getByPlaceholderText('Filter sessions...'), { target: { value: 'beta' } });
    expect(headingText(/^Chat Feeds/)).toBe('Chat Feeds(1)');
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });
});

describe('Overview: the Recent Sessions count answers for the snapshot read', () => {
  const mount = async () => {
    localStorage.setItem('jarvis-current-view', 'overview');
    await act(async () => { render(<App />); });
  };
  const settle = async (index: number, sessions: BackendSession[]) => {
    await act(async () => {
      overviewRequests.get_system_health[index].resolve(health);
      overviewRequests.list_agents[index].resolve([agent]);
      sessionRequests[index].resolve(sessions);
    });
  };
  const fail = async (index: number) => {
    await act(async () => { overviewRequests.get_system_health[index].reject(new Error('synthetic private native detail')); });
  };

  it('keeps the header off the screen entirely while the snapshot read is unanswered', async () => {
    await mount();
    // Not "a count of zero" and not a stale one: the whole Overview waits, which
    // is why this site needed the rule rather than a fix.
    expect(screen.queryByRole('heading', { level: 2, name: /^Recent Sessions/ })).not.toBeInTheDocument();
    expect(screen.getByText('Loading overview…')).toBeInTheDocument();
  });

  it('keeps it off the screen after a failed first read too', async () => {
    await mount();
    await fail(0);
    expect(screen.queryByRole('heading', { level: 2, name: /^Recent Sessions/ })).not.toBeInTheDocument();
    expect(screen.getByText('Could not load overview.')).toBeInTheDocument();
  });

  it('states the confirmed count of the five rows it titles, and a confirmed zero', async () => {
    await mount();
    await settle(0, [alpha, beta]);
    expect(headingText(/^Recent Sessions/)).toBe('Recent Sessions(2)');
    await screen.findByText('Alpha');

    cleanup();
    overviewRequests = Object.fromEntries(OVERVIEW_READS.map((command) => [command, []]));
    sessionRequests = [];
    await mount();
    await settle(0, []);
    expect(headingText(/^Recent Sessions/)).toBe('Recent Sessions(0)');
  });

  it('keeps stating the confirmed count through a failed refresh, because the rows are still on screen', async () => {
    await mount();
    await settle(0, [alpha, beta]);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    await fail(1);
    expect(headingText(/^Recent Sessions/)).toBe('Recent Sessions(2)');
    expect(screen.getByText(/Could not refresh overview\./)).toBeInTheDocument();
  });
});
