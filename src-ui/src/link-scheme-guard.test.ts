// Link-scheme guard.
//
// A link destination in this app is author-supplied: model output in a
// transcript, a skill body off disk, a page the agent was asked to read. Two
// renderers disagreed about it — the hand-rolled one passed its capture group
// straight into `href`, and the react-markdown one was safe only because of a
// library default (`defaultUrlTransform`'s `https?|ircs?|mailto|xmpp` allowlist,
// which answers a refused scheme with `''` and lets `<a href="">` reach the DOM
// looking exactly like a working link).
//
// So this is the rule, as a ratchet: every `href={` in the UI source is either
// routed through `lib/link-scheme.ts` or the guard fails. A new link cannot ship
// until someone writes down which decision made it safe, and a decision the guard
// cannot see is an undocumented one.
//
// It reads the source as text rather than rendering anything: the rule spans
// files, and rendering the app needs Tauri IPC mocks. No Rust toolchain, no Tauri.

import { describe, expect, it } from 'vitest';
import {
  findHrefSites,
  isRoutedThroughDecision,
  matchHrefAllowlist,
  type HrefAllowlistEntry,
} from './lib/link-scheme-guard';

// Vite `?raw` glob — every non-test source module as a string, so a new file with
// a link is scanned without touching this file.
const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Every link the UI renders, with the evidence that its address went through the
 * one decision. `shared-decision` is the only kind: a value is only allowed to
 * reach `href` if `projectLink(` decided it, and the guard checks that against the
 * site's own value (or the declaration the value was bound to) rather than
 * trusting this file.
 */
const ALLOWLIST: HrefAllowlistEntry[] = [
  {
    file: './components/jarvis/MarkdownRenderer.tsx',
    text: 'href={link.href}',
    kind: 'shared-decision',
    reason:
      'The hand-rolled renderer’s `[text](address)` match. The address is author-supplied — it came out of a transcript or a skill body — and `projectLink` is called on it in the same `case` before this element exists, so a `javascript:`, `data:`, `file:` or `vbscript:` address is rendered as inert text with the refusal notice instead of as a link. `target` and `rel` are the ones it always had.',
  },
  {
    file: './components/jarvis/MarkdownView.tsx',
    text: 'href={link.href}',
    kind: 'shared-decision',
    reason:
      'The react-markdown `a` override. The component is handed the raw destination because the view’s own `urlTransform` passes `href` through untouched (every other url attribute keeps the library’s own transform), and `projectLink` is called on it immediately above, so a refused scheme cannot arrive as the library’s silent `\'\'`. Styling, `target` and `rel` are unchanged.',
  },
];

describe('link-scheme guard', () => {
  it('finds every link in the UI source, so the allowlist below cannot pass vacuously', () => {
    const sites = findHrefSites(sources);

    expect(sites.length).toBeGreaterThan(0);
    // The two renderers are the anchor: if the scan ever stopped finding them,
    // every other case in this file would be measuring nothing.
    expect(
      sites.map((site) => site.file).sort(),
      'the scan should still find exactly the two markdown renderers',
    ).toEqual(['./components/jarvis/MarkdownRenderer.tsx', './components/jarvis/MarkdownView.tsx']);
  });

  it('allows no link whose address did not go through the shared decision', () => {
    const sites = findHrefSites(sources);
    const { undocumented, unused, unrouted } = matchHrefAllowlist(sites, ALLOWLIST, sources);

    expect(
      undocumented.map((site) => `${site.file}:${site.line} ${site.text}`),
      'href sites with no documented decision behind them — route the value through `projectLink`, or add an entry above saying which decision made it safe',
    ).toEqual([]);
    expect(
      unused.map((entry) => `${entry.file}: ${entry.text}`),
      'allowlist entries that match no site — the link moved or was deleted, so the entry is now a claim about nothing',
    ).toEqual([]);
    expect(
      unrouted.map((entry) => `${entry.file}: ${entry.text}`),
      'entries that claim the shared decision but whose value never reached it',
    ).toEqual([]);
  });

  it('keeps every entry routed through the decision, checked against the site rather than the list', () => {
    const sites = findHrefSites(sources);

    for (const entry of ALLOWLIST) {
      const site = sites.find((candidate) => candidate.file === entry.file && candidate.text.includes(entry.text));
      expect(site, `${entry.file}: ${entry.text} must claim a site in the tree`).toBeDefined();
      expect(
        isRoutedThroughDecision(site!, sources),
        `${entry.file}:${site!.line} ${site!.text} must be routed through the shared decision`,
      ).toBe(true);
    }
  });

  it('documents every entry as a real sentence, because the reason is the guard', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, `${entry.file}: ${entry.text}`).toBeGreaterThan(60);
      expect(entry.kind).toBe('shared-decision');
    }
  });
});
