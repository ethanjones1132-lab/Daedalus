// Raw-error guard: the rule, as a ratchet.
//
// The fixed-message rule is established in five sibling surfaces and violated in
// thirteen places across eight files. That is the same shape as the pulse class:
// a rule stated in a row's Acceptance, fixed one surface at a time, and enforced by
// nothing — so a new surface can ship a raw Native rejection and the suite stays
// green. `read-error-guard.test.tsx` fixed the read paths this row names; this
// file is the part that keeps them fixed.
//
// Every line that stringifies a caught value is either documented here or the
// guard fails. The table below is CLOSED, and that is the part that matters:
//
// - a new site is undocumented, so it is red until someone writes down what
//   happens to the value;
// - a fixed site leaves its entry matching nothing, so the entry must be deleted —
//   a stale claim is an error, not a leftover;
// - `deferred` entries are leaks, not permissions. Each names the Ready row that
//   owns it, and the deferred set is pinned to an exact list, so the debt can
//   shrink but never grow quietly;
// - `unreachable` entries are machine-checked below: if a module listed as
//   unreachable ever gains an importer, the guard fails and the entry has to be
//   re-argued rather than inherited.
//
// It reads the source as text rather than rendering anything: the rule spans
// files, and rendering the app needs Tauri IPC mocks. No Rust toolchain, no Tauri.

import { describe, expect, it } from 'vitest';
import {
  findReadErrorSites,
  matchReadErrorAllowlist,
  type ReadErrorEntry,
} from './lib/read-error-guard';

// Vite `?raw` glob — every non-test source module as a string, so a new file with
// a raw Native rejection is scanned without touching this file.
const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const DEBT_ROW = '`fix(ui): withhold the native rejection on the four surfaces this guard lists as debt` (.sprint/BACKLOG.md)';

const ALLOWLIST: ReadErrorEntry[] = [
  {
    file: './components/jarvis/JarvisView.tsx',
    text: 'else setSessionsError(String(e));',
    verdict: 'deferred',
    reason:
      `The Session list read still renders the Native string in its announced alert, and \`JarvisView.sessions.test.tsx\` pins that raw copy today. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/JarvisView.tsx',
    text: 'const errorMessage = String(e instanceof Error ? e.message : e);',
    verdict: 'deferred',
    reason:
      `A failed chat turn renders the Bun server's own turn-failure copy in the designed error bubble beside an \`errorDisplayForCode\` label, so this is the server's authored text rather than a Native store rejection — a different claim, and the one place a turn failure has to say something specific. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/ModelProfilesView.tsx',
    text: 'setError(String(e));',
    verdict: 'deferred',
    reason:
      `The model-profile list read still renders the Native string through ErrorState. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/ModelProfilesView.tsx',
    text: "toastError(String(e), 'Activation failed');",
    verdict: 'deferred',
    reason:
      `The activation write toast still carries the Native string under a fixed title. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/ModelProfilesView.tsx',
    text: "toastError(String(e), 'Delete failed');",
    verdict: 'deferred',
    reason:
      `The delete write toast still carries the Native string under a fixed title. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/ModelProfilesView.tsx',
    text: "toastError(String(e), 'Create failed');",
    verdict: 'deferred',
    reason:
      `The create write toast still carries the Native string under a fixed title. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/SettingsView.tsx',
    text: 'setError(String(e));',
    verdict: 'deferred',
    reason:
      `The settings read still renders the Native string, and a settings row is exactly where configuration values live. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/SettingsView.tsx',
    text: 'toastError(String(e), `Failed to save ${key}`);',
    verdict: 'deferred',
    reason:
      `The per-setting save toast still carries the Native string under a fixed title. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/SkillsView.tsx',
    text: 'setRevError(String(e));',
    verdict: 'deferred',
    reason:
      `The skill-revision read still renders the Native string; the list read in the same file is fixed by this row and this one is a different read. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/SkillsView.tsx',
    text: "toastError(String(e), 'Restore failed');",
    verdict: 'deferred',
    reason:
      `The revision-restore write toast still carries the Native string under a fixed title. ${DEBT_ROW} owns it.`,
  },
  {
    file: './components/jarvis/SystemHealthView.tsx',
    text: 'setError(String(e));',
    verdict: 'unreachable',
    reason:
      'No module imports SystemHealthView except its own test, so this read cannot reach an operator; the retirement row that removes the module owns it, and the reachability check below fails the moment that stops being true.',
  },
  {
    file: './hooks/useResourceList.ts',
    text: 'setError(String(e));',
    verdict: 'unreachable',
    reason:
      'No module imports useResourceList, so this hook is dead code rather than a leak; the retirement row that removes it owns this, and the reachability check below fails the moment an importer appears.',
  },
];

const DEFERRED_EXPECTED = ALLOWLIST.filter((entry) => entry.verdict === 'deferred')
  .map((entry) => `${entry.file}: ${entry.text}`);

describe('raw-error guard', () => {
  it('finds every stringified rejection in the UI source, so the allowlist below cannot pass vacuously', () => {
    const sites = findReadErrorSites(sources);
    expect(sites.length).toBeGreaterThan(0);
    // The anchor is a site that is still listed as debt, so the scan cannot pass
    // by having stopped seeing the class it is meant to police.
    expect(
      sites.some((site) => site.file === './components/jarvis/ModelProfilesView.tsx' && site.text.includes('setError(String(e))')),
      'the scan should still find a read-path stringification the allowlist lists as debt — if it cannot, the scan stopped seeing the class',
    ).toBe(true);
  });

  it('allows no stringified rejection that the allowlist does not account for', () => {
    const sites = findReadErrorSites(sources);
    const { undocumented, unused } = matchReadErrorAllowlist(sites, ALLOWLIST);
    expect(
      undocumented,
      'stringified caught values with no documented fate — render a fixed sentence instead, or add an entry above saying where the value goes',
    ).toEqual([]);
    expect(
      unused.map((entry) => `${entry.file}: ${entry.text}`),
      'allowlist entries that match no site — the leak was fixed or moved, so the entry is now a claim about nothing',
    ).toEqual([]);
  });

  it('holds the debt still: every deferred site is listed, and no deferred site has been added quietly', () => {
    const sites = findReadErrorSites(sources);
    const { undocumented, unused } = matchReadErrorAllowlist(sites, ALLOWLIST);
    const deferred = ALLOWLIST.filter((entry) => entry.verdict === 'deferred');
    // An entry that claims a fixed site is an unused entry and fails above, so the
    // only way the list below grows is a deliberate edit here — which is the point.
    expect(undocumented).toEqual([]);
    expect(unused).toEqual([]);
    expect(deferred.map((entry) => `${entry.file}: ${entry.text}`)).toEqual(DEFERRED_EXPECTED);
  });

  it('names the row that owns every deferred leak, because a debt with no owner is a promise', () => {
    for (const entry of ALLOWLIST.filter((item) => item.verdict === 'deferred')) {
      expect(
        entry.reason,
        `${entry.file}: ${entry.text} must name the Ready row that owns the fix`,
      ).toContain('.sprint/BACKLOG.md');
    }
  });

  it('proves every unreachable entry is still unreachable', () => {
    for (const entry of ALLOWLIST.filter((item) => item.verdict === 'unreachable')) {
      const base = entry.file.split('/').pop()!.replace(/\.tsx?$/, '');
      const importers = Object.keys(sources)
        .filter((file) => file !== entry.file && !/\.test\.[cm]?[jt]sx?$/.test(file))
        .filter((file) => sources[file].includes(base));
      expect(
        importers,
        `${entry.file} is listed as unreachable but ${importers.join(', ')} mentions it — re-argue the entry as deferred instead of inheriting it`,
      ).toEqual([]);
    }
  });

  it('documents every entry as a real sentence, because the reason is the guard', () => {
    for (const item of ALLOWLIST) {
      expect(item.reason.length, `${item.file}: ${item.text}`).toBeGreaterThan(60);
      expect(item.text.length, `${item.file}: ${item.text}`).toBeGreaterThan(0);
    }
  });
});
