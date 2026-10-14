// The memory tier tally is a separate read from the memory list, so it can fail on
// its own. These are the only places its verdict is derived: a count that the
// record did not return is never printed as 0, and a failed read is never the
// absence of a tally.

import type { Tier } from './memory-recall-state';

export const TIERS: readonly Tier[] = ['hot', 'warm', 'cold'];

export interface TierReading {
  tier: Tier;
  count: number | null;
  /** The record carried the key (with null when it carried a null). */
  supplied: boolean;
  /** The key was present but not a count this build can print. */
  unreadable: boolean;
}

export type DecodedTierStats =
  | { kind: 'decoded'; readings: TierReading[] }
  | { kind: 'unreadable' };

export function decodeTierStats(raw: unknown): DecodedTierStats {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'unreadable' };
  const record = raw as Record<string, unknown>;
  const readings = TIERS.map((tier) => {
    const value = record[tier];
    if (value === undefined || value === null) {
      return { tier, count: null, supplied: false, unreadable: false };
    }
    const usable = typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
    return usable
      ? { tier, count: value, supplied: true, unreadable: false }
      : { tier, count: null, supplied: true, unreadable: true };
  });
  return { kind: 'decoded', readings };
}

export function formatTierCount(reading: TierReading): string {
  if (reading.count !== null) return String(reading.count);
  return reading.unreadable ? 'unreadable' : 'not supplied';
}

export type TierStatsState = {
  requestId: number;
  pending: boolean;
  failure: 'rejected' | 'unreadable' | null;
  /** The last confirmed readings, retained so a failed read can mark them stale. */
  readings: TierReading[] | null;
};

export const initialTierStatsState: TierStatsState = {
  requestId: 0,
  pending: false,
  failure: null,
  readings: null,
};

export function beginTierStatsRead(state: TierStatsState, requestId: number): TierStatsState {
  if (requestId < state.requestId) return state;
  return { ...state, requestId, pending: true, failure: null };
}

export function resolveTierStatsRead(
  state: TierStatsState,
  requestId: number,
  raw: unknown,
): TierStatsState {
  if (requestId !== state.requestId) return state;
  const decoded = decodeTierStats(raw);
  if (decoded.kind === 'unreadable') {
    return { ...state, pending: false, failure: 'unreadable' };
  }
  return { ...state, pending: false, failure: null, readings: decoded.readings };
}

export function rejectTierStatsRead(state: TierStatsState, requestId: number): TierStatsState {
  if (requestId !== state.requestId) return state;
  return { ...state, pending: false, failure: 'rejected' };
}

export const TIER_STATS_GROUP_LABEL = 'Memory tier counts';
export const TIER_STATS_RETRY_LABEL = 'Retry tier counts';
export const TIER_STATS_PENDING = 'Reading memory tier counts…';
export const TIER_STATS_REFRESHING = 'Refreshing memory tier counts…';
export const TIER_STATS_REJECTED = 'Could not load the memory tier counts.';
export const TIER_STATS_UNREADABLE = 'Could not read the memory tier counts from this build.';
const TIER_STATS_STALE_SUFFIX = ' Showing the last confirmed counts; they may be stale.';

export type TierStatsView =
  | { kind: 'pending'; message: string; readings: TierReading[] | null }
  | { kind: 'unavailable'; message: string; readings: TierReading[] | null; stale: boolean }
  | { kind: 'confirmed'; readings: TierReading[] };

export function tierStatsView(state: TierStatsState): TierStatsView {
  if (state.pending) {
    return {
      kind: 'pending',
      message: state.readings ? TIER_STATS_REFRESHING : TIER_STATS_PENDING,
      readings: state.readings,
    };
  }
  if (state.failure) {
    const base = state.failure === 'unreadable' ? TIER_STATS_UNREADABLE : TIER_STATS_REJECTED;
    return {
      kind: 'unavailable',
      message: state.readings ? `${base}${TIER_STATS_STALE_SUFFIX}` : base,
      readings: state.readings,
      stale: state.readings !== null,
    };
  }
  if (state.readings) return { kind: 'confirmed', readings: state.readings };
  return { kind: 'pending', message: TIER_STATS_PENDING, readings: null };
}
