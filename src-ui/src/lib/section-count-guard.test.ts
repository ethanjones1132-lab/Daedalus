// Unit contracts for the section-count guard's analysis.
//
// The rule test (`src/section-count-guard.test.ts`) runs the analysis over the
// real tree through a Vite `?raw` glob. These pin the analysis itself, on
// synthetic sources, so each of the ways it could stop finding a site — and each
// of the ways it could go quiet — is a named failure rather than a surprise in
// someone else's commit.

import { describe, expect, it } from 'vitest';
import {
  findCountSites,
  isOptionalRead,
  matchCountAllowlist,
  routesThroughSharedTally,
} from './section-count-guard';

const SOURCES = {
  './a/Reader.tsx': [
    'export function Reader() {',
    '  return <SectionHeader title="Devices" count={devices.length} />;',
    '}',
  ].join('\n'),
  './c/Toast.tsx': [
    '  <SectionHeader',
    '    title="Skills"',
    '    count={sectionCount(skills, { loading, failed: error !== null })}',
    '  />',
  ].join('\n'),
};

describe('findCountSites', () => {
  it('finds every count prop, on one line or spread across several', () => {
    const sites = findCountSites(SOURCES);
    expect(sites.map((site) => `${site.file}: ${site.text}`)).toEqual([
      './a/Reader.tsx: return <SectionHeader title="Devices" count={devices.length} />;',
      './c/Toast.tsx: count={sectionCount(skills, { loading, failed: error !== null })}',
    ]);
  });

  it('ignores test modules, query-suffixed specifiers and itself', () => {
    const sites = findCountSites({
      './a/Reader.test.tsx': 'const el = <SectionHeader count={rows.length} />;',
      './a/Reader.tsx?raw': 'const el = <SectionHeader count={rows.length} />;',
      './lib/section-count-guard.ts': 'const COUNT_PROP = /count=\\{/;',
      './a/Real.tsx': 'const el = <SectionHeader count={rows.length} />;',
    });
    expect(sites.map((site) => site.file)).toEqual(['./a/Real.tsx']);
  });

  it('ignores a line that is only a comment about a count', () => {
    // Otherwise this analysis's own documentation would be its first site, and
    // the rule would be asking about itself.
    const sites = findCountSites({
      './a/Notes.tsx': ['// the old header said count={rows.length}', '/* count={rows.length} */', '  const x = 1;'].join('\n'),
    });
    expect(sites).toEqual([]);
  });

  it('ignores the primitive’s own prop, which is not a caller’s number', () => {
    const sites = findCountSites({
      './components/ui/index.tsx': [
        '  count?: number;',
        '  {typeof count === \'number\' && (',
        '      <span className="ml-2 text-sm text-bone/40 font-normal">',
        '        ({count})',
      ].join('\n'),
    });
    expect(sites).toEqual([]);
  });

  it('finds a count in a non-component module too, because the rule spans files', () => {
    const sites = findCountSites({ './lib/thing.ts': 'export const props = { count={x} };' });
    expect(sites).toHaveLength(1);
  });
});

describe('matchCountAllowlist', () => {
  it('reports a site no entry accounts for', () => {
    const sites = findCountSites(SOURCES);
    const { undocumented } = matchCountAllowlist(sites, [
      { file: './c/Toast.tsx', text: 'count={sectionCount(', kind: 'confirmed-read', reason: 'x'.repeat(70) },
    ]);
    expect(undocumented.map((site) => site.file)).toEqual(['./a/Reader.tsx']);
  });

  it('reports an entry that matches nothing, so a fixed site cannot leave a stale claim', () => {
    const sites = findCountSites(SOURCES);
    const { unused, undocumented } = matchCountAllowlist(sites, [
      { file: './a/Reader.tsx', text: 'count={devices.length}', kind: 'confirmed-read', reason: 'x'.repeat(70) },
      { file: './c/Toast.tsx', text: 'count={sectionCount(', kind: 'confirmed-read', reason: 'x'.repeat(70) },
      { file: './a/Gone.tsx', text: 'count={gone.length}', kind: 'confirmed-read', reason: 'x'.repeat(70) },
    ]);
    expect(unused.map((entry) => entry.file)).toEqual(['./a/Gone.tsx']);
    expect(undocumented).toEqual([]);
  });

  it('claims at most one site per entry, so a second count on the same shape is red', () => {
    const sites = findCountSites({
      './a/Twin.tsx': [
        '        count={rows.length}',
        '        count={rows.length}',
      ].join('\n'),
    });
    const { undocumented } = matchCountAllowlist(sites, [
      { file: './a/Twin.tsx', text: 'count={rows.length}', kind: 'confirmed-read', reason: 'x'.repeat(70) },
    ]);
    expect(undocumented).toHaveLength(1);
  });

  it('matches on the file as well as the line, so two files cannot share one entry', () => {
    const sites = findCountSites({
      './a/One.tsx': '  count={rows.length}',
      './a/Two.tsx': '  count={rows.length}',
    });
    const { undocumented } = matchCountAllowlist(sites, [
      { file: './a/One.tsx', text: 'count={rows.length}', kind: 'confirmed-read', reason: 'x'.repeat(70) },
    ]);
    expect(undocumented.map((site) => site.file)).toEqual(['./a/Two.tsx']);
  });
});

describe('the kinds, machine-checked', () => {
  it('recognises a count that asks the shared tally', () => {
    expect(routesThroughSharedTally('count={sectionCount(devices, { loading, failed })}')).toBe(true);
    expect(routesThroughSharedTally('count={countProp(tally)}')).toBe(true);
    expect(routesThroughSharedTally('count={tally.count ?? undefined}')).toBe(false);
    expect(routesThroughSharedTally('count={devices.length}')).toBe(false);
  });

  it('recognises a count that is optional-chained off an unread value', () => {
    expect(isOptionalRead('count={summary?.active}')).toBe(true);
    expect(isOptionalRead('count={sessions?.length}')).toBe(true);
    expect(isOptionalRead('count={sessions.length}')).toBe(false);
  });

  it('keeps the two shapes apart, because one of them is a claim and one is not', () => {
    // `count={rows.length}` is neither: a number from a list no read has been
    // asked about, which is the whole reason this guard exists.
    const raw = 'count={rows.length}';
    expect(routesThroughSharedTally(raw)).toBe(false);
    expect(isOptionalRead(raw)).toBe(false);
  });
});
