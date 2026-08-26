import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownRenderer from './MarkdownRenderer';

const clipboardWriteMock = vi.fn();
const clipboardMock = { writeText: clipboardWriteMock };

describe('MarkdownRenderer copy (P2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: clipboardMock,
      writable: true,
      configurable: true,
    });
  });

  it('renders Copy button when content is given', () => {
    render(<MarkdownRenderer content="hello" />);
    expect(screen.getByRole('button', { name: /copy/i })).toBeDefined();
  });

  it('shows Copied after success and writes text', async () => {
    clipboardWriteMock.mockResolvedValueOnce(undefined);
    render(<MarkdownRenderer content="hello" />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(screen.getByText('Copied')).toBeDefined());
    expect(clipboardWriteMock).toHaveBeenCalledWith('hello');
  });

  it('shows no Copied and does not throw when clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    render(<MarkdownRenderer content="hello" />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: /copy/i }))).not.toThrow();
    expect(screen.queryByText('Copied')).toBeNull();
  });
});
