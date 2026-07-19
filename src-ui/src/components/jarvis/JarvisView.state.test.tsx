import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView, { ChatPanel } from './JarvisView';

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
    if (command === 'jarvis_list_sessions' || command === 'get_all_session_runs') return [];
    if (command === 'jarvis_get_config' || command === 'jarvis_check_status' || command === 'jarvis_get_companion') return null;
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

describe('ChatPanel state machine', () => {
  it('allows only one fetch for rapid duplicate Enter submissions', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatPanel {...props} />);
    const composer = await screen.findByLabelText('Chat input');

    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(new Response('data: {"type":"result","result":"hi"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    await waitFor(() => expect(screen.getByText('hi')).toBeInTheDocument());
  });

  it('keeps the submitted text recoverable when connecting fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    render(<ChatPanel {...props} />);
    const composer = await screen.findByLabelText('Chat input') as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: 'keep this message' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('connection refused'));
    expect(composer.value).toBe('keep this message');
  });

  it('clears the prior streaming transcript before loading another Session', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Session switched', 'AbortError'));
        }, { once: true });
      })));
    const view = render(<ChatPanel {...props} />);
    const composer = await screen.findByLabelText('Chat input');

    fireEvent.change(composer, { target: { value: 'belongs to session one' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    const transcript = screen.getByRole('log');
    expect(await within(transcript).findByText('belongs to session one')).toBeInTheDocument();

    view.rerender(<ChatPanel {...props} activeSession="session-2" />);

    await waitFor(() => expect(within(transcript).queryByText('belongs to session one')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Stop streaming')).not.toBeInTheDocument();
  });

  it('shows the actual routed provider, model, and visible TTFT from run telemetry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response([
      'data: {"type":"orchestration_metrics","duration_ms":5151,"tokens_total":2123,"tool_calls":2,"fallback_retries":0,"actual_provider":"opencode_zen","actual_model":"deepseek-v4-flash-free","first_visible_token_ms":3227}',
      'data: {"type":"result","result":"done"}',
      '',
    ].join('\n\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    render(<ChatPanel {...props} />);
    const composer = await screen.findByLabelText('Chat input');

    fireEvent.change(composer, { target: { value: 'audit this run' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    const metrics = await screen.findByLabelText('Orchestration run metrics');
    expect(metrics).toHaveTextContent('OpenCode Zen · deepseek-v4-flash-free');
    expect(metrics).toHaveTextContent('TTFT 3.2s');
  });
});

describe('Jarvis viewport navigation', () => {
  it('keeps view and session navigation outside the scrolling transcript', async () => {
    render(<JarvisView />);

    const rail = await screen.findByTestId('jarvis-persistent-nav');
    const transcript = screen.getByRole('log', { name: 'Jarvis chat transcript' });

    expect(rail).toHaveClass('sticky', 'top-0', 'shrink-0');
    expect(rail).not.toContainElement(transcript);
    expect(transcript).toHaveClass('flex-1', 'min-h-0', 'overflow-y-auto');
  });
});
