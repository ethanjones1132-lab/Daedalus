// Raw-error guard: the analysis half.
//
// Unit contracts for the scanner and the matcher, with no tree of their own —
// the allowlist that actually gates the repo lives in `src/read-error-guard.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  findReadErrorSites,
  matchReadErrorAllowlist,
  type ReadErrorEntry,
} from './read-error-guard';

const SOURCES = {
  'a/Reader.tsx': [
    "import { useState } from 'react';",
    'export function Reader() {',
    '  const [error, setError] = useState<string | null>(null);',
    '  const read = async () => {',
    '    try { setRows(await invoke("get_rows")); }',
    '    catch (e) { setError(String(e)); }',
    '  };',
    '}',
  ].join('\n'),
  'b/Writer.tsx': [
    'export function Writer() {',
    '  const run = async () => {',
    '    try { await invoke("put_row"); }',
    '    catch (e) { console.error("write failed", e); }',
    '  };',
    '}',
  ].join('\n'),
  'c/Toast.tsx': [
    "import { toast } from '../ui';",
    "    catch (err) { toast.error('Delete failed', err?.message); }",
  ].join('\n'),
  'd/notes.md': 'String(e) is a JavaScript idiom, not a leak.',
  'e/Reader.test.tsx': "    catch (e) { setError(String(e)); }",
  'f/Legacy.tsx': ['  // setError(String(e)) was removed here.', '  setError(READ_FAILED);'].join('\n'),
  'g/Joined.tsx': [
    '    catch (e) { setError("Append failed: " + (e?.message || String(e))); }',
  ].join('\n'),
};

describe('findReadErrorSites', () => {
  it('finds a caught value stringified into an error state, and skips the modules that cannot render one', () => {
    const files = findReadErrorSites(SOURCES).map((site) => site.file);
    expect(files).toContain('a/Reader.tsx');
    // A value that only goes to the console reaches no surface.
    expect(files).not.toContain('b/Writer.tsx');
    // A toast body is a rendered surface, so it is a site.
    expect(files).toContain('c/Toast.tsx');
    // Non-modules, test modules and comment-only lines are not sites.
    expect(files).not.toContain('d/notes.md');
    expect(files).not.toContain('e/Reader.test.tsx');
    expect(files).not.toContain('f/Legacy.tsx');
  });

  it('finds a prefixed concatenation, because prefixing a leak is still a leak', () => {
    const sites = findReadErrorSites(SOURCES);
    expect(sites.some((site) => site.file === 'g/Joined.tsx' && site.text.includes('Append failed'))).toBe(true);
  });

  it('is not vacuous on an empty tree, and reports the whole line as the claim', () => {
    expect(findReadErrorSites({})).toEqual([]);
    const [site] = findReadErrorSites(SOURCES);
    expect(site.text).toBe('catch (e) { setError(String(e)); }');
  });
});

describe('matchReadErrorAllowlist', () => {
  const sites = findReadErrorSites(SOURCES);
  const entry = (over: Partial<ReadErrorEntry>): ReadErrorEntry => ({
    file: 'a/Reader.tsx',
    text: 'setError(String(e))',
    verdict: 'deferred',
    reason: 'The Native read error is rendered verbatim; a filed row owns the fixed copy.',
    ...over,
  });

  it('reports a site no entry accounts for, which is the guard failing', () => {
    const { undocumented } = matchReadErrorAllowlist(sites, [entry({})]);
    expect(undocumented.map((site) => `${site.file}: ${site.text}`)).toEqual([
      'c/Toast.tsx: catch (err) { toast.error(\'Delete failed\', err?.message); }',
      'g/Joined.tsx: catch (e) { setError("Append failed: " + (e?.message || String(e))); }',
    ]);
  });

  it('reports an entry that matches nothing, so a fixed site cannot leave a stale claim behind', () => {
    const { unused } = matchReadErrorAllowlist(sites, [entry({ text: 'setError(String(e)) /* removed */' })]);
    expect(unused.map((item) => item.text)).toEqual(['setError(String(e)) /* removed */']);
  });

  it('claims each site once, so a second site on the same shape has to be documented twice', () => {
    const two = [
      ...sites,
      { file: 'h/Second.tsx', text: 'catch (e) { setError(String(e)); }' },
    ];
    const { undocumented, unused } = matchReadErrorAllowlist(two, [entry({})]);
    expect(undocumented.map((site) => site.file)).toEqual([
      'c/Toast.tsx',
      'g/Joined.tsx',
      'h/Second.tsx',
    ]);
    expect(unused).toEqual([]);
  });

  it('accounts for every site when every site is documented', () => {
    const { undocumented, unused } = matchReadErrorAllowlist(sites, [
      entry({}),
      entry({ file: 'c/Toast.tsx', text: "toast.error('Delete failed'" }),
      entry({ file: 'g/Joined.tsx', text: 'Append failed' }),
    ]);
    expect(undocumented).toEqual([]);
    expect(unused).toEqual([]);
  });

  it('treats an authored claim as a documented site, not as a leak, and still holds it to one entry', () => {
    // `authored` is the verdict for the one value that reaches a surface on
    // purpose: the product's own claim about a chat turn, delivered beside a
    // stable code. It must satisfy the matcher exactly like any other entry, so
    // naming it is a decision someone wrote down rather than a hole in the table.
    const { undocumented, unused } = matchReadErrorAllowlist(sites, [
      entry({ text: 'setError(String(e))', verdict: 'authored' }),
      entry({ file: 'c/Toast.tsx', text: "toast.error('Delete failed'" }),
      entry({ file: 'g/Joined.tsx', text: 'Append failed' }),
    ]);
    expect(undocumented).toEqual([]);
    expect(unused).toEqual([]);
    // Two sites on the same shape still need two entries, whatever the verdict.
    const doubled = [...sites, { file: 'h/Second.tsx', text: 'catch (e) { setError(String(e)); }' }];
    const second = matchReadErrorAllowlist(doubled, [
      entry({ verdict: 'authored' }),
      entry({ file: 'c/Toast.tsx', text: "toast.error('Delete failed'" }),
      entry({ file: 'g/Joined.tsx', text: 'Append failed' }),
    ]);
    expect(second.undocumented.map((site) => site.file)).toEqual(['h/Second.tsx']);
  });
});
