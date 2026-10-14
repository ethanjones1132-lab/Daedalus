import { describe, expect, it } from 'vitest';
import { findHrefSites, isRoutedThroughDecision } from './lib/link-scheme-guard';
const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
describe('link-scheme guard on shared Markdown presentation', () => {
  it('routes every rendered author address through the shared scheme decision', () => {
    const sites = findHrefSites(sources);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(isRoutedThroughDecision(site, sources), `${site.file}: ${site.text}`).toBe(true);
    expect(sources['./features/sessions/MarkdownView.tsx']).toContain('RefusedMarkdownLink');
  });
});
