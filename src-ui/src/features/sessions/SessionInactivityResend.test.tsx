import { nativeMemoryFixture } from './test-native-memory';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';

const { invokeMock, listenMock, watchdog } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
  watchdog: {
    timeoutMs: 0,
    fire: null as null | (() => void),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

// DD-113 — fire the inactivity deadline on demand instead of waiting 90 s of
// wall clock. `InactivityWatchdog`'s own schedule/reset behaviour is pinned by
// domain/sse-protocol.test.ts; this file drives exactly the callback the
// production watchdog hands the turn, which is what performs the abort.
vi.mock('../../domain/sse-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domain/sse-protocol')>();
  return {
    ...actual,
    InactivityWatchdog: class {
      constructor(timeoutMs: number, onTimeout: () => void) {
        watchdog.timeoutMs = timeoutMs;
        watchdog.fire = onTimeout;
      }
      start() {}
      touch() {}
      stop() {}
    },
  };
});

const props = {
  activeSession: 'session-1',
  setActiveSession: vi.fn(),
  config: null,
  backendLabel: 'Ollama',
  modelLabel: 'test-model',
  onSessionCreated: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  watchdog.timeoutMs = 0;
  watchdog.fire = null;
  // Unique saved ids per append: a duplicate user row cannot hide behind a
  // stable fixture id.
  let appendedUsers = 0;
  invokeMock.mockImplementation(async (command: string, nativeArgs: Record<string, any> = {}) => {
    if (command === 'append_message' && nativeArgs.role === 'user') {
      appendedUsers += 1;
      return `persisted-user-${appendedUsers}`;
    }
    const nativeValue = nativeMemoryFixture(command, nativeArgs);
    if (nativeValue !== undefined) return nativeValue;
    if (command === 'get_session_history') return [];
    if (command === 'jarvis_list_sessions' || command === 'get_all_session_runs') return [];
    if (command === 'jarvis_get_session_grants') return { session_id: 'session-1', grants: [] };
    return true;
  });
});

const userAppends = () => invokeMock.mock.calls.filter(
  ([command, nativeArgs]) => command === 'append_message' && nativeArgs?.role === 'user',
);

describe('DD-113 resend after the 90 s stream-inactivity abort', () => {
  it('re-uses the saved user row so the resend leaves one user row and one turn id', async () => {
    let attempt = 0;
    let silentController!: ReadableStreamDefaultController<Uint8Array>;
    const silentStream = new ReadableStream<Uint8Array>({ start(value) { silentController = value; } });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      attempt += 1;
      if (attempt === 1) {
        // The real transport errors the body when its request signal aborts;
        // the watchdog's abort must reach the pending read the same way.
        init.signal?.addEventListener('abort', () => {
          try {
            silentController.error(new DOMException('Aborted', 'AbortError'));
          } catch {
            /* the reader already ended the body */
          }
        });
        return new Response(silentStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('data: {"type":"result","result":"recovered answer"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }));
    render(<ChatPanel {...props} />);
    const composer = await screen.findByLabelText('Chat input') as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: 'resend after the silence' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    // The POST was accepted and the user row saved; the stream then stays silent.
    await screen.findByRole('status', { name: 'Session turn progress' });
    await waitFor(() => expect(watchdog.fire).not.toBeNull());
    expect(watchdog.timeoutMs).toBe(90_000);
    expect(userAppends()).toHaveLength(1);

    // 90 s pass with no frame: the watchdog aborts this turn.
    await act(async () => { watchdog.fire!(); });

    expect(await screen.findByRole('alert')).toHaveTextContent('The turn failed.');
    expect(composer.value).toBe('resend after the silence');
    // The aborted turn saved only the user row; no assistant row exists for it.
    expect(userAppends()).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(
      ([command, nativeArgs]) => command === 'append_message' && nativeArgs?.role === 'assistant',
    )).toHaveLength(0);

    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('recovered answer')).toBeInTheDocument());
    // Exactly ONE saved user row for the two attempts: the resend re-used the
    // row the aborted turn saved instead of appending a second one, and the
    // transcript holds exactly one bubble for it.
    expect(userAppends()).toHaveLength(1);
    expect(userAppends()[0][1].content).toBe('resend after the silence');
    expect(screen.getAllByText('resend after the silence')).toHaveLength(1);
    // One turn identity for that row: the retry prepared the SAME persisted row
    // rather than a freshly appended duplicate.
    const preparedRowIds = invokeMock.mock.calls
      .filter(([command]) => command === 'memory_prepare_turn')
      .map(([, nativeArgs]) => nativeArgs.request.user_message_id);
    expect(preparedRowIds).toHaveLength(2);
    expect(new Set(preparedRowIds)).toEqual(new Set(['persisted-user-1']));
    // And the saved answer belongs to exactly one memory turn.
    const turnIds = invokeMock.mock.calls
      .filter(([command, nativeArgs]) => command === 'append_message' && nativeArgs?.role === 'assistant')
      .map(([, nativeArgs]) => nativeArgs.memory_turn_id);
    expect(turnIds).toHaveLength(1);
    expect(typeof turnIds[0]).toBe('string');
  });
});
