// A cron job's `Running` pill answers to the read that feeds it.
//
// `get_in_flight_cron_jobs` is polled every 3s and its failure path returns
// silently, so the retained set — and the pulsing `Running` pill built from it —
// survives a read that stopped answering. The pill is a claim about a specific run
// that is still executing; after a failed read that claim is unverified, and the
// animation is what says it is current.
//
// Written against the unchanged card first. The confirmed half is the same
// contract from the other side: a read that answers still pulses, in the same
// colour, with the same word.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import CronView from './CronView';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const NATIVE_DETAIL = 'synthetic private native detail';

type Job = {
  id: string;
  name: string;
  schedule: string;
  agent_id: string;
  session_id: string | null;
  prompt: string;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
};

const alpha: Job = {
  id: 'alpha',
  name: 'Alpha',
  schedule: '0 3 * * *',
  agent_id: 'jarvis',
  session_id: null,
  prompt: 'Check Alpha',
  enabled: true,
  last_run: null,
  next_run: null,
  run_count: 0,
  metadata: null,
  created_at: '2026-09-23T00:00:00Z',
  updated_at: '2026-09-23T00:00:00Z',
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let listReads: Array<Deferred<Job[]>>;
let inFlightReads: Array<Deferred<string[]>>;
let missedReads: Array<Deferred<Job[]>>;
let fakeNow: number;

beforeEach(() => {
  fakeNow = Date.parse('2026-09-26T12:00:00Z');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(fakeNow);
  listReads = [];
  inFlightReads = [];
  missedReads = [];
  listenMock.mockReset().mockResolvedValue(() => {});
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_cron_jobs') {
      const request = deferred<Job[]>();
      listReads.push(request);
      return request.promise;
    }
    if (command === 'get_in_flight_cron_jobs') {
      const request = deferred<string[]>();
      inFlightReads.push(request);
      return request.promise;
    }
    if (command === 'list_pending_missed_jobs') {
      const request = deferred<Job[]>();
      missedReads.push(request);
      return request.promise;
    }
    if (command === 'get_cron_runs') return Promise.resolve([]);
    return Promise.resolve([]);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(inFlight: string[] = ['alpha']): Promise<void> {
  render(<ToastProvider><CronView /></ToastProvider>);
  await waitFor(() => expect(listReads.length).toBeGreaterThan(0));
  await act(async () => {
    listReads[0].resolve([alpha]);
    inFlightReads[0].resolve(inFlight);
    missedReads[0].resolve([]);
  });
}

// The pill's own text, matched exactly. `/^Running/` would also match the card's
// own `Running…` dispatch button, which is a different claim about a different
// thing, and a test that cannot tell them apart cannot pin either.
const pillText = (content: string) => content === 'Running' || content === 'Running (stale)';
const pill = () => screen.getByText(pillText);
const dot = () => pill().querySelector('span');

describe('the cron Running pill answers to the in-flight read', () => {
  it('animates while the read that fed it has answered', async () => {
    await mount();
    await waitFor(() => expect(pill()).toBeInTheDocument());
    expect(pill()).toHaveTextContent('Running');
    expect(pill()).not.toHaveTextContent('stale');
    expect(dot()).toHaveClass('animate-pulse');
  });

  it('stops animating and marks itself stale when that read fails', async () => {
    await mount();
    await waitFor(() => expect(dot()).toHaveClass('animate-pulse'));

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { inFlightReads[1].reject(new Error(NATIVE_DETAIL)); });

    expect(pill()).toHaveTextContent('Running');
    expect(pill()).toHaveTextContent('stale');
    expect(dot()).toBeNull();
    expect(pill().querySelector('.animate-pulse')).toBeNull();
    expect(pill().textContent).not.toContain(NATIVE_DETAIL);
  });

  it('drops the claim entirely once a later read confirms the run is no longer in flight', async () => {
    await mount();
    await waitFor(() => expect(pill()).toBeInTheDocument());
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { inFlightReads[1].reject(new Error(NATIVE_DETAIL)); });
    expect(pill()).toHaveTextContent('stale');

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { inFlightReads[2].resolve([]); });

    expect(screen.queryByText(pillText)).not.toBeInTheDocument();
  });

  it('resumes the confirmed claim when a read answers after a failed one', async () => {
    await mount();
    await waitFor(() => expect(dot()).toHaveClass('animate-pulse'));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { inFlightReads[1].reject(new Error(NATIVE_DETAIL)); });
    expect(pill()).toHaveTextContent('stale');

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { inFlightReads[2].resolve(['alpha']); });

    expect(pill()).toHaveTextContent('Running');
    expect(pill()).not.toHaveTextContent('stale');
    expect(dot()).toHaveClass('animate-pulse');
  });

  it('does not turn a stale run claim into a second dispatch', async () => {
    await mount();
    await waitFor(() => expect(dot()).toHaveClass('animate-pulse'));
    const run = screen.getByRole('button', { name: 'Run Alpha' });
    expect(run).toBeDisabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { inFlightReads[1].reject(new Error(NATIVE_DETAIL)); });
    // The pill is a claim about one run; the control's own guard is `isInFlight`
    // and is unchanged by this row, so a stale reading must not silently hand the
    // operator a second dispatch for a run that may still be executing.
    expect(screen.getByRole('button', { name: 'Run Alpha' })).toBeDisabled();
    fireEvent.click(run);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'run_cron_job')).toHaveLength(0);
  });
});
