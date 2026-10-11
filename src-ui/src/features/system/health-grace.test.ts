import { describe, expect, it } from 'vitest';
import { healthGraceAnchor, recordFirstHealthObservation } from './health-derivation';

describe('shared startup-grace anchor', () => {
  it('falls back until the first observation, then keeps the earliest one', () => {
    expect(healthGraceAnchor(500)).toBe(500);
    recordFirstHealthObservation(100);
    recordFirstHealthObservation(200);
    expect(healthGraceAnchor(500)).toBe(100);
  });
});
