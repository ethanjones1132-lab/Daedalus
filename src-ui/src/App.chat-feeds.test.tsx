// Boundary contracts for the Chat Feeds Session list and transcript reads.
//
// `ChatFeedsView` is the one `usePolling` caller that carried no private guard:
// `fetchSessions` published `list_sessions` straight from the resolved value and
// `loadHistory` published `get_session_history` straight from its own await, so
// a read that outlived its poll could land after a newer one and revert the
// list, and two selections in quick order could render one Session's header
// over another Session's transcript. These contracts pin the two properties
// that surface now gets from the shared fence and the read identity.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ChatFeedsView } from './App';
import type { BackendSession, SessionMessage } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const alpha: BackendSession = {
  id: 'session-alpha', agent_id: 'agent-alpha', title: 'Alpha', backend: 'ollama',
  model: 'test-model', context_tokens: 1000, total_tokens: 250,
  created_at: '2026-09-16T10:00:00Z', updated_at: '2026-09-16T11:00:00Z',
  archived: false, message_count: 7,
};
const beta: BackendSession = { ...alpha, id: 'session-beta', title: 'Beta', agent_id: 'agent-beta' };

function message(sessionId: string, body: string): SessionMessage {
  return {
    id: `${sessionId}-1`, session_id: sessionId, role: 'user', content: body,
    tokens: 1, tool_calls: null, created_at: '2026-09-16T11:00:00Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let listRequests: Array<ReturnType<typeof deferred<BackendSession[]>>>;
let historyRequests: Array<{ sessionId: string; request: ReturnType<typeof deferred<SessionMessage[]>> }>;

beforeEach(() => {
  // Fake only the poll interval: framer-motion and MarkdownRenderer need real
  // macrotasks to settle, so a fully faked clock is not usable here.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  // jsdom implements no layout, so the transcript pane's scroll-into-view has
  // no engine behind it. The read contracts below are about which transcript
  // renders, not about scrolling.
  vi.stubGlobal('scrollIntoView', vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  listRequests = [];
  historyRequests = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'list_sessions') {
      const request = deferred<BackendSession[]>();
      listRequests.push(request);
      return request.promise;
    }
    if (command === 'get_session_history') {
      const request = deferred<SessionMessage[]>();
      historyRequests.push({ sessionId: (args as { sessionId: string }).sessionId, request });
      return request.promise;
    }
    return null;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const mount = async () => { await act(async () => { render(<ChatFeedsView />); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const resolveList = async (index: number, rows: BackendSession[]) => {
  await act(async () => { listRequests[index].resolve(rows); });
};
const resolveHistory = async (index: number, rows: SessionMessage[]) => {
  await act(async () => { historyRequests[index].request.resolve(rows); });
};
const listCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'list_sessions');
const row = (name: RegExp) => screen.getByRole('button', { name });

describe('Chat Feeds read ordering', () => {
  it('keeps showing the newest confirmed list when an older poll resolves last', async () => {
    // The failure this surface had: `fetchSessions` published `list_sessions`
    // straight from the resolved value with no identity, so the poll that
    // started first and finished last won, and the list went backwards with no
    // error anywhere.
    await mount();
    expect(listCalls()).toHaveLength(1);
    await advance(15000);
    expect(listCalls(), 'a hung read must not block the newer observation').toHaveLength(2);

    await resolveList(1, [beta]);
    expect(row(/Beta/)).toBeInTheDocument();

    await resolveList(0, [alpha]);
    expect(row(/Beta/), 'the older poll must not replace the newer confirmed read').toBeInTheDocument();
    expect(screen.queryByText(/Alpha/)).not.toBeInTheDocument();
  });

  it('keeps reading after a settled read and shows each newest observation', async () => {
    await mount();
    await resolveList(0, []);
    expect(screen.getByText('No sessions match filter')).toBeInTheDocument();
    await advance(15000);
    expect(listCalls()).toHaveLength(2);
    await resolveList(1, [alpha]);
    expect(row(/Alpha/)).toBeInTheDocument();
  });

  it('never renders a superseded transcript under the newly selected Session', async () => {
    await mount();
    await resolveList(0, [alpha, beta]);
    fireEvent.click(row(/Alpha/));
    fireEvent.click(row(/Beta/));
    expect(historyRequests.map((entry) => entry.sessionId)).toEqual(['session-alpha', 'session-beta']);

    // The older transcript resolves while the newer selection is still reading.
    await resolveHistory(0, [message('session-alpha', 'alpha transcript line')]);
    expect(
      screen.queryByText(/alpha transcript line/),
      'a superseded read must never publish its transcript',
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Failed to load chat history'),
      'a superseded read must not end the pending state of the current one',
    ).not.toBeInTheDocument();

    await resolveHistory(1, [message('session-beta', 'beta transcript line')]);
    expect(screen.getByText(/beta transcript line/)).toBeInTheDocument();
    expect(screen.queryByText(/alpha transcript line/)).not.toBeInTheDocument();
    expect(screen.getByText('session-beta')).toBeInTheDocument();
  });
});
