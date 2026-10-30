import { describe, expect, it } from 'vitest';
import {
  INJECTION_BASIS,
  decodeInjectability,
  injectionLabel,
} from './memory-injectability';

describe('decodeInjectability', () => {
  it('keeps admitted and filtered verdicts with fixed reason codes', () => {
    const decoded = decodeInjectability([
      { id: 'a', admitted: true, stale: false, reason: null },
      { id: 'b', admitted: false, stale: false, reason: 'out_of_scope' },
    ]);
    expect(decoded).toEqual({
      a: { id: 'a', admitted: true, stale: false, reason: null },
      b: { id: 'b', admitted: false, stale: false, reason: 'out_of_scope' },
    });
  });

  it('defaults an absent stale flag to false', () => {
    expect(decodeInjectability([{ id: 'a', admitted: true, reason: null }])).toEqual({
      a: { id: 'a', admitted: true, stale: false, reason: null },
    });
  });

  it('refuses a malformed read instead of inventing verdicts', () => {
    for (const value of [null, undefined, {}, [{ id: 'a' }], [{ id: 'a', admitted: 'yes' }], [{ id: 'a', admitted: false, reason: 'raw error text' }]]) {
      expect(decodeInjectability(value)).toBeNull();
    }
  });
});

describe('injectionLabel', () => {
  it('says recallable, and flags a passed review window', () => {
    expect(injectionLabel({ id: 'a', admitted: true, stale: false, reason: null })).toBe('recallable here');
    expect(injectionLabel({ id: 'a', admitted: true, stale: true, reason: null })).toBe('recallable here · review due');
  });

  it('names each filter in fixed words rather than native text', () => {
    expect(injectionLabel({ id: 'a', admitted: false, stale: false, reason: 'authority_filtered' })).toBe(
      'filtered: legacy or derived authority',
    );
    expect(injectionLabel({ id: 'a', admitted: false, stale: false, reason: 'tier_filtered' })).toBe(
      'filtered: cold tier',
    );
    expect(injectionLabel({ id: 'a', admitted: false, stale: false, reason: 'expired' })).toBe('filtered: expired');
  });

  it('bounds the claim: admission is not a query match', () => {
    expect(INJECTION_BASIS).toMatch(/does not mean the current query matches/);
  });
});
