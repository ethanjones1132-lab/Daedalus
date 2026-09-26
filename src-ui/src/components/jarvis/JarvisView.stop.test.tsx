import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './JarvisView';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const props = {
  activeSession: 'session-1' as string | null,
  setActiveSession: vi.fn(),
  config: null,
  backendLabel: 'OpenRouter',
  modelLabel: 'test-model',
  onSessionCreated: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'get_session_history') return [];
    if (command === 'jarvis_list_sessions' || command === 'get_all_session_runs') return [];
    if (command === 'jarvis_get_config' || command === 'jarvis_check_status' || command === 'jarvis_get_companion') return null;
    if (command === 'jarvis_get_session_grants') return { session_id: 'session-1', grants: [] };
    if (command === 'append_message') return 'row-1';
    return true;
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

/**
 * A live SSE response the test drives frame by frame. The abort listener is
 * what a real `fetch` does to the body when its signal fires, so a Stop that
 * the server confirms tears the reader down the same way it does in the app.
 */
function stubStreamingFetch() {
  let chat: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/chat/cancel')) return new Response('{}', { status: 200 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chat = controller;
        init?.signal?.addEventListener('abort', () => {
          try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* already closed */ }
        }, { once: true });
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const live = () => {
    if (!chat) throw new Error('the chat stream has not been opened yet');
    return chat;
  };
  return {
    fetchMock,
    emit: async (frame: object) => {
      await act(async () => {
        live().enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      });
    },
    close: async () => {
      await act(async () => { try { live().close(); } catch { /* already closed */ } });
    },
  };
}

function cancelCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'cancel_chat_stream');
}

function terminalRunWrites() {
  return invokeMock.mock.calls.filter(([command]) => command === 'record_terminal_run');
}

/** Render the panel, send a turn, and stream one partial answer. */
async function startStreamingTurn(stream: ReturnType<typeof stubStreamingFetch>, options: { partial?: boolean } = {}) {
  const { partial = true } = options;
  const view = render(<ChatPanel {...props} />);
  const composer = await screen.findByLabelText('Chat input');
  fireEvent.change(composer, { target: { value: 'walk the workspace' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  const stop = await screen.findByLabelText('Stop streaming');
  if (partial) {
    await stream.emit({ type: 'stream_event', delta: { text: 'Partial answer' } });
    await waitFor(() => expect(screen.getByText(/Streaming ·/)).toBeInTheDocument());
  } else {
    await waitFor(() => expect(screen.getByText(/Streaming ·/)).toBeInTheDocument());
  }
  return { view, stop };
}

/** The default read mock, with `cancel_chat_stream` answering `false`. */
function mockInvokeWithStop(answer: (attempt: number) => unknown) {
  let attempt = 0;
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'cancel_chat_stream') {
      attempt += 1;
      const result = answer(attempt);
      if (result instanceof Error) throw result;
      return result;
    }
    if (command === 'get_session_history') return [];
    if (command === 'jarvis_list_sessions' || command === 'get_all_session_runs') return [];
    if (command === 'jarvis_get_config' || command === 'jarvis_check_status' || command === 'jarvis_get_companion') return null;
    if (command === 'jarvis_get_session_grants') return { session_id: 'session-1', grants: [] };
    if (command === 'append_message') return 'row-1';
    return true;
  });
}

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('stopping a Session turn', () => {
  it('asks the server once for repeated Stop input while the request is in flight', async () => {
    const stream = stubStreamingFetch();
    const confirmation = defer<boolean>();
    mockInvokeWithStop(() => confirmation.promise);
    const { stop } = await startStreamingTurn(stream);

    await act(async () => {
      fireEvent.click(stop);
      fireEvent.click(stop);
      fireEvent.keyDown(screen.getByLabelText('Chat input'), { key: 'Escape' });
    });
    expect(cancelCalls()).toHaveLength(1);

    const status = await screen.findByRole('status', { name: 'Session turn stop' });
    expect(status).toHaveTextContent('Stopping Session turn…');
    expect(screen.getByLabelText('Stop streaming')).toBeDisabled();
    expect(screen.queryByRole('alert', { name: 'Session turn stop' })).not.toBeInTheDocument();

    await act(async () => { confirmation.resolve(true); });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Session turn stop' })).not.toBeInTheDocument());
  });

  it('finalizes the partial answer as intentionally stopped once the server confirms', async () => {
    const stream = stubStreamingFetch();
    mockInvokeWithStop(() => true);
    const { stop } = await startStreamingTurn(stream);

    await act(async () => { fireEvent.click(stop); });

    await waitFor(() => expect(screen.queryByLabelText('Stop streaming')).not.toBeInTheDocument());
    // The stopped vocabulary rather than a complete-looking answer: the muted
    // bubble, its `stopped` pill, and the marker in place of the body. This
    // turn used to finalize as a plain assistant message — the single reading
    // that says the model finished.
    expect(screen.getByText('stopped')).toBeInTheDocument();
    expect(screen.getByText('(stopped)')).toBeInTheDocument();
    // A stop the operator asked for is not a failure, so nothing is announced
    // as one.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const writes = terminalRunWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ outcome: 'cancelled', cancelledReason: 'user_stop' });
  });

  it('records the reason the server sent when its cancelled frame wins the race', async () => {
    const stream = stubStreamingFetch();
    const confirmation = defer<boolean>();
    mockInvokeWithStop(() => confirmation.promise);
    const { stop } = await startStreamingTurn(stream);

    fireEvent.click(stop);
    // The server's own terminal frame lands first, carrying its own
    // classification of the abort. A local teardown afterwards must neither
    // overwrite that reason nor write a second record.
    await stream.emit({ type: 'cancelled', reason: 'superseded' });
    await stream.close();
    await waitFor(() => expect(terminalRunWrites()).toHaveLength(1));
    expect(terminalRunWrites()[0][1]).toMatchObject({ outcome: 'cancelled', cancelledReason: 'superseded' });
    // The turn is over, so nothing is left claiming a stop is in flight.
    expect(screen.queryByRole('status', { name: 'Session turn stop' })).not.toBeInTheDocument();

    await act(async () => { confirmation.resolve(true); });
    expect(cancelCalls()).toHaveLength(1);
    expect(terminalRunWrites()).toHaveLength(1);
  });

  it('keeps the turn running and says so when the server refuses the stop', async () => {
    const stream = stubStreamingFetch();
    mockInvokeWithStop(() => false);
    const { stop } = await startStreamingTurn(stream);

    await act(async () => { fireEvent.click(stop); });

    const alert = await screen.findByRole('alert', { name: 'Session turn stop' });
    expect(alert).toHaveTextContent('Could not stop this turn. The server did not stop it');
    expect(alert).toHaveTextContent('may still arrive');
    // The turn is retained: its answer may still be on the wire. The token
    // buffer is flushed on an animation frame, so this waits for the real
    // render rather than assuming the frame has already run.
    expect(screen.getByLabelText('Stop streaming')).toBeEnabled();
    expect(screen.getByText(/Streaming ·/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Partial answer')).toBeInTheDocument());
    expect(terminalRunWrites()).toHaveLength(0);
    // The duplicate direct HTTP cancellation is gone: the one lifecycle owner
    // is the native command.
    expect(stream.fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/chat/cancel'))).toHaveLength(0);
  });

  it('distinguishes a stop request that could not be made from one the server refused', async () => {
    const stream = stubStreamingFetch();
    mockInvokeWithStop(() => new Error('Native store is locked: /Users/operator/.jarvis/daedalus.sqlite3 (SQLITE_BUSY)'));
    const { stop } = await startStreamingTurn(stream);

    await act(async () => { fireEvent.click(stop); });

    const alert = await screen.findByRole('alert', { name: 'Session turn stop' });
    expect(alert).toHaveTextContent('Could not reach the server to stop this turn.');
    expect(alert).not.toHaveTextContent('SQLITE');
    expect(alert).not.toHaveTextContent('daedalus.sqlite3');
    expect(document.body.textContent).not.toContain('SQLITE_BUSY');
    expect(screen.getByLabelText('Stop streaming')).toBeEnabled();
  });

  it('offers a deliberate retry that issues a second request and can end the turn', async () => {
    const stream = stubStreamingFetch();
    const second = defer<boolean>();
    mockInvokeWithStop((attempt) => (attempt === 1 ? false : second.promise));
    const { stop } = await startStreamingTurn(stream);

    await act(async () => { fireEvent.click(stop); });
    const alert = await screen.findByRole('alert', { name: 'Session turn stop' });
    const retry = within(alert).getByRole('button', { name: 'Retry stop' });
    expect(retry).toBeEnabled();

    await act(async () => { fireEvent.click(retry); });
    expect(cancelCalls()).toHaveLength(2);
    // The retry is in flight: the strip hands over to the announced pending
    // sentence, and the Stop control refuses a third request.
    expect(screen.queryByRole('alert', { name: 'Session turn stop' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Session turn stop' })).toHaveTextContent('Stopping Session turn…');
    expect(screen.getByLabelText('Stop streaming')).toBeDisabled();
    await act(async () => { fireEvent.click(screen.getByLabelText('Stop streaming')); });
    expect(cancelCalls()).toHaveLength(2);

    await act(async () => { second.resolve(true); });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Session turn stop' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByLabelText('Stop streaming')).not.toBeInTheDocument());
    expect(screen.getByText('stopped')).toBeInTheDocument();
    expect(terminalRunWrites()).toHaveLength(1);
    expect(terminalRunWrites()[0][1]).toMatchObject({ outcome: 'cancelled', cancelledReason: 'user_stop' });
  });

  it('does not relabel a normal answer cancelled when a stop was requested', async () => {
    const stream = stubStreamingFetch();
    const confirmation = defer<boolean>();
    mockInvokeWithStop(() => confirmation.promise);
    const { stop } = await startStreamingTurn(stream, { partial: false });

    fireEvent.click(stop);
    await stream.emit({ type: 'result', result: 'The whole answer' });
    await stream.close();
    await waitFor(() => expect(terminalRunWrites()).toHaveLength(1));
    await act(async () => { confirmation.resolve(true); });

    expect(terminalRunWrites()[0][1]).toMatchObject({ outcome: 'success', cancelledReason: null });
    expect(screen.getByText('The whole answer')).toBeInTheDocument();
    expect(screen.queryByText('stopped')).not.toBeInTheDocument();
  });

  it('stops an older completion from changing the turn of a Session the view has left', async () => {
    const stream = stubStreamingFetch();
    const confirmation = defer<boolean>();
    mockInvokeWithStop(() => confirmation.promise);
    const { view, stop } = await startStreamingTurn(stream);

    fireEvent.click(stop);
    await screen.findByRole('status', { name: 'Session turn stop' });
    view.rerender(<ChatPanel {...props} activeSession="session-2" />);
    await act(async () => { confirmation.resolve(true); });

    expect(screen.queryByRole('status', { name: 'Session turn stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Session turn stop' })).not.toBeInTheDocument();
    expect(terminalRunWrites()).toHaveLength(0);
  });

  it('clears an unconfirmed stop when the next Session is opened', async () => {
    const stream = stubStreamingFetch();
    mockInvokeWithStop(() => false);
    const { stop } = await startStreamingTurn(stream);

    await act(async () => { fireEvent.click(stop); });
    expect(await screen.findByRole('alert', { name: 'Session turn stop' })).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '+ New Chat' })); });
    expect(screen.queryByRole('alert', { name: 'Session turn stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Session turn stop' })).not.toBeInTheDocument();
  });
});
