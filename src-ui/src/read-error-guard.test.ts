import { describe, expect, it } from 'vitest';
import {
  findReadErrorSites,
  matchReadErrorAllowlist,
  type ReadErrorEntry,
} from './lib/read-error-guard';
const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// DD-103 narrowed the one sanctioned read to `turnFailureCopy` in the turn
// controller: a coded rejection's one-line reason, or the handler's own
// Session-creation sentence, sanitized before it can render. Every other caught
// value — including a Native read's rejection — must stay behind authored copy.
const TURN_FAILURE_SITE = {
  file: './features/sessions/useSessionTurn.ts',
  text: 'const claimed = errorCode || error.message === SESSION_CREATION_FAILED ? error.message : undefined;',
};

describe('raw-error guard on the integrated architecture', () => {
  it('permits only the sanitized turn-failure copy; rejected Native reads use authored recovery copy', () => {
    const sites = findReadErrorSites(sources);
    expect(sites).toEqual([TURN_FAILURE_SITE]);
    const controller = sources[TURN_FAILURE_SITE.file];
    expect(controller).toContain('const errorCode = e instanceof JarvisStreamError ? e.code : undefined;');
    expect(controller).toContain('const errorMessage = turnFailureCopy(e, errorCode);');
    expect(controller).toContain("const SESSION_CREATION_FAILED = 'Could not create a Session for this message.';");
    expect(controller).toContain('function normalizeTurnFailureReason(value: string): string | null {');
    expect(controller).toContain('await response.text().catch');
    // The pre-DD-103 broad surface is gone; the sanctioned site is now the
    // sanitizer's own selection of the value it may show.
    expect(controller).not.toContain('String(e instanceof Error ? e.message : e)');
  });

  it('still reports an unaccounted direct caught-error surface beside the sanctioned site', () => {
    const withNativeRead = {
      ...sources,
      './features/sessions/NativeReadFixture.tsx': 'catch (error) { setLoadError(error.message); }',
    };
    const sites = findReadErrorSites(withNativeRead);
    expect(sites.filter(site => site.file === TURN_FAILURE_SITE.file)).toEqual([TURN_FAILURE_SITE]);
    expect(sites.map(site => site.file)).toContain('./features/sessions/NativeReadFixture.tsx');
  });

  it('does not let the turn-failure entry cover a transport error surfaced by an unrelated Native read', () => {
    const sites = findReadErrorSites({
      './features/sessions/useSessionTurn.ts': sources[TURN_FAILURE_SITE.file],
      './features/sessions/DeviceNamesFixture.tsx': 'catch (e) { setDeviceError(String(e)); }',
    });
    const entry: ReadErrorEntry = {
      ...TURN_FAILURE_SITE,
      verdict: 'authored',
      reason: 'DD-103 sanitized turn-failure copy: a coded reason or the authored Session-creation sentence, never a bare transport error.',
    };
    const { undocumented, unused } = matchReadErrorAllowlist(sites, [entry]);
    expect(unused).toEqual([]);
    expect(undocumented.map(site => site.file)).toEqual(['./features/sessions/DeviceNamesFixture.tsx']);
  });
});
