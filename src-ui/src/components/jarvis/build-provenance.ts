/**
 * Build provenance — the pure verdict, view, and shared observation behind
 * the running binary's `BuildBadge`.
 *
 * `get_build_info` reports an unavailable source tree as *not stale*
 * (`src-tauri/src/commands/system.rs:322-350`: `None` → `stale: false`), so an
 * installed binary with no source on the machine, a machine without `git`, and a
 * binary that was built from a modified working tree all read as a clean,
 * confirmed build. "Not checked" is not "checked and current", so the verdict
 * here has three states and only one of them is a confirmation:
 *
 *   - `clean`         — the source tree on this machine matches the commit the
 *                       binary embeds, and that build was not dirty.
 *   - `stale`         — the source tree has advanced past the embedded commit.
 *   - `unverifiable`  — provenance could not be checked: no source tree, no
 *                       recorded commit, a dirty build, or a failed read.
 *
 * Native stays the only process that touches Git; nothing here exposes a
 * filesystem path, a diff, or a command line. Git/process access and the
 * embedded provenance itself are unchanged.
 */
import type { BuildInfo } from './types';

// Re-exported so a surface that observes provenance needs one import.
export type { BuildInfo };

export type BuildProvenanceState = 'clean' | 'stale' | 'unverifiable';

export type BuildProvenanceReason =
  /** The source tree's HEAD equals the embedded commit and the build was clean. */
  | 'source_matches'
  /** The source tree has advanced past the embedded commit. */
  | 'source_advanced'
  /** The build recorded a dirty working tree, so the commit is not the binary. */
  | 'built_dirty'
  /** No source tree on this machine, or Git could not be read. */
  | 'source_unavailable'
  /** The build never recorded which source commit it came from. */
  | 'provenance_missing'
  /** The check itself could not be completed. */
  | 'read_failed'
  /** Nothing has been observed yet. */
  | 'unreadable_response';

export type BuildProvenanceVerdict =
  | { state: 'clean'; reason: 'source_matches' }
  | { state: 'stale'; reason: 'source_advanced'; sourceSha: string | null }
  | {
      state: 'unverifiable';
      reason: Exclude<BuildProvenanceReason, 'source_matches' | 'source_advanced'>;
    };

/** The commit recorded by `build.rs` when Git was unavailable at build time. */
const UNKNOWN_SHA = 'unknown';

function isShortSha(value: string): boolean {
  return value.length > 0 && value !== UNKNOWN_SHA;
}

/**
 * Decode one `get_build_info` response. Returns `null` for anything that is
 * not a complete provenance record, so a schema drift can never be read as a
 * confirmed clean build. `source_sha` is optional (`None` serialises to
 * `null`/absent) and `git_short` is derived from the full sha when absent, so
 * an older binary that omitted it still shows provenance.
 */
export function decodeBuildInfo(value: unknown): BuildInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const { version, git_sha: gitSha, dirty, build_time: buildTime, source_sha: sourceSha } = row;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof gitSha !== 'string') return null;
  if (typeof dirty !== 'boolean') return null;
  if (typeof buildTime !== 'string') return null;
  if (typeof row.stale !== 'boolean') return null;
  if (sourceSha !== null && sourceSha !== undefined && typeof sourceSha !== 'string') return null;
  const sha = gitSha;
  const short = typeof row.git_short === 'string' && row.git_short.length > 0
    ? row.git_short
    : sha.slice(0, 9);
  return {
    version,
    git_sha: sha,
    git_short: short,
    dirty,
    build_time: buildTime,
    source_sha: typeof sourceSha === 'string' ? sourceSha : null,
    stale: row.stale,
  };
}

export interface BuildProvenanceInput {
  /** The last successfully decoded observation, if any. */
  info: BuildInfo | null;
  /** The most recent check failed or came back undecodable. */
  readFailed: boolean;
}

/**
 * Decide the one verdict for the badge. A failure to check outranks a stale
 * answer (a stale binary is still stale, and a failed check on top of it is
 * still a failed check), and `stale` outranks every unverifiable signal because
 * it is the actionable one.
 */
export function decideBuildProvenance(input: BuildProvenanceInput): BuildProvenanceVerdict {
  if (input.readFailed) return { state: 'unverifiable', reason: 'read_failed' };
  const info = input.info;
  if (!info) return { state: 'unverifiable', reason: 'unreadable_response' };
  if (!isShortSha(info.git_sha)) return { state: 'unverifiable', reason: 'provenance_missing' };
  if (info.stale || (info.source_sha !== null && info.source_sha !== info.git_sha)) {
    return { state: 'stale', reason: 'source_advanced', sourceSha: info.source_sha };
  }
  if (info.source_sha === null) return { state: 'unverifiable', reason: 'source_unavailable' };
  if (info.dirty) return { state: 'unverifiable', reason: 'built_dirty' };
  return { state: 'clean', reason: 'source_matches' };
}

// ── Presentation ───────────────────────────────────────────────

export const BUILD_CHECKING_TEXT = 'Checking build provenance…';
export const BUILD_RECHECKING_TEXT = 'Rechecking build provenance…';
export const BUILD_MATCHES_SENTENCE = (short: string) =>
  `Build provenance confirmed: this binary matches source ${short}.`;
export const BUILD_STALE_SENTENCE = (short: string, sourceShort: string) =>
  `Build provenance stale: this binary was built from ${short}, source is now ${sourceShort}. Rebuild to match.`;
export const BUILD_DIRTY_SENTENCE = (short: string) =>
  `Build provenance unverifiable: this binary was built from a modified working tree at ${short}, so that commit does not describe what is running.`;
export const BUILD_NO_SOURCE_SENTENCE = (short: string) =>
  `Build provenance unverifiable: this binary was built from ${short} but the source tree is not available to check.`;
export const BUILD_NO_PROVENANCE_SENTENCE =
  'Build provenance unverifiable: this binary does not record which source commit it was built from.';
export const BUILD_READ_FAILED_SENTENCE = 'Build provenance unverifiable: the build check could not be completed.';

const UNVERIFIABLE_DETAIL: Record<
  Extract<BuildProvenanceReason, 'source_unavailable' | 'provenance_missing' | 'built_dirty' | 'read_failed' | 'unreadable_response'>,
  string
> = {
  source_unavailable: 'the source tree is not available to check',
  provenance_missing: 'the build records no source commit',
  built_dirty: 'the build came from a modified working tree',
  read_failed: 'the build check could not be completed',
  unreadable_response: 'no build provenance has been read yet',
};

export interface BuildProvenanceView {
  state: BuildProvenanceState;
  reason: BuildProvenanceReason;
  /** `v<version>` while a record is held, `v…` before anything is read. */
  versionLabel: string;
  /** `·<short sha>` with the dirty-build marker, or '' when there is no sha. */
  shaLabel: string;
  /** Visible state word. Empty for a confirmed match and while checking. */
  marker: string;
  /** Tailwind class for the marker. Colour is decoration; `marker` is the text. */
  markerClass: string;
  /** The one full sentence an assistive technology reads. */
  sentence: string;
  /** Hover detail: embedded version, full sha, build time, and the state. */
  title: string;
  /** True only when a check found the source tree matching the embedded commit. */
  confirmed: boolean;
  checking: boolean;
}

export interface BuildProvenanceViewInput {
  info: BuildInfo | null;
  checking: boolean;
  readFailed: boolean;
}

function shortOf(sha: string | null | undefined): string {
  if (typeof sha !== 'string') return '?';
  return isShortSha(sha) ? sha.slice(0, 9) : UNKNOWN_SHA;
}

/** Project the badge's one observation onto the three states, in text. */
export function buildProvenanceView(input: BuildProvenanceViewInput): BuildProvenanceView {
  const { info, checking, readFailed } = input;
  const verdict = decideBuildProvenance({ info, readFailed });
  const short = info ? shortOf(info.git_sha) : '';
  const versionLabel = info ? `v${info.version}` : 'v…';
  const shaLabel = info && isShortSha(info.git_sha)
    ? `·${info.git_short || shortOf(info.git_sha)}${info.dirty ? '*' : ''}`
    : '';

  let sentence: string;
  if (verdict.state === 'clean') sentence = BUILD_MATCHES_SENTENCE(short);
  else if (verdict.state === 'stale') sentence = BUILD_STALE_SENTENCE(short, shortOf(verdict.sourceSha));
  else if (verdict.reason === 'built_dirty') sentence = BUILD_DIRTY_SENTENCE(short);
  else if (verdict.reason === 'source_unavailable') sentence = BUILD_NO_SOURCE_SENTENCE(short);
  else if (verdict.reason === 'provenance_missing') sentence = BUILD_NO_PROVENANCE_SENTENCE;
  else sentence = BUILD_READ_FAILED_SENTENCE;
  if (checking) sentence = info ? BUILD_RECHECKING_TEXT : BUILD_CHECKING_TEXT;

  const titleLines = info
    ? [
        `version ${info.version}`,
        isShortSha(info.git_sha) ? `commit ${info.git_sha}` : 'commit not recorded',
        info.dirty && 'built from a dirty working tree',
        info.build_time && `built ${info.build_time}`,
      ]
    : [];
  if (verdict.state === 'stale') {
    titleLines.push(
      `STALE — source is now ${shortOf(verdict.sourceSha)}; rebuild to match`,
    );
  } else if (verdict.state === 'unverifiable') {
    titleLines.push(`UNVERIFIABLE — ${UNVERIFIABLE_DETAIL[verdict.reason]}`);
  }

  return {
    state: verdict.state,
    reason: verdict.reason,
    versionLabel,
    shaLabel,
    marker: verdict.state === 'clean' ? '' : verdict.state === 'stale' ? '⚠ stale' : '? unverifiable',
    markerClass: verdict.state === 'stale' ? 'text-amber-400' : 'text-amber-400/80',
    sentence,
    title: titleLines.filter(Boolean).join('\n'),
    confirmed: verdict.state === 'clean',
    checking,
  };
}

// ── Shared observation ─────────────────────────────────────────

export interface BuildProvenanceSnapshot {
  info: BuildInfo | null;
  checking: boolean;
  readFailed: boolean;
  verdict: BuildProvenanceVerdict;
}

export interface BuildProvenanceStore {
  subscribe(listener: () => void): () => void;
  /** Stable reference between changes, as `useSyncExternalStore` requires. */
  getSnapshot(): BuildProvenanceSnapshot;
  /** Re-check provenance. Concurrent callers share the one in-flight read. */
  refresh(): void;
}

const EMPTY_SNAPSHOT: BuildProvenanceSnapshot = {
  info: null,
  checking: false,
  readFailed: false,
  verdict: decideBuildProvenance({ info: null, readFailed: false }),
};

/**
 * One provenance observation shared by every mounted badge. The badge is
 * mounted twice (sidebar footer and header), and each mount used to read
 * `get_build_info` once for itself and never again, so a source tree that moved
 * after boot stayed clean for the life of the process. Concurrent subscribers —
 * and a recheck requested while a read is still in flight — share one request.
 * A failed or undecodable check keeps the last good record readable and marks it
 * unverifiable rather than clearing it.
 */
export function createBuildProvenanceStore(read: () => Promise<unknown>): BuildProvenanceStore {
  let snapshot: BuildProvenanceSnapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;

  const publish = (next: Partial<Omit<BuildProvenanceSnapshot, 'verdict'>>) => {
    const info = 'info' in next ? next.info ?? null : snapshot.info;
    const checking = next.checking ?? snapshot.checking;
    const readFailed = next.readFailed ?? snapshot.readFailed;
    if (info === snapshot.info && checking === snapshot.checking && readFailed === snapshot.readFailed) {
      return;
    }
    snapshot = { info, checking, readFailed, verdict: decideBuildProvenance({ info, readFailed }) };
    for (const listener of listeners) listener();
  };

  const refresh = (): void => {
    if (inFlight) return;
    publish({ checking: true });
    const request: Promise<void> = read().then(
      value => {
        const info = decodeBuildInfo(value);
        publish(info ? { info, readFailed: false } : { readFailed: true });
      },
      () => { publish({ readFailed: true }); },
    ).then(() => {
      if (inFlight === request) {
        inFlight = null;
        publish({ checking: false });
      }
    });
    inFlight = request;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      // The first surface to subscribe starts the check; later ones join it.
      if (listeners.size === 1) refresh();
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    refresh,
  };
}

const sharedStores = new Map<() => Promise<unknown>, BuildProvenanceStore>();

/** The one store for a given native read, so every badge observes together. */
export function sharedBuildProvenanceStore(read: () => Promise<unknown>): BuildProvenanceStore {
  const existing = sharedStores.get(read);
  if (existing) return existing;
  const store = createBuildProvenanceStore(read);
  sharedStores.set(read, store);
  return store;
}

/** Drop every shared store. Tests use this to isolate one observation. */
export function resetSharedBuildProvenanceStores(): void {
  sharedStores.clear();
}

/** Re-check provenance whenever the window regains focus. Returns a disposer. */
export function bindFocusRecheck(
  target: EventTarget,
  recheck: () => void,
): () => void {
  const handler = () => recheck();
  target.addEventListener('focus', handler);
  return () => target.removeEventListener('focus', handler);
}
