import {
  reconcileRemovals,
  removalLocked,
  type RemovalOperation,
  type RemovalReconciliation,
} from './removal-state';

export type SessionDeleteOperation<T extends { id: string }> = RemovalOperation<T>;

export interface SessionDeleteReconciliation<T extends { id: string }> extends RemovalReconciliation<T> {
  confirmed: string[];
}

export function sessionDeleteLocked<T extends { id: string }>(
  operation: SessionDeleteOperation<T> | undefined,
): boolean {
  return removalLocked(operation);
}

export function reconcileSessionDeletions<T extends { id: string }>(
  snapshot: T[],
  operations: Record<string, SessionDeleteOperation<T>>,
  request: number,
): SessionDeleteReconciliation<T> {
  const previous = operations;
  const result = reconcileRemovals(snapshot, operations, request);
  const confirmed = Object.entries(previous)
    .filter(([id, operation]) => (
      operation.phase !== 'writing'
      && operation.phase !== 'write-failed'
      && request > operation.after
      && !snapshot.some(row => row.id === id)
      && result.operations[id] === undefined
    ))
    .map(([id]) => id);

  return { ...result, confirmed };
}
