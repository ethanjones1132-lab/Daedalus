import { nativeMemoryFixture } from './test-native-memory';
// DD-055 — the chat POST must go to the origin the native runtime resolved.
//
// `useSessionTurn` used to capture `http://127.0.0.1:19877` in a module-level
// `JARVIS_API_URL`, so a turn was sent to that literal even when the native
// runtime had discovered its Bun server somewhere else (a configured port, a
// WSL distro) — a first run under the installer reached no server at all.
// These contracts pin the request to `lib/bun-origin`: a resolved non-default
// origin must receive `/chat/stream`, and the documented default must still be
// used when the resolver cannot answer (the test/bridge-down case).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionsPage from './SessionsPage';
import { DEFAULT_BUN_ORIGIN, resetBunOriginForTests } from '../../lib/bun-origin';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const session = {
  id: 'session-1', name: 'First run', model: 'test-model', message_count: 0,
  created_at: '2026-11-04T00:00:00Z', last_active: '2026-11-04T00:00:00Z',
};

/** What the native resolver answers; `null` means the bridge cannot answer. */
let resolvedOrigin: string | null = null;

async function nativeFallback(command: string, args: Record<string, any> = {}) {
  const nativeValue = nativeMemoryFixture(command, args);
  if (nativeValue !== undefined) return nativeValue;
  if (command === 'bun_server_origin') {
    if (resolvedOrigin === null) throw new Error('native runtime not ready');
    return resolvedOrigin;
  }
  switch (command) {
    case 'jarvis_list_sessions': return [session];
    case 'jarvis_new_session': return session;
    case 'get_session_history': return [];
    case 'jarvis_get_session_grants': return { session_id: session.id, grants: [] };
    case 'get_all_session_runs':
    case 'get_session_runs': return [];
    case 'jarvis_get_config':
    case 'jarvis_check_status':
    case 'jarvis_get_companion': return null;
    default: return null;
  }
}

/** Capture every fetched URL and answer the chat POST with an SSE stream. */
function stubFetch() {
  const calls: string[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const fetchMock = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    chatCalls: () => calls.filter((url) => url.endsWith('/chat/stream')),
    finish: async () => {
      await act(async () => {
        controller.enqueue(new TextEncoder().encode('data: {"type":"result","result":"ok"}\n\n'));
        controller.close();
      });
    },
  };
}

async function sendTurn(message: string) {
  const composer = await screen.findByLabelText('Chat input');
  fireEvent.change(composer, { target: { value: message } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await screen.findByRole('status', { name: 'Session turn progress' });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(nativeFallback);
  resolvedOrigin = null;
  // The resolver memoizes its answer per module instance; each case starts cold.
  resetBunOriginForTests();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetBunOriginForTests();
});

describe('the chat POST follows the native-resolved Bun origin', () => {
  it('sends the turn to a non-default origin the resolver reports', async () => {
    resolvedOrigin = 'http://127.0.0.1:20999';
    const io = stubFetch();
    render(<SessionsPage />);
    await sendTurn('first run');

    // The POST is the observable claim: it must carry the resolved origin, not
    // the old `http://127.0.0.1:19877` literal.
    await waitFor(() => expect(io.chatCalls()).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith('bun_server_origin');
    expect(io.chatCalls()).toEqual(['http://127.0.0.1:20999/chat/stream']);
    await io.finish();
  });

  it('keeps the documented default when the resolver cannot answer', async () => {
    resolvedOrigin = null;
    const io = stubFetch();
    render(<SessionsPage />);
    await sendTurn('first run');

    await waitFor(() => expect(io.chatCalls()).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith('bun_server_origin');
    expect(io.chatCalls()).toEqual([`${DEFAULT_BUN_ORIGIN}/chat/stream`]);
    await io.finish();
  });
});
