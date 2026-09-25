import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './JarvisView';

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
  backendLabel: 'OpenRouter',
  modelLabel: 'test-model',
  onSessionCreated: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'get_session_history') return [];
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

describe('Session activity ledger', () => {
  it('renders directives in stream arrival order with actionable labels', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    render(<ChatPanel {...props} />);
    const composer = await screen.findByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'inspect the workspace' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByRole('status', { name: 'Session turn progress' });

    const emit = async (frame: object) => {
      await act(async () => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      });
    };

    await emit({ type: 'orchestrator_stage', stage: 'planner', status: 'running' });
    await emit({ type: 'tool_use', id: 'call-1', name: 'read_file', arguments: { path: 'src/app.ts' } });
    await emit({
      type: 'conductor_directive',
      session_id: 'session-1',
      stage: 'planner',
      directive: { type: 'reroute', newRemaining: ['executor'], reason: 'prioritize execution' },
    });
    await emit({ type: 'tool_result', call_id: 'call-1', name: 'read_file', output: 'source loaded', is_error: false });
    await emit({
      type: 'conductor_directive',
      session_id: 'session-1',
      stage: 'executor',
      directive: {
        type: 'start_repair_chain',
        itemId: 'item-1',
        reason: 'review found a gap',
        newRemaining: ['rewriter', 'executor', 'reviewer'],
      },
    });

    const activity = screen.getByLabelText('Turn activity');
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
    const rows = [...activity.querySelectorAll('[data-activity-item]')];
    expect(rows.map((row) => row.getAttribute('data-activity-kind'))).toEqual([
      'plan',
      'tool',
      'directive',
      'tool_result',
      'directive',
    ]);
    expect(within(activity).getByLabelText('Conductor directive: Reroute')).toHaveTextContent('prioritize execution');
    expect(within(activity).getByLabelText(/Conductor directive: Start repair chain/)).toHaveTextContent('review found a gap');
    expect(within(activity).getByText('source loaded')).toBeInTheDocument();

    await emit({ type: 'cancelled', reason: 'operator_stop' });
    await act(async () => { controller.close(); });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Session turn progress' })).not.toBeInTheDocument());
  });

  it('closes an unresolved tool when the turn terminates', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    render(<ChatPanel {...props} />);
    const composer = await screen.findByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'run a tool' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByRole('status', { name: 'Session turn progress' });
    await act(async () => {
      controller.enqueue(new TextEncoder().encode('data: {"type":"tool_use","id":"open-call","name":"grep","arguments":{}}\n\n'));
    });
    await act(async () => {
      controller.enqueue(new TextEncoder().encode('data: {"type":"cancelled","reason":"operator_stop"}\n\n'));
      controller.close();
    });

    await waitFor(() => expect(screen.queryByRole('status', { name: 'Session turn progress' })).not.toBeInTheDocument());
    const activity = screen.getByLabelText('Turn activity');
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));
    expect(within(activity).getByLabelText('Tool: grep')).toHaveTextContent('cancelled');
  });
});
