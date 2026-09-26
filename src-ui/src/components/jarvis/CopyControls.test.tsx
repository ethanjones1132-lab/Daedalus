// Boundary contracts for every clipboard control in the app.
//
// Two of the four controls kept the outcome as a fact and announced a refusal
// (`RecordIdBadge`, the `MarkdownView` code block). Two did not: the hand-rolled
// `MarkdownRenderer` swallowed the rejection into `setCopied(false)` and had no
// error state at all, and the Jarvis transcript's icon-only per-message control
// logged the failure and changed nothing an operator could see or hear. A
// success label that reverts after 1.5s looks identical to a control that did
// nothing, so both failures were invisible.
//
// The sentences are asserted as literals rather than imported from the module, so
// a change to the copy is a deliberate edit here and this file's failures are
// about behaviour rather than about an import.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JarvisView from './JarvisView';
import MarkdownRenderer from './MarkdownRenderer';
import MarkdownView from './MarkdownView';
import RecordIdBadge from './RecordIdBadge';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('./SystemStatusBar', () => ({ default: () => null }));

const clipboardWriteMock = vi.fn();
const clipboardMock = { writeText: clipboardWriteMock };

/** A refusal carrying the kind of detail a webview reports, which must never
 *  reach a surface. */
const refusal = new Error('Clipboard write refused: document is not focused');

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, writable: true, configurable: true });
}

const session = {
  id: 'Alpha', name: 'Alpha', model: 'test-model', message_count: 1,
  created_at: '2026-09-26T00:00:00Z', last_active: '2026-09-26T09:00:00Z',
};
const assistantRow = {
  id: 'row-1', role: 'assistant', content: 'The answer is 42.', created_at: '2026-09-26T09:00:00Z',
};

async function mountTranscript() {
  invokeMock.mockImplementation((command: string) => {
    if (command === 'jarvis_list_sessions') return Promise.resolve([session]);
    if (command === 'get_session_history') return Promise.resolve([assistantRow]);
    if (command === 'get_all_session_runs') return Promise.resolve([]);
    if (command === 'jarvis_get_session_grants') return Promise.resolve({ session_id: 'Alpha', grants: [] });
    return Promise.resolve(null);
  });
  render(<JarvisView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
  const transcript = within(await screen.findByRole('log', { name: 'Jarvis chat transcript' }));
  await transcript.findByText('The answer is 42.');
  return transcript;
}

const icon = (button: HTMLElement) => button.querySelector('svg')?.getAttribute('class') ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does not drain queued one-shot implementations, and a test
  // that aborts before its second click would leak one into the next case. The
  // write is reset outright, with a resolving default every refusal test
  // overrides for its first click.
  clipboardWriteMock.mockReset();
  clipboardWriteMock.mockResolvedValue(undefined);
  setClipboard(clipboardMock);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('MarkdownRenderer copy control', () => {
  it('announces a refused write and never shows the success label for it', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    render(<MarkdownRenderer content="the whole message body" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy the message to clipboard.');
    expect(document.body.textContent).not.toContain('document is not focused');
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeEnabled();
  });

  it('attempts again on a second click after a refusal, writing the same value', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    render(<MarkdownRenderer content="the whole message body" />);
    const button = screen.getByRole('button', { name: 'Copy to clipboard' });

    fireEvent.click(button);
    await screen.findByRole('alert');
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
    expect(clipboardWriteMock).toHaveBeenCalledTimes(2);
    expect(clipboardWriteMock).toHaveBeenLastCalledWith('the whole message body');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a webview with no clipboard at all as a refusal, not as a crash', async () => {
    setClipboard(undefined);
    render(<MarkdownRenderer content="the whole message body" />);

    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))).not.toThrow();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy the message to clipboard.');
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('drops a refusal about text that is no longer on screen', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    const { rerender } = render(<MarkdownRenderer content="first body" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await screen.findByRole('alert');

    rerender(<MarkdownRenderer content="second body" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the confirmed path: Copied on the same 1.5s timer, then the plain label', async () => {
    vi.useFakeTimers();
    render(<MarkdownRenderer content="the whole message body" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => { vi.advanceTimersByTime(1499); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
  });
});

describe('Jarvis transcript per-message copy control', () => {
  it('announces a refused write on the bubble and does not flip the icon to Copied', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    const transcript = await mountTranscript();

    const button = transcript.getByRole('button', { name: 'Copy message 1' });
    expect(icon(button)).toContain('lucide-copy');
    fireEvent.click(button);

    const alert = await transcript.findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy the message to clipboard.');
    expect(document.body.textContent).not.toContain('document is not focused');
    expect(icon(transcript.getByRole('button', { name: 'Copy message 1' }))).toContain('lucide-copy');
    expect(transcript.getByRole('button', { name: 'Copy message 1' })).toBeEnabled();
  });

  it('attempts again on a second click after a refusal', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    const transcript = await mountTranscript();

    fireEvent.click(transcript.getByRole('button', { name: 'Copy message 1' }));
    await transcript.findByRole('alert');
    fireEvent.click(transcript.getByRole('button', { name: 'Copy message 1' }));

    await waitFor(() =>
      expect(icon(transcript.getByRole('button', { name: 'Copy message 1' }))).toContain('lucide-check'),
    );
    expect(clipboardWriteMock).toHaveBeenCalledTimes(2);
    expect(clipboardWriteMock).toHaveBeenLastCalledWith('The answer is 42.');
    expect(transcript.queryByRole('alert')).toBeNull();
  });

  it('keeps the confirmed path: the Check icon on the same 1.5s timer', async () => {
    // Mounted under real timers: the transcript's own reads are awaited, and a
    // faked timer would stall the `findBy*` waits this mount needs.
    const transcript = await mountTranscript();
    vi.useFakeTimers();
    const button = () => transcript.getByRole('button', { name: 'Copy message 1' });

    await act(async () => {
      fireEvent.click(button());
    });
    expect(icon(button())).toContain('lucide-check');
    expect(transcript.queryByRole('alert')).toBeNull();

    act(() => { vi.advanceTimersByTime(1500); });
    expect(icon(button())).toContain('lucide-copy');
  });

  it('reports one refusal per bubble, not one for the whole transcript', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    const transcript = await mountTranscript();

    fireEvent.click(transcript.getByRole('button', { name: 'Copy message 1' }));

    expect(await transcript.findByRole('alert')).toHaveTextContent('Could not copy the message to clipboard.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('controls that already reported a refusal', () => {
  it('keeps the code block sentence and the confirmed label byte-identical', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    render(<MarkdownView content={'```ts\nconst value = 1;\n```'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy code to clipboard.');
    expect(alert).not.toHaveTextContent('Could not copy the message to clipboard.');
    expect(document.body.textContent).not.toContain('document is not focused');
  });

  it('keeps the record id sentence and its own Copy control byte-identical', async () => {
    clipboardWriteMock.mockRejectedValueOnce(refusal);
    render(<RecordIdBadge id="run-42" label="run" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy run id' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy the id.');
    expect(alert).not.toHaveTextContent('Could not copy the message to clipboard.');
    expect(screen.getByTestId('record-id')).toHaveTextContent('run-42');
    expect(document.body.textContent).not.toContain('document is not focused');
  });
});
