// ── GoalsView — durable user-owned Goals with acceptance criteria ──
//    (goal_create/goal_list/goal_get/goal_update/goal_transition/
//     goal_links_list). Completion is never inferred here: trusted acceptance
//    runs only through the native ToolRuntime/trusted manifest, and an
//    accepted/completed state is shown only after a durable native readback of
//    the exact acceptance receipt, Goal terminal evidence, and Action Registry
//    terminal state.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cn,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  EmptyState,
  type StatusVariant,
} from '../ui';
import {
  acceptanceStatusVariant,
  criterionEvidenceSummary,
  deepJsonEqual,
  evidenceSummary,
  executionStatusVariant,
  isTrustedAcceptanceReceipt,
  isTrustedExecutionReceipt,
  isTrustedManifestSummary,
  manifestAcceptanceChecks,
  manifestAcceptanceKeys,
  normalizeRoot,
  type TrustedAcceptanceCriterionReceipt,
  type TrustedAcceptanceReceipt,
  type TrustedExecutionReceipt,
  type TrustedManifestSummary,
} from './trusted-receipt-state';
import type { GoalNotificationSelector, WorkflowDestination, WorkflowNavigationSelector } from './types';
import WorkflowReadinessPanel, { type WorkflowReadinessItem } from './WorkflowReadinessPanel';

interface Goal {
  id: string;
  objective: string;
  status: string;
  agent_id: string;
  project_root: string | null;
  objective_authority: string;
  created_at: string;
  updated_at: string;
}

interface GoalCriterion {
  id: string;
  goal_id: string;
  ordinal: number;
  text: string;
  authority: string;
  created_at: string;
}

interface GoalLink {
  id: string;
  goal_id: string;
  target_kind: string;
  target_id: string;
  created_at: string;
}

interface GoalEvent {
  id: string;
  goal_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor: string;
  reason: string;
  created_at: string;
}

interface GoalDetail {
  goal: Goal;
  criteria: GoalCriterion[];
  links: GoalLink[];
  events: GoalEvent[];
}

interface GoalRunProgress {
  goal_id: string;
  session_id: string;
  run_id: string;
  outcome: string;
  goal_status: string;
  interrupted: boolean;
  resumable: boolean;
  evidence_refs: string[];
  accepted_output_pending: boolean;
  finished_at: string | null;
}

interface CommitmentRecord {
  id: string;
  text: string;
  status: string;
  due: string | null;
  created_at: string;
  completed_at: string | null;
  agent_id: string | null;
  goal_id: string | null;
}

interface CronSchedule {
  id: string;
  name: string;
  schedule: string;
  agent_id: string;
  session_id: string | null;
  enabled: boolean;
  last_run: string | null;
  next_run: string | null;
  run_count: number;
  goal_id: string | null;
}

/** Optional runtime receipt carried on a Cron run (never Goal acceptance). */
interface CronExecutionEvidence {
  run_id: string;
  status: string;
  acceptance_result: string | null;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * Per-run receipt state. Distinguishes an explicit `null` evidence (native
 * Option) from a present-but-malformed evidence object, so the UI never hides a
 * malformed receipt behind the same "none" rendering.
 */
type CronRunReceipt =
  | { kind: 'present'; evidence: CronExecutionEvidence }
  | { kind: 'absent' }
  | { kind: 'malformed' };

interface CronActivation {
  activation_id: string;
  cron_id: string;
  goal_id: string | null;
  agent_id: string;
  session_id: string | null;
  project_root: string | null;
  schedule_occurrence: string;
  trigger_kind: string;
  claim_state: string;
  run_id: string | null;
  bun_run_id: string | null;
  terminal_reason: string | null;
  claimed_at: string;
  dispatched_at: string | null;
  settled_at: string | null;
}

interface CronRunRecord {
  id: string;
  cron_id: string;
  status: string;
  output: string;
  error: string;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
  execution_evidence: CronRunReceipt;
  activation_id: string | null;
  schedule_occurrence: string | null;
  goal_id: string | null;
  terminal_reason: string | null;
}

type LinkTargetKind = 'cron_job' | 'commitment';

/** Persisted Session authority used to prove a cron job's workspace scope. */
interface SessionScopeRow {
  id: string;
  agent_id: string;
  project_root: string | null;
}

/**
 * Candidate rows for explicit Goal linking, read only from the owning native
 * authorities and bound to the current Goal/request generation. A failed or
 * malformed read is an unavailable candidate set, never an empty one.
 */
type LinkCandidatesState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      jobs: CronSchedule[];
      commitments: CommitmentRecord[];
      sessions: SessionScopeRow[];
    };

/**
 * One explicit link/unlink operation. A write whose exact Goal-side link and
 * target-side `goal_id` readback do not agree stays unresolved and is only
 * reconciled by a read-only Refresh; it is never repeated automatically.
 */
interface LinkOp {
  kind: 'link' | 'unlink';
  targetKind: LinkTargetKind;
  targetId: string;
  phase: 'writing' | 'write-failed' | 'read-failed';
  message?: string;
}

type ScheduleOpKind = 'pause' | 'resume' | 'run' | 'cancel';
type ScheduleOpPhase = 'writing' | 'write-failed' | 'read-failed';

interface ScheduleOp {
  kind: ScheduleOpKind;
  jobId: string;
  goalId: string;
  phase: ScheduleOpPhase;
  message?: string;
  /**
   * Immutable operation context captured at submission so the requested effect
   * can be reconciled later without re-submitting. `expectedEnabled` is the
   * enabled value a pause (false) or resume (true) must reach; the baseline
   * activation/run ids and submission time let Run now require newly observed
   * evidence after the action.
   */
  expectedEnabled?: boolean;
  baselineActivationIds?: string[];
  baselineRunIds?: string[];
  submittedAt?: string;
}

/**
 * Result of an authoritative schedule read. `ok` reports the observed enabled
 * state, in-flight set, and the readable activation/run history per linked job,
 * so a pending mutation is only cleared when the specific effect it requested is
 * actually evidenced. Jobs whose history read failed are omitted from
 * `activationsByJob`/`runsByJob` (their UI error flags remain set) so a missing
 * key is unavailable, never an empty authoritative history.
 */
type ScheduleRefreshResult =
  | { status: 'stale' }
  | { status: 'unavailable' }
  | {
      status: 'ok';
      linkedJobIds: Set<string>;
      enabledByJob: Record<string, boolean>;
      inFlight: Set<string>;
      activationsByJob: Record<string, CronActivation[]>;
      runsByJob: Record<string, CronRunRecord[]>;
    };

const TRANSITION_STATUSES = ['running', 'waiting_for_user', 'blocked', 'paused', 'failed', 'cancelled'];
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/** Activation claim states that require a specific user/reconciliation action. */
const ACTIONABLE_CLAIM_STATES = ['waiting_for_user', 'blocked', 'ambiguous'];

const STATUS_VARIANT: Record<string, StatusVariant> = {
  pending: 'default',
  running: 'info',
  waiting_for_user: 'warn',
  blocked: 'error',
  paused: 'default',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
};

function statusVariant(status: string): StatusVariant {
  return STATUS_VARIANT[status] ?? 'default';
}

function allowedTransitions(status: string): string[] {
  if (TERMINAL_STATUSES.includes(status)) return [];
  return TRANSITION_STATUSES.filter((s) => s !== status);
}

const CLAIM_VARIANT: Record<string, StatusVariant> = {
  claimed: 'info',
  dispatched: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
  ambiguous: 'warn',
  waiting_for_user: 'warn',
  blocked: 'error',
};

function claimVariant(state: string): StatusVariant {
  return CLAIM_VARIANT[state] ?? 'default';
}

function actionableLabel(state: string): string {
  if (state === 'waiting_for_user') return 'Waiting for you';
  if (state === 'blocked') return 'Blocked';
  if (state === 'ambiguous') return 'Needs reconciliation';
  return state;
}

function cronRunVariant(status: string): StatusVariant {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'timeout') return 'warn';
  return 'default';
}

function scheduleOpVerb(kind: ScheduleOpKind): string {
  if (kind === 'pause') return 'pause';
  if (kind === 'resume') return 'resume';
  if (kind === 'cancel') return 'cancel';
  return 'run';
}

/** A write is in flight, so a read-only reconcile must not race it. */
function hasWritingScheduleOp(ops: Record<string, ScheduleOp>): boolean {
  return Object.values(ops).some((op) => op.phase === 'writing');
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isAtOrAfter(timestamp: string | null | undefined, reference: number): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= reference;
}

// ── Strict native activation/run decoding ────────────────────────────────────
//
// Native `CronActivation`/`CronRun`/`CronExecutionEvidence` DTOs are decoded
// field-by-field. A malformed collection or row is unavailable (null), never a
// silently-cast or empty authoritative history; a valid empty array is genuine
// "none recorded".

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A required string field; a missing/non-string value is malformed. */
function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * An `Option<String>` field that native serializes as an explicit `null` or a
 * string. Returns `undefined` for a missing/malformed value (malformed), `null`
 * for an explicit null, and the string otherwise.
 */
function nullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * A required identity field. A missing/non-string value, or an empty or
 * whitespace-only string, is malformed so a blank ID can never join or verify.
 */
function requiredIdentity(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}

/**
 * An optional identity field: explicit `null` is a legitimate "absent", but a
 * present empty/whitespace-only string (or any non-string/non-null value, or a
 * missing key) is malformed.
 */
function nullableIdentity(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value;
}

function decodeCronExecutionEvidence(value: unknown): CronExecutionEvidence | null {
  if (!isRecord(value)) return null;
  const runId = requiredIdentity(value, 'run_id');
  const status = requiredString(value, 'status');
  const acceptanceResult = nullableString(value, 'acceptance_result');
  const errorCode = nullableString(value, 'error_code');
  const startedAt = nullableString(value, 'started_at');
  const finishedAt = nullableString(value, 'finished_at');
  if (runId === null || status === null) return null;
  if (
    acceptanceResult === undefined ||
    errorCode === undefined ||
    startedAt === undefined ||
    finishedAt === undefined
  ) {
    return null;
  }
  return {
    run_id: runId,
    status,
    acceptance_result: acceptanceResult,
    error_code: errorCode,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function decodeCronActivation(value: unknown): CronActivation | null {
  if (!isRecord(value)) return null;
  const activationId = requiredIdentity(value, 'activation_id');
  const cronId = requiredIdentity(value, 'cron_id');
  const agentId = requiredIdentity(value, 'agent_id');
  const occurrence = requiredIdentity(value, 'schedule_occurrence');
  const triggerKind = requiredString(value, 'trigger_kind');
  const claimState = requiredString(value, 'claim_state');
  const claimedAt = requiredString(value, 'claimed_at');
  const goalId = nullableIdentity(value, 'goal_id');
  const sessionId = nullableIdentity(value, 'session_id');
  const projectRoot = nullableIdentity(value, 'project_root');
  const runId = nullableIdentity(value, 'run_id');
  const bunRunId = nullableIdentity(value, 'bun_run_id');
  const terminalReason = nullableString(value, 'terminal_reason');
  const dispatchedAt = nullableString(value, 'dispatched_at');
  const settledAt = nullableString(value, 'settled_at');
  if (
    activationId === null ||
    cronId === null ||
    agentId === null ||
    occurrence === null ||
    triggerKind === null ||
    claimState === null ||
    claimedAt === null
  ) {
    return null;
  }
  if (
    goalId === undefined ||
    sessionId === undefined ||
    projectRoot === undefined ||
    runId === undefined ||
    bunRunId === undefined ||
    terminalReason === undefined ||
    dispatchedAt === undefined ||
    settledAt === undefined
  ) {
    return null;
  }
  return {
    activation_id: activationId,
    cron_id: cronId,
    goal_id: goalId,
    agent_id: agentId,
    session_id: sessionId,
    project_root: projectRoot,
    schedule_occurrence: occurrence,
    trigger_kind: triggerKind,
    claim_state: claimState,
    run_id: runId,
    bun_run_id: bunRunId,
    terminal_reason: terminalReason,
    claimed_at: claimedAt,
    dispatched_at: dispatchedAt,
    settled_at: settledAt,
  };
}

function decodeCronRunRecord(value: unknown): CronRunRecord | null {
  if (!isRecord(value)) return null;
  const id = requiredIdentity(value, 'id');
  const cronId = requiredIdentity(value, 'cron_id');
  const status = requiredString(value, 'status');
  const startedAt = requiredString(value, 'started_at');
  const output = requiredString(value, 'output');
  const error = requiredString(value, 'error');
  const durationMs = value.duration_ms;
  const finishedAt = nullableString(value, 'finished_at');
  const activationId = nullableIdentity(value, 'activation_id');
  const occurrence = nullableIdentity(value, 'schedule_occurrence');
  const goalId = nullableIdentity(value, 'goal_id');
  const terminalReason = nullableString(value, 'terminal_reason');
  if (id === null || cronId === null || status === null || startedAt === null) return null;
  if (output === null || error === null) return null;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
  if (
    finishedAt === undefined ||
    activationId === undefined ||
    occurrence === undefined ||
    goalId === undefined ||
    terminalReason === undefined
  ) {
    return null;
  }
  let executionEvidence: CronRunReceipt;
  if (value.execution_evidence === undefined) {
    // The native contract requires this field (Option): an absent property is a
    // malformed outer row.
    return null;
  } else if (value.execution_evidence === null) {
    executionEvidence = { kind: 'absent' };
  } else {
    const decoded = decodeCronExecutionEvidence(value.execution_evidence);
    executionEvidence =
      decoded === null ? { kind: 'malformed' } : { kind: 'present', evidence: decoded };
  }
  return {
    id,
    cron_id: cronId,
    status,
    output,
    error,
    duration_ms: durationMs,
    started_at: startedAt,
    finished_at: finishedAt,
    execution_evidence: executionEvidence,
    activation_id: activationId,
    schedule_occurrence: occurrence,
    goal_id: goalId,
    terminal_reason: terminalReason,
  };
}

function decodeCronActivationArray(value: unknown): CronActivation[] | null {
  if (!Array.isArray(value)) return null;
  const out: CronActivation[] = [];
  for (const row of value) {
    const decoded = decodeCronActivation(row);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

function decodeCronRunArray(value: unknown): CronRunRecord[] | null {
  if (!Array.isArray(value)) return null;
  const out: CronRunRecord[] = [];
  for (const row of value) {
    const decoded = decodeCronRunRecord(row);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

/**
 * Exact run↔activation relation: Cron, Goal, activation, and occurrence must
 * all agree, and when the activation records a run id it must equal the run id.
 * Anything else is a separate/unavailable relation, never a synthesized success.
 */
function runMatchesActivation(run: CronRunRecord, activation: CronActivation): boolean {
  if (run.activation_id === null) return false;
  if (activation.activation_id !== run.activation_id) return false;
  if (activation.cron_id !== run.cron_id) return false;
  if (activation.goal_id !== run.goal_id) return false;
  if (activation.schedule_occurrence !== run.schedule_occurrence) return false;
  if (activation.run_id !== null && activation.run_id !== run.id) return false;
  return true;
}

function joinedRunForActivation(
  activation: CronActivation,
  runs: CronRunRecord[],
): CronRunRecord | null {
  const matches = runs.filter((run) => runMatchesActivation(run, activation));
  return matches.length === 1 ? matches[0] : null;
}

function matchedActivationForRun(
  run: CronRunRecord,
  activations: CronActivation[],
): CronActivation | null {
  const matches = activations.filter((activation) => runMatchesActivation(run, activation));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Whether one operation's requested effect is evidenced by an authoritative
 * readback. This is the single predicate applied both immediately after the
 * command's readback and later by the read-only Refresh, so an uncertain op is
 * only cleared when its own effect is observed:
 *   * pause/resume — the job must now show the expected enabled value;
 *   * run — activation and run history must be readable and show evidence newer
 *     than the recorded baseline (or, when the baseline was unreadable before
 *     submission, evidence at/after the recorded submission time);
 *   * cancel — the tracked in-flight execution must now be absent, with history
 *     still readable.
 * A job missing from the linked list, or whose history was unreadable, is never
 * treated as reconciled.
 */
function scheduleOpReconciled(
  op: ScheduleOp,
  result: Extract<ScheduleRefreshResult, { status: 'ok' }>,
): boolean {
  const jobId = op.jobId;
  if (!result.linkedJobIds.has(jobId)) return false;

  if (op.kind === 'pause' || op.kind === 'resume') {
    return result.enabledByJob[jobId] === op.expectedEnabled;
  }

  // A missing key means the history read for that job was unavailable.
  if (!hasOwn(result.activationsByJob, jobId) || !hasOwn(result.runsByJob, jobId)) {
    return false;
  }
  const activations = result.activationsByJob[jobId];
  const runs = result.runsByJob[jobId];

  if (op.kind === 'run') {
    if (op.baselineActivationIds !== undefined && op.baselineRunIds !== undefined) {
      const newActivation = activations.some(
        (activation) => !op.baselineActivationIds!.includes(activation.activation_id),
      );
      const newRun = runs.some((run) => !op.baselineRunIds!.includes(run.id));
      return newActivation || newRun;
    }
    // No readable baseline before submission: only accept evidence that is newer
    // than the recorded submission time.
    if (!op.submittedAt) return false;
    const submitted = Date.parse(op.submittedAt);
    if (!Number.isFinite(submitted)) return false;
    const newActivation = activations.some((activation) =>
      isAtOrAfter(activation.claimed_at, submitted),
    );
    const newRun = runs.some((run) => isAtOrAfter(run.started_at, submitted));
    return newActivation || newRun;
  }

  // cancel: the tracked in-flight execution must be gone after the refresh.
  return !result.inFlight.has(jobId);
}

/**
 * Exact navigation focus resolved from a `goal://notifications` selector against
 * fresh native reads. It is a display focus only: `cronJobId`/`activationId`/
 * `runId` are the exact matching durable IDs, never authority.
 */
interface NotificationFocus {
  goalId: string;
  cronJobId: string | null;
  activationId: string | null;
  runId: string | null;
}

/**
 * Outcome of reconciling a notification selector against the freshly-read Goal,
 * persisted Goal↔Cron association, and exact activation/run tuple. A stale
 * outcome never selects or focuses a different/latest record.
 */
type NotificationReconcile =
  | { status: 'ok'; focus: NotificationFocus }
  | { status: 'stale'; message: string };

const NOTIFICATION_STALE_MESSAGE =
  'This notification selector could not be reconciled with the current native Goal, schedule link, or activation/run rows. Nothing was opened or focused from it; refresh the schedule state or select the Goal manually. No fallback or latest record is substituted.';

/**
 * Reconcile a notification selector against fresh native state. Only an exact
 * tuple (Goal id, persisted Goal↔Cron link, exact activation id with matching
 * Cron/Goal ids, and — when supplied — exact run id with matching Cron/Goal ids
 * and an exact run↔activation relation) resolves to a focus. Anything missing,
 * malformed, or conflicting is stale; the caller must not substitute another
 * record. Selector values are never status, reason, or evidence.
 */
function reconcileNotificationSelector(
  selector: GoalNotificationSelector,
  goalId: string,
  linkedJobIds: Set<string>,
  linkedCronIds: Set<string>,
  activationsByJob: Record<string, CronActivation[]>,
  runsByJob: Record<string, CronRunRecord[]>,
): NotificationReconcile {
  const { cron_job_id, activation_id, run_id } = selector;
  const hasSubSelector =
    cron_job_id !== undefined || activation_id !== undefined || run_id !== undefined;
  if (!hasSubSelector) {
    return { status: 'ok', focus: { goalId, cronJobId: null, activationId: null, runId: null } };
  }
  if (cron_job_id === undefined || !linkedCronIds.has(cron_job_id) || !linkedJobIds.has(cron_job_id)) {
    // A sub-selector without an exact persisted Goal↔Cron association (link
    // projection AND target-side goal_id) cannot be focused; never fall back to
    // another linked job.
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }
  if (!hasOwn(activationsByJob, cron_job_id) || !hasOwn(runsByJob, cron_job_id)) {
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }
  const activations = activationsByJob[cron_job_id];
  const runs = runsByJob[cron_job_id];

  let matchedActivation: CronActivation | null = null;
  if (activation_id !== undefined) {
    const matches = activations.filter(
      (activation) =>
        activation.activation_id === activation_id &&
        activation.cron_id === cron_job_id &&
        activation.goal_id === goalId,
    );
    if (matches.length !== 1) {
      return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
    }
    matchedActivation = matches[0];
  }

  if (run_id !== undefined) {
    const matches = runs.filter(
      (run) => run.id === run_id && run.cron_id === cron_job_id && run.goal_id === goalId,
    );
    if (matches.length !== 1) {
      return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
    }
    if (matchedActivation !== null && !runMatchesActivation(matches[0], matchedActivation)) {
      return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
    }
  }

  return {
    status: 'ok',
    focus: {
      goalId,
      cronJobId: cron_job_id,
      activationId: activation_id ?? null,
      runId: run_id ?? null,
    },
  };
}

/**
 * Fresh, state-free reconciliation of a notification selector against native
 * authority, performed BEFORE any selection/expansion/focus. It reads the exact
 * Goal, the persisted Goal↔Cron link projection, `list_cron_jobs`, and (when a
 * sub-selector is present) that job's activation and run histories, then applies
 * the exact-tuple predicate. A read failure or malformed row is stale, never an
 * empty success, and no other/latest record is substituted.
 */
async function readNotificationSelector(
  selector: GoalNotificationSelector,
): Promise<NotificationReconcile> {
  const goalId = selector.goal_id;
  let detailRaw: unknown;
  try {
    detailRaw = await invoke<unknown>('goal_get', { id: goalId });
  } catch {
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }
  if (!isRecord(detailRaw)) return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  const goal = detailRaw.goal;
  if (!isRecord(goal) || requiredIdentity(goal, 'id') !== goalId) {
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }

  const hasSubSelector =
    selector.cron_job_id !== undefined ||
    selector.activation_id !== undefined ||
    selector.run_id !== undefined;
  if (!hasSubSelector) {
    return { status: 'ok', focus: { goalId, cronJobId: null, activationId: null, runId: null } };
  }
  if (selector.cron_job_id === undefined) {
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }
  const cronJobId = selector.cron_job_id;

  let linksRaw: unknown;
  try {
    linksRaw = await invoke<unknown>('goal_links_list', { goalId });
  } catch {
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }
  if (!Array.isArray(linksRaw)) return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  const linkedCronIds = new Set<string>();
  for (const row of linksRaw) {
    if (!isRecord(row)) return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
    const rowGoalId = requiredIdentity(row, 'goal_id');
    const targetKind = requiredString(row, 'target_kind');
    const targetId = requiredIdentity(row, 'target_id');
    if (rowGoalId === null || targetKind === null || targetId === null) {
      return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
    }
    if (rowGoalId === goalId && targetKind === 'cron_job') linkedCronIds.add(targetId);
  }

  let jobsRaw: unknown;
  try {
    jobsRaw = await invoke<unknown>('list_cron_jobs');
  } catch {
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }
  if (!Array.isArray(jobsRaw)) return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  const linkedJobIds = new Set<string>();
  for (const row of jobsRaw) {
    if (!isRecord(row)) return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
    const jobId = requiredIdentity(row, 'id');
    const jobGoalId = nullableIdentity(row, 'goal_id');
    if (jobId === null || jobGoalId === undefined) {
      return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
    }
    if (jobGoalId === goalId) linkedJobIds.add(jobId);
  }

  let activations: CronActivation[] | null;
  try {
    activations = decodeCronActivationArray(
      await invoke<unknown>('get_cron_activations', { cronId: cronJobId }),
    );
  } catch {
    activations = null;
  }
  let runs: CronRunRecord[] | null;
  try {
    runs = decodeCronRunArray(await invoke<unknown>('get_cron_runs', { cronId: cronJobId }));
  } catch {
    runs = null;
  }
  if (activations === null || runs === null) {
    return { status: 'stale', message: NOTIFICATION_STALE_MESSAGE };
  }

  return reconcileNotificationSelector(
    selector,
    goalId,
    linkedJobIds,
    linkedCronIds,
    { [cronJobId]: activations },
    { [cronJobId]: runs },
  );
}

/**
 * Adapt a cross-workflow Recurring Operator navigation selector to the existing
 * notification selector shape so the same fresh native Goal/link/schedule/
 * activation/run reconciliation is reused. `cron_run_id` and the notification
 * selector's `run_id` denote the same Cron run namespace; this is never a
 * Session run or an Agent run id, and no cross-namespace value is coerced.
 */
function workflowSelectorToNotificationSelector(
  selector: Extract<WorkflowNavigationSelector, { workflow: 'recurring-operator' }>,
): GoalNotificationSelector {
  return {
    goal_id: selector.goal_id,
    ...(selector.cron_job_id !== undefined ? { cron_job_id: selector.cron_job_id } : {}),
    ...(selector.activation_id !== undefined ? { activation_id: selector.activation_id } : {}),
    ...(selector.cron_run_id !== undefined ? { run_id: selector.cron_run_id } : {}),
  };
}


interface ActionRegistryRow {
  id: string;
  status: string;
}

/**
 * One Goal-scoped trusted acceptance candidate, resolved only from
 * authoritative native receipts. Eligibility binds the exact native execution
 * receipt to the current registered manifest (id/version/hash) and to this
 * Goal's own criteria/Agent/workspace. Nothing here is derived from Goal text,
 * model output, or Action Registry row evidence.
 */
interface AcceptanceCandidate {
  execution: TrustedExecutionReceipt;
  manifest: TrustedManifestSummary;
  receipt: TrustedAcceptanceReceipt | null;
}

interface AcceptanceLoadResult {
  candidates: AcceptanceCandidate[];
  doneActionIds: Set<string>;
  unavailable: boolean;
}

/** Exact set equality (order-independent) for criterion ids. Empty is invalid. */
function sameCriterionSet(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((key) => set.has(key));
}

/**
 * Exact one-for-one comparison of a native acceptance receipt's criterion rows
 * against the validated manifest's declared checks. Requires an identical row
 * count, every expected `(criterion_id, check_index)` present exactly once with
 * matching tool/expected hash, every row accepted, and every actual hash exactly
 * equal to its expected hash. A partially passing criterion never counts.
 */
function receiptMatchesManifestChecks(
  receipt: TrustedAcceptanceReceipt,
  manifest: TrustedManifestSummary,
): boolean {
  const expected = manifestAcceptanceChecks(manifest);
  if (expected.length === 0 || receipt.criteria.length !== expected.length) return false;
  const byKey = new Map<string, TrustedAcceptanceCriterionReceipt>();
  for (const row of receipt.criteria) {
    byKey.set(`${row.criterion_id}:${row.check_index}`, row);
  }
  for (const row of expected) {
    const actual = byKey.get(`${row.criterion_id}:${row.check_index}`);
    if (!actual) return false;
    if (actual.tool !== row.tool) return false;
    if (actual.expected_sha256 !== row.expected_sha256) return false;
    if (actual.accepted !== true) return false;
    if (actual.actual_sha256 !== row.expected_sha256) return false;
  }
  return true;
}

/** Exact Goal-terminal receipt reference written by native completion. */
function acceptanceTerminalRef(receipt: TrustedAcceptanceReceipt): string {
  return `trusted_acceptance:${receipt.acceptance_key}`;
}

/**
 * Exact readback equality between the transient `run_trusted_acceptance` return
 * and the independently re-read `get_trusted_acceptance` persisted receipt.
 * Every DTO payload field must match, including the criterion rows in order and
 * their evidence payloads. `confirmed` is intentionally excluded: the in-process
 * run return sets it true only after native proof, while the read command
 * reconstructs the persisted row with `false`.
 */
function acceptanceReceiptsMatch(
  command: TrustedAcceptanceReceipt,
  durable: TrustedAcceptanceReceipt,
): boolean {
  if (
    command.acceptance_key !== durable.acceptance_key ||
    command.execution_id !== durable.execution_id ||
    command.action_id !== durable.action_id ||
    command.manifest_id !== durable.manifest_id ||
    command.goal_id !== durable.goal_id ||
    command.status !== durable.status ||
    command.terminal_reason !== durable.terminal_reason ||
    command.bun_run_id !== durable.bun_run_id ||
    command.bun_instance_id !== durable.bun_instance_id ||
    command.runtime_started_at !== durable.runtime_started_at ||
    command.runtime_finished_at !== durable.runtime_finished_at ||
    command.settled_at !== durable.settled_at ||
    command.created_at !== durable.created_at ||
    command.updated_at !== durable.updated_at
  ) {
    return false;
  }
  if (!deepJsonEqual(command.evidence, durable.evidence)) return false;
  if (command.criteria.length !== durable.criteria.length) return false;
  for (let index = 0; index < command.criteria.length; index += 1) {
    const a = command.criteria[index];
    const b = durable.criteria[index];
    if (
      a.criterion_id !== b.criterion_id ||
      a.check_index !== b.check_index ||
      a.tool !== b.tool ||
      a.expected_sha256 !== b.expected_sha256 ||
      a.actual_sha256 !== b.actual_sha256 ||
      a.accepted !== b.accepted ||
      !deepJsonEqual(a.evidence, b.evidence)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Accepted/completed is shown only when the native acceptance receipt is
 * explicitly `confirmed`, binds to the exact execution/manifest/Goal, its full
 * criterion row set matches the validated manifest checks exactly, and current
 * native readbacks prove the Goal terminal link/event and the Action Registry
 * action is terminally done. Status `accepted` alone is never delivery
 * confirmation; model/command/registry text is never a basis for completion.
 */
function isAcceptedCompleted(
  candidate: AcceptanceCandidate,
  detail: GoalDetail,
  doneActionIds: Set<string>,
): boolean {
  const { execution, manifest, receipt } = candidate;
  if (!receipt) return false;
  if (receipt.confirmed !== true) return false;
  if (receipt.execution_id !== execution.execution_id) return false;
  if (receipt.action_id !== execution.action_id) return false;
  if (receipt.manifest_id !== execution.manifest_id) return false;
  if (receipt.goal_id !== detail.goal.id) return false;
  if (receipt.status !== 'accepted') return false;
  if (!receiptMatchesManifestChecks(receipt, manifest)) return false;
  if (detail.goal.status !== 'completed') return false;
  const ref = acceptanceTerminalRef(receipt);
  if (!detail.links.some((link) => link.target_kind === 'evidence' && link.target_id === ref)) {
    return false;
  }
  if (
    !detail.events.some(
      (event) =>
        event.event_type === 'transition' &&
        event.to_status === 'completed' &&
        event.reason === ref,
    )
  ) {
    return false;
  }
  return doneActionIds.has(execution.action_id);
}

function acceptanceRank(candidate: AcceptanceCandidate): number {
  if (candidate.receipt?.status === 'accepted') return 0;
  if (candidate.execution.status === 'pending_acceptance') return 1;
  if (candidate.receipt !== null) return 2;
  return 3;
}

/**
 * Bounded runtime receipt for one exact run, visibly scoped to that run. A run's
 * runtime evidence and `acceptance_result` are per-run facts, never Goal
 * acceptance; Goal completion still requires the trusted acceptance receipt.
 *
 * Native `evidence.run_id` is the Bun run id, which must equal the exact joined
 * activation's `bun_run_id` for the evidence to be verified. It is never
 * compared to the Cron run row id; absent/conflicting identity renders the
 * evidence as unverified, not as a valid receipt.
 */
function RunReceipt({
  run,
  activationBunRunId,
}: {
  run: CronRunRecord;
  activationBunRunId: string | null;
}) {
  const receipt = run.execution_evidence;
  return (
    <div className="mt-1.5 rounded border border-white/10 bg-white/[0.02] p-2 text-[11px] font-mono text-bone/70">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill variant={cronRunVariant(run.status)}>{run.status}</Pill>
        <span className="text-bone/40">{run.duration_ms}ms</span>
      </div>
      <div className="mt-1 text-bone/50 break-all">
        <div>run {run.id}</div>
        <div>cron {run.cron_id} · goal {run.goal_id ?? 'unbound'}</div>
        <div>
          activation {run.activation_id ?? 'none'} · occurrence{' '}
          {run.schedule_occurrence ?? '—'}
        </div>
        <div>
          started {run.started_at}
          {run.finished_at ? ` · finished ${run.finished_at}` : ''}
        </div>
      </div>
      {run.terminal_reason && (
        <div className="mt-1 text-bone/60">reason: {run.terminal_reason}</div>
      )}
      {run.error && <div className="mt-1 text-red-200/80 break-all">error: {run.error}</div>}
      {run.output && <div className="mt-1 text-bone/40 break-all">output: {run.output}</div>}
      {receipt.kind === 'absent' && (
        <div className="mt-1.5 rounded border border-white/10 p-1.5 text-[10px] text-bone/40">
          No runtime receipt available for this run.
        </div>
      )}
      {receipt.kind === 'malformed' && (
        <div
          role="alert"
          className="mt-1.5 rounded border border-warning/20 bg-warning/5 p-1.5 text-[10px] text-warning"
        >
          Runtime receipt unavailable: malformed native evidence.
        </div>
      )}
      {receipt.kind === 'present' &&
        (() => {
          const evidence = receipt.evidence;
          const evidenceVerified =
            activationBunRunId !== null && activationBunRunId === evidence.run_id;
          return (
            <div
              className={cn(
                'mt-1.5 rounded border p-1.5',
                evidenceVerified
                  ? 'border-cyan-neon/20 bg-cyan-neon/5'
                  : 'border-warning/20 bg-warning/5',
              )}
            >
              <div
                className={cn(
                  'text-[10px] uppercase tracking-wider',
                  evidenceVerified ? 'text-cyan-glow' : 'text-warning',
                )}
              >
                {evidenceVerified
                  ? `Runtime receipt/evidence (scoped to run ${run.id})`
                  : 'Runtime evidence unverified'}
              </div>
              <div className="mt-0.5 text-bone/60 break-all">
                <div>
                  evidence run {evidence.run_id} · status {evidence.status}
                </div>
                {evidence.error_code && <div>error code: {evidence.error_code}</div>}
                {(evidence.started_at || evidence.finished_at) && (
                  <div>
                    {evidence.started_at ? `started ${evidence.started_at}` : ''}
                    {evidence.finished_at ? ` · finished ${evidence.finished_at}` : ''}
                  </div>
                )}
                {evidence.acceptance_result && (
                  <div className="text-bone/50">
                    runtime acceptance_result: {evidence.acceptance_result}
                  </div>
                )}
              </div>
              <div className="mt-1 text-[10px] text-bone/40">
                {evidenceVerified
                  ? 'This is a per-run runtime receipt, not Goal acceptance. Goal completion still requires the trusted acceptance receipt/readback above.'
                  : "This evidence's identity is unverified: the exact joined activation's bun_run_id does not match evidence.run_id, or no joined activation exists. It is not a valid runtime receipt and is not Goal acceptance."}
              </div>
            </div>
          );
        })()}
    </div>
  );
}

export default function GoalsView({
  notificationSelector = null,
  onNotificationSelectorConsumed,
  navigationSelector = null,
  onNavigationSelectorConsumed,
  onNavigateWorkflow,
}: {
  /**
   * App-retained `{goal_id, activation_id?, cron_job_id?, run_id?}` navigation
   * selector from an in-app `goal://notifications` event. Selector-only: on
   * mount the view re-reads native Goal/link/schedule/activation/run authority
   * and opens/focuses only an exact match. No toast text or prompt is carried.
   */
  notificationSelector?: GoalNotificationSelector | null;
  /** Reports the exact selector consumed, so App clears only that one. */
  onNotificationSelectorConsumed?: (selector: GoalNotificationSelector) => void;
  /**
   * App-retained cross-workflow navigation selector. Destination-addressed and
   * selector-only: this view re-reads native Goal/link/schedule/activation/run
   * authority and opens/focuses only an exact match. A missing, malformed,
   * stale, or conflicting selector is shown as stale with no fallback and no
   * schedule action.
   */
  navigationSelector?: Extract<WorkflowNavigationSelector, { workflow: 'recurring-operator' }> | null;
  /** Reports the exact selector consumed, so App clears only that one. */
  onNavigationSelectorConsumed?: (selector: WorkflowNavigationSelector) => void;
  /** Requests navigation to another workflow, optionally with an exact selector. */
  onNavigateWorkflow?: (
    destination: WorkflowDestination,
    selector: WorkflowNavigationSelector | null,
  ) => void;
}) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [runs, setRuns] = useState<GoalRunProgress[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  const [commitments, setCommitments] = useState<CommitmentRecord[]>([]);
  const [commitmentsUnavailable, setCommitmentsUnavailable] = useState(false);
  const [commitmentsReadError, setCommitmentsReadError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<CronSchedule[]>([]);
  const [activations, setActivations] = useState<Record<string, CronActivation[]>>({});
  const [cronRuns, setCronRuns] = useState<Record<string, CronRunRecord[]>>({});
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [activationErrors, setActivationErrors] = useState<Record<string, boolean>>({});
  const [runErrors, setRunErrors] = useState<Record<string, boolean>>({});
  // Schedule authority availability is distinct from "authoritative empty": a
  // failed or malformed read marks it unavailable so nothing claims an empty
  // list and no stale control stays actionable.
  const [scheduleUnavailable, setScheduleUnavailable] = useState(false);
  const [scheduleReadError, setScheduleReadError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [scheduleOps, setScheduleOps] = useState<Record<string, ScheduleOp>>({});
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  // App-retained notification navigation focus (selector-only). `selectorNotice`
  // surfaces a stale/unavailable outcome when the selector cannot be reconciled;
  // `selectorFocus` highlights only the exact matching native record.
  const [selectorFocus, setSelectorFocus] = useState<NotificationFocus | null>(null);
  const [selectorNotice, setSelectorNotice] = useState<string | null>(null);

  // Explicit Goal link/unlink candidates and operation. Candidates are read only
  // from the owning native authorities and bound to the current Goal generation.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTargetKind, setLinkTargetKind] = useState<LinkTargetKind>('cron_job');
  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkCandidates, setLinkCandidates] = useState<LinkCandidatesState>({ kind: 'loading' });
  const [linkOpState, setLinkOpState] = useState<LinkOp | null>(null);
  const linkOpRef = useRef<LinkOp | null>(null);

  const [acceptanceCandidates, setAcceptanceCandidates] = useState<AcceptanceCandidate[]>([]);
  const [acceptanceDoneIds, setAcceptanceDoneIds] = useState<Set<string>>(new Set());
  const [acceptanceUnavailable, setAcceptanceUnavailable] = useState(false);
  const [acceptanceReadError, setAcceptanceReadError] = useState<string | null>(null);
  const [acceptanceRefreshing, setAcceptanceRefreshing] = useState(false);
  const [acceptanceRunningId, setAcceptanceRunningId] = useState<string | null>(null);
  const [acceptanceMessage, setAcceptanceMessage] = useState<string | null>(null);
  // Native `run_trusted_acceptance` is the only source of an explicitly
  // `confirmed` acceptance receipt (`get_trusted_acceptance` always returns
  // confirmed=false). Session confirmations are held by exact execution id and
  // are still re-verified against current readbacks on every render.
  const [confirmedAcceptance, setConfirmedAcceptance] = useState<
    Record<string, TrustedAcceptanceReceipt>
  >({});
  const acceptancePending = useRef(false);

  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState<string[]>(['']);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPending = useRef(false);
  const requestId = useRef(0);
  const detailRequestId = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const transitionPending = useRef(false);
  const scheduleOpsRef = useRef<Record<string, ScheduleOp>>({});
  const reconcilePending = useRef(false);
  // Latest successfully-read history, used only to capture an immutable baseline
  // before a Run now submission (or to detect that no baseline was available).
  const historyRef = useRef<{
    activations: Record<string, CronActivation[]>;
    runs: Record<string, CronRunRecord[]>;
    activationErrors: Record<string, boolean>;
    runErrors: Record<string, boolean>;
  }>({ activations: {}, runs: {}, activationErrors: {}, runErrors: {} });

  const fetchGoals = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      const rows = await invoke<Goal[]>('goal_list');
      if (request !== requestId.current) return;
      setGoals(rows);
      setError(null);
    } catch {
      if (request !== requestId.current) return;
      setError('Could not load goals.');
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);

  // Authoritative native readback for the Goal's associated schedules,
  // activations, and runs. Every schedule mutation calls this before the UI may
  // claim the change succeeded; a failed readback leaves the previous displayed
  // state in place, marks it stale/unavailable, and reports uncertainty. A stale
  // selection generation is discarded. A failed or malformed (non-array) schedule
  // or in-flight response is unavailable, never an authoritative empty list, and
  // history read failures are tracked per job so an unavailable list is never
  // rendered as "no activations" or "no runs".
  const refreshScheduleState = useCallback(
    async (
      goalId: string,
      expectedRequest: number,
    ): Promise<ScheduleRefreshResult> => {
      let jobs: CronSchedule[];
      let flight: string[];
      try {
        const [jobsResponse, flightResponse] = await Promise.all([
          invoke<unknown>('list_cron_jobs'),
          invoke<unknown>('get_in_flight_cron_jobs'),
        ]);
        if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
        if (!Array.isArray(jobsResponse) || !Array.isArray(flightResponse)) {
          setScheduleUnavailable(true);
          setScheduleReadError(
            'The native schedule authority returned an unreadable response. Schedule state is unavailable; controls are disabled until it is reconciled.',
          );
          return { status: 'unavailable' };
        }
        jobs = jobsResponse as CronSchedule[];
        flight = flightResponse as string[];
      } catch {
        if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
        setScheduleUnavailable(true);
        setScheduleReadError(
          'Could not read goal-linked schedules from the native authority. Schedule state is unavailable; controls are disabled until it is reconciled.',
        );
        return { status: 'unavailable' };
      }
      if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
      const linked = jobs.filter((job) => job.goal_id === goalId);
      const linkedJobIds = new Set(linked.map((job) => job.id));
      const enabledByJob: Record<string, boolean> = {};
      const nextActivations: Record<string, CronActivation[]> = {};
      const nextRuns: Record<string, CronRunRecord[]> = {};
      const nextActivationErrors: Record<string, boolean> = {};
      const nextRunErrors: Record<string, boolean> = {};
      // Only successfully-read histories appear here, so a missing key is an
      // unavailable history rather than an authoritative empty list.
      const observedActivations: Record<string, CronActivation[]> = {};
      const observedRuns: Record<string, CronRunRecord[]> = {};
      for (const job of linked) {
        enabledByJob[job.id] = job.enabled;
        try {
          const rows = await invoke<unknown>('get_cron_activations', {
            cronId: job.id,
          });
          if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
          const decoded = decodeCronActivationArray(rows);
          if (decoded !== null) {
            nextActivations[job.id] = decoded;
            observedActivations[job.id] = decoded;
          } else {
            // A malformed collection/row is unavailable, never an authoritative
            // empty history: the key stays absent.
            nextActivationErrors[job.id] = true;
          }
        } catch {
          if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
          nextActivationErrors[job.id] = true;
        }
        try {
          const rows = await invoke<unknown>('get_cron_runs', {
            cronId: job.id,
          });
          if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
          const decoded = decodeCronRunArray(rows);
          if (decoded !== null) {
            nextRuns[job.id] = decoded;
            observedRuns[job.id] = decoded;
          } else {
            nextRunErrors[job.id] = true;
          }
        } catch {
          if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
          nextRunErrors[job.id] = true;
        }
      }
      if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
      setSchedules(linked);
      setActivations(nextActivations);
      setCronRuns(nextRuns);
      setActivationErrors(nextActivationErrors);
      setRunErrors(nextRunErrors);
      setInFlight(new Set(flight));
      setScheduleUnavailable(false);
      setScheduleReadError(null);
      historyRef.current = {
        activations: nextActivations,
        runs: nextRuns,
        activationErrors: nextActivationErrors,
        runErrors: nextRunErrors,
      };
      return {
        status: 'ok',
        linkedJobIds,
        enabledByJob,
        inFlight: new Set(flight),
        activationsByJob: observedActivations,
        runsByJob: observedRuns,
      };
    },
    [],
  );

  // Read-only reconciliation for the Goal's schedule panel. It re-reads the
  // authoritative schedule + activation/run state and clears only the pending
  // error operations (never an in-flight write) after a successful readback. It
  // never re-submits a mutation, so it is not a retry.
  const reconcileSchedules = useCallback(async () => {
    if (reconcilePending.current) return;
    const goalId = selectedIdRef.current;
    if (!goalId) return;
    if (
      Object.values(scheduleOpsRef.current).some((op) => op.phase === 'writing')
    ) {
      return;
    }
    reconcilePending.current = true;
    setReconciling(true);
    const expectedRequest = detailRequestId.current;
    const outcome = await refreshScheduleState(goalId, expectedRequest);
    if (
      selectedIdRef.current !== goalId ||
      expectedRequest !== detailRequestId.current
    ) {
      reconcilePending.current = false;
      setReconciling(false);
      return;
    }
    if (outcome.status === 'ok') {
      // Clear a pending failed/uncertain operation only when the readback shows
      // that operation's own requested effect (see scheduleOpReconciled). An
      // incomplete history or an unchanged effect leaves the operation uncertain
      // and the controls disabled until a later successful reconciliation.
      const next: Record<string, ScheduleOp> = {};
      for (const [jobId, op] of Object.entries(scheduleOpsRef.current)) {
        if (op.phase === 'writing') {
          next[jobId] = op;
          continue;
        }
        if (!scheduleOpReconciled(op, outcome)) next[jobId] = op;
      }
      scheduleOpsRef.current = next;
      setScheduleOps(next);
    }
    reconcilePending.current = false;
    setReconciling(false);
  }, [refreshScheduleState]);

  // Goal-linked Commitments are owned by the Commitment JSON authority, so the
  // display is derived from the authoritative records (never an inferred link).
  // A failed or malformed (non-array) read is unavailable, never an
  // authoritative "no commitments" list.
  const loadGoalSupport = useCallback(
    async (goalId: string, expectedRequest: number): Promise<ScheduleRefreshResult> => {
      try {
        const all = await invoke<unknown>('get_commitments');
        if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
        if (!Array.isArray(all)) {
          setCommitmentsUnavailable(true);
          setCommitmentsReadError(
            'The native Commitment authority returned an unreadable response. Linked commitments are unavailable.',
          );
        } else {
          setCommitmentsUnavailable(false);
          setCommitmentsReadError(null);
          setCommitments(
            (all as CommitmentRecord[]).filter((c) => c.goal_id === goalId),
          );
        }
      } catch {
        if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
        setCommitmentsUnavailable(true);
        setCommitmentsReadError(
          'Could not read linked commitments from the native authority. Linked commitments are unavailable.',
        );
      }
      return refreshScheduleState(goalId, expectedRequest);
    },
    [refreshScheduleState],
  );

  // Authoritative trusted-acceptance readback for the selected Goal. Candidate
  // executions come only from native receipts: a registered manifest is
  // Goal-scoped when its exact acceptance criterion set equals the Goal's own
  // criteria and its Agent/workspace scope matches, then the manifest's exact
  // action receipts are read and each execution must match the manifest's
  // id/version/hash/schema/Agent/action tuple. A failed or malformed read marks
  // the panel unavailable (never empty success); a mismatched identity is
  // dropped so stale evidence is never shown.
  const loadAcceptanceState = useCallback(
    async (goalDetail: GoalDetail, expectedRequest: number): Promise<AcceptanceLoadResult> => {
      const empty: AcceptanceLoadResult = {
        candidates: [],
        doneActionIds: new Set(),
        unavailable: true,
      };
      let manifests: TrustedManifestSummary[];
      try {
        const raw = await invoke<unknown>('list_trusted_acceptance_manifests');
        if (expectedRequest !== detailRequestId.current) return empty;
        if (!Array.isArray(raw)) throw new Error('unreadable');
        manifests = [];
        for (const row of raw) {
          if (!isTrustedManifestSummary(row)) throw new Error('malformed');
          manifests.push(row);
        }
      } catch {
        if (expectedRequest !== detailRequestId.current) return empty;
        setAcceptanceCandidates([]);
        setAcceptanceDoneIds(new Set());
        setAcceptanceUnavailable(true);
        setAcceptanceReadError(
          'The native trusted-manifest registry could not be read. Trusted acceptance is unavailable.',
        );
        return empty;
      }

      const goal = goalDetail.goal;
      const required = goalDetail.criteria.map((criterion) => criterion.id);
      const goalRoot = normalizeRoot(goal.project_root);
      const scoped = manifests.filter(
        (manifest) =>
          typeof manifest.action_id === 'string' &&
          manifest.action_id.length > 0 &&
          manifest.schema_version === 1 &&
          manifest.agent_id === goal.agent_id &&
          goalRoot !== null &&
          normalizeRoot(manifest.project_root) === goalRoot &&
          sameCriterionSet(manifestAcceptanceKeys(manifest), required),
      );

      const candidates: AcceptanceCandidate[] = [];
      let failed = false;
      for (const manifest of scoped) {
        let executions: TrustedExecutionReceipt[];
        try {
          const raw = await invoke<unknown>('list_trusted_executions', {
            actionId: manifest.action_id,
          });
          if (expectedRequest !== detailRequestId.current) return empty;
          if (!Array.isArray(raw)) throw new Error('unreadable');
          executions = [];
          for (const item of raw) {
            if (!isTrustedExecutionReceipt(item) || item.action_id !== manifest.action_id) {
              throw new Error('malformed');
            }
            executions.push(item);
          }
        } catch {
          if (expectedRequest !== detailRequestId.current) return empty;
          failed = true;
          continue;
        }
        const manifestRoot = normalizeRoot(manifest.project_root);
        for (const execution of executions) {
          // An execution that claims this manifest id must satisfy the complete
          // exact tuple, including canonical project root. A mismatch is an
          // integrity failure (unavailable), never a silently-dropped candidate
          // that would render an empty/not-linked state.
          if (execution.manifest_id !== manifest.manifest_id) continue;
          const rootMatches =
            manifestRoot !== null &&
            goalRoot !== null &&
            manifestRoot === goalRoot &&
            normalizeRoot(execution.project_root) === manifestRoot;
          if (
            !rootMatches ||
            execution.manifest_registry_version !== manifest.registry_version ||
            execution.manifest_content_hash !== manifest.content_hash ||
            execution.manifest_schema_version !== manifest.schema_version ||
            execution.agent_id !== manifest.agent_id ||
            execution.action_id !== manifest.action_id
          ) {
            failed = true;
            continue;
          }
          let receipt: TrustedAcceptanceReceipt | null = null;
          try {
            const rawReceipt = await invoke<unknown>('get_trusted_acceptance', {
              executionId: execution.execution_id,
            });
            if (expectedRequest !== detailRequestId.current) return empty;
            if (rawReceipt !== null && rawReceipt !== undefined) {
              if (
                !isTrustedAcceptanceReceipt(rawReceipt) ||
                rawReceipt.execution_id !== execution.execution_id ||
                rawReceipt.action_id !== execution.action_id ||
                rawReceipt.manifest_id !== execution.manifest_id ||
                rawReceipt.goal_id !== goal.id
              ) {
                throw new Error('malformed');
              }
              receipt = rawReceipt;
            }
          } catch {
            if (expectedRequest !== detailRequestId.current) return empty;
            failed = true;
            continue;
          }
          candidates.push({ execution, manifest, receipt });
        }
      }

      let doneActionIds = new Set<string>();
      let doneOk = false;
      try {
        const rawDone = await invoke<unknown>('get_action_registry_bucket', { bucket: 'done' });
        if (expectedRequest !== detailRequestId.current) return empty;
        if (
          rawDone &&
          typeof rawDone === 'object' &&
          Array.isArray((rawDone as { actions?: unknown }).actions)
        ) {
          const rows = (rawDone as { actions: ActionRegistryRow[] }).actions;
          doneActionIds = new Set(
            rows.filter((row) => row && row.status === 'done').map((row) => row.id),
          );
          doneOk = true;
        } else {
          throw new Error('unreadable');
        }
      } catch {
        if (expectedRequest !== detailRequestId.current) return empty;
        failed = true;
      }

      if (expectedRequest !== detailRequestId.current) return empty;
      candidates.sort((a, b) => acceptanceRank(a) - acceptanceRank(b));
      const unavailable = failed || !doneOk;
      setAcceptanceCandidates(candidates);
      setAcceptanceDoneIds(doneActionIds);
      setAcceptanceUnavailable(unavailable);
      setAcceptanceReadError(
        unavailable
          ? 'Some authoritative native receipts could not be read. Affected acceptance evidence is hidden and shown as unavailable; no completion is claimed without a full readback.'
          : null,
      );
      return { candidates, doneActionIds, unavailable };
    },
    [],
  );

  const refreshAcceptanceState = useCallback(async () => {
    const current = detail;
    if (!current || acceptancePending.current) return;
    const expectedRequest = detailRequestId.current;
    setAcceptanceRefreshing(true);
    try {
      await loadAcceptanceState(current, expectedRequest);
    } finally {
      setAcceptanceRefreshing(false);
    }
  }, [detail, loadAcceptanceState]);

  // Explicit user-authorized acceptance run for ONE exact native
  // `pending_acceptance` execution id. The command return is never a completion
  // claim: the exact execution receipt, acceptance receipt, Goal/criteria, and
  // Action Registry terminal state are re-read and must all match before an
  // accepted/completed state is displayed.
  const runAcceptance = useCallback(
    async (executionId: string) => {
      const current = detail;
      if (!current || acceptancePending.current) return;
      const goalId = current.goal.id;
      const expectedRequest = detailRequestId.current;
      const candidate = acceptanceCandidates.find(
        (row) => row.execution.execution_id === executionId,
      );
      if (
        !candidate ||
        candidate.execution.status !== 'pending_acceptance' ||
        candidate.receipt !== null
      ) {
        return;
      }
      const execution = candidate.execution;
      acceptancePending.current = true;
      setAcceptanceRunningId(executionId);
      setAcceptanceMessage(null);
      let commandError: string | null = null;
      let commandReceipt: TrustedAcceptanceReceipt | null = null;
      try {
        try {
          const raw = await invoke<unknown>('run_trusted_acceptance', { executionId });
          if (isTrustedAcceptanceReceipt(raw)) commandReceipt = raw;
        } catch (err) {
          commandError = typeof err === 'string' ? err : 'unknown error';
        }
        if (selectedIdRef.current !== goalId || expectedRequest !== detailRequestId.current) {
          return;
        }
        // Re-read the exact execution receipt and bind it to the frozen tuple.
        let freshExecution: TrustedExecutionReceipt | null = null;
        try {
          const raw = await invoke<unknown>('get_trusted_execution', { executionId });
          if (isTrustedExecutionReceipt(raw)) freshExecution = raw;
        } catch {
          freshExecution = null;
        }
        let freshDetail: GoalDetail | null = null;
        try {
          const raw = await invoke<GoalDetail>('goal_get', { id: goalId });
          if (raw && raw.goal && raw.goal.id === goalId) freshDetail = raw;
        } catch {
          freshDetail = null;
        }
        if (selectedIdRef.current !== goalId || expectedRequest !== detailRequestId.current) {
          return;
        }
        if (freshDetail) setDetail(freshDetail);
        const result = await loadAcceptanceState(freshDetail ?? current, expectedRequest);
        if (selectedIdRef.current !== goalId || expectedRequest !== detailRequestId.current) {
          return;
        }
        const updated =
          result.candidates.find((row) => row.execution.execution_id === executionId) ?? null;
        const executionBound =
          freshExecution !== null &&
          freshExecution.execution_id === execution.execution_id &&
          freshExecution.action_id === execution.action_id &&
          freshExecution.manifest_id === execution.manifest_id &&
          freshExecution.manifest_registry_version === execution.manifest_registry_version &&
          freshExecution.manifest_content_hash === execution.manifest_content_hash &&
          freshExecution.agent_id === execution.agent_id &&
          normalizeRoot(freshExecution.project_root) === normalizeRoot(execution.project_root);
        // Delivery confirmation requires the running command's explicitly
        // `confirmed` receipt AND the independently re-read `get_trusted_acceptance`
        // persisted receipt to be identical in every payload field (including
        // criterion rows and their evidence), differing only in `confirmed`.
        const durable = updated?.receipt ?? null;
        const commandConfirmedAccepted =
          commandReceipt !== null &&
          commandReceipt.confirmed === true &&
          commandReceipt.status === 'accepted' &&
          commandReceipt.execution_id === execution.execution_id &&
          commandReceipt.action_id === execution.action_id &&
          commandReceipt.manifest_id === execution.manifest_id &&
          commandReceipt.goal_id === goalId;
        const receiptsMatch =
          commandReceipt !== null &&
          durable !== null &&
          acceptanceReceiptsMatch(commandReceipt, durable);
        const receiptBound = commandConfirmedAccepted && receiptsMatch;
        // Fail closed: if the run claimed confirmation but the persisted
        // readback is missing, malformed, or differs, the accepted/completed
        // state is unavailable rather than inferred from the command response.
        if (commandConfirmedAccepted && !receiptsMatch && commandError === null) {
          setAcceptanceUnavailable(true);
          setAcceptanceReadError(
            'The native acceptance confirmation did not exactly match the persisted acceptance receipt, so no accepted/completed state is shown.',
          );
        } else if (commandReceipt === null && commandError === null) {
          setAcceptanceUnavailable(true);
          setAcceptanceReadError(
            'The native acceptance command did not return a readable receipt, so no accepted/completed state is shown.',
          );
        }
        const accepted =
          executionBound &&
          receiptBound &&
          updated !== null &&
          freshDetail !== null &&
          commandReceipt !== null &&
          isAcceptedCompleted(
            { execution: updated.execution, manifest: updated.manifest, receipt: commandReceipt },
            freshDetail,
            result.doneActionIds,
          );
        if (accepted && commandReceipt !== null) {
          const confirmed = commandReceipt;
          setConfirmedAcceptance((prev) => ({ ...prev, [executionId]: confirmed }));
          setAcceptanceMessage(
            'Trusted acceptance confirmed: the native run returned a confirmed receipt, the re-read durable receipt matches it, the Goal is completed from accepted evidence, and the Action Registry action is terminally done.',
          );
        } else if (commandError !== null) {
          setAcceptanceMessage(
            `Acceptance did not confirm (${commandError}). No completion is claimed; only the durable native receipt state below is shown.`,
          );
        } else if (updated?.receipt) {
          setAcceptanceMessage(
            `Acceptance recorded status '${updated.receipt.status}'. Terminal delivery is not confirmed; no completion is claimed.`,
          );
        } else {
          setAcceptanceMessage(
            'Acceptance did not produce a confirmable native receipt. No completion is claimed.',
          );
        }
      } finally {
        acceptancePending.current = false;
        setAcceptanceRunningId(null);
      }
    },
    [detail, acceptanceCandidates, loadAcceptanceState],
  );

  // One schedule mutation at a time per job. The native command must confirm the
  // effect and an authoritative readback must then succeed before the operation
  // is cleared; otherwise the operation is left actionable and the display is
  // not optimized.
  const runScheduleOp = useCallback(
    async (kind: ScheduleOpKind, job: CronSchedule) => {
      const goalId = job.goal_id;
      if (!goalId) return;
      if (scheduleOpsRef.current[job.id]) return;
      const expectedRequest = detailRequestId.current;

      // Capture immutable context so the requested effect can be reconciled
      // later without re-submitting. A run baseline is only usable when both
      // history reads were previously successful; otherwise the predicate
      // requires evidence newer than the submission time.
      const history = historyRef.current;
      const baselineActivationIds =
        history.activationErrors[job.id] !== true &&
        Array.isArray(history.activations[job.id])
          ? history.activations[job.id].map((activation) => activation.activation_id)
          : undefined;
      const baselineRunIds =
        history.runErrors[job.id] !== true && Array.isArray(history.runs[job.id])
          ? history.runs[job.id].map((run) => run.id)
          : undefined;

      // Run now must not submit without a usable fresh activation+run baseline:
      // without it the new occurrence could not be reconciled, so refuse rather
      // than dispatch an unverifiable manual run. No operation is recorded (no
      // write was attempted); the control is disabled while history is
      // unavailable, so this is a defensive guard.
      if (kind === 'run' && (baselineActivationIds === undefined || baselineRunIds === undefined)) {
        return;
      }

      const op: ScheduleOp = {
        kind,
        jobId: job.id,
        goalId,
        phase: 'writing',
        ...(kind === 'pause' || kind === 'resume'
          ? { expectedEnabled: kind === 'resume' }
          : {}),
        ...(kind === 'run'
          ? {
              baselineActivationIds,
              baselineRunIds,
              submittedAt: new Date().toISOString(),
            }
          : {}),
      };
      scheduleOpsRef.current = { ...scheduleOpsRef.current, [job.id]: op };
      setScheduleOps(scheduleOpsRef.current);

      const fail = (message: string) => {
        if (
          selectedIdRef.current !== goalId ||
          expectedRequest !== detailRequestId.current
        ) {
          return;
        }
        scheduleOpsRef.current = {
          ...scheduleOpsRef.current,
          [job.id]: { ...op, phase: 'write-failed', message },
        };
        setScheduleOps(scheduleOpsRef.current);
      };

      let confirmed: boolean;
      try {
        const command =
          kind === 'pause'
            ? 'disable_cron_job'
            : kind === 'resume'
              ? 'enable_cron_job'
              : kind === 'cancel'
                ? 'cancel_cron_job'
                : 'run_cron_job';
        confirmed = (await invoke<boolean>(command, { id: job.id })) === true;
      } catch (err) {
        fail(
          typeof err === 'string'
            ? err
            : `Could not ${scheduleOpVerb(kind)} this schedule.`,
        );
        return;
      }

      if (
        selectedIdRef.current !== goalId ||
        expectedRequest !== detailRequestId.current
      ) {
        return;
      }

      if (!confirmed) {
        fail(
          kind === 'cancel'
            ? 'Cancellation was requested but the running execution did not confirm it. The run may still be active; reconcile the activation history.'
            : `The native authority did not confirm the ${scheduleOpVerb(kind)} request.`,
        );
        return;
      }

      const readBack = await refreshScheduleState(goalId, expectedRequest);
      if (
        selectedIdRef.current !== goalId ||
        expectedRequest !== detailRequestId.current
      ) {
        return;
      }
      if (readBack.status !== 'ok') {
        // `stale` already returned above; this is an unavailable authority or a
        // failed read. Keep the previous display and leave the operation
        // actionable through the read-only reconcile action.
        scheduleOpsRef.current = {
          ...scheduleOpsRef.current,
          [job.id]: {
            ...op,
            phase: 'read-failed',
            message: `The ${scheduleOpVerb(kind)} was accepted, but the authoritative schedule state could not be re-read. Showing the previous state; it is stale. Use Refresh to reconcile the schedule status.`,
          },
        };
        setScheduleOps(scheduleOpsRef.current);
        return;
      }
      if (!scheduleOpReconciled(op, readBack)) {
        // The schedule list was readable, but the requested effect was not
        // observed (e.g. still enabled after a pause, no new run/activation, or
        // a still-tracked in-flight cancel). Keep the operation uncertain so the
        // UI does not claim it succeeded without evidence.
        scheduleOpsRef.current = {
          ...scheduleOpsRef.current,
          [job.id]: {
            ...op,
            phase: 'read-failed',
            message: `The ${scheduleOpVerb(kind)} was accepted, but the native schedule state does not yet show its requested effect (for example, a still-enabled pause, no new run/activation, or a still-tracked cancel). Use Refresh to reconcile the schedule status.`,
          },
        };
        setScheduleOps(scheduleOpsRef.current);
        return;
      }

      const next = { ...scheduleOpsRef.current };
      delete next[job.id];
      scheduleOpsRef.current = next;
      setScheduleOps(next);
    },
    [refreshScheduleState],
  );

  const publishLinkOp = useCallback((next: LinkOp | null) => {
    linkOpRef.current = next;
    setLinkOpState(next);
  }, []);

  // Load explicit-link candidates from the owning native authorities only. A
  // failed or malformed read (including a malformed Session authority row) is an
  // unavailable candidate set, never an empty one.
  const loadLinkCandidates = useCallback(async (expectedRequest: number) => {
    if (expectedRequest !== detailRequestId.current) return;
    setLinkCandidates({ kind: 'loading' });
    try {
      const [jobsRaw, commitmentsRaw, sessionsRaw] = await Promise.all([
        invoke<unknown>('list_cron_jobs'),
        invoke<unknown>('get_commitments'),
        invoke<unknown>('list_sessions'),
      ]);
      if (expectedRequest !== detailRequestId.current) return;
      if (
        !Array.isArray(jobsRaw) ||
        !Array.isArray(commitmentsRaw) ||
        !Array.isArray(sessionsRaw)
      ) {
        setLinkCandidates({
          kind: 'error',
          message:
            'The native candidate authorities returned an unreadable response. Link candidates are unavailable.',
        });
        return;
      }
      const sessions: SessionScopeRow[] = [];
      for (const row of sessionsRaw) {
        if (!row || typeof row !== 'object') {
          setLinkCandidates({
            kind: 'error',
            message:
              'The native Session authority returned a malformed row. Link candidates are unavailable.',
          });
          return;
        }
        const record = row as Record<string, unknown>;
        if (typeof record.id !== 'string' || typeof record.agent_id !== 'string') {
          setLinkCandidates({
            kind: 'error',
            message:
              'The native Session authority returned a malformed row. Link candidates are unavailable.',
          });
          return;
        }
        sessions.push({
          id: record.id,
          agent_id: record.agent_id,
          project_root: typeof record.project_root === 'string' ? record.project_root : null,
        });
      }
      setLinkCandidates({
        kind: 'ready',
        jobs: jobsRaw as CronSchedule[],
        commitments: commitmentsRaw as CommitmentRecord[],
        sessions,
      });
    } catch {
      if (expectedRequest !== detailRequestId.current) return;
      setLinkCandidates({
        kind: 'error',
        message: 'Could not read link candidates from the native authorities.',
      });
    }
  }, []);

  // Freshly re-read the exact Goal row and its Agent/workspace identity.
  const readGoalRow = useCallback(async (goalId: string): Promise<Goal | null> => {
    try {
      const raw = await invoke<GoalDetail>('goal_get', { id: goalId });
      if (!raw || !raw.goal || raw.goal.id !== goalId) return null;
      return raw.goal;
    } catch {
      return null;
    }
  }, []);

  // Freshly read the persisted Session scope map, or null when the authority is
  // unavailable/malformed (so a project-scoped candidate can never be offered).
  const readSessionScopes = useCallback(
    async (): Promise<Map<string, SessionScopeRow> | null> => {
      try {
        const raw = await invoke<unknown>('list_sessions');
        if (!Array.isArray(raw)) return null;
        const map = new Map<string, SessionScopeRow>();
        for (const row of raw) {
          if (!row || typeof row !== 'object') return null;
          const record = row as Record<string, unknown>;
          if (typeof record.id !== 'string' || typeof record.agent_id !== 'string') return null;
          map.set(record.id, {
            id: record.id,
            agent_id: record.agent_id,
            project_root: typeof record.project_root === 'string' ? record.project_root : null,
          });
        }
        return map;
      } catch {
        return null;
      }
    },
    [],
  );

  // Exact Goal-side link + freshly re-read Goal identity + authoritative
  // target-side `goal_id`/scope agreement.
  const confirmLink = useCallback(
    async (goalId: string, targetKind: LinkTargetKind, targetId: string): Promise<boolean> => {
      const goal = await readGoalRow(goalId);
      if (!goal) return false;
      const linksRaw = await invoke<unknown>('goal_links_list', { goalId }).catch(() => null);
      if (!Array.isArray(linksRaw)) return false;
      const linkPresent = (linksRaw as GoalLink[]).some(
        (link) =>
          link.goal_id === goalId &&
          link.target_kind === targetKind &&
          link.target_id === targetId,
      );
      if (!linkPresent) return false;
      if (targetKind === 'cron_job') {
        const jobsRaw = await invoke<unknown>('list_cron_jobs').catch(() => null);
        if (!Array.isArray(jobsRaw)) return false;
        const job = (jobsRaw as CronSchedule[]).find((row) => row.id === targetId);
        if (!job || job.goal_id !== goalId || job.agent_id !== goal.agent_id) return false;
        if (goal.project_root !== null) {
          if (job.session_id === null) return false;
          const sessions = await readSessionScopes();
          if (!sessions) return false;
          const session = sessions.get(job.session_id);
          if (
            !session ||
            session.agent_id !== goal.agent_id ||
            session.project_root !== goal.project_root
          ) {
            return false;
          }
        }
        return true;
      }
      const commitmentsRaw = await invoke<unknown>('get_commitments').catch(() => null);
      if (!Array.isArray(commitmentsRaw)) return false;
      const commitment = (commitmentsRaw as CommitmentRecord[]).find((row) => row.id === targetId);
      if (!commitment || commitment.goal_id !== goalId) return false;
      // A Commitment carries no workspace association and cannot be bound to a
      // project-scoped Goal.
      if (goal.project_root !== null) return false;
      if (commitment.agent_id !== null && commitment.agent_id !== goal.agent_id) return false;
      return true;
    },
    [readGoalRow, readSessionScopes],
  );

  // Unlink confirmation requires the link absent AND the target fully unbound
  // (`goal_id === null`, not merely a different Goal id).
  const confirmUnlink = useCallback(
    async (goalId: string, targetKind: LinkTargetKind, targetId: string): Promise<boolean> => {
      const goal = await readGoalRow(goalId);
      if (!goal) return false;
      const linksRaw = await invoke<unknown>('goal_links_list', { goalId }).catch(() => null);
      if (!Array.isArray(linksRaw)) return false;
      const linkPresent = (linksRaw as GoalLink[]).some(
        (link) =>
          link.goal_id === goalId &&
          link.target_kind === targetKind &&
          link.target_id === targetId,
      );
      if (linkPresent) return false;
      if (targetKind === 'cron_job') {
        const jobsRaw = await invoke<unknown>('list_cron_jobs').catch(() => null);
        if (!Array.isArray(jobsRaw)) return false;
        const job = (jobsRaw as CronSchedule[]).find((row) => row.id === targetId);
        return job !== undefined && job.goal_id === null;
      }
      const commitmentsRaw = await invoke<unknown>('get_commitments').catch(() => null);
      if (!Array.isArray(commitmentsRaw)) return false;
      const commitment = (commitmentsRaw as CommitmentRecord[]).find((row) => row.id === targetId);
      return commitment !== undefined && commitment.goal_id === null;
    },
    [readGoalRow],
  );

  const refreshLinkState = useCallback(
    async (goalId: string, expectedRequest: number) => {
      try {
        const fresh = await invoke<GoalDetail>('goal_get', { id: goalId });
        if (expectedRequest !== detailRequestId.current || selectedIdRef.current !== goalId) return;
        if (fresh && fresh.goal && fresh.goal.id === goalId) setDetail(fresh);
      } catch {
        // Leave the previous detail in place; the unresolved link op surfaces
        // the uncertainty and a later Refresh reconciles it.
      }
      await loadGoalSupport(goalId, expectedRequest);
      await loadLinkCandidates(expectedRequest);
    },
    [loadGoalSupport, loadLinkCandidates],
  );

  const runLinkOp = useCallback(
    async (kind: 'link' | 'unlink', targetKind: LinkTargetKind, targetId: string) => {
      const current = detail;
      if (!current || linkOpRef.current) return;
      const goalId = current.goal.id;
      const expectedRequest = detailRequestId.current;
      const op: LinkOp = { kind, targetKind, targetId, phase: 'writing' };
      publishLinkOp(op);

      // A completion may only mutate the operation it started, and only while
      // the exact Goal selection/generation is unchanged. A stale callback never
      // clears or rewrites a newer operation.
      const stillCurrent = (): boolean =>
        linkOpRef.current === op &&
        selectedIdRef.current === goalId &&
        expectedRequest === detailRequestId.current;

      const fail = (phase: 'write-failed' | 'read-failed', message: string) => {
        if (!stillCurrent()) return;
        publishLinkOp({ ...op, phase, message });
      };

      try {
        if (kind === 'link') {
          await invoke<GoalLink>('goal_link_add', { goalId, targetKind, targetId });
        } else {
          await invoke<boolean>('goal_link_remove', { goalId, targetKind, targetId });
        }
      } catch (err) {
        fail(
          'write-failed',
          typeof err === 'string'
            ? err
            : `Could not ${kind} the ${targetKind === 'cron_job' ? 'cron job' : 'commitment'}.`,
        );
        return;
      }

      if (!stillCurrent()) return;

      const confirmed =
        kind === 'link'
          ? await confirmLink(goalId, targetKind, targetId)
          : await confirmUnlink(goalId, targetKind, targetId);
      if (!stillCurrent()) return;
      if (confirmed) {
        publishLinkOp(null);
        setLinkTargetId('');
        await refreshLinkState(goalId, expectedRequest);
      } else {
        fail(
          'read-failed',
          `The ${kind} was accepted, but the authoritative Goal and target rows did not confirm it. Use Refresh to reconcile; the write is not repeated automatically.`,
        );
      }
    },
    [detail, publishLinkOp, confirmLink, confirmUnlink, refreshLinkState],
  );

  // Read-only reconciliation for an unresolved link/unlink: re-read the exact
  // Goal-side link and target rows and clear only when they agree. It never
  // repeats the write, and it only mutates the operation it was started for.
  const reconcileLinks = useCallback(async () => {
    const op = linkOpRef.current;
    if (!op || op.phase === 'writing') return;
    const goalId = selectedIdRef.current;
    if (!goalId) return;
    const expectedRequest = detailRequestId.current;
    const confirmed =
      op.kind === 'link'
        ? await confirmLink(goalId, op.targetKind, op.targetId)
        : await confirmUnlink(goalId, op.targetKind, op.targetId);
    if (linkOpRef.current !== op) return;
    if (selectedIdRef.current !== goalId || expectedRequest !== detailRequestId.current) return;
    if (confirmed) {
      publishLinkOp(null);
      await refreshLinkState(goalId, expectedRequest);
    } else {
      publishLinkOp({
        ...op,
        phase: 'read-failed',
        message: `The ${op.kind} is still not confirmed by the authoritative rows. Reconcile again later; the write is not repeated automatically.`,
      });
    }
  }, [confirmLink, confirmUnlink, publishLinkOp, refreshLinkState]);

  // Reconcile an App-retained notification selector against the freshly-read
  // Goal/link/schedule/activation/run state. It never selects or focuses a
  // different/latest record: an exact Goal readback plus (when supplied) the
  // exact persisted Goal↔Cron link and exact activation/Cron/Goal/run tuple are
  // required. Only the resolved exact IDs are used, and only as a display focus.
  const applyNotificationSelector = useCallback(
    async (
      selector: GoalNotificationSelector,
      goalId: string,
      loaded: GoalDetail | null,
      scheduleResult: ScheduleRefreshResult,
      expectedRequest: number,
    ) => {
      if (loaded === null || loaded.goal.id !== selector.goal_id) {
        setSelectorFocus(null);
        setExpandedJob(null);
        setSelectorNotice(NOTIFICATION_STALE_MESSAGE);
        return;
      }
      const hasSubSelector =
        selector.cron_job_id !== undefined ||
        selector.activation_id !== undefined ||
        selector.run_id !== undefined;
      if (!hasSubSelector) {
        // Only an exact Goal id was supplied: open that Goal and do not invent
        // or select a latest activation.
        setSelectorNotice(null);
        setSelectorFocus(null);
        setExpandedJob(null);
        return;
      }
      if (scheduleResult.status !== 'ok') {
        setSelectorFocus(null);
        setExpandedJob(null);
        setSelectorNotice(NOTIFICATION_STALE_MESSAGE);
        return;
      }
      let linksRaw: unknown;
      try {
        linksRaw = await invoke<unknown>('goal_links_list', { goalId });
      } catch {
        if (expectedRequest !== detailRequestId.current) return;
        setSelectorFocus(null);
        setExpandedJob(null);
        setSelectorNotice(NOTIFICATION_STALE_MESSAGE);
        return;
      }
      if (expectedRequest !== detailRequestId.current) return;
      if (!Array.isArray(linksRaw)) {
        setSelectorFocus(null);
        setExpandedJob(null);
        setSelectorNotice(NOTIFICATION_STALE_MESSAGE);
        return;
      }
      const linkedCronIds = new Set<string>();
      for (const row of linksRaw) {
        if (!isRecord(row)) {
          setSelectorFocus(null);
          setExpandedJob(null);
          setSelectorNotice(NOTIFICATION_STALE_MESSAGE);
          return;
        }
        const rowGoalId = requiredIdentity(row, 'goal_id');
        const targetKind = requiredString(row, 'target_kind');
        const targetId = requiredIdentity(row, 'target_id');
        if (rowGoalId === null || targetKind === null || targetId === null) {
          setSelectorFocus(null);
          setExpandedJob(null);
          setSelectorNotice(NOTIFICATION_STALE_MESSAGE);
          return;
        }
        if (rowGoalId === goalId && targetKind === 'cron_job') linkedCronIds.add(targetId);
      }
      const reconciled = reconcileNotificationSelector(
        selector,
        goalId,
        scheduleResult.linkedJobIds,
        linkedCronIds,
        scheduleResult.activationsByJob,
        scheduleResult.runsByJob,
      );
      if (reconciled.status === 'ok') {
        setSelectorNotice(null);
        setSelectorFocus(reconciled.focus);
        setExpandedJob(reconciled.focus.cronJobId);
      } else {
        setSelectorFocus(null);
        setExpandedJob(null);
        setSelectorNotice(reconciled.message);
      }
    },
    [],
  );

  const loadDetail = useCallback(async (id: string, selector: GoalNotificationSelector | null = null) => {
    // Bind this read to the selection generation. A response for an older
    // selection is discarded so it can never replace a newer selected Goal.
    const request = ++detailRequestId.current;
    selectedIdRef.current = id;
    setSelectedId(id);
    setTransitionError(null);
    // A manual selection (no notification selector) clears any retained
    // notification focus/notice so a stale selector can never keep highlighting
    // a record the user has navigated away from. A selector-driven open leaves
    // the prior notice until this generation resolves it.
    if (selector === null) {
      setSelectorNotice(null);
      setSelectorFocus(null);
    }
    // Clear any detail that belongs to a different Goal so the panel and the
    // list selection never disagree; re-selecting the shown Goal is preserved.
    setDetail((prev) => (prev && prev.goal.id === id ? prev : null));
    setRuns((prev) => (prev.length > 0 ? [] : prev));
    setCommitments((prev) => (prev.length > 0 ? [] : prev));
    setSchedules((prev) => (prev.length > 0 ? [] : prev));
    setActivations((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    setCronRuns((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    setInFlight((prev) => (prev.size > 0 ? new Set<string>() : prev));
    setActivationErrors((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    setRunErrors((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    setCommitmentsUnavailable(false);
    setCommitmentsReadError(null);
    setScheduleUnavailable(false);
    setScheduleReadError(null);
    setReconciling(false);
    reconcilePending.current = false;
    scheduleOpsRef.current = {};
    setScheduleOps({});
    historyRef.current = {
      activations: {},
      runs: {},
      activationErrors: {},
      runErrors: {},
    };
    setExpandedJob(null);
    setLinkOpen(false);
    setLinkTargetKind('cron_job');
    setLinkTargetId('');
    setLinkCandidates({ kind: 'loading' });
    linkOpRef.current = null;
    setLinkOpState(null);
    setAcceptanceCandidates([]);
    setAcceptanceDoneIds(new Set());
    setAcceptanceUnavailable(false);
    setAcceptanceReadError(null);
    setAcceptanceRefreshing(false);
    setAcceptanceRunningId(null);
    setAcceptanceMessage(null);
    setConfirmedAcceptance({});
    acceptancePending.current = false;
    let loaded: GoalDetail | null = null;
    try {
      const next = await invoke<GoalDetail>('goal_get', { id });
      if (request !== detailRequestId.current) return;
      loaded = next;
      setDetail(next);
      setError(null);
    } catch {
      if (request !== detailRequestId.current) return;
      setDetail(null);
      setError(`Could not load goal ${id}.`);
    }
    // Goal-linked run/recovery view. A read failure is not fatal to the detail
    // panel; the runs list simply stays empty rather than being inferred.
    try {
      const progress = await invoke<GoalRunProgress[]>('goal_run_progress', { goalId: id });
      if (request !== detailRequestId.current) return;
      setRuns(Array.isArray(progress) ? progress : []);
    } catch {
      if (request !== detailRequestId.current) return;
      setRuns([]);
    }
    // Goal-linked Commitments and schedules are read from their own native
    // authorities. Their read failures are reported in their own panels.
    const scheduleResult = await loadGoalSupport(id, request);
    // Trusted acceptance receipts are read only from native authorities and
    // bound to this exact Goal generation.
    if (loaded && request === detailRequestId.current) {
      await loadAcceptanceState(loaded, request);
    }
    // Reconcile an App-retained notification selector only after the fresh
    // Goal/link/schedule/activation/run reads above. Selecting/expanding/focusing
    // happens only for an exact match; anything missing, malformed, or
    // conflicting is shown as stale/unavailable with no fallback.
    if (selector !== null && request === detailRequestId.current) {
      await applyNotificationSelector(selector, id, loaded, scheduleResult, request);
    }
  }, [loadGoalSupport, loadAcceptanceState, applyNotificationSelector]);

  useEffect(() => {
    void fetchGoals();
  }, [fetchGoals]);

  // Consume an App-retained notification selector exactly once. The exact Goal,
  // persisted Goal↔Cron link, `list_cron_jobs`, and the relevant
  // activation/run histories are read and reconciled BEFORE any selection,
  // expansion, or focus; a deleted/malformed/conflicting selector is never
  // selected and no other/latest record is substituted. The selector is reported
  // consumed only after the read settles, so it survives the route change into
  // Goals but is not retained as durable authority. A superseded selector is not
  // reported consumed; App clears only the exact selector it handed over.
  useEffect(() => {
    if (!notificationSelector) return;
    const selector = notificationSelector;
    let cancelled = false;
    const selectionAtStart = selectedIdRef.current;
    // Snapshot the selection generation too: a manual reselect of the SAME Goal
    // leaves selectedIdRef unchanged but bumps detailRequestId, so this prevents
    // a delayed notification preflight from overriding the manual choice.
    const generationAtStart = detailRequestId.current;
    void (async () => {
      const reconciled = await readNotificationSelector(selector);
      if (cancelled) return;
      // A newer user selection supersedes this notification open; never
      // override it with a delayed read.
      if (
        selectedIdRef.current !== selectionAtStart ||
        detailRequestId.current !== generationAtStart
      ) {
        onNotificationSelectorConsumed?.(selector);
        return;
      }
      if (reconciled.status !== 'ok') {
        setSelectorFocus(null);
        setExpandedJob(null);
        setSelectorNotice(reconciled.message);
        onNotificationSelectorConsumed?.(selector);
        return;
      }
      // Open the exact reconciled Goal; loadDetail re-reads and re-reconciles
      // the exact tuple before applying any focus, so a change between reads is
      // shown as stale rather than focused.
      await loadDetail(selector.goal_id, selector);
      if (cancelled) return;
      onNotificationSelectorConsumed?.(selector);
    })();
    return () => {
      cancelled = true;
    };
  }, [notificationSelector, loadDetail, onNotificationSelectorConsumed]);

  // Consume an App-retained cross-workflow navigation selector exactly once. The
  // exact Goal / persisted Goal↔Cron link / activation / run tuple is re-read
  // and reconciled BEFORE any selection, expansion, or focus; a stale selector
  // is never substituted and no schedule action is run. The selector is reported
  // consumed only after the read settles.
  useEffect(() => {
    if (!navigationSelector) return;
    const selector = navigationSelector;
    let cancelled = false;
    const selectionAtStart = selectedIdRef.current;
    const generationAtStart = detailRequestId.current;
    void (async () => {
      const adapted = workflowSelectorToNotificationSelector(selector);
      const reconciled = await readNotificationSelector(adapted);
      if (cancelled) return;
      // A newer user selection supersedes this handoff; never override it.
      if (
        selectedIdRef.current !== selectionAtStart ||
        detailRequestId.current !== generationAtStart
      ) {
        onNavigationSelectorConsumed?.(selector);
        return;
      }
      if (reconciled.status !== 'ok') {
        setSelectorFocus(null);
        setExpandedJob(null);
        setSelectorNotice(reconciled.message);
        onNavigationSelectorConsumed?.(selector);
        return;
      }
      // Open the exact reconciled Goal; loadDetail re-reads and re-reconciles
      // the exact tuple before applying any focus.
      await loadDetail(selector.goal_id, adapted);
      if (cancelled) return;
      onNavigationSelectorConsumed?.(selector);
    })();
    return () => {
      cancelled = true;
    };
  }, [navigationSelector, loadDetail, onNavigationSelectorConsumed]);

  // Candidate lists are loaded only when the explicit link panel is opened, and
  // are bound to the current Goal/request generation.
  useEffect(() => {
    if (!linkOpen || !selectedId) return;
    void loadLinkCandidates(detailRequestId.current);
  }, [linkOpen, selectedId, loadLinkCandidates]);

  const create = useCallback(async () => {
    if (createPending.current) return;
    const trimmedCriteria = criteria.map((c) => c.trim()).filter((c) => c.length > 0);
    if (!objective.trim() || trimmedCriteria.length === 0) {
      setCreateError('An objective and at least one acceptance criterion are required.');
      return;
    }
    createPending.current = true;
    setCreating(true);
    try {
      const created = await invoke<GoalDetail>('goal_create', {
        objective: objective.trim(),
        criteria: trimmedCriteria,
      });
      setCreateError(null);
      setObjective('');
      setCriteria(['']);
      await fetchGoals();
      void loadDetail(created.goal.id);
    } catch {
      setCreateError('Could not create the goal. Your draft was kept.');
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }, [objective, criteria, fetchGoals, loadDetail]);

  const transition = useCallback(async (to: string) => {
    if (!detail || transitionPending.current) return;
    const goalId = detail.goal.id;
    transitionPending.current = true;
    setTransitioning(true);
    setTransitionError(null);
    try {
      const next = await invoke<GoalDetail>('goal_transition', {
        id: goalId,
        toStatus: to,
      });
      // A mutation supersedes any in-flight detail read and any schedule
      // readback bound to the previous generation.
      detailRequestId.current++;
      scheduleOpsRef.current = {};
      setScheduleOps({});
      if (selectedIdRef.current !== goalId) return;
      setDetail(next);
      await fetchGoals();
    } catch (err) {
      if (selectedIdRef.current !== goalId) return;
      setTransitionError(typeof err === 'string' ? err : `Could not move goal to ${to}.`);
    } finally {
      transitionPending.current = false;
      setTransitioning(false);
    }
  }, [detail, fetchGoals]);

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50';

  const otherLinks = detail
    ? detail.links.filter(
        (link) => link.target_kind !== 'commitment' && link.target_kind !== 'cron_job',
      )
    : [];

  const goalIsProjectScoped = detail ? detail.goal.project_root !== null : false;
  const linkedJobIds = new Set(schedules.map((job) => job.id));
  const linkedCommitmentIds = new Set(commitments.map((c) => c.id));
  const sessionById = new Map<string, SessionScopeRow>(
    linkCandidates.kind === 'ready'
      ? linkCandidates.sessions.map(
          (session) => [session.id, session] as [string, SessionScopeRow],
        )
      : [],
  );
  const jobCandidates =
    linkCandidates.kind === 'ready' && detail
      ? linkCandidates.jobs.filter((job) => {
          if (job.goal_id !== null) return false;
          if (linkedJobIds.has(job.id)) return false;
          if (job.agent_id !== detail.goal.agent_id) return false;
          if (goalIsProjectScoped) {
            // A project-scoped Goal requires a persisted, session-bound job whose
            // canonical Session workspace root matches the Goal root. An
            // unavailable/malformed Session authority yields no candidate.
            if (job.session_id === null) return false;
            const session = sessionById.get(job.session_id);
            if (!session) return false;
            if (session.agent_id !== detail.goal.agent_id) return false;
            if (session.project_root !== detail.goal.project_root) return false;
          }
          return true;
        })
      : [];
  const commitmentCandidates =
    linkCandidates.kind === 'ready' && detail
      ? linkCandidates.commitments.filter(
          (c) =>
            c.goal_id === null &&
            !linkedCommitmentIds.has(c.id) &&
            (c.agent_id === null || c.agent_id === detail.goal.agent_id),
        )
      : [];

  // ── Task 2: presentation-only readiness/recovery items ──────────────────────
  //
  // Every item mirrors state this view already decoded from native authority.
  // The panel performs no read and never equates a run, receipt, or command
  // return with Goal acceptance.
  const recurringReadinessItems: WorkflowReadinessItem[] = [];
  if (loading && !detail) {
    recurringReadinessItems.push({
      id: 'goals',
      label: 'Goals',
      state: 'waiting',
      detail: 'Loading the native Goal list.',
    });
  } else if (error && !detail) {
    recurringReadinessItems.push({
      id: 'goals',
      label: 'Goals',
      state: 'unavailable',
      detail: `${error} The Goal list read failed or was malformed; this is not an authoritative empty list.`,
      recoveryLabel: 'Retry',
      onRecover: () => {
        void fetchGoals();
      },
      nextStep: 'Retry the Goal read.',
    });
  } else if (!detail) {
    recurringReadinessItems.push({
      id: 'goal',
      label: 'Goal selection',
      state: 'needs_user_input',
      detail: 'No Goal is selected.',
      nextStep: 'Select a Goal to review its schedule/commitment and trusted acceptance state.',
    });
  } else {
    if (error) {
      recurringReadinessItems.push({
        id: 'goals',
        label: 'Goals',
        state: 'unavailable',
        detail: `${error} The Goal list read failed or was malformed; the open Goal detail is shown, but the list read is unavailable.`,
        recoveryLabel: 'Retry',
        onRecover: () => {
          void fetchGoals();
        },
      });
    }
    if (scheduleUnavailable) {
      recurringReadinessItems.push({
        id: 'schedules',
        label: 'Goal-linked schedules',
        state: 'unavailable',
        detail: scheduleReadError ?? 'The native schedule authority is unavailable.',
        recoveryLabel: 'Refresh',
        onRecover: () => {
          void reconcileSchedules();
        },
      });
    } else if (schedules.length === 0) {
      recurringReadinessItems.push({
        id: 'schedules',
        label: 'Goal-linked schedules',
        state: 'needs_user_input',
        detail:
          'No cron schedules are linked to this Goal. Linking attributes future activations; it does not grant permissions.',
        nextStep: 'Link a compatible existing job or create one elsewhere; this view never creates a job.',
      });
    } else {
      const ops = Object.values(scheduleOps);
      const writing = ops.some((op) => op.phase === 'writing');
      const uncertain = ops.some((op) => op.phase !== 'writing');
      const claimStates = Object.values(activations)
        .flat()
        .map((activation) => activation.claim_state);
      const unrecognizedClaimStates = claimStates.filter(
        (state) => !hasOwn(CLAIM_VARIANT, state),
      );
      const historyUnavailable =
        Object.values(activationErrors).some(Boolean) || Object.values(runErrors).some(Boolean);
      if (writing) {
        recurringReadinessItems.push({
          id: 'schedules',
          label: 'Schedule operation',
          state: 'waiting',
          detail:
            'A schedule operation is in flight; its requested effect must be read back before it is claimed.',
        });
      } else if (uncertain) {
        recurringReadinessItems.push({
          id: 'schedules',
          label: 'Schedule operation',
          state: 'stale',
          detail:
            'A schedule operation was accepted but its requested effect is not yet observed; the display is stale until Refresh reconciles it.',
          recoveryLabel: 'Refresh',
          onRecover: () => {
            void reconcileSchedules();
          },
        });
      } else if (historyUnavailable) {
        recurringReadinessItems.push({
          id: 'history',
          label: 'Activation / run history',
          state: 'unavailable',
          detail:
            'At least one activation or run history could not be read. A missing history is unavailable, never an authoritative empty list.',
          recoveryLabel: 'Refresh',
          onRecover: () => {
            void reconcileSchedules();
          },
        });
      } else if (claimStates.includes('blocked')) {
        recurringReadinessItems.push({
          id: 'activations',
          label: 'Activation',
          state: 'blocked',
          detail: 'At least one activation is blocked by the native runtime; this panel grants nothing.',
          nextStep: 'Resolve the blocked condition through the existing activation surface.',
        });
      } else if (claimStates.includes('claimed') || claimStates.includes('dispatched')) {
        recurringReadinessItems.push({
          id: 'activations',
          label: 'Activation',
          state: 'waiting',
          detail:
            'At least one activation is claimed or dispatched and has not reached a terminal state.',
          nextStep:
            'Wait for the existing activation control to advance, or reconcile it through the existing activation surface.',
        });
      } else if (claimStates.includes('waiting_for_user')) {
        recurringReadinessItems.push({
          id: 'activations',
          label: 'Activation',
          state: 'waiting',
          detail: 'At least one activation is waiting for you.',
          nextStep: 'Respond through the existing activation control.',
        });
      } else if (claimStates.includes('ambiguous')) {
        recurringReadinessItems.push({
          id: 'activations',
          label: 'Activation',
          state: 'partial',
          detail: 'At least one activation is ambiguous and needs reconciliation.',
          recoveryLabel: 'Refresh',
          onRecover: () => {
            void reconcileSchedules();
          },
        });
      } else if (claimStates.includes('failed')) {
        recurringReadinessItems.push({
          id: 'activations',
          label: 'Activation',
          state: 'partial',
          detail: 'At least one activation failed; review its per-run receipt below.',
        });
      } else if (claimStates.includes('cancelled')) {
        recurringReadinessItems.push({
          id: 'activations',
          label: 'Activation',
          state: 'stale',
          detail: 'At least one activation was cancelled; it is not a completed occurrence.',
        });
      } else if (unrecognizedClaimStates.length > 0) {
        recurringReadinessItems.push({
          id: 'activations',
          label: 'Activation',
          state: 'unavailable',
          detail:
            'At least one activation is in an unrecognized claim state; it is unavailable, never ready.',
        });
      } else {
        recurringReadinessItems.push({
          id: 'schedules',
          label: 'Goal-linked schedules',
          state: 'ready_for_explicit_action',
          detail: `${schedules.length} linked schedule(s) with no observed blocker.`,
          nextStep: 'Use the existing pause/resume/run/cancel controls explicitly.',
        });
      }
    }

    if (commitmentsUnavailable) {
      recurringReadinessItems.push({
        id: 'commitments',
        label: 'Goal-linked commitments',
        state: 'unavailable',
        detail: commitmentsReadError ?? 'The native Commitment authority is unavailable.',
        recoveryLabel: 'Refresh',
        onRecover: () => {
          void loadDetail(detail.goal.id);
        },
      });
    }

    if (acceptanceUnavailable) {
      recurringReadinessItems.push({
        id: 'acceptance',
        label: 'Trusted acceptance',
        state: 'unavailable',
        detail: acceptanceReadError ?? 'Trusted acceptance receipts are unavailable.',
        recoveryLabel: 'Refresh',
        onRecover: () => {
          void refreshAcceptanceState();
        },
        nextStep:
          'Refresh the trusted acceptance readbacks; no completion is claimed without a full readback.',
      });
    } else if (Object.keys(confirmedAcceptance).length > 0) {
      recurringReadinessItems.push({
        id: 'acceptance',
        label: 'Trusted acceptance (confirmed)',
        state: 'ready_for_explicit_action',
        detail:
          'A trusted acceptance receipt was confirmed by native readback. This is trusted acceptance, not a plain run success or command return.',
        nextStep: 'Review the criterion check rows below; the Goal is completed only from accepted evidence.',
      });
    } else if (
      acceptanceCandidates.some(
        (candidate) =>
          candidate.execution.status === 'pending_acceptance' && candidate.receipt === null,
      )
    ) {
      recurringReadinessItems.push({
        id: 'acceptance',
        label: 'Trusted acceptance',
        state: 'ready_for_explicit_action',
        detail:
          'A bound pending-acceptance execution exists; running acceptance is an explicit, trusted native action.',
        nextStep: 'Run acceptance checks for the exact execution through the existing trusted path.',
      });
    } else if (acceptanceCandidates.length === 0) {
      recurringReadinessItems.push({
        id: 'acceptance',
        label: 'Trusted acceptance',
        state: 'needs_user_input',
        detail:
          "No bound execution or acceptance candidate is available for this Goal's criteria, Agent, and workspace.",
        nextStep:
          'Inspect the existing trusted acceptance/manifest panel or Settings for a compatible registered manifest.',
      });
    } else {
      recurringReadinessItems.push({
        id: 'acceptance',
        label: 'Trusted acceptance',
        state: 'partial',
        detail: 'Bound acceptance candidates exist but none is currently runnable or confirmed.',
        nextStep: 'Reconcile the exact operation from the trusted manifest panel.',
      });
    }

    if (selectorNotice) {
      recurringReadinessItems.push({
        id: 'selector',
        label: 'Notification / selector reconciliation',
        state: 'stale',
        detail: selectorNotice,
        recoveryLabel: 'Refresh goals',
        onRecover: () => {
          void fetchGoals();
        },
      });
    }
  }

  const recurringReadinessBoundary =
    'A successful Cron run, runtime receipt, or command return is not Goal acceptance. Completion is shown only after a trusted acceptance receipt and exact native readback. This panel creates, runs, pauses, or cancels nothing.';

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Goals"
        subtitle="User-owned objectives and the acceptance criteria they must meet"
        count={goals.length}
      />

      {onNavigateWorkflow && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-bone/40">
          <span className="uppercase tracking-[0.18em]">Open</span>
          <button
            type="button"
            onClick={() => onNavigateWorkflow('project-steward', null)}
            className="underline"
          >
            Project Steward
          </button>
          <button
            type="button"
            onClick={() => onNavigateWorkflow('researcher', null)}
            className="underline"
          >
            Attributable Researcher
          </button>
        </div>
      )}

      <WorkflowReadinessPanel
        workflow="recurring-operator"
        heading="Derived from the Goal, Goal-linked schedule/commitment, activation/run, and trusted acceptance readbacks below."
        items={recurringReadinessItems}
        boundaryNote={recurringReadinessBoundary}
        onNavigateWorkflow={
          onNavigateWorkflow ? (destination) => onNavigateWorkflow(destination, null) : undefined
        }
      />

      <GlassCard className="p-3">
        <div className="flex flex-col gap-2">
          <input
            className={inputCls}
            placeholder="What is the objective?"
            aria-label="Goal objective"
            disabled={creating}
            value={objective}
            onChange={(e) => {
              if (!createPending.current) setObjective(e.target.value);
            }}
          />
          <div className="flex flex-col gap-1.5">
            {criteria.map((criterion, index) => (
              <div key={index} className="flex gap-2">
                <input
                  className={cn(inputCls, 'flex-1')}
                  placeholder={`Acceptance criterion ${index + 1}`}
                  aria-label={`Acceptance criterion ${index + 1}`}
                  disabled={creating}
                  value={criterion}
                  onChange={(e) => {
                    if (createPending.current) return;
                    setCriteria((prev) => prev.map((v, i) => (i === index ? e.target.value : v)));
                  }}
                />
                {criteria.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove acceptance criterion ${index + 1}`}
                    disabled={creating}
                    onClick={() => setCriteria((prev) => prev.filter((_, i) => i !== index))}
                    className="px-2 text-bone/40 hover:text-red-200 transition-colors"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              disabled={creating}
              onClick={() => setCriteria((prev) => [...prev, ''])}
              className="self-start text-xs text-bone/50 hover:text-bone transition-colors"
            >
              + Add criterion
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={create}
              disabled={creating || !objective.trim()}
              className="px-4 py-2 text-sm rounded-lg bg-accent text-bone hover:bg-accent/80 disabled:opacity-40 transition-colors"
            >
              {creating ? 'Creating…' : 'Create goal'}
            </button>
            <span className="text-[11px] text-bone/40">
              Goals start pending. Completion requires verified evidence and is not available yet.
            </span>
          </div>
          {createError && (
            <div role="alert" className="text-sm text-red-200">
              {createError}
            </div>
          )}
        </div>
      </GlassCard>

      <div className="flex-1 flex gap-4 min-h-0">
        <div className="w-80 shrink-0 overflow-y-auto min-h-0">
          {error && (
            <div role="alert" className="text-sm text-red-200 mb-2">
              {error}{' '}
              <button type="button" disabled={loading} onClick={() => void fetchGoals()} className="underline disabled:opacity-40">
                Retry
              </button>
            </div>
          )}
          {loading && goals.length === 0 ? (
            <LoadingState message="Loading goals…" />
          ) : goals.length === 0 ? (
            <EmptyState message="No goals yet. Create one above." />
          ) : (
            <ul className="space-y-2">
              {goals.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => void loadDetail(g.id)}
                    aria-current={g.id === selectedId ? 'true' : undefined}
                    className={cn(
                      'w-full text-left rounded-xl border p-3 transition-colors',
                      g.id === selectedId
                        ? 'border-accent/50 bg-white/5'
                        : 'border-white/10 hover:bg-white/5',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <StatusDot variant={statusVariant(g.status)} />
                      <span className="text-sm text-bone truncate">{g.objective}</span>
                    </div>
                    <div className="mt-1">
                      <Pill variant={statusVariant(g.status)}>{g.status}</Pill>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {selectorNotice && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-[11px] text-warning"
            >
              {selectorNotice}{' '}
              <button type="button" onClick={() => void fetchGoals()} className="underline">
                Refresh goals
              </button>
            </div>
          )}
          {!detail ? (
            <EmptyState message="Select a goal to review its criteria and state." />
          ) : (
            <div className="flex flex-col gap-3">
              <GlassCard className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-bone">{detail.goal.objective}</h3>
                  <Pill variant={statusVariant(detail.goal.status)}>{detail.goal.status}</Pill>
                </div>
                <div className="mt-2 text-[11px] text-bone/40 font-mono">
                  {detail.goal.agent_id}
                  {detail.goal.project_root ? ` · ${detail.goal.project_root}` : ''} · objective:{' '}
                  {detail.goal.objective_authority}
                </div>
                <div className="mt-4">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                    Acceptance criteria
                  </div>
                  {detail.criteria.length === 0 ? (
                    <div className="text-sm text-bone/40 mt-1">No criteria recorded.</div>
                  ) : (
                    <ol className="mt-2 space-y-1.5">
                      {detail.criteria.map((criterion, index) => (
                        <li key={criterion.id} className="flex gap-2 text-sm text-bone/80">
                          <span className="text-bone/40 font-mono">{index + 1}.</span>
                          <span>{criterion.text}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div className="mt-4">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                    Move state
                  </div>
                  {allowedTransitions(detail.goal.status).length === 0 ? (
                    <div className="text-sm text-bone/40 mt-1">
                      {TERMINAL_STATUSES.includes(detail.goal.status)
                        ? `This goal is ${detail.goal.status}; terminal states do not change.`
                        : 'No transitions available.'}
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {allowedTransitions(detail.goal.status).map((to) => (
                        <button
                          key={to}
                          type="button"
                          disabled={transitioning}
                          onClick={() => void transition(to)}
                          className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 disabled:opacity-40 transition-colors"
                        >
                          {to}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 text-[11px] text-bone/40">
                    Marking complete is withheld until accepted evidence exists.
                  </div>
                  {transitionError && (
                    <div role="alert" className="text-sm text-red-200 mt-1">
                      {transitionError}
                    </div>
                  )}
                </div>
              </GlassCard>

              <GlassCard className="p-4">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                    Trusted acceptance
                  </div>
                  <button
                    type="button"
                    aria-label="Refresh trusted acceptance receipts from the native authority"
                    disabled={acceptanceRefreshing || acceptanceRunningId !== null}
                    onClick={() => void refreshAcceptanceState()}
                    className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 disabled:opacity-40 transition-colors"
                  >
                    {acceptanceRefreshing ? 'Refreshing…' : 'Refresh'}
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-bone/40">
                  Acceptance runs only through the native trusted manifest and the current Permission
                  policy. Completion is shown only after a durable native readback; a tool run or a
                  command return is never acceptance.
                </div>
                {acceptanceReadError && (
                  <div role="alert" className="mt-2 text-sm text-red-200">
                    {acceptanceReadError}
                  </div>
                )}
                {acceptanceMessage && (
                  <div role="status" className="mt-2 text-[11px] text-bone/60">
                    {acceptanceMessage}
                  </div>
                )}
                {acceptanceCandidates.length === 0 && !acceptanceUnavailable ? (
                  <div className="text-sm text-bone/40 mt-2">
                    No bound execution or acceptance candidate is available for this Goal&apos;s
                    criteria, Agent, and workspace. Inspect the existing trusted acceptance/manifest
                    panel or Settings for a compatible registered manifest.
                  </div>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {acceptanceCandidates.map((candidate) => {
                      const { execution, manifest, receipt } = candidate;
                      // A native run confirmation is only ever trusted for the
                      // exact execution it was minted for; the decision still
                      // re-verifies the current Goal/Action/manifest readbacks.
                      const sessionConfirmed = confirmedAcceptance[execution.execution_id];
                      const decisionCandidate =
                        sessionConfirmed && sessionConfirmed.execution_id === execution.execution_id
                          ? { execution, manifest, receipt: sessionConfirmed }
                          : candidate;
                      // A tuple/read integrity failure makes the panel
                      // unavailable; never show an accepted state from a
                      // possibly-stale confirmation in that case.
                      const accepted =
                        !acceptanceUnavailable &&
                        isAcceptedCompleted(decisionCandidate, detail, acceptanceDoneIds);
                      const canRun =
                        execution.status === 'pending_acceptance' &&
                        receipt === null &&
                        detail.goal.status !== 'completed' &&
                        detail.goal.status !== 'failed' &&
                        detail.goal.status !== 'cancelled';
                      return (
                        <li
                          key={execution.execution_id}
                          className="rounded-lg border border-white/10 p-3"
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <Pill variant={executionStatusVariant(execution.status)}>
                              {execution.status}
                            </Pill>
                            {receipt && (
                              <Pill variant={acceptanceStatusVariant(receipt.status)}>
                                acceptance: {receipt.status}
                              </Pill>
                            )}
                            {accepted && <Pill variant="success">accepted &amp; completed</Pill>}
                            {receipt && !accepted && receipt.status === 'accepted' && (
                              <Pill variant="warn">delivery not confirmed</Pill>
                            )}
                          </div>
                          <div className="mt-1 text-[11px] text-bone/50 font-mono break-all">
                            <div>action {execution.action_id}</div>
                            <div>execution {execution.execution_id}</div>
                            <div>
                              manifest {manifest.manifest_id} · v{manifest.registry_version} ·{' '}
                              {manifest.content_hash.slice(0, 12)}… · schema {manifest.schema_version}
                            </div>
                            <div>
                              agent {manifest.agent_id} · workspace {manifest.project_root}
                            </div>
                          </div>
                          {execution.terminal_reason && (
                            <div className="mt-1 text-[11px] text-bone/50">
                              reason: {execution.terminal_reason}
                            </div>
                          )}
                          {execution.conflict?.detail && (
                            <div className="mt-1 text-[11px] text-warning">
                              conflict: {execution.conflict.detail}
                            </div>
                          )}
                          {evidenceSummary(execution.evidence) && (
                            <div className="mt-1 text-[11px] text-bone/40">
                              run evidence: {evidenceSummary(execution.evidence)}
                            </div>
                          )}
                          {receipt && (
                            <div className="mt-2 space-y-1">
                              <div className="text-[11px] text-bone/50 font-mono break-all">
                                <div>
                                  acceptance {receipt.acceptance_key} · goal {receipt.goal_id}
                                </div>
                                <div>
                                  runtime {receipt.runtime_started_at ?? '—'} →{' '}
                                  {receipt.runtime_finished_at ?? '—'}
                                </div>
                              </div>
                              {receipt.terminal_reason && (
                                <div className="text-[11px] text-bone/50">
                                  delivery note: {receipt.terminal_reason}
                                </div>
                              )}
                              <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                                Criterion checks
                              </div>
                              <ul className="space-y-1">
                                {receipt.criteria.map((criterion) => (
                                  <li
                                    key={`${criterion.criterion_id}:${criterion.check_index}`}
                                    className="text-[11px] font-mono text-bone/70"
                                  >
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Pill variant={criterion.accepted ? 'success' : 'error'}>
                                        {criterion.accepted ? 'accepted' : 'not accepted'}
                                      </Pill>
                                      <span>{criterion.tool}</span>
                                      <span className="text-bone/40">
                                        check {criterion.check_index}
                                      </span>
                                    </div>
                                    <div className="text-bone/40 break-all">
                                      criterion {criterion.criterion_id} · expected{' '}
                                      {criterion.expected_sha256.slice(0, 12)}… · actual{' '}
                                      {criterion.actual_sha256
                                        ? `${criterion.actual_sha256.slice(0, 12)}…`
                                        : '—'}
                                    </div>
                                    {criterionEvidenceSummary(criterion.evidence) && (
                                      <div className="text-bone/40">
                                        {criterionEvidenceSummary(criterion.evidence)}
                                      </div>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {canRun && (
                            <div className="mt-2">
                              <button
                                type="button"
                                aria-label={`Run acceptance checks for execution ${execution.execution_id}`}
                                disabled={acceptanceRunningId !== null}
                                onClick={() => void runAcceptance(execution.execution_id)}
                                className="px-2 py-0.5 rounded-md border border-accent/40 text-xs text-accent/90 hover:bg-accent/10 disabled:opacity-40 transition-colors"
                              >
                                {acceptanceRunningId === execution.execution_id
                                  ? 'Running acceptance…'
                                  : 'Run acceptance checks'}
                              </button>
                              <div className="mt-1 text-[10px] text-bone/40">
                                Bound to this exact pending-acceptance execution. Native revalidates
                                the manifest, Agent/workspace scope, Goal criteria, and Permission
                                policy.
                              </div>
                            </div>
                          )}
                          {!canRun && !receipt && execution.status !== 'pending_acceptance' && (
                            <div className="mt-1 text-[11px] text-bone/40">
                              This execution is not awaiting acceptance; reconcile the exact
                              operation from the trusted manifest panel.
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </GlassCard>

              <GlassCard className="p-4">
                <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                  Goal-linked runs
                </div>
                {runs.length === 0 ? (
                  <div className="text-sm text-bone/40 mt-1">
                    No goal-linked runs recorded yet. Link a goal from Chat to record run progress
                    and evidence here.
                  </div>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {runs.map((run) => (
                      <li key={run.run_id} className="text-sm text-bone/80">
                        <div className="flex items-center gap-2">
                          <Pill variant={run.interrupted ? 'warn' : statusVariant(run.outcome)}>
                            {run.interrupted ? 'interrupted' : run.outcome}
                          </Pill>
                          <span className="font-mono text-xs text-bone/60 truncate">{run.run_id}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-bone/40 font-mono">
                          session {run.session_id}
                          {run.finished_at ? ` · ${run.finished_at}` : ''}
                          {run.resumable ? ' · resumable' : ''}
                        </div>
                        {run.evidence_refs.length > 0 && (
                          <div className="mt-1 text-[11px] text-bone/50">
                            Progress evidence: {run.evidence_refs.join(', ')}
                          </div>
                        )}
                        {run.accepted_output_pending && (
                          <div className="mt-1 text-[11px] text-bone/40">
                            Accepted output: pending / unverified until trusted acceptance checks
                            run and confirm from durable native receipts; the completion gate stays
                            open.
                          </div>
                        )}
                        {onNavigateWorkflow && (
                          <button
                            type="button"
                            onClick={() =>
                              onNavigateWorkflow('project-steward', {
                                workflow: 'project-steward',
                                session_id: run.session_id,
                                goal_id: detail.goal.id,
                                session_run_id: run.run_id,
                              })
                            }
                            className="mt-1 underline text-[11px] text-bone/50 hover:text-bone"
                          >
                            Open this run in Project Steward
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </GlassCard>

              <GlassCard className="p-4">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                    Link an existing record
                  </div>
                  <button
                    type="button"
                    aria-label="Toggle linking an existing cron job or commitment"
                    onClick={() => {
                      setLinkTargetId('');
                      setLinkOpen((open) => !open);
                    }}
                    className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 transition-colors"
                  >
                    {linkOpen ? 'Close' : 'Link record…'}
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-bone/40">
                  Linking records attribution only. It never creates a cron job, grants
                  permissions, or completes the Goal.
                </div>

                {linkOpen && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-bone/50" htmlFor="goal-link-kind">
                        Kind
                      </label>
                      <select
                        id="goal-link-kind"
                        value={linkTargetKind}
                        disabled={linkOpState?.phase === 'writing'}
                        onChange={(e) => {
                          setLinkTargetKind(e.target.value as LinkTargetKind);
                          setLinkTargetId('');
                        }}
                        className="px-2 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-bone"
                      >
                        <option value="cron_job">Cron job</option>
                        <option value="commitment">Commitment</option>
                      </select>
                    </div>

                    {linkCandidates.kind === 'loading' && (
                      <div role="status" className="text-[11px] text-bone/40">
                        Loading candidates…
                      </div>
                    )}
                    {linkCandidates.kind === 'error' && (
                      <div role="alert" className="text-[11px] text-red-200">
                        {linkCandidates.message}{' '}
                        <button
                          type="button"
                          onClick={() => void loadLinkCandidates(detailRequestId.current)}
                          className="underline"
                        >
                          Retry
                        </button>
                      </div>
                    )}

                    {linkCandidates.kind === 'ready' &&
                      linkTargetKind === 'cron_job' &&
                      (goalIsProjectScoped && jobCandidates.length === 0 ? (
                        <div role="alert" className="text-[11px] text-warning">
                          This Goal is project-scoped. A cron job may be linked only when it is
                          already bound to a Session whose Agent and canonical workspace pass the
                          native compatibility validator. No compatible existing session-bound job
                          is available. A new cron job cannot be created-and-linked here; bind an
                          existing job elsewhere first.
                        </div>
                      ) : jobCandidates.length === 0 ? (
                        <div className="text-[11px] text-bone/40">
                          No compatible unlinked cron jobs are available.
                        </div>
                      ) : (
                        <select
                          aria-label="Cron job candidate"
                          value={linkTargetId}
                          disabled={linkOpState?.phase === 'writing'}
                          onChange={(e) => setLinkTargetId(e.target.value)}
                          className="w-full px-2 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-bone"
                        >
                          <option value="">Select a cron job…</option>
                          {jobCandidates.map((job) => (
                            <option key={job.id} value={job.id}>
                              {job.name} · {job.schedule} · agent {job.agent_id}
                              {job.session_id ? ' · session-bound' : ''}
                            </option>
                          ))}
                        </select>
                      ))}

                    {linkCandidates.kind === 'ready' &&
                      linkTargetKind === 'commitment' &&
                      (goalIsProjectScoped ? (
                        <div role="alert" className="text-[11px] text-warning">
                          Commitments have no workspace association and cannot be linked to a
                          project-scoped Goal under the current native contract.
                        </div>
                      ) : commitmentCandidates.length === 0 ? (
                        <div className="text-[11px] text-bone/40">
                          No compatible unlinked commitments are available.
                        </div>
                      ) : (
                        <select
                          aria-label="Commitment candidate"
                          value={linkTargetId}
                          disabled={linkOpState?.phase === 'writing'}
                          onChange={(e) => setLinkTargetId(e.target.value)}
                          className="w-full px-2 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-bone"
                        >
                          <option value="">Select a commitment…</option>
                          {commitmentCandidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.text} · {c.status}
                              {c.agent_id ? ` · agent ${c.agent_id}` : ' · user-wide'}
                            </option>
                          ))}
                        </select>
                      ))}

                    <button
                      type="button"
                      disabled={linkTargetId === '' || linkOpState !== null}
                      onClick={() => void runLinkOp('link', linkTargetKind, linkTargetId)}
                      className="px-3 py-1 rounded-md border border-accent/40 text-xs text-accent/90 hover:bg-accent/10 disabled:opacity-40 transition-colors"
                    >
                      {linkOpState?.kind === 'link' && linkOpState.phase === 'writing'
                        ? 'Linking…'
                        : 'Link selected'}
                    </button>

                    {linkOpState && linkOpState.phase !== 'writing' && (
                      <div role="alert" className="text-[11px] text-red-200">
                        {linkOpState.message}{' '}
                        <button
                          type="button"
                          onClick={() => void reconcileLinks()}
                          className="underline"
                        >
                          Refresh
                        </button>
                        <div className="mt-0.5 text-bone/40">
                          The write is not repeated automatically. Refresh re-reads the
                          authoritative Goal and target rows.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </GlassCard>

              <GlassCard className="p-4">
                <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                  Goal-linked commitments
                </div>
                {commitmentsReadError && (
                  <div role="alert" className="mt-1 text-sm text-red-200">
                    {commitmentsReadError}
                  </div>
                )}
                {commitmentsUnavailable && commitments.length > 0 && (
                  <div className="mt-1 text-[11px] text-warning">
                    Showing previously loaded commitments; they may be stale.
                  </div>
                )}
                {commitments.length === 0 && !commitmentsUnavailable ? (
                  <div className="text-sm text-bone/40 mt-1">
                    No commitments are linked to this goal. Linking records attribution only;
                    commitment completion is never treated as goal acceptance.
                  </div>
                ) : commitments.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {commitments.map((commitment) => (
                      <li key={commitment.id} className="text-sm text-bone/80">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Pill variant={commitment.status === 'completed' ? 'success' : 'default'}>
                            {commitment.status}
                          </Pill>
                          <span>{commitment.text}</span>
                          <button
                            type="button"
                            aria-label={`Unlink commitment ${commitment.id} from this goal`}
                            disabled={linkOpState !== null}
                            onClick={() => void runLinkOp('unlink', 'commitment', commitment.id)}
                            className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/60 hover:bg-white/10 disabled:opacity-40 transition-colors"
                          >
                            {linkOpState?.kind === 'unlink' &&
                            linkOpState.targetId === commitment.id &&
                            linkOpState.phase === 'writing'
                              ? 'Unlinking…'
                              : 'Unlink'}
                          </button>
                        </div>
                        <div className="mt-1 text-[11px] text-bone/40 font-mono">
                          {commitment.agent_id ? `agent ${commitment.agent_id} · ` : ''}
                          {commitment.due ? `due ${commitment.due} · ` : ''}
                          commitment {commitment.id}
                          {commitment.completed_at ? ` · completed ${commitment.completed_at}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </GlassCard>

              <GlassCard className="p-4">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                    Goal-linked schedules
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Refresh schedule state from the native authority"
                      disabled={reconciling || hasWritingScheduleOp(scheduleOps)}
                      onClick={() => void reconcileSchedules()}
                      className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 disabled:opacity-40 transition-colors"
                    >
                      {reconciling ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <div className="text-[11px] text-bone/40">
                      A successful run is progress evidence, not goal acceptance.
                    </div>
                  </div>
                </div>
                {scheduleReadError && (
                  <div role="alert" className="mt-1 text-sm text-red-200">
                    {scheduleReadError}
                  </div>
                )}
                {scheduleUnavailable && schedules.length > 0 && (
                  <div role="alert" className="mt-1 text-[11px] text-warning">
                    Showing previously loaded schedules; they may be stale and their controls are
                    disabled until the schedule state is reconciled.
                  </div>
                )}
                {schedules.length === 0 && !scheduleUnavailable ? (
                  <div className="text-sm text-bone/40 mt-1">
                    No cron schedules are linked to this goal. Associating a job attributes its
                    future activations to this objective; it does not grant permissions.
                  </div>
                ) : schedules.length > 0 ? (
                  <ul className="mt-2 space-y-3">
                    {schedules.map((job) => {
                      const op = scheduleOps[job.id];
                      const running = inFlight.has(job.id);
                      const jobActivations = activations[job.id] ?? [];
                      const jobRuns = cronRuns[job.id] ?? [];
                      const actionable = jobActivations.filter((a) =>
                        ACTIONABLE_CLAIM_STATES.includes(a.claim_state),
                      );
                      const expanded = expandedJob === job.id;
                      // The mutation controls require this exact job's native
                      // schedule and activation/run history. If the schedule
                      // authority is unavailable, or this job's activation/run
                      // history is malformed/unreadable, no mutation may be
                      // submitted (per-job, so other jobs stay controllable).
                      const historyUnavailable =
                        activationErrors[job.id] === true || runErrors[job.id] === true;
                      const scheduleStateUnavailable = scheduleUnavailable || historyUnavailable;
                      return (
                        <li
                          key={job.id}
                          className={cn(
                            'rounded-lg border border-white/10 p-3',
                            selectorFocus?.cronJobId === job.id &&
                              'border-accent/50 ring-1 ring-accent/30',
                          )}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <StatusDot ok={job.enabled} warn={!job.enabled} />
                            <span className="text-sm text-bone truncate">{job.name}</span>
                            <Pill variant={job.enabled ? 'success' : 'default'}>
                              {job.enabled ? 'enabled' : 'paused'}
                            </Pill>
                            {running && <Pill variant="info">running</Pill>}
                          </div>
                          <div className="mt-1 text-[11px] text-bone/40 font-mono">
                            {job.schedule} · next {job.next_run ?? '—'} · last{' '}
                            {job.last_run ?? 'never'} · {job.run_count} runs · agent {job.agent_id}
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {job.enabled ? (
                              <button
                                type="button"
                                aria-label={`Pause schedule ${job.name}`}
                                disabled={op !== undefined || scheduleStateUnavailable}
                                onClick={() => void runScheduleOp('pause', job)}
                                className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 disabled:opacity-40 transition-colors"
                              >
                                {op?.kind === 'pause' && op.phase === 'writing' ? 'Pausing…' : 'Pause'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                aria-label={`Resume schedule ${job.name}`}
                                disabled={op !== undefined || scheduleStateUnavailable}
                                onClick={() => void runScheduleOp('resume', job)}
                                className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 disabled:opacity-40 transition-colors"
                              >
                                {op?.kind === 'resume' && op.phase === 'writing' ? 'Resuming…' : 'Resume'}
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label={`Run schedule ${job.name} now`}
                              title="Starts a new manual occurrence; this is not a replay of a prior activation."
                              disabled={
                                op !== undefined ||
                                running ||
                                !job.enabled ||
                                scheduleStateUnavailable
                              }
                              onClick={() => void runScheduleOp('run', job)}
                              className="px-2 py-0.5 rounded-md border border-accent/40 text-xs text-accent/90 hover:bg-accent/10 disabled:opacity-40 transition-colors"
                            >
                              {op?.kind === 'run' && op.phase === 'writing' ? 'Starting…' : 'Run now'}
                            </button>
                            {running && (
                              <button
                                type="button"
                                aria-label={`Cancel schedule ${job.name}`}
                                disabled={op !== undefined || scheduleStateUnavailable}
                                onClick={() => void runScheduleOp('cancel', job)}
                                className="px-2 py-0.5 rounded-md border border-error/40 text-xs text-error/90 hover:bg-error/10 disabled:opacity-40 transition-colors"
                              >
                                {op?.kind === 'cancel' && op.phase === 'writing' ? 'Cancelling…' : 'Cancel'}
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label={`Unlink cron job ${job.name} from this goal`}
                              disabled={linkOpState !== null}
                              onClick={() => void runLinkOp('unlink', 'cron_job', job.id)}
                              className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/60 hover:bg-white/10 disabled:opacity-40 transition-colors"
                            >
                              {linkOpState?.kind === 'unlink' &&
                              linkOpState.targetId === job.id &&
                              linkOpState.phase === 'writing'
                                ? 'Unlinking…'
                                : 'Unlink'}
                            </button>
                          </div>

                          <div className="mt-1 text-[10px] text-bone/30">
                            Pause stops future activations and requests cancellation of any in-flight
                            run. Run now starts a new manual occurrence.
                          </div>

                          {historyUnavailable && (
                            <div role="alert" className="mt-1.5 text-[11px] text-warning">
                              This schedule&apos;s activation/run history is unavailable; its
                              mutation controls are disabled until the state is reconciled.
                            </div>
                          )}

                          {op && op.phase === 'writing' && (
                            <div role="status" className="mt-1.5 text-[11px] text-bone/40">
                              {'Submitting and confirming the authoritative schedule state…'}
                            </div>
                          )}
                          {op && (op.phase === 'write-failed' || op.phase === 'read-failed') && (
                            <div role="alert" className="mt-1.5 text-[11px] text-red-200">
                              {op.message}
                              <div className="mt-0.5 text-bone/40">
                                The mutation is not re-submitted automatically. Use Refresh above to
                                re-read the authoritative schedule state.
                              </div>
                            </div>
                          )}

                          {actionable.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {actionable.map((activation) => (
                                <div
                                  key={activation.activation_id}
                                  role="alert"
                                  className={cn(
                                    'rounded-md border p-2 text-[11px]',
                                    activation.claim_state === 'blocked'
                                      ? 'border-error/30 bg-error/5 text-error'
                                      : 'border-warning/30 bg-warning/5 text-warning',
                                  )}
                                >
                                  <span className="font-semibold uppercase tracking-wider">
                                    {actionableLabel(activation.claim_state)}
                                  </span>
                                  {activation.terminal_reason
                                    ? `: ${activation.terminal_reason}`
                                    : ''}
                                  <div className="mt-0.5 text-bone/40 font-mono">
                                    occurrence {activation.schedule_occurrence} ·{' '}
                                    {activation.claimed_at}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="mt-2">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => setExpandedJob(expanded ? null : job.id)}
                              className="text-[10px] font-mono text-bone/50 hover:text-bone transition-colors"
                            >
                              {expanded ? '▾' : '▸'} Activation history ({jobActivations.length})
                            </button>
                            {expanded && (
                              <div className="mt-1.5 pl-2 border-l border-white/10 space-y-2">
                                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                                  Claimed activations
                                </div>
                                {activationErrors[job.id] ? (
                                  <div role="alert" className="text-[11px] text-red-200">
                                    Activation history could not be read; it is unavailable, not
                                    empty.
                                  </div>
                                ) : jobActivations.length === 0 ? (
                                  <div className="text-[11px] text-bone/40">
                                    No activations recorded yet.
                                  </div>
                                ) : (
                                  <ul className="space-y-2">
                                    {jobActivations.map((activation) => {
                                      const joined = joinedRunForActivation(activation, jobRuns);
                                      return (
                                        <li
                                          key={activation.activation_id}
                                          className={cn(
                                            'rounded-md border border-white/10 p-2 text-[11px] font-mono text-bone/70',
                                            selectorFocus?.cronJobId === job.id &&
                                              selectorFocus?.activationId ===
                                                activation.activation_id &&
                                              'border-accent/50 bg-accent/5 ring-1 ring-accent/30',
                                          )}
                                        >
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <Pill variant={claimVariant(activation.claim_state)}>
                                              {activation.claim_state}
                                            </Pill>
                                            <span>{actionableLabel(activation.claim_state)}</span>
                                            <span className="text-bone/40">
                                              {activation.trigger_kind}
                                            </span>
                                          </div>
                                          <div className="mt-1 text-bone/50 break-all">
                                            <div>activation {activation.activation_id}</div>
                                            <div>
                                              cron {activation.cron_id} · goal{' '}
                                              {activation.goal_id ?? 'unbound'}
                                            </div>
                                            <div>
                                              agent {activation.agent_id}
                                              {activation.session_id
                                                ? ` · session ${activation.session_id}`
                                                : ''}
                                              {activation.project_root
                                                ? ` · root ${activation.project_root}`
                                                : ''}
                                            </div>
                                            <div>
                                              occurrence {activation.schedule_occurrence}
                                            </div>
                                            <div>
                                              claimed {activation.claimed_at}
                                              {activation.dispatched_at
                                                ? ` · dispatched ${activation.dispatched_at}`
                                                : ''}
                                              {activation.settled_at
                                                ? ` · settled ${activation.settled_at}`
                                                : ''}
                                            </div>
                                            <div>
                                              run {activation.run_id ?? 'none'}
                                              {activation.bun_run_id
                                                ? ` · bun ${activation.bun_run_id}`
                                                : ''}
                                            </div>
                                          </div>
                                          {activation.terminal_reason && (
                                            <div className="mt-1 text-bone/60">
                                              reason: {activation.terminal_reason}
                                            </div>
                                          )}
                                          {runErrors[job.id] ? (
                                            <div className="mt-1 text-bone/40">
                                              Run history is unavailable; no run relation is claimed
                                              for this activation.
                                            </div>
                                          ) : joined ? (
                                            <RunReceipt
                                              run={joined}
                                              activationBunRunId={activation.bun_run_id}
                                            />
                                          ) : (
                                            <div className="mt-1 text-bone/40">
                                              No run is joined to this activation by exact
                                              Cron/Goal/activation/occurrence identity.
                                            </div>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                )}

                                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40">
                                  Runs without a matched activation
                                </div>
                                {runErrors[job.id] ? (
                                  <div role="alert" className="text-[11px] text-red-200">
                                    Run history could not be read; it is unavailable, not empty.
                                  </div>
                                ) : (
                                  (() => {
                                    const unmatched = jobRuns.filter(
                                      (run) =>
                                        matchedActivationForRun(run, jobActivations) === null,
                                    );
                                    if (unmatched.length === 0) {
                                      return (
                                        <div className="text-[11px] text-bone/40">
                                          Every run is joined to an activation.
                                        </div>
                                      );
                                    }
                                    return (
                                      <ul className="space-y-2">
                                        {unmatched.slice(0, 10).map((run) => (
                                          <li
                                            key={run.id}
                                            className={cn(
                                              'rounded-md border border-warning/20 p-2 text-[11px] font-mono text-bone/70',
                                              selectorFocus?.cronJobId === job.id &&
                                                selectorFocus?.runId === run.id &&
                                                'border-accent/50 bg-accent/5 ring-1 ring-accent/30',
                                            )}
                                          >
                                            <div className="text-bone/40">
                                              Activation relation unavailable or conflicting; shown
                                              separately.
                                            </div>
                                            <RunReceipt run={run} activationBunRunId={null} />
                                          </li>
                                        ))}
                                      </ul>
                                    );
                                  })()
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </GlassCard>

              <GlassCard className="p-4">
                <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-bone/40">
                  Other linked records
                </div>
                {otherLinks.length === 0 ? (
                  <div className="text-sm text-bone/40 mt-1">
                    No other association links. Commitment and cron schedule links appear above;
                    goal-linked runs appear above once a turn is executed under this goal.
                  </div>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {otherLinks.map((link) => (
                      <li key={link.id} className="text-sm text-bone/70 font-mono">
                        {link.target_kind}: {link.target_id}
                      </li>
                    ))}
                  </ul>
                )}
              </GlassCard>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
