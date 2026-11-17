import { nativeMemoryFixture } from './test-native-memory';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { turnFailureCopy } from './useSessionTurn';
import { resetBunOriginForTests } from '../../lib/bun-origin';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const GENERIC = 'The turn failed. Your message is kept as a draft — send it again to retry.';
const SESSION_CREATION_FAILED = 'Could not create a Session for this message.';
// Assembled at runtime so the repository's secret scanner never sees a literal
// key shape; the credential-shape redaction is what this run tests.
const FAKE_KEY = ['sk', 'or-v1', 'DD103SECRETMARKER0123456789'].join('-');

const props = {
  activeSession: 'session-1',
  setActiveSession: vi.fn(),
  config: null,
  backendLabel: 'OpenRouter',
  modelLabel: 'test-model',
  onSessionCreated: vi.fn(),
};

function defaultInvoke(command: string, nativeArgs: Record<string, any> = {}) {
  const nativeValue = nativeMemoryFixture(command, nativeArgs);
  if (nativeValue !== undefined) return Promise.resolve(nativeValue);
  if (command === 'get_session_history') return Promise.resolve([]);
  if (command === 'jarvis_list_sessions' || command === 'get_all_session_runs') return Promise.resolve([]);
  if (command === 'jarvis_get_config' || command === 'jarvis_check_status' || command === 'jarvis_get_companion') return Promise.resolve(null);
  if (command === 'jarvis_get_session_grants') return Promise.resolve({ session_id: 'session-1', grants: [] });
  return Promise.resolve(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBunOriginForTests();
  invokeMock.mockImplementation(defaultInvoke);
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

async function send(text: string): Promise<HTMLTextAreaElement> {
  const composer = await screen.findByLabelText('Chat input') as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  return composer;
}

describe('ChatPanel turn-failure copy', () => {
  it('shows the reason a Session could not be created and keeps the draft', async () => {
    invokeMock.mockImplementation((command: string, nativeArgs: Record<string, any> = {}) =>
      command === 'jarvis_new_session'
        ? Promise.resolve({ id: '' })
        : defaultInvoke(command, nativeArgs));

    render(<ChatPanel {...props} activeSession={null} />);
    const composer = await send('keep this draft');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(SESSION_CREATION_FAILED);
    expect(alert).not.toHaveTextContent('The turn failed.');
    expect(composer.value).toBe('keep this draft');
  });

  it('withholds a Native Session-creation diagnostic behind the authored sentence', async () => {
    invokeMock.mockImplementation((command: string, nativeArgs: Record<string, any> = {}) =>
      command === 'jarvis_new_session'
        ? Promise.reject(new Error('jarvis_new_session failed at C:\\DD103_NATIVE_MARKER'))
        : defaultInvoke(command, nativeArgs));

    render(<ChatPanel {...props} activeSession={null} />);
    const composer = await send('keep this draft');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(SESSION_CREATION_FAILED);
    expect(document.body.textContent ?? '').not.toContain('DD103_NATIVE_MARKER');
    expect(composer.value).toBe('keep this draft');
  });

  it('keeps a coded Jarvis stream reason friendly and shows its code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'No inference backend is configured for this Session.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )));

    render(<ChatPanel {...props} />);
    const composer = await send('explain the failure');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Jarvis server returned 500.');
    expect(alert).toHaveTextContent('No inference backend is configured for this Session.');
    expect(await screen.findByText('code: server_error')).toBeInTheDocument();
    expect(composer.value).toBe('explain the failure');
  });

  it('falls back to the fixed sentence when a transport failure is not an Error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'DD103_RAW_TRANSPORT_MARKER'; }));

    render(<ChatPanel {...props} />);
    const composer = await send('keep this draft');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The turn failed.');
    expect(alert).toHaveTextContent('Your message is kept as a draft');
    expect(document.body.textContent ?? '').not.toContain('DD103_RAW_TRANSPORT_MARKER');
    expect(composer.value).toBe('keep this draft');
  });

  it('withholds a credential-shaped reason behind the fixed sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: `Invalid API key ${FAKE_KEY}` }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )));

    render(<ChatPanel {...props} />);
    const composer = await send('keep this draft');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The turn failed.');
    expect(document.body.textContent ?? '').not.toContain('DD103SECRETMARKER');
    expect(composer.value).toBe('keep this draft');
  });
});

describe('turnFailureCopy', () => {
  it('normalizes a coded reason to one trimmed line and never renders a stack', () => {
    const copy = turnFailureCopy(
      new Error('\n  First   reason  \n    at handler (bundle.js:10:4)\n'),
      'server_error',
    );
    expect(copy).toBe('First reason');
  });

  it('keeps the fixed sentence for an empty or whitespace-only reason', () => {
    expect(turnFailureCopy(new Error('   \n \t '), 'server_error')).toBe(GENERIC);
  });

  it('keeps the fixed sentence for a non-Error rejection', () => {
    expect(turnFailureCopy('connection refused', 'server_error')).toBe(GENERIC);
  });

  it('keeps the fixed sentence for a credential-shaped reason', () => {
    expect(turnFailureCopy(
      new Error(`provider rejected ${FAKE_KEY}`),
      'server_error',
    )).toBe(GENERIC);
  });

  it('shows the authored Session-creation sentence, but not an uncoded transport message', () => {
    expect(turnFailureCopy(new Error(SESSION_CREATION_FAILED))).toBe(SESSION_CREATION_FAILED);
    expect(turnFailureCopy(new Error('connection refused'))).toBe(GENERIC);
  });
});
