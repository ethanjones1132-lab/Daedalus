import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView, { ChatPanel } from './JarvisView';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));
vi.mock('./WorkspaceGrantsChip', () => ({ default: () => null }));

const sessions = [
  { id: 'Alpha', name: 'Alpha', model: 'test-model', message_count: 0, created_at: '2026-09-25T00:00:00Z' },
  { id: 'Beta', name: 'Beta', model: 'test-model', message_count: 0, created_at: '2026-09-25T00:00:00Z' },
];

function installNativeMock() {
  invokeMock.mockImplementation(async (command: string, args?: { sessionId: string }) => {
    if (command === 'jarvis_list_sessions') return sessions;
    if (command === 'get_all_session_runs') return [];
    if (command === 'get_session_history') return [];
    if (command === 'jarvis_get_session_grants') return { session_id: args?.sessionId, grants: [] };
    if (command === 'jarvis_get_config' || command === 'jarvis_check_status' || command === 'jarvis_get_companion') return null;
    return true;
  });
}

async function select(name: string) {
  const button = await screen.findByRole('button', { name });
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
}

function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    controller,
    response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
  };
}

async function emit(controller: ReadableStreamDefaultController<Uint8Array>, frame: object) {
  await act(async () => {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installNativeMock();
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

describe('Jarvis Session draft ownership', () => {
  it('keeps Alpha, Beta, and New drafts in independent slots', async () => {
    render(<JarvisView />);
    await select('Alpha');
    const composer = await screen.findByLabelText('Chat input') as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: 'alpha draft' } });
    await select('Beta');
    expect(composer).toHaveValue('');
    fireEvent.change(composer, { target: { value: 'beta draft' } });
    await select('Alpha');
    await waitFor(() => expect(composer).toHaveValue('alpha draft'));

    await select('New chat');
    await waitFor(() => expect(composer).toHaveValue(''));
    fireEvent.change(composer, { target: { value: 'new draft' } });
    await select('Alpha');
    await waitFor(() => expect(composer).toHaveValue('alpha draft'));
    await select('New chat');
    await waitFor(() => expect(composer).toHaveValue('new draft'));
  });

  it('does not carry Alpha telemetry into Beta and ignores a late Alpha result', async () => {
    const alphaStream = streamResponse();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/chat/cancel')) return Promise.resolve(new Response('{}'));
      return Promise.resolve(alphaStream.response);
    }));
    render(<JarvisView />);
    await select('Alpha');
    const composer = await screen.findByLabelText('Chat input') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'alpha turn' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await screen.findByRole('button', { name: 'Stop streaming' });

    await emit(alphaStream.controller, { type: 'scope_notice', allowed_paths: ['alpha-only'] });
    await emit(alphaStream.controller, { type: 'orchestration_metrics', duration_ms: 1200, tokens_total: 42, tool_calls: 1 });
    expect(screen.getByLabelText('Explicit workspace scope')).toHaveTextContent('alpha-only');
    expect(screen.getByLabelText('Orchestration run metrics')).toBeInTheDocument();

    await select('Beta');
    await waitFor(() => expect(screen.queryByLabelText('Explicit workspace scope')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Orchestration run metrics')).not.toBeInTheDocument();

    await emit(alphaStream.controller, { type: 'result', result: 'late alpha answer' });
    await act(async () => { alphaStream.controller.close(); });
    await waitFor(() => expect(screen.queryByText('late alpha answer')).not.toBeInTheDocument());
  });

  it('preserves an identical newer draft when the original submission is accepted', async () => {
    let resolveFetch!: (response: Response) => void;
    const response = streamResponse();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    render(<ChatPanel
      activeSession="Alpha"
      setActiveSession={vi.fn()}
      config={null}
      backendLabel="OpenRouter"
      modelLabel="test-model"
      onSessionCreated={vi.fn()}
    />);
    const composer = await screen.findByLabelText('Chat input') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'same text' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.change(composer, { target: { value: 'same text edited' } });
    fireEvent.change(composer, { target: { value: 'same text' } });

    await act(async () => { resolveFetch(response.response); });
    await screen.findByRole('button', { name: 'Stop streaming' });
    await emit(response.controller, { type: 'result', result: 'answer' });
    await act(async () => { response.controller.close(); });

    await waitFor(() => expect(composer).toHaveValue('same text'));
  });
});
