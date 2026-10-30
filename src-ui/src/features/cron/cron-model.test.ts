import { describe, expect, it } from 'vitest';
import { decodeCronRunOutcome } from './cron-model';

describe('decodeCronRunOutcome', () => {
  it('decodes the typed native outcomes', () => {
    expect(decodeCronRunOutcome('ran')).toBe('ran');
    expect(decodeCronRunOutcome('already_claimed')).toBe('already_claimed');
    expect(decodeCronRunOutcome('cancelled')).toBe('cancelled');
  });

  it('accepts the legacy boolean shapes without overclaiming a run', () => {
    expect(decodeCronRunOutcome(true)).toBe('ran');
    expect(decodeCronRunOutcome(false)).toBe('already_claimed');
  });

  it('refuses an unknown shape so the caller can surface a failure', () => {
    for (const value of [null, undefined, {}, [], 'running', 1]) {
      expect(decodeCronRunOutcome(value)).toBeNull();
    }
  });
});
