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

const job = {
  id: 'cron-1', name: 'Daily check', schedule: '0 3 * * *', agent_id: 'jarvis',
  session_id: null, prompt: 'Check the workspace', enabled: true, last_run: null,
  next_run: null, run_count: 1, metadata: null,
  created_at: '2026-09-16T00:00:00Z', updated_at: '2026-09-16T00:00:00Z',
};
const run = {
  id: 'run-1', cron_id: job.id, status: 'success', output: 'Workspace checked',
  error: '', duration_ms: 1200, started_at: '2026-09-16T00:00:00Z',
  finished_at: '2026-09-16T00:00:02Z',
  execution_evidence: { run_id: 'run-1', status: 'passed', acceptance_result: 'All checks verified' },
};
const history = vi.fn();

beforeEach(() => {
  // CronView auto-loads Insights before the operator opens a job's history.
  history.mockReset().mockResolvedValueOnce([]);
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'list_cron_jobs') return Promise.resolve([job]);
    if (command === 'get_in_flight_cron_jobs' || command === 'list_pending_missed_jobs') return Promise.resolve([]);
    if (command === 'get_cron_runs') return history();
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

async function openHistory() {
  render(<CronView />);
  await screen.findByRole('button', { name: /1 runs/ });
  await waitFor(() => expect(history).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: /1 runs/ }));
}

async function collapseHistory() {
  fireEvent.click(screen.getByRole('button', { name: /1 runs/ }));
  await waitFor(() => expect(screen.queryByText('Workspace checked')).not.toBeInTheDocument());
}

describe('Cron run history resource states', () => {
  it('distinguishes pending and rejection from empty, then retries once and preserves execution evidence', async () => {
    const first = deferred<unknown[]>();
    const retry = deferred<unknown[]>();
    history.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    await openHistory();
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs');
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
    await act(async () => first.reject(new Error('native history unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load run history.');
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/native history unavailable/)).not.toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(history).toHaveBeenCalledTimes(3); // Insights + initial history + retry
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs');
    await act(async () => retry.resolve([run]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Workspace checked')).toBeInTheDocument();
    expect(screen.getByText('evidence: passed')).toBeInTheDocument();
    expect(screen.getByText('All checks verified')).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'get_cron_runs'))
      .toEqual(Array.from({ length: 3 }, () => ['get_cron_runs', { cronId: job.id }]));
  });

  it('shows No runs yet only after a successful empty history response', async () => {
    const request = deferred<unknown[]>();
    history.mockReturnValueOnce(request.promise);
    await openHistory();
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
    await act(async () => request.resolve([]));
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reloads on re-expansion and labels retained history stale after failure until recovery', async () => {
    const refresh = deferred<unknown[]>();
    const retry = deferred<unknown[]>();
    history.mockResolvedValueOnce([run]).mockReturnValueOnce(refresh.promise).mockReturnValueOnce(retry.promise);
    await openHistory();
    await screen.findByText('Workspace checked');
    await collapseHistory();
    fireEvent.click(screen.getByRole('button', { name: /1 runs/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs');
    await act(async () => refresh.reject(new Error('refresh failed')));
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded runs; they may be stale.');
    expect(screen.getByText('Workspace checked')).toBeInTheDocument();
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('stale');
    await act(async () => retry.resolve([]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Workspace checked')).not.toBeInTheDocument();
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
  });

  it('does not start competing requests when collapsed and reopened while pending', async () => {
    const request = deferred<unknown[]>();
    history.mockReturnValueOnce(request.promise);
    await openHistory();
    const toggle = screen.getByRole('button', { name: /1 runs/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText('Loading runs…')).not.toBeInTheDocument());
    fireEvent.click(toggle);
    expect(history).toHaveBeenCalledTimes(2);
    await act(async () => request.resolve([run]));
    expect(screen.getByText('Workspace checked')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
