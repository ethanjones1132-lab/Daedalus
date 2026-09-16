import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CronView from './CronView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const jobA = {
  id: 'cron-a', name: 'Daily check', schedule: '0 3 * * *', agent_id: 'jarvis',
  session_id: null, prompt: 'Check the workspace', enabled: true, last_run: null,
  next_run: null, run_count: 12, metadata: null,
  created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const jobB = { ...jobA, id: 'cron-b', name: 'Weekly review', run_count: 6 };
const run = {
  id: 'run-a', cron_id: jobA.id, status: 'success', output: '', error: '',
  duration_ms: 1200, started_at: '2026-09-16T00:00:00Z', finished_at: '2026-09-16T00:00:01Z',
};
const history = vi.fn();

beforeEach(() => {
  history.mockReset().mockResolvedValue([]);
  invokeMock.mockReset().mockImplementation((command: string, args: unknown) => {
    if (command === 'list_cron_jobs') return Promise.resolve([jobA, jobB]);
    if (command === 'get_in_flight_cron_jobs' || command === 'list_pending_missed_jobs') return Promise.resolve([]);
    if (command === 'get_cron_runs') return history(args);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function start() {
  render(<CronView />);
  await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
}

const emptyMessage = /No historical runs found yet/;
const recommendation = /Learning and review routines are balanced/;

describe('Cron insights resource states', () => {
  it('distinguishes total failure from empty and retries without duplicate batches', async () => {
    const first = deferred<unknown[]>();
    const retry = deferred<unknown[]>();
    history.mockReturnValueOnce(first.promise).mockRejectedValueOnce(new Error('native detail'))
      .mockReturnValueOnce(retry.promise).mockResolvedValueOnce([]);
    await start();
    expect(screen.getByRole('status')).toHaveTextContent('Loading premium cron insights');
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();
    await act(async () => first.reject(new Error('native detail')));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load insights');
    expect(screen.getByRole('alert')).toHaveTextContent('2 of 2 selected jobs');
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();
    expect(screen.queryByText('Success Rate')).not.toBeInTheDocument();
    expect(screen.queryByText(recommendation)).not.toBeInTheDocument();
    expect(screen.queryByText(/native detail/)).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(history).toHaveBeenCalledTimes(3);
    await act(async () => retry.resolve([run]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 1 sampled runs')).toBeInTheDocument();
    expect(history.mock.calls).toEqual([
      [{ cronId: jobA.id }], [{ cronId: jobB.id }], [{ cronId: jobA.id }], [{ cronId: jobB.id }],
    ]);
  });

  it('labels mixed results as partial rather than complete or stale', async () => {
    const second = deferred<unknown[]>();
    history.mockResolvedValueOnce([run]).mockReturnValueOnce(second.promise);
    render(<CronView />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    await act(async () => second.reject(new Error('down')));
    expect(screen.getByRole('alert')).toHaveTextContent('Partial insights');
    expect(screen.getByRole('alert')).toHaveTextContent('1 of 2 selected jobs');
    expect(screen.getByText('1 of 1 sampled runs')).toBeInTheDocument();
    expect(screen.queryByText(recommendation)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });

  it('renders empty history only after all selected histories succeed', async () => {
    const first = deferred<unknown[]>();
    history.mockReturnValueOnce(first.promise);
    await start();
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();
    await act(async () => first.resolve([]));
    expect(screen.getByText(emptyMessage)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not call partial empty results a true empty history', async () => {
    history.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('down'));
    render(<CronView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Partial insights');
    expect(screen.queryByText(emptyMessage)).not.toBeInTheDocument();
    expect(screen.getByText(/No runs in the available subset/)).toBeInTheDocument();
  });

  it('labels retained data stale after a failed refresh and clears it on successful empty retry', async () => {
    const refresh = deferred<unknown[]>();
    const retry = deferred<unknown[]>();
    history.mockResolvedValueOnce([run]).mockResolvedValueOnce([])
      .mockReturnValueOnce(refresh.promise).mockRejectedValueOnce(new Error('down'))
      .mockReturnValueOnce(retry.promise).mockResolvedValueOnce([]);
    render(<CronView />);
    await screen.findByText('1 of 1 sampled runs');
    fireEvent.click(screen.getByRole('button', { name: 'Hide Insights' }));
    fireEvent.click(screen.getByRole('button', { name: /📊 Insights/ }));
    await act(async () => refresh.reject(new Error('down')));
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded samples; they may be stale.');
    expect(screen.getByText('1 of 1 sampled runs')).toBeInTheDocument();
    expect(screen.queryByText(recommendation)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('alert')).toHaveTextContent('stale');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    await act(async () => retry.resolve([]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('1 of 1 sampled runs')).not.toBeInTheDocument();
    expect(screen.getByText(emptyMessage)).toBeInTheDocument();
  });
});
