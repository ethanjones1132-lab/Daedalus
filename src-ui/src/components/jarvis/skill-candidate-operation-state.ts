export type SkillCandidateAction = 'eval' | 'promote' | 'reject' | 'demote' | 'rollback';
export type SkillCandidateStatus = 'candidate' | 'promoted' | 'rejected' | 'staged' | 'rolled_back';

const CANONICAL_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A captured rollback event timestamp must be exactly what `Date.toISOString()`
 * emits: millisecond precision, UTC `Z`, and a value that round-trips. This
 * rejects non-canonical spellings rather than reinterpreting them.
 */
export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_ISO_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
export type SkillCandidateMutationPhase = 'writing' | 'reconciling' | 'write-failed' | 'read-failed';
export type SkillCandidateMutationEvent = 'write-succeeded' | 'write-failed' | 'read-failed' | 'retry-read' | 'conflict' | 'request-finished';

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
  reportHash?: string;
  recordHash?: string;
  reasonCode?: string;
  contentDigest?: string;
  artifactDigest?: string;
  eventTimestamp?: string;
}

export interface SkillCandidateMutationProof {
  reportHash?: string;
  recordHash?: string;
  reasonCode?: string;
  contentDigest?: string;
  artifactDigest?: string;
  eventTimestamp?: string;
}

export function startSkillCandidateMutation(
  candidateId: string,
  action: SkillCandidateAction,
  expectedVersion: number,
  token: number,
  observedStatus: SkillCandidateStatus = 'candidate',
  proof?: SkillCandidateMutationProof,
): SkillCandidateMutation {
  return {
    token,
    candidateId,
    action,
    expectedVersion,
    observedStatus,
    phase: 'writing',
    writeAccepted: false,
    ...(proof ?? {}),
  };
}

export function transitionSkillCandidateMutation(
  mutation: SkillCandidateMutation,
  event: SkillCandidateMutationEvent,
  writeAccepted?: boolean,
): SkillCandidateMutation | null {
  if (event === 'write-succeeded' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'reconciling', writeAccepted: true };
  }
  if (event === 'request-finished' && mutation.phase === 'writing') {
    return { ...mutation, phase: 'reconciling', writeAccepted: writeAccepted === true };
  }
  if (event === 'write-failed' && (mutation.phase === 'writing' || mutation.phase === 'reconciling')) {
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
  if (mutation.action === 'promote') return candidate.status === 'promoted';
  if (mutation.action === 'rollback') return candidate.status === 'rolled_back';
  if (mutation.action === 'reject') return candidate.status === 'rejected';
  if (mutation.action === 'demote') return candidate.status === 'candidate';
  return candidate.status === mutation.observedStatus;
}

/**
 * Preflight gate for replaying a proof mutation (promote/rollback) whose write
 * was never confirmed. A retry is only allowed to be resent when a freshly read
 * candidate snapshot still matches the captured tuple exactly: the same
 * candidate, the pinned lifecycle version, and the action-specific pre-state
 * (staged at the pinned version for promote, promoted at the pinned version for
 * rollback). The evaluation-record half of the tuple is checked by the caller
 * against the same pinned pre-state; this gate never consults the current UI
 * selection.
 */
export function skillCandidateMutationRetryPreflight(
  mutation: SkillCandidateMutation | null | undefined,
  candidate: SkillCandidateSnapshot | null | undefined,
): boolean {
  if (!mutation || !candidate) return false;
  if (mutation.phase !== 'write-failed') return false;
  if (mutation.action !== 'promote' && mutation.action !== 'rollback') return false;
  const preState: SkillCandidateStatus = mutation.action === 'promote' ? 'staged' : 'promoted';
  if (mutation.observedStatus !== preState) return false;
  if (candidate.id !== mutation.candidateId) return false;
  if (candidate.lifecycle_version !== mutation.expectedVersion) return false;
  return candidate.status === preState;
}

/**
 * The route error codes that definitively refuse a candidate mutation once its
 * post-state has failed exact confirmation. Each is only definitive at the
 * status the route pairs it with, so a strict `data.error` must match exactly:
 * an unknown code, or a known code at the wrong status, never counts.
 */
const SKILL_CANDIDATE_REFUSAL_CODES: Readonly<Record<number, readonly string[]>> = {
  400: [
    'invalid_candidate_id',
    'invalid_report_hash',
    'invalid_record_hash',
    'invalid_expected_version',
    'invalid_reason_code',
    'invalid_event_timestamp',
  ],
  404: ['candidate_not_found'],
  409: ['wrong_status', 'stale_version', 'event_conflict'],
  422: [
    'invalid_candidate_record',
    'evidence_required',
    'decision_not_accepted',
    'candidate_binding_mismatch',
  ],
};

/**
 * Whether a candidate action response is a definitive, mutation-free refusal.
 * It is read from both the HTTP status and a strict `data.error`: a 400 counts
 * only when the code is one this route's proof handlers own for parser/
 * validation rejection, and 404/409/422 only when the code is one the route
 * uses to guarantee no mutation occurred. Every other status/code — including
 * an unenumerated 400 code, 409 `rollback_recorded`, 500 `record_corrupt`,
 * 503, transport status 0, and unknown codes — is not definitive and must stay
 * ambiguous so retry/reconciliation can still prove the true state.
 */
export function skillCandidateMutationDefinitiveRefusal(status: number, error: unknown): boolean {
  if (typeof error !== 'string' || error.length === 0) return false;
  const codes = SKILL_CANDIDATE_REFUSAL_CODES[status];
  return codes !== undefined && codes.includes(error);
}
