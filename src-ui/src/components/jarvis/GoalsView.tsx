// ── GoalsView — durable user-owned Goals with acceptance criteria ──
//    (goal_create/goal_list/goal_get/goal_update/goal_transition/
//     goal_links_list). A Goal is never shown as complete here: completion
//    requires verified acceptance evidence that this part does not implement.

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

interface CronActivation {
  activation_id: string;
  cron_id: string;
  schedule_occurrence: string;
  trigger_kind: string;
  claim_state: string;
  run_id: string | null;
  terminal_reason: string | null;
  claimed_at: string;
  dispatched_at: string | null;
  settled_at: string | null;
}

interface CronRunRecord {
  id: string;
  cron_id: string;
  status: string;
  error: string;
  terminal_reason: string | null;
  started_at: string;
  finished_at: string | null;
  activation_id: string | null;
  schedule_occurrence: string | null;
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

export default function GoalsView() {
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
          if (Array.isArray(rows)) {
            nextActivations[job.id] = rows as CronActivation[];
            observedActivations[job.id] = rows as CronActivation[];
          } else {
            nextActivations[job.id] = [];
            nextActivationErrors[job.id] = true;
          }
        } catch {
          if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
          nextActivations[job.id] = [];
          nextActivationErrors[job.id] = true;
        }
        try {
          const rows = await invoke<unknown>('get_cron_runs', {
            cronId: job.id,
          });
          if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
          if (Array.isArray(rows)) {
            nextRuns[job.id] = rows as CronRunRecord[];
            observedRuns[job.id] = rows as CronRunRecord[];
          } else {
            nextRuns[job.id] = [];
            nextRunErrors[job.id] = true;
          }
        } catch {
          if (expectedRequest !== detailRequestId.current) return { status: 'stale' };
          nextRuns[job.id] = [];
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
    async (goalId: string, expectedRequest: number) => {
      try {
        const all = await invoke<unknown>('get_commitments');
        if (expectedRequest !== detailRequestId.current) return;
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
        if (expectedRequest !== detailRequestId.current) return;
        setCommitmentsUnavailable(true);
        setCommitmentsReadError(
          'Could not read linked commitments from the native authority. Linked commitments are unavailable.',
        );
      }
      await refreshScheduleState(goalId, expectedRequest);
    },
    [refreshScheduleState],
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

  const loadDetail = useCallback(async (id: string) => {
    // Bind this read to the selection generation. A response for an older
    // selection is discarded so it can never replace a newer selected Goal.
    const request = ++detailRequestId.current;
    selectedIdRef.current = id;
    setSelectedId(id);
    setTransitionError(null);
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
    try {
      const next = await invoke<GoalDetail>('goal_get', { id });
      if (request !== detailRequestId.current) return;
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
    await loadGoalSupport(id, request);
  }, [loadGoalSupport]);

  useEffect(() => {
    void fetchGoals();
  }, [fetchGoals]);

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

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      <SectionHeader
        title="Goals"
        subtitle="User-owned objectives and the acceptance criteria they must meet"
        count={goals.length}
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
                            Accepted output: pending / unverified (trusted acceptance is not
                            implemented; the completion gate stays open).
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
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
                        <div className="flex items-center gap-2">
                          <Pill variant={commitment.status === 'completed' ? 'success' : 'default'}>
                            {commitment.status}
                          </Pill>
                          <span>{commitment.text}</span>
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
                      return (
                        <li key={job.id} className="rounded-lg border border-white/10 p-3">
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
                                disabled={op !== undefined || scheduleUnavailable}
                                onClick={() => void runScheduleOp('pause', job)}
                                className="px-2 py-0.5 rounded-md border border-white/15 text-xs text-bone/80 hover:bg-white/10 disabled:opacity-40 transition-colors"
                              >
                                {op?.kind === 'pause' && op.phase === 'writing' ? 'Pausing…' : 'Pause'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                aria-label={`Resume schedule ${job.name}`}
                                disabled={op !== undefined || scheduleUnavailable}
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
                                op !== undefined || running || !job.enabled || scheduleUnavailable
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
                                disabled={op !== undefined || scheduleUnavailable}
                                onClick={() => void runScheduleOp('cancel', job)}
                                className="px-2 py-0.5 rounded-md border border-error/40 text-xs text-error/90 hover:bg-error/10 disabled:opacity-40 transition-colors"
                              >
                                {op?.kind === 'cancel' && op.phase === 'writing' ? 'Cancelling…' : 'Cancel'}
                              </button>
                            )}
                          </div>

                          <div className="mt-1 text-[10px] text-bone/30">
                            Pause stops future activations and requests cancellation of any in-flight
                            run. Run now starts a new manual occurrence.
                          </div>

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
                              <div className="mt-1.5 pl-2 border-l border-white/10 space-y-1.5">
                                {activationErrors[job.id] && (
                                  <div role="alert" className="text-[11px] text-red-200">
                                    Activation history could not be read; it may be incomplete.
                                  </div>
                                )}
                                {!activationErrors[job.id] && jobActivations.length === 0 && (
                                  <div className="text-[11px] text-bone/40">
                                    No activations recorded yet.
                                  </div>
                                )}
                                {jobActivations.map((activation) => (
                                  <div
                                    key={activation.activation_id}
                                    className="text-[11px] text-bone/70 font-mono"
                                  >
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Pill variant={claimVariant(activation.claim_state)}>
                                        {activation.claim_state}
                                      </Pill>
                                      <span>occ {activation.schedule_occurrence}</span>
                                      <span className="text-bone/40">{activation.trigger_kind}</span>
                                    </div>
                                    <div className="text-bone/40">
                                      claimed {activation.claimed_at}
                                      {activation.dispatched_at
                                        ? ` · dispatched ${activation.dispatched_at}`
                                        : ''}
                                      {activation.settled_at
                                        ? ` · settled ${activation.settled_at}`
                                        : ''}
                                      {activation.run_id ? ` · run ${activation.run_id}` : ''}
                                    </div>
                                    {activation.terminal_reason && (
                                      <div className="text-bone/60">
                                        reason: {activation.terminal_reason}
                                      </div>
                                    )}
                                  </div>
                                ))}
                                <div className="text-[10px] font-mono uppercase tracking-wider text-bone/40 mt-1">
                                  Recent runs
                                </div>
                                {runErrors[job.id] && (
                                  <div role="alert" className="text-[11px] text-red-200">
                                    Run history could not be read; it may be incomplete.
                                  </div>
                                )}
                                {!runErrors[job.id] && jobRuns.length === 0 && (
                                  <div className="text-[11px] text-bone/40">No runs recorded yet.</div>
                                )}
                                {jobRuns.slice(0, 10).map((run) => (
                                  <div key={run.id} className="text-[11px] text-bone/70 font-mono">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Pill variant={cronRunVariant(run.status)}>{run.status}</Pill>
                                      <span>{run.started_at}</span>
                                      {run.activation_id ? (
                                        <span className="text-bone/40">act {run.activation_id}</span>
                                      ) : null}
                                    </div>
                                    {run.terminal_reason && (
                                      <div className="text-bone/60">reason: {run.terminal_reason}</div>
                                    )}
                                    {run.error && (
                                      <div className="text-red-200/80 truncate">{run.error}</div>
                                    )}
                                  </div>
                                ))}
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
