import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('./components/jarvis/HealthBanner', () => ({ default: () => null }));
vi.mock('./components/jarvis/MythosCompanionSprite', () => ({ MythosCompanionSprite: () => null }));

const REGISTRY_EVENT = 'action-registry://alerts';
const MISSED_EVENT = 'cron://missed-jobs';
const READ = 'get_action_registry_alerts';
const NATIVE_DETAIL = 'synthetic private native detail';

type EventHandler = (event: { payload: unknown }) => void;
type ListenOutcome = 'resolve' | 'reject' | 'defer';
type ReadOutcome = 'empty' | 'alerts' | 'reject' | 'undecodable';

const highAlert = {
  id: 'alert-high',
  kind: 'dispatch_failed',
  severity: 'high',
  title: 'Action dispatch not confirmed',
  message: 'The provider did not confirm delivery of the dispatched action.',
  count: 1,
  created_at: '2026-09-26T10:00:00Z',
};
const summary = { active: 1, blocked: 0, done: 0, pending_approvals: 0, escalated: 0, alerts: 1 };
const bucket = { bucket: 'active', actions: [] };

interface DeferredListen {
  name: string;
  index: number;
  resolve: (unlisten: () => void) => void;
  reject: (reason: Error) => void;
}

let readScript: ReadOutcome[];
let listenScript: Record<string, ListenOutcome[]>;
let deferredListens: DeferredListen[];
let handlers: Record<string, EventHandler[]>;
let unlistens: Record<string, ReturnType<typeof vi.fn>[]>;
let listenCounts: Record<string, number>;
let readCount: number;

function unlistenFor(name: string) {
  const unlisten = vi.fn();
  unlistens[name] = (unlistens[name] ?? []).concat(unlisten);
  return unlisten;
}

beforeEach(() => {
  localStorage.setItem('jarvis-current-view', 'sessions');
  readScript = ['empty'];
  listenScript = { [REGISTRY_EVENT]: ['resolve'], [MISSED_EVENT]: ['resolve'] };
  deferredListens = [];
  handlers = {};
  unlistens = {};
  listenCounts = {};
  readCount = 0;
  listenMock.mockReset();
  listenMock.mockImplementation((name: string, handler: EventHandler) => {
    const index = (listenCounts[name] = (listenCounts[name] ?? -1) + 1);
    handlers[name] = (handlers[name] ?? []).concat(handler);
    const outcome = listenScript[name]?.[index] ?? 'resolve';
    if (outcome === 'resolve') return Promise.resolve(unlistenFor(name));
    if (outcome === 'reject') return Promise.reject(new Error(NATIVE_DETAIL));
    return new Promise<() => void>((resolve, reject) => {
      deferredListens.push({ name, index, resolve, reject });
    });
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === READ) {
      const outcome = readScript[readCount] ?? 'empty';
      readCount += 1;
      if (outcome === 'empty') return [];
      if (outcome === 'alerts') return [highAlert];
      if (outcome === 'undecodable') return { alerts: [highAlert] };
      throw new Error(NATIVE_DETAIL);
    }
    if (command === 'get_action_registry_summary') return summary;
    if (command === 'get_action_registry_bucket') return bucket;
    if (command === 'list_sessions' || command === 'list_cron_jobs' || command === 'list_pending_missed_jobs') {
      return [];
    }
    return null;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

const mount = async () => { await act(async () => { render(<App />); }); };
const channel = () => screen.queryByRole('alert', { name: 'Action registry alert channel' });
const reasons = () => Array.from(document.querySelectorAll('[aria-label="Action registry alert channel"] li'))
  .map((li) => li.textContent);
const retry = () => screen.getByRole('button', { name: 'Retry' });
const fire = (name: string, payload: unknown) => {
  const handler = handlers[name]?.[0];
  if (!handler) throw new Error(`no handler registered for ${name}`);
  act(() => { handler({ payload }); });
};
const settleListen = async (name: string, index: number, outcome: 'resolve' | 'reject') => {
  const pending = deferredListens.find((d) => d.name === name && d.index === index);
  if (!pending) throw new Error(`no deferred listen for ${name}#${index}`);
  await act(async () => {
    if (outcome === 'resolve') pending.resolve(unlistenFor(name));
    else pending.reject(new Error(NATIVE_DETAIL));
  });
};

describe('a failed registry-alert read', () => {
  it('announces the dead channel with a fixed message and a deliberate Retry', async () => {
    readScript = ['reject'];
    await mount();
    const region = channel();
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent('Some Action registry alerts cannot reach you right now.');
    expect(reasons()).toEqual(['Existing registry alerts could not be read.']);
    expect(retry()).toBeEnabled();
    expect(screen.queryByText(new RegExp(NATIVE_DETAIL))).not.toBeInTheDocument();
  });

  it('reads the same command again when the operator retries, and clears the failure once it answers', async () => {
    readScript = ['reject', 'empty'];
    await mount();
    expect(channel()).not.toBeNull();
    await act(async () => { fireEvent.click(retry()); });
    expect(invokeMock.mock.calls.filter(([command]) => command === READ)).toHaveLength(2);
    await waitFor(() => expect(channel()).toBeNull());
  });

  it('treats a payload that is not a list of alerts as a failed read rather than a quiet registry', async () => {
    readScript = ['undecodable'];
    await mount();
    expect(channel()).not.toBeNull();
    expect(reasons()).toEqual(['Existing registry alerts could not be read.']);
    expect(screen.queryByText('Some Action registry alerts cannot reach you right now.')).not.toBeNull();
  });

  it('stays quiet while the read is still unanswered', async () => {
    await mount();
    expect(channel()).toBeNull();
  });
});

describe('a dead registry-alert subscription', () => {
  it('announces the registry channel when its subscription is refused', async () => {
    listenScript = { [REGISTRY_EVENT]: ['reject'], [MISSED_EVENT]: ['resolve'] };
    await mount();
    expect(channel()).not.toBeNull();
    expect(reasons()).toEqual(['New registry alerts are not arriving.']);
  });

  it('announces the missed-cron channel when that subscription is refused', async () => {
    listenScript = { [REGISTRY_EVENT]: ['resolve'], [MISSED_EVENT]: ['reject'] };
    await mount();
    expect(channel()).not.toBeNull();
    expect(reasons()).toEqual(['Missed-cron warnings are not arriving.']);
  });

  it('names every refused channel at once', async () => {
    listenScript = { [REGISTRY_EVENT]: ['reject'], [MISSED_EVENT]: ['reject'] };
    readScript = ['reject'];
    await mount();
    expect(reasons()).toEqual([
      'Existing registry alerts could not be read.',
      'New registry alerts are not arriving.',
      'Missed-cron warnings are not arriving.',
    ]);
  });

  it('re-arms both subscriptions when the operator retries', async () => {
    listenScript = { [REGISTRY_EVENT]: ['reject'], [MISSED_EVENT]: ['reject'] };
    await mount();
    expect(channel()).not.toBeNull();
    await act(async () => { fireEvent.click(retry()); });
    expect(listenMock.mock.calls.filter(([name]) => name === REGISTRY_EVENT)).toHaveLength(2);
    expect(listenMock.mock.calls.filter(([name]) => name === MISSED_EVENT)).toHaveLength(2);
    await waitFor(() => expect(channel()).toBeNull());
  });

  it('releases a subscription that is granted only after the shell goes away', async () => {
    listenScript = { [REGISTRY_EVENT]: ['defer'], [MISSED_EVENT]: ['resolve'] };
    const { unmount } = render(<App />);
    await act(async () => { await Promise.resolve(); });
    unmount();
    await settleListen(REGISTRY_EVENT, 0, 'resolve');
    expect(unlistens[REGISTRY_EVENT]?.[0]).toHaveBeenCalledTimes(1);
  });

  it('ignores a refusal from a subscription torn down by an earlier retry', async () => {
    listenScript = { [REGISTRY_EVENT]: ['defer', 'resolve'], [MISSED_EVENT]: ['resolve', 'resolve'] };
    readScript = ['reject', 'empty'];
    await mount();
    expect(channel()).not.toBeNull();
    await act(async () => { fireEvent.click(retry()); });
    await waitFor(() => expect(channel()).toBeNull());
    await settleListen(REGISTRY_EVENT, 0, 'reject');
    expect(channel()).toBeNull();
  });
});

describe('a confirmed registry alert', () => {
  it('renders no channel failure when every read and subscription answers', async () => {
    await mount();
    expect(channel()).toBeNull();
  });

  it('still toasts a high-severity alert with its title, message and Open Actions action', async () => {
    readScript = ['alerts'];
    await mount();
    expect(screen.getByText('Action dispatch not confirmed')).toBeInTheDocument();
    expect(screen.getByText('The provider did not confirm delivery of the dispatched action.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Actions' })).toBeInTheDocument();
    expect(channel()).toBeNull();
  });

  it('still opens the Actions view from the alert toast', async () => {
    readScript = ['alerts'];
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open Actions' })); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Action Registry' })).toBeInTheDocument());
  });

  it('still delivers an alert that arrives over a live subscription', async () => {
    await mount();
    fire(REGISTRY_EVENT, [highAlert]);
    expect(screen.getByText('Action dispatch not confirmed')).toBeInTheDocument();
    expect(channel()).toBeNull();
  });

  it('still warns about a missed cron job that arrives over a live subscription', async () => {
    await mount();
    fire(MISSED_EVENT, [{ id: 'job-1', prompt: 'self-improvement review' }]);
    expect(screen.getByText('Missed Cron Jobs Detected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Cron View' })).toBeInTheDocument();
  });

  it('stays quiet for a confirmed read that carries no alerts at all', async () => {
    readScript = ['empty'];
    await mount();
    expect(channel()).toBeNull();
    expect(screen.queryByText('Action dispatch not confirmed')).not.toBeInTheDocument();
  });
});
