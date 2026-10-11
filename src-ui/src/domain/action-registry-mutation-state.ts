export type RegistryMutationKind = 'sync' | 'approve' | 'waive' | 'dispatch';
export type RegistryMutationPhase = 'writing' | 'write-failed' | 'reconciling' | 'read-failed' | 'unavailable';
export type RegistryMutationEvent = 'write-succeeded' | 'write-failed' | 'read-succeeded' | 'read-failed' | 'retry-read' | 'dispatch-unavailable';

export interface RegistryMutation {
  kind: RegistryMutationKind;
  id?: string;
  phase: RegistryMutationPhase;
  unavailable?: boolean;
}

export interface RegistryDispatchEvidence {
  run_id: string;
  status: 'verified';
  acceptance_result: string;
}

export interface RegistryMutationSnapshot {
  active: Array<{ id: string; approval_status?: string }>;
  blocked: Array<{ id: string; approval_status?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isVerifiedRegistryDispatchEvidence(value: unknown): value is RegistryDispatchEvidence {
  if (!isRecord(value)) return false;
  return typeof value.run_id === 'string' && value.run_id.trim().length > 0 &&
    value.status === 'verified' &&
    typeof value.acceptance_result === 'string' && value.acceptance_result.trim().length > 0;
}

export function isRegistryDispatchUnavailable(value: unknown): boolean {
  return isRecord(value) && value.status === 'unavailable' && value.code === 'verification_manifest_missing';
}

export function startRegistryMutation(kind: RegistryMutationKind, id?: string): RegistryMutation {
  return { kind, id, phase: 'writing' };
}

export function transitionRegistryMutation(
  mutation: RegistryMutation,
  event: RegistryMutationEvent,
): RegistryMutation | null {
  if (event === 'dispatch-unavailable' && mutation.phase === 'writing' && mutation.kind === 'dispatch') {
    return { ...mutation, phase: 'unavailable', unavailable: true };
  }
  if (event === 'write-succeeded' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'reconciling' };
  }
  if (event === 'write-failed' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'write-failed' };
  }
  if (event === 'read-failed' && mutation.phase === 'reconciling') {
    return { ...mutation, phase: 'read-failed' };
  }
  if (event === 'retry-read' && (mutation.phase === 'read-failed' || mutation.phase === 'unavailable')) {
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
  dispatchEvidence?: unknown,
): boolean {
  if (mutation.kind === 'sync') return true;
  if (mutation.id === undefined) return false;
  if (mutation.kind === 'dispatch') {
    return isVerifiedRegistryDispatchEvidence(dispatchEvidence) &&
      ![...snapshot.active, ...snapshot.blocked].some(action => action.id === mutation.id);
  }
  const expected = mutation.kind === 'approve' ? 'approved' : 'waived';
  return [...snapshot.active, ...snapshot.blocked].some(
    action => action.id === mutation.id && action.approval_status === expected,
  );
}
