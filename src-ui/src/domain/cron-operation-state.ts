export type CronOperationKind = 'toggle' | 'run' | 'delete' | 'cancel';
export type CronOperationPhase = 'writing' | 'write-failed' | 'reconciling' | 'read-failed';
export type CronOperationEvent = 'write-succeeded' | 'write-failed' | 'read-failed' | 'retry-read' | 'read-succeeded';

export interface CronOperation<T extends { id: string; enabled: boolean }> {
  kind: CronOperationKind;
  id: string;
  row: T;
  phase: CronOperationPhase;
  after: number;
  targetEnabled?: boolean;
}

export interface CronOperationReconciliation<T extends { id: string; enabled: boolean }> {
  rows: T[];
  operations: Record<string, CronOperation<T>>;
  confirmed: Array<{ operation: CronOperation<T>; observed?: T }>;
}

export function startCronOperation<T extends { id: string; enabled: boolean }>(
  kind: CronOperationKind,
  id: string,
  row: T,
  after: number,
  targetEnabled?: boolean,
): CronOperation<T> {
  return { kind, id, row, phase: 'writing', after, targetEnabled };
}

export function transitionCronOperation<T extends { id: string; enabled: boolean }>(
  operation: CronOperation<T>,
  event: CronOperationEvent,
): CronOperation<T> | null {
  if (event === 'write-succeeded' && operation.phase === 'writing') {
    return { ...operation, phase: 'reconciling' };
  }
  if (event === 'write-failed' && operation.phase === 'writing') {
    return { ...operation, phase: 'write-failed' };
  }
  if (event === 'read-failed' && operation.phase === 'reconciling') {
    return { ...operation, phase: 'read-failed' };
  }
  if (event === 'retry-read' && operation.phase === 'read-failed') {
    return { ...operation, phase: 'reconciling' };
  }
  if (event === 'read-succeeded' && operation.phase === 'reconciling') {
    return null;
  }
  return operation;
}

export function cronOperationLocked<T extends { id: string; enabled: boolean }>(operation: CronOperation<T> | undefined): boolean {
  return operation !== undefined && operation.phase !== 'write-failed';
}

export function cronOperationConfirmed<T extends { id: string; enabled: boolean }>(
  operation: CronOperation<T>,
  snapshot: T[],
): boolean {
  const observed = snapshot.find(row => row.id === operation.id);
  if (operation.kind === 'delete') return observed === undefined;
  // A cancel cannot be confirmed merely because the recurring job row still
  // exists. Only a confirmed cancel path (the run no longer in flight) may
  // clear it; otherwise it stays explicitly unconfirmed/actionable.
  if (operation.kind === 'cancel') return false;
  if (operation.kind === 'run') return observed !== undefined;
  return observed !== undefined && observed.enabled === operation.targetEnabled;
}

function replaceRow<T extends { id: string; enabled: boolean }>(rows: T[], row: T): void {
  const index = rows.findIndex(item => item.id === row.id);
  if (index < 0) rows.push(row);
  else rows[index] = row;
}

export function reconcileCronOperations<T extends { id: string; enabled: boolean }>(
  snapshot: T[],
  operations: Record<string, CronOperation<T>>,
  request: number,
): CronOperationReconciliation<T> {
  const rows = [...snapshot];
  const next = { ...operations };
  const confirmed: CronOperationReconciliation<T>['confirmed'] = [];

  for (const operation of Object.values(operations)) {
    if (operation.phase === 'writing' || operation.phase === 'write-failed' || request <= operation.after) {
      replaceRow(rows, operation.row);
      continue;
    }

    const observed = snapshot.find(row => row.id === operation.id);
    if (cronOperationConfirmed(operation, snapshot)) {
      delete next[operation.id];
      if (operation.kind === 'delete') {
        const index = rows.findIndex(row => row.id === operation.id);
        if (index >= 0) rows.splice(index, 1);
      } else if (observed) {
        replaceRow(rows, observed);
      }
      confirmed.push({ operation, observed });
      continue;
    }

    next[operation.id] = { ...operation, phase: 'read-failed' };
    replaceRow(rows, operation.row);
  }

  return { rows, operations: next, confirmed };
}
