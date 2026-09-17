export interface CommitmentOperation<T> {
  row: T;
  action: 'complete' | 'delete';
  phase: 'writing' | 'write-failed' | 'reconciling' | 'read-failed';
  // Last request started before this write settled. It cannot reconcile the write.
  after: number;
}

export function commitmentLocked<T>(operation: CommitmentOperation<T> | undefined): boolean {
  return !!operation && operation.phase !== 'write-failed';
}

export function reconcileCommitments<T extends { id: string; status: string }>(
  snapshot: T[],
  operations: Record<string, CommitmentOperation<T>>,
  request: number,
): { rows: T[]; operations: Record<string, CommitmentOperation<T>> } {
  let rows = [...snapshot];
  const next = { ...operations };
  for (const [id, operation] of Object.entries(operations)) {
    const observed = snapshot.find(row => row.id === id);
    if (operation.phase !== 'writing' && request > operation.after) {
      if (operation.phase === 'write-failed') continue;
      const reconciled = operation.action === 'delete' ? !observed : !observed || observed.status === 'completed';
      if (reconciled) {
        delete next[id];
        continue;
      }
      next[id] = { ...operation, phase: 'read-failed' };
    }
    // Until a post-write snapshot confirms the result, retain a disabled row.
    // Do not fabricate completed_at or optimistically hide a deletion.
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) rows.push(operation.row);
    else rows[index] = operation.row;
  }
  return { rows, operations: next };
}
