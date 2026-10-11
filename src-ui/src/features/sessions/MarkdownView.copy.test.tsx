import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownView from './MarkdownView';

const clipboardWriteMock = vi.fn();
const clipboardMock = { writeText: clipboardWriteMock };

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    writable: true,
    configurable: true,
  });
}

function codeMarkdown(source: string, language = 'ts', fence = '```') {
  return `${fence}${language}\n${source}\n${fence}`;
}

describe('MarkdownView code blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setClipboard(clipboardMock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies exact highlighted TypeScript source', async () => {
    const source = 'const value: number = 1;\nconsole.log("héllo 👋", value);';
    clipboardWriteMock.mockResolvedValueOnce(undefined);
    render(<MarkdownView content={codeMarkdown(source)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));

    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith(source));
    expect(screen.getByRole('button', { name: 'Copied ts code' })).toBeDefined();
  });

  it('keeps punctuation-heavy language identities on block controls', async () => {
    const source = 'int main() { return 0; }';
    clipboardWriteMock.mockResolvedValueOnce(undefined);
    render(<MarkdownView content={codeMarkdown(source, 'c++')} />);

    const button = screen.getByRole('button', { name: 'Copy c++ code' });
    fireEvent.click(button);

    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith(source));
  });

  it('closes a streaming four-backtick block without truncating nested backticks', async () => {
    const source = 'const marker = "```";\nconst nested = true;';
    clipboardWriteMock.mockResolvedValueOnce(undefined);
    render(<MarkdownView content={'````ts\n' + source} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));

    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith(source));
  });

  it('handles tilde fences and empty blocks as code blocks', async () => {
    clipboardWriteMock.mockResolvedValueOnce(undefined);
    const { rerender } = render(<MarkdownView content={'~~~ts\nconst value = 1;'} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));
    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith('const value = 1;'));

    rerender(<MarkdownView content={'```ts\n```'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));
    await waitFor(() => expect(clipboardWriteMock).toHaveBeenLastCalledWith(''));
  });

  it('shows fixed accessible feedback when clipboard writing fails', async () => {
    clipboardWriteMock.mockRejectedValueOnce(new Error('native clipboard detail'));
    render(<MarkdownView content={codeMarkdown('const value = 1;')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy code to clipboard.');
    expect(screen.queryByRole('button', { name: /Copied/ })).toBeNull();
    expect(screen.queryByText(/native clipboard detail/)).toBeNull();
  });

  it('retains GFM tables, safe links, and syntax highlighting', () => {
    const { container } = render(
      <MarkdownView
        content={'[docs](https://example.com)\n\n| name | value |\n| --- | --- |\n| one | 1 |\n\n```ts\nconst value = 1;\n```'}
      />,
    );

    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByRole('table')).toHaveTextContent('one');
    expect(container.querySelector('code.hljs .hljs-keyword')).not.toBeNull();
  });

  it('clears success state and its timer when content changes or unmounts', async () => {
    vi.useFakeTimers();
    clipboardWriteMock.mockResolvedValue(undefined);
    const { rerender, unmount } = render(<MarkdownView content={codeMarkdown('const value = 1;')} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Copied ts code' })).toBeDefined();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rerender(<MarkdownView content={codeMarkdown('const value = 2;')} />);
    expect(screen.getByRole('button', { name: 'Copy ts code' })).toBeDefined();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy ts code' }));
      await Promise.resolve();
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
