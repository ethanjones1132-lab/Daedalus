import { expect, it } from 'vitest';
import { reconcileCommitments, commitmentLocked, type CommitmentOperation } from './commitment-state';
const row = { id: 'a', status: 'open', text: 'Task' };
const operation = (phase: CommitmentOperation<typeof row>['phase'], action: 'complete' | 'delete' = 'complete'): CommitmentOperation<typeof row> => ({ row, action, phase, after: 2 });
it('locks through failed reconciliation but releases rejected writes', () => {
  for (const phase of ['writing', 'reconciling', 'read-failed'] as const) expect(commitmentLocked(operation(phase))).toBe(true);
  expect(commitmentLocked(operation('write-failed'))).toBe(false);
  expect(commitmentLocked(undefined)).toBe(false);
});
it('preserves pending rows even when another read removes or completes them', () => {
  for (const rows of [[], [{ ...row, status: 'completed' }]]) {
    expect(reconcileCommitments(rows, { a: operation('writing') }, 3).rows).toEqual([row]);
  }
});
it('only post-write reads can reconcile completion or deletion', () => {
  const completed = { ...row, status: 'completed' };
  expect(reconcileCommitments([completed], { a: operation('reconciling') }, 2).rows).toEqual([row]);
  expect(reconcileCommitments([completed], { a: operation('reconciling') }, 3)).toEqual({ rows: [completed], operations: {} });
  expect(reconcileCommitments([], { a: operation('read-failed', 'delete') }, 3)).toEqual({ rows: [], operations: {} });
});
it('keeps conflicting snapshots guarded for read-only recovery', () => {
  const result = reconcileCommitments([row], { a: operation('reconciling', 'delete') }, 3);
  expect(result.rows).toEqual([row]);
  expect(result.operations.a.phase).toBe('read-failed');
  expect(commitmentLocked(result.operations.a)).toBe(true);
});
it('reconciles independent rows without unlocking a write still pending', () => {
  const b = { ...row, id: 'b' };
  const result = reconcileCommitments([{ ...row, status: 'completed' }], {
    a: operation('reconciling'), b: { ...operation('writing', 'delete'), row: b },
  }, 3);
  expect(result.rows).toEqual([{ ...row, status: 'completed' }, b]);
  expect(Object.keys(result.operations)).toEqual(['b']);
});
it('protects rejected writes from already-started reads', () => {
  expect(reconcileCommitments([], { a: operation('write-failed') }, 2).rows).toEqual([row]);
  expect(reconcileCommitments([], { a: operation('write-failed') }, 3).rows).toEqual([]);
});
