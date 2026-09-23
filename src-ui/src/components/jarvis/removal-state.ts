export type RemovalPhase = 'writing' | 'write-failed' | 'reconciling' | 'read-failed';

export interface RemovalOperation<T> {
  row: T;
  phase: RemovalPhase;
  after: number;
}

export interface RemovalReconciliation<T> {
  rows: T[];
  operations: Record<string, RemovalOperation<T>>;
}

export function removalLocked(operation: RemovalOperation<unknown> | undefined): boolean {
  return operation !== undefined && operation.phase !== 'write-failed';
}

export function reconcileRemovals<T extends { id: string }>(
  snapshot: T[],
  operations: Record<string, RemovalOperation<T>>,
  request: number,
): RemovalReconciliation<T> {
  const rows = [...snapshot];
  const next = { ...operations };

  for (const [id, operation] of Object.entries(operations)) {
    const observed = snapshot.find(row => row.id === id);
    if (operation.phase !== 'writing' && request > operation.after) {
      if (operation.phase === 'write-failed') {
        delete next[id];
        continue;
      }
      if (!observed) {
        delete next[id];
        continue;
      }
      next[id] = { ...operation, phase: 'read-failed' };
    }

    const index = rows.findIndex(row => row.id === id);
    if (index < 0) rows.push(operation.row);
    else rows[index] = operation.row;
  }

  return { rows, operations: next };
}
