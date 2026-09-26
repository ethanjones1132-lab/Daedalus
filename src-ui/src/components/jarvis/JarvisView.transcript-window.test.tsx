// Boundary contracts for the bounded Jarvis transcript.
//
// The read is unbounded — `get_session_history` selects every row for the
// Session with no `LIMIT` and takes no paging argument
// (`src-tauri/src/commands/sessions.rs:514-527`) — and the transcript rendered
// every row it was handed, one `MarkdownView` per message with highlight.js
// language detection on every code block. Nothing on screen said so: the
// transcript is a bare list under `aria-label="Jarvis chat transcript"`, and the
// one number in the sibling surface counted the rows it did render rather than
// the messages that exist. So "this is the whole conversation" and "this is
// everything that rendered" were the same pixels, on the route an operator opens
// most.
//
// These contracts pin the bound as a stated fact and the withheld messages as
// reachable, and they pin the confirmed half: a Session at or under the bound
// renders every message and says nothing about a window.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView from './JarvisView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

const BOUND = 100;

const sessions = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
  id: name, name, model: 'test-model', message_count: 2, created_at: '2026-09-26T00:00:00Z',
}));

/** A long Session: `count` messages, numbered from 0, alternating who sent them. */
function longHistory(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    session_id: 'Alpha',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`,
    created_at: '2026-09-26T00:00:00Z',
  }));
}

function mockHistory(byId: (id: string) => unknown[]) {
  invokeMock.mockImplementation((command: string, args?: { sessionId: string }) => {
    if (command === 'jarvis_list_sessions') return Promise.resolve(sessions);
    if (command === 'get_session_history') return Promise.resolve(byId(args!.sessionId));
    if (command === 'get_all_session_runs') return Promise.resolve([]);
    if (command === 'jarvis_get_session_grants') return Promise.resolve({ session_id: args?.sessionId, grants: [] });
    return Promise.resolve(null);
  });
}

const transcript = () => within(screen.getByRole('log', { name: 'Jarvis chat transcript' }));
const notice = () => transcript().queryByRole('status', { name: 'Transcript window' });
const renderedTurns = () => transcript().queryAllByText(/^turn \d+$/).map((node) => node.textContent);

async function select(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }));
  await act(async () => {});
}

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('a long transcript states its bound', () => {
  it('renders the newest messages, says how much is off screen, and keeps the rest reachable', async () => {
    mockHistory(() => longHistory(342));
    render(<JarvisView />);
    await select('Alpha');
    const turns = await transcript().findAllByText(/^turn \d+$/);

    expect(turns).toHaveLength(BOUND);
    expect(renderedTurns()[BOUND - 1], 'the newest message is on screen').toBe(`turn ${341}`);
    expect(transcript().queryByText('turn 241'), 'the withheld run starts above the window').not.toBeInTheDocument();
    expect(notice()).toHaveTextContent('Showing the newest 100 of 342 messages.');
    expect(transcript().getByRole('button', { name: 'Show 100 earlier messages' })).toBeInTheDocument();
  });

  it('extends the window on demand until the whole Session is on screen', async () => {
    mockHistory(() => longHistory(342));
    render(<JarvisView />);
    await select('Alpha');
    await transcript().findAllByText(/^turn \d+$/);

    fireEvent.click(transcript().getByRole('button', { name: 'Show 100 earlier messages' }));
    expect(await transcript().findByText('turn 241'), 'the withheld run becomes reachable').toBeInTheDocument();
    expect(transcript().getAllByText(/^turn \d+$/)).toHaveLength(200);
    expect(notice()).toHaveTextContent('Showing the newest 200 of 342 messages.');
    expect(transcript().getByRole('button', { name: 'Show 100 earlier messages' })).toBeInTheDocument();

    // Each press lifts the bound by one step and asks only for what is left, so
    // the last press names the 42 that remain rather than a round 100.
    fireEvent.click(transcript().getByRole('button', { name: 'Show 100 earlier messages' }));
    expect(transcript().getAllByText(/^turn \d+$/)).toHaveLength(300);
    fireEvent.click(transcript().getByRole('button', { name: 'Show 42 earlier messages' }));
    expect(transcript().getAllByText(/^turn \d+$/)).toHaveLength(342);
    expect(transcript().queryByText('turn 0')).toBeInTheDocument();
    expect(notice(), 'a Session that fits says nothing about a window').not.toBeInTheDocument();
    expect(transcript().queryByRole('button', { name: /earlier message/ })).not.toBeInTheDocument();
  });

  it('asks for only the messages that are left', async () => {
    mockHistory(() => longHistory(102));
    render(<JarvisView />);
    await select('Alpha');
    await transcript().findAllByText(/^turn \d+$/);
    expect(notice()).toHaveTextContent('Showing the newest 100 of 102 messages.');
    expect(transcript().getByRole('button', { name: 'Show 2 earlier messages' })).toBeInTheDocument();
    fireEvent.click(transcript().getByRole('button', { name: 'Show 2 earlier messages' }));
    expect(transcript().getAllByText(/^turn \d+$/)).toHaveLength(102);
    expect(notice()).not.toBeInTheDocument();
  });
});

describe('a transcript at or under the bound is untouched', () => {
  it('renders every message of a Session exactly at the bound and claims no window', async () => {
    mockHistory(() => longHistory(BOUND));
    render(<JarvisView />);
    await select('Alpha');
    const turns = await transcript().findAllByText(/^turn \d+$/);
    expect(turns).toHaveLength(BOUND);
    expect(renderedTurns()[0]).toBe('turn 0');
    expect(notice(), 'nothing is withheld, so nothing is claimed').not.toBeInTheDocument();
  });

  it('numbers a revealed message by its place in the conversation, not in the window', async () => {
    mockHistory(() => longHistory(342));
    render(<JarvisView />);
    await select('Alpha');
    await transcript().findAllByText(/^turn \d+$/);
    // The first visible assistant bubble is turn 243, and `Copy message 244` is
    // what the control has always said for the 244th message of the Session.
    expect(transcript().getByRole('button', { name: 'Copy message 244' })).toBeInTheDocument();
    fireEvent.click(transcript().getByRole('button', { name: 'Show 100 earlier messages' }));
    expect(transcript().getByRole('button', { name: 'Copy message 144' })).toBeInTheDocument();
  });

  it('resets the window when another Session is selected', async () => {
    mockHistory(id => (id === 'Alpha' ? longHistory(342) : longHistory(120)));
    render(<JarvisView />);
    await select('Alpha');
    await transcript().findAllByText(/^turn \d+$/);
    for (const label of ['Show 100 earlier messages', 'Show 100 earlier messages', 'Show 42 earlier messages']) {
      fireEvent.click(transcript().getByRole('button', { name: label }));
    }
    expect(transcript().queryByText('turn 0')).toBeInTheDocument();

    await select('Gamma');
    await act(async () => {});
    const turns = await transcript().findAllByText(/^turn \d+$/);
    expect(turns, 'a window sized for another Session must not withhold from this one').toHaveLength(BOUND);
    expect(notice()).toHaveTextContent('Showing the newest 100 of 120 messages.');
  });

  it('says nothing about a window while the read has not answered', async () => {
    let resolve!: (rows: unknown[]) => void;
    invokeMock.mockImplementation((command: string, args?: { sessionId: string }) => {
      if (command === 'jarvis_list_sessions') return Promise.resolve(sessions);
      if (command === 'get_session_history') return new Promise<unknown[]>((res) => { resolve = res; });
      if (command === 'get_all_session_runs') return Promise.resolve([]);
      if (command === 'jarvis_get_session_grants') return Promise.resolve({ session_id: args?.sessionId, grants: [] });
      return Promise.resolve(null);
    });
    render(<JarvisView />);
    await select('Alpha');
    expect(transcript().getByRole('status', { name: /Session history loading/ })).toBeInTheDocument();
    expect(notice(), 'a pending read knows no length and must claim none').not.toBeInTheDocument();
    await act(async () => { resolve(longHistory(342)); });
    expect(await transcript().findAllByText(/^turn \d+$/)).toHaveLength(BOUND);
  });
});
