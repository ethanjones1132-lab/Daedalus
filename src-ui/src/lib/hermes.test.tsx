import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHermesChat, type HermesState } from './hermes';

const { invokeMock, listenMock, listeners } = vi.hoisted(() => {
  const eventListeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    invokeMock: vi.fn(),
    listenMock: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
      eventListeners.set(eventName, handler);
      return () => {
        if (eventListeners.get(eventName) === handler) eventListeners.delete(eventName);
      };
    }),
    listeners: eventListeners,
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function status(state: HermesState) {
  return { state, reason: null };
}

function Harness({ sessionId = 'session-1' }: { sessionId?: string }) {
  const chat = useHermesChat(sessionId);
  return (
    <div>
      <output data-testid="state">{chat.state}</output>
      <output data-testid="reason">{chat.reason ?? ''}</output>
      <output data-testid="streaming">{String(chat.isStreaming)}</output>
      <output data-testid="starting">{String(chat.isStarting)}</output>
      <output data-testid="stopping">{String(chat.isStopping)}</output>
      <output data-testid="interrupt-error">{chat.interruptError ?? ''}</output>
      <output data-testid="messages">{JSON.stringify(chat.messages)}</output>
      <button type="button" onClick={() => void chat.submit('hello')}>send</button>
      <button type="button" onClick={() => void chat.interrupt()}>stop</button>
      <button type="button" onClick={() => void chat.retry()}>retry</button>
    </div>
  );
}

async function emit(payload: Record<string, unknown>) {
  const listener = listeners.get('hermes-event');
  expect(listener).toBeDefined();
  await act(async () => listener?.({ payload }));
}

function invokeCalls(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'hermes_status') return status('ready');
    if (command === 'hermes_spawn') return status('ready');
    if (command === 'hermes_invoke') return {};
    if (command === 'hermes_interrupt') return status('cold');
    return null;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useHermesChat', () => {
  it('turns a failed status probe into guarded unavailable recovery', async () => {
    const initialStatus = deferred<{ state: HermesState; reason: string | null }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return initialStatus.promise;
      if (command === 'hermes_spawn') return Promise.resolve(status('starting'));
      return Promise.resolve(null);
    });
    render(<Harness />);
    await waitFor(() => expect(listeners.has('hermes-event')).toBe(true));
    await act(async () => initialStatus.reject(new Error('private process path')));

    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('reason')).toHaveTextContent('Hermes Bridge is unavailable.');
    expect(screen.queryByText(/private process path/)).not.toBeInTheDocument();

    const spawn = deferred<{ state: HermesState; reason: string | null }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_spawn') return spawn.promise;
      return Promise.resolve(null);
    });
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(screen.getByTestId('starting')).toHaveTextContent('true');
    await waitFor(() => expect(invokeCalls('hermes_spawn')).toHaveLength(1));
    await act(async () => spawn.resolve(status('starting')));
    await emit({ type: 'gateway.ready', session_id: null, params: {} });
    expect(await screen.findByText('ready')).toBeInTheDocument();
  });

  it('moves a cold bridge through starting to ready using returned state and an event', async () => {
    const spawn = deferred<{ state: HermesState; reason: string | null }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('cold'));
      if (command === 'hermes_spawn') return spawn.promise;
      return Promise.resolve(null);
    });
    render(<Harness />);
    await waitFor(() => expect(invokeCalls('hermes_spawn')).toHaveLength(1));
    expect(screen.getByTestId('state')).toHaveTextContent('starting');
    await act(async () => spawn.resolve(status('starting')));
    expect(screen.getByTestId('state')).toHaveTextContent('starting');
    await emit({ type: 'gateway.ready', session_id: null, params: {} });
    expect(screen.getByTestId('state')).toHaveTextContent('ready');
  });

  it('marks an automatic spawn failure unavailable without exposing process detail', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('cold'));
      if (command === 'hermes_spawn') return Promise.reject(new Error('private executable path'));
      return Promise.resolve(null);
    });
    render(<Harness />);
    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('reason')).toHaveTextContent('Could not start Hermes Bridge.');
    expect(screen.queryByText(/private executable path/)).not.toBeInTheDocument();
  });

  it('accepts turn events only for the active Session and terminalizes once', async () => {
    const request = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('ready'));
      if (command === 'hermes_invoke') return request.promise;
      return Promise.resolve(null);
    });
    render(<Harness sessionId="session-1" />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(invokeCalls('hermes_invoke')).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith('hermes_invoke', {
      args: { method: 'prompt.submit', params: { text: 'hello', session_id: 'session-1' }, timeout_ms: 300000 },
    });

    await emit({ type: 'stream.token', session_id: null, params: { text: 'wrong-null' } });
    await emit({ type: 'stream.token', session_id: 'session-2', params: { text: 'wrong-session' } });
    expect(screen.getByTestId('messages')).not.toHaveTextContent('wrong');
    await emit({ type: 'stream.token', session_id: 'session-1', params: { text: 'right' } });
    await emit({ type: 'stream.done', session_id: 'session-1', params: {} });
    await emit({ type: 'stream.done', session_id: 'session-1', params: {} });
    expect(screen.getByTestId('messages')).toHaveTextContent('right');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('"streaming":true');
    expect(screen.getByTestId('streaming')).toHaveTextContent('false');
  });

  it('stops one active turn once when no terminal event arrives', async () => {
    const request = deferred<unknown>();
    const stop = deferred<{ state: HermesState; reason: string | null }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('ready'));
      if (command === 'hermes_invoke') return request.promise;
      if (command === 'hermes_interrupt') return stop.promise;
      return Promise.resolve(null);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('streaming')).toHaveTextContent('true'));
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    expect(screen.getByTestId('stopping')).toHaveTextContent('true');
    expect(invokeCalls('hermes_interrupt')).toHaveLength(1);
    await act(async () => stop.resolve(status('cold')));
    expect(screen.getByTestId('streaming')).toHaveTextContent('false');
    expect(screen.getByTestId('messages')).toHaveTextContent('"cancelled":true');
  });

  it('keeps the turn active after a failed stop and retries the same interruption', async () => {
    const request = deferred<unknown>();
    let stopCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('ready'));
      if (command === 'hermes_invoke') return request.promise;
      if (command === 'hermes_interrupt') {
        stopCount += 1;
        return stopCount === 1
          ? Promise.reject(new Error('private process detail'))
          : Promise.resolve(status('cold'));
      }
      return Promise.resolve(null);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('streaming')).toHaveTextContent('true'));
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    await waitFor(() => expect(screen.getByTestId('interrupt-error')).toHaveTextContent('Could not stop the Hermes turn.'));
    expect(screen.getByTestId('streaming')).toHaveTextContent('true');
    expect(screen.queryByText(/private process detail/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'stop' }));
    await waitFor(() => expect(screen.getByTestId('streaming')).toHaveTextContent('false'));
    expect(invokeCalls('hermes_interrupt')).toHaveLength(2);
    expect(screen.getByTestId('messages')).toHaveTextContent('"cancelled":true');
  });

  it('redacts native turn failures from message state', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('ready'));
      if (command === 'hermes_invoke') return Promise.reject(new Error('token=secret-value'));
      return Promise.resolve(null);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(screen.getByTestId('streaming')).toHaveTextContent('false'));
    expect(screen.getByTestId('messages')).toHaveTextContent('Hermes turn failed.');
    expect(screen.getByTestId('messages')).not.toHaveTextContent('secret-value');
  });
});
