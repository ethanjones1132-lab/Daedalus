import { nativeMemoryFixture } from './test-native-memory';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { resetBunOriginForTests } from '../../lib/bun-origin';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const props = {
  activeSession: 'session-1',
  setActiveSession: vi.fn(),
  config: null,
  backendLabel: 'OpenRouter',
  modelLabel: 'test-model',
  onSessionCreated: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  resetBunOriginForTests();
  invokeMock.mockImplementation(async (command: string, nativeArgs: Record<string, any> = {}) => {
    const nativeValue = nativeMemoryFixture(command, nativeArgs);
    if (nativeValue !== undefined) return Promise.resolve(nativeValue);
    if (command === 'get_session_history') return [];
    if (command === 'jarvis_list_sessions' || command === 'get_all_session_runs') return [];
    if (command === 'jarvis_get_config' || command === 'jarvis_check_status' || command === 'jarvis_get_companion') return null;
    if (command === 'jarvis_get_session_grants') return { session_id: 'session-1', grants: [] };
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

async function sendTurn(): Promise<HTMLElement> {
  render(<ChatPanel {...props} />);
  const composer = await screen.findByLabelText('Chat input');
  fireEvent.change(composer, { target: { value: 'explain the failure' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  return screen.findByRole('alert');
}

describe('a failed chat POST names the status and the server message', () => {
  it('surfaces the message from a 500 JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'No inference backend is configured for this Session.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )));

    const alert = await sendTurn();

    expect(alert).toHaveTextContent('Jarvis server returned 500.');
    expect(alert).toHaveTextContent('No inference backend is configured for this Session.');
  });

  it('does not leak markup from a 503 HTML gateway body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<!doctype html><html><body><h1>503 Service Unavailable</h1><p>trace=DD056_SECRET_MARKER</p></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html' } },
    )));

    const alert = await sendTurn();

    expect(alert).toHaveTextContent('Jarvis server returned 503.');
    expect(alert.textContent ?? '').not.toContain('<');
    expect(alert.textContent ?? '').not.toContain('DD056_SECRET_MARKER');
    expect(alert.textContent ?? '').not.toContain('Service Unavailable');
  });

  it('keeps the status-only message when the body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));

    const alert = await sendTurn();

    expect(alert).toHaveTextContent('Jarvis server returned 500.');
    expect(alert.textContent?.trim()).toBe('Jarvis server returned 500.');
  });
});
