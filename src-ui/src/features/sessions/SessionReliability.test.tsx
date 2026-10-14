import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { TurnMessage } from './TurnMessage';
import MarkdownView from './MarkdownView';
import { nativeMemoryFixture } from './test-native-memory';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
beforeEach(() => invokeMock.mockReset().mockImplementation(async (command, args) => {
  if (command === 'get_session_history') return [];
  if (command === 'jarvis_get_session_grants') return { session_id: 'session-1', grants: [] };
  return nativeMemoryFixture(command, args);
}));
describe('preserved local Session reliability', () => {
  it('keeps a turn live after unconfirmed Stop, retries once explicitly, and preserves partial text after confirmation', async () => {
    let confirmations = 0;
    const initial = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => command === 'cancel_chat_stream' ? ++confirmations > 1 : initial(command, args));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
      return new Response(body);
    }));
    render(<ChatPanel activeSession="session-1" setActiveSession={vi.fn()} config={null} backendLabel="Ollama" modelLabel="test" onSessionCreated={vi.fn()} />);
    const composer = screen.getByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'Continue work' } }); fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => controller.enqueue(new TextEncoder().encode('data: {"type":"stream_event","delta":{"text":"Useful partial answer"}}\n\n')));
    fireEvent.click(screen.getByRole('button', { name: 'Stop streaming' }));
    expect(await screen.findByRole('alert', { name: 'Stop request' })).toHaveTextContent('has not been stopped');
    expect(screen.getByRole('button', { name: 'Stop streaming' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry stop' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop streaming' })).not.toBeInTheDocument());
    expect(screen.getByText('Useful partial answer')).toBeInTheDocument();
    expect(screen.getByText('(stopped)')).toBeInTheDocument();
    expect(confirmations).toBe(2);
  });
  it.each(['jarvis_new_session', 'append_message', 'memory_prepare_turn', 'memory_turn_history'])('retires deferred %s setup when Stop occurs before HTTP dispatch', async (deferredCommand) => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(resolveValue => { resolve = resolveValue; });
    const initial = invokeMock.getMockImplementation()!;
    let blocked = false;
    let blockedArgs: Record<string, any> = {};
    invokeMock.mockImplementation((command, args) => {
      if (command === deferredCommand && !blocked) { blocked = true; blockedArgs = args; return pending; }
      if (command === 'cancel_chat_stream') return Promise.resolve(false);
      return initial(command, args);
    });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<ChatPanel activeSession={deferredCommand === 'jarvis_new_session' ? null : 'session-1'} setActiveSession={vi.fn()} config={null} backendLabel="Ollama" modelLabel="test" onSessionCreated={vi.fn()} />);
    const composer = screen.getByLabelText('Chat input');
    fireEvent.change(composer, { target: { value: 'Keep this draft' } }); fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(blocked).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Stop streaming' }));
    await act(async () => {
      resolve(deferredCommand === 'jarvis_new_session' ? { id: 'created-session' }
        : deferredCommand === 'append_message' ? 'saved-user'
        : deferredCommand === 'memory_prepare_turn' ? nativeMemoryFixture(deferredCommand, blockedArgs)
        : []);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop streaming' })).not.toBeInTheDocument();
    expect(composer).toHaveValue('Keep this draft');
    expect(screen.getByText('Turn stopped before it was sent. Your draft was kept.')).toBeInTheDocument();
    expect(screen.queryByText('(stopped)')).not.toBeInTheDocument();
  });
  it('does not let an old Session Stop reply unlock a newer pending Stop', async () => {
    const stops: Array<{ sid: string; resolve: (value: boolean) => void }> = [];
    const initial = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((command, args) => command === 'cancel_chat_stream'
      ? new Promise<boolean>(resolve => { stops.push({ sid: args.sessionId, resolve }); })
      : initial(command, args));
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')));
    } }))));
    const props = { setActiveSession: vi.fn(), config: null, backendLabel: 'Ollama', modelLabel: 'test', onSessionCreated: vi.fn() };
    const view = render(<ChatPanel {...props} activeSession="session-A" />);
    const send = (text: string) => { fireEvent.change(screen.getByLabelText('Chat input'), { target: { value: text } }); fireEvent.keyDown(screen.getByLabelText('Chat input'), { key: 'Enter' }); };
    send('A'); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop streaming' }));
    const oldStop = stops[0];
    view.rerender(<ChatPanel {...props} activeSession="session-B" />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop streaming' })).not.toBeInTheDocument());
    send('B'); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Stop streaming' }));
    expect(stops.filter(stop => stop.sid === 'session-B')).toHaveLength(1);
    await act(async () => oldStop.resolve(false));
    fireEvent.keyDown(screen.getByLabelText('Chat input'), { key: 'Escape' });
    expect(stops.filter(stop => stop.sid === 'session-B')).toHaveLength(1);
    await act(async () => stops.find(stop => stop.sid === 'session-B')!.resolve(false));
    expect(await screen.findByRole('alert', { name: 'Stop request' })).toHaveTextContent('has not been stopped');
  });
  it('announces a refused message copy without showing caught clipboard diagnostics', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('/private/profile clipboard denied')) } });
    render(<TurnMessage message={{ role: 'assistant', content: 'Saved response' }} index={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy the message to clipboard.');
    expect(document.body.textContent).not.toContain('/private/profile');
  });
  it('keeps refused Markdown addresses inert and explicit', () => {
    render(<MarkdownView content="[unsafe](javascript:alert(1)) [safe](https://example.com)" />);
    expect(screen.queryByRole('link', { name: 'unsafe' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('javascript:alert(1)');
    expect(screen.getByRole('link', { name: 'safe' })).toHaveAttribute('href', 'https://example.com');
  });
});
