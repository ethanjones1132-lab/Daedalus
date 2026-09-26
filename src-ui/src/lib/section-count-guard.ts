// Section-count guard — the analysis, kept pure so it can be pinned by unit
// contracts instead of only by its one rule caller.
//
// `SectionHeader` prints its count inside the heading as the view's own name
// (`Devices(0)`) whenever `typeof count === 'number'`. That makes a count a
// *headline claim about a read*, not a decoration: whatever the expression
// happens to be while a read is in flight or has just failed is what the
// operator reads as the size of the world. Nine mounted surfaces passed
// `count={list.length}` from a list that starts `[]`, so both an unanswered read
// and a failed one printed a confident `0` — the reading that most strongly
// says "there is nothing here", produced by a read that returned nothing.
//
// This module finds those sites by reading source text, exactly as
// `lib/pulse-guard.ts` does for `animate-pulse`: the rule spans files, and
// rendering the app to test it needs Tauri IPC mocks. It imports no component
// and renders nothing.

export interface ModuleSources {
  /** Module path as the scan found it -> source text. */
  [modulePath: string]: string;
}

export interface SectionCountSite {
  file: string;
  /** The whole source line, trimmed. A claim is a line, not a token. */
  text: string;
}

/**
 * Why a count may be stated. The kind is the claim, and each kind carries a
 * contract the rule test machine-checks, so an entry cannot rot into a comment:
 *
 * - `confirmed-read` — the number comes from the shared tally, which states it
 *   only for a read that returned the rows on screen.
 * - `optional-read` — the expression is optional-chained off a value that is
 *   `null` until its read returns, so the primitive is handed `undefined` and
 *   prints nothing until then.
 * - `no-claim` — the number is not a count of a read at all, and the entry says
 *   what it is instead.
 */
export type SectionCountKind = 'confirmed-read' | 'optional-read' | 'no-claim';

export interface SectionCountAllowlistEntry {
  file: string;
  /**
   * A distinctive fragment of the site’s line, matched by containment rather
   * than equality so that reformatting the line around the prop does not
   * silently turn a documented site into an undocumented one.
   */
  text: string;
  kind: SectionCountKind;
  /** Why this count cannot outlive the read behind it, or why it makes no claim. */
  reason: string;
}

export interface SectionCountAllowlistMatch {
  /** Sites no allowlist entry accounts for — the guard's actual failure. */
  undocumented: SectionCountSite[];
  /** Entries that match no site — a claim about a count that moved. */
  unused: SectionCountAllowlistEntry[];
}

const TEST_MODULE = /\.test\.[cm]?[jt]sx?$/;
const QUERY_SUFFIX = /\?/;
// The scanner itself names the attribute in prose and in the literal it
// searches for. It exports two pure functions and no JSX, so exempting it
// cannot hide a count.
const GUARD_MODULE = /lib\/section-count-guard\.ts$/;
// The primitive's own prop is `count`, not `count={`: the declaration, the
// destructuring, the `typeof` gate and the rendered `({count})` are all a
// different claim, and none of them is a caller's number.
const COUNT_PROP = /count=\{/;
// A claim lives in code. A line that is entirely a comment describes a claim
// somewhere else and renders nothing.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

function isScannable(file: string): boolean {
  return !TEST_MODULE.test(file) && !QUERY_SUFFIX.test(file) && !GUARD_MODULE.test(file);
}

/** Every `count={` in the scannable source, in file then line order. */
export function findCountSites(sources: ModuleSources): SectionCountSite[] {
  const sites: SectionCountSite[] = [];
  for (const file of Object.keys(sources).sort()) {
    if (!isScannable(file)) continue;
    const lines = sources[file].split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index].trim();
      if (COUNT_PROP.test(text) && !COMMENT_LINE.test(text)) sites.push({ file, text });
    }
  }
  return sites;
}

/**
 * The calls that route a count through the one shared tally
 * (`lib/list-tally.ts`). A `confirmed-read` entry is checked against this, so
 * the kind cannot be claimed for an expression that never consults the read.
 */
export const SHARED_TALLY_CALLS = ['sectionCount(', 'countProp(', 'projectListTally('] as const;

/** Whether a site's expression asks the shared tally what it may state. */
export function routesThroughSharedTally(text: string): boolean {
  return SHARED_TALLY_CALLS.some((call) => text.includes(call));
}

/**
 * Whether a site's expression is optional-chained, so a value that is `null`
 * until its read returns hands the primitive `undefined` and prints nothing.
 */
export function isOptionalRead(text: string): boolean {
  return text.includes('?.');
}

/**
 * Account for every site with the allowlist, one entry per site. Containment
 * matching means an entry claims at most one site, so a file that grows a second
 * count on the same line shape still has to be documented twice.
 */
export function matchCountAllowlist(
  sites: SectionCountSite[],
  allowlist: SectionCountAllowlistEntry[],
): SectionCountAllowlistMatch {
  const claimed = new Set<number>();
  const unused: SectionCountAllowlistEntry[] = [];
  for (const entry of allowlist) {
    const at = sites.findIndex((site, index) =>
      !claimed.has(index) && site.file === entry.file && site.text.includes(entry.text));
    if (at === -1) {
      unused.push(entry);
      continue;
    }
    claimed.add(at);
  }
  return {
    undocumented: sites.filter((_site, index) => !claimed.has(index)),
    unused,
  };
}
