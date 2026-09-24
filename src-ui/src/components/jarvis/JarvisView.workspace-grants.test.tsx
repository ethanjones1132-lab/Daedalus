import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView from './JarvisView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const sessions = [
  { id: 'Alpha', name: 'Alpha', model: 'test-model', message_count: 0, created_at: '2026-09-23T00:00:00Z' },
  { id: 'Beta', name: 'Beta', model: 'test-model', message_count: 0, created_at: '2026-09-23T00:00:00Z' },
];
const alphaRoot = '/workspace/alpha';
const betaRoot = '/workspace/beta';

function grantResponse(sessionId: string, grants: string[]) {
  return { session_id: sessionId, grants };
}

function mockBase(grant: (sessionId: string) => Promise<unknown>) {
  invokeMock.mockImplementation((command: string, args?: { sessionId?: string; root?: string }) => {
    if (command === 'jarvis_list_sessions') return Promise.resolve(sessions);
    if (command === 'get_all_session_runs') return Promise.resolve([]);
    if (command === 'get_session_history') return Promise.resolve([]);
    if (command === 'jarvis_get_session_grants') return grant(args?.sessionId ?? '');
    if (command === 'jarvis_revoke_session_grant') {
      return Promise.resolve(grantResponse(args?.sessionId ?? '', [betaRoot]));
    }
    return Promise.resolve(null);
  });
}

async function selectSession(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }));
}

beforeEach(() => {
  invokeMock.mockReset();
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

afterEach(cleanup);

describe('Jarvis workspace grant ownership', () => {
  it('loads grants for the selected existing Session and revokes that Session', async () => {
    mockBase(async (sessionId) => grantResponse(sessionId, sessionId === 'Alpha' ? [alphaRoot] : []));
    render(<JarvisView />);

    await selectSession('Alpha');
    expect(await screen.findByText(alphaRoot)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('jarvis_get_session_grants', { sessionId: 'Alpha' });

    fireEvent.click(screen.getByRole('button', { name: `Revoke grant for ${alphaRoot}` }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_revoke_session_grant', { sessionId: 'Alpha', root: alphaRoot }));
  });

  it('hides Alpha controls while Beta is pending and ignores Alpha completion', async () => {
    const alpha = deferred<unknown>();
    const beta = deferred<unknown>();
    mockBase((sessionId) => sessionId === 'Alpha' ? alpha.promise : beta.promise);
    render(<JarvisView />);

    await selectSession('Alpha');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_get_session_grants', { sessionId: 'Alpha' }));
    await selectSession('Beta');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('jarvis_get_session_grants', { sessionId: 'Beta' }));
    expect(screen.queryByText(alphaRoot)).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Workspace grants loading' })).toBeInTheDocument();

    await act(async () => alpha.resolve(grantResponse('Alpha', [alphaRoot])));
    expect(screen.queryByText(alphaRoot)).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Workspace grants loading' })).toBeInTheDocument();

    await act(async () => beta.resolve(grantResponse('Beta', [betaRoot])));
    expect(screen.getByText(betaRoot)).toBeInTheDocument();
  });
});
