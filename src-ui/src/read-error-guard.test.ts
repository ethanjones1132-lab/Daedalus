import { describe, expect, it } from 'vitest';
import { findReadErrorSites } from './lib/read-error-guard';
const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
describe('raw-error guard on the integrated architecture', () => {
  it('permits only structured Session-turn diagnoses; rejected Native reads use authored recovery copy', () => {
    const sites = findReadErrorSites(sources);
    expect(sites).toEqual([{ file: './features/sessions/useSessionTurn.ts', text: "const errorMessage = errorCode ? String(e instanceof Error ? e.message : e) : 'The turn failed. Your message is kept as a draft — send it again to retry.';" }]);
    const controller = sources['./features/sessions/useSessionTurn.ts'];
    expect(controller).toContain('const errorCode = e instanceof JarvisStreamError ? e.code : undefined;');
    expect(controller).toContain('await response.text().catch');
  });
});
