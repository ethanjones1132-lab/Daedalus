import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView from './JarvisView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const session = {
  id: 's-1', name: 'Saved work', model: 'test-model', message_count: 2,
  created_at: '2026-09-16T00:00:00Z',
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'jarvis_list_sessions' || command === 'get_all_session_runs') return [];
    return null;
  });
});
afterEach(cleanup);

describe('Sessions resource states', () => {
  it('shows loading, not an empty Session list, until the native request resolves', async () => {
    const request = deferred<unknown[]>();
    invokeMock.mockImplementation((command: string) =>
      command === 'jarvis_list_sessions' ? request.promise : Promise.resolve([]));
    render(<JarvisView initialSubView="sessions" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading sessions');
    expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeDisabled();
    await act(async () => request.resolve([]));
    expect(await screen.findByText('No sessions yet')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a native failure instead of false emptiness and retries successfully', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_list_sessions') throw new Error('sqlite unavailable');
      return [];
    });
    render(<JarvisView initialSubView="sessions" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('sqlite unavailable');
    expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument();

    const retry = deferred<unknown[]>();
    invokeMock.mockImplementation((command: string) =>
      command === 'jarvis_list_sessions' ? retry.promise : Promise.resolve([]));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading sessions');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => retry.resolve([session]));
    expect(await screen.findByText('Saved work', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeEnabled();
  });

  it('keeps saved Sessions visible during refresh and labels a failed refresh as stale', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'jarvis_list_sessions' ? [session] : []);
    render(<JarvisView initialSubView="sessions" />);
    await screen.findByText('Saved work', { selector: 'span' });
    const refresh = deferred<unknown[]>();
    invokeMock.mockImplementation((command: string) =>
      command === 'jarvis_list_sessions' ? refresh.promise : Promise.resolve([]));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing sessions');
    expect(screen.getByText('Saved work', { selector: 'span' })).toBeInTheDocument();
    await act(async () => refresh.reject('native surface disconnected'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Showing previously loaded sessions');
    expect(screen.getByRole('alert')).toHaveTextContent('native surface disconnected');
    expect(screen.getByText('Saved work', { selector: 'span' })).toBeInTheDocument();
  });

  it('still loads Sessions when run telemetry is unavailable, and says so', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_list_sessions') return [session];
      if (command === 'get_all_session_runs') throw new Error('telemetry unavailable');
      return null;
    });
    render(<JarvisView initialSubView="sessions" />);
    await waitFor(() => expect(screen.getByText('Saved work', { selector: 'span' })).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read recorded run outcomes.');
    expect(screen.getByText('run outcome unavailable')).toBeInTheDocument();
    // A read that failed must never read as a confirmed absence of a run.
    expect(screen.queryByText('no run recorded')).not.toBeInTheDocument();
  });

  it('reads a confirmed empty run-outcome read as no runs recorded, not as unavailable', async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === 'jarvis_list_sessions' ? [session] : []);
    render(<JarvisView initialSubView="sessions" />);
    await waitFor(() => expect(screen.getByText('Saved work', { selector: 'span' })).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('no run recorded')).toBeInTheDocument();
  });

  it('shows a recorded outcome and clears the unavailable state on a later successful read', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_list_sessions') return [session];
      if (command === 'get_all_session_runs') throw new Error('telemetry unavailable');
      return null;
    });
    render(<JarvisView initialSubView="sessions" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not read recorded run outcomes.'));

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_list_sessions') return [session];
      if (command === 'get_all_session_runs') {
        return [{
          session_id: 's-1', run_id: 'run-77', outcome: 'failed',
          selected_model: 'slow-model', token_count: 12, tool_count: 3,
        }];
      }
      return null;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry run outcomes' }));
    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(screen.getByText('(slow-model)')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('run outcome unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('no run recorded')).not.toBeInTheDocument();
  });

  it('reports a pending outcome read as pending, never as a confirmed absence', async () => {
    const runs = deferred<unknown[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') return Promise.resolve([session]);
      if (command === 'get_all_session_runs') return runs.promise;
      return Promise.resolve(null);
    });
    render(<JarvisView initialSubView="sessions" />);
    // The authoritative Session list is not held hostage by the outcome read.
    expect(await screen.findByText('Saved work', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('reading run outcome…')).toBeInTheDocument();
    expect(screen.queryByText('no run recorded')).not.toBeInTheDocument();
    expect(screen.queryByText('run outcome unavailable')).not.toBeInTheDocument();
    await act(async () => runs.resolve([]));
    expect(await screen.findByText('no run recorded')).toBeInTheDocument();
  });

  it('treats a malformed run-outcome read as unavailable rather than as no runs', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'jarvis_list_sessions') return [session];
      if (command === 'get_all_session_runs') return { rows: [] };
      return null;
    });
    render(<JarvisView initialSubView="sessions" />);
    await waitFor(() => expect(screen.getByText('run outcome unavailable')).toBeInTheDocument());
    expect(screen.queryByText('no run recorded')).not.toBeInTheDocument();
  });

  it('issues one in-flight run-outcome read when a list reload overlaps a pending one', async () => {
    const runs = deferred<unknown[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') return Promise.resolve([session]);
      if (command === 'get_all_session_runs') return runs.promise;
      return Promise.resolve(null);
    });
    render(<JarvisView initialSubView="sessions" />);
    const selection = await screen.findByRole('button', { name: 'Select session Saved work' });
    const row = within(selection.parentElement!.parentElement!);
    fireEvent.click(row.getByRole('button', { name: 'Delete session Saved work' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(
      invokeMock.mock.calls.filter(([command]) => command === 'get_all_session_runs'),
    ).toHaveLength(1));
    await act(async () => runs.resolve([]));
    expect(await screen.findByText('no run recorded')).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === 'get_all_session_runs'),
    ).toHaveLength(1);
  });
});
