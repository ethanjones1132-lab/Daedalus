import { describe, expect, it } from 'vitest';
import {
  SHARED_DECISION_CALLS,
  findHrefSites,
  hrefValueSource,
  isRoutedThroughDecision,
  matchHrefAllowlist,
  type HrefAllowlistEntry,
} from './link-scheme-guard';

const ALLOWLIST: HrefAllowlistEntry[] = [
  {
    file: './components/jarvis/Reader.tsx',
    text: 'href={link.href}',
    kind: 'shared-decision',
    reason: 'Routed through the shared decision two lines above, so this value cannot be an address the app did not agree to open.',
  },
];

describe('findHrefSites', () => {
  it('finds every href site with its line, trimmed text and value expression', () => {
    const sites = findHrefSites({
      './components/jarvis/Reader.tsx': [
        'export function Reader() {',
        '  const link = projectLink(address);',
        '  return (',
        '    <a href={link.href} target="_blank">',
        '      open',
        '    </a>',
        '  );',
        '}',
      ].join('\n'),
    });

    expect(sites).toEqual([
      {
        file: './components/jarvis/Reader.tsx',
        line: 4,
        text: '<a href={link.href} target="_blank">',
        value: '{link.href}',
      },
    ]);
  });

  it('scans every file in sorted order, so the report is stable', () => {
    const sites = findHrefSites({ './b.tsx': '<a href={one} />', './a.tsx': '<a href={two} />' });

    expect(sites.map((site) => site.file)).toEqual(['./a.tsx', './b.tsx']);
  });

  it('skips test modules, raw-import specifiers, the guard itself and comment lines', () => {
    const sites = findHrefSites({
      './components/jarvis/Reader.test.tsx': 'render(<a href={x} />);',
      './a.tsx?raw': 'import x from "./b.tsx?raw";',
      './lib/link-scheme-guard.ts': "const HREF_OPEN = 'href={';",
      './components/jarvis/Writer.tsx': [
        '// <a href={commented} /> — a claim described in prose',
        '/* <a href={blocked} /> */',
        '  <a href={real} />',
      ].join('\n'),
    });

    expect(sites).toEqual([
      { file: './components/jarvis/Writer.tsx', line: 3, text: '<a href={real} />', value: '{real}' },
    ]);
  });

  it('reads a value that spans lines, and a value containing a brace inside a string', () => {
    const sites = findHrefSites({
      './multiline.tsx': ['<a', '  href={', '    link.href', '  }', '  rel="noopener"', '/>'].join('\n'),
      './quoted.tsx': `<a href={cn('a}b', link.href)} />`,
    });

    expect(sites[0].value).toBe('{\n    link.href\n  }');
    expect(sites[1].value).toBe("{cn('a}b', link.href)}");
  });

  it('reports a value whose braces never balance as empty rather than dropping the site', () => {
    const sites = findHrefSites({ './broken.tsx': '<a href={link.href />' });

    expect(sites).toHaveLength(1);
    expect(sites[0].value).toBe('');
  });
});

describe('hrefValueSource', () => {
  it('follows a plain identifier to the declaration it was bound to', () => {
    const source = ['const link = projectLink(address);', '<a href={link.href} />'].join('\n');
    const [site] = findHrefSites({ './a.tsx': source });

    expect(hrefValueSource(site, { './a.tsx': source })).toBe('projectLink(address);');
  });

  it('uses the last declaration when a file rebinds the identifier', () => {
    const source = [
      'const link = projectLink(first);',
      'const other = 1;',
      'const link = projectLink(second);',
      '<a href={link.href} />',
    ].join('\n');
    const [site] = findHrefSites({ './a.tsx': source });

    expect(hrefValueSource(site, { './a.tsx': source })).toBe('projectLink(second);');
  });

  it('falls back to the value itself when the identifier is not declared in the file', () => {
    const source = '<a href={props.href} />';
    const [site] = findHrefSites({ './a.tsx': source });

    expect(hrefValueSource(site, { './a.tsx': source })).toBe('props.href');
  });

  it('leaves a literal or call value as its own source', () => {
    const source = '<a href={projectLink(x).href} />';
    const [site] = findHrefSites({ './a.tsx': source });

    expect(hrefValueSource(site, { './a.tsx': source })).toBe('projectLink(x).href');
  });
});

describe('isRoutedThroughDecision', () => {
  it('accepts a value that is the decision', () => {
    const tree = { './a.tsx': '<a href={projectLink(x).href} />' };

    expect(isRoutedThroughDecision(findHrefSites(tree)[0], tree)).toBe(true);
  });

  it('accepts a value that came from the decision', () => {
    const tree = { './b.tsx': ['const link = projectLink(x);', '<a href={link.href} />'].join('\n') };

    expect(isRoutedThroughDecision(findHrefSites(tree)[0], tree)).toBe(true);
  });

  it('rejects an author-supplied value, a props member and a bare literal', () => {
    const tree = {
      './a.tsx': '<a href={match.groups[1]} />',
      './b.tsx': '<a href={props.href} />',
      './c.tsx': '<a href={"javascript:void"} />',
    };

    for (const site of findHrefSites(tree)) {
      expect(isRoutedThroughDecision(site, tree), site.file).toBe(false);
    }
  });

  it('names the calls it accepts, so a rename is a deliberate edit to the rule', () => {
    expect(SHARED_DECISION_CALLS).toEqual(['projectLink(']);
  });
});

describe('matchHrefAllowlist', () => {
  const routed = {
    './components/jarvis/Reader.tsx': [
      'const link = projectLink(address);',
      '<a href={link.href} target="_blank">open</a>',
    ].join('\n'),
  };
  const unrouted = {
    './components/jarvis/Reader.tsx': [
      'const address = match.groups[1];',
      '<a href={address} target="_blank">open</a>',
    ].join('\n'),
  };

  it('accounts for a routed site with one entry', () => {
    const sites = findHrefSites(routed);

    expect(matchHrefAllowlist(sites, ALLOWLIST, routed)).toEqual({
      undocumented: [],
      unused: [],
      unrouted: [],
    });
  });

  it('reports a site no entry accounts for', () => {
    const match = matchHrefAllowlist(findHrefSites(unrouted), [], unrouted);

    expect(match.undocumented.map((site) => site.text)).toEqual([
      '<a href={address} target="_blank">open</a>',
    ]);
  });

  it('reports an entry that matches no site, so a moved link cannot keep its claim', () => {
    const match = matchHrefAllowlist(findHrefSites(unrouted), ALLOWLIST, unrouted);

    expect(match.unused.map((entry) => entry.text)).toEqual(['href={link.href}']);
    expect(match.undocumented).toHaveLength(1);
  });

  it('reports a documented claim whose value never reached the decision', () => {
    const match = matchHrefAllowlist(findHrefSites(unrouted), [{ ...ALLOWLIST[0], text: 'href={address}' }], unrouted);

    expect(match.unrouted.map((entry) => entry.text)).toEqual(['href={address}']);
    expect(match.undocumented).toEqual([]);
  });

  it('claims at most one site per entry, so a second link on the same shape is documented twice', () => {
    const tree = {
      './components/jarvis/Reader.tsx': [
        'const link = projectLink(x);',
        '<a href={link.href} />',
        '<a href={link.href} />',
      ].join('\n'),
    };
    const match = matchHrefAllowlist(findHrefSites(tree), ALLOWLIST, tree);

    expect(match.undocumented).toHaveLength(1);
  });
});
