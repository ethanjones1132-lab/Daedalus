// Raw-error guard: the rule, as a ratchet.
//
// The fixed-message rule is established in five sibling surfaces and was violated
// in thirteen places across eight files. That is the same shape as the pulse class:
// a rule stated in a row's Acceptance, fixed one surface at a time, and enforced by
// nothing — so a new surface can ship a raw Native rejection and the suite stays
// green. `read-error-guard.test.tsx` fixed the read paths the first row named and
// `ReadErrorDebt.test.tsx` fixed the ten writes and reads this row named; this file
// is the part that keeps them fixed.
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
//   shrink but never grow quietly. That set is now EMPTY: every leak this guard
//   named has been fixed, and the next one starts from nothing;
// - `authored` is the one place a value still reaches a surface on purpose. It is
//   not a re-opened leak and it is not a renamed `deferred`: the entry must name
//   the classifier that carries the actionable meaning and the guard proves the
//   file routes the printed text through it, so "the server's own claim" is a
//   checked mechanism rather than an assertion in prose;
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

const ALLOWLIST: ReadErrorEntry[] = [
  {
    file: './components/jarvis/JarvisView.tsx',
    text: 'String(e instanceof Error ? e.message : e)',
    verdict: 'authored',
    reason:
      'A chat turn that ends with a stable code is the Conductor’s own claim about the turn: the terminal SSE frame carries both a code and text explaining that code, so the text is authored product copy rather than a failing layer’s diagnostics, and it is the operator’s only diagnosis of why the turn stopped. It prints beside the code’s `errorDisplayForCode` label and actionable hint, and the check below proves this file routes the text through that classifier. A turn that fails with no code is a transport failure and prints `TURN_FAILED_COPY` instead, so no `authored` entry covers a `TypeError`, an HTTP body or a watchdog.',
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

/**
 * The debt this guard exists to shrink, written out rather than derived from the
 * table above. Derived, it would be a tautology: deleting a row from `ALLOWLIST`
 * would satisfy it. Written out, growing the debt is a deliberate edit to this
 * list — which is the point.
 */
const EXPECTED_DEFERRED: string[] = [];

describe('raw-error guard', () => {
  it('still scans the whole tree, so the allowlist below cannot pass vacuously', () => {
    const sites = findReadErrorSites(sources);
    expect(sites.length).toBeGreaterThan(0);
    // The anchors are sites that are still listed, so the scan cannot pass by
    // having stopped seeing the class it is meant to police. They are the two
    // unreachable modules rather than a fixed one: an anchor on a site this
    // project fixes is an anchor that fails on success.
    expect(
      sites.some((site) => site.file === './components/jarvis/SystemHealthView.tsx' && site.text.includes('setError(String(e))')),
      'the scan should still find a read-path stringification the allowlist lists — if it cannot, the scan stopped seeing the class',
    ).toBe(true);
    expect(
      sites.some((site) => site.file === './hooks/useResourceList.ts'),
      'the scan should still reach the hooks directory',
    ).toBe(true);
  });

  it('no longer finds a stringified rejection on the four surfaces this guard listed as debt', () => {
    // The other half of the non-vacuity pair: an allowlist entry can be deleted by
    // editing the table, so the scan itself has to be shown to have stopped
    // reporting the fixed sites. `JarvisView.tsx` is the one file that keeps a
    // site, and it keeps exactly one — the `authored` turn-failure copy — so a new
    // leak there fails this rather than hiding behind the entry.
    const expectedResidual: Record<string, string[]> = {
      './components/jarvis/ModelProfilesView.tsx': [],
      './components/jarvis/SettingsView.tsx': [],
      './components/jarvis/SkillsView.tsx': [],
      './components/jarvis/JarvisView.tsx': ['const errorMessage = errorCode ? String(e instanceof Error ? e.message : e) : TURN_FAILED_COPY;'],
    };
    for (const [file, expected] of Object.entries(expectedResidual)) {
      expect(
        findReadErrorSites({ [file]: sources[file] }).map((site) => site.text),
        `${file} should report only the sites it still claims`,
      ).toEqual(expected);
    }
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

  it('holds the debt still: no site is listed as deferred, and none can be added quietly', () => {
    const sites = findReadErrorSites(sources);
    const { undocumented, unused } = matchReadErrorAllowlist(sites, ALLOWLIST);
    const deferred = ALLOWLIST.filter((entry) => entry.verdict === 'deferred');
    // An entry that claims a fixed site is an unused entry and fails above, so the
    // only way the list below grows is a deliberate edit to it.
    expect(undocumented).toEqual([]);
    expect(unused).toEqual([]);
    expect(deferred.map((entry) => `${entry.file}: ${entry.text}`)).toEqual(EXPECTED_DEFERRED);
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

  it('proves every authored entry is classified, so "the server’s own claim" is a mechanism', () => {
    const authored = ALLOWLIST.filter((item) => item.verdict === 'authored');
    // A guard that lets a surface print a raw string by calling it authored, with
    // nothing checked, is the leak renamed. So the claim must name a classifier and
    // the file must actually call one of the identifiers it named.
    expect(authored.length, 'an authored entry is a deliberate exception and must be listed').toBeGreaterThan(0);
    for (const entry of authored) {
      const named = [...entry.reason.matchAll(/`(\w+)`/g)].map((match) => match[1]);
      expect(
        named.length,
        `${entry.file}: ${entry.text} must name the classifier that carries the failure's meaning, in backticks`,
      ).toBeGreaterThan(0);
      const called = named.filter((name) => sources[entry.file]?.includes(`${name}(`));
      expect(
        called,
        `${entry.file} names ${named.join(', ')} as what classifies this text but calls none of it`,
      ).not.toEqual([]);
    }
  });

  it('documents every entry as a real sentence, because the reason is the guard', () => {
    for (const item of ALLOWLIST) {
      expect(item.reason.length, `${item.file}: ${item.text}`).toBeGreaterThan(60);
      expect(item.text.length, `${item.file}: ${item.text}`).toBeGreaterThan(0);
    }
  });
});
