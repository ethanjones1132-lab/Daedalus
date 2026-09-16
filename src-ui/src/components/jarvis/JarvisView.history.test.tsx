import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const sessions = ['Alpha', 'Beta'].map((name) => ({
  id: name, name, model: 'test-model', message_count: 2, created_at: '2026-09-16T00:00:00Z',
}));
const row = (content: string) => ({ id: content, role: 'user', content, created_at: '2026-09-16T00:00:00Z' });
const splash = 'Your local AI coding assistant. Ask me to build, debug, or explore code.';
function mockHistory(load: (id: string) => Promise<unknown>) {
  invokeMock.mockImplementation((command: string, args?: { sessionId: string }) => {
    if (command === 'jarvis_list_sessions') return Promise.resolve(sessions);
    if (command === 'get_session_history') return load(args!.sessionId);
    if (command === 'get_all_session_runs') return Promise.resolve([]);
    return Promise.resolve(null);
  });
}
async function select(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }));
}
const transcript = () => within(screen.getByRole('log', { name: 'Jarvis chat transcript' }));

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

describe('Session history resource states', () => {
  it('distinguishes pending and rejected history from empty, then retries and deduplicates restored messages', async () => {
    const first = deferred<unknown[]>();
    const retry = deferred<unknown[]>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    mockHistory(load);
    render(<JarvisView />);
    await select('Alpha');
    expect(transcript().getByRole('status')).toHaveTextContent('Loading session history');
    expect(screen.queryByText(splash)).not.toBeInTheDocument();
    await act(async () => first.reject(new Error('sqlite unavailable')));
    expect(transcript().getByRole('alert')).toHaveTextContent('Could not load session history');
    expect(screen.queryByText(splash)).not.toBeInTheDocument();
    fireEvent.click(transcript().getByRole('button', { name: 'Retry' }));
    expect(transcript().queryByRole('alert')).not.toBeInTheDocument();
    expect(transcript().getByRole('status')).toHaveTextContent('Loading session history');
    expect(transcript().queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await act(async () => retry.resolve([row('Restored message'), row('Restored message')]));
    expect(transcript().getAllByText('Restored message')).toHaveLength(1);
    expect(transcript().queryByRole('status')).not.toBeInTheDocument();
    expect(load.mock.calls).toEqual([['Alpha'], ['Alpha']]);
    expect(invokeMock).toHaveBeenCalledWith('get_session_history', { sessionId: 'Alpha', session_id: 'Alpha' });
  });

  it('shows the empty transcript only after a successful empty history response', async () => {
    const request = deferred<unknown[]>();
    mockHistory(() => request.promise);
    render(<JarvisView />);
    await select('Alpha');
    expect(screen.queryByText(splash)).not.toBeInTheDocument();
    await act(async () => request.resolve([]));
    expect(screen.getByText(splash)).toBeInTheDocument();
    expect(transcript().queryByRole('alert')).not.toBeInTheDocument();
    expect(transcript().queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'] as const)('ignores a late %s from a previous Session while the selected Session is pending', async (completion) => {
    const alpha = deferred<unknown[]>();
    const beta = deferred<unknown[]>();
    mockHistory(id => id === 'Alpha' ? alpha.promise : beta.promise);
    render(<JarvisView />);
    await select('Alpha');
    await select('Beta');
    await act(async () => {
      if (completion === 'resolve') alpha.resolve([row('Wrong Session message')]);
      else alpha.reject(new Error('old failure'));
    });
    expect(transcript().getByRole('status')).toHaveTextContent('Loading session history');
    expect(screen.queryByText('Wrong Session message')).not.toBeInTheDocument();
    expect(transcript().queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => beta.resolve([row('Selected Session message')]));
    expect(transcript().getByText('Selected Session message')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith('cancel_chat_stream', { sessionId: 'Alpha', session_id: 'Alpha' });
  });

  it.each(['resolve', 'reject'] as const)('clears pending history on New and ignores its late %s', async (completion) => {
    const request = deferred<unknown[]>();
    mockHistory(() => request.promise);
    render(<JarvisView />);
    await select('Alpha');
    await select('New chat');
    expect(screen.getByText(splash)).toBeInTheDocument();
    expect(transcript().queryByRole('status')).not.toBeInTheDocument();
    await act(async () => {
      if (completion === 'resolve') request.resolve([row('Wrong Session message')]);
      else request.reject(new Error('old failure'));
    });
    expect(screen.queryByText('Wrong Session message')).not.toBeInTheDocument();
    expect(transcript().queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(splash)).toBeInTheDocument();
  });

  it('hides loaded history immediately when another Session is pending', async () => {
    const beta = deferred<unknown[]>();
    mockHistory(id => id === 'Alpha' ? Promise.resolve([row('Alpha history')]) : beta.promise);
    render(<JarvisView />);
    await select('Alpha');
    expect(await transcript().findByText('Alpha history')).toBeInTheDocument();
    await select('Beta');
    expect(screen.queryByText('Alpha history')).not.toBeInTheDocument();
    expect(transcript().getByRole('status')).toHaveTextContent('Loading session history');
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
    await act(async () => beta.resolve([row('Beta history')]));
    expect(transcript().getByText('Beta history')).toBeInTheDocument();
  });

  it('clears old messages and errors when switching Sessions', async () => {
    mockHistory(async id => id === 'Alpha' ? [row('Alpha history')] : Promise.reject(new Error('unavailable')));
    render(<JarvisView />);
    await select('Alpha');
    expect(await transcript().findByText('Alpha history')).toBeInTheDocument();
    await select('Beta');
    expect(await transcript().findByRole('alert')).toHaveTextContent('Could not load session history');
    expect(screen.queryByText('Alpha history')).not.toBeInTheDocument();
    await select('New chat');
    expect(transcript().queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(splash)).toBeInTheDocument();
  });
});
