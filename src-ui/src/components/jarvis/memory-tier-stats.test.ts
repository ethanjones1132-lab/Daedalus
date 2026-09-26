import { describe, expect, it } from 'vitest';
import {
  TIER_STATS_PENDING,
  TIER_STATS_REFRESHING,
  TIER_STATS_REJECTED,
  TIER_STATS_UNREADABLE,
  beginTierStatsRead,
  decodeTierStats,
  formatTierCount,
  initialTierStatsState,
  rejectTierStatsRead,
  resolveTierStatsRead,
  tierStatsView,
  type TierStatsState,
} from './memory-tier-stats';

const complete = { hot: 3, warm: 2, cold: 1 };

function readings(state: TierStatsState) {
  const view = tierStatsView(state);
  return view.readings;
}

describe('decodeTierStats', () => {
  it('reads a complete record into three counts', () => {
    const decoded = decodeTierStats(complete);
    expect(decoded).toEqual({
      kind: 'decoded',
      readings: [
        { tier: 'hot', count: 3, supplied: true, unreadable: false },
        { tier: 'warm', count: 2, supplied: true, unreadable: false },
        { tier: 'cold', count: 1, supplied: true, unreadable: false },
      ],
    });
  });

  it('reads a zero as a real count', () => {
    const decoded = decodeTierStats({ hot: 0, warm: 0, cold: 0 });
    expect(decoded.kind).toBe('decoded');
    expect(decoded.kind === 'decoded' && decoded.readings.map((r) => r.count)).toEqual([0, 0, 0]);
  });

  it('marks a key the record did not return as not supplied, never as 0', () => {
    const decoded = decodeTierStats({ hot: 4, warm: 2 });
    expect(decoded.kind).toBe('decoded');
    if (decoded.kind !== 'decoded') return;
    const warm = decoded.readings.find((r) => r.tier === 'warm')!;
    const cold = decoded.readings.find((r) => r.tier === 'cold')!;
    expect(warm).toEqual({ tier: 'warm', count: 2, supplied: true, unreadable: false });
    expect(cold).toEqual({ tier: 'cold', count: null, supplied: false, unreadable: false });
    expect(cold.count).toBeNull();
    expect(cold.unreadable).toBe(false);
    expect(formatTierCount(cold)).toBe('not supplied');
  });

  it('marks an explicit null as not supplied rather than unreadable', () => {
    const decoded = decodeTierStats({ hot: 1, warm: null, cold: 1 });
    expect(decoded.kind).toBe('decoded');
    if (decoded.kind !== 'decoded') return;
    expect(formatTierCount(decoded.readings[1])).toBe('not supplied');
  });

  it.each([
    ['a string count', { hot: '3', warm: 1, cold: 1 }],
    ['a negative count', { hot: -1, warm: 1, cold: 1 }],
    ['a fractional count', { hot: 1.5, warm: 1, cold: 1 }],
    ['NaN', { hot: Number.NaN, warm: 1, cold: 1 }],
    ['Infinity', { hot: Number.POSITIVE_INFINITY, warm: 1, cold: 1 }],
  ])('keeps the readable tiers and marks only the unreadable one: %s', (_label, raw) => {
    const decoded = decodeTierStats(raw);
    expect(decoded.kind).toBe('decoded');
    if (decoded.kind !== 'decoded') return;
    expect(formatTierCount(decoded.readings[0])).toBe('unreadable');
    expect(decoded.readings[1].count).toBe(1);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [1, 2, 3]],
    ['a number', 7],
    ['a string', 'hot'],
  ])('refuses to read a root that is not a record: %s', (_label, raw) => {
    expect(decodeTierStats(raw)).toEqual({ kind: 'unreadable' });
  });

  it('ignores keys this build does not render', () => {
    const decoded = decodeTierStats({ ...complete, archive: 9, total: 6 });
    expect(decoded.kind).toBe('decoded');
    if (decoded.kind !== 'decoded') return;
    expect(decoded.readings).toHaveLength(3);
  });
});

describe('tierStatsView', () => {
  it('announces a first read as pending with no counts', () => {
    const started = beginTierStatsRead(initialTierStatsState, 1);
    const view = tierStatsView(started);
    expect(view).toEqual({ kind: 'pending', message: TIER_STATS_PENDING, readings: null });
  });

  it('announces a re-read as refreshing while keeping the confirmed counts visible', () => {
    const confirmed = resolveTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1, complete);
    const view = tierStatsView(beginTierStatsRead(confirmed, 2));
    expect(view.kind).toBe('pending');
    expect(view.kind === 'pending' && view.message).toBe(TIER_STATS_REFRESHING);
    expect(view.kind === 'pending' && view.readings).toHaveLength(3);
  });

  it('reports a rejected read with no counts as unavailable and retryable', () => {
    const failed = rejectTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1);
    const view = tierStatsView(failed);
    expect(view.kind).toBe('unavailable');
    expect(view.kind === 'unavailable' && view.message).toBe(TIER_STATS_REJECTED);
    expect(view.kind === 'unavailable' && view.stale).toBe(false);
    expect(view.kind === 'unavailable' && view.readings).toBeNull();
  });

  it('keeps the last confirmed counts and marks them stale after a failed re-read', () => {
    const confirmed = resolveTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1, complete);
    const failed = rejectTierStatsRead(beginTierStatsRead(confirmed, 2), 2);
    const view = tierStatsView(failed);
    expect(view.kind).toBe('unavailable');
    if (view.kind !== 'unavailable') return;
    expect(view.stale).toBe(true);
    expect(view.message).toContain(TIER_STATS_REJECTED);
    expect(view.message).toContain('may be stale');
    expect(view.readings).toHaveLength(3);
  });

  it('distinguishes an undecodable payload from a rejected read', () => {
    const failed = resolveTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1, 'hot');
    const view = tierStatsView(failed);
    expect(view.kind === 'unavailable' && view.message).toBe(TIER_STATS_UNREADABLE);
  });

  it('confirms a decoded record even when one tier is unreadable', () => {
    const confirmed = resolveTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1, { hot: 1, warm: 'x', cold: 0 });
    const view = tierStatsView(confirmed);
    expect(view.kind).toBe('confirmed');
    expect(view.kind === 'confirmed' && view.readings.map(formatTierCount)).toEqual(['1', 'unreadable', '0']);
  });

  it('clears a standing failure once a read confirms', () => {
    const failed = rejectTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1);
    const recovered = resolveTierStatsRead(beginTierStatsRead(failed, 2), 2, complete);
    expect(tierStatsView(recovered).kind).toBe('confirmed');
  });

  it('keeps a standing failure visible through its own in-flight retry', () => {
    const failed = rejectTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1);
    const view = tierStatsView(beginTierStatsRead(failed, 2));
    expect(view.kind).toBe('pending');
    expect(view.kind === 'pending' && view.message).toBe(TIER_STATS_PENDING);
  });
});

describe('tier read request fencing', () => {
  it('ignores a superseded resolve and a superseded reject', () => {
    const started = beginTierStatsRead(initialTierStatsState, 2);
    expect(resolveTierStatsRead(started, 1, { hot: 9, warm: 9, cold: 9 })).toBe(started);
    expect(rejectTierStatsRead(started, 1)).toBe(started);
  });

  it('ignores a superseded resolve that would otherwise blank confirmed counts', () => {
    const confirmed = resolveTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1, complete);
    const second = beginTierStatsRead(confirmed, 2);
    const late = resolveTierStatsRead(second, 1, { hot: 9, warm: 9, cold: 9 });
    expect(late).toBe(second);
    expect(readings(late)).toEqual(confirmed.readings);
  });

  it('ignores a begin that is older than the newest read', () => {
    const newest = beginTierStatsRead(initialTierStatsState, 5);
    expect(beginTierStatsRead(newest, 4)).toBe(newest);
  });

  it('clears a standing failure the moment a newer read starts', () => {
    const failed = rejectTierStatsRead(beginTierStatsRead(initialTierStatsState, 1), 1);
    const retrying = beginTierStatsRead(failed, 2);
    expect(retrying.failure).toBeNull();
    expect(retrying.pending).toBe(true);
  });

  it('does not mutate the state it is given', () => {
    const before = beginTierStatsRead(initialTierStatsState, 1);
    const snapshot = JSON.stringify(before);
    resolveTierStatsRead(before, 1, complete);
    rejectTierStatsRead(before, 1);
    beginTierStatsRead(before, 2);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
