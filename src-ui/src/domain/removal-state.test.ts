import { describe, expect, it } from 'vitest';
import {
  reconcileRemovals,
  removalLocked,
  type RemovalOperation,
} from './removal-state';

type Row = { id: string; name: string };

const alpha: Row = { id: 'a', name: 'Alpha' };
const beta: Row = { id: 'b', name: 'Beta' };

function operation(overrides: Partial<RemovalOperation<Row>> = {}): RemovalOperation<Row> {
  return {
    row: alpha,
    phase: 'reconciling',
    after: 2,
    ...overrides,
  };
}

describe('removal reconciliation', () => {
  it('locks every phase except a rejected write', () => {
    expect(removalLocked(undefined)).toBe(false);
    for (const phase of ['writing', 'reconciling', 'read-failed'] as const) {
      expect(removalLocked(operation({ phase }))).toBe(true);
    }
    expect(removalLocked(operation({ phase: 'write-failed' }))).toBe(false);
  });

  it('retains a pending row whether an observation includes or omits it', () => {
    const pending = operation({ phase: 'writing' });
    const omitted = reconcileRemovals([], { a: pending }, 3);
    expect(omitted.rows).toEqual([alpha]);
    expect(omitted.operations.a).toEqual(pending);

    const included = reconcileRemovals([alpha, beta], { a: pending }, 3);
    expect(included.rows).toEqual([alpha, beta]);
    expect(included.operations.a).toEqual(pending);
  });

  it('does not let a read at or before settlement confirm removal', () => {
    const pending = operation({ after: 4 });
    const result = reconcileRemovals([], { a: pending }, 4);
    expect(result.rows).toEqual([alpha]);
    expect(result.operations.a).toEqual(pending);
  });

  it('confirms removal only from a newer observation that omits the row', () => {
    const result = reconcileRemovals([beta], { a: operation() }, 3);
    expect(result).toEqual({ rows: [beta], operations: {} });
  });

  it('retains a contradictory observation for read-only recovery', () => {
    const pending = operation();
    const result = reconcileRemovals([alpha, beta], { a: pending }, 3);
    expect(result.rows).toEqual([alpha, beta]);
    expect(result.operations.a).toEqual({ ...pending, phase: 'read-failed' });
    expect(reconcileRemovals([beta], result.operations, 4).operations).toEqual({});
  });

  it('clears a rejected write only after a fresh observation without claiming deletion', () => {
    const failed = operation({ phase: 'write-failed' });
    const present = reconcileRemovals([alpha, beta], { a: failed }, 3);
    expect(present.rows).toEqual([alpha, beta]);
    expect(present.operations).toEqual({});
    expect(reconcileRemovals([beta], { a: failed }, 3)).toEqual({ rows: [beta], operations: {} });
  });

  it('reconciles independent removals without coupling their locks', () => {
    const first = operation();
    const second = operation({ row: beta });
    const result = reconcileRemovals([alpha, beta], { a: first, b: second }, 3);
    expect(result.operations.a).toEqual({ ...first, phase: 'read-failed' });
    expect(result.operations.b).toEqual({ ...second, phase: 'read-failed' });
    expect(result.rows).toEqual([alpha, beta]);
  });
});
