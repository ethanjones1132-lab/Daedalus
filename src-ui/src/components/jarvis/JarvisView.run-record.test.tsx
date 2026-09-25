import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView from './JarvisView';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

const session = {
  id: 'session-1', name: 'Run ledger', model: 'test-model', message_count: 1,
  created_at: '2026-09-25T00:00:00Z', last_active: '2026-09-25T09:00:00Z',
};

type StoreRow = {
  session_id: string;
  run_id: string;
  outcome: string;
  selected_model?: string | null;
  token_count: number;
  tool_count: number;
  cancelled_reason?: string | null;
  partial_output?: string | null;
};

/** A minimal `session_runs` table so the mocks answer reads from real writes. */
let store: StoreRow[] = [];
let recordCalls: Array<Record<string, unknown>> = [];
let rejectWrites = false;
let hiddenRunIds: string[] = [];
let rejectReads = false;

function readFailure() {
  return new Error('sqlite: /Users/operator/.openclaw/jarvis.db is locked');
}

function seed(rows: StoreRow[]) {
  store = rows.map(row => ({ ...row }));
}

/** Apply one `record_terminal_run` write to the fake `session_runs` table. */
function applyWrite(args: Record<string, any>): StoreRow {
  const row: StoreRow = {
    session_id: args.session_id ?? args.sessionId,
    run_id: args.runId,
    outcome: args.outcome,
    selected_model: args.selectedModel,
    token_count: args.tokenCount,
    tool_count: args.toolCount,
    cancelled_reason: args.cancelledReason,
    partial_output: args.partialOutput,
  };
  store = [row, ...store.filter(existing => existing.run_id !== row.run_id)];
  return row;
}

/** The `session_runs` fake used by every test in this file. */
async function nativeFallback(command: string, args: Record<string, any> = {}) {
  switch (command) {
    case 'jarvis_list_sessions': return [session];
    case 'jarvis_new_session': return session;
    case 'get_session_history': return [];
    case 'jarvis_get_session_grants': return { session_id: session.id, grants: [] };
    case 'jarvis_get_config':
    case 'jarvis_check_status':
    case 'jarvis_get_companion': return null;
    case 'get_all_session_runs':
      if (rejectReads) throw readFailure();
      return store.map(row => ({ ...row }));
    case 'get_session_runs':
      if (rejectReads) throw readFailure();
      return store
        .filter(row => !hiddenRunIds.includes(row.run_id))
        .filter(row => row.session_id === (args.session_id ?? args.sessionId))
        .map(row => ({ ...row }));
    case 'record_terminal_run': {
      recordCalls.push(args);
      if (rejectWrites) throw readFailure();
      return applyWrite(args);
    }
    default: return null;
  }
}

function nativeMock() {
  invokeMock.mockImplementation(nativeFallback);
}

function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const fetchMock = vi.fn(async () => new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    emit: async (frame: object) => {
      await act(async () => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      });
    },
    close: async () => { await act(async () => { controller.close(); }); },
  };
}

async function sendTurn(message: string) {
  const composer = await screen.findByLabelText('Chat input');
  fireEvent.change(composer, { target: { value: message } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await screen.findByRole('status', { name: 'Session turn progress' });
}

const confirmation = () => screen.queryByLabelText('Recorded run confirmation');

beforeEach(() => {
  invokeMock.mockReset();
  store = [];
  recordCalls = [];
  rejectWrites = false;
  hiddenRunIds = [];
  rejectReads = false;
  nativeMock();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a recorded run is confirmed by read-back, never assumed', () => {
  it('confirms the durable run Native stores and names its run id', async () => {
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-9017' });
    await stream.emit({ type: 'result', result: 'All done' });
    await stream.close();

    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-9017 as success.'));
    expect(confirmation()).toHaveAttribute('role', 'status');
    expect(
      invokeMock.mock.calls.filter(([command]) => command === 'get_session_runs'),
    ).toHaveLength(1);
    expect(recordCalls[0]).toMatchObject({ session_id: 'session-1', runId: 'run-9017', outcome: 'success' });
  });

  it('reads the run back for the same Session it wrote, with the existing read command', async () => {
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-scope' });
    await stream.emit({ type: 'result', result: 'ok' });
    await stream.close();

    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-scope as success.'));
    const read = invokeMock.mock.calls.find(([command]) => command === 'get_session_runs');
    expect(read?.[1]).toMatchObject({ session_id: 'session-1', sessionId: 'session-1' });
  });

  it('never claims a run the read-back does not report, and retries on demand', async () => {
    hiddenRunIds = ['run-42'];
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-42' });
    await stream.emit({ type: 'result', result: 'ok' });
    await stream.close();

    await waitFor(() => expect(confirmation()).toHaveTextContent(
      'Native does not report run run-42 for this Session, so the recorded run outcome is not confirmed.',
    ));
    expect(confirmation()).toHaveTextContent('not confirmed');
    expect(recordCalls).toHaveLength(1);

    hiddenRunIds = [];
    fireEvent.click(screen.getByRole('button', { name: 'Record the run outcome again' }));
    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-42 as success.'));
    expect(recordCalls).toHaveLength(2);
  });

  it('renders the stored outcome when the read-back disagrees and never rewrites it', async () => {
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-7' });
    await stream.emit({ type: 'result', result: 'ok' });
    // A second writer (or a relay retry) already stored a different outcome
    // under the same durable run_id before our read-back ran.
    invokeMock.mockImplementation(async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_session_runs') {
        return [{ ...store[0], outcome: 'cancelled', cancelled_reason: 'client_abort' }];
      }
      if (command === 'get_all_session_runs') return store.map(row => ({ ...row }));
      if (command === 'jarvis_list_sessions') return [session];
      if (command === 'record_terminal_run') {
        recordCalls.push(args);
        return applyWrite(args);
      }
      return null;
    });
    await stream.close();

    await waitFor(() => expect(confirmation()).toHaveTextContent(
      'Native recorded run run-7 as cancelled, not success. The stored outcome is shown.',
    ));
    expect(screen.queryByRole('button', { name: /again/ })).not.toBeInTheDocument();
    // The stored row is authoritative: the disagreement is never "fixed" by
    // writing over it.
    expect(recordCalls).toHaveLength(1);
  });

  it('reports a rejected durable write and retries it deliberately', async () => {
    rejectWrites = true;
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-9' });
    await stream.emit({ type: 'result', result: 'ok' });
    await stream.close();

    await waitFor(() => expect(confirmation()).toHaveTextContent(
      'Native rejected the record for run run-9, so this Session has no confirmed run outcome.',
    ));
    // Native error detail is never surfaced or logged to the operator.
    expect(confirmation()?.textContent).not.toContain('jarvis.db');
    expect(
      invokeMock.mock.calls.filter(([command]) => command === 'get_session_runs'),
    ).toHaveLength(0);

    rejectWrites = false;
    nativeMock();
    fireEvent.click(screen.getByRole('button', { name: 'Record the run outcome again' }));
    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-9 as success.'));
  });

  it('keeps an unreadable read-back unconfirmed and lets a later read settle it', async () => {
    rejectReads = true;
    const stream = sseStream();
    render(<JarvisView />);
    await sendTurn('inspect the workspace');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-3' });
    await stream.emit({ type: 'result', result: 'ok' });
    await stream.close();

    await waitFor(() => expect(confirmation()).toHaveTextContent(
      'Run run-3 was written but could not be read back, so the recorded run outcome is not confirmed.',
    ));
    expect(screen.getByRole('button', { name: 'Read the run outcome again' })).toBeInTheDocument();

    rejectReads = false;
    fireEvent.click(screen.getByRole('button', { name: 'Read the run outcome again' }));
    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-3 as success.'));
    // The write was already accepted, so settling it must re-read only.
    expect(recordCalls).toHaveLength(1);
  });

  it('clears a superseded confirmation instead of leaving the last turn on screen', async () => {
    const first = sseStream();
    render(<JarvisView />);
    await sendTurn('first turn');
    await first.emit({ type: 'agent_run_id', agent_run_id: 'run-a' });
    await first.emit({ type: 'result', result: 'one' });
    await first.close();
    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-a as success.'));

    const second = sseStream();
    await sendTurn('second turn');
    expect(screen.queryByText('Recorded run run-a as success.')).not.toBeInTheDocument();
    await second.emit({ type: 'agent_run_id', agent_run_id: 'run-b' });
    await second.emit({ type: 'result', result: 'two' });
    await second.close();
    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-b as success.'));
    expect(screen.queryByText('Recorded run run-a as success.')).not.toBeInTheDocument();
  });
});

describe('the Session list shows the durable run, never a local assumption', () => {
  async function openSessions() {
    render(<JarvisView initialSubView="sessions" />);
    await screen.findByText('Run ledger', { selector: 'span' });
    fireEvent.click(screen.getByRole('button', { name: 'Select session Run ledger' }));
    await screen.findByLabelText('Chat input');
  }

  it('shows the durable run id and counts the older runs of that Session', async () => {
    seed([
      { session_id: 'session-1', run_id: 'run-new', outcome: 'failed', selected_model: 'slow', token_count: 4, tool_count: 1 },
      { session_id: 'session-1', run_id: 'run-mid', outcome: 'success', token_count: 3, tool_count: 0 },
      { session_id: 'session-1', run_id: 'run-old', outcome: 'partial', token_count: 2, tool_count: 0 },
      { session_id: 'other', run_id: 'run-other', outcome: 'success', token_count: 1, tool_count: 0 },
    ]);
    render(<JarvisView initialSubView="sessions" />);
    const row = await screen.findByText('Run ledger', { selector: 'span' });
    const card = row.parentElement!.parentElement!;
    expect(card).toHaveTextContent('run-new');
    expect(card).toHaveTextContent('2 older runs');
    expect(card).toHaveTextContent('failed');
    expect(card).not.toHaveTextContent('run-other');
  });

  it('marks a Session whose last turn never got a confirmed run record', async () => {
    rejectWrites = true;
    const stream = sseStream();
    await openSessions();
    await sendTurn('record this turn');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-x' });
    await stream.emit({ type: 'result', result: 'ok' });
    await stream.close();
    await waitFor(() => expect(confirmation()).toHaveTextContent('no confirmed run outcome'));

    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    const row = await screen.findByText('Run ledger', { selector: 'span' });
    const card = row.parentElement!.parentElement!;
    // The durable read is honest about the absence…
    expect(card).toHaveTextContent('no run recorded');
    // …and the turn the operator just watched is not presented as recorded.
    expect(card).toHaveTextContent("last turn's run outcome not confirmed");
  });

  it('stops marking a Session once the run record is confirmed', async () => {
    const stream = sseStream();
    await openSessions();
    await sendTurn('record this turn');
    await stream.emit({ type: 'agent_run_id', agent_run_id: 'run-y' });
    await stream.emit({ type: 'result', result: 'ok' });
    await stream.close();
    await waitFor(() => expect(confirmation()).toHaveTextContent('Recorded run run-y as success.'));

    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    const row = await screen.findByText('Run ledger', { selector: 'span' });
    const card = row.parentElement!.parentElement!;
    await waitFor(() => expect(card).toHaveTextContent('run-y'));
    expect(card).not.toHaveTextContent("last turn's run outcome not confirmed");
  });

  it('opens a real route to the run history of one Session and keeps it honest', async () => {
    seed([
      { session_id: 'session-1', run_id: 'run-new', outcome: 'failed', selected_model: 'slow', token_count: 4, tool_count: 1 },
      { session_id: 'session-1', run_id: 'run-old', outcome: 'success', token_count: 3, tool_count: 0 },
    ]);
    render(<JarvisView initialSubView="sessions" />);
    await screen.findByText('Run ledger', { selector: 'span' });
    const toggle = screen.getByRole('button', { name: 'Show recorded runs' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('session-runs-view')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide recorded runs' })).toHaveAttribute('aria-expanded', 'true');
    const view = await screen.findByTestId('session-runs-view');
    const items = await within(view).findAllByRole('listitem');
    expect(items.map(item => item.textContent)).toHaveLength(2);
    expect(items[0]).toHaveTextContent('run-new');
    expect(items[1]).toHaveTextContent('run-old');

    fireEvent.click(screen.getByRole('button', { name: 'Hide recorded runs' }));
    expect(screen.queryByTestId('session-runs-view')).not.toBeInTheDocument();
  });

  it('never renders a failed run-history read as an empty history', async () => {
    seed([{ session_id: 'session-1', run_id: 'run-new', outcome: 'success', token_count: 1, tool_count: 0 }]);
    let failReads = true;
    invokeMock.mockImplementation(async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_session_runs') {
        if (failReads) throw readFailure();
        return store.map(row => ({ ...row }));
      }
      return nativeFallback(command, args);
    });
    render(<JarvisView initialSubView="sessions" />);
    await screen.findByText('Run ledger', { selector: 'span' });
    fireEvent.click(screen.getByRole('button', { name: 'Show recorded runs' }));
    const view = await screen.findByTestId('session-runs-view');
    expect(await within(view).findByRole('alert')).toHaveTextContent(
      'Could not read the recorded runs for this Session.',
    );
    expect(within(view).queryByText('No runs recorded for this Session.')).not.toBeInTheDocument();

    failReads = false;
    fireEvent.click(within(view).getByRole('button', { name: 'Retry recorded runs' }));
    expect(await within(view).findByRole('listitem')).toHaveTextContent('run-new');
    expect(within(view).queryByRole('alert')).not.toBeInTheDocument();
  });
});
