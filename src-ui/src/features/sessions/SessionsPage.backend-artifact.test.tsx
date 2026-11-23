// DD-111 — a configured llama.cpp artifact path that is not a file is its own
// fault, not a backend that "may still be starting".
//
// The mounted page is the contract: `get_backend_readiness` answers
// `missing_file` carrying the setting and the exact path, and the composer note
// must print that path while Send stays disabled. The same sentence is what the
// health band prints for the same record.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionsPage from './SessionsPage';
import { resetBunOriginForTests } from '../../lib/bun-origin';
import { nativeMemoryFixture } from './test-native-memory';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const unusableServerPath = {
  state: 'missing_file',
  backend: 'llama_cpp',
  missing: [
    {
      key: 'llama_cpp.server_path',
      label: 'llama.cpp server_path',
      env_var: 'JARVIS_LLAMA_SERVER_PATH',
      path: 'C:/tools/llama-server',
    },
  ],
};

async function nativeFallback(command: string, args: Record<string, any> = {}) {
  const nativeValue = nativeMemoryFixture(command, args);
  if (nativeValue !== undefined) return nativeValue;
  switch (command) {
    case 'get_backend_readiness':
      return unusableServerPath;
    case 'jarvis_list_sessions':
    case 'get_session_history':
    case 'get_all_session_runs':
    case 'get_session_runs':
      return [];
    case 'jarvis_get_session_grants':
      return { session_id: 'session-1', grants: [] };
    default:
      return null;
  }
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(nativeFallback);
  resetBunOriginForTests();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  resetBunOriginForTests();
});

describe('a configured artifact that is not a file', () => {
  it('prints the setting and path in the composer note and refuses to send', async () => {
    render(<SessionsPage />);

    const note = await screen.findByRole('note', { name: 'Chat setup required' });
    expect(note).toHaveTextContent('llama.cpp server_path');
    expect(note).toHaveTextContent('C:/tools/llama-server');
    expect(note).toHaveTextContent('which is not a file');
    expect(note).not.toHaveTextContent('still starting');

    const composer = screen.getByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'explain the failure' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
});
