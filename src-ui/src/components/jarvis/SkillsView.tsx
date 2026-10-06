// ═══════════════════════════════════════════════════════════════
// ── SkillsView — Browse, toggle, inspect, and revision-restore skills
// ═══════════════════════════════════════════════════════════════
//
// Backed by the SQLite skills surface in src-tauri/src/commands/skills.rs:
//   list_skills() -> Skill[]
//   enable_skill(name) / disable_skill(name)
//   invoke_skill(name) -> Skill        (returns the full body + metadata)
//   skill_revisions_list(skillId?, limit?) -> SkillRevision[]
//   skill_restore_revision(revisionId) -> bool

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  cn,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';
import MarkdownRenderer from './MarkdownRenderer';
import { initialRegistryState, reduceRegistryState, type RegistrySnapshotState } from './action-registry-state';
import { applySkillListRead, confirmSkillToggle, type SkillToggleProtection } from './skill-toggle-state';
import {
  isCanonicalIsoTimestamp,
  skillCandidateMutationConfirmed,
  skillCandidateMutationDefinitiveRefusal,
  skillCandidateMutationLocked,
  skillCandidateMutationRetryPreflight,
  startSkillCandidateMutation,
  transitionSkillCandidateMutation,
  type SkillCandidateAction,
  type SkillCandidateMutation,
  type SkillCandidateMutationProof,
  type SkillCandidateSnapshot,
  type SkillCandidateStatus,
} from './skill-candidate-operation-state';
import {
  candidatePerformanceView,
  initialCandidatePerformanceState,
  reduceCandidatePerformance,
  type CandidatePerformanceResponse,
  type CandidatePerformanceState,
} from './skill-candidate-performance';

// ── Types ──────────────────────────────────────────────────────

interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  metadata: string | null;
  body: string;
  version: number;
  last_improved_at?: string | null;
  improvement_score: number;
  created_at: string;
  updated_at: string;
}

interface SkillRevision {
  id: string;
  skill_id: string;
  version: number;
  body_before: string;
  body_after: string;
  change_reason: string;
  source_session_id?: string | null;
  created_at: string;
}

// Distilled-skill lifecycle detail, fetched from the Bun orchestrator (the
// source of truth for distilled skills — see docs/superpowers/plans/
// 2026-07-02-organism-loop-implementation-spec.md D1). The native `Skill`
// row's `metadata.candidate_id` links it to one of these.
interface SkillCandidateDetail {
  id: string;
  name: string;
  description: string;
  trigger: { task_types: string[]; requirements: string[]; signals: string[] };
  body: string;
  source_run_ids: string[];
  source_session_id?: string;
  confidence: number;
  status: 'candidate' | 'promoted' | 'rejected' | 'staged' | 'rolled_back';
  lifecycle_version?: number;
  eval_score?: number;
  eval_missed?: string[];
  rejection_reason?: string;
  rejection_detail?: string;
  promoted_at?: string;
  created_at: string;
  updated_at: string;
}

type Filter = 'all' | 'enabled' | 'disabled' | 'candidates';

const BUN_URL = 'http://127.0.0.1:19877';

type RollbackReasonCode = 'regression_detected' | 'superseded_by_newer_evidence' | 'manual_rollback';

const ROLLBACK_REASON_CODES: readonly RollbackReasonCode[] = [
  'regression_detected',
  'superseded_by_newer_evidence',
  'manual_rollback',
];

function isRollbackReasonCode(value: string | undefined): value is RollbackReasonCode {
  return typeof value === 'string' && (ROLLBACK_REASON_CODES as readonly string[]).includes(value);
}

// ── Helpers ────────────────────────────────────────────────────

function formatDate(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function categoryOf(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    if (typeof md.category === 'string') return md.category;
  } catch {
    /* ignore malformed metadata */
  }
  return null;
}

function distilledStatus(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    if (typeof md.status === 'string') return md.status;
  } catch {
    /* ignore */
  }
  return null;
}

function isDistilledCandidate(skill: Skill): boolean {
  const status = distilledStatus(skill);
  return status === 'candidate' || skill.name.startsWith('distilled-');
}

function sourceOf(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    return typeof md.source === 'string' ? md.source : null;
  } catch {
    return null;
  }
}

function candidateIdOf(skill: Skill): string | null {
  if (!skill.metadata) return null;
  try {
    const md = JSON.parse(skill.metadata);
    return typeof md.candidate_id === 'string' ? md.candidate_id : null;
  } catch {
    return null;
  }
}

/** Distilled skills are owned by the Bun candidate store — their lifecycle
 *  moves through Promote/Reject/Rollback, not the native enable/disable
 *  toggle (which the orchestrator's resolver never reads for these rows). */
function isDistilledSkill(skill: Skill): boolean {
  return sourceOf(skill) === 'trajectory_distillation';
}

interface SkillCandidateActionResponse {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}

async function postSkillCandidateAction(
  candidateId: string,
  action: SkillCandidateAction,
  expectedVersion: number,
  reason?: string,
  proof?: SkillCandidateMutationProof,
): Promise<SkillCandidateActionResponse> {
  let payload: Record<string, unknown>;
  if (action === 'promote') {
    if (proof?.reportHash === undefined || proof.recordHash === undefined) {
      return { ok: false, status: 0, data: {} };
    }
    payload = {
      report_hash: proof.reportHash,
      record_hash: proof.recordHash,
      expected_version: expectedVersion,
    };
  } else if (action === 'rollback') {
    if (proof?.reportHash === undefined || proof.recordHash === undefined || proof.reasonCode === undefined) {
      return { ok: false, status: 0, data: {} };
    }
    if (!isCanonicalIsoTimestamp(proof.eventTimestamp)) {
      return { ok: false, status: 0, data: {} };
    }
    payload = {
      report_hash: proof.reportHash,
      record_hash: proof.recordHash,
      expected_version: expectedVersion,
      reason_code: proof.reasonCode,
      event_timestamp: proof.eventTimestamp,
    };
  } else {
    payload = { expected_version: expectedVersion, ...(reason === undefined ? {} : { reason }) };
  }
  try {
    const res = await fetch(`${BUN_URL}/skills/candidates/${encodeURIComponent(candidateId)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      data: data && typeof data === 'object' ? data as Record<string, unknown> : {},
    };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

/**
 * Read one promoted candidate's performance-since-promotion window. A rejected
 * request, a status the route uses to refuse the read, and an undecodable body
 * are each reported as themselves so `skill-candidate-performance` can name
 * what it could not learn; no transport or server text is carried, and the
 * `status` is normalised because a synthetic or partial response may not carry
 * one at all.
 */
async function readCandidatePerformance(candidateId: string): Promise<CandidatePerformanceResponse> {
  let res: Response;
  try {
    res = await fetch(`${BUN_URL}/skills/candidates/${encodeURIComponent(candidateId)}/performance`);
  } catch {
    return { kind: 'transport' };
  }
  const status = typeof res.status === 'number' ? res.status : 0;
  try {
    return { kind: 'http', status, value: await res.json() };
  } catch {
    return { kind: 'body' };
  }
}

// ── Candidate evaluation projection ────────────────────────────
//
// Strict read model for the native-backed
// GET /skills/candidates/:id/evaluation projection. Every field is decoded
// defensively so a malformed or partial body is reported as itself rather
// than coerced; a failed read never becomes an empty evaluations list.

export type SkillCandidateEvaluationDecision = 'accepted' | 'rejected' | 'inconclusive';

export interface SkillCandidateEvaluationCandidate {
  id: string;
  content_digest: string;
  artifact_digest: string;
}

export interface SkillCandidateEvaluationCoverage {
  planned_task_count: number;
  seeds_per_task: number;
  arms_per_block: number;
  planned_block_count: number;
  planned_outcome_count: number;
  observed_outcome_count: number;
  missing_outcome_count: number;
}

export interface SkillCandidateEvaluationCriterion {
  id: string;
  description: string;
  threshold: number;
  observed: number | null;
  status: string;
  reason: string | null;
}

export interface SkillCandidateEvaluation {
  report_hash: string;
  record_hash: string;
  manifest_hash: string;
  decision: SkillCandidateEvaluationDecision;
  generated_at: string;
  candidate: SkillCandidateEvaluationCandidate;
  coverage: SkillCandidateEvaluationCoverage;
  criteria: SkillCandidateEvaluationCriterion[];
  reasons: string[];
  observed_status: SkillCandidateStatus;
  observed_version: number;
  content_match: boolean;
  stale: boolean;
}

export interface SkillCandidateEvaluationProjection {
  candidate_id: string;
  current_status: SkillCandidateStatus;
  current_version: number;
  count: number;
  evaluations: SkillCandidateEvaluation[];
}

export type SkillCandidateEvaluationReadResult =
  | { kind: 'ok'; value: SkillCandidateEvaluationProjection }
  | { kind: 'http'; status: number }
  | { kind: 'transport' }
  | { kind: 'body' }
  | { kind: 'invalid' };

/**
 * SkillsView-owned read state for the selected candidate's evaluation
 * projection. `idle` means no candidate is selected; the unavailable kinds stay
 * distinct so the evidence section can report why it could not load instead of
 * rendering a misleading empty list.
 */
export type SkillCandidateEvaluationLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; candidateId: string }
  | { kind: 'loaded'; candidateId: string; projection: SkillCandidateEvaluationProjection }
  | { kind: 'http'; candidateId: string; status: number }
  | { kind: 'transport'; candidateId: string }
  | { kind: 'body'; candidateId: string }
  | { kind: 'invalid'; candidateId: string };

const SKILL_CANDIDATE_STATUS_VALUES: readonly SkillCandidateStatus[] = [
  'candidate',
  'promoted',
  'rejected',
  'staged',
  'rolled_back',
];

const SKILL_CANDIDATE_DECISIONS: readonly SkillCandidateEvaluationDecision[] = [
  'accepted',
  'rejected',
  'inconclusive',
];

const HEX_64 = /^[0-9a-fA-F]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSkillCandidateStatus(value: unknown): value is SkillCandidateStatus {
  return typeof value === 'string' && (SKILL_CANDIDATE_STATUS_VALUES as readonly string[]).includes(value);
}

function isSkillCandidateDecision(value: unknown): value is SkillCandidateEvaluationDecision {
  return typeof value === 'string' && (SKILL_CANDIDATE_DECISIONS as readonly string[]).includes(value);
}

function decodeEvaluationCandidate(value: unknown): SkillCandidateEvaluationCandidate | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const contentDigest = value.content_digest;
  const artifactDigest = value.artifact_digest;
  if (!isNonEmptyString(id) || !isHex64(contentDigest) || !isHex64(artifactDigest)) return null;
  return { id, content_digest: contentDigest, artifact_digest: artifactDigest };
}

function decodeEvaluationCoverage(value: unknown): SkillCandidateEvaluationCoverage | null {
  if (!isRecord(value)) return null;
  const plannedTaskCount = value.planned_task_count;
  const seedsPerTask = value.seeds_per_task;
  const armsPerBlock = value.arms_per_block;
  const plannedBlockCount = value.planned_block_count;
  const plannedOutcomeCount = value.planned_outcome_count;
  const observedOutcomeCount = value.observed_outcome_count;
  const missingOutcomeCount = value.missing_outcome_count;
  if (!isNonNegativeSafeInteger(plannedTaskCount)) return null;
  if (!isNonNegativeSafeInteger(seedsPerTask)) return null;
  if (!isNonNegativeSafeInteger(armsPerBlock)) return null;
  if (!isNonNegativeSafeInteger(plannedBlockCount)) return null;
  if (!isNonNegativeSafeInteger(plannedOutcomeCount)) return null;
  if (!isNonNegativeSafeInteger(observedOutcomeCount)) return null;
  if (!isNonNegativeSafeInteger(missingOutcomeCount)) return null;
  return {
    planned_task_count: plannedTaskCount,
    seeds_per_task: seedsPerTask,
    arms_per_block: armsPerBlock,
    planned_block_count: plannedBlockCount,
    planned_outcome_count: plannedOutcomeCount,
    observed_outcome_count: observedOutcomeCount,
    missing_outcome_count: missingOutcomeCount,
  };
}

function decodeEvaluationCriterion(value: unknown): SkillCandidateEvaluationCriterion | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const description = value.description;
  const threshold = value.threshold;
  const observed = value.observed;
  const status = value.status;
  const reason = value.reason;
  if (!isNonEmptyString(id)) return null;
  if (typeof description !== 'string') return null;
  if (!isFiniteNumber(threshold)) return null;
  if (observed !== null && !isFiniteNumber(observed)) return null;
  if (!isNonEmptyString(status)) return null;
  if (reason !== null && typeof reason !== 'string') return null;
  return {
    id,
    description,
    threshold,
    observed: observed === null ? null : observed,
    status,
    reason: reason === null ? null : reason,
  };
}

function decodeEvaluation(value: unknown): SkillCandidateEvaluation | null {
  if (!isRecord(value)) return null;
  const reportHash = value.report_hash;
  const recordHash = value.record_hash;
  const manifestHash = value.manifest_hash;
  const decision = value.decision;
  const generatedAt = value.generated_at;
  if (!isHex64(reportHash) || !isHex64(recordHash) || !isHex64(manifestHash)) return null;
  if (!isSkillCandidateDecision(decision)) return null;
  if (!isNonEmptyString(generatedAt)) return null;
  const candidate = decodeEvaluationCandidate(value.candidate);
  if (!candidate) return null;
  const coverage = decodeEvaluationCoverage(value.coverage);
  if (!coverage) return null;
  if (!Array.isArray(value.criteria)) return null;
  const criteria: SkillCandidateEvaluationCriterion[] = [];
  for (const raw of value.criteria) {
    const criterion = decodeEvaluationCriterion(raw);
    if (!criterion) return null;
    criteria.push(criterion);
  }
  if (!Array.isArray(value.reasons)) return null;
  const reasons: string[] = [];
  for (const raw of value.reasons) {
    if (typeof raw !== 'string') return null;
    reasons.push(raw);
  }
  const observedStatus = value.observed_status;
  const observedVersion = value.observed_version;
  const contentMatch = value.content_match;
  const stale = value.stale;
  if (!isSkillCandidateStatus(observedStatus)) return null;
  if (!isNonNegativeSafeInteger(observedVersion)) return null;
  if (typeof contentMatch !== 'boolean') return null;
  if (typeof stale !== 'boolean') return null;
  return {
    report_hash: reportHash,
    record_hash: recordHash,
    manifest_hash: manifestHash,
    decision,
    generated_at: generatedAt,
    candidate,
    coverage,
    criteria,
    reasons,
    observed_status: observedStatus,
    observed_version: observedVersion,
    content_match: contentMatch,
    stale,
  };
}

export function decodeSkillCandidateEvaluation(body: unknown): SkillCandidateEvaluationProjection | null {
  if (!isRecord(body)) return null;
  const candidateId = body.candidate_id;
  const currentStatus = body.current_status;
  const currentVersion = body.current_version;
  const count = body.count;
  const evaluationsRaw = body.evaluations;
  if (!isNonEmptyString(candidateId)) return null;
  if (!isSkillCandidateStatus(currentStatus)) return null;
  if (!isNonNegativeSafeInteger(currentVersion)) return null;
  if (!isNonNegativeSafeInteger(count)) return null;
  if (!Array.isArray(evaluationsRaw)) return null;
  if (count !== evaluationsRaw.length) return null;
  const evaluations: SkillCandidateEvaluation[] = [];
  for (const raw of evaluationsRaw) {
    const evaluation = decodeEvaluation(raw);
    if (!evaluation) return null;
    if (evaluation.candidate.id !== candidateId) return null;
    evaluations.push(evaluation);
  }
  return {
    candidate_id: candidateId,
    current_status: currentStatus,
    current_version: currentVersion,
    count,
    evaluations,
  };
}

export async function readCandidateEvaluation(candidateId: string): Promise<SkillCandidateEvaluationReadResult> {
  let res: Response;
  try {
    res = await fetch(`${BUN_URL}/skills/candidates/${encodeURIComponent(candidateId)}/evaluation`);
  } catch {
    return { kind: 'transport' };
  }
  const status = typeof res.status === 'number' ? res.status : 0;
  if (!res.ok) return { kind: 'http', status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'body' };
  }
  const value = decodeSkillCandidateEvaluation(body);
  // The route is candidate-scoped: a body for a different candidate is not a
  // valid read of this request, regardless of how well-formed it is.
  if (!value || value.candidate_id !== candidateId) return { kind: 'invalid' };
  return { kind: 'ok', value };
}

/**
 * Authoritative confirmation for one candidate mutation. Eval/reject are
 * confirmed from the candidate snapshot alone; promote/rollback additionally
 * require the freshly read evaluation projection to carry the exact pinned
 * report+record once, accepted, against the same candidate content, with the
 * record's observed pre-state matching the expected lifecycle transition.
 * A stale record is only acceptable because the expected transition advanced
 * the candidate out from under it — any other shape stays unconfirmed.
 */
function confirmCandidateMutation(
  candidateId: string,
  mutation: SkillCandidateMutation,
  authoritative: SkillCandidateSnapshot | undefined,
  readback: SkillCandidateEvaluationReadResult | null,
): boolean {
  if (!authoritative) return false;
  if (mutation.action !== 'promote' && mutation.action !== 'rollback') {
    return skillCandidateMutationConfirmed(mutation, authoritative);
  }
  if (!skillCandidateMutationConfirmed(mutation, authoritative)) return false;
  if (!readback || readback.kind !== 'ok') return false;
  const projection = readback.value;
  if (projection.candidate_id !== candidateId) return false;
  const targetStatus = mutation.action === 'promote' ? 'promoted' : 'rolled_back';
  if (projection.current_status !== targetStatus) return false;
  if (projection.current_version !== mutation.expectedVersion + 1) return false;
  if (mutation.reportHash === undefined || mutation.recordHash === undefined) return false;
  const matches = projection.evaluations.filter(
    (record) => record.record_hash === mutation.recordHash && record.report_hash === mutation.reportHash,
  );
  if (matches.length !== 1) return false;
  const record = matches[0];
  if (record.decision !== 'accepted') return false;
  if (record.candidate.id !== candidateId) return false;
  if (mutation.contentDigest !== undefined && record.candidate.content_digest !== mutation.contentDigest) return false;
  if (mutation.artifactDigest !== undefined && record.candidate.artifact_digest !== mutation.artifactDigest) return false;
  if (record.content_match !== true) return false;
  if (record.stale !== true) return false;
  const expectedObservedVersion =
    mutation.action === 'promote' ? mutation.expectedVersion : mutation.expectedVersion - 1;
  if (record.observed_status !== 'staged') return false;
  if (record.observed_version !== expectedObservedVersion) return false;
  return true;
}

// ── Detail panel ───────────────────────────────────────────────

function SkillDetail({
  skill,
  candidateDetail,
  candidateCurrent,
  candidateMutation,
  evaluationLoad: evaluationLoadProp,
  selectedEvaluationHash,
  onSelectEvaluation,
  onRetryEvaluation,
  onCandidateAction,
  onRetryCandidate,
  onClose,
  onToggle,
  togglePending,
  toggleError,
  onChanged,
}: {
  skill: Skill;
  candidateDetail: SkillCandidateDetail | null;
  candidateCurrent: boolean;
  candidateMutation: SkillCandidateMutation | null;
  evaluationLoad: SkillCandidateEvaluationLoadState;
  selectedEvaluationHash: string | null;
  onSelectEvaluation: (recordHash: string) => void;
  onRetryEvaluation: () => void;
  onCandidateAction: (action: SkillCandidateAction, reasonCode?: string) => void;
  onRetryCandidate: () => void;
  onClose: () => void;
  onToggle: (skill: Skill) => void;
  togglePending: boolean;
  toggleError: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'body' | 'revisions'>('body');
  const [revisions, setRevisions] = useState<SkillRevision[] | null>(null);
  const [loadingRevs, setLoadingRevs] = useState(false);
  const [revError, setRevError] = useState<string | null>(null);
  const [rollbackReasonSelection, setRollbackReasonSelection] = useState<{
    candidateId: string;
    reasonCode: RollbackReasonCode;
  } | null>(null);
  // The active reason is derived from both the candidate it was chosen for and
  // the reason itself, so a reason chosen for another candidate is never shown
  // as this candidate's selection — including on the render before effects run.
  const rollbackReason: RollbackReasonCode | '' =
    candidateDetail && rollbackReasonSelection?.candidateId === candidateDetail.id
      ? rollbackReasonSelection.reasonCode
      : '';
  const { success, error: toastError } = useToast();
  const distilled = isDistilledSkill(skill);
  const candidateActionLocked = skillCandidateMutationLocked(candidateMutation);

  const evaluationRadioName = useId();
  // A load tagged for a candidate other than the one being shown cannot describe
  // it. Until effects run for the newly selected candidate, present the previous
  // selection's load as still-loading rather than rendering its projection or
  // error under the new candidate.
  const evaluationLoad: SkillCandidateEvaluationLoadState =
    evaluationLoadProp.kind === 'idle' || evaluationLoadProp.candidateId === candidateDetail?.id
      ? evaluationLoadProp
      : { kind: 'loading', candidateId: evaluationLoadProp.candidateId };
  const evaluationProjection = evaluationLoad.kind === 'loaded' ? evaluationLoad.projection : null;
  const candidateLifecycleVersion = candidateDetail?.lifecycle_version ?? 0;
  // A record may only be marked eligible when it was accepted against the same
  // candidate, is neither stale nor content-mismatched, and the projection's
  // current status/version exactly match the candidate detail we are showing.
  const evaluationEligibility = (record: SkillCandidateEvaluation): boolean => {
    if (!candidateDetail || !evaluationProjection) return false;
    return (
      record.decision === 'accepted' &&
      record.stale === false &&
      record.content_match === true &&
      record.candidate.id === candidateDetail.id &&
      evaluationProjection.candidate_id === candidateDetail.id &&
      evaluationProjection.current_status === candidateDetail.status &&
      evaluationProjection.current_version === candidateLifecycleVersion
    );
  };
  const evaluationIneligibilityReason = (record: SkillCandidateEvaluation): string => {
    if (!candidateDetail || !evaluationProjection) return 'Ineligible — no current candidate';
    if (record.decision !== 'accepted') return 'Ineligible — decision not accepted';
    if (record.stale) return 'Ineligible — stale record';
    if (!record.content_match) return 'Ineligible — content mismatch';
    if (record.candidate.id !== candidateDetail.id) return 'Ineligible — different candidate';
    if (evaluationProjection.candidate_id !== candidateDetail.id) return 'Ineligible — projection for a different candidate';
    if (evaluationProjection.current_status !== candidateDetail.status) return 'Ineligible — candidate status changed';
    if (evaluationProjection.current_version !== candidateLifecycleVersion) return 'Ineligible — candidate version changed';
    return 'Ineligible';
  };

  // The selection is a hash, never an implicit first row. It only counts when it
  // resolves to exactly one displayed record.
  const selectedEvaluationRecord = useMemo<SkillCandidateEvaluation | null>(() => {
    if (!evaluationProjection || !selectedEvaluationHash) return null;
    const matches = evaluationProjection.evaluations.filter(
      (record) => record.record_hash === selectedEvaluationHash,
    );
    return matches.length === 1 ? matches[0] : null;
  }, [evaluationProjection, selectedEvaluationHash]);
  const selectedEvaluationEligible = selectedEvaluationRecord !== null && evaluationEligibility(selectedEvaluationRecord);
  // Promotion consumes the record observed at the current staged version;
  // rollback consumes the record observed at the staged version immediately
  // before the current promoted version.
  const selectedPromotionEligible =
    selectedEvaluationEligible &&
    candidateDetail?.status === 'staged' &&
    selectedEvaluationRecord?.observed_status === 'staged' &&
    selectedEvaluationRecord?.observed_version === candidateLifecycleVersion;
  const selectedRollbackEligible =
    candidateDetail?.status === 'promoted' &&
    evaluationProjection !== null &&
    evaluationProjection.candidate_id === candidateDetail.id &&
    evaluationProjection.current_status === candidateDetail.status &&
    evaluationProjection.current_version === candidateLifecycleVersion &&
    selectedEvaluationRecord !== null &&
    selectedEvaluationRecord.decision === 'accepted' &&
    selectedEvaluationRecord.content_match === true &&
    selectedEvaluationRecord.stale === true &&
    selectedEvaluationRecord.candidate.id === candidateDetail.id &&
    selectedEvaluationRecord.observed_status === 'staged' &&
    selectedEvaluationRecord.observed_version === candidateLifecycleVersion - 1;
  // The exact prior staged accepted record selected for rollback stays
  // meaningful after promotion even though it is now stale. It is not
  // generically ineligible; it is the prior-state evidence rollback consumes.
  const isPriorStateRollbackEvidence = (record: SkillCandidateEvaluation): boolean =>
    selectedRollbackEligible &&
    selectedEvaluationRecord !== null &&
    record.report_hash === selectedEvaluationRecord.report_hash &&
    record.record_hash === selectedEvaluationRecord.record_hash;

  const performanceCandidateId = candidateDetail?.status === 'promoted' ? candidateDetail.id : null;
  const [performanceState, setPerformanceState] = useState<CandidatePerformanceState>(initialCandidatePerformanceState);
  const performanceRequestId = useRef(0);
  const performancePending = useRef(false);
  const readPerformance = useCallback(async (retry: boolean) => {
    if (retry && performancePending.current) return;
    const requestId = ++performanceRequestId.current;
    performancePending.current = true;
    if (!performanceCandidateId) {
      setPerformanceState((prev) => reduceCandidatePerformance(prev, { type: 'invalidate', requestId }));
      performancePending.current = false;
      return;
    }
    setPerformanceState((prev) => reduceCandidatePerformance(prev, { type: 'start', requestId }));
    const response = await readCandidatePerformance(performanceCandidateId);
    setPerformanceState((prev) => reduceCandidatePerformance(prev, { type: 'settle', requestId, response }));
    if (requestId === performanceRequestId.current) performancePending.current = false;
  }, [performanceCandidateId]);

  useEffect(() => {
    void readPerformance(false);
  }, [readPerformance]);

  const performanceView = candidatePerformanceView(performanceState);

  const loadRevisions = useCallback(async () => {
    setLoadingRevs(true);
    setRevError(null);
    try {
      const revs = await invoke<SkillRevision[]>('skill_revisions_list', {
        skillId: skill.id,
        limit: 50,
      });
      setRevisions(revs);
    } catch (e) {
      setRevError(String(e));
    } finally {
      setLoadingRevs(false);
    }
  }, [skill.id]);

  useEffect(() => {
    if (tab === 'revisions' && revisions === null) loadRevisions();
  }, [tab, revisions, loadRevisions]);

  const restore = useCallback(
    async (rev: SkillRevision) => {
      try {
        await invoke<boolean>('skill_restore_revision', { revisionId: rev.id });
        success(`Restored ${skill.name} to v${rev.version}`, 'Revision restored');
        await loadRevisions();
        onChanged();
      } catch (e) {
        toastError(String(e), 'Restore failed');
      }
    },
    [skill.name, loadRevisions, onChanged, success, toastError],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot ok={skill.enabled} warn={!skill.enabled} />
            <h3 className="text-base font-semibold text-bone truncate">{skill.name}</h3>
            <Pill variant="default">v{skill.version}</Pill>
          </div>
          <p className="text-xs text-bone/50 mt-1">{skill.description}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-bone/40 hover:text-bone text-lg leading-none px-2"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3">
        {distilled ? (
          <div className="flex items-center gap-2">
            {candidateDetail && (
              <button
                type="button"
                disabled={candidateActionLocked || !candidateCurrent}
                onClick={() => onCandidateAction('eval')}
                className="px-3 py-1.5 text-xs rounded-lg border border-white/10 text-bone/70 hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                Run eval
              </button>
            )}
            {candidateDetail?.status === 'candidate' && (
              <button
                type="button"
                disabled={candidateActionLocked || !candidateCurrent}
                onClick={() => onCandidateAction('reject')}
                className="px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors disabled:opacity-50"
              >
                Reject
              </button>
            )}
            {candidateDetail?.status === 'staged' && (
              <button
                type="button"
                disabled={candidateActionLocked || !candidateCurrent || !selectedPromotionEligible}
                title={
                  selectedPromotionEligible
                    ? 'Promote this staged candidate against the explicitly selected evaluation record.'
                    : 'Promotion requires an explicitly selected eligible accepted evaluation record for this staged candidate.'
                }
                onClick={() => onCandidateAction('promote')}
                className="px-3 py-1.5 text-xs rounded-lg border border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
              >
                Promote
              </button>
            )}
            {candidateDetail?.status === 'promoted' && (
              <>
                <select
                  value={rollbackReason}
                  onChange={(e) => {
                    const value = e.target.value;
                    setRollbackReasonSelection(
                      candidateDetail && isRollbackReasonCode(value)
                        ? { candidateId: candidateDetail.id, reasonCode: value }
                        : null,
                    );
                  }}
                  aria-label="Rollback reason"
                  disabled={candidateActionLocked || !candidateCurrent}
                  className="px-2 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-bone disabled:opacity-50"
                >
                  <option value="" disabled>
                    Rollback reason…
                  </option>
                  <option value="regression_detected">Regression detected</option>
                  <option value="superseded_by_newer_evidence">Superseded by newer evidence</option>
                  <option value="manual_rollback">Manual rollback</option>
                </select>
                <button
                  type="button"
                  disabled={
                    candidateActionLocked ||
                    !candidateCurrent ||
                    !selectedRollbackEligible ||
                    !isRollbackReasonCode(rollbackReason)
                  }
                  title={
                    selectedRollbackEligible
                      ? 'Roll back this promoted candidate against the selected evaluation record.'
                      : 'Rollback requires an explicitly selected eligible accepted record and a chosen reason.'
                  }
                  onClick={() => {
                    if (
                      candidateDetail &&
                      rollbackReasonSelection?.candidateId === candidateDetail.id &&
                      isRollbackReasonCode(rollbackReason)
                    ) {
                      onCandidateAction('rollback', rollbackReason);
                    }
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg border border-amber-500/30 text-amber-200 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
                >
                  Rollback
                </button>
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onToggle(skill)}
            disabled={togglePending}
            className={cn(
              'px-3 py-1.5 text-xs rounded-lg border transition-colors',
              skill.enabled
                ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
            )}
          >
            {togglePending ? (skill.enabled ? 'Disabling…' : 'Enabling…') : skill.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
        <div
          className="ml-auto flex gap-1 text-[11px]"
          role="tablist"
          aria-label="Skill detail tabs"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') setTab('revisions');
            else if (e.key === 'ArrowLeft') setTab('body');
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'body'}
            tabIndex={tab === 'body' ? 0 : -1}
            onClick={() => setTab('body')}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors',
              tab === 'body' ? 'bg-white/10 text-bone' : 'text-bone/40 hover:text-bone/70',
            )}
          >
            Body
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'revisions'}
            tabIndex={tab === 'revisions' ? 0 : -1}
            onClick={() => setTab('revisions')}
            className={cn(
              'px-2.5 py-1 rounded-md transition-colors',
              tab === 'revisions' ? 'bg-white/10 text-bone' : 'text-bone/40 hover:text-bone/70',
            )}
          >
            Revisions
          </button>
        </div>
      </div>

      {candidateMutation?.phase === 'write-failed' && (
        <div role="status" aria-label="Candidate lifecycle status" className="mb-3 text-xs text-red-200">
          Could not update candidate lifecycle. Showing the last confirmed state.{' '}
          <button type="button" onClick={onRetryCandidate} className="underline">Retry</button>
        </div>
      )}
      {candidateMutation?.phase === 'read-failed' && (
        <div role="status" aria-label="Candidate lifecycle status" className="mb-3 text-xs text-amber-200">
          {candidateMutation.writeAccepted
            ? 'The lifecycle write was accepted, but its completion could not be confirmed.'
            : 'The request outcome was not confirmed, and the lifecycle write could not be verified.'}{' '}
          Showing the last confirmed state.{' '}
                           <button type="button" onClick={onRetryCandidate} className="underline">Retry</button>
        </div>
      )}

      {!distilled && toggleError && (
        <div role="alert" className="mb-3 text-xs text-red-200">
          Could not update skill enablement. Showing last confirmed state: {skill.enabled ? 'enabled' : 'disabled'}.{' '}
          <button type="button" disabled={togglePending} onClick={() => onToggle(skill)} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}

      {candidateDetail && (
        <GlassCard className="p-3 mb-3 text-xs space-y-1.5">
          {!candidateCurrent && <p className="text-amber-200">Previous lifecycle observation; it may be stale. Actions are unavailable.</p>}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-bone/50">Confidence</span>
            <Pill variant="default">{candidateDetail.confidence.toFixed(2)}</Pill>
            {candidateDetail.eval_score !== undefined && (
              <>
                <span className="text-bone/50">Eval score</span>
                <Pill variant={candidateDetail.eval_score >= 0.75 ? 'success' : 'warn'}>
                  {candidateDetail.eval_score.toFixed(2)}
                </Pill>
              </>
            )}
            {candidateDetail.status === 'rejected' && candidateDetail.rejection_reason && (
              <>
                <span className="text-bone/50">Rejected</span>
                <Pill variant="error">{candidateDetail.rejection_reason}</Pill>
              </>
            )}
            {candidateDetail.promoted_at && (
              <>
                <span className="text-bone/50">Promoted</span>
                <span className="text-bone/70">{formatDate(candidateDetail.promoted_at)}</span>
              </>
            )}
          </div>
          {candidateDetail.rejection_detail && (
            <p className="text-bone/50">{candidateDetail.rejection_detail}</p>
          )}
          {candidateDetail.eval_missed && candidateDetail.eval_missed.length > 0 && (
            <p className="text-bone/50">Missed: {candidateDetail.eval_missed.join('; ')}</p>
          )}
          <div className="flex items-center gap-3 text-bone/40 font-mono text-[10px]">
            {candidateDetail.source_session_id && <span>session {candidateDetail.source_session_id}</span>}
            {candidateDetail.source_run_ids.length > 0 && (
              <span>runs {candidateDetail.source_run_ids.join(', ')}</span>
            )}
          </div>
          {candidateDetail.status === 'promoted' && performanceView && (
            <div
              role="group"
              aria-label="Skill performance since promotion"
              className="pt-1.5 mt-1.5 border-t border-white/10 space-y-1"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-bone/50">Since promotion</span>
                {performanceView.measured && (
                  <>
                    <span className="text-bone/70">
                      {performanceView.measured.before.rate}
                      {' → '}
                      {performanceView.measured.after.rate}
                    </span>
                    {performanceView.measured.delta ? (
                      <Pill variant={performanceView.measured.delta.positive ? 'success' : 'error'}>
                        {performanceView.measured.delta.text}
                      </Pill>
                    ) : (
                      <span className="text-bone/50">delta —</span>
                    )}
                  </>
                )}
              </div>
              {performanceView.measured && <p className="text-bone/40">{performanceView.measured.text}</p>}
              {performanceView.kind === 'pending' && <p role="status" className="text-bone/50">{performanceView.text}</p>}
              {performanceView.failureText && (
                <div role="alert" className="text-amber-200">
                  {performanceView.failureText}{' '}
                  <button
                    type="button"
                    disabled={performanceView.kind === 'pending'}
                    onClick={() => void readPerformance(true)}
                    className="underline disabled:opacity-40"
                  >
                    Retry
                  </button>
                </div>
              )}
              {performanceView.kind === 'unmeasured' && <p className="text-bone/50">{performanceView.text}</p>}
            </div>
          )}
        </GlassCard>
      )}

      {evaluationLoad.kind !== 'idle' && (
        <GlassCard className="p-3 mb-3 text-xs space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-bone/80">Evaluation evidence</h4>
            {evaluationProjection && (
              <span className="text-bone/40 font-mono text-[10px]">
                current {evaluationProjection.current_status} v{evaluationProjection.current_version}
                {' · '}
                {evaluationProjection.count} record{evaluationProjection.count === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {evaluationLoad.kind === 'loading' && (
            <p role="status" className="text-bone/50">Loading evaluation evidence…</p>
          )}
          {(evaluationLoad.kind === 'http' ||
            evaluationLoad.kind === 'transport' ||
            evaluationLoad.kind === 'body' ||
            evaluationLoad.kind === 'invalid') && (
            <div role="alert" className="text-amber-200">
              Evaluation evidence unavailable
              {evaluationLoad.kind === 'http' ? ` (HTTP ${evaluationLoad.status})` : ''}.{' '}
              <button type="button" onClick={onRetryEvaluation} className="underline">Retry</button>
            </div>
          )}
          {evaluationLoad.kind === 'loaded' &&
            (evaluationLoad.projection.evaluations.length === 0 ? (
              <p className="text-bone/50">No evaluation records recorded for this candidate.</p>
            ) : (
              <ul className="space-y-2">
                {evaluationLoad.projection.evaluations.map((record) => {
                  const eligible = evaluationEligibility(record);
                  const priorStateRollbackEvidence = !eligible && isPriorStateRollbackEvidence(record);
                  const selected = selectedEvaluationHash === record.record_hash;
                  return (
                    <li
                      key={record.record_hash}
                      className={cn(
                        'rounded-lg border p-2 space-y-1.5',
                        selected ? 'border-accent/40 bg-white/[0.06]' : 'border-white/10',
                      )}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name={evaluationRadioName}
                            checked={selected}
                            onChange={() => onSelectEvaluation(record.record_hash)}
                          />
                          <span className="font-medium text-bone">{record.decision}</span>
                        </label>
                        {eligible ? (
                          <Pill variant="success">Eligible</Pill>
                        ) : priorStateRollbackEvidence ? (
                          <Pill variant="default">Prior-state rollback evidence (stale)</Pill>
                        ) : (
                          <Pill variant="warn">{evaluationIneligibilityReason(record)}</Pill>
                        )}
                      </div>
                      <p className="text-bone/40 font-mono text-[10px] break-all">report {record.report_hash}</p>
                      <p className="text-bone/40 font-mono text-[10px] break-all">record {record.record_hash}</p>
                      <p className="text-bone/40 font-mono text-[10px] break-all">manifest {record.manifest_hash}</p>
                      <div className="text-bone/50 font-mono text-[10px] break-all">
                        <p>candidate {record.candidate.id}</p>
                        <p>content {record.candidate.content_digest}</p>
                        <p>artifact {record.candidate.artifact_digest}</p>
                      </div>
                      <p className="text-bone/50">
                        tasks {record.coverage.planned_task_count}
                        {' · '}seeds/task {record.coverage.seeds_per_task}
                        {' · '}arms/block {record.coverage.arms_per_block}
                        {' · '}blocks {record.coverage.planned_block_count}
                        {' · '}outcomes {record.coverage.observed_outcome_count}/{record.coverage.planned_outcome_count}
                        {' · '}missing {record.coverage.missing_outcome_count}
                      </p>
                      {record.criteria.length > 0 && (
                        <ul className="space-y-0.5">
                          {record.criteria.map((criterion) => (
                            <li key={criterion.id} className="text-bone/50">
                              <span className="text-bone/70">{criterion.description || criterion.id}</span>
                              {' — '}threshold {criterion.threshold}
                              {' · '}observed {criterion.observed === null ? '—' : criterion.observed}
                              {' · '}{criterion.status}
                              {criterion.reason ? ` (${criterion.reason})` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                      {record.reasons.length > 0 && (
                        <ul className="list-disc pl-4 text-bone/50 space-y-0.5">
                          {record.reasons.map((reason, index) => (
                            <li key={`${record.record_hash}-reason-${index}`}>{reason}</li>
                          ))}
                        </ul>
                      )}
                      <p className="text-bone/40">
                        observed {record.observed_status} v{record.observed_version}
                        {' · '}content {record.content_match ? 'match' : 'mismatch'}
                        {' · '}{record.stale ? 'stale' : 'current'}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ))}
        </GlassCard>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === 'body' ? (
          skill.body ? (
            <GlassCard className="p-4">
              <MarkdownRenderer content={skill.body} />
            </GlassCard>
          ) : (
            <EmptyState message="This skill has no stored body." />
          )
        ) : loadingRevs ? (
          <LoadingState message="Loading revisions…" />
        ) : revError ? (
          <ErrorState error={revError} onRetry={loadRevisions} />
        ) : !revisions || revisions.length === 0 ? (
          <EmptyState message="No revision history for this skill yet." />
        ) : (
          <ul className="space-y-2">
            {revisions.map((rev) => (
              <li key={rev.id}>
                <GlassCard className="p-3">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-xs font-medium text-bone">
                      v{rev.version}
                      <span className="ml-2 text-[10px] font-mono text-bone/30">
                        {formatDate(rev.created_at)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => restore(rev)}
                      className="text-[11px] px-2 py-0.5 rounded-md border border-royal/40 text-royal-light hover:bg-royal/10 transition-colors"
                    >
                      Restore
                    </button>
                  </div>
                  <p className="text-xs text-bone/60">{rev.change_reason || 'No reason recorded.'}</p>
                </GlassCard>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Optional observations never own the native list's loading lifetime. Refreshes
// supersede older reads; Retry is guarded and only repeats this resource's read.
function useSkillObservation<S>(read: () => Promise<S>) {
  const [state, setState] = useState(initialRegistryState<S>);
  const requestId = useRef(0);
  const pending = useRef(false);
  const current = useRef(false);
  const refresh = useCallback(async (retry = false): Promise<S | null> => {
    if (retry && pending.current) return null;
    const id = ++requestId.current;
    pending.current = true;
    current.current = false;
    setState((prev) => reduceRegistryState(prev, { type: 'pending', requestId: id }));
    try {
      const snapshot = await read();
      if (id === requestId.current) current.current = true;
      setState((prev) => reduceRegistryState(prev, { type: 'success', requestId: id, snapshot }));
      return snapshot;
    } catch {
      setState((prev) => reduceRegistryState(prev, { type: 'failure', requestId: id }));
      return null;
    } finally {
      if (id === requestId.current) pending.current = false;
    }
  }, [read]);
  return { state, refresh, current };
}

async function readRuntimeSkills() {
  const result = await invoke<any[]>('jarvis_get_skills');
  if (!Array.isArray(result)) throw new Error('Invalid skills observation');
  return result;
}

async function readRuntimeTools() {
  const result = await invoke<any[]>('jarvis_get_tools');
  if (!Array.isArray(result)) throw new Error('Invalid tools observation');
  return result;
}

async function readCandidates() {
  const res = await fetch(`${BUN_URL}/skills/candidates`);
  if (!res.ok) throw new Error('Candidate observation unavailable');
  const body = await res.json();
  if (!Array.isArray(body?.candidates)) throw new Error('Invalid candidate observation');
  const byId: Record<string, SkillCandidateDetail> = {};
  for (const value of body.candidates) {
    if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
      throw new Error('Invalid candidate observation');
    }
    const candidate = value as SkillCandidateDetail;
    const version = candidate.lifecycle_version;
    byId[candidate.id] = {
      ...candidate,
      lifecycle_version: Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : 0,
    };
  }
  return byId;
}

function ObservationFeedback<S>({ label, state, onRetry }: {
  label: string;
  state: RegistrySnapshotState<S>;
  onRetry: () => void;
}) {
  return (
    <>
      {state.loading && <div role="status">Loading {label}…</div>}
      {state.error && (
        <div role="alert" className="text-amber-200">
          Could not load {label}.{' '}
          {state.snapshot !== null && 'Showing previous observations; they may be stale. '}
          <button type="button" disabled={state.loading} onClick={onRetry} className="underline disabled:opacity-40">Retry</button>
        </div>
      )}
      {state.loading && !state.error && state.snapshot !== null && <p>Showing previous observations; they may be stale.</p>}
    </>
  );
}

// ── Main view ──────────────────────────────────────────────────

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const pendingToggles = useRef(new Set<string>());
  const [togglePending, setTogglePending] = useState<Record<string, boolean>>({});
  const [toggleError, setToggleError] = useState<Record<string, boolean>>({});
  const protections = useRef<Record<string, SkillToggleProtection<boolean>>>({});
  const candidateMutationRef = useRef<Record<string, SkillCandidateMutation | undefined>>({});
  const [candidateMutations, setCandidateMutations] = useState<Record<string, SkillCandidateMutation | undefined>>({});
  const nextCandidateMutationToken = useRef(0);
  const listReadId = useRef(0);
  const { state: runtimeSkills, refresh: refreshRuntimeSkills } = useSkillObservation(readRuntimeSkills);
  const { state: runtimeTools, refresh: refreshRuntimeTools } = useSkillObservation(readRuntimeTools);
  const { state: candidateState, refresh: refreshCandidates, current: candidatesCurrent } = useSkillObservation(readCandidates);
  const candidates = candidateState.snapshot;
  const candidateCurrent = candidates !== null && !candidateState.loading && !candidateState.error;
  const canUseCandidate = useCallback(() => candidatesCurrent.current, [candidatesCurrent]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailId = useId();
  const inspectionButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);
  const { success } = useToast();

  const publishCandidateMutation = useCallback((candidateId: string, mutation: SkillCandidateMutation | null) => {
    candidateMutationRef.current[candidateId] = mutation ?? undefined;
    setCandidateMutations((previous) => {
      const next = { ...previous };
      if (mutation) next[candidateId] = mutation;
      else delete next[candidateId];
      return next;
    });
  }, []);

  const closeInspection = () => {
    const opener = selectedId ? inspectionButtons.current.get(selectedId) : null;
    setSelectedId(null);
    // Filtering or a refreshed list may have removed the selected row.
    if (opener?.isConnected) opener.focus();
    else searchInput.current?.focus();
  };

  const fetchSkills = useCallback(async (includeCandidates = true) => {
    const readId = ++listReadId.current;
    void refreshRuntimeSkills();
    void refreshRuntimeTools();
    if (includeCandidates) void refreshCandidates();
    setLoading(true);
    setError(null);
    try {
      try {
        await invoke<number>('sync_distilled_skill_candidates');
      } catch {
        /* Bun may not have written candidates yet */
      }
      const list = await invoke<Skill[]>('list_skills');
      if (readId !== listReadId.current) return;
      const reconciled = applySkillListRead(list, protections.current, readId);
      protections.current = reconciled.protections;
      setSkills(reconciled.skills);

    } catch (e) {
      if (readId === listReadId.current) setError(String(e));
    } finally {
      if (readId === listReadId.current) setLoading(false);
    }
  }, [refreshRuntimeSkills, refreshRuntimeTools, refreshCandidates]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const toggle = useCallback(
    async (skill: Skill) => {
      if (isDistilledSkill(skill) || pendingToggles.current.has(skill.id)) return;
      pendingToggles.current.add(skill.id);
      setTogglePending((prev) => ({ ...prev, [skill.id]: true }));
      const next = !skill.enabled;
      // Concurrent reads must not publish an in-flight write as confirmed.
      protections.current[skill.id] = { target: skill.enabled, barrierReadId: Infinity };
      try {
        await invoke<void>(next ? 'enable_skill' : 'disable_skill', { name: skill.name });
        protections.current[skill.id] = { target: next, barrierReadId: listReadId.current };
        setSkills((prev) => confirmSkillToggle(prev, skill.id, next));
        setToggleError((prev) => ({ ...prev, [skill.id]: false }));
        success(`${next ? 'Enabled' : 'Disabled'} ${skill.name}`);
      } catch {
        protections.current[skill.id] = { target: skill.enabled, barrierReadId: listReadId.current };
        setToggleError((prev) => ({ ...prev, [skill.id]: true }));
      } finally {
        pendingToggles.current.delete(skill.id);
        setTogglePending((prev) => ({ ...prev, [skill.id]: false }));
      }
    },
    [success],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (filter === 'enabled' && !s.enabled) return false;
      if (filter === 'disabled' && s.enabled) return false;
      if (filter === 'candidates' && !isDistilledCandidate(s)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (categoryOf(s)?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [skills, query, filter]);

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );
   const selectedCandidate = useMemo(() => {
     if (!selected) return null;
     const cid = candidateIdOf(selected);
     return cid ? candidates?.[cid] ?? null : null;
   }, [selected, candidates]);
   const selectedCandidateId = selected ? candidateIdOf(selected) : null;
   const selectedCandidateMutation = selectedCandidateId ? candidateMutations[selectedCandidateId] ?? null : null;

   const [evaluationLoad, setEvaluationLoad] = useState<SkillCandidateEvaluationLoadState>({ kind: 'idle' });
   const [selectedEvaluationHash, setSelectedEvaluationHash] = useState<string | null>(null);
   const evaluationRequestId = useRef(0);

   const loadCandidateEvaluation = useCallback(
     (candidateId: string): Promise<SkillCandidateEvaluationReadResult | null> => {
       const requestId = ++evaluationRequestId.current;
       setEvaluationLoad({ kind: 'loading', candidateId });
       return readCandidateEvaluation(candidateId).then((result) => {
         // A late response from a superseded selection must not render here, and
         // its readback must not be handed to a caller acting on a newer request.
         if (requestId !== evaluationRequestId.current) return null;
         if (result.kind === 'ok') setEvaluationLoad({ kind: 'loaded', candidateId, projection: result.value });
         else if (result.kind === 'http') setEvaluationLoad({ kind: 'http', candidateId, status: result.status });
         else if (result.kind === 'transport') setEvaluationLoad({ kind: 'transport', candidateId });
         else if (result.kind === 'body') setEvaluationLoad({ kind: 'body', candidateId });
         else setEvaluationLoad({ kind: 'invalid', candidateId });
         return result;
       });
     },
     [],
   );

   useEffect(() => {
     // Selection is explicit and candidate-scoped: reset it whenever the
     // candidate changes, and never fall back to an implicit default record.
     setSelectedEvaluationHash(null);
     if (selectedCandidateId) {
       void loadCandidateEvaluation(selectedCandidateId);
     } else {
       evaluationRequestId.current += 1;
       setEvaluationLoad({ kind: 'idle' });
     }
   }, [selectedCandidateId, loadCandidateEvaluation]);

   const retryCandidateEvaluation = useCallback(() => {
     if (selectedCandidateId) void loadCandidateEvaluation(selectedCandidateId);
   }, [selectedCandidateId, loadCandidateEvaluation]);

   const enabledCount = skills.filter((s) => s.enabled).length;

  const runCandidateAction = useCallback(
    async (
      skill: Skill,
      candidateId: string,
      action: SkillCandidateAction,
      options?: { reasonCode?: string; retryOf?: SkillCandidateMutation },
    ) => {
      if (!canUseCandidate()) return;
      const observed = candidates?.[candidateId];
      if (!observed) return;
      const existing = candidateMutationRef.current[candidateId];
      if (skillCandidateMutationLocked(existing)) return;

      const retryOf = options?.retryOf;
      const isProofAction = action === 'promote' || action === 'rollback';
      let expectedVersion = observed.lifecycle_version ?? 0;
      let observedStatus: SkillCandidateStatus = observed.status;
      let proof: SkillCandidateMutationProof | undefined;

      if (isProofAction) {
        // Promote/rollback are only ever issued from a confirmed current
        // observation against an explicitly selected record read fresh here.
        if (!candidateCurrent) return;
        if (retryOf) {
          // Retries replay the exact captured proof tuple. The current UI
          // selection is never consulted. Before resending, a fresh candidate
          // read and a fresh evaluation read must both still match every
          // captured field; otherwise the write-failed state is retained and
          // nothing is POSTed.
          if (retryOf.action !== action) return;
          if (retryOf.reportHash === undefined || retryOf.recordHash === undefined) return;
          if (action === 'rollback' && !isRollbackReasonCode(retryOf.reasonCode)) return;
          // The captured rollback timestamp is replayed exactly; a non-canonical
          // one refuses the retry rather than generating a fresh value.
          if (action === 'rollback' && !isCanonicalIsoTimestamp(retryOf.eventTimestamp)) return;
          const capturedReportHash = retryOf.reportHash;
          const capturedRecordHash = retryOf.recordHash;
          const freshCandidates = await refreshCandidates();
          const freshCandidate = freshCandidates?.[candidateId] ?? null;
          if (!skillCandidateMutationRetryPreflight(retryOf, freshCandidate)) return;
          expectedVersion = retryOf.expectedVersion;
          observedStatus = retryOf.observedStatus;
          const readback = await loadCandidateEvaluation(candidateId);
          if (!readback || readback.kind !== 'ok') return;
          const projection = readback.value;
          if (projection.candidate_id !== candidateId) return;
          if (projection.current_status !== observedStatus) return;
          if (projection.current_version !== expectedVersion) return;
          const pinned = projection.evaluations.filter(
            (record) =>
              record.record_hash === capturedRecordHash &&
              record.report_hash === capturedReportHash,
          );
          if (pinned.length !== 1) return;
          const record = pinned[0];
          if (record.candidate.id !== candidateId) return;
          if (record.decision !== 'accepted') return;
          if (record.content_match !== true) return;
          if (record.candidate.content_digest !== retryOf.contentDigest) return;
          if (record.candidate.artifact_digest !== retryOf.artifactDigest) return;
          if (action === 'promote') {
            if (record.stale !== false) return;
            if (record.observed_status !== 'staged') return;
            if (record.observed_version !== expectedVersion) return;
          } else {
            if (record.stale !== true) return;
            if (record.observed_status !== 'staged') return;
            if (record.observed_version !== expectedVersion - 1) return;
          }
          proof = {
            reportHash: capturedReportHash,
            recordHash: capturedRecordHash,
            reasonCode: retryOf.reasonCode,
            contentDigest: retryOf.contentDigest,
            artifactDigest: retryOf.artifactDigest,
            eventTimestamp: action === 'rollback' ? retryOf.eventTimestamp : undefined,
          };
        } else {
          if (action === 'promote' && observed.status !== 'staged') return;
          if (action === 'rollback' && observed.status !== 'promoted') return;
          if (action === 'rollback' && !isRollbackReasonCode(options?.reasonCode)) return;
          if (selectedEvaluationHash === null) return;
          const readback = await loadCandidateEvaluation(candidateId);
          if (!readback || readback.kind !== 'ok') return;
          const projection = readback.value;
          if (projection.candidate_id !== candidateId) return;
          if (projection.current_status !== observed.status) return;
          if (projection.current_version !== (observed.lifecycle_version ?? 0)) return;
          const matches = projection.evaluations.filter(
            (record) => record.record_hash === selectedEvaluationHash,
          );
          if (matches.length !== 1) return;
          const record = matches[0];
          if (record.decision !== 'accepted') return;
          if (record.content_match !== true) return;
          if (record.candidate.id !== candidateId) return;
          if (action === 'promote') {
            if (record.stale !== false) return;
            if (record.observed_status !== 'staged') return;
            if (record.observed_version !== (observed.lifecycle_version ?? 0)) return;
          } else {
            if (record.stale !== true) return;
            if (record.observed_status !== 'staged') return;
            if (record.observed_version !== (observed.lifecycle_version ?? 0) - 1) return;
          }
          proof = {
            reportHash: record.report_hash,
            recordHash: record.record_hash,
            reasonCode: action === 'rollback' ? options?.reasonCode : undefined,
            contentDigest: record.candidate.content_digest,
            artifactDigest: record.candidate.artifact_digest,
            // One timestamp is minted per explicitly selected rollback action and
            // captured in the immutable proof tuple before the mutation begins.
            eventTimestamp: action === 'rollback' ? new Date().toISOString() : undefined,
          };
        }
      }

      const token = ++nextCandidateMutationToken.current;
      const mutation = startSkillCandidateMutation(
        candidateId,
        action,
        expectedVersion,
        token,
        observedStatus,
        proof,
      );
      publishCandidateMutation(candidateId, mutation);
      const isCurrent = () => candidateMutationRef.current[candidateId]?.token === token;
      const response = await postSkillCandidateAction(
        candidateId,
        action,
        expectedVersion,
        isProofAction ? proof?.reasonCode : options?.reasonCode,
        proof,
      );
      if (!isCurrent()) return;

      if (isProofAction) {
        // The POST is only a request outcome. For promote/rollback success is
        // whatever the authoritative candidate + evaluation readback confirms,
        // regardless of the response status. `writeAccepted` records only
        // whether the request itself was accepted, never confirmation.
        const reconciling = transitionSkillCandidateMutation(mutation, 'request-finished', response.ok);
        if (!reconciling) return;
        publishCandidateMutation(candidateId, reconciling);
        const snapshot = await refreshCandidates();
        if (!isCurrent()) return;
        const authoritative = snapshot?.[candidateId];
        const readback = await loadCandidateEvaluation(candidateId);
        if (!isCurrent()) return;
        if (!confirmCandidateMutation(candidateId, reconciling, authoritative, readback)) {
          // Only a conclusive readback plus a route error that names a
          // mutation-free refusal becomes the definitive write-failed state; a
          // failed/malformed readback or an ambiguous response stays read-failed
          // so retry/reconciliation can still prove the true state.
          const readbackConclusive =
            snapshot !== null && authoritative !== undefined && readback?.kind === 'ok';
          const refused =
            readbackConclusive && skillCandidateMutationDefinitiveRefusal(response.status, response.data.error);
          publishCandidateMutation(
            candidateId,
            transitionSkillCandidateMutation(reconciling, refused ? 'write-failed' : 'read-failed'),
          );
          return;
        }
        publishCandidateMutation(candidateId, null);
        success(`${action === 'promote' ? 'Promoted' : 'Rolled back'} ${skill.name}`);
        void fetchSkills(false);
        return;
      }

      if (!response.ok) {
        if (response.status === 400) {
          publishCandidateMutation(candidateId, transitionSkillCandidateMutation(mutation, 'write-failed'));
          return;
        }
        const reconciling = transitionSkillCandidateMutation(mutation, 'conflict');
        if (!reconciling) return;
        publishCandidateMutation(candidateId, reconciling);
        const snapshot = await refreshCandidates();
        if (!isCurrent()) return;
        const authoritative = snapshot?.[candidateId];
        if (snapshot && authoritative && skillCandidateMutationConfirmed(reconciling, authoritative)) {
          publishCandidateMutation(candidateId, null);
          success(`${authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : action === 'eval' ? 'Evaluated' : 'Updated'} ${skill.name}`);
        } else {
          publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        }
        return;
      }
      const reconciling = transitionSkillCandidateMutation(mutation, 'write-succeeded');
      if (!reconciling) return;
      publishCandidateMutation(candidateId, reconciling);
      const snapshot = await refreshCandidates();
      if (!isCurrent()) return;
      const authoritative = snapshot?.[candidateId];
      if (!snapshot || !authoritative || !skillCandidateMutationConfirmed(reconciling, authoritative)) {
        publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        return;
      }
      publishCandidateMutation(candidateId, null);
      const outcome = authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : 'Evaluated';
      success(`${outcome} ${skill.name}`);
      void fetchSkills(false);
    },
    [
      candidateCurrent,
      candidates,
      canUseCandidate,
      fetchSkills,
      loadCandidateEvaluation,
      publishCandidateMutation,
      refreshCandidates,
      selectedEvaluationHash,
      success,
    ],
  );

  const retryCandidateMutation = useCallback(
    async (skill: Skill, candidateId: string) => {
      const mutation = candidateMutationRef.current[candidateId];
      if (!mutation) return;
      if (mutation.phase === 'write-failed') {
        await runCandidateAction(skill, candidateId, mutation.action, { retryOf: mutation });
        return;
      }
      if (mutation.phase !== 'read-failed') return;
      const reconciling = transitionSkillCandidateMutation(mutation, 'retry-read');
      if (!reconciling) return;
      publishCandidateMutation(candidateId, reconciling);
      const token = reconciling.token;
      const snapshot = await refreshCandidates();
      if (candidateMutationRef.current[candidateId]?.token !== token) return;
      const authoritative = snapshot?.[candidateId];
      let readback: SkillCandidateEvaluationReadResult | null = null;
      if (reconciling.action === 'promote' || reconciling.action === 'rollback') {
        readback = await loadCandidateEvaluation(candidateId);
        if (candidateMutationRef.current[candidateId]?.token !== token) return;
      }
      if (!snapshot || !authoritative || !confirmCandidateMutation(candidateId, reconciling, authoritative, readback)) {
        publishCandidateMutation(candidateId, transitionSkillCandidateMutation(reconciling, 'read-failed'));
        return;
      }
      publishCandidateMutation(candidateId, null);
      const outcome = authoritative.status === 'promoted' ? 'Promoted' : authoritative.status === 'rejected' ? 'Rejected' : authoritative.status === 'rolled_back' ? 'Rolled back' : 'Evaluated';
      success(`${outcome} ${skill.name}`);
      void fetchSkills(false);
    },
    [fetchSkills, loadCandidateEvaluation, publishCandidateMutation, refreshCandidates, runCandidateAction, success],
  );

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Skills"
        subtitle="Browse, toggle, inspect, and restore skill revisions"
        count={skills.length}
        action={
          <Pill variant={enabledCount > 0 ? 'success' : 'default'}>
            {enabledCount} enabled
          </Pill>
        }
      />

      <div className="flex gap-2">
        <input
          ref={searchInput}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills…"
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="px-2 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone"
        >
          <option value="all">All</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="candidates">Distilled candidates</option>
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs max-h-40 overflow-y-auto shrink-0">
        <section aria-label="Runtime skills" className="p-3 rounded-lg border border-white/10">
          <h3 className="font-semibold text-cyan-200">Runtime skills</h3>
          <ObservationFeedback label="runtime skills" state={runtimeSkills} onRetry={() => { void refreshRuntimeSkills(true); }} />
          {runtimeSkills.snapshot !== null && (
            runtimeSkills.snapshot.length > 0
              ? <p>{runtimeSkills.snapshot.map((skill: any) => skill.name || JSON.stringify(skill)).join(', ')}</p>
              : !runtimeSkills.loading && !runtimeSkills.error && <p>No runtime skills observed.</p>
          )}
        </section>
        <section aria-label="Runtime tools" className="p-3 rounded-lg border border-white/10">
          <h3 className="font-semibold text-cyan-200">Runtime tools</h3>
          <ObservationFeedback label="runtime tools" state={runtimeTools} onRetry={() => { void refreshRuntimeTools(true); }} />
          {runtimeTools.snapshot !== null && (
            runtimeTools.snapshot.length > 0
              ? <p>{runtimeTools.snapshot.map((tool: any) => tool.name || JSON.stringify(tool)).join(', ')}</p>
              : !runtimeTools.loading && !runtimeTools.error && <p>No runtime tools observed.</p>
          )}
        </section>
        <section aria-label="Skill candidates" className="p-3 rounded-lg border border-white/10">
          <h3 className="font-semibold text-cyan-200">Skill candidates</h3>
          <ObservationFeedback label="skill candidates" state={candidateState} onRetry={() => { void refreshCandidates(true); }} />
          {candidates !== null && (
            Object.keys(candidates).length > 0
              ? <p>{Object.keys(candidates).length} candidate observations</p>
              : candidateCurrent && <p>No skill candidates observed.</p>
          )}
        </section>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        <div className={cn('overflow-y-auto min-h-0', selected ? 'w-1/2' : 'flex-1')}>
          {loading ? (
            <LoadingState message="Loading skills…" />
          ) : error ? (
            <ErrorState error={error} onRetry={fetchSkills} />
          ) : filtered.length === 0 ? (
            <EmptyState message="No skills match the current filter." />
          ) : (
            <ul className="space-y-2">
              {filtered.map((s) => {
                const category = categoryOf(s);
                const distilled = isDistilledSkill(s);
                const candidateId = candidateIdOf(s);
                const candidate = candidateId ? candidates?.[candidateId] : null;
                 const candidateStatus = candidate?.status;
                 const candidateMutation = candidateId ? candidateMutations[candidateId] ?? null : null;
                 const candidateActionLocked = skillCandidateMutationLocked(candidateMutation);
                return (
                  <li key={s.id}>
                    <GlassCard
                      onClick={() => setSelectedId(s.id)}
                      hoverable
                      className={cn(
                        'p-3',
                        selectedId === s.id && 'border-accent/40 bg-white/[0.06]',
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <StatusDot ok={s.enabled} warn={!s.enabled} />
                        <h3 className="text-sm font-medium text-bone truncate">
                          <button
                            type="button"
                            ref={(node) => {
                              if (node) inspectionButtons.current.set(s.id, node);
                              else inspectionButtons.current.delete(s.id);
                            }}
                            aria-label={`Inspect skill: ${s.name}`}
                            aria-pressed={selectedId === s.id}
                            aria-controls={`${detailId}-${s.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(s.id);
                            }}
                            className="max-w-full truncate text-left rounded cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-neon focus-visible:outline-offset-2"
                          >
                            {s.name}
                          </button>
                        </h3>
                        {category && (
                          <span className="text-[10px] rounded-full bg-white/5 border border-white/10 px-1.5 py-0.5 text-bone/50">
                            {category}
                          </span>
                        )}
                        {distilled && (
                          <span className="text-[10px] rounded-full bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 text-amber-200/80">
                            {candidateStatus ? `${candidateStatus}${candidateCurrent ? '' : ' (previous observation; may be stale)'}` : 'Lifecycle observation unavailable.'}
                          </span>
                        )}
                        {distilled && candidateId ? (
                          <div className="ml-auto flex gap-1">
                            {candidateStatus === 'candidate' && (
                              <button
                                type="button"
                                 disabled={!candidateCurrent || candidateActionLocked}
                                onClick={(e) => {
                                  e.stopPropagation();
                                   runCandidateAction(s, candidateId, 'reject');
                                }}
                                className="text-[11px] px-2 py-0.5 rounded-md border border-red-500/30 text-red-200 hover:bg-red-500/10 transition-colors"
                              >
                                Reject
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(s);
                            }}
                            disabled={distilled || togglePending[s.id] === true}
                            className={cn(
                              'ml-auto text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                              s.enabled
                                ? 'border-amber-500/30 text-amber-200 hover:bg-amber-500/10'
                                : 'border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/10',
                            )}
                          >
                            {togglePending[s.id] ? (s.enabled ? 'Disabling…' : 'Enabling…') : s.enabled ? 'Disable' : 'Enable'}
                          </button>
                        )}
                      </div>
                       <p className="text-xs text-bone/60 line-clamp-2">{s.description}</p>
                       {candidateMutation?.phase === 'write-failed' && (
                         <div role="alert" aria-label={`Candidate lifecycle: ${s.name}`} className="mt-1 text-xs text-red-200">
                           Could not update candidate lifecycle. Showing the last confirmed state.{' '}
                           <button type="button" onClick={(e) => { e.stopPropagation(); void retryCandidateMutation(s, candidateId!); }} className="underline">Retry</button>
                         </div>
                       )}
                       {candidateMutation?.phase === 'read-failed' && (
                         <div role="alert" aria-label={`Candidate lifecycle: ${s.name}`} className="mt-1 text-xs text-amber-200">
                           {candidateMutation.writeAccepted
                             ? 'The lifecycle write was accepted, but its completion could not be confirmed.'
                             : 'The request outcome was not confirmed, and the lifecycle write could not be verified.'}{' '}
                           Showing the last confirmed state.{' '}
                           <button type="button" onClick={(e) => { e.stopPropagation(); void retryCandidateMutation(s, candidateId!); }} className="underline">Retry</button>
                         </div>
                       )}
                      {!distilled && toggleError[s.id] && (
                        <div role="alert" className="mt-1 text-xs text-red-200">
                          Could not update skill enablement. Showing last confirmed state: {s.enabled ? 'enabled' : 'disabled'}.{' '}
                          <button type="button" disabled={togglePending[s.id] === true} onClick={(e) => { e.stopPropagation(); toggle(s); }} className="underline disabled:opacity-40">Retry</button>
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono text-bone/30">
                        <span>v{s.version}</span>
                        {s.improvement_score > 0 && (
                          <span>score {s.improvement_score.toFixed(2)}</span>
                        )}
                        <span className="ml-auto">{formatDate(s.updated_at)}</span>
                      </div>
                    </GlassCard>
                  </li>
                );
              })}
            </ul>
          )}
        </div>


        {selected && (
          <div
            id={`${detailId}-${selected.id}`}
            role="region"
            aria-label={`Skill details: ${selected.name}`}
            className="w-1/2 min-h-0"
          >
            <GlassCard className="p-4 h-full">
              <SkillDetail
                key={selected.id}
                skill={selected}
                 candidateDetail={selectedCandidate}
                 candidateCurrent={candidateCurrent}
                 candidateMutation={selectedCandidateMutation}
                 evaluationLoad={evaluationLoad}
                 selectedEvaluationHash={selectedEvaluationHash}
                 onSelectEvaluation={setSelectedEvaluationHash}
                 onRetryEvaluation={retryCandidateEvaluation}
                 onCandidateAction={(action, reasonCode) => {
                   if (selectedCandidate) void runCandidateAction(selected, selectedCandidate.id, action, { reasonCode });
                 }}
                 onRetryCandidate={() => {
                   if (selectedCandidateId) void retryCandidateMutation(selected, selectedCandidateId);
                 }}
                 onClose={closeInspection}
                onToggle={toggle}
                togglePending={togglePending[selected.id] === true}
                toggleError={toggleError[selected.id] === true}
                onChanged={fetchSkills}
              />
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  );
}

export default SkillsView;
