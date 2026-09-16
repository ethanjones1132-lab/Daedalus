import { describe, expect, it } from 'vitest';
import { reconcileApprovalRows } from './approval-state';

describe('reconcileApprovalRows', () => {
  it('retains pending or failed decision snapshots and excludes settled ids', () => {
    const pending = { id: 'pending', description: 'submitted snapshot' };
    const failed = { id: 'failed', description: 'retryable snapshot' };
    const fresh = { id: 'fresh', description: 'new request' };
    const incoming = [{ ...pending, description: 'older list snapshot' }, { id: 'done', description: 'settled' }, fresh];
    expect(reconcileApprovalRows(incoming, [pending, failed], new Set(['done'])))
      .toEqual([pending, fresh, failed]);
    expect(incoming).toHaveLength(3);
  });
  it('accepts a successful empty list when no decisions need retaining', () => {
    expect(reconcileApprovalRows([], [], new Set())).toEqual([]);
  });
});
