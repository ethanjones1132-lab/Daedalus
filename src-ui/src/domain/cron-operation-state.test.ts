import { describe, expect, it } from 'vitest';
import {
  cronOperationConfirmed,
  cronOperationLocked,
  reconcileCronOperations,
  startCronOperation,
  transitionCronOperation,
  type CronOperation,
} from './cron-operation-state';

type Job = { id: string; name: string; enabled: boolean };

const alpha: Job = { id: 'alpha', name: 'Alpha', enabled: true };
const beta: Job = { id: 'beta', name: 'Beta', enabled: true };

function operation(overrides: Partial<CronOperation<Job>> = {}): CronOperation<Job> {
  return {
    kind: 'toggle',
    id: 'alpha',
    row: alpha,
    phase: 'reconciling',
    after: 2,
    targetEnabled: false,
    ...overrides,
  };
}

describe('cron operation state', () => {
  it('locks every phase except a rejected write', () => {
    expect(cronOperationLocked(undefined)).toBe(false);
    for (const phase of ['writing', 'reconciling', 'read-failed'] as const) {
      expect(cronOperationLocked(operation({ phase }))).toBe(true);
    }
    expect(cronOperationLocked(operation({ phase: 'write-failed' }))).toBe(false);
  });

  it('does not let a read at or before settlement confirm a write', () => {
    const pending = operation({ after: 4 });
    const result = reconcileCronOperations([{ ...alpha, enabled: false }], { alpha: pending }, 4);
    expect(result.rows).toEqual([alpha]);
    expect(result.operations.alpha).toEqual(pending);
    expect(result.confirmed).toEqual([]);
  });

  it('confirms a toggle, run, and delete only from the submitted target observation', () => {
    expect(cronOperationConfirmed(operation(), [{ ...alpha, enabled: false }])).toBe(true);
    expect(cronOperationConfirmed(operation(), [alpha])).toBe(false);
    expect(cronOperationConfirmed(operation({ kind: 'run', targetEnabled: undefined }), [alpha])).toBe(true);
    expect(cronOperationConfirmed(operation({ kind: 'delete', targetEnabled: undefined }), [beta])).toBe(true);
    expect(cronOperationConfirmed(operation({ kind: 'delete', targetEnabled: undefined }), [alpha])).toBe(false);
  });

  it('removes a confirmed deletion and keeps contradictory rows for read-only recovery', () => {
    const deleted = reconcileCronOperations([beta], { alpha: operation({ kind: 'delete', targetEnabled: undefined }) }, 3);
    expect(deleted.rows).toEqual([beta]);
    expect(deleted.operations).toEqual({});
    expect(deleted.confirmed.map(result => result.operation.kind)).toEqual(['delete']);

    const contradictory = reconcileCronOperations([alpha, beta], { alpha: operation() }, 3);
    expect(contradictory.rows).toEqual([alpha, beta]);
    expect(contradictory.operations.alpha).toEqual({ ...operation(), phase: 'read-failed' });
  });

  it('clears a confirmed operation only after a newer observation', () => {
    const pending = operation();
    const stale = reconcileCronOperations([{ ...alpha, enabled: false }], { alpha: pending }, pending.after);
    expect(stale.operations.alpha).toEqual(pending);
    const current = reconcileCronOperations([{ ...alpha, enabled: false }], stale.operations, pending.after + 1);
    expect(current.operations).toEqual({});
    expect(current.confirmed).toHaveLength(1);
  });

  it('keeps independent operations separate', () => {
    const first = operation();
    const second = operation({ id: 'beta', row: beta, after: 2 });
    const result = reconcileCronOperations(
      [{ ...alpha, enabled: false }, { ...beta, enabled: false }],
      { alpha: first, beta: second },
      3,
    );
    expect(result.operations).toEqual({});
    expect(result.confirmed.map(result => result.operation.id)).toEqual(['alpha', 'beta']);
  });

  it('moves a read failure through a read-only retry without rewriting', () => {
    const failed = transitionCronOperation(operation(), 'read-failed')!;
    expect(failed.phase).toBe('read-failed');
    const retry = transitionCronOperation(failed, 'retry-read')!;
    expect(retry.phase).toBe('reconciling');
    expect(transitionCronOperation(retry, 'read-succeeded')).toBeNull();
    expect(startCronOperation('toggle', 'alpha', alpha, 4, false).phase).toBe('writing');
  });
});
