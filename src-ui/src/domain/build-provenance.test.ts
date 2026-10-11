// ═══════════════════════════════════════════════════════════════
// build-provenance — pure verdict, view, and shared observation
// ═══════════════════════════════════════════════════════════════
//
// `get_build_info` reports an unavailable source tree as `stale: false`
// (`src-tauri/src/commands/system.rs:322-350`), so an installed binary with no
// source on the machine read as a clean, confirmed build. These contracts pin
// the third state apart from a confirmed match, and pin that two mounted badges
// share one observation that can be deliberately re-read.

import { describe, expect, it, vi } from 'vitest';
import {
  bindFocusRecheck,
  buildProvenanceView,
  createBuildProvenanceStore,
  decideBuildProvenance,
  decodeBuildInfo,
  resetSharedBuildProvenanceStores,
  sharedBuildProvenanceStore,
  type BuildInfo,
} from './build-provenance';

function buildInfo(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: '0.6.0',
    git_sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    // Native's own `git_short`: the first nine characters of the full sha.
    git_short: 'a1b2c3d4e',
    dirty: false,
    build_time: '2026-09-25T10:00:00+00:00',
    source_sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    stale: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── Decode ─────────────────────────────────────────────────────

describe('decodeBuildInfo', () => {
  it('accepts a complete native response', () => {
    expect(decodeBuildInfo(buildInfo())).toEqual(buildInfo());
  });

  it('treats a missing source_sha as an absent source tree', () => {
    const { source_sha: _dropped, ...rest } = buildInfo();
    expect(decodeBuildInfo(rest)?.source_sha).toBeNull();
  });

  it('derives the short sha when native omits git_short', () => {
    const { git_short: _dropped, ...rest } = buildInfo();
    expect(decodeBuildInfo(rest)?.git_short).toBe('a1b2c3d4e');
  });

  it.each([
    ['a non-object root', 'nope'],
    ['a null root', null],
    ['an array root', []],
    ['a missing version', { ...buildInfo(), version: undefined }],
    ['an empty version', { ...buildInfo(), version: '' }],
    ['a missing git_sha', { ...buildInfo(), git_sha: undefined }],
    ['a non-boolean dirty', { ...buildInfo(), dirty: 'true' }],
    ['a non-boolean stale', { ...buildInfo(), stale: 0 }],
    ['a missing build_time', { ...buildInfo(), build_time: undefined }],
    ['a non-string source_sha', { ...buildInfo(), source_sha: 42 }],
  ])('rejects %s instead of reading it as provenance', (_label, value) => {
    expect(decodeBuildInfo(value)).toBeNull();
  });
});

// ── Verdict ────────────────────────────────────────────────────

describe('decideBuildProvenance', () => {
  it('confirms a clean build whose source tree matches', () => {
    expect(decideBuildProvenance({ info: buildInfo(), readFailed: false })).toEqual({
      state: 'clean',
      reason: 'source_matches',
    });
  });

  it('confirms a match only when the source tree is present and equal', () => {
    // Native answers `stale: false` for both of these; neither is a match.
    expect(decideBuildProvenance({ info: buildInfo({ source_sha: null }), readFailed: false }).state)
      .toBe('unverifiable');
    expect(decideBuildProvenance({ info: buildInfo({ dirty: true }), readFailed: false }).state)
      .toBe('unverifiable');
  });

  it('marks a source tree that advanced past the embedded sha as stale', () => {
    expect(
      decideBuildProvenance({
        info: buildInfo({ source_sha: 'f'.repeat(40) }),
        readFailed: false,
      }),
    ).toEqual({ state: 'stale', reason: 'source_advanced', sourceSha: 'f'.repeat(40) });
  });

  it("honours native's own stale verdict when it reports one", () => {
    expect(
      decideBuildProvenance({ info: buildInfo({ stale: true }), readFailed: false }),
    ).toMatchObject({ state: 'stale', reason: 'source_advanced' });
  });

  it('reports an equal but dirty build as unverifiable, not clean', () => {
    expect(decideBuildProvenance({ info: buildInfo({ dirty: true }), readFailed: false })).toEqual({
      state: 'unverifiable',
      reason: 'built_dirty',
    });
  });

  it('reports a relocated binary with no source tree as unverifiable, not stale or clean', () => {
    expect(
      decideBuildProvenance({ info: buildInfo({ source_sha: null }), readFailed: false }),
    ).toEqual({ state: 'unverifiable', reason: 'source_unavailable' });
  });

  it('reports a build with no recorded source sha as unverifiable', () => {
    expect(
      decideBuildProvenance({ info: buildInfo({ git_sha: 'unknown' }), readFailed: false }),
    ).toEqual({ state: 'unverifiable', reason: 'provenance_missing' });
  });

  it('reports a failed read as unverifiable even while holding an earlier observation', () => {
    const info = buildInfo();
    expect(decideBuildProvenance({ info, readFailed: true })).toEqual({
      state: 'unverifiable',
      reason: 'read_failed',
    });
  });

  it('reports an undecodable read as unverifiable rather than a confirmed absence', () => {
    expect(decideBuildProvenance({ info: null, readFailed: false })).toEqual({
      state: 'unverifiable',
      reason: 'unreadable_response',
    });
  });

  it('prefers stale over an unverifiable signal so the actionable verdict wins', () => {
    expect(
      decideBuildProvenance({
        info: buildInfo({ source_sha: 'f'.repeat(40), dirty: true }),
        readFailed: false,
      }),
    ).toMatchObject({ state: 'stale' });
  });
});

// ── View ───────────────────────────────────────────────────────

describe('buildProvenanceView', () => {
  it('names the confirmed match and marks nothing as wrong', () => {
    const view = buildProvenanceView({ info: buildInfo(), checking: false, readFailed: false });
    expect(view.state).toBe('clean');
    expect(view.marker).toBe('');
    expect(view.confirmed).toBe(true);
    expect(view.sentence).toContain('matches source');
    expect(view.versionLabel).toBe('v0.6.0');
    expect(view.shaLabel).toBe('·a1b2c3d4e');
  });

  it('keeps the dirty-build marker next to the short sha', () => {
    const view = buildProvenanceView({
      info: buildInfo({ dirty: true }),
      checking: false,
      readFailed: false,
    });
    expect(view.shaLabel).toBe('·a1b2c3d4e*');
  });

  it('shows a visible word for every non-clean verdict, not colour alone', () => {
    const stale = buildProvenanceView({
      info: buildInfo({ source_sha: 'f'.repeat(40) }),
      checking: false,
      readFailed: false,
    });
    const unverifiable = buildProvenanceView({
      info: buildInfo({ source_sha: null }),
      checking: false,
      readFailed: false,
    });
    expect(stale.marker).toMatch(/stale/i);
    expect(stale.sentence).toContain('f'.repeat(9));
    expect(unverifiable.marker).toMatch(/unverifiable/i);
    expect(unverifiable.confirmed).toBe(false);
    expect(unverifiable.sentence).toMatch(/source tree is not available/i);
  });

  it('names the running source commit without exposing a path, diff, or command', () => {
    const view = buildProvenanceView({
      info: buildInfo({ source_sha: 'f'.repeat(40) }),
      checking: false,
      readFailed: false,
    });
    // The accessible name carries the short sha; the hover detail keeps the
    // full one. Neither may leak the source location or a diff.
    expect(view.sentence).toContain('a1b2c3d4e');
    expect(view.sentence).not.toMatch(/\/|diff|rev-parse|git /);
    expect(view.title).toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    expect(view.title).not.toMatch(/\/|diff|rev-parse/);
  });

  it('keeps the last observed build readable when a recheck fails', () => {
    const view = buildProvenanceView({
      info: buildInfo(),
      checking: false,
      readFailed: true,
    });
    expect(view.versionLabel).toBe('v0.6.0');
    expect(view.sentence).toMatch(/could not be completed/i);
  });

  it('shows the v… fallback and no confirmed claim before anything is read', () => {
    const view = buildProvenanceView({ info: null, checking: true, readFailed: false });
    expect(view.versionLabel).toBe('v…');
    expect(view.shaLabel).toBe('');
    expect(view.confirmed).toBe(false);
    expect(view.sentence).toMatch(/checking/i);
  });

  it('marks a never-read badge unverifiable once the read has failed', () => {
    const view = buildProvenanceView({ info: null, checking: false, readFailed: true });
    expect(view.marker).toMatch(/unverifiable/i);
    expect(view.sentence).toMatch(/could not be completed/i);
  });

  it('keeps the embedded version, build time, and full sha in the hover detail', () => {
    const view = buildProvenanceView({ info: buildInfo(), checking: false, readFailed: false });
    expect(view.title).toContain('version 0.6.0');
    expect(view.title).toContain('commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    expect(view.title).toContain('built 2026-09-25T10:00:00+00:00');
  });
});

// ── Shared observation ─────────────────────────────────────────

describe('build provenance store', () => {
  it('issues one read no matter how many surfaces subscribe', async () => {
    const read = vi.fn(async () => buildInfo());
    const store = createBuildProvenanceStore(read);
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);
    store.refresh();
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().info).not.toBeNull());
    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(store.getSnapshot().verdict).toEqual({ state: 'clean', reason: 'source_matches' });
  });

  it('collapses a recheck requested while a read is in flight into one request', async () => {
    const pending = deferred<BuildInfo>();
    const read = vi.fn(async () => pending.promise);
    const store = createBuildProvenanceStore(read);
    store.refresh();
    store.refresh();
    expect(store.getSnapshot().checking).toBe(true);
    pending.resolve(buildInfo());
    await vi.waitFor(() => expect(store.getSnapshot().checking).toBe(false));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads on a later deliberate recheck so a moved source tree is caught', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(buildInfo())
      .mockResolvedValueOnce(buildInfo({ source_sha: 'e'.repeat(40) }));
    const store = createBuildProvenanceStore(read);
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().verdict.state).toBe('clean'));
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().verdict.state).toBe('stale'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('holds the last observation and marks the verdict unverifiable when a recheck fails', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(buildInfo())
      .mockRejectedValueOnce(new Error('command not found'));
    const store = createBuildProvenanceStore(read);
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().verdict.state).toBe('clean'));
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().verdict.reason).toBe('read_failed'));
    expect(store.getSnapshot().info).toEqual(buildInfo());
    expect(store.getSnapshot().checking).toBe(false);
  });

  it('treats an undecodable response as a failed check, never as a clean build', async () => {
    const read = vi.fn().mockResolvedValue({ version: '0.6.0' });
    const store = createBuildProvenanceStore(read);
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().verdict.reason).toBe('read_failed'));
    expect(store.getSnapshot().info).toBeNull();
  });

  it('stops notifying a surface once it unsubscribes', async () => {
    const read = vi.fn(async () => buildInfo());
    const store = createBuildProvenanceStore(read);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    listener.mockClear();
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().info).not.toBeNull());
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies the first subscriber that starts the check', () => {
    const read = vi.fn(() => new Promise<BuildInfo>(() => {}));
    const store = createBuildProvenanceStore(read);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(read).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hands every subscriber the same snapshot reference between changes', async () => {
    const read = vi.fn(async () => buildInfo());
    const store = createBuildProvenanceStore(read);
    // `useSyncExternalStore` re-reads on every render, so an unchanged
    // snapshot must be the very same object.
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().info).not.toBeNull());
    const settled = store.getSnapshot();
    expect(store.getSnapshot()).toBe(settled);
  });

  it('keeps the same verdict when a recheck observes the same build', async () => {
    const read = vi.fn(async () => buildInfo());
    const store = createBuildProvenanceStore(read);
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().verdict.state).toBe('clean'));
    store.refresh();
    await vi.waitFor(() => expect(store.getSnapshot().checking).toBe(false));
    expect(store.getSnapshot().verdict).toEqual({ state: 'clean', reason: 'source_matches' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns one shared store per read function and forgets it on reset', async () => {
    resetSharedBuildProvenanceStores();
    const read = vi.fn(async () => buildInfo());
    const first = sharedBuildProvenanceStore(read);
    expect(sharedBuildProvenanceStore(read)).toBe(first);
    expect(sharedBuildProvenanceStore(vi.fn())).not.toBe(first);
    resetSharedBuildProvenanceStores();
    expect(sharedBuildProvenanceStore(read)).not.toBe(first);
  });
});

describe('bindFocusRecheck', () => {
  it('rechecks on focus and detaches when disposed', () => {
    const recheck = vi.fn();
    const target = new EventTarget();
    const dispose = bindFocusRecheck(target, recheck);
    target.dispatchEvent(new Event('focus'));
    expect(recheck).toHaveBeenCalledTimes(1);
    dispose();
    target.dispatchEvent(new Event('focus'));
    expect(recheck).toHaveBeenCalledTimes(1);
  });
});
