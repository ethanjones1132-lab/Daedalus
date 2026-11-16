import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { resetBunOriginForTests } from '../../lib/bun-origin';
import { nativeMemoryFixture } from './test-native-memory';

// DD-060: with no configured backend the composer must not pretend a turn can
// run. The sentence is Native's own derivation, passed down by SessionsPage.
const BLOCKED =
  'llama.cpp is missing llama.cpp server_path (or JARVIS_LLAMA_SERVER_PATH) and ' +
  'llama.cpp model_path (or JARVIS_LLAMA_MODEL_PATH). Set it in Settings to chat.';

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
  backendLabel: 'llama.cpp',
  modelLabel: '',
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

describe('chat while no inference backend is configured', () => {
  it('names the missing setting and refuses to send', async () => {
    render(<ChatPanel {...props} chatBlockedReason={BLOCKED} />);

    const note = await screen.findByRole('note', { name: 'Chat setup required' });
    expect(note).toHaveTextContent('llama.cpp server_path');
    expect(note).toHaveTextContent('JARVIS_LLAMA_MODEL_PATH');
    expect(note).toHaveTextContent('Open Settings');

    const composer = screen.getByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'explain the failure' } });

    // Text in the box is not enough: a doomed turn must not be startable.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop streaming' })).not.toBeInTheDocument();
  });

  it('blocks Send when a configured backend is not listening', async () => {
    // DD-067: nothing is blank, so this is not the setup band — it is the other
    // way a first chat dies, a configured backend whose port nothing answers.
    const NOT_LISTENING =
      'llama.cpp is configured, but nothing is answering its port yet — it may still be starting.';
    render(<ChatPanel {...props} chatBlockedReason={NOT_LISTENING} />);

    const note = await screen.findByRole('note', { name: 'Chat setup required' });
    expect(note).toHaveTextContent('llama.cpp is configured');
    expect(note).toHaveTextContent('nothing is answering');
    expect(note).toHaveTextContent('may still be starting');

    const composer = screen.getByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'are you there?' } });

    // Text in the box is not enough: a turn that cannot reach the backend must
    // not be startable.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('leaves the composer usable when a backend is configured', async () => {
    render(<ChatPanel {...props} />);

    const composer = await screen.findByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'explain the failure' } });

    expect(screen.queryByRole('note', { name: 'Chat setup required' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
});
