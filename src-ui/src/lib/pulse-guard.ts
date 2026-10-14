// Pulse-liveness analysis for the UI source.
//
// `animate-pulse` is this app's liveness vocabulary, and three surfaces have
// already shipped one on a value no read could end. Each of those fixes pinned its
// own row, so the class kept recurring: a new pulsing dot on a stored flag, on a
// never-probed record, or on a constant compiles and tests green.
//
// This module is the guard's analysis, kept pure so it can be pinned by unit
// contracts instead of only by its one caller. It reads source text; it never
// imports the components it describes, and it renders nothing.

export interface ModuleSources {
  /** Module path as the scan found it -> source text. */
  [modulePath: string]: string;
}

export interface PulseSite {
  file: string;
  /** The whole source line, trimmed. A claim is a line, not a token. */
  text: string;
}

export type PulseKind = 'decorative' | 'read-gated';

export interface PulseAllowlistEntry {
  file: string;
  /**
   * A distinctive fragment of the site’s line. It is matched by containment
   * rather than equality so that reformatting the line around the class does not
   * silently turn a documented site into an undocumented one — the class itself is
   * what has to stay accounted for.
   */
  text: string;
  kind: PulseKind;
  /** Why the animation cannot outlive its claim, or why it makes no claim. */
  reason: string;
}

export interface PulseAllowlistMatch {
  /** Sites no allowlist entry accounts for — the guard's actual failure. */
  undocumented: PulseSite[];
  /** Entries that match no site — a claim about an animation that moved. */
  unused: PulseAllowlistEntry[];
}

const TEST_MODULE = /\.test\.[cm]?[jt]sx?$/;
const QUERY_SUFFIX = /\?/;
// The scanner itself, and the guard's own documentation, name the class in prose
// and in the literal it searches for. Neither renders anything: this module
// exports two pure functions and no JSX, so exempting it cannot hide an animation.
const GUARD_MODULE = /lib\/pulse-guard\.ts$/;
// A claim lives in code. A line that is entirely a comment describes a claim
// somewhere else and renders nothing, so it is not scanned — otherwise this
// module's own header would be an undocumented animation.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

function isScannable(file: string): boolean {
  return !TEST_MODULE.test(file) && !QUERY_SUFFIX.test(file) && !GUARD_MODULE.test(file);
}

/** Every `animate-pulse` in the scannable source, in file then line order. */
export function findPulseSites(sources: ModuleSources): PulseSite[] {
  const sites: PulseSite[] = [];
  for (const file of Object.keys(sources).sort()) {
    if (!isScannable(file)) continue;
    const lines = sources[file].split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index].trim();
      if (text.includes('animate-pulse') && !COMMENT_LINE.test(text)) sites.push({ file, text });
    }
  }
  return sites;
}

/**
 * Account for every site with the allowlist, one entry per site. Containment
 * matching means an entry claims at most one site, so a file that grows a second
 * pulsing dot on the same line shape still has to be documented twice.
 */
export function matchPulseAllowlist(
  sites: PulseSite[],
  allowlist: PulseAllowlistEntry[],
): PulseAllowlistMatch {
  const claimed = new Set<number>();
  const unused: PulseAllowlistEntry[] = [];
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
