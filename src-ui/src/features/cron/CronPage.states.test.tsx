import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CronPage from './CronPage';
import type { CronJob } from './cron-model';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const job: CronJob = {
  id: 'cron-1', name: 'Nightly digest', schedule: '0 3 * * *', agent_id: 'jarvis', session_id: null,
  prompt: 'Summarise the day', enabled: true, last_run: '2026-10-10T03:00:00Z', next_run: null, run_count: 3,
  metadata: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
};
const failedRun = {
  id: 'r1', cron_id: 'cron-1', status: 'failed', output: '', error: 'tool timed out', duration_ms: 900,
  started_at: '2026-10-10T03:00:00Z', finished_at: '2026-10-10T03:00:01Z',
};

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(cleanup);

describe('Cron page states', () => {
  it('reports a failed first load as an error, never as an empty list', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_cron_jobs') return Promise.reject(new Error('native down'));
      return Promise.resolve([]);
    });
    render(<CronPage />);
    expect(await screen.findByRole('alert', { name: 'Cron jobs loading' })).toHaveTextContent('Could not load cron jobs.');
    expect(screen.queryByText('No cron jobs configured')).not.toBeInTheDocument();
    expect(screen.queryByText(/native down/)).not.toBeInTheDocument();
  });

  it('shows the empty state only after a successful empty read', async () => {
    invokeMock.mockImplementation(() => Promise.resolve([]));
    render(<CronPage />);
    expect(await screen.findByText('No cron jobs configured')).toBeInTheDocument();
  });

  it('opens a job\'s history in a side panel, shows its outcome in the row, and closes it', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'list_cron_jobs') return Promise.resolve([job]);
      if (command === 'get_cron_runs') return Promise.resolve([failedRun]);
      return Promise.resolve([]);
    });
    render(<CronPage />);
    const toggle = await screen.findByRole('button', { name: '3 runs' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const panel = await screen.findByRole('region', { name: 'Run history for Nightly digest' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('tool timed out')).toBeInTheDocument();
    expect(panel).toHaveTextContent('failed');
    fireEvent.click(screen.getByRole('button', { name: 'Close run history' }));
    expect(screen.queryByRole('region', { name: 'Run history for Nightly digest' })).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('describes the schedule in words beside the expression', async () => {
    invokeMock.mockImplementation((command: string) => (command === 'list_cron_jobs' ? Promise.resolve([job]) : Promise.resolve([])));
    render(<CronPage />);
    expect(await screen.findByText('daily at 3am')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('0 3 * * *')).toBeInTheDocument());
  });
});
