import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownRenderer from './MarkdownRenderer';
import MarkdownView from './MarkdownView';

// The notice is stated as a literal here on purpose: this file's red has to be
// about what the surfaces render, not about a module that does not exist yet. The
// constant in `lib/link-scheme.ts` is pinned to this same sentence there.
const REFUSED_LINK_NOTICE = 'This address is not a link: Daedalus did not make it clickable.';

// The link decision is shared, so both renderers are held to the same contract.
// Each renderer's *confirmed* link keeps its own existing class, which is why the
// class is stated per renderer rather than once.
const RENDERERS = [
  {
    name: 'MarkdownRenderer',
    draw: (content: string) => <MarkdownRenderer content={content} />,
    linkClass: 'text-cyan-neon hover:text-cyan-glow underline underline-offset-2',
  },
  {
    name: 'MarkdownView',
    draw: (content: string) => <MarkdownView content={content} />,
    linkClass: 'text-cyan-glow underline underline-offset-2 hover:text-cyan-neon transition-colors',
  },
] as const;

const ALLOWED_ADDRESSES = [
  ['http', 'http://example.com/docs'],
  ['https', 'https://example.com/docs?a=b#frag'],
  ['mailto', 'mailto:operator@example.com'],
  ['an upper-cased scheme', 'HTTPS://example.com/docs'],
  ['a relative path', '/sessions/42'],
  ['a bare fragment', '#turn-3'],
  ['a scheme-relative address', '//cdn.example.com/asset.png'],
] as const;

const REFUSED_ADDRESSES = [
  ['a javascript address', 'javascript:alert(1)'],
  ['a javascript address without parentheses', 'javascript:void'],
  ['a data address', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ['a file address', 'file:///etc/hosts'],
  ['a vbscript address', 'vbscript:msgbox(1)'],
  ['an ircs address the hand-rolled renderer used to open', 'ircs://irc.example.com/channel'],
] as const;

describe.each(RENDERERS)('$name link schemes', ({ draw, linkClass }) => {
  it.each(ALLOWED_ADDRESSES)('keeps %s a live link with today’s attributes', (_label, address) => {
    const { container } = render(draw(`[open me](${address})`));

    const link = screen.getByRole('link', { name: 'open me' });
    expect(link).toHaveAttribute('href', address);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.className).toBe(linkClass);
    // A link the app is willing to open is still a link: nothing else appears.
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it.each(REFUSED_ADDRESSES)('refuses %s as inert text and leaves no href in the output', (_label, address) => {
    const { container } = render(draw(`[open me](${address})`));

    // No element carries the address: not a link, not a hidden href, not a
    // clickable ancestor.
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toContain('href');

    const note = screen.getByRole('note', { name: REFUSED_LINK_NOTICE });
    // The link text and the address itself stay readable, and the reason is named.
    expect(note.textContent).toContain('open me');
    expect(within(note).getByText(/^\(.*\)$/)).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('states the notice as a real sentence rather than a token', () => {
    expect(REFUSED_LINK_NOTICE.length).toBeGreaterThan(20);
    expect(REFUSED_LINK_NOTICE).toMatch(/not a link/);
  });

  it('leaves the confirmed links around a refused one working', () => {
    const { container } = render(draw('[real](https://example.com) and [fake](javascript:void) end'));

    expect(screen.getByRole('link', { name: 'real' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByRole('note', { name: REFUSED_LINK_NOTICE })).toBeDefined();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.textContent).toContain('and');
    expect(container.textContent).toContain('end');
  });

  it('keeps the surrounding inline styles working around a refused address', () => {
    const { container } = render(draw('**bold** and `code` around [fake](javascript:void)'));

    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(screen.getByRole('note', { name: REFUSED_LINK_NOTICE })).toBeDefined();
  });

  it('renders a message with no link at all unchanged', () => {
    const { container } = render(draw('just words'));

    expect(container.querySelector('a')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
    expect(container.textContent).toContain('just words');
  });
});
