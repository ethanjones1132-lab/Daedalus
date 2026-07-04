import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
});
