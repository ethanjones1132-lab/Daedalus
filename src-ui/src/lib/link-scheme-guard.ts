// Link-scheme guard.
//
// A link destination in this app is author-supplied — model output in a
// transcript, a skill body off disk, a page the agent was asked to read — so the
// scheme decides whether the app hands the address to the operating system. Two
// renderers already disagreed about it: the hand-rolled one passed capture group 1
// straight into `href`, and the react-markdown one was safe only because of a
// library default it never states on screen.
//
// So this is the rule, as a ratchet: every `href={` in the UI source is either
// routed through the one shared decision or the guard fails. A new link cannot
// ship until someone writes down which decision made it safe.
//
// It reads source as text rather than rendering anything: the rule spans files,
// and rendering the app needs Tauri IPC mocks. No Rust toolchain, no Tauri.

export interface ModuleSources {
  /** Module path as the scan found it -> source text. */
  [modulePath: string]: string;
}

export interface HrefSite {
  file: string;
  /** 1-based line the `href={` was found on. */
  line: number;
  /** The whole source line, trimmed. A claim is a line, not a token. */
  text: string;
  /** The attribute's value expression, braces and quotes included. */
  value: string;
}

export type HrefKind = 'shared-decision';

export interface HrefAllowlistEntry {
  file: string;
  /**
   * A distinctive fragment of the site's line, matched by containment rather than
   * equality so reformatting the element around the attribute does not silently
   * turn a documented site into an undocumented one.
   */
  text: string;
  kind: HrefKind;
  /** Why the value cannot carry an address the app did not agree to open. */
  reason: string;
}

export interface HrefAllowlistMatch {
  /** Sites no entry accounts for — the guard's actual failure. */
  undocumented: HrefSite[];
  /** Entries that match no site — a claim about a link that moved. */
  unused: HrefAllowlistEntry[];
  /** Entries whose claim is documented but does not resolve to the decision. */
  unrouted: HrefAllowlistEntry[];
}

/**
 * The calls that make a value routed. An allowlist entry is only a *claim* that a
 * site went through the decision; this list is what makes it a *fact*, checked
 * against the site's own value (or the declaration that value came from).
 */
export const SHARED_DECISION_CALLS = ['projectLink('] as const;

const TEST_MODULE = /\.test\.[cm]?[jt]sx?$/;
const QUERY_SUFFIX = /\?/;
// The scanner and its own documentation name the class in prose and in the literal
// it searches for. Neither renders anything: this module exports pure functions
// and no JSX, so exempting it cannot hide a link.
const GUARD_MODULE = /lib\/link-scheme-guard\.ts$/;
// A claim lives in code. A comment-only line describes a claim elsewhere.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const HREF_OPEN = 'href={';
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isScannable(file: string): boolean {
  return !TEST_MODULE.test(file) && !QUERY_SUFFIX.test(file) && !GUARD_MODULE.test(file);
}

/**
 * Read the value expression that follows `href={` starting at `from`, tracking
 * brace depth and string literals so a `}` inside a quoted attribute value does
 * not end the expression early. Returns null when the braces never balance, which
 * reports the site as unrouted rather than dropping it.
 */
function readValueExpression(text: string, from: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, index + 1);
    }
  }
  return null;
}

/** Every `href={` in the scannable source, in file then line order. */
export function findHrefSites(sources: ModuleSources): HrefSite[] {
  const sites: HrefSite[] = [];
  for (const file of Object.keys(sources).sort()) {
    if (!isScannable(file)) continue;
    const source = sources[file];
    const lines = source.split('\n');
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const text = line.trim();
      const at = line.indexOf(HREF_OPEN);
      if (at !== -1 && !COMMENT_LINE.test(text)) {
        // The expression may run past the end of its line, so it is read from the
        // source rather than from the line.
        const value = readValueExpression(source, offset + at + HREF_OPEN.length - 1);
        sites.push({ file, line: index + 1, text, value: value ?? '' });
      }
      offset += line.length + 1;
    }
  }
  return sites;
}

/**
 * The expression a value actually came from: the site's own value, or — when the
 * value is a plain identifier or a member read on one — the declaration that
 * identifier was bound to. `href={link.href}` is therefore checked against
 * `const link = projectLink(…)`, which is the shape both renderers need in order
 * to decide what to render.
 */
export function hrefValueSource(site: HrefSite, sources: ModuleSources): string {
  const bare = site.value.replace(/^\{|\}$/g, '').trim();
  const base = bare.split(/[.?!:[(]/)[0];
  if (!IDENTIFIER.test(base)) return bare;
  const source = sources[site.file] ?? '';
  const declaration = new RegExp(`(?:const|let|var)\\s+${base}\\s*=\\s*([^\\n]*)`, 'g');
  let found: string | null = null;
  let match = declaration.exec(source);
  while (match) {
    found = match[1];
    match = declaration.exec(source);
  }
  return found ?? bare;
}

/** Whether a site's value — or the declaration it came from — is the decision. */
export function isRoutedThroughDecision(site: HrefSite, sources: ModuleSources): boolean {
  const expression = hrefValueSource(site, sources);
  return SHARED_DECISION_CALLS.some((call) => expression.includes(call));
}

/**
 * Account for every site with the allowlist, one entry per site, and check that
 * each claim is routed. Containment matching means an entry claims at most one
 * site, so a file that grows a second link on the same shape is documented twice.
 */
export function matchHrefAllowlist(
  sites: HrefSite[],
  allowlist: HrefAllowlistEntry[],
  sources: ModuleSources,
): HrefAllowlistMatch {
  const claimed = new Set<number>();
  const unused: HrefAllowlistEntry[] = [];
  const unrouted: HrefAllowlistEntry[] = [];
  for (const entry of allowlist) {
    const at = sites.findIndex(
      (site, index) =>
        !claimed.has(index) && site.file === entry.file && site.text.includes(entry.text),
    );
    if (at === -1) {
      unused.push(entry);
      continue;
    }
    claimed.add(at);
    if (entry.kind === 'shared-decision' && !isRoutedThroughDecision(sites[at], sources)) {
      unrouted.push(entry);
    }
  }
  return {
    undocumented: sites.filter((_site, index) => !claimed.has(index)),
    unused,
    unrouted,
  };
}
