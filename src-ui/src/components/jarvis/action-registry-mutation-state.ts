export type RegistryMutationKind = 'sync' | 'approve' | 'waive' | 'dispatch';
export type RegistryMutationPhase = 'writing' | 'write-failed' | 'reconciling' | 'read-failed';
export type RegistryMutationEvent = 'write-succeeded' | 'write-failed' | 'read-succeeded' | 'read-failed' | 'retry-read';

export interface RegistryMutation {
  kind: RegistryMutationKind;
  id?: string;
  phase: RegistryMutationPhase;
}

export interface RegistryMutationSnapshot {
  active: Array<{ id: string; approval_status?: string }>;
  blocked: Array<{ id: string; approval_status?: string }>;
}

export function startRegistryMutation(kind: RegistryMutationKind, id?: string): RegistryMutation {
  return { kind, id, phase: 'writing' };
}

export function transitionRegistryMutation(
  mutation: RegistryMutation,
  event: RegistryMutationEvent,
): RegistryMutation | null {
  if (event === 'write-succeeded' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'reconciling' };
  }
  if (event === 'write-failed' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'write-failed' };
  }
  if (event === 'read-failed' && mutation.phase === 'reconciling') {
    return { ...mutation, phase: 'read-failed' };
  }
  if (event === 'retry-read' && mutation.phase === 'read-failed') {
    return { ...mutation, phase: 'reconciling' };
  }
  if (event === 'read-succeeded' && mutation.phase === 'reconciling') {
    return null;
  }
  return mutation;
}

export function registryMutationLocked(mutation: RegistryMutation | null): boolean {
  return mutation !== null && mutation.phase !== 'write-failed';
}

export function registryMutationConfirmed(
  mutation: RegistryMutation,
  snapshot: RegistryMutationSnapshot,
): boolean {
  if (mutation.kind === 'sync') return true;
  if (mutation.id === undefined) return false;
  if (mutation.kind === 'dispatch') {
    return ![...snapshot.active, ...snapshot.blocked].some(action => action.id === mutation.id);
  }
  const expected = mutation.kind === 'approve' ? 'approved' : 'waived';
  return [...snapshot.active, ...snapshot.blocked].some(
    action => action.id === mutation.id && action.approval_status === expected,
  );
}
