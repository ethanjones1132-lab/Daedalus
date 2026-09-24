import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView from './JarvisView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

type Session = {
  id: string;
  name: string;
  model: string;
  message_count: number;
  created_at: string;
  backend: string;
};

const alpha: Session = {
  id: 'session-alpha',
  name: 'Alpha',
  model: 'test-model',
  message_count: 2,
  created_at: '2026-09-23T00:00:00Z',
  backend: 'ollama',
};
const beta: Session = { ...alpha, id: 'session-beta', name: 'Beta' };
const gamma: Session = { ...alpha, id: 'session-gamma', name: 'Gamma' };

let sessions: Session[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selectionButton(name: string) {
  return screen.getByRole('button', { name: `Select session ${name}` });
}

function row(name: string) {
  const selection = selectionButton(name);
  return within(selection.parentElement!.parentElement!);
}

function deleteButton(name: string) {
  return row(name).getByRole('button', { name: `Delete session ${name}` });
}

function openDelete(name: string) {
  fireEvent.click(deleteButton(name));
  return screen.getByRole('dialog');
}

function confirmDelete(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
}

function listCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'jarvis_list_sessions');
}

function deleteCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'jarvis_delete_session');
}

async function mountSessions() {
  render(<JarvisView initialSubView="sessions" />);
  await screen.findByRole('button', { name: 'Select session Alpha' });
}

beforeEach(() => {
  sessions = [alpha, beta, gamma];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'jarvis_list_sessions') return sessions;
    if (command === 'get_all_session_runs') return [];
    return null;
  });
});

afterEach(cleanup);

describe('Jarvis Session deletion coordination', () => {
  it('requires deliberate confirmation and serializes repeated confirmation', async () => {
    await mountSessions();
    const firstDialog = openDelete('Beta');
    expect(firstDialog).toHaveTextContent('Delete session "Beta"?');
    expect(deleteCalls()).toHaveLength(0);

    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Cancel' }));
    expect(deleteCalls()).toHaveLength(0);

    const write = deferred<void>();
    const read = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return write.promise;
      if (command === 'jarvis_list_sessions') return read.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const dialog = openDelete('Beta');
    confirmDelete(dialog);
    confirmDelete(dialog);
    expect(deleteCalls()).toEqual([['jarvis_delete_session', { sessionId: 'session-beta' }]]);
    expect(row('Beta').getByRole('status')).toHaveTextContent(/deleting session/i);
    expect(deleteButton('Beta')).toBeDisabled();

    await act(async () => { write.resolve(); });
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(row('Beta').getByRole('status')).toHaveTextContent(/confirming session removal/i);
    expect(deleteButton('Beta')).toBeDisabled();

    await act(async () => { read.resolve([alpha, gamma]); });
    expect(screen.queryByText('Beta', { selector: 'span' })).not.toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(1);
  });

  it('keeps the row and requires a fresh confirmation after a rejected write', async () => {
    await mountSessions();
    const write = deferred<void>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return write.promise;
      if (command === 'jarvis_list_sessions') return Promise.resolve(sessions);
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const dialog = openDelete('Beta');
    confirmDelete(dialog);
    await act(async () => { write.reject(new Error('private native delete detail')); });

    const alert = row('Beta').getByRole('alert');
    expect(alert).toHaveTextContent(/could not delete the session/i);
    expect(alert).toHaveTextContent(/previous row was kept/i);
    expect(alert).not.toHaveTextContent('private native delete detail');
    expect(deleteButton('Beta')).toBeEnabled();

    const retryWrite = deferred<void>();
    const retryRead = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return retryWrite.promise;
      if (command === 'jarvis_list_sessions') return retryRead.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    const retryDialog = screen.getByRole('dialog');
    expect(deleteCalls()).toHaveLength(1);
    confirmDelete(retryDialog);
    expect(deleteCalls()).toHaveLength(2);
    expect(row('Beta').getByRole('status')).toHaveTextContent(/deleting session/i);

    await act(async () => { retryWrite.resolve(); });
    await act(async () => { retryRead.resolve([alpha, gamma]); });
    expect(screen.queryByText('Beta', { selector: 'span' })).not.toBeInTheDocument();
  });

  it('retains a stale row after readback failure and retries only the list', async () => {
    await mountSessions();
    const write = deferred<void>();
    const failedRead = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return write.promise;
      if (command === 'jarvis_list_sessions') return failedRead.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const dialog = openDelete('Beta');
    confirmDelete(dialog);
    await act(async () => { write.resolve(); });
    await act(async () => { failedRead.reject(new Error('private native readback detail')); });

    const alert = row('Beta').getByRole('alert');
    expect(alert).toHaveTextContent(/deletion was saved/i);
    expect(alert).toHaveTextContent(/retry reloads the list only/i);
    expect(alert).not.toHaveTextContent('private native readback detail');
    expect(deleteButton('Beta')).toBeDisabled();

    const retryRead = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') return retryRead.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    const retry = within(alert).getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(row('Beta').getByRole('status')).toHaveTextContent(/confirming session removal/i);
    expect(listCalls()).toHaveLength(3);
    expect(deleteCalls()).toHaveLength(1);

    await act(async () => { retryRead.resolve([alpha, gamma]); });
    expect(screen.queryByText('Beta', { selector: 'span' })).not.toBeInTheDocument();
  });

  it('retains a contradictory readback as stale and resolves without another write', async () => {
    await mountSessions();
    const write = deferred<void>();
    const contradictory = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return write.promise;
      if (command === 'jarvis_list_sessions') return contradictory.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    confirmDelete(openDelete('Beta'));
    await act(async () => { write.resolve(); });
    await act(async () => { contradictory.resolve(sessions); });

    const alert = row('Beta').getByRole('alert');
    expect(alert).toHaveTextContent(/deletion was saved/i);
    expect(alert).toHaveTextContent(/previous row/i);
    expect(deleteButton('Beta')).toBeDisabled();

    const recovery = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_list_sessions') return recovery.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await act(async () => { recovery.resolve([alpha, gamma]); });

    expect(screen.queryByText('Beta', { selector: 'span' })).not.toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(1);
  });

  it('does not select a deleted row and preserves another selected Session', async () => {
    const user = userEvent.setup();
    await mountSessions();
    await user.click(selectionButton('Alpha'));
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    await screen.findByRole('button', { name: 'Select session Alpha' });

    const write = deferred<void>();
    const read = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return write.promise;
      if (command === 'jarvis_list_sessions') return read.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    confirmDelete(openDelete('Beta'));
    await act(async () => { write.resolve(); });
    await act(async () => { read.resolve([alpha, gamma]); });

    expect(selectionButton('Alpha')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Beta', { selector: 'span' })).not.toBeInTheDocument();
  });

  it('clears the active Session only after authoritative absence', async () => {
    const user = userEvent.setup();
    await mountSessions();
    await user.click(selectionButton('Alpha'));
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    await screen.findByRole('button', { name: 'Select session Alpha' });

    const write = deferred<void>();
    const read = deferred<Session[]>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return write.promise;
      if (command === 'jarvis_list_sessions') return read.promise;
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    confirmDelete(openDelete('Alpha'));
    await act(async () => { write.resolve(); });
    await act(async () => { read.resolve([beta, gamma]); });

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    const newChat = within(screen.getByTestId('jarvis-persistent-nav')).getByRole('button', { name: 'New chat' });
    expect(newChat).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores a pre-delete list completion after a newer absence observation', async () => {
    await mountSessions();
    const preDeleteRead = deferred<Session[]>();
    const postDeleteRead = deferred<Session[]>();
    const write = deferred<void>();
    let listRequest = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'jarvis_delete_session') return write.promise;
      if (command === 'jarvis_list_sessions') {
        listRequest += 1;
        return listRequest === 1 ? preDeleteRead.promise : postDeleteRead.promise;
      }
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    confirmDelete(openDelete('Beta'));
    await act(async () => { write.resolve(); });
    await act(async () => { postDeleteRead.resolve([alpha, gamma]); });
    expect(screen.queryByText('Beta', { selector: 'span' })).not.toBeInTheDocument();

    await act(async () => { preDeleteRead.resolve(sessions); });
    await waitFor(() => expect(screen.queryByText('Beta', { selector: 'span' })).not.toBeInTheDocument());
    expect(deleteCalls()).toHaveLength(1);
  });
});
