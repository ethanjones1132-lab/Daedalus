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
// Assembled the same way: a bearer token and a hex key of key length, with no
// literal secret shape in the source.
const FAKE_BEARER_TOKEN = ['DD110', 'BEARERMARKER', '0123456789'].join('-');
const FAKE_HEX_KEY = Array.from({ length: 40 }, (_, index) => '0123456789abcdef'.charAt(index % 16)).join('');
// DD-110 — `describePipelineError` in server-jarvis/src/orchestration/pipeline.ts
// (the 401 branch, line 941) answers a rejected provider key with exactly this
// sentence, and the server sends it as the `error` of a `stage_error` frame.
// It names the API key on purpose, so it must reach the bubble verbatim.
const REJECTED_KEY_SENTENCE = 'Authentication failed (401): the inference provider rejected the API key. Check your OpenRouter API key in Settings.';

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

  it('shows the server sentence that names the rejected API key, with its code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `data: ${JSON.stringify({ type: 'error', code: 'stage_error', error: REJECTED_KEY_SENTENCE })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));

    render(<ChatPanel {...props} />);
    const composer = await send('keep this draft');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain(REJECTED_KEY_SENTENCE);
    // The first-run operator is told to check the key in Settings, not to
    // resend the same rejected credential.
    expect(alert).not.toHaveTextContent('send it again to retry');
    expect(await screen.findByText('code: stage_error')).toBeInTheDocument();
    expect(composer.value).toBe('keep this draft');
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

  it('withholds a reason carrying an sk- key and its long value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: `Invalid API key ${FAKE_KEY}` }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )));

    render(<ChatPanel {...props} />);
    const composer = await send('keep this draft');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The turn failed.');
    // The sk- shape is what withholds this reason, not the words around it.
    expect(alert).not.toHaveTextContent(/api key/i);
    expect(document.body.textContent ?? '').not.toContain('DD103SECRETMARKER');
    expect(composer.value).toBe('keep this draft');
  });

  it('withholds a bearer token behind the fixed sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: `upstream rejected Bearer ${FAKE_BEARER_TOKEN}` }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )));

    render(<ChatPanel {...props} />);
    const composer = await send('keep this draft');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The turn failed.');
    expect(alert).not.toHaveTextContent(/bearer/i);
    expect(document.body.textContent ?? '').not.toContain('DD110BEARERMARKER');
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

  it('shows the server sentence that names the rejected API key, with its code', () => {
    expect(turnFailureCopy(new Error(REJECTED_KEY_SENTENCE), 'stage_error')).toBe(REJECTED_KEY_SENTENCE);
  });

  it('does not treat a credential name as the credential itself', () => {
    expect(turnFailureCopy(new Error('The api_key is malformed for this model.'), 'stage_error'))
      .toBe('The api_key is malformed for this model.');
  });

  it('withholds a bearer token and a long hex key even when the reason names the credential', () => {
    expect(turnFailureCopy(
      new Error(`Authorization failed: Bearer ${FAKE_BEARER_TOKEN}`),
      'stage_error',
    )).toBe(GENERIC);
    expect(turnFailureCopy(
      new Error(`Invalid API key: ${FAKE_HEX_KEY}`),
      'stage_error',
    )).toBe(GENERIC);
  });

  it('shows the authored Session-creation sentence, but not an uncoded transport message', () => {
    expect(turnFailureCopy(new Error(SESSION_CREATION_FAILED))).toBe(SESSION_CREATION_FAILED);
    expect(turnFailureCopy(new Error('connection refused'))).toBe(GENERIC);
  });
});
