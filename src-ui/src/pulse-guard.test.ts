import { describe, expect, it } from 'vitest';
import { findPulseSites } from './lib/pulse-guard';
const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
describe('pulse guard on migrated advanced controls', () => {
  it('retains only the observed Cron-flight pulse and stops it on failed reads', () => {
    const sites = findPulseSites(sources);
    expect(sites).toHaveLength(1);
    expect(sites[0].file).toBe('./features/cron/GoalCronPage.tsx');
    expect(sites[0].text).toContain('!inFlightReadFailed');
    expect(sources['./features/system/HealthBanner.tsx']).toContain('live={!error');
  });
});
