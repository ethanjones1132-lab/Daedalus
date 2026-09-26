// Boundary contracts for the bounded Chat Feeds transcript.
//
// The same unbounded read as the Jarvis transcript, on the surface that prints a
// number beside it: `<Pill variant="info">{history.length} msgs</Pill>`
// (`src-ui/src/App.tsx:567`) counted the rows it rendered, so a bounded window
// would have left the pill claiming 342 while 100 were on screen. These contracts
// pin both halves of that: a Session at or under the bound still reads exactly
// `7 msgs`, and a bounded one counts what is on screen and states the bound.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ChatFeedsView } from './App';
import type { BackendSession, SessionMessage } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => {}) }));

const BOUND = 100;

const alpha: BackendSession = {
  id: 'session-alpha', agent_id: 'agent-alpha', title: 'Alpha', backend: 'ollama',
  model: 'test-model', context_tokens: 1000, total_tokens: 250,
  created_at: '2026-09-26T10:00:00Z', updated_at: '2026-09-26T11:00:00Z',
  archived: false, message_count: 7,
};
const beta: BackendSession = { ...alpha, id: 'session-beta', title: 'Beta', agent_id: 'agent-beta' };

function turn(sessionId: string, i: number): SessionMessage {
  return {
    id: `${sessionId}-${i}`, session_id: sessionId, role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`, tokens: 1, tool_calls: null, created_at: '2026-09-26T11:00:00Z',
  };
}
const longHistory = (sessionId: string, count: number) =>
  Array.from({ length: count }, (_, i) => turn(sessionId, i));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('scrollIntoView', vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const sessionId = (args as { sessionId?: string } | undefined)?.sessionId ?? '';
    if (command === 'list_sessions') return [alpha, beta];
    if (command === 'get_session_history') return longHistory(sessionId, sessionId === 'session-alpha' ? 342 : 120);
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const mount = async () => { await act(async () => { render(<ChatFeedsView />); }); };
const openAlpha = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Alpha/ })); }); };
const renderedTurns = () => screen.queryAllByText(/^turn \d+$/).map((node) => node.textContent);

describe('a bounded feed transcript states its bound', () => {
  it('renders the newest messages, says how much is off screen, and keeps the rest reachable', async () => {
    await mount();
    await openAlpha();
    const turns = await screen.findAllByText(/^turn \d+$/);

    expect(turns).toHaveLength(BOUND);
    expect(renderedTurns()[BOUND - 1]).toBe('turn 341');
    expect(screen.queryByText('turn 241')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Transcript window' })).toHaveTextContent(
      'Showing the newest 100 of 342 messages.',
    );
    expect(screen.getByRole('button', { name: 'Show 100 earlier messages' })).toBeInTheDocument();
  });

  it('counts what is on screen in the pill rather than what the read returned', async () => {
    await mount();
    await openAlpha();
    await screen.findAllByText(/^turn \d+$/);
    expect(screen.getByText('100 of 342 msgs')).toBeInTheDocument();
    expect(screen.queryByText('342 msgs'), 'the pill must not count messages the surface is not showing').not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 100 earlier messages' }));
    expect(await screen.findByText('turn 241')).toBeInTheDocument();
    expect(screen.getByText('200 of 342 msgs')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Transcript window' })).toHaveTextContent(
      'Showing the newest 200 of 342 messages.',
    );

    for (const label of ['Show 100 earlier messages', 'Show 42 earlier messages']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
    }
    expect(screen.getAllByText(/^turn \d+$/)).toHaveLength(342);
    expect(screen.getByText('342 msgs')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Transcript window' })).not.toBeInTheDocument();
  });

  it('resets the window when another Session is selected', async () => {
    await mount();
    await openAlpha();
    await screen.findAllByText(/^turn \d+$/);
    fireEvent.click(screen.getByRole('button', { name: 'Show 100 earlier messages' }));
    expect(screen.getAllByText(/^turn \d+$/)).toHaveLength(200);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Beta/ })); });
    const turns = await screen.findAllByText(/^turn \d+$/);
    expect(turns, 'a window sized for another Session must not withhold from this one').toHaveLength(BOUND);
    expect(screen.getByText('100 of 120 msgs')).toBeInTheDocument();
  });
});

describe('a feed transcript at or under the bound is untouched', () => {
  it('keeps the pill it has always printed and claims no window', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const sessionId = (args as { sessionId?: string } | undefined)?.sessionId ?? '';
      if (command === 'list_sessions') return [alpha, beta];
      if (command === 'get_session_history') return longHistory(sessionId, 7);
      return null;
    });
    await mount();
    await openAlpha();
    const turns = await screen.findAllByText(/^turn \d+$/);
    expect(turns).toHaveLength(7);
    expect(screen.getByText('7 msgs')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Transcript window' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /earlier messages/ })).not.toBeInTheDocument();
  });

  it('keeps a failed transcript read a failure rather than an empty window', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'list_sessions') return [alpha, beta];
      if (command === 'get_session_history') throw new Error('session row vanished');
      return null;
    });
    await mount();
    await openAlpha();
    expect(screen.getByRole('alert')).toHaveTextContent("Could not load this session's transcript.");
    expect(screen.queryByRole('status', { name: 'Transcript window' })).not.toBeInTheDocument();
    expect(screen.queryByText('0 msgs')).not.toBeInTheDocument();
  });
});
