import { describe, expect, it } from 'vitest';
import { findPulseSites, matchPulseAllowlist, type PulseAllowlistEntry } from './pulse-guard';

const entry = (text: string, file = './a.tsx'): PulseAllowlistEntry => ({
  file,
  text,
  kind: 'read-gated',
  reason: 'gated on a read that can fail',
});

describe('findPulseSites', () => {
  it('finds one site per line, trimmed, in file then line order', () => {
    const sites = findPulseSites({
      './b.tsx': "const a = 1;\n<span className='w-2 rounded-full animate-pulse' />\n",
      './a.tsx': "  pulse && 'animate-pulse',  \n",
    });
    expect(sites).toEqual([
      { file: './a.tsx', text: "pulse && 'animate-pulse'," },
      { file: './b.tsx', text: "<span className='w-2 rounded-full animate-pulse' />" },
    ]);
  });

  it('ignores test modules, query-suffixed specifiers, comment prose and itself', () => {
    const sites = findPulseSites({
      './App.pulse.test.tsx': "expect(x).toBe('animate-pulse');",
      './App.tsx?raw': "<span className='animate-pulse' />",
      './lib/pulse-guard.ts': "// this module names animate-pulse in prose and in its own literal\nif (text.includes('animate-pulse')) sites.push({ file, text });\n",
      './notes.ts': '/** animate-pulse means alive right now. */\n',
      './App.tsx': "<span className='animate-pulse' />",
    });
    expect(sites).toEqual([{ file: './App.tsx', text: "<span className='animate-pulse' />" }]);
  });

  it('reports nothing for source with no animation, so an empty scan is possible', () => {
    expect(findPulseSites({ './a.tsx': 'const a = 1;\n' })).toEqual([]);
  });
});

describe('matchPulseAllowlist', () => {
  const sites = findPulseSites({
    './a.tsx': "<span className='w-2 rounded-full animate-pulse' />\n<span className='w-2 animate-pulse' />\n",
  });

  it('reports a site no entry accounts for', () => {
    const { undocumented } = matchPulseAllowlist(sites, [entry('rounded-full')]);
    expect(undocumented).toEqual([{ file: './a.tsx', text: "<span className='w-2 animate-pulse' />" }]);
  });

  it('reports an entry that matches no site, so a moved animation is not a standing claim', () => {
    const { unused } = matchPulseAllowlist(sites, [entry('rounded-full'), entry('gone')]);
    expect(unused.map((item) => item.text)).toEqual(['gone']);
  });

  it('matches by containment and consumes one site per entry', () => {
    const { undocumented, unused } = matchPulseAllowlist(sites, [entry('animate-pulse'), entry('animate-pulse')]);
    expect(undocumented).toEqual([]);
    expect(unused).toEqual([]);
  });

  it('does not let an entry in one file account for the same class in another', () => {
    const { undocumented } = matchPulseAllowlist(sites, [entry('rounded-full', './other.tsx'), entry('rounded-full')]);
    expect(undocumented).toHaveLength(1);
  });
});
