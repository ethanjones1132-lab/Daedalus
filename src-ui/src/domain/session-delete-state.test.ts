import { describe, expect, it } from 'vitest';
import {
  reconcileSessionDeletions,
  sessionDeleteLocked,
  type SessionDeleteOperation,
} from './session-delete-state';

type Session = { id: string; name: string };

const alpha: Session = { id: 'alpha', name: 'Alpha' };
const beta: Session = { id: 'beta', name: 'Beta' };

function operation(overrides: Partial<SessionDeleteOperation<Session>> = {}): SessionDeleteOperation<Session> {
  return {
    row: alpha,
    phase: 'reconciling',
    after: 2,
    ...overrides,
  };
}

describe('Session deletion reconciliation', () => {
  it('locks writing, reconciling, and read-failed operations', () => {
    expect(sessionDeleteLocked(undefined)).toBe(false);
    expect(sessionDeleteLocked(operation({ phase: 'writing' }))).toBe(true);
    expect(sessionDeleteLocked(operation({ phase: 'reconciling' }))).toBe(true);
    expect(sessionDeleteLocked(operation({ phase: 'read-failed' }))).toBe(true);
    expect(sessionDeleteLocked(operation({ phase: 'write-failed' }))).toBe(false);
  });

  it('does not let a read at the settlement barrier confirm removal', () => {
    const pending = operation({ after: 4 });
    const result = reconcileSessionDeletions([], { alpha: pending }, 4);

    expect(result.rows).toEqual([alpha]);
    expect(result.operations).toEqual({ alpha: pending });
    expect(result.confirmed).toEqual([]);
  });

  it('confirms removal only after a newer list omits the Session', () => {
    const result = reconcileSessionDeletions([beta], { alpha: operation() }, 3);

    expect(result).toEqual({ rows: [beta], operations: {}, confirmed: ['alpha'] });
  });

  it('retains a contradictory read as a locked stale row', () => {
    const pending = operation();
    const result = reconcileSessionDeletions([alpha, beta], { alpha: pending }, 3);

    expect(result.rows).toEqual([alpha, beta]);
    expect(result.operations.alpha).toEqual({ ...pending, phase: 'read-failed' });
    expect(result.confirmed).toEqual([]);
  });

  it('resolves a read-failed operation through a later list without another write', () => {
    const failed = operation({ phase: 'read-failed' });
    const result = reconcileSessionDeletions([beta], { alpha: failed }, 4);

    expect(result).toEqual({ rows: [beta], operations: {}, confirmed: ['alpha'] });
  });

  it('does not report a rejected write as a confirmed deletion', () => {
    const failed = operation({ phase: 'write-failed' });
    const result = reconcileSessionDeletions([beta], { alpha: failed }, 3);

    expect(result).toEqual({ rows: [beta], operations: {}, confirmed: [] });
  });

  it('reconciles independent Session ids independently', () => {
    const first = operation();
    const second = operation({ row: beta, after: 1 });
    const result = reconcileSessionDeletions([alpha, beta], {
      alpha: first,
      beta: second,
    }, 3);

    expect(result.rows).toEqual([alpha, beta]);
    expect(result.operations.alpha).toEqual({ ...first, phase: 'read-failed' });
    expect(result.operations.beta).toEqual({ ...second, phase: 'read-failed' });
    expect(result.confirmed).toEqual([]);
  });
});
