import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesChat from './HermesChat';

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

function status(state: string) {
  return { state, reason: null };
}

async function emit(payload: Record<string, unknown>) {
  const listener = listeners.get('hermes-event');
  expect(listener).toBeDefined();
  await act(async () => listener?.({ payload }));
}

beforeEach(() => {
  invokeMock.mockReset();
  listeners.clear();
  Element.prototype.scrollTo = vi.fn();
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

describe('HermesChat availability and turn termination', () => {
  it('shows a redacted unavailable state and a guarded Retry when status is unavailable', async () => {
    const initialStatus = deferred<{ state: string; reason: string | null }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return initialStatus.promise;
      return Promise.resolve(null);
    });
    render(<HermesChat />);
    await act(async () => initialStatus.reject(new Error('private executable path')));
    expect(await screen.findByRole('alert', { name: 'Hermes Bridge availability' })).toHaveTextContent('Hermes Bridge is unavailable.');
    expect(screen.queryByText(/private executable path/)).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry Hermes Bridge' });
    const spawn = deferred<{ state: string; reason: string | null }>();
    invokeMock.mockImplementation((command: string) => command === 'hermes_spawn' ? spawn.promise : Promise.resolve(null));
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    await act(async () => spawn.resolve(status('ready')));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Hermes Bridge status' })).toHaveTextContent('Hermes Bridge ready.'));
  });

  it('shows Stopping and finalizes a stopped turn without a terminal event', async () => {
    const request = deferred<unknown>();
    const stop = deferred<{ state: string; reason: string | null }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('ready'));
      if (command === 'hermes_invoke') return request.promise;
      if (command === 'hermes_interrupt') return stop.promise;
      return Promise.resolve(null);
    });
    render(<HermesChat />);
    const input = await screen.findByRole('textbox', { name: 'Message Hermes' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    const stopping = await screen.findByRole('button', { name: 'Stopping…' });
    fireEvent.click(stopping);
    fireEvent.click(stopping);
    expect(stopping).toBeDisabled();
    await act(async () => stop.resolve(status('cold')));
    expect(await screen.findByText('Session turn stopped.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stopping…' })).not.toBeInTheDocument();
  });

  it('restores a failed prompt and retries it once against the same Session', async () => {
    const firstRequest = deferred<unknown>();
    const retryRequest = deferred<unknown>();
    let submitCount = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('ready'));
      if (command === 'hermes_invoke') {
        submitCount += 1;
        return submitCount === 1 ? firstRequest.promise : retryRequest.promise;
      }
      return Promise.resolve(null);
    });

    render(<HermesChat />);
    const input = await screen.findByRole('textbox', { name: 'Message Hermes' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'recover this prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'hermes_invoke')).toHaveLength(1));

    await act(async () => firstRequest.reject(new Error('token=private-value')));
    expect(await screen.findByRole('alert', { name: 'Hermes prompt submission' })).toHaveTextContent('Could not submit the Hermes prompt.');
    expect(input).toHaveValue('recover this prompt');
    expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();

    const retry = screen.getByRole('button', { name: 'Retry Hermes prompt' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'hermes_invoke')).toHaveLength(2));
    const submitCalls = invokeMock.mock.calls.filter(([command]) => command === 'hermes_invoke');
    expect(submitCalls[1][1]).toEqual(submitCalls[0][1]);
    expect(retry).toBeDisabled();

    const submittedArgs = submitCalls[0][1].args;
    await act(async () => retryRequest.resolve({}));
    await emit({
      type: 'stream.done',
      session_id: submittedArgs.params.session_id,
      params: {},
    });
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('alert', { name: 'Hermes prompt submission' })).not.toBeInTheDocument();
  });

  it('does not replace a newer composer edit when an older submission rejects', async () => {
    const request = deferred<unknown>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'hermes_status') return Promise.resolve(status('ready'));
      if (command === 'hermes_invoke') return request.promise;
      return Promise.resolve(null);
    });

    render(<HermesChat />);
    const input = await screen.findByRole('textbox', { name: 'Message Hermes' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'failed prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(input, { target: { value: 'newer prompt' } });

    await act(async () => request.reject(new Error('private failure detail')));
    await waitFor(() => expect(input).toHaveValue('newer prompt'));
    expect(screen.queryByRole('alert', { name: 'Hermes prompt submission' })).not.toBeInTheDocument();
    expect(screen.queryByText(/private failure detail/)).not.toBeInTheDocument();
  });
});
