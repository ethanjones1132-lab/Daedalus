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

// The second half of a header is its `action` slot: the pills that finish the
// sentence its count started. `SkillsView` and `ChannelsView` each printed
// `{n} enabled` / `{n} connected` / `{n} delivery verified` from a list that
// starts `[]`, in a slot the primitive renders unconditionally, so a failed
// read put three confident zeros in the header above the surface's own
// "could not load" line. These pin the analysis that finds them.
const ACTION_SOURCES = {
  './a/Skills.tsx': [
    '      <SectionHeader',
    '        title="Skills"',
    '        count={countProp(tally)}',
    '        action={',
    '          <Pill variant={tallyTone(enabled)}>{enabled} enabled</Pill>',
    '        }',
    '      />',
  ].join('\n'),
  './b/Channels.tsx': [
    '        action={',
    '          <div className="flex items-center gap-2">',
    '            {connected === null ? null : (',
    '              <Pill variant={tallyTone(connected)}>{connected} connected</Pill>',
    '            )}',
    '            {verified === null ? null : (',
    '              <Pill variant={tallyTone(verified)}>{verified} delivery verified</Pill>',
    '            )}',
    '            <button type="button">{adding ? \'Close\' : \'+ New channel\'}</button>',
    '          </div>',
    '        }',
  ].join('\n'),
  './c/Ledger.tsx': [
    '        action={',
    '          <div>',
    '            <Pill variant="info">stale</Pill>',
    '            <Pill variant="default" />',
    '            <button type="button">Retry</button>',
    '          </div>',
    '        }',
    '      <li><Pill variant={state.status}>{state.status}</Pill></li>',
  ].join('\n'),
};

describe('findCountSites: the action slot', () => {
  it('finds a tally pill beside its count, and says which slot it came from', () => {
    const sites = findCountSites(ACTION_SOURCES);
    expect(
      sites
        .filter((site) => site.slot === 'action')
        .map((site) => `${site.file}: ${site.text}`),
    ).toEqual([
      './a/Skills.tsx: <Pill variant={tallyTone(enabled)}>{enabled} enabled</Pill>',
      './b/Channels.tsx: <Pill variant={tallyTone(connected)}>{connected} connected</Pill>',
      './b/Channels.tsx: <Pill variant={tallyTone(verified)}>{verified} delivery verified</Pill>',
    ]);
  });

  it('still finds the count props of the same headers, so both halves are policed', () => {
    // The count and the pills are one sentence, and the rule has to hold on
    // both halves of it rather than only the one inside the heading.
    const sites = findCountSites(ACTION_SOURCES);
    expect(sites.filter((site) => site.slot === 'count').map((site) => site.text)).toEqual([
      'count={countProp(tally)}',
    ]);
  });

  it('points at the line the claim is on, so a failure message can name it', () => {
    const [site] = findCountSites(ACTION_SOURCES).filter((candidate) => candidate.slot === 'action');
    expect(site.line).toBe(5);
  });

  it('reports the whole pill, so children on their own line cannot hide the claim', () => {
    // A count is a line; a pill is an element. The element is what carries the
    // number, so it is the element the rule claims — otherwise reformatting the
    // children onto separate lines would silently un-claim the site.
    const sites = findCountSites({
      './a/Split.tsx': [
        '        action={',
        '          <Pill variant={enabled > 0 ? \'success\' : \'default\'}>',
        '            {enabled} enabled',
        '          </Pill>',
        '        }',
      ].join('\n'),
    });
    expect(sites).toHaveLength(1);
    expect(sites[0].text).toBe("<Pill variant={enabled > 0 ? 'success' : 'default'}> {enabled} enabled </Pill>");
  });

  it('ignores a pill that states no number, however it is written', () => {
    // A status word, a self-closing chip and a row-level pill below the header
    // are three different things that are all not a tally.
    expect(findCountSites(ACTION_SOURCES).filter((site) => site.slot === 'action')).toHaveLength(3);
  });

  it('does not end an action region at a brace inside a string', () => {
    // The region is found by balancing braces, so a class name or a title with
    // a brace in it would otherwise truncate the scan and hide a later pill.
    const sites = findCountSites({
      './a/Braces.tsx': [
        '        action={',
        '          <div className="w-[calc(100%-2rem)]" title="a } brace">',
        '            <Pill variant={tallyTone(n)}>{n} enabled</Pill>',
        '          </div>',
        '        }',
      ].join('\n'),
    });
    expect(sites.map((site) => site.text)).toEqual([
      '<Pill variant={tallyTone(n)}>{n} enabled</Pill>',
    ]);
  });

  it('ignores a line that is only a comment about a pill', () => {
    const sites = findCountSites({
      './a/Notes.tsx': [
        '        // the old slot printed <Pill>{n} enabled</Pill>',
        '        action={',
        '          <Pill variant={tallyTone(n)}>{n} enabled</Pill>',
        '        }',
      ].join('\n'),
    });
    expect(sites).toHaveLength(1);
    expect(sites[0].line).toBe(3);
  });

  it('claims one pill per entry, so a second tally in one slot is red', () => {
    // Channels states two tallies from one list, and a third would be a third
    // number about the same read that nothing has accounted for.
    const sites = findCountSites(ACTION_SOURCES);
    const { undocumented } = matchCountAllowlist(sites, [
      { file: './b/Channels.tsx', text: '{connected} connected', kind: 'confirmed-read', reason: 'x'.repeat(70) },
    ]);
    expect(undocumented.map((site) => site.text)).toEqual([
      'count={countProp(tally)}',
      '<Pill variant={tallyTone(enabled)}>{enabled} enabled</Pill>',
      '<Pill variant={tallyTone(verified)}>{verified} delivery verified</Pill>',
    ]);
  });

  it('reports an action-slot entry that matches nothing, so a fixed pill leaves no stale claim', () => {
    const sites = findCountSites(ACTION_SOURCES);
    const { unused } = matchCountAllowlist(sites, [
      { file: './a/Skills.tsx', text: '{enabled} enabled', kind: 'confirmed-read', reason: 'x'.repeat(70) },
      { file: './a/Gone.tsx', text: '{gone} enabled', kind: 'confirmed-read', reason: 'x'.repeat(70) },
    ]);
    expect(unused.map((entry) => entry.file)).toEqual(['./a/Gone.tsx']);
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

  it('recognises a tally pill that asks the shared tally, and one that does not', () => {
    expect(routesThroughSharedTally("<Pill variant={tallyTone(enabled)}>{enabled} enabled</Pill>")).toBe(true);
    expect(routesThroughSharedTally("<Pill variant={enabledCount > 0 ? 'success' : 'default'}>{enabledCount} enabled</Pill>")).toBe(false);
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
