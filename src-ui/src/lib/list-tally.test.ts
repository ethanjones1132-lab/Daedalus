// The one place a list header decides what number it may state.
//
// A `SectionHeader` renders its count inside the heading as the view's own name
// (`Devices(0)`), and it prints whenever `typeof count === 'number'`. Nine
// mounted surfaces kept their list in a `useState<T[]>([])` and passed
// `count={list.length}` from a header that sits above and independently of the
// read gate its own body implements — so a read that was still in flight, and a
// read that had just failed, both printed a confident `0`. That is the reading
// which most strongly says "there is nothing here", produced by a read that
// returned nothing, and it is indistinguishable from a genuinely empty install.
//
// These are the rules the whole class is reduced to, pinned in one place so a
// header and the body beneath it cannot disagree about the same read.

import { describe, expect, it } from 'vitest';
import { countProp, listRead, projectListTally, sectionCount, type ListRead } from './list-tally';

const NO_READ = { loading: false, failed: false };
const IN_FLIGHT = { loading: true, failed: false };
const FAILED = { loading: false, failed: true };
const FAILED_AND_STILL_LOADING = { loading: true, failed: true };

const THREE = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('listRead', () => {
  it('claims nothing while the first read is in flight', () => {
    expect(listRead([], IN_FLIGHT)).toBe('pending');
  });

  it('claims nothing when a read has failed and put no rows on screen', () => {
    expect(listRead([], FAILED)).toBe('failed');
  });

  it('claims nothing when a read is in flight over a failure that put no rows on screen', () => {
    // A Retry re-arms the read without clearing the failure, so both flags can
    // be true at once and neither one is a reading.
    expect(listRead([], FAILED_AND_STILL_LOADING)).toBe('pending');
  });

  it('confirms a read that returned rows, whichever read came after it', () => {
    // A refresh in flight and a refresh that failed both leave the confirmed
    // list on screen. The surface says so in its own words ("Previously loaded
    // … may be stale"), and the count is the number of those rows.
    expect(listRead(THREE, IN_FLIGHT)).toBe('confirmed');
    expect(listRead(THREE, FAILED)).toBe('confirmed');
    expect(listRead(THREE, FAILED_AND_STILL_LOADING)).toBe('confirmed');
  });

  it('confirms a read that returned nothing, because a genuine zero is a zero', () => {
    // The load-bearing distinction: a confirmed empty read is not a failed one.
    // Collapsing these is how `(0)` became the app's most confident claim.
    expect(listRead([], NO_READ)).toBe('confirmed');
  });

  it('prefers a failed read over a loading one only when nothing is on screen', () => {
    // Loading and failed together is a retry, and the pending word is the
    // honest one: the surface is waiting, not reporting a fault.
    expect(listRead([], { loading: false, failed: true })).toBe('failed');
    expect(listRead([], { loading: true, failed: true })).toBe('pending');
  });
});

describe('projectListTally', () => {
  it('states the real number for a confirmed read', () => {
    expect(projectListTally(THREE, 'confirmed')).toEqual({ count: 3 });
  });

  it('states a confirmed zero rather than nothing', () => {
    expect(projectListTally([], 'confirmed')).toEqual({ count: 0 });
  });

  it('states nothing at all for a pending or failed read', () => {
    expect(projectListTally(THREE, 'pending')).toEqual({ count: null });
    expect(projectListTally(THREE, 'failed')).toEqual({ count: null });
    // Including a list it is still holding: a failed read's rows are the
    // surface's own staleness sentence's business, not this count's.
    expect(projectListTally([], 'failed')).toEqual({ count: null });
  });

  it('never sees the read that failed, so no native text can reach a heading', () => {
    // `failed` carries no message by construction. A count is a number or it is
    // absent; there is no third state in which it narrates a rejection.
    const read: ListRead = 'failed';
    expect(projectListTally(THREE, read).count).toBeNull();
  });
});

describe('countProp', () => {
  it('hands the primitive a number for a confirmed count and undefined for a null one', () => {
    // The primitive's own gate is `typeof count === 'number'`, so this is the
    // only difference between printing `Devices(0)` and printing nothing.
    expect(countProp({ count: 3 })).toBe(3);
    expect(countProp({ count: 0 })).toBe(0);
    expect(countProp({ count: null })).toBeUndefined();
  });
});

describe('sectionCount', () => {
  it('returns the SectionHeader prop value for a confirmed read', () => {
    expect(sectionCount(THREE, { loading: false, failed: false })).toBe(3);
  });

  it('returns 0 — a number, so the heading still prints it — for a confirmed empty read', () => {
    // `undefined` is how the primitive is told to print nothing at all, and `0`
    // is how it is told to print `(0)`. A confirmed zero must reach the second.
    const prop = sectionCount([], { loading: false, failed: false });
    expect(prop).toBe(0);
    expect(typeof prop).toBe('number');
  });

  it('returns undefined — the primitive omits the parenthetical — for a read that cannot count', () => {
    expect(sectionCount([], { loading: true, failed: false })).toBeUndefined();
    expect(sectionCount([], { loading: false, failed: true })).toBeUndefined();
    expect(sectionCount([], { loading: true, failed: true })).toBeUndefined();
  });

  it('cannot un-claim a count for rows that are on screen, whatever the newest read did', () => {
    // Every flag combination, against a list a read has already returned. This
    // is the property that keeps a refresh or a retry from blanking a number the
    // operator is looking at.
    for (const loading of [true, false]) {
      for (const failed of [true, false]) {
        expect(sectionCount(THREE, { loading, failed })).toBe(3);
      }
    }
  });

  it('keeps the count of confirmed rows through a refresh and through a failed refresh', () => {
    // These are the two cases a "loading means no count" rule gets wrong: the
    // rows are on screen, so the number of them is not in doubt.
    expect(sectionCount(THREE, { loading: true, failed: false })).toBe(3);
    expect(sectionCount(THREE, { loading: false, failed: true })).toBe(3);
  });

  it('agrees with projectListTally for every read, so two readers of one read cannot disagree', () => {
    for (const flags of [NO_READ, IN_FLIGHT, FAILED, FAILED_AND_STILL_LOADING]) {
      for (const items of [[], THREE]) {
        const tally = projectListTally(items, listRead(items, flags));
        const prop = sectionCount(items, flags);
        // `null` and `undefined` are the two ways this module says "no claim",
        // and a header must not be able to get one where the other got the other.
        expect(prop === undefined ? null : prop).toBe(tally.count);
        expect(countProp(tally)).toBe(prop);
      }
    }
  });
});
