// Section-count guard — the analysis, kept pure so it can be pinned by unit
// contracts instead of only by its one rule caller.
//
// `SectionHeader` prints its count inside the heading as the view's own name
// (`Devices(0)`) whenever `typeof count === 'number'`, and it renders whatever
// its `action` slot holds beside that name. Both halves are the same claim about
// the same read. That makes a count a *headline claim about a read*, not a
// decoration: whatever the expression happens to be while a read is in flight or
// has just failed is what the operator reads as the size of the world. Nine
// mounted surfaces passed `count={list.length}` from a list that starts `[]`, so
// both an unanswered read and a failed one printed a confident `0` — the reading
// that most strongly says "there is nothing here", produced by a read that
// returned nothing. Routing those thirteen counts through the one shared tally
// left the slot beside them untouched, so `0 enabled`, `0 connected` and
// `0 delivery verified` were printed by the same failed reads.
//
// So the scan claims two slots: the `count` prop, and a numbered `Pill` inside
// an `action={…}` region. A claim is read as the element that carries the
// number — the line for a count, the whole pill for a slot — because a pill's
// children can be reformatted onto lines of their own and that must not silently
// un-claim it.
//
// This module finds those sites by reading source text, exactly as
// `lib/pulse-guard.ts` does for `animate-pulse`: the rule spans files, and
// rendering the app to test it needs Tauri IPC mocks. It imports no component
// and renders nothing.

export interface ModuleSources {
  /** Module path as the scan found it -> source text. */
  [modulePath: string]: string;
}

/** Which half of a header a claim was found in. */
export type HeaderClaimSlot = 'count' | 'action';

export interface SectionCountSite {
  file: string;
  /** 1-based line the claim starts on, so a failure can point at it. */
  line: number;
  /** The claim itself, whitespace-normalised: a count is a line, a pill is an element. */
  text: string;
  slot: HeaderClaimSlot;
}

/**
 * Why a claim may be stated. The kind is the claim, and each kind carries a
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
// The slot a header states the rest of its claim in. Any component with an
// `action` slot counts: a claim in one is a claim in the same sentence as a
// count, whether or not the owner is a `SectionHeader`.
const ACTION_SLOT = /action=\{/;
const PILL_OPEN = /<Pill\b/;
// A claim lives in code. A line that is entirely a comment describes a claim
// somewhere else and renders nothing.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
// A number in a pill's children: a value with no call, no branch and no string
// in it, followed by the unit word the copy reads with — `{enabled} enabled`,
// `{connectedCount} connected`. A status word, a self-closing chip and a row's
// own `{receipt.status}` are all things this does not match.
const PILL_TALLY = /\{[A-Za-z_$][\w$]*(?:[.?][\w$]+|\[[^\]]*\])*\}[ \t]+[a-z]/;

function isScannable(file: string): boolean {
  return !TEST_MODULE.test(file) && !QUERY_SUFFIX.test(file) && !GUARD_MODULE.test(file);
}

/** The 0-based line of every character offset in `text`, for naming a site. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '\n') starts.push(at + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** A claim reads the same however it is laid out, so it is reported normalised. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The offset just past a quoted string, a template, or a comment opened at `at`. */
function pastQuoted(text: string, at: number, char: string): number {
  if (char === '/') {
    const close = text.indexOf('*/', at + 2);
    if (close === -1) return text.length;
    return close + 2;
  }
  if (char === '`') {
    // A template's `${…}` is walked as code, so its braces balance themselves.
    for (let cursor = at + 1; cursor < text.length; ) {
      if (text[cursor] === '\\') { cursor += 2; continue; }
      if (text[cursor] === '`') return cursor + 1;
      if (text[cursor] === '$' && text[cursor + 1] === '{') {
        cursor = pastBraces(text, cursor + 1);
        continue;
      }
      cursor += 1;
    }
    return text.length;
  }
  for (let cursor = at + 1; cursor < text.length; ) {
    if (text[cursor] === '\\') { cursor += 2; continue; }
    if (text[cursor] === char) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}

/** The offset just past the expression brace opened at `at`. */
function pastBraces(text: string, at: number): number {
  let depth = 0;
  for (let cursor = at; cursor < text.length; ) {
    const char = text[cursor];
    if (char === '"' || char === "'" || char === '`' || (char === '/' && text[cursor + 1] === '*')) {
      cursor = pastQuoted(text, cursor, char);
      continue;
    }
    if (char === '/' && text[cursor + 1] === '/') {
      const end = text.indexOf('\n', cursor);
      if (end === -1) return text.length;
      cursor = end + 1;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

/**
 * Where a `Pill`'s children begin, or -1 for a self-closing one. Attribute
 * expressions are walked through rather than cut at, so
 * `variant={n > 0 ? 'a' : 'b'}` does not end the open tag early.
 */
function childrenAt(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; ) {
    const char = text[at];
    if (char === '"' || char === "'" || char === '`') { at = pastQuoted(text, at, char); continue; }
    if (char === '{') { depth += 1; at += 1; continue; }
    if (char === '}') { depth -= 1; at += 1; continue; }
    if (depth > 0) { at += 1; continue; }
    if (char === '/' && text[at + 1] === '>') return -1;
    if (char === '>') return at;
    at += 1;
  }
  return -1;
}

/** The numbered `Pill`s inside an `action={…}` region of one source file. */
function findActionSlotClaims(file: string, text: string, starts: readonly number[]): SectionCountSite[] {
  const sites: SectionCountSite[] = [];
  const whole = text.split('\n');
  for (let index = 0; index < whole.length; index += 1) {
    const line = whole[index].trim();
    if (!ACTION_SLOT.test(line) || COMMENT_LINE.test(line)) continue;
    const at = starts[index] + whole[index].indexOf('{');
    const limit = pastBraces(text, at);
    for (const match of text.slice(at, limit).matchAll(new RegExp(PILL_OPEN, 'g'))) {
      const open = at + (match.index ?? 0);
      const children = childrenAt(text, open + match[0].length);
      if (children === -1) continue; // a self-closing chip states no number
      const close = text.indexOf('</Pill>', children);
      const claim = normalise(text.slice(open, close === -1 ? limit : close + '</Pill>'.length));
      // The claim is the whole element, so children written on their own line
      // are part of it; only what follows the open tag is tested, because an
      // attribute is not a claim.
      if (PILL_TALLY.test(text.slice(children, close === -1 ? limit : close))) {
        sites.push({ file, line: lineOf(starts, open) + 1, text: claim, slot: 'action' });
      }
    }
  }
  return sites;
}

/** Every `count={`, and every numbered pill in an `action` slot, in line order. */
export function findCountSites(sources: ModuleSources): SectionCountSite[] {
  const sites: SectionCountSite[] = [];
  for (const file of Object.keys(sources).sort()) {
    if (!isScannable(file)) continue;
    const text = sources[file];
    const starts = lineStarts(text);
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (COUNT_PROP.test(line) && !COMMENT_LINE.test(line)) {
        sites.push({ file, line: index + 1, text: line, slot: 'count' });
      }
    }
    sites.push(...findActionSlotClaims(file, text, starts));
  }
  return sites.sort((left, right) =>
    left.file === right.file ? left.line - right.line : left.file.localeCompare(right.file));
}

/**
 * The calls that route a claim through the one shared tally
 * (`lib/list-tally.ts`). A `confirmed-read` entry is checked against this, so
 * the kind cannot be claimed for an expression that never consults the read.
 * `tallyNumber` states a pill's number from the same tally as the count beside
 * it, and `tallyTone` is the tone threshold those pills already used.
 */
export const SHARED_TALLY_CALLS = [
  'sectionCount(',
  'countProp(',
  'projectListTally(',
  'tallyNumber(',
  'tallyTone(',
] as const;

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
