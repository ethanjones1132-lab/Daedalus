export type ProfileOperationPhase = 'idle' | 'writing' | 'write-failed' | 'reconciling' | 'reconciliation-failed';
type Event = 'submit' | 'written' | 'write-failed' | 'observed' | 'read-failed' | 'retry-read';

export function profileOperationLocked(phase: ProfileOperationPhase): boolean {
  return phase === 'writing' || phase === 'reconciling' || phase === 'reconciliation-failed';
}

export function reduceProfileOperation(phase: ProfileOperationPhase, event: Event): ProfileOperationPhase {
  if (event === 'submit' && !profileOperationLocked(phase)) return 'writing';
  if (phase === 'writing') {
    if (event === 'written') return 'reconciling';
    if (event === 'write-failed') return 'write-failed';
  }
  if (phase === 'reconciling') {
    if (event === 'observed') return 'idle';
    if (event === 'read-failed') return 'reconciliation-failed';
  }
  if (phase === 'reconciliation-failed' && event === 'retry-read') return 'reconciling';
  return phase;
}
