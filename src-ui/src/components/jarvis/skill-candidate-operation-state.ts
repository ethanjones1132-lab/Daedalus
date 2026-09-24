export type SkillCandidateAction = 'eval' | 'promote' | 'reject' | 'demote';
export type SkillCandidateStatus = 'candidate' | 'promoted' | 'rejected';
export type SkillCandidateMutationPhase = 'writing' | 'reconciling' | 'write-failed' | 'read-failed';
export type SkillCandidateMutationEvent = 'write-succeeded' | 'write-failed' | 'read-failed' | 'retry-read' | 'conflict';

export interface SkillCandidateSnapshot {
  id: string;
  status: SkillCandidateStatus;
  lifecycle_version?: number;
  eval_score?: number;
}

export interface SkillCandidateMutation {
  token: number;
  candidateId: string;
  action: SkillCandidateAction;
  expectedVersion: number;
  observedStatus: SkillCandidateStatus;
  phase: SkillCandidateMutationPhase;
  writeAccepted: boolean;
}

export function startSkillCandidateMutation(
  candidateId: string,
  action: SkillCandidateAction,
  expectedVersion: number,
  token: number,
  observedStatus: SkillCandidateStatus = 'candidate',
): SkillCandidateMutation {
  return { token, candidateId, action, expectedVersion, observedStatus, phase: 'writing', writeAccepted: false };
}

export function transitionSkillCandidateMutation(
  mutation: SkillCandidateMutation,
  event: SkillCandidateMutationEvent,
): SkillCandidateMutation | null {
  if (event === 'write-succeeded' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'reconciling', writeAccepted: true };
  }
  if (event === 'write-failed' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'write-failed', writeAccepted: false };
  }
  if ((event === 'conflict' || event === 'read-failed') && mutation.phase === 'reconciling') {
    return { ...mutation, phase: 'read-failed', writeAccepted: event === 'conflict' ? false : mutation.writeAccepted };
  }
  if (event === 'retry-read' && mutation.phase === 'read-failed') {
    return { ...mutation, phase: 'reconciling' };
  }
  return null;
}

export function skillCandidateMutationLocked(mutation: SkillCandidateMutation | null | undefined): boolean {
  return mutation?.phase === 'writing' || mutation?.phase === 'reconciling' || mutation?.phase === 'read-failed';
}

export function skillCandidateMutationConfirmed(
  mutation: SkillCandidateMutation | null | undefined,
  candidate: SkillCandidateSnapshot | null | undefined,
): boolean {
  if (!mutation || mutation.phase !== 'reconciling' || !candidate) return false;
  if (candidate.id !== mutation.candidateId || candidate.lifecycle_version !== mutation.expectedVersion + 1) return false;
  if (mutation.action === 'promote') return candidate.status === 'promoted' || candidate.status === 'rejected';
  if (mutation.action === 'reject') return candidate.status === 'rejected';
  if (mutation.action === 'demote') return candidate.status === 'candidate';
  return candidate.status === mutation.observedStatus;
}
