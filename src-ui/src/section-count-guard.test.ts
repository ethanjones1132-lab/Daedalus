import { describe, expect, it } from 'vitest';
import { findCountSites, isOptionalRead, routesThroughSharedTally } from './lib/section-count-guard';
const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
describe('header tally guard on integrated native workflows', () => {
  it('gates list headings on shared tallies or optional authoritative reads', () => {
    const sites = findCountSites(sources);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      // Stat counts on the Actions board are native summary metrics. That board
      // mounts only after the registry snapshot read; pending/failure tests pin it.
      if (site.file === './features/actions/ActionsPage.tsx' && site.text.includes('summary.')) continue;
      if (site.file === './features/skills/SkillLearningPage.tsx' && site.text.includes('enabledCount')) { expect(sources[site.file]).toContain('const enabledCount = tallyNumber('); continue; }
      expect(isOptionalRead(site.text) || routesThroughSharedTally(site.text), `${site.file}: ${site.text}`).toBe(true);
    }
  });
});
