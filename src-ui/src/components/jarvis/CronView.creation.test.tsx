import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
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

const createdJob = {
  id: 'cron-created',
  name: 'Created job',
  schedule: '*/5 * * * *',
  agent_id: 'agent-7',
  session_id: null,
  prompt: 'Review workspace',
  enabled: true,
  last_run: null,
  next_run: '2026-09-23T12:05:00Z',
  run_count: 0,
  metadata: null,
  created_at: '2026-09-23T12:00:00Z',
  updated_at: '2026-09-23T12:00:00Z',
};

const addCalls = () => invokeMock.mock.calls.filter(([command]) => command === 'add_cron_job');

function defaultCommand(command: string) {
  if (command === 'list_cron_jobs') return Promise.resolve([]);
  if (command === 'get_in_flight_cron_jobs' || command === 'list_pending_missed_jobs') return Promise.resolve([]);
  if (command === 'get_cron_runs') return Promise.resolve([]);
  throw new Error(`Unexpected command: ${command}`);
}

beforeEach(() => {
  invokeMock.mockReset().mockImplementation(defaultCommand);
});
afterEach(cleanup);

async function openDraft() {
  render(<ToastProvider><CronView /></ToastProvider>);
  await screen.findByRole('heading', { name: /Cron Jobs/ });
  fireEvent.click(screen.getByRole('button', { name: '+ Add Job' }));
  await screen.findByRole('heading', { name: 'Add Cron Job' });
  fireEvent.change(screen.getByPlaceholderText('Learning Session'), { target: { value: '  Created job  ' } });
  fireEvent.change(screen.getByPlaceholderText('jarvis'), { target: { value: '  agent-7  ' } });
  fireEvent.click(screen.getByRole('button', { name: /^Custom Fully custom prompt and schedule/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
  fireEvent.change(screen.getByPlaceholderText('*/5 * * * *'), { target: { value: '  */5 * * * *  ' } });
  fireEvent.change(screen.getByPlaceholderText('What should this cron job do?'), { target: { value: '  Review workspace  ' } });
  return screen.getByPlaceholderText('Custom');
}

describe('Cron creation lifetime', () => {
  it('serializes one frozen submission above both dismissal paths and closes only after native success', async () => {
    const request = deferred<typeof createdJob>();
    const nameInput = await openDraft();
    invokeMock.mockImplementation((command: string) => command === 'add_cron_job' ? request.promise : defaultCommand(command));

    const add = screen.getByRole('button', { name: 'Add Job' });
    fireEvent.click(add);
    fireEvent.click(add);

    expect(addCalls()).toEqual([[
      'add_cron_job',
      { name: 'Created job', schedule: '*/5 * * * *', prompt: 'Review workspace', agentId: 'agent-7' },
    ]]);
    expect(screen.getByRole('status')).toHaveTextContent('Adding cron job');
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(nameInput).toBeDisabled();
    expect(screen.getByPlaceholderText('jarvis')).toBeDisabled();
    expect(screen.getByPlaceholderText('*/5 * * * *')).toBeDisabled();
    expect(screen.getByPlaceholderText('What should this cron job do?')).toBeDisabled();

    const cancels = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancels).toHaveLength(2);
    expect(cancels[0]).toBeDisabled();
    expect(cancels[1]).toBeDisabled();
    fireEvent.change(nameInput, { target: { value: 'Later name' } });
    fireEvent.change(screen.getByPlaceholderText('jarvis'), { target: { value: 'later-agent' } });
    fireEvent.change(screen.getByPlaceholderText('*/5 * * * *'), { target: { value: '0 * * * *' } });
    fireEvent.change(screen.getByPlaceholderText('What should this cron job do?'), { target: { value: 'Later prompt' } });
    fireEvent.click(cancels[1]);
    fireEvent.click(cancels[0]);

    expect(nameInput).toHaveValue('  Created job  ');
    expect(screen.getByPlaceholderText('jarvis')).toHaveValue('  agent-7  ');
    expect(screen.getByPlaceholderText('*/5 * * * *')).toHaveValue('  */5 * * * *  ');
    expect(screen.getByPlaceholderText('What should this cron job do?')).toHaveValue('  Review workspace  ');
    expect(screen.queryByText('Cron job "Created job" created successfully.')).not.toBeInTheDocument();
    expect(addCalls()).toHaveLength(1);

    await act(async () => { request.resolve(createdJob); });

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add Cron Job' })).not.toBeInTheDocument());
    expect(screen.getByText('Review workspace')).toBeInTheDocument();
    expect(screen.getByText('Cron job "Created job" created successfully.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Add Job' }));
    expect(screen.getByPlaceholderText('Learning Session')).toHaveValue('');
    expect(screen.getByPlaceholderText('jarvis')).toHaveValue('jarvis');
    expect((screen.getByPlaceholderText('What should this cron job do?') as HTMLTextAreaElement).value).toContain('autonomous Learning Session');
    expect(screen.queryByPlaceholderText('*/5 * * * *')).not.toBeInTheDocument();
  });

  it('retains the submitted name schedule prompt and agent for guarded fixed-message retry', async () => {
    const request = deferred<typeof createdJob>();
    const nameInput = await openDraft();
    invokeMock.mockImplementation((command: string) => command === 'add_cron_job' ? request.promise : defaultCommand(command));
    fireEvent.click(screen.getByRole('button', { name: 'Add Job' }));
    await act(async () => { request.reject(new Error('synthetic private native detail')); });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not add cron job. Your draft has been kept.');
    expect(screen.queryByText(/synthetic private native detail/)).not.toBeInTheDocument();
    expect(screen.queryByText('Cron Job Error')).not.toBeInTheDocument();
    expect(nameInput).toHaveValue('  Created job  ');
    expect(screen.getByPlaceholderText('jarvis')).toHaveValue('  agent-7  ');
    expect(screen.getByPlaceholderText('*/5 * * * *')).toHaveValue('  */5 * * * *  ');
    expect(screen.getByPlaceholderText('What should this cron job do?')).toHaveValue('  Review workspace  ');
    expect(nameInput).toBeEnabled();

    const retryRequest = deferred<typeof createdJob>();
    invokeMock.mockImplementation((command: string) => command === 'add_cron_job' ? retryRequest.promise : defaultCommand(command));
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);

    expect(addCalls()).toHaveLength(2);
    expect(addCalls()[1]).toEqual(addCalls()[0]);
    expect(retry).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Your draft has been kept.');
    expect(screen.getByRole('status')).toHaveTextContent('Adding cron job');

    await act(async () => { retryRequest.resolve(createdJob); });

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add Cron Job' })).not.toBeInTheDocument());
    expect(screen.getByText('Cron job "Created job" created successfully.')).toBeInTheDocument();
  });

  it('allows form and parent cancellation before submission and reopens a clean default draft', async () => {
    await openDraft();
    let cancels = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancels).toHaveLength(2);
    fireEvent.click(cancels[1]);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add Cron Job' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '+ Add Job' }));
    await screen.findByRole('heading', { name: 'Add Cron Job' });
    expect(screen.getByPlaceholderText('Learning Session')).toHaveValue('');
    expect(screen.getByPlaceholderText('jarvis')).toHaveValue('jarvis');
    expect((screen.getByPlaceholderText('What should this cron job do?') as HTMLTextAreaElement).value).toContain('autonomous Learning Session');
    expect(screen.queryByPlaceholderText('*/5 * * * *')).not.toBeInTheDocument();

    cancels = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancels[0]);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add Cron Job' })).not.toBeInTheDocument());
    expect(addCalls()).toHaveLength(0);
  });
});
