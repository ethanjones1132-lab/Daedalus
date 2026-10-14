import { describe, expect, it } from 'vitest';
import {
  REFUSED_LINK_NOTICE,
  SAFE_LINK_SCHEMES,
  linkScheme,
  projectLink,
} from './link-scheme';

// A link destination in this app is author-supplied: model output in a
// transcript, a skill body off disk. The decision is pure so both renderers and
// the guard can hold the same answer.

describe('linkScheme', () => {
  it('reads a scheme, lower-cased, for an absolute address', () => {
    expect(linkScheme('https://example.com')).toBe('https');
    expect(linkScheme('HTTPS://example.com')).toBe('https');
    expect(linkScheme('mailto:operator@example.com')).toBe('mailto');
  });

  it('reads no scheme for the addresses the library rule calls relative', () => {
    expect(linkScheme('/sessions/42')).toBeNull();
    expect(linkScheme('#turn-3')).toBeNull();
    expect(linkScheme('?a=b')).toBeNull();
    expect(linkScheme('//cdn.example.com/asset.png')).toBeNull();
    expect(linkScheme('docs/page.md')).toBeNull();
  });

  it('keeps the library’s relative rule: a first colon after /, ? or # is not a scheme', () => {
    expect(linkScheme('/a/b:c')).toBeNull();
    expect(linkScheme('docs?q=a:b')).toBeNull();
    expect(linkScheme('#x:javascript:void')).toBeNull();
    expect(linkScheme('mailto:operator@example.com')).toBe('mailto');
    // The colon that decides is the first one, so this is a javascript scheme
    // with a slash inside its body rather than a relative path.
    expect(linkScheme('javascript:a/b')).toBe('javascript');
  });
});

describe('projectLink', () => {
  it.each(['http://example.com', 'https://example.com/a?b=c#d', 'mailto:operator@example.com'])(
    'opens %s',
    (address) => {
      const verdict = projectLink(address);
      expect(verdict.allowed).toBe(true);
      if (!verdict.allowed) throw new Error('expected an allowed verdict');
      expect(verdict.href).toBe(address);
    },
  );

  it.each([
    ['a relative path', '/sessions/42'],
    ['a bare fragment', '#turn-3'],
    ['a query-only address', '?a=b'],
    ['a scheme-relative address', '//cdn.example.com/asset.png'],
    ['a relative path with a colon after a slash', '/a/b:c'],
    ['a relative path with a colon in its query', 'docs?q=a:b'],
    ['a fragment containing something that looks like a scheme', '#x:javascript:void'],
  ])('opens %s', (_label, address) => {
    const verdict = projectLink(address);
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error('expected an allowed verdict');
    expect(verdict.href).toBe(address);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html;base64,PHN2Zz4='],
    ['file', 'file:///etc/hosts'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['ircs, which the library default allowed and this app has no client for', 'ircs://irc.example.com/x'],
    ['xmpp, which the library default allowed and this app has no client for', 'xmpp:operator@example.com'],
  ])('refuses %s', (_label, address) => {
    const verdict = projectLink(address);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('expected a refused verdict');
    // The refused verdict carries the address the author wrote, unchanged, so the
    // surface can show it rather than swallowing it.
    expect(verdict.address).toBe(address);
    expect(verdict.scheme).toBe(address.slice(0, address.indexOf(':')).toLowerCase());
  });

  it('refuses an address with no scheme at all in it, so an empty href cannot reach the DOM', () => {
    for (const address of ['', '   ', '\t', undefined, null]) {
      const verdict = projectLink(address);
      expect(verdict.allowed, `address ${JSON.stringify(address)}`).toBe(false);
      if (verdict.allowed) throw new Error('expected a refused verdict');
      expect(verdict.address).toBe(address ?? '');
      expect(verdict.scheme).toBeNull();
    }
  });

  it('refuses a scheme hidden behind whitespace, because a browser strips it first', () => {
    for (const address of [' javascript:alert(1)', '\tjavascript:alert(1)', '  JaVaScRiPt:alert(1)']) {
      const verdict = projectLink(address);
      expect(verdict.allowed, address).toBe(false);
      if (verdict.allowed) throw new Error('expected a refused verdict');
      expect(verdict.scheme).toBe('javascript');
    }
  });

  it('refuses a scheme split by a tab or newline, because a browser strips those too', () => {
    for (const address of ['java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)']) {
      const verdict = projectLink(address);
      expect(verdict.allowed, address).toBe(false);
      if (verdict.allowed) throw new Error('expected a refused verdict');
      // The scheme is not reassembled from the stripped form, so a split scheme
      // fails the allowlist rather than quietly becoming a real one.
      expect(verdict.scheme).toBe(address.slice(0, address.indexOf(':')).toLowerCase());
      expect(verdict.scheme).not.toBe('javascript');
    }
  });

  it('still opens a safe scheme padded with whitespace, so an ordinary address is not needlessly broken', () => {
    const verdict = projectLink(' https://example.com/docs');
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error('expected an allowed verdict');
    // The address is never rewritten: what the author wrote is what is opened.
    expect(verdict.href).toBe(' https://example.com/docs');
  });

  it('names the scheme it will open, so a caller never re-derives it', () => {
    const verdict = projectLink('HTTPS://example.com');
    if (!verdict.allowed) throw new Error('expected an allowed verdict');
    expect(verdict.scheme).toBe('https');
    expect(SAFE_LINK_SCHEMES).toEqual(['http', 'https', 'mailto']);
  });

  it('carries a notice that says the address was not made into a link', () => {
    // The same sentence the boundary contracts assert on the DOM, pinned here as a
    // value so changing the copy is a deliberate edit in two places.
    expect(REFUSED_LINK_NOTICE).toBe('This address is not a link: Daedalus did not make it clickable.');
    expect(REFUSED_LINK_NOTICE).toMatch(/not a link/);
    expect(REFUSED_LINK_NOTICE.length).toBeGreaterThan(20);
    // It never names a scheme: the point is that the operator learns the app made
    // a decision, not why the author wrote what they wrote.
    expect(REFUSED_LINK_NOTICE).not.toMatch(/javascript|data|file|vbscript/i);
  });
});
