// ── ProjectStewardView — explicit Project Steward setup flow ──
//    (Roadmap Priority #4, Phase 4.1, Task 2)
//
// The user selects an existing, eligible persisted Session, authors a concrete
// task and at least one acceptance criterion, and this view creates a Goal
// through the native `goal_create` authority bound to the exact Session
// Agent/canonical root. The Goal is shown as created only after an exact
// `goal_get` readback matches the submitted objective, criteria, Agent, and
// workspace. "Open in Chat" carries a three-field selector-only handoff
// (session_id, goal_id, task_draft) to the existing chat surface; the user
// still presses Send there. This view never supplies workspace authority,
// never grants permissions, and never dispatches work.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cn,
  GlassCard,
  Pill,
  SectionHeader,
  StatusDot,
  LoadingState,
  type StatusVariant,
} from '../ui';
import type { AgentOption, ProjectStewardHandoff, WorkflowDestination, WorkflowNavigationSelector } from './types';
import WorkflowReadinessPanel, {
  type WorkflowReadinessItem,
} from './WorkflowReadinessPanel';

/**
 * App-level Project Steward review selector, retained across the Open in Chat
 * route change so the Goal/run review can be reconstructed on remount. It is
 * exactly the persisted Session ID and native Goal ID and carries no task text,
 * Agent, root, criteria, outcome, diff, or evidence; every displayed field is
 * re-read from native authority rather than restored from this selector.
 */
export interface ProjectStewardReviewSelection {
  session_id: string;
  goal_id: string;
}

interface AgentProjectionRow {
  slug: string;
  status: string;
  active: boolean;
  source_hash: string;
  active_source_hash: string;
}

interface Goal {
  id: string;
  objective: string;
  status: string;
  agent_id: string;
  project_root: string | null;
}

interface GoalCriterion {
  id: string;
  goal_id: string;
  ordinal: number;
  text: string;
  authority: string;
  created_at: string;
}

interface GoalDetail {
  goal: Goal;
  criteria: GoalCriterion[];
}

/**
 * A Goal that passed exact native readback, together with the exact Session
 * that was submitted and read back for it. The handoff binds this captured
 * Session (never the current selection), so a late response can never enable a
 * handoff for a Session other than the one the Goal was validated against.
 */
interface CreatedGoal {
  detail: GoalDetail;
  session: StewardSession;
  /** `created` from this view's `goal_create`+readback; `restored` from a
   *  remount reconciliation of the App-retained Session/Goal selector. */
  origin: 'created' | 'restored';
}

/**
 * Canonical persisted Session row as read back from the native `list_sessions`
 * authority. Unlike the chat projection it carries `archived` and the validated
 * `project_root`, which eligibility requires. Values are selectors only.
 */
interface StewardSession {
  id: string;
  agent_id: string;
  title: string;
  archived: boolean;
  project_root: string | null;
}

/**
 * Result of decoding a native collection. `ok: false` means the collection was
 * unreadable — not that it was empty — so callers surface it as unavailable
 * instead of collapsing a malformed read into an empty selection.
 */
type CollectionRead<T> = { ok: true; rows: T[] } | { ok: false };

/**
 * Remount reconciliation state for the App-retained `{session_id, goal_id}`
 * selector. `unavailable` means the native Goal/Session readback was missing,
 * malformed, or did not match, so the review must not be restored from cached
 * fields.
 */
type RestoreRead =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | { status: 'restored' };

const RESTORE_UNAVAILABLE =
  'The retained Project Steward selection could not be reconciled with native Goal and Session authority (the readback was missing, malformed, or did not match the exact Goal/Session identity, Agent, or canonical root). The review is unavailable and was not restored from cached fields.';

const RUN_HANDOFF_UNAVAILABLE =
  'The supplied Session run id did not resolve to a Goal-linked run for the exact Goal and Session. The Goal review was restored, but no run was selected — none is chosen for you.';

function decodeStewardSessions(value: unknown): CollectionRead<StewardSession> {
  if (!Array.isArray(value)) return { ok: false };
  const rows: StewardSession[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false };
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.agent_id !== 'string') return { ok: false };
    if (typeof record.title !== 'string') return { ok: false };
    // Strict decode: a row without a real boolean `archived` is unreadable
    // rather than coerced to `false`, so a malformed/archived Session can never
    // become eligible by default. Any malformed element makes the whole read
    // unavailable; a genuinely valid empty array stays empty.
    if (typeof record.archived !== 'boolean') return { ok: false };
    let projectRoot: string | null;
    if (record.project_root === null) projectRoot = null;
    else if (typeof record.project_root === 'string') projectRoot = record.project_root;
    else return { ok: false };
    rows.push({
      id: record.id,
      agent_id: record.agent_id,
      title: record.title,
      archived: record.archived,
      project_root: projectRoot,
    });
  }
  return { ok: true, rows };
}

const BUILTIN_JARVIS_AGENT_ID = 'jarvis';
const TERMINAL_GOAL_STATUSES = ['completed', 'failed', 'cancelled'];

/** Best-effort root normalization for display/filter only; native revalidates
 *  the canonical root on every authority read. */
function trimRoot(root: string | null | undefined): string | null {
  if (typeof root !== 'string') return null;
  let value = root.trim();
  if (value.length === 0) return null;
  while (value.length > 1 && (value.endsWith('/') || value.endsWith('\\'))) {
    value = value.slice(0, -1);
  }
  return value;
}

function decodeAgents(value: unknown): CollectionRead<AgentOption> {
  if (!Array.isArray(value)) return { ok: false };
  const rows: AgentOption[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false };
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.enabled !== 'boolean') return { ok: false };
    let name: string | undefined;
    if (record.name !== undefined) {
      if (typeof record.name !== 'string') return { ok: false };
      name = record.name;
    }
    rows.push({ id: record.id, name, enabled: record.enabled });
  }
  return { ok: true, rows };
}

function decodeProjections(value: unknown): CollectionRead<AgentProjectionRow> {
  if (!Array.isArray(value)) return { ok: false };
  const rows: AgentProjectionRow[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false };
    const record = item as Record<string, unknown>;
    // Every field `projectionUsable` inspects is required; a missing or
    // mistyped field makes the projection set unreadable rather than silently
    // defaulting to an unusable/eligible projection.
    if (typeof record.slug !== 'string') return { ok: false };
    if (typeof record.status !== 'string') return { ok: false };
    if (typeof record.active !== 'boolean') return { ok: false };
    if (typeof record.source_hash !== 'string') return { ok: false };
    if (typeof record.active_source_hash !== 'string') return { ok: false };
    rows.push({
      slug: record.slug,
      status: record.status,
      active: record.active,
      source_hash: record.source_hash,
      active_source_hash: record.active_source_hash,
    });
  }
  return { ok: true, rows };
}

function decodeGoalDetail(value: unknown): GoalDetail | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const goalRaw = record.goal;
  if (typeof goalRaw !== 'object' || goalRaw === null || Array.isArray(goalRaw)) return null;
  const goalRecord = goalRaw as Record<string, unknown>;
  if (typeof goalRecord.id !== 'string' || typeof goalRecord.objective !== 'string') return null;
  if (typeof goalRecord.agent_id !== 'string') return null;
  if (goalRecord.project_root !== null && typeof goalRecord.project_root !== 'string') {
    return null;
  }
  const criteriaRaw = record.criteria;
  if (!Array.isArray(criteriaRaw)) return null;
  const criteria: GoalCriterion[] = [];
  for (const item of criteriaRaw) {
    if (typeof item !== 'object' || item === null) return null;
    const criterion = item as Record<string, unknown>;
    if (typeof criterion.id !== 'string' || typeof criterion.text !== 'string') return null;
    criteria.push({
      id: criterion.id,
      goal_id: typeof criterion.goal_id === 'string' ? criterion.goal_id : goalRecord.id,
      ordinal: typeof criterion.ordinal === 'number' ? criterion.ordinal : criteria.length,
      text: criterion.text,
      authority: typeof criterion.authority === 'string' ? criterion.authority : '',
      created_at: typeof criterion.created_at === 'string' ? criterion.created_at : '',
    });
  }
  return {
    goal: {
      id: goalRecord.id,
      objective: goalRecord.objective,
      status: typeof goalRecord.status === 'string' ? goalRecord.status : 'pending',
      agent_id: goalRecord.agent_id,
      project_root: goalRecord.project_root ?? null,
    },
    criteria,
  };
}

/** A Projection is eligible only when it is the active, non-stale, valid
 *  projection for the Session's Agent. A custom Agent without one is blocked;
 *  the built-in Jarvis no-row exception is preserved. */
function projectionUsable(projection: AgentProjectionRow | undefined): boolean {
  if (!projection) return false;
  return (
    projection.status === 'valid' &&
    projection.active === true &&
    projection.source_hash.length > 0 &&
    projection.active_source_hash === projection.source_hash
  );
}

/**
 * A Session is eligible for a Project Steward task only when it is persisted,
 * non-archived, has a nonempty canonical project root, and its Agent is enabled
 * (custom Agents additionally need a valid/active/non-stale projection). This is
 * a selector filter only; native revalidates everything on `goal_create`.
 */
function sessionEligible(
  session: StewardSession,
  agentsById: Map<string, AgentOption>,
  projectionsBySlug: Map<string, AgentProjectionRow>,
): boolean {
  if (session.archived) return false;
  if (trimRoot(session.project_root) === null) return false;
  const agentId = typeof session.agent_id === 'string' ? session.agent_id : '';
  if (!agentId) return false;
  const agent = agentsById.get(agentId);
  if (!agent) return agentId === BUILTIN_JARVIS_AGENT_ID;
  if (!agent.enabled) return false;
  if (agentId === BUILTIN_JARVIS_AGENT_ID) return true;
  return projectionUsable(projectionsBySlug.get(agentId));
}

/**
 * Exact readback equality between the submitted task and a freshly read
 * `goal_get` result. Requires the exact Goal id, objective text, Agent, and
 * canonical root, a non-terminal Goal, and an exactly matching criterion set
 * (order by ordinal).
 */
function goalMatchesSubmission(
  detail: GoalDetail,
  goalId: string,
  objective: string,
  criteria: string[],
  session: StewardSession,
): boolean {
  if (detail.goal.id !== goalId) return false;
  if (detail.goal.objective !== objective) return false;
  if (detail.goal.agent_id !== session.agent_id) return false;
  if (trimRoot(detail.goal.project_root) !== trimRoot(session.project_root)) return false;
  if (TERMINAL_GOAL_STATUSES.includes(detail.goal.status)) return false;
  const texts = detail.criteria
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((criterion) => criterion.text);
  if (texts.length !== criteria.length) return false;
  for (let index = 0; index < criteria.length; index += 1) {
    if (texts[index] !== criteria[index]) return false;
  }
  return true;
}

// ── Task 3: durable run state and read-only workspace snapshot review ──
//
// Every value shown here is a selector/readback from a native authority. Runs
// come from `goal_run_progress`; the diff comes from the read-only
// `project_steward_workspace_snapshot` command. Nothing in this section marks a
// Goal accepted or completed, and no write, commit, shell, or model-triggered
// acceptance control is exposed.

/** Persisted terminal run outcomes; only these may be reviewed. */
const TERMINAL_RUN_OUTCOMES = ['success', 'partial', 'failed', 'timed_out', 'cancelled'];

/**
 * One native Goal-linked run row as returned by `goal_run_progress`. It carries
 * only identifiers and structured state — never transcript or memory text.
 */
interface GoalRunRow {
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

/** Typed native snapshot state; kept distinct through the whole render. */
type SnapshotState = 'complete' | 'partial' | 'stale' | 'unavailable';

/**
 * Strict projection of `ProjectStewardWorkspaceSnapshot`. `diff_sha256` is the
 * native SHA-256 of the exact returned `diff` bytes and is absent only when the
 * state carries no diff. `changed_paths_exhaustive` is true only when native
 * proved the changed-path list complete, so it must gate any "all changes"
 * claim.
 */
interface WorkspaceSnapshot {
  session_id: string;
  goal_id: string;
  run_id: string;
  agent_id: string;
  project_root: string;
  run_outcome: string;
  run_finished_at: string | null;
  git_head: string | null;
  git_branch: string | null;
  changed_paths: string[];
  changed_paths_exhaustive: boolean;
  diff: string;
  diff_sha256: string | null;
  captured_at: string;
  state: SnapshotState;
  reason: string | null;
  details: string[];
}

/**
 * Read state for the native run rows. `unavailable` means the authority was
 * unreadable — not that there were no runs — so the UI never collapses it into
 * an empty run list or enables review on it.
 */
type RunsRead =
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | { status: 'ok'; rows: GoalRunRow[] };

/** Read state for the read-only workspace snapshot. */
type SnapshotRead =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  | { status: 'ok'; value: WorkspaceSnapshot };

function isTerminalRunOutcome(outcome: string): boolean {
  return TERMINAL_RUN_OUTCOMES.includes(outcome);
}

/**
 * RFC3339 date-time with an explicit offset (`Z` or `±hh:mm`). Capture groups:
 * 1 year, 2 month, 3 day, 4 hour, 5 minute, 6 second, 7 `Z`, 8 offset sign,
 * 9 offset hour, 10 offset minute. The shape alone is not enough: component and
 * calendar ranges are validated separately so a syntactically shaped but
 * impossible date (for example February 30) is rejected rather than normalized.
 */
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** Days in a 1-indexed month, honoring leap-year rules for February. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leapYear ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * A terminal run is reviewable only when it carries a nonempty, valid RFC3339
 * `finished_at`. Beyond the shape match, every calendar and clock component is
 * range-checked and the day is validated against the real month length and
 * leap-year rules, so impossible dates such as February 30 are rejected instead
 * of being silently normalized by the platform date parser. Seconds are limited
 * to 00-59; a leap-second `:60` cannot be verified here and keeps review
 * disabled. The value is also compared string-exactly to the snapshot's
 * `run_finished_at`, so an absent or unparseable finish time keeps snapshot
 * review disabled rather than binding to an unverified run.
 */
function isValidRfc3339(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  if (match[8] !== undefined) {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/**
 * A SHA-256 digest is exactly 64 hexadecimal characters. Used before a snapshot
 * is accepted or its digest is labelled/displayed as SHA-256, so a malformed or
 * truncated hash can never be presented as a real content digest.
 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

function isSha256Hex(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/**
 * Consistency check for a decoded snapshot's status fields. A diff-bearing
 * state (`complete`/`partial`) must carry a diff hash, `complete` must prove
 * exhaustive path coverage, and the discarded states (`stale`/`unavailable`)
 * must carry no diff, paths, or hash. An inconsistent readback is treated as
 * unavailable rather than rendered as a real capture.
 */
function snapshotShapeConsistent(value: WorkspaceSnapshot): boolean {
  const carriesDiff = value.state === 'complete' || value.state === 'partial';
  if (carriesDiff) {
    if (value.state === 'complete' && !value.changed_paths_exhaustive) return false;
    // A diff-bearing capture must carry a real 64-hex SHA-256 of the exact diff
    // bytes. A missing, malformed, or truncated digest makes the snapshot
    // inconsistent, so it is discarded rather than accepted or labelled.
    if (!isSha256Hex(value.diff_sha256)) return false;
    return true;
  }
  return (
    value.diff.length === 0 &&
    value.changed_paths.length === 0 &&
    value.diff_sha256 === null
  );
}

/**
 * Strict decode of the native `goal_run_progress` collection. Any malformed
 * element makes the whole read unavailable rather than silently dropping a run.
 */
function decodeGoalRunProgress(value: unknown): CollectionRead<GoalRunRow> {
  if (!Array.isArray(value)) return { ok: false };
  const rows: GoalRunRow[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { ok: false };
    const record = item as Record<string, unknown>;
    if (typeof record.goal_id !== 'string' || typeof record.session_id !== 'string') return { ok: false };
    if (typeof record.run_id !== 'string' || typeof record.outcome !== 'string') return { ok: false };
    if (typeof record.goal_status !== 'string') return { ok: false };
    if (typeof record.interrupted !== 'boolean' || typeof record.resumable !== 'boolean') return { ok: false };
    if (typeof record.accepted_output_pending !== 'boolean') return { ok: false };
    if (!Array.isArray(record.evidence_refs) || !record.evidence_refs.every((ref) => typeof ref === 'string')) {
      return { ok: false };
    }
    let finishedAt: string | null;
    if (record.finished_at === null || typeof record.finished_at === 'string') {
      finishedAt = record.finished_at;
    } else {
      return { ok: false };
    }
    rows.push({
      goal_id: record.goal_id,
      session_id: record.session_id,
      run_id: record.run_id,
      outcome: record.outcome,
      goal_status: record.goal_status,
      interrupted: record.interrupted,
      resumable: record.resumable,
      evidence_refs: record.evidence_refs as string[],
      accepted_output_pending: record.accepted_output_pending,
      finished_at: finishedAt,
    });
  }
  return { ok: true, rows };
}

/**
 * Strict decode of the native workspace snapshot. Every identity and status
 * field is required with its exact type; an unknown `state` or a missing field
 * yields `null`, so a malformed readback is never rendered as a real capture.
 */
function decodeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const requiredStrings = [
    'session_id',
    'goal_id',
    'run_id',
    'agent_id',
    'project_root',
    'run_outcome',
    'captured_at',
    'diff',
  ] as const;
  for (const key of requiredStrings) {
    if (typeof record[key] !== 'string') return null;
  }
  const nullableStrings = ['run_finished_at', 'git_head', 'git_branch', 'diff_sha256', 'reason'] as const;
  for (const key of nullableStrings) {
    const field = record[key];
    if (field !== null && typeof field !== 'string') return null;
  }
  if (!Array.isArray(record.changed_paths) || !record.changed_paths.every((path) => typeof path === 'string')) {
    return null;
  }
  if (!Array.isArray(record.details) || !record.details.every((detail) => typeof detail === 'string')) {
    return null;
  }
  if (typeof record.changed_paths_exhaustive !== 'boolean') return null;
  if (
    record.state !== 'complete' &&
    record.state !== 'partial' &&
    record.state !== 'stale' &&
    record.state !== 'unavailable'
  ) {
    return null;
  }
  return {
    session_id: record.session_id as string,
    goal_id: record.goal_id as string,
    run_id: record.run_id as string,
    agent_id: record.agent_id as string,
    project_root: record.project_root as string,
    run_outcome: record.run_outcome as string,
    run_finished_at: (record.run_finished_at as string | null) ?? null,
    git_head: (record.git_head as string | null) ?? null,
    git_branch: (record.git_branch as string | null) ?? null,
    changed_paths: record.changed_paths as string[],
    changed_paths_exhaustive: record.changed_paths_exhaustive,
    diff: record.diff as string,
    diff_sha256: (record.diff_sha256 as string | null) ?? null,
    captured_at: record.captured_at as string,
    state: record.state as SnapshotState,
    reason: (record.reason as string | null) ?? null,
    details: record.details as string[],
  };
}

export default function ProjectStewardView({
  onOpenInChat,
  reviewSelection = null,
  navigationSelector = null,
  onNavigationSelectorConsumed,
  onNavigateWorkflow,
}: {
  onOpenInChat: (handoff: ProjectStewardHandoff) => void;
  /**
   * App-retained `{session_id, goal_id}` selector. On remount this view re-reads
   * native Goal and canonical Session authority and restores the Goal/run review
   * only when the exact identity, Agent, non-archived state, and canonical root
   * all match. Selector-only: no cached field is ever treated as authority.
   */
  reviewSelection?: ProjectStewardReviewSelection | null;
  /**
   * App-retained cross-workflow navigation selector. Destination-addressed and
   * selector-only: this view re-reads native Goal/Session (and, when supplied,
   * Session run) authority and selects only an exact match. It is reported
   * consumed only after that readback resolves or explicitly rejects it.
   */
  navigationSelector?: Extract<WorkflowNavigationSelector, { workflow: 'project-steward' }> | null;
  /** Reports the exact selector consumed, so App clears only that one. */
  onNavigationSelectorConsumed?: (selector: WorkflowNavigationSelector) => void;
  /** Requests navigation to another workflow, optionally with an exact selector. */
  onNavigateWorkflow?: (
    destination: WorkflowDestination,
    selector: WorkflowNavigationSelector | null,
  ) => void;
}) {
  const [sessions, setSessions] = useState<StewardSession[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [projections, setProjections] = useState<AgentProjectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState<string[]>(['']);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdGoal, setCreatedGoal] = useState<CreatedGoal | null>(null);
  const createPendingGuard = useRef(false);
  // Monotonic Goal-creation generation. Bumped on every selection/draft change
  // and at the start of each attempt so a late response for a superseded Session
  // or draft is discarded instead of repopulating `createdGoal`.
  const createSeqRef = useRef(0);

  // Remount reconciliation of the App-retained review selector. Kept separate
  // from the creation generation so a restore read can never be mistaken for a
  // fresh `goal_create` response.
  const [restoreRead, setRestoreRead] = useState<RestoreRead>({ status: 'idle' });
  const [restoreKey, setRestoreKey] = useState(0);
  const restoreSeqRef = useRef(0);
  // Optional Session run id from a cross-workflow navigation selector. It is
  // validated against fresh `goal_run_progress` before GoalRunReview selects it;
  // a stale/unresolvable id selects nothing and surfaces a handoff notice.
  const [initialRunId, setInitialRunId] = useState<string | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  // Monotonic cross-workflow navigation generation. A newer selector or a
  // consume clears it, so a delayed read can never select under a superseded
  // selector.
  const navigationSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      invoke<unknown>('list_sessions'),
      invoke<unknown>('list_agents'),
      invoke<unknown>('list_agent_projections'),
    ])
      .then(([sessionRows, agentRows, projectionRows]) => {
        if (cancelled) return;
        // Any malformed element makes the whole collection read unavailable; a
        // genuinely valid empty array stays empty. This routes through the same
        // load error as an invoke rejection so unreadable authority can never
        // render as "no eligible Session".
        const decodedSessions = decodeStewardSessions(sessionRows);
        const decodedAgents = decodeAgents(agentRows);
        const decodedProjections = decodeProjections(projectionRows);
        if (!decodedSessions.ok || !decodedAgents.ok || !decodedProjections.ok) {
          throw new Error('unreadable');
        }
        setSessions(decodedSessions.rows);
        setAgents(decodedAgents.rows);
        setProjections(decodedProjections.rows);
      })
      .catch(() => {
        if (cancelled) return;
        // A failed read is unavailable, never an authoritative empty selection.
        setSessions([]);
        setAgents([]);
        setProjections([]);
        setLoadError(
          'Could not read the native Session/Agent authority (the response was unreadable or malformed). Eligible Sessions are unavailable; this is not an empty list. Retry when the authority is readable.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const agentsById = useMemo(() => {
    const map = new Map<string, AgentOption>();
    for (const agent of agents) map.set(agent.id, agent);
    return map;
  }, [agents]);

  const projectionsBySlug = useMemo(() => {
    const map = new Map<string, AgentProjectionRow>();
    for (const projection of projections) map.set(projection.slug, projection);
    return map;
  }, [projections]);

  const eligibleSessions = useMemo(
    () => sessions.filter((session) => sessionEligible(session, agentsById, projectionsBySlug)),
    [sessions, agentsById, projectionsBySlug],
  );

  const selectedSession = useMemo(
    () => eligibleSessions.find((session) => session.id === selectedSessionId) ?? null,
    [eligibleSessions, selectedSessionId],
  );

  // A new selection or a new draft invalidates any previously created Goal so a
  // handoff can never reference a Goal that does not match the current inputs.
  // Bumping the generation here also discards any in-flight creation response
  // that belongs to the superseded Session or draft.
  useEffect(() => {
    createSeqRef.current += 1;
    setCreatedGoal(null);
    setCreateError(null);
    // A manual selection or draft change also dismisses any cross-workflow
    // handoff notice; the notice belongs to the selector, not the new inputs.
    setHandoffNotice(null);
  }, [selectedSessionId, objective, criteria]);

  // Fresh native reconciliation shared by the Open-in-Chat review selector and
  // the cross-workflow navigation selector. `goal_get` supplies the
  // Goal/criteria/Agent/root and canonical `list_sessions` supplies the Session
  // row. Any missing, malformed, or mismatched readback (exact IDs, non-archived
  // Session, matching Agent, matching non-null canonical root) is explicitly
  // unavailable and restores no stale review context.
  const reconcileProjectStewardReview = useCallback(
    async (
      sessionId: string,
      goalId: string,
    ): Promise<{ createdGoal: CreatedGoal } | { error: string }> => {
      try {
        const [goalRaw, sessionRows] = await Promise.all([
          invoke<unknown>('goal_get', { id: goalId }),
          invoke<unknown>('list_sessions'),
        ]);
        const detail = decodeGoalDetail(goalRaw);
        const decodedSessions = decodeStewardSessions(sessionRows);
        if (!detail || !decodedSessions.ok) {
          return { error: RESTORE_UNAVAILABLE };
        }
        const session = decodedSessions.rows.find((row) => row.id === sessionId) ?? null;
        const goalRoot = trimRoot(detail.goal.project_root);
        const sessionRoot = trimRoot(session?.project_root ?? null);
        if (
          !session ||
          session.archived ||
          detail.goal.id !== goalId ||
          detail.goal.agent_id !== session.agent_id ||
          goalRoot === null ||
          goalRoot !== sessionRoot
        ) {
          return { error: RESTORE_UNAVAILABLE };
        }
        return { createdGoal: { detail, session, origin: 'restored' } };
      } catch {
        return { error: RESTORE_UNAVAILABLE };
      }
    },
    [],
  );

  // On remount, reconcile the App-retained `{session_id, goal_id}` review
  // selector with fresh native authority before restoring the Goal/run review.
  // A cross-workflow navigation selector takes precedence and is handled below.
  const reviewSessionId = reviewSelection?.session_id ?? null;
  const reviewGoalId = reviewSelection?.goal_id ?? null;

  useEffect(() => {
    if (navigationSelector) return;
    if (reviewSessionId === null || reviewGoalId === null) {
      setRestoreRead({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const seq = ++restoreSeqRef.current;
    // Drop any prior review context before the read so a failed reconciliation
    // can never leave a stale Goal/run review on screen.
    setCreatedGoal(null);
    setInitialRunId(null);
    setHandoffNotice(null);
    setRestoreRead({ status: 'loading' });
    void reconcileProjectStewardReview(reviewSessionId, reviewGoalId).then((result) => {
      if (cancelled || seq !== restoreSeqRef.current) return;
      if ('error' in result) {
        setRestoreRead({ status: 'unavailable', message: result.error });
        return;
      }
      setCreatedGoal(result.createdGoal);
      setRestoreRead({ status: 'restored' });
    });
    return () => {
      cancelled = true;
    };
  }, [navigationSelector, reviewSessionId, reviewGoalId, restoreKey, reconcileProjectStewardReview]);

  // Consume an App-retained cross-workflow navigation selector exactly once.
  // Destination-addressed and selector-only: `goal_get` + canonical
  // `list_sessions` (and, when a Session run id is supplied, `goal_run_progress`)
  // are re-read and the exact Goal/Session/Agent/root/run identity is validated
  // BEFORE any selection. A missing, malformed, stale, or conflicting selector is
  // shown as unavailable with no fallback and no run selected, and the selector
  // is reported consumed only after the read settles.
  useEffect(() => {
    if (!navigationSelector) return;
    const selector = navigationSelector;
    let cancelled = false;
    const seq = ++navigationSeqRef.current;
    setCreatedGoal(null);
    setInitialRunId(null);
    setHandoffNotice(null);
    setRestoreRead({ status: 'loading' });
    void (async () => {
      const result = await reconcileProjectStewardReview(selector.session_id, selector.goal_id);
      if (cancelled || seq !== navigationSeqRef.current) return;
      if ('error' in result) {
        // Surface the rejection as a persistent notice (independent of the
        // selector, which is cleared below) and leave manual selection available.
        setHandoffNotice(result.error);
        setRestoreRead({ status: 'idle' });
        onNavigationSelectorConsumed?.(selector);
        return;
      }
      // Validate the optional Session run id against fresh native run rows. A
      // supplied run resolves only when it is an exact run_id + goal_id +
      // session_id match that is also a terminal run with a valid RFC3339
      // finished_at — the same predicate GoalRunReview uses to preselect. Any
      // other value is rejected with the existing visible notice while the exact
      // Goal still opens; it is never silently consumed as if selected, and it is
      // never replaced by the latest/first run.
      let selectedRunId: string | null = null;
      let runRejected = false;
      if (selector.session_run_id !== undefined) {
        try {
          const decoded = decodeGoalRunProgress(
            await invoke<unknown>('goal_run_progress', { goalId: selector.goal_id }),
          );
          if (cancelled || seq !== navigationSeqRef.current) return;
          const run = decoded.ok
            ? decoded.rows.find(
                (row) =>
                  row.run_id === selector.session_run_id &&
                  row.goal_id === selector.goal_id &&
                  row.session_id === selector.session_id &&
                  isTerminalRunOutcome(row.outcome) &&
                  isValidRfc3339(row.finished_at),
              ) ?? null
            : null;
          if (run) selectedRunId = run.run_id;
          else runRejected = true;
        } catch {
          if (cancelled || seq !== navigationSeqRef.current) return;
          runRejected = true;
        }
      }
      setCreatedGoal(result.createdGoal);
      setInitialRunId(selectedRunId);
      setHandoffNotice(runRejected ? RUN_HANDOFF_UNAVAILABLE : null);
      setRestoreRead({ status: 'restored' });
      onNavigationSelectorConsumed?.(selector);
    })();
    return () => {
      cancelled = true;
    };
  }, [navigationSelector, reconcileProjectStewardReview, onNavigationSelectorConsumed]);

  const addCriterion = useCallback(() => setCriteria((prev) => [...prev, '']), []);
  const removeCriterion = useCallback(
    (index: number) => setCriteria((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index))),
    [],
  );
  const setCriterion = useCallback(
    (index: number, value: string) =>
      setCriteria((prev) => prev.map((criterion, i) => (i === index ? value : criterion))),
    [],
  );

  const createGoal = useCallback(async () => {
    if (createPendingGuard.current) return;
    const session = selectedSession;
    const trimmedObjective = objective.trim();
    const trimmedCriteria = criteria.map((criterion) => criterion.trim()).filter((c) => c.length > 0);
    if (!session) {
      setCreateError('Select an eligible Session first.');
      return;
    }
    if (!trimmedObjective || trimmedCriteria.length === 0) {
      setCreateError('A concrete task and at least one acceptance criterion are required.');
      return;
    }
    const seq = ++createSeqRef.current;
    createPendingGuard.current = true;
    setCreating(true);
    setCreateError(null);
    setCreatedGoal(null);
    try {
      const created = decodeGoalDetail(
        await invoke<unknown>('goal_create', {
          objective: trimmedObjective,
          criteria: trimmedCriteria,
          agentId: session.agent_id,
          projectRoot: session.project_root,
        }),
      );
      if (seq !== createSeqRef.current) return;
      if (!created) throw new Error('unreadable goal_create response');
      const reread = decodeGoalDetail(await invoke<unknown>('goal_get', { id: created.goal.id }));
      if (seq !== createSeqRef.current) return;
      if (!reread) throw new Error('goal_get readback unavailable');
      if (!goalMatchesSubmission(reread, created.goal.id, trimmedObjective, trimmedCriteria, session)) {
        throw new Error('goal_get readback did not match the submitted Goal');
      }
      // Bind the Goal to the exact Session that was submitted and read back.
      setCreatedGoal({ detail: reread, session, origin: 'created' });
    } catch {
      if (seq !== createSeqRef.current) return;
      setCreateError(
        'Could not create the Goal with an exact native readback. Your task and criteria are preserved; nothing was handed off.',
      );
    } finally {
      createPendingGuard.current = false;
      setCreating(false);
    }
  }, [criteria, objective, selectedSession]);

  const openInChat = useCallback(() => {
    if (!createdGoal) return;
    // Bind the exact Session and Goal that passed native readback, not the
    // current selection, so the handoff can never target a different Session.
    onOpenInChat({
      session_id: createdGoal.session.id,
      goal_id: createdGoal.detail.goal.id,
      task_draft: createdGoal.detail.goal.objective,
    });
  }, [createdGoal, onOpenInChat]);

  // ── Task 2: presentation-only readiness/recovery items ──────────────────────
  //
  // Every item mirrors state this view already decoded from native authority.
  // The panel performs no read, and no item equates a run, tool result, or
  // snapshot with accepted delivery.
  const stewardReadinessItems: WorkflowReadinessItem[] = [];
  if (loadError) {
    stewardReadinessItems.push({
      id: 'authority',
      label: 'Session / Agent authority',
      state: 'unavailable',
      detail:
        'The native Session/Agent/projection authority was unreadable or malformed. Eligible Sessions are unavailable — this is not an empty list.',
      nextStep:
        'Retry the read. If it stays unavailable, bind a workspace from the existing Chat Session workspace control.',
      recoveryLabel: 'Retry read',
      onRecover: () => setReloadKey((key) => key + 1),
    });
  } else if (eligibleSessions.length === 0) {
    stewardReadinessItems.push({
      id: 'authority',
      label: 'Eligible persisted Session',
      state: 'needs_user_input',
      detail:
        'A readable authority shows no persisted Session with an enabled Agent and a validated project workspace, so no eligible Session exists. This is a real empty selection, not an unavailable read.',
      nextStep:
        'Open Chat, choose the Agent, and bind a workspace with the existing Session workspace control (native memory_bind_session_workspace), then return here.',
    });
  } else if (!selectedSession) {
    stewardReadinessItems.push({
      id: 'authority',
      label: 'Eligible persisted Session',
      state: 'needs_user_input',
      detail: `${eligibleSessions.length} eligible persisted Session(s) are available; none is selected.`,
      nextStep: 'Select one eligible Session above.',
    });
  } else if (!objective.trim() || criteria.every((criterion) => criterion.trim().length === 0)) {
    stewardReadinessItems.push({
      id: 'authority',
      label: 'Task definition',
      state: 'needs_user_input',
      detail:
        'A Session is selected, but no concrete task and at least one acceptance criterion have been authored yet.',
      nextStep: 'Author the task and at least one acceptance criterion, then create the Goal.',
    });
  } else {
    stewardReadinessItems.push({
      id: 'authority',
      label: 'Task definition',
      state: 'ready_for_explicit_action',
      detail:
        'A Session is selected with a concrete task and acceptance criteria. Creating the Goal remains an explicit action; this panel dispatches nothing.',
      nextStep: 'Create the Goal; it is shown only after an exact native goal_get readback.',
    });
  }

  if (restoreRead.status === 'loading') {
    stewardReadinessItems.push({
      id: 'restore',
      label: 'Retained Session/Goal selection',
      state: 'waiting',
      detail:
        'Reconciling the retained selector against fresh native Goal and Session authority before restoring any review.',
    });
  } else if (restoreRead.status === 'unavailable') {
    stewardReadinessItems.push({
      id: 'restore',
      label: 'Retained Session/Goal selection',
      state: 'stale',
      detail: restoreRead.message,
      nextStep: 'Select a Session manually instead; no review is restored from cached fields.',
      recoveryLabel: 'Retry reconciliation',
      onRecover: () => setRestoreKey((key) => key + 1),
    });
  }

  if (handoffNotice) {
    stewardReadinessItems.push({
      id: 'handoff',
      label: 'Cross-workflow run selector',
      state: 'stale',
      detail: handoffNotice,
    });
  }

  if (createdGoal) {
    stewardReadinessItems.push({
      id: 'acceptance',
      label: 'Trusted Goal acceptance',
      state: 'waiting',
      detail:
        'Task delivery and acceptance are not observed in this view. The Goal exists, but existence, a run, a tool success, or a workspace snapshot never marks it delivered or accepted.',
      destination: 'recurring-operator',
      nextStep:
        'Open Recurring Operator (Goals) and use the existing trusted acceptance path if a bound pending-acceptance execution exists.',
    });
  }

  const stewardReadinessBoundary =
    'A successful run, tool result, Agent run, or snapshot is not accepted output: it never marks the Goal delivered or accepted. Research/source checks and Jarvis source checks are not task-level acceptance. Goal completion remains available only through the existing trusted native acceptance receipt and exact readback path.';

  const inputCls =
    'px-3 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-bone placeholder:text-bone/30 focus:outline-none focus:border-accent/50 disabled:opacity-50';

  const restoreActive = navigationSelector !== null || reviewSelection !== null;

  if (loading) return <LoadingState />;

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto">
      <SectionHeader
        title="Project Steward"
        subtitle="Start a project-scoped Goal from a persisted Session, then hand its task to Chat"
        count={eligibleSessions.length}
      />

      {onNavigateWorkflow && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-bone-faint">
          <span className="uppercase tracking-[0.18em]">Open</span>
          <button
            type="button"
            onClick={() =>
              onNavigateWorkflow(
                'recurring-operator',
                createdGoal
                  ? { workflow: 'recurring-operator', goal_id: createdGoal.detail.goal.id }
                  : null,
              )
            }
            className="btn-ghost text-xs"
          >
            Recurring Operator
          </button>
          <button
            type="button"
            onClick={() => onNavigateWorkflow('researcher', null)}
            className="btn-ghost text-xs"
          >
            Attributable Researcher
          </button>
        </div>
      )}

      <WorkflowReadinessPanel
        workflow="project-steward"
        heading="Derived from the Session/Agent authority and the Goal/run/snapshot readbacks shown below."
        items={stewardReadinessItems}
        boundaryNote={stewardReadinessBoundary}
        onNavigateWorkflow={
          onNavigateWorkflow ? (destination) => onNavigateWorkflow(destination, null) : undefined
        }
      />

      {loadError && (
        <div role="alert" className="text-sm text-bone-dim">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="btn-ghost text-xs mt-2"
          >
            Retry read
          </button>
        </div>
      )}

      {restoreActive && !loadError && !createdGoal && restoreRead.status === 'loading' && (
        <p role="status" className="text-xs text-bone-dim">
          Reconciling the retained Project Steward selection with native Goal and Session authority…
        </p>
      )}

      {restoreActive && !loadError && !createdGoal && restoreRead.status === 'unavailable' && (
        <div role="alert" className="text-sm text-bone-dim">
          <p>{restoreRead.message}</p>
          <button
            type="button"
            onClick={() => setRestoreKey((key) => key + 1)}
            className="btn-ghost text-xs mt-2"
          >
            Retry reconciliation
          </button>
        </div>
      )}

      {handoffNotice && !loadError && (
        <p role="status" className="text-xs text-bone-dim">
          {handoffNotice}
        </p>
      )}

      {!loadError && eligibleSessions.length === 0 && (
        <GlassCard className="p-4">
          <p className="text-sm text-bone-muted mb-2">No eligible bound Session yet.</p>
          <p className="text-xs text-bone-dim">
            A Project Steward task needs an existing, non-archived Session with an enabled Agent and
            a validated project workspace. Open Chat, choose the Agent, bind a workspace with the
            existing Session workspace control (native <span className="font-mono">memory_bind_session_workspace</span>),
            then return here. A raw path entered on this screen is never workspace authority.
          </p>
        </GlassCard>
      )}

      {!loadError && eligibleSessions.length > 0 && (
        <GlassCard className="p-3">
          <div className="text-xs font-mono uppercase tracking-[0.18em] text-bone/40 mb-2">Session</div>
          <div className="flex flex-col gap-2">
            {eligibleSessions.map((session) => {
              const selected = session.id === selectedSessionId;
              return (
                <button
                  key={session.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={creating}
                  onClick={() => {
                    if (creating) return;
                    // A manual selection invalidates any in-flight handoff read so
                    // a delayed selector response cannot override the user.
                    navigationSeqRef.current += 1;
                    setSelectedSessionId(session.id);
                  }}
                  className={cn(
                    'text-left px-3 py-2 rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                    selected
                      ? 'bg-royal/15 border-royal/40'
                      : 'bg-obsidian/30 border-iron/20 hover:border-iron/40',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot ok={selected} size="sm" />
                    <span className="text-sm text-bone truncate">{session.title || session.id}</span>
                    <Pill variant="info">{session.agent_id}</Pill>
                  </div>
                  <div className="text-[11px] font-mono text-bone-faint truncate mt-0.5">{session.id}</div>
                  <div className="text-[11px] font-mono text-bone-dim truncate mt-0.5">
                    root: {trimRoot(session.project_root) ?? 'unbound'}
                  </div>
                </button>
              );
            })}
          </div>
        </GlassCard>
      )}

      {!loadError && (
        <GlassCard className="p-3">
          <div className="text-xs font-mono uppercase tracking-[0.18em] text-bone/40 mb-2">Task</div>
          <textarea
            className={cn(inputCls, 'w-full resize-none')}
            rows={3}
            placeholder="What is the concrete task for this project?"
            aria-label="Project Steward task"
            disabled={creating || !selectedSession}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
          <div className="text-xs font-mono uppercase tracking-[0.18em] text-bone/40 mt-3 mb-2">
            Acceptance criteria
          </div>
          <div className="flex flex-col gap-1.5">
            {criteria.map((criterion, index) => (
              <div key={index} className="flex gap-2">
                <input
                  className={cn(inputCls, 'flex-1')}
                  placeholder={`Criterion ${index + 1}`}
                  aria-label={`Acceptance criterion ${index + 1}`}
                  disabled={creating || !selectedSession}
                  value={criterion}
                  onChange={(e) => setCriterion(index, e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => removeCriterion(index)}
                  disabled={criteria.length <= 1 || creating}
                  className="btn-ghost text-xs disabled:opacity-40"
                  aria-label={`Remove criterion ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 mt-3">
            <button type="button" onClick={addCriterion} disabled={creating} className="btn-ghost text-xs">
              Add criterion
            </button>
            <button
              type="button"
              onClick={() => { void createGoal(); }}
              disabled={creating || !selectedSession || !objective.trim()}
              className="btn-ghost text-xs disabled:opacity-40"
            >
              {creating ? 'Creating…' : 'Create Goal'}
            </button>
          </div>
          {createError && (
            <p role="alert" className="text-xs text-error mt-2">
              {createError}
            </p>
          )}
        </GlassCard>
      )}

      {createdGoal && (
        <GlassCard className="p-3">
          <div className="flex items-center gap-2 mb-2">
            <Pill variant="success">
              {createdGoal.origin === 'restored' ? 'Goal restored' : 'Goal created'}
            </Pill>
            <span className="text-[11px] font-mono text-bone-faint truncate">{createdGoal.detail.goal.id}</span>
            <Pill variant="info">{createdGoal.detail.goal.status}</Pill>
          </div>
          {createdGoal.origin === 'restored' && (
            <p className="text-[11px] text-bone-faint mb-2">
              Reconciled from fresh native <span className="font-mono">goal_get</span> and canonical{' '}
              <span className="font-mono">list_sessions</span> readback on return from Chat; no cached
              selector field is shown as authority.
            </p>
          )}
          <div className="text-sm text-bone mb-1">{createdGoal.detail.goal.objective}</div>
          <div className="text-[11px] font-mono text-bone-dim mb-1">Agent: {createdGoal.detail.goal.agent_id}</div>
          <div className="text-[11px] font-mono text-bone-dim mb-1">
            Session: {createdGoal.session.id}
          </div>
          <div className="text-[11px] font-mono text-bone-dim mb-2">
            Root: {trimRoot(createdGoal.detail.goal.project_root) ?? 'unbound'}
          </div>
          <ul className="list-disc list-inside text-xs text-bone-muted mb-3">
            {createdGoal.detail.criteria
              .slice()
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((criterion) => (
                <li key={criterion.id}>{criterion.text}</li>
              ))}
          </ul>
          <button type="button" onClick={openInChat} className="btn-ghost text-xs">
            Open in Chat
          </button>
          <p className="text-[11px] text-bone-faint mt-2">
            Opens the existing Chat with this Session and Goal selected and the task pre-filled. It
            does not send anything; you press Send there.
          </p>
        </GlassCard>
      )}

      {createdGoal && (
        <GoalRunReview
          key={createdGoal.detail.goal.id}
          createdGoal={createdGoal}
          initialRunId={initialRunId}
        />
      )}
    </div>
  );
}

/**
 * Durable run state plus the exact, read-only workspace snapshot for one exact
 * Session/Goal/run tuple. Runs are read from native `goal_run_progress`; the
 * diff is read from native `project_steward_workspace_snapshot`. The component
 * is keyed by Goal id by its parent, so a different Goal remounts it and drops
 * every captured run/snapshot state instead of reusing a stale binding. Run
 * selection is always explicit — a latest or first row is never chosen for the
 * user. No control here writes, commits, merges, publishes, deploys, runs a
 * shell, or triggers acceptance.
 */
function GoalRunReview({
  createdGoal,
  initialRunId = null,
}: {
  createdGoal: CreatedGoal;
  /**
   * Optional exact Session run id supplied by a cross-workflow navigation
   * selector. It is selected only after the fresh run rows resolve and only when
   * it is a selectable terminal run bound to this Session; otherwise no run is
   * selected (a latest/first run is never substituted).
   */
  initialRunId?: string | null;
}) {
  const goal = createdGoal.detail.goal;
  const goalId = goal.id;
  const boundSessionId = createdGoal.session.id;
  const boundAgentId = goal.agent_id;
  const boundRoot = trimRoot(goal.project_root);

  const [runsRead, setRunsRead] = useState<RunsRead>({ status: 'loading' });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotRead>({ status: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  const selectedRunIdRef = useRef<string | null>(null);
  const refreshPendingRef = useRef(false);
  const runsSeqRef = useRef(0);
  const snapshotSeqRef = useRef(0);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  const readRuns = useCallback(async (): Promise<RunsRead> => {
    try {
      const decoded = decodeGoalRunProgress(await invoke<unknown>('goal_run_progress', { goalId }));
      if (!decoded.ok) {
        return {
          status: 'unavailable',
          message:
            'The native Goal-run authority returned an unreadable response. Goal-linked runs are unavailable; this is not an empty run list.',
        };
      }
      // Integrity: every returned row must claim this exact Goal. A mismatch is
      // unreadable authority, never a row to display or select.
      for (const row of decoded.rows) {
        if (row.goal_id !== goalId) {
          return {
            status: 'unavailable',
            message:
              'A native Goal-run row did not match the selected Goal. Run state is unavailable; nothing is shown.',
          };
        }
      }
      return { status: 'ok', rows: decoded.rows };
    } catch {
      return {
        status: 'unavailable',
        message:
          'Could not read Goal-linked runs from the native authority. Run state is unavailable; retry is read-only.',
      };
    }
  }, [goalId]);

  useEffect(() => {
    let cancelled = false;
    setRunsRead({ status: 'loading' });
    setSelectedRunId(null);
    setSnapshot({ status: 'idle' });
    void readRuns().then((result) => {
      if (cancelled) return;
      setRunsRead(result);
      // Preselect the exact supplied Session run only when it is a selectable
      // terminal run bound to this Session. An unavailable read or a missing /
      // non-terminal / different-Session run selects nothing.
      if (initialRunId !== null && result.status === 'ok') {
        const match = result.rows.find(
          (row) =>
            row.run_id === initialRunId &&
            isTerminalRunOutcome(row.outcome) &&
            row.session_id === boundSessionId &&
            isValidRfc3339(row.finished_at),
        );
        if (match) setSelectedRunId(match.run_id);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [readRuns, initialRunId, boundSessionId]);

  const selectRun = useCallback((runId: string | null) => {
    // A selection change discards any in-flight or displayed snapshot so a
    // result can never be attributed to a different run.
    snapshotSeqRef.current += 1;
    setSelectedRunId(runId);
    setSnapshot({ status: 'idle' });
  }, []);

  // Read-only reconciliation: re-read the run rows and, when the same explicit
  // selection is still present and terminal, re-request the snapshot. It never
  // starts a run, sends a message, or asserts a successful outcome.
  const refreshReview = useCallback(async () => {
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    const seq = ++runsSeqRef.current;
    setRefreshing(true);
    const result = await readRuns();
    if (seq !== runsSeqRef.current) {
      refreshPendingRef.current = false;
      setRefreshing(false);
      return;
    }
    setRunsRead(result);
    const current = selectedRunIdRef.current;
    const stillValid =
      result.status === 'ok' &&
      current !== null &&
      result.rows.some(
        (row) =>
          row.run_id === current &&
          isTerminalRunOutcome(row.outcome) &&
          row.session_id === boundSessionId &&
          isValidRfc3339(row.finished_at),
      );
    if (!stillValid) {
      setSelectedRunId(null);
      setSnapshot({ status: 'idle' });
    }
    refreshPendingRef.current = false;
    setRefreshing(false);
  }, [readRuns, boundSessionId]);

  // Clear a selection that no longer refers to a readable terminal run bound to
  // this Session with a valid RFC3339 finish time, so the review never rests on
  // an unverified or non-terminal run.
  useEffect(() => {
    if (selectedRunId === null || runsRead.status !== 'ok') return;
    const stillValid = runsRead.rows.some(
      (row) =>
        row.run_id === selectedRunId &&
        isTerminalRunOutcome(row.outcome) &&
        row.session_id === boundSessionId &&
        isValidRfc3339(row.finished_at),
    );
    if (!stillValid) setSelectedRunId(null);
  }, [runsRead, selectedRunId, boundSessionId]);

  // Request the snapshot for the exact selected Session/Goal/run tuple. A new
  // selection, Goal, or run supersedes any in-flight request, and every identity
  // and status field is strictly decoded and matched before the result is kept.
  useEffect(() => {
    if (selectedRunId === null) {
      setSnapshot({ status: 'idle' });
      return;
    }
    const run =
      runsRead.status === 'ok'
        ? runsRead.rows.find((row) => row.run_id === selectedRunId) ?? null
        : null;
    if (
      !run ||
      !isTerminalRunOutcome(run.outcome) ||
      run.session_id !== boundSessionId ||
      !isValidRfc3339(run.finished_at)
    ) {
      setSnapshot({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const seq = ++snapshotSeqRef.current;
    setSnapshot({ status: 'loading' });
    void invoke<unknown>('project_steward_workspace_snapshot', {
      sessionId: boundSessionId,
      goalId,
      runId: run.run_id,
    })
      .then((raw) => {
        if (cancelled || seq !== snapshotSeqRef.current) return;
        const value = decodeWorkspaceSnapshot(raw);
        if (!value) {
          setSnapshot({
            status: 'unavailable',
            message:
              'The native workspace snapshot response was unreadable or malformed; it was discarded rather than shown as a capture.',
          });
          return;
        }
        // `run_finished_at` must equal the selected persisted row's `finished_at`
        // string exactly, so a snapshot whose finish time differs in any way is
        // discarded rather than attributed to this run.
        const identityBound =
          value.session_id === boundSessionId &&
          value.goal_id === goalId &&
          value.run_id === run.run_id &&
          value.agent_id === boundAgentId &&
          trimRoot(value.project_root) === boundRoot &&
          value.run_outcome === run.outcome &&
          value.run_finished_at === run.finished_at;
        if (!identityBound || !snapshotShapeConsistent(value)) {
          setSnapshot({
            status: 'unavailable',
            message:
              'The native workspace snapshot did not match the selected Session/Goal/run identity or was internally inconsistent; it was discarded rather than attributed to this run.',
          });
          return;
        }
        setSnapshot({ status: 'ok', value });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== snapshotSeqRef.current) return;
        setSnapshot({
          status: 'unavailable',
          message:
            typeof error === 'string' && error.trim().length > 0
              ? error
              : 'The read-only workspace snapshot could not be captured for this run.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, runsRead, boundSessionId, goalId, boundAgentId, boundRoot]);

  const selectedRun =
    runsRead.status === 'ok' && selectedRunId !== null
      ? runsRead.rows.find((row) => row.run_id === selectedRunId) ?? null
      : null;

  // ── Task 2: presentation-only run/snapshot readiness items ──────────────────
  const reviewReadinessItems: WorkflowReadinessItem[] = [];
  if (runsRead.status === 'loading') {
    reviewReadinessItems.push({
      id: 'runs',
      label: 'Goal-linked runs',
      state: 'waiting',
      detail: 'Reading native Goal-linked run rows.',
    });
  } else if (runsRead.status === 'unavailable') {
    reviewReadinessItems.push({
      id: 'runs',
      label: 'Goal-linked runs',
      state: 'unavailable',
      detail: runsRead.message,
      recoveryLabel: 'Refresh',
      onRecover: () => {
        void refreshReview();
      },
    });
  } else if (runsRead.rows.length === 0) {
    reviewReadinessItems.push({
      id: 'runs',
      label: 'Goal-linked runs',
      state: 'waiting',
      detail:
        'No terminal Goal-linked run is recorded for this Goal yet. This is a real empty run history, not an unavailable read.',
      nextStep: 'Send the task from Chat; runs appear here after they finish.',
    });
  } else if (selectedRunId === null) {
    reviewReadinessItems.push({
      id: 'runs',
      label: 'Run review',
      state: 'needs_user_input',
      detail: `${runsRead.rows.length} terminal run(s) are recorded; none is selected (a latest/first run is never chosen for you).`,
      nextStep: 'Select one terminal run to review its read-only snapshot.',
    });
  } else {
    reviewReadinessItems.push({
      id: 'runs',
      label: 'Run review',
      state: 'ready_for_explicit_action',
      detail:
        'A terminal run with a valid finish time is selected for read-only review.',
      nextStep: 'Refresh re-reads the run rows; it never starts or accepts a run.',
    });
  }

  if (selectedRunId !== null) {
    if (snapshot.status === 'loading') {
      reviewReadinessItems.push({
        id: 'snapshot',
        label: 'Workspace snapshot',
        state: 'waiting',
        detail: 'Capturing a read-only workspace snapshot for the selected run.',
      });
    } else if (snapshot.status === 'unavailable') {
      reviewReadinessItems.push({
        id: 'snapshot',
        label: 'Workspace snapshot',
        state: 'unavailable',
        detail: snapshot.message,
      });
    } else if (snapshot.status === 'ok') {
      const snapshotStateMap: Record<SnapshotState, WorkflowReadinessItem['state']> = {
        complete: 'ready_for_explicit_action',
        partial: 'partial',
        stale: 'stale',
        unavailable: 'unavailable',
      };
      reviewReadinessItems.push({
        id: 'snapshot',
        label: 'Workspace snapshot',
        state: snapshotStateMap[snapshot.value.state],
        detail: `Native snapshot state is '${snapshot.value.state}'. It is a read-only observation that may include pre-existing edits; it is not proof the selected run created every change, and it is not acceptance.`,
      });
    } else {
      reviewReadinessItems.push({
        id: 'snapshot',
        label: 'Workspace snapshot',
        state: 'needs_user_input',
        detail: 'Snapshot review is idle until a terminal run is selected.',
      });
    }
  }

  return (
    <GlassCard className="p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-mono uppercase tracking-[0.18em] text-bone/40">Run review</div>
        <button
          type="button"
          onClick={() => { void refreshReview(); }}
          disabled={refreshing || runsRead.status === 'loading'}
          className="btn-ghost text-xs disabled:opacity-40"
        >
          {refreshing ? 'Reconciling…' : 'Refresh'}
        </button>
      </div>

      <div className="mb-2">
        <WorkflowReadinessPanel
          workflow="project-steward"
          heading="Derived from the run rows and the read-only workspace snapshot below."
          items={reviewReadinessItems}
          boundaryNote="A terminal run, tool success, or snapshot never marks the Goal delivered or accepted; trusted acceptance is a separate native path."
        />
      </div>

      {runsRead.status === 'loading' && (
        <p className="text-xs text-bone-dim">Reading native Goal-linked runs…</p>
      )}

      {runsRead.status === 'unavailable' && (
        <p role="alert" className="text-xs text-error">
          {runsRead.message} Use Refresh to re-read; retry is read-only.
        </p>
      )}

      {runsRead.status === 'ok' && runsRead.rows.length === 0 && (
        <p className="text-xs text-bone-dim">
          No terminal Goal-linked run is recorded for this Goal yet. Runs appear here after the task
          is sent from Chat and finishes. This is a real empty run history, not an unavailable read.
        </p>
      )}

      {runsRead.status === 'ok' && runsRead.rows.length > 0 && (
        <>
          <p className="text-[11px] text-bone-faint mb-2">
            Select one concrete terminal run to review. The newest or first run is never chosen for
            you, and snapshot review stays disabled until you select a terminal run with a valid
            RFC3339 <span className="font-mono">finished_at</span>.
          </p>
          <div className="flex flex-col gap-2">
            {runsRead.rows.map((run) => {
              const terminal = isTerminalRunOutcome(run.outcome);
              const sameSession = run.session_id === boundSessionId;
              const hasValidFinish = isValidRfc3339(run.finished_at);
              const selectable = terminal && sameSession && hasValidFinish;
              const selected = run.run_id === selectedRunId;
              return (
                <button
                  key={run.run_id}
                  type="button"
                  aria-pressed={selected}
                  disabled={!selectable}
                  onClick={() => selectRun(selected ? null : run.run_id)}
                  className={cn(
                    'text-left px-3 py-2 rounded-lg border transition-colors',
                    selected
                      ? 'bg-royal/15 border-royal/40'
                      : 'bg-obsidian/30 border-iron/20 hover:border-iron/40',
                    !selectable && 'opacity-60 cursor-not-allowed',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot
                      size="sm"
                      variant={run.outcome === 'success' ? 'success' : run.interrupted ? 'warn' : 'default'}
                    />
                    <Pill
                      variant={
                        run.outcome === 'success'
                          ? 'success'
                          : run.outcome === 'cancelled'
                            ? 'default'
                            : 'warn'
                      }
                    >
                      {run.outcome}
                    </Pill>
                    {run.interrupted ? (
                      <Pill variant="warn">interrupted</Pill>
                    ) : (
                      <Pill variant="default">not interrupted</Pill>
                    )}
                    {run.resumable ? (
                      <Pill variant="info">resumable</Pill>
                    ) : (
                      <Pill variant="default">not resumable</Pill>
                    )}
                    {!sameSession && <Pill variant="error">different Session</Pill>}
                    {!terminal && <Pill variant="warn">non-terminal</Pill>}
                    {terminal && !hasValidFinish && (
                      <Pill variant="warn">no valid finished_at</Pill>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-bone-dim mt-1 truncate">
                    run: {run.run_id}
                  </div>
                  <div className="text-[11px] font-mono text-bone-dim truncate">
                    session: {run.session_id}
                  </div>
                  <div className="text-[11px] font-mono text-bone-faint truncate">
                    finished: {run.finished_at ?? 'no terminal finished_at'}
                  </div>
                  <div className="text-[11px] text-bone-faint mt-1">
                    progress evidence refs: {run.evidence_refs.length}
                    {run.accepted_output_pending
                      ? ' · accepted-output evidence pending/unverified'
                      : ''}
                  </div>
                  {run.evidence_refs.length > 0 && (
                    <div className="text-[11px] text-bone-faint mt-0.5 font-mono break-all">
                      {run.evidence_refs.join(', ')}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {selectedRun && (
        <p className="text-[11px] text-bone-faint mt-2">
          Reviewing run <span className="font-mono">{selectedRun.run_id}</span> for Session{' '}
          <span className="font-mono">{boundSessionId}</span>.
        </p>
      )}

      {snapshot.status === 'loading' && (
        <p className="text-xs text-bone-dim mt-2">Capturing a read-only workspace snapshot…</p>
      )}
      {snapshot.status === 'unavailable' && (
        <p role="alert" className="text-xs text-error mt-2">
          {snapshot.message}
        </p>
      )}
      {snapshot.status === 'ok' && selectedRun && (
        <SnapshotReview value={snapshot.value} run={selectedRun} />
      )}
      {selectedRunId === null && runsRead.status === 'ok' && runsRead.rows.length > 0 && (
        <p className="text-[11px] text-bone-faint mt-2">
          Workspace review is disabled until you explicitly select a terminal run above.
        </p>
      )}
    </GlassCard>
  );
}

/**
 * Read-only render of one decoded workspace snapshot. Clean (`complete`),
 * `partial`, `stale`, and `unavailable` stay visually and textually distinct.
 * The diff is always labelled as the workspace state at capture time and, for a
 * failed/interrupted run, as changes pending review — never delivered or
 * accepted. No check result is asserted: this chain does not persist one.
 */
function SnapshotReview({ value, run }: { value: WorkspaceSnapshot; run: GoalRunRow }) {
  const stateConfig: Record<
    SnapshotState,
    { label: string; variant: StatusVariant; blurb: string }
  > = {
    complete: {
      label: 'Complete',
      variant: 'success',
      blurb:
        'Native captured a coherent read-only read of the tracked workspace at capture time.',
    },
    partial: {
      label: 'Partial',
      variant: 'warn',
      blurb:
        'The capture is incomplete; some changes are not fully represented. Nothing here is a complete review.',
    },
    stale: {
      label: 'Stale',
      variant: 'info',
      blurb:
        'The workspace changed between reads, so diff, path, and revision evidence were all discarded.',
    },
    unavailable: {
      label: 'Unavailable',
      variant: 'error',
      blurb: 'The workspace snapshot could not be read. No diff or revision is claimed.',
    },
  };
  const config = stateConfig[value.state];
  const pendingReview = run.outcome !== 'success' || run.interrupted;
  const carriesDiff = value.state === 'complete' || value.state === 'partial';
  const pathsLabel = value.changed_paths_exhaustive
    ? 'Changed paths (exhaustive for this capture)'
    : 'Changed paths (not exhaustive — coverage is unknown)';

  return (
    <div className="mt-3 border-t border-iron/20 pt-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Pill variant={config.variant}>{config.label}</Pill>
        <span className="text-[11px] font-mono text-bone-faint">captured {value.captured_at}</span>
      </div>
      <p className="text-xs text-bone-muted mb-2">{config.blurb}</p>

      <p className="text-[11px] text-bone-faint mb-2">
        This is the workspace snapshot at capture time. It is a read-only observation that may
        include pre-existing edits; it is not proof that the selected run created every change.
      </p>

      {pendingReview && carriesDiff && (
        <p className="text-xs text-warning mb-2">
          This run did not end in a clean success ({run.outcome}
          {run.interrupted ? ', interrupted' : ''}). Any diff below is changes pending review — it is
          not delivered and not accepted.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px] font-mono text-bone-dim mb-2">
        <div className="truncate">HEAD: {value.git_head ?? 'unavailable'}</div>
        <div className="truncate">branch: {value.git_branch ?? 'unavailable'}</div>
        <div className="truncate">Agent: {value.agent_id}</div>
        <div className="truncate">root: {value.project_root}</div>
        <div className="truncate">run outcome: {value.run_outcome}</div>
        <div className="truncate">run finished: {value.run_finished_at ?? 'unavailable'}</div>
      </div>

      {carriesDiff && (
        <>
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-bone/40 mb-1">
            {pathsLabel}
          </div>
          {value.changed_paths.length === 0 ? (
            <p className="text-xs text-bone-dim mb-2">
              No changed tracked or staged paths were detected.
            </p>
          ) : (
            <ul className="list-disc list-inside text-xs text-bone-muted mb-2 max-h-40 overflow-y-auto">
              {value.changed_paths.map((path) => (
                <li key={path} className="font-mono break-all">
                  {path}
                </li>
              ))}
            </ul>
          )}

          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-bone/40 mb-1">
            Diff{' '}
            {isSha256Hex(value.diff_sha256)
              ? `(sha256 ${value.diff_sha256})`
              : '(no valid sha256 — not a complete capture)'}
          </div>
          {value.diff.length === 0 ? (
            <p className="text-xs text-bone-dim mb-2">
              No tracked or staged diff was captured for this snapshot.
            </p>
          ) : (
            <pre className="text-[11px] leading-snug font-mono text-bone-muted bg-black/30 border border-iron/20 rounded-lg p-2 max-h-80 overflow-auto whitespace-pre-wrap break-all mb-2">
              {value.diff}
            </pre>
          )}
        </>
      )}

      {value.reason && <p className="text-xs text-bone-dim mb-1">Reason: {value.reason}</p>}
      {value.details.length > 0 && (
        <ul className="list-disc list-inside text-[11px] text-bone-faint mb-2">
          {value.details.map((detail, index) => (
            <li key={`${index}-${detail}`}>{detail}</li>
          ))}
        </ul>
      )}

      <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-bone/40 mb-1">
        Evidence
      </div>
      <p className="text-xs text-bone-muted mb-1">
        Progress evidence refs from the persisted terminal run: {run.evidence_refs.length}
        {run.evidence_refs.length > 0 && (
          <>
            {' — '}
            <span className="font-mono break-all">{run.evidence_refs.join(', ')}</span>
          </>
        )}
      </p>
      <p className="text-xs text-bone-dim mb-2">
        Check evidence unavailable. This source chain persists run and tool evidence, not acceptance
        check results; no test runner is added here and no check is claimed to have passed. The five
        Jarvis source checks validate Jarvis source only and are not task-level acceptance evidence.
      </p>
      <p className="text-[11px] text-bone-faint">
        A run, a tool success, model text, or this snapshot never marks the Goal delivered or
        accepted. Goal completion remains available only through the existing trusted native
        acceptance receipt and exact readback path.
      </p>
    </div>
  );
}
