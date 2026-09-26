// Raw-error analysis for the UI source.
//
// A Native rejection string is whatever the failing layer chose to say, and the
// reads that stringify one into a surface are the reads that touch the operator's
// own store: paired device names, registered hook payloads, node records, skill
// lists, the `.mcp.json` map. The repo already states the hazard in its own
// comments — "Native errors may embed store or session detail", "Native errors
// may embed configuration values" — and five sibling surfaces already withhold
// the reason behind one locally-authored sentence. Six more did not, so the class
// was fixed surface by surface with nothing enforcing it.
//
// This module is the guard's analysis, kept pure so it can be pinned by unit
// contracts instead of only by its one caller. It reads source text; it never
// imports the components it describes, and it renders nothing.

export interface ModuleSources {
  /** Module path as the scan found it -> source text. */
  [modulePath: string]: string;
}

export interface ReadErrorSite {
  file: string;
  /** The whole source line, trimmed. A claim is a line, not a token. */
  text: string;
}

/**
 * What a listed site does with the value it stringifies.
 *
 * - `withheld` — the value never reaches a rendered error surface. It is logged,
 *   or it only decides control flow. There is nothing to fix here.
 * - `unreachable` — the module is imported by nothing but its own test, so the
 *   value reaches no operator at all until the module is retired.
 * - `deferred` — the value DOES still reach a surface. The entry names the
 *   Ready row that owns the fix. This is a debt, not a permission: the allowlist
 *   is closed, a new site is always undocumented, and an entry whose site was
 *   fixed becomes an unused entry, which fails the guard.
 */
export type ReadErrorVerdict = 'withheld' | 'unreachable' | 'deferred';

export interface ReadErrorEntry {
  file: string;
  /**
   * A distinctive fragment of the site’s line. Matched by containment rather than
   * equality so reformatting the line around the class does not silently turn a
   * documented site into an undocumented one — the class is what must stay
   * accounted for.
   */
  text: string;
  verdict: ReadErrorVerdict;
  /** Why the value is safe where it is, or which row still owns the leak. */
  reason: string;
}

export interface ReadErrorMatch {
  /** Sites no entry accounts for — the guard's actual failure. */
  undocumented: ReadErrorSite[];
  /** Entries that match no site — a claim about a leak that moved or was fixed. */
  unused: ReadErrorEntry[];
}

const TEST_MODULE = /\.test\.[cm]?[jt]sx?$/;
const QUERY_SUFFIX = /\?/;
// Only modules are scanned. The tree's glob is already `*.{ts,tsx}`, but a
// scanner that scans whatever it is handed will one day be handed a note or a
// fixture, and a prose mention of the idiom is not a leak.
const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
// The scanner itself, and the guard's own documentation, name the class in prose
// and in the literals it searches for. Neither renders anything: this module
// exports pure functions and no JSX, so exempting it cannot hide a leak.
const GUARD_MODULE = /lib\/read-error-guard\.ts$/;
// A claim lives in code. A line that is entirely a comment describes a claim
// somewhere else and renders nothing, so it is not scanned — otherwise this
// module's own header would be an undocumented site.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/** The caught value being turned into a string. */
const STRINGIFIED_CAUGHT_VALUE =
  /String\(\s*(e|err|error|cause)\s*\)|\b(e|err|error|cause)\??\.message\b/;

function isScannable(file: string): boolean {
  return MODULE_EXTENSION.test(file)
    && !TEST_MODULE.test(file)
    && !QUERY_SUFFIX.test(file)
    && !GUARD_MODULE.test(file);
}

/**
 * Every line that stringifies a caught value, in file then line order. The scan
 * is deliberately wider than "reaches a rendered surface": over-capturing makes
 * the allowlist the place where a wide-but-safe use is stated, and a narrower
 * scan would let a new leak through by choosing a shape the pattern missed.
 */
export function findReadErrorSites(sources: ModuleSources): ReadErrorSite[] {
  const sites: ReadErrorSite[] = [];
  for (const file of Object.keys(sources).sort()) {
    if (!isScannable(file)) continue;
    const lines = sources[file].split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index].trim();
      if (STRINGIFIED_CAUGHT_VALUE.test(text) && !COMMENT_LINE.test(text)) sites.push({ file, text });
    }
  }
  return sites;
}

/**
 * Account for every site with the allowlist, one entry per site. Containment
 * matching means an entry claims at most one site, so a file that grows a second
 * stringified rejection on the same line shape still has to be documented twice.
 */
export function matchReadErrorAllowlist(
  sites: ReadErrorSite[],
  entries: ReadErrorEntry[],
): ReadErrorMatch {
  const claimed = new Set<number>();
  const unused: ReadErrorEntry[] = [];
  for (const entry of entries) {
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
