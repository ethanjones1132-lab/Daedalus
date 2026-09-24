import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import CronView from './CronView';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

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
const beta: Job = { ...alpha, id: 'beta', name: 'Beta', prompt: 'Check Beta' };
const missedAlpha: Job = { ...alpha, id: 'missed-alpha', name: 'Missed Alpha', enabled: false };
const missedBeta: Job = { ...alpha, id: 'missed-beta', name: 'Missed Beta', enabled: false };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let listReads: Array<Deferred<Job[]>>;
let inFlightReads: Array<Deferred<string[]>>;
let missedReads: Array<Deferred<Job[]>>;
let writeResponses: Map<string, Promise<unknown>>;
let initialMissed: Job[];
let confirmMock: { mockReturnValue: (value: boolean) => unknown; mockRestore: () => void };

function writeKey(command: string, args: unknown): string {
  const id = typeof args === 'object' && args !== null && 'id' in args ? String(args.id) : '';
  return `${command}:${id}`;
}

function setWrite(command: string, response: Promise<unknown>, id = ''): void {
  writeResponses.set(writeKey(command, { id }), response);
}

function mutationCalls(): Array<[string, unknown]> {
  return invokeMock.mock.calls.filter(([command]) => [
    'enable_cron_job',
    'disable_cron_job',
    'run_cron_job',
    'delete_cron_job',
    'trigger_missed_cron_job',
    'dismiss_missed_cron_job',
  ].includes(command as string)) as Array<[string, unknown]>;
}

beforeEach(() => {
  listReads = [];
  inFlightReads = [];
  missedReads = [];
  writeResponses = new Map();
  initialMissed = [];
  listenMock.mockReset().mockResolvedValue(() => {});
  invokeMock.mockReset().mockImplementation((command: string, args?: unknown) => {
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
    const response = writeResponses.get(writeKey(command, args ?? {}));
    if (response) return response;
    return Promise.resolve(true);
  });
  confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  confirmMock.mockRestore();
});

async function resolveRead(index: number, jobs: Job[], missed: Job[] = []): Promise<void> {
  await waitFor(() => expect(listReads.length).toBeGreaterThan(index));
  await act(async () => {
    listReads[index].resolve(jobs);
    inFlightReads[inFlightReads.length - 1]?.resolve([]);
    missedReads[missedReads.length - 1]?.resolve(missed);
  });
}

async function mount(): Promise<void> {
  render(<ToastProvider><CronView /></ToastProvider>);
  await waitFor(() => expect(listReads.length).toBe(1));
  await resolveRead(0, [alpha, beta], initialMissed);
  await waitFor(() => expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0));
}

describe('Cron operational mutation coordination', () => {
  it('serializes controls for one job while leaving an independent job usable', async () => {
    await mount();
    const alphaWrite = deferred<unknown>();
    setWrite('disable_cron_job', alphaWrite.promise, 'alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Disable Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));

    expect(mutationCalls()).toEqual([['disable_cron_job', { id: 'alpha' }]]);
    expect(screen.getByRole('status', { name: 'Cron job operation' })).toHaveTextContent('Disabling');
    expect(screen.getByRole('button', { name: 'Disable Alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run Alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Alpha' })).toBeDisabled();

    const betaWrite = deferred<unknown>();
    setWrite('disable_cron_job', betaWrite.promise, 'beta');
    fireEvent.click(screen.getByRole('button', { name: 'Disable Beta' }));
    expect(mutationCalls()).toEqual([
      ['disable_cron_job', { id: 'alpha' }],
      ['disable_cron_job', { id: 'beta' }],
    ]);

    await act(async () => alphaWrite.resolve(true));
    await resolveRead(1, [{ ...alpha, enabled: false }, beta]);
    expect(screen.getByText('Cron job "Alpha" disabled.')).toBeInTheDocument();
    await act(async () => betaWrite.resolve(true));
    await resolveRead(2, [{ ...alpha, enabled: false }, { ...beta, enabled: false }]);
  });

  it('retains a false write and retries the same operation without changing the confirmed row', async () => {
    await mount();
    const failed = deferred<boolean>();
    setWrite('disable_cron_job', failed.promise, 'alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Disable Alpha' }));
    await act(async () => failed.resolve(false));

    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert', { name: 'Cron job operation' })).toHaveTextContent('Could not disable cron job');
    expect(screen.queryByText('Cron job "Alpha" disabled.')).not.toBeInTheDocument();
    expect(screen.queryByText(/false/)).not.toBeInTheDocument();

    const retry = deferred<boolean>();
    setWrite('disable_cron_job', retry.promise, 'alpha');
    const retryButton = screen.getByRole('button', { name: 'Retry Alpha' });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(mutationCalls()).toEqual([
      ['disable_cron_job', { id: 'alpha' }],
      ['disable_cron_job', { id: 'alpha' }],
    ]);
    await act(async () => retry.resolve(true));
    await resolveRead(1, [{ ...alpha, enabled: false }, beta]);
    expect(screen.getByText('Cron job "Alpha" disabled.')).toBeInTheDocument();
  });

  it.each([
    { command: 'run_cron_job', button: 'Run Alpha', message: 'Could not run cron job' },
    { command: 'delete_cron_job', button: 'Delete Alpha', message: 'Could not delete cron job' },
  ] as const)('requires an explicit true result for $command', async ({ command, button, message }) => {
    await mount();
    const result = deferred<boolean>();
    setWrite(command, result.promise, 'alpha');
    fireEvent.click(screen.getByRole('button', { name: button }));
    await act(async () => result.resolve(false));

    await waitFor(() => expect(screen.getByRole('alert', { name: 'Cron job operation' })).toHaveTextContent(message));
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(mutationCalls()).toEqual([[command, { id: 'alpha' }]]);
    expect(screen.queryByText('Cron job "Alpha" deleted.')).not.toBeInTheDocument();
    expect(screen.queryByText('Run requested for cron job "Alpha".')).not.toBeInTheDocument();
  });

  it('waits for a confirmed readback and retries a failed read without rewriting', async () => {
    await mount();
    const write = deferred<boolean>();
    setWrite('disable_cron_job', write.promise, 'alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Disable Alpha' }));
    await act(async () => write.resolve(true));

    await waitFor(() => expect(listReads.length).toBe(2));
    await act(async () => {
      listReads[1].reject(new Error('private native readback detail'));
      inFlightReads[1]?.resolve([]);
      missedReads[1]?.resolve([]);
    });
    await waitFor(() => expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole('alert', { name: 'Cron job operation' })).toHaveTextContent(/saved.*reconcil/i));
    expect(screen.getByRole('button', { name: 'Disable Alpha' })).toBeDisabled();
    expect(screen.queryByText(/private native readback detail/)).not.toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: 'Retry Alpha' });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(mutationCalls()).toHaveLength(1);
    await resolveRead(2, [{ ...alpha, enabled: false }, beta]);
    await waitFor(() => expect(screen.getByText('Cron job "Alpha" disabled.')).toBeInTheDocument());
  });

  it('keeps a confirmed deletion out of the UI until a newer list omits it', async () => {
    await mount();
    const write = deferred<boolean>();
    setWrite('delete_cron_job', write.promise, 'alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    await act(async () => write.resolve(true));

    await waitFor(() => expect(listReads.length).toBe(2));
    await resolveRead(1, [alpha, beta]);
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert', { name: 'Cron job operation' })).toHaveTextContent(/saved.*reconcil/i);

    fireEvent.click(screen.getByRole('button', { name: 'Retry Alpha' }));
    expect(mutationCalls()).toHaveLength(1);
    await resolveRead(2, [beta]);
    await waitFor(() => expect(screen.queryAllByText('Alpha')).toHaveLength(0));
  });

  it('does not let a stale refresh replace a job while its write is reconciling', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh jobs' }));
    await waitFor(() => expect(listReads.length).toBe(2));
    const write = deferred<boolean>();
    setWrite('disable_cron_job', write.promise, 'alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Disable Alpha' }));
    await act(async () => write.resolve(true));
    await waitFor(() => expect(listReads.length).toBe(3));

    await act(async () => listReads[1].resolve([alpha, beta]));
    await resolveRead(2, [{ ...alpha, enabled: false }, beta]);
    await waitFor(() => expect(screen.getByText('Cron job "Alpha" disabled.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Enable Alpha' })).toBeInTheDocument();
  });

  it('keeps a missed job visible until dismissal is confirmed by readback', async () => {
    initialMissed = [missedAlpha];
    await mount();
    const write = deferred<boolean>();
    setWrite('dismiss_missed_cron_job', write.promise, missedAlpha.id);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Missed Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Missed Alpha' }));
    expect(mutationCalls()).toEqual([['dismiss_missed_cron_job', { id: missedAlpha.id }]]);
    expect(screen.getByText('Missed Alpha')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Missed cron operation' })).toHaveTextContent('Dismissing');

    await act(async () => write.resolve(true));
    await resolveRead(1, [alpha, beta], []);
    await waitFor(() => expect(screen.queryByText('Missed Alpha')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Missed job "Missed Alpha" dismissed and rescheduled.')).toBeInTheDocument());
  });

  it('ignores a missed event while a dismissal is reconciling', async () => {
    initialMissed = [missedAlpha];
    await mount();
    const write = deferred<boolean>();
    setWrite('dismiss_missed_cron_job', write.promise, missedAlpha.id);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Missed Alpha' }));
    const eventHandler = listenMock.mock.calls[0]?.[1] as ((event: { payload: Job[] }) => void) | undefined;
    expect(eventHandler).toBeDefined();
    eventHandler?.({ payload: [missedAlpha] });
    expect(screen.getByText('Missed Alpha')).toBeInTheDocument();

    await act(async () => write.resolve(true));
    await resolveRead(1, [alpha, beta], []);
    await waitFor(() => expect(screen.queryByText('Missed Alpha')).not.toBeInTheDocument());
  });

  it('reports partial Dismiss All results and retries only the remaining dismissal', async () => {
    initialMissed = [missedAlpha, missedBeta];
    await mount();
    const alphaWrite = deferred<boolean>();
    setWrite('dismiss_missed_cron_job', alphaWrite.promise, missedAlpha.id);
    setWrite('dismiss_missed_cron_job', Promise.resolve(false), missedBeta.id);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss All' }));

    expect(mutationCalls()).toEqual([
      ['dismiss_missed_cron_job', { id: missedAlpha.id }],
      ['dismiss_missed_cron_job', { id: missedBeta.id }],
    ]);
    await act(async () => alphaWrite.resolve(true));
    await resolveRead(1, [alpha, beta], [missedBeta]);

    expect(screen.queryByText('Missed Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Missed Beta')).toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Missed cron operation' })).toHaveTextContent(/some|remaining|confirmed/i);
    expect(screen.queryByText('All missed jobs dismissed.')).not.toBeInTheDocument();

    const retry = deferred<boolean>();
    setWrite('dismiss_missed_cron_job', retry.promise, missedBeta.id);
    fireEvent.click(screen.getByRole('button', { name: 'Retry remaining missed dismissals' }));
    await act(async () => retry.resolve(true));
    await resolveRead(2, [alpha, beta], []);
    await waitFor(() => expect(screen.queryByText('Missed Beta')).not.toBeInTheDocument());
  });
});
