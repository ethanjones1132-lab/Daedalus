// ─── Native memory turn state (UI decoders) ─────────────────────────────────
// Phase 2.4. This module mirrors the frozen Phase 2.1/2.2 wire vocabulary for
// the UI only. It decodes native preparation/diagnostic envelopes and the
// transient `memory_status` / `memory_applied` SSE frames.
//
// Discipline: the UI never sees recalled text, capability, scope, or source
// hashes. SSE frames are informational only; the native `memory_turn_diagnostic`
// read-back is the authority for persisted selected/applied metadata. No frame
// is ever treated as durable native evidence.

import type {
  AuthorityKind,
  MemoryScopeKind,
  MemoryStatementKind,
} from './memory-control-state';

/** Frozen `MemoryRecallStatus` values. Keep in lockstep with the Rust enum. */
export type MemoryRecallStatus =
  | 'ready'
  | 'empty'
  | 'unavailable'
  | 'retrieval_failed'
  | 'registration_failed'
  | 'expired'
  | 'invalidated'
  | 'scope_mismatch'
  | 'already_consumed'
  | 'budget_omitted'
  | 'applied';

/** Frozen `MemoryTurnState` values. */
export type MemoryTurnState =
  | 'prepared'
  | 'registered'
  | 'started'
  | 'terminal'
  | 'invalidated'
  | 'expired'
  | 'unavailable'
  | 'unterminated';

/** Frozen `MemoryTurnTerminalStatus` values. */
export type MemoryTurnTerminalStatus =
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed'
  | 'unterminated';

/** Phase 4.3 `MemoryRevalidationState` values (evidence availability only). */
export type MemoryRevalidationState =
  | 'not_required'
  | 'required'
  | 'fresh_evidence'
  | 'unavailable';

const REVALIDATION_STATES: ReadonlySet<string> = new Set<MemoryRevalidationState>([
  'not_required',
  'required',
  'fresh_evidence',
  'unavailable',
]);

const RECALL_STATUSES: ReadonlySet<string> = new Set<MemoryRecallStatus>([
  'ready',
  'empty',
  'unavailable',
  'retrieval_failed',
  'registration_failed',
  'expired',
  'invalidated',
  'scope_mismatch',
  'already_consumed',
  'budget_omitted',
  'applied',
]);

const TURN_STATES: ReadonlySet<string> = new Set<MemoryTurnState>([
  'prepared',
  'registered',
  'started',
  'terminal',
  'invalidated',
  'expired',
  'unavailable',
  'unterminated',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<MemoryTurnTerminalStatus>([
  'completed',
  'partial',
  'cancelled',
  'failed',
  'unterminated',
]);

export function isMemoryRecallStatus(value: unknown): value is MemoryRecallStatus {
  return typeof value === 'string' && RECALL_STATUSES.has(value);
}

/**
 * Map an unknown thrown/typed error to a known recall status. Only an exact
 * frozen status on the error's `status`/`code` is honored; anything else
 * degrades to `unavailable` rather than inventing `registration_failed`.
 */
export function coerceMemoryRecallStatus(value: unknown): MemoryRecallStatus {
  if (value && typeof value === 'object') {
    const candidate = (value as { status?: unknown }).status
      ?? (value as { code?: unknown }).code;
    if (isMemoryRecallStatus(candidate)) return candidate;
  }
  return 'unavailable';
}

/**
 * Validate native prompt-history rows before use. Unknown/malformed data
 * degrades to `null` so the caller sends empty history plus a visible warning
 * instead of blindly mapping malformed rows or falling back to a UI cache.
 */
export function decodeNativeHistoryRows(
  value: unknown,
): Array<{ role: string; content: string }> | null {
  if (!Array.isArray(value)) return null;
  const rows: Array<{ role: string; content: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.role !== 'string' || typeof entry.content !== 'string') {
      return null;
    }
    rows.push({ role: entry.role, content: entry.content });
  }
  return rows;
}

export function isMemoryTurnState(value: unknown): value is MemoryTurnState {
  return typeof value === 'string' && TURN_STATES.has(value);
}

export function isMemoryTurnTerminalStatus(value: unknown): value is MemoryTurnTerminalStatus {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value);
}

/** Native `MemoryTurnPreparation` response (request-wrapped command result). */
export interface MemoryTurnPreparation {
  turn_id: string;
  preparation_id: string | null;
  status: MemoryRecallStatus;
}

/** Transient `memory_status` SSE frame — metadata only, never authority. */
export interface MemoryStatusFrame {
  turn_id: string;
  status: MemoryRecallStatus;
  selected_ids: string[];
  store_revision: number | null;
  code?: string;
}

/** Decoded native `MemoryScope` (field names camel-cased). */
export interface MemoryScopeView {
  kind: MemoryScopeKind;
  agentId: string;
  projectRoot: string | null;
}

/**
 * Decoded prepared candidate from the native `selected` metadata. This is what
 * was *prepared*, never what was used: only the intersection with
 * `appliedSelectedIds` may be shown as used.
 */
export interface PreparedMemorySelectionView {
  id: string;
  revision: number;
  scope: MemoryScopeView;
  authorityKind: AuthorityKind;
  statementKind: MemoryStatementKind;
  sourceSessionId: string | null;
  sourceMessageIds: string[];
  sourceRunId: string | null;
  verifiedAt: string | null;
  stale: boolean;
}

/**
 * UI projection of the authoritative native `MemoryTurnDiagnostic`. Prepared
 * `prepared`/`selectedIds` and actual `appliedSelectedIds` stay distinct; the
 * latter may validly be empty even after a model turn.
 */
export interface MemoryTurnDiagnosticView {
  turnId: string;
  sessionId: string;
  scope: MemoryScopeView;
  state: MemoryTurnState;
  recallStatus: MemoryRecallStatus;
  errorCode: string | null;
  terminalStatus: MemoryTurnTerminalStatus | null;
  prepared: PreparedMemorySelectionView[];
  selectedIds: string[];
  appliedSelectedIds: string[];
  storeRevision: number;
  /**
   * Phase 4.3 current-source evidence availability. `null` when the native
   * diagnostic predates the field or lacks a well-formed result. Never a truth
   * verdict or a verified-observation capture.
   */
  revalidation: MemoryRevalidationView | null;
}

/** Decoded native `MemoryRevalidationResult` (field names camel-cased). */
export interface MemoryRevalidationView {
  state: MemoryRevalidationState;
  memoryIds: string[];
  evidenceToolCallIds: string[];
  reasonCode: string | null;
}

const SCOPE_KINDS: ReadonlySet<string> = new Set<MemoryScopeKind>([
  'project',
  'agent',
  'user',
  'legacy_unscoped',
]);

const AUTHORITY_KINDS: ReadonlySet<string> = new Set<AuthorityKind>([
  'manual',
  'user_statement',
  'verified_observation',
  'assistant_proposal',
  'legacy_unknown',
]);

const STATEMENT_KINDS: ReadonlySet<string> = new Set<MemoryStatementKind>([
  'normative_constraint',
  'descriptive_fact',
  'unknown',
]);

/** Present and either a string or an explicit null; missing is rejected. */
function isPresentNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/**
 * Strict scope decoder. `project_root` must be explicitly present as string or
 * null; a missing field is malformed.
 */
export function decodeMemoryScope(value: unknown): MemoryScopeView {
  if (!isRecord(value)) throw new Error('Invalid memory scope');
  if (typeof value.kind !== 'string' || !SCOPE_KINDS.has(value.kind)) {
    throw new Error('Invalid memory scope kind');
  }
  if (typeof value.agent_id !== 'string') throw new Error('Invalid memory scope agent');
  if (!('project_root' in value) || !isPresentNullableString(value.project_root)) {
    throw new Error('Invalid memory scope project root');
  }
  return {
    kind: value.kind as MemoryScopeKind,
    agentId: value.agent_id,
    projectRoot: value.project_root as string | null,
  };
}

/**
 * Strict prepared-selection decoder. A missing `statement_kind` is the only
 * legacy compatibility (decoded as `unknown`); every other field must be
 * present and well-typed or the whole diagnostic is malformed.
 */
export function decodePreparedMemorySelection(value: unknown): PreparedMemorySelectionView {
  if (!isRecord(value)) throw new Error('Invalid prepared memory selection');
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('Invalid prepared memory selection id');
  }
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision <= 0
  ) {
    throw new Error('Invalid prepared memory selection revision');
  }
  if (typeof value.authority_kind !== 'string' || !AUTHORITY_KINDS.has(value.authority_kind)) {
    throw new Error('Invalid prepared memory authority');
  }
  const statementRaw = value.statement_kind;
  const statementKind = statementRaw === undefined
    ? 'unknown'
    : (typeof statementRaw === 'string' && STATEMENT_KINDS.has(statementRaw)
      ? (statementRaw as MemoryStatementKind)
      : null);
  if (statementKind === null) throw new Error('Invalid prepared memory classification');
  if (!('source_session_id' in value) || !isPresentNullableString(value.source_session_id)) {
    throw new Error('Invalid prepared memory source session');
  }
  if (!('source_run_id' in value) || !isPresentNullableString(value.source_run_id)) {
    throw new Error('Invalid prepared memory source run');
  }
  if (!('verified_at' in value) || !isPresentNullableString(value.verified_at)) {
    throw new Error('Invalid prepared memory verification provenance');
  }
  if (!isStringArray(value.source_message_ids)) {
    throw new Error('Invalid prepared memory source messages');
  }
  if (typeof value.stale !== 'boolean') {
    throw new Error('Invalid prepared memory staleness');
  }
  return {
    id: value.id,
    revision: value.revision,
    scope: decodeMemoryScope(value.scope),
    authorityKind: value.authority_kind as AuthorityKind,
    statementKind,
    sourceSessionId: value.source_session_id as string | null,
    sourceMessageIds: value.source_message_ids,
    sourceRunId: value.source_run_id as string | null,
    verifiedAt: value.verified_at as string | null,
    stale: value.stale,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Decode an optional Phase 4.3 native revalidation result. A missing or
 * malformed value decodes to `null` (predates the field / unavailable), never
 * to an invented success.
 */
export function decodeMemoryRevalidation(value: unknown): MemoryRevalidationView | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (typeof state !== 'string' || !REVALIDATION_STATES.has(state)) return null;
  const memoryIds = isStringArray(value.memory_ids) ? value.memory_ids : null;
  const evidenceToolCallIds = isStringArray(value.evidence_tool_call_ids)
    ? value.evidence_tool_call_ids
    : null;
  const reason = value.reason_code;
  if (memoryIds === null || evidenceToolCallIds === null) return null;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return null;
  if (state === 'fresh_evidence' && evidenceToolCallIds.length === 0) return null;
  return {
    state: state as MemoryRevalidationState,
    memoryIds,
    evidenceToolCallIds,
    reasonCode: typeof reason === 'string' ? reason : null,
  };
}

/**
 * Decode a native `MemoryTurnPreparation`. Malformed values are rejected by
 * throwing; callers treat a failure as "memory reference unavailable" and run
 * ordinary inference.
 */
export function decodeMemoryTurnPreparation(value: unknown): MemoryTurnPreparation {
  if (!isRecord(value)) throw new Error('Invalid memory turn preparation');
  const turnId = value.turn_id;
  const preparationId = value.preparation_id;
  const status = value.status;
  if (typeof turnId !== 'string' || turnId.length === 0) {
    throw new Error('Invalid memory turn preparation');
  }
  if (preparationId !== null && typeof preparationId !== 'string') {
    throw new Error('Invalid memory turn preparation');
  }
  if (!isMemoryRecallStatus(status)) {
    throw new Error('Invalid memory turn preparation');
  }
  return {
    turn_id: turnId,
    preparation_id: preparationId === null ? null : preparationId,
    status,
  };
}

/**
 * Decode a transient `memory_status` SSE frame. Non-object/malformed frames
 * are rejected with `null`; an unknown `status` value degrades to
 * `unavailable` rather than surfacing an invented status.
 */
export function decodeMemoryStatusFrame(value: unknown): MemoryStatusFrame | null {
  if (!isRecord(value)) return null;
  const turnId = value.turn_id;
  if (typeof turnId !== 'string' || turnId.length === 0) return null;
  const status = isMemoryRecallStatus(value.status) ? value.status : 'unavailable';
  const selectedIds = isStringArray(value.selected_ids) ? value.selected_ids : [];
  const storeRevision = isFiniteNumber(value.store_revision) ? value.store_revision : null;
  const code = typeof value.code === 'string' ? value.code : undefined;
  return {
    turn_id: turnId,
    status,
    selected_ids: selectedIds,
    store_revision: storeRevision,
    ...(code ? { code } : {}),
  };
}

/**
 * Decode the authoritative native `MemoryTurnDiagnostic`. Requires exact frozen
 * state/status values; malformed input is rejected by throwing so the caller
 * never renders an invented diagnostic.
 */
export function decodeMemoryTurnDiagnostic(value: unknown): MemoryTurnDiagnosticView {
  if (!isRecord(value)) throw new Error('Invalid memory turn diagnostic');
  const turnId = value.turn_id;
  const sessionId = value.session_id;
  const storeRevision = value.store_revision;
  const state = value.state;
  const recallStatus = value.recall_status;
  const errorCode = value.error_code;
  const terminalStatus = value.terminal_status;
  if (typeof turnId !== 'string' || turnId.length === 0) {
    throw new Error('Invalid memory turn diagnostic');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('Invalid memory turn diagnostic');
  }
  if (!isFiniteNumber(storeRevision)) throw new Error('Invalid memory turn diagnostic');
  if (!isMemoryTurnState(state)) throw new Error('Invalid memory turn diagnostic');
  if (!isMemoryRecallStatus(recallStatus)) throw new Error('Invalid memory turn diagnostic');
  if (errorCode !== null && typeof errorCode !== 'string') {
    throw new Error('Invalid memory turn diagnostic');
  }
  if (terminalStatus !== null && !isMemoryTurnTerminalStatus(terminalStatus)) {
    throw new Error('Invalid memory turn diagnostic');
  }
  if (!Array.isArray(value.selected)) throw new Error('Invalid memory turn diagnostic');
  const prepared = value.selected.map(decodePreparedMemorySelection);
  const selectedIds = prepared.map((entry) => entry.id);
  if (!isStringArray(value.applied_selected_ids)) {
    throw new Error('Invalid memory turn diagnostic');
  }
  const appliedSelectedIds = value.applied_selected_ids;
  return {
    turnId,
    sessionId,
    scope: decodeMemoryScope(value.scope),
    state,
    recallStatus,
    errorCode: errorCode ?? null,
    terminalStatus: terminalStatus ?? null,
    prepared,
    selectedIds,
    appliedSelectedIds,
    storeRevision,
    revalidation: decodeMemoryRevalidation(value.revalidation),
  };
}

const RECALL_STATUS_LABELS: Record<MemoryRecallStatus, string> = {
  ready: 'ready',
  empty: 'no matches',
  unavailable: 'unavailable',
  retrieval_failed: 'retrieval failed',
  registration_failed: 'registration failed',
  expired: 'expired',
  invalidated: 'invalidated',
  scope_mismatch: 'scope mismatch',
  already_consumed: 'already used',
  budget_omitted: 'omitted (budget)',
  applied: 'applied',
};

export function memoryRecallStatusLabel(status: MemoryRecallStatus): string {
  return RECALL_STATUS_LABELS[status] ?? 'unavailable';
}

const TURN_STATE_LABELS: Record<MemoryTurnState, string> = {
  prepared: 'prepared',
  registered: 'registered',
  started: 'started',
  terminal: 'finished',
  invalidated: 'invalidated',
  expired: 'expired',
  unavailable: 'unavailable',
  unterminated: 'unterminated',
};

/**
 * True only when the native turn reached a terminal state. A `registered`,
 * `started`, or `prepared` read-back is explicitly NOT terminal success.
 */
export function isMemoryTurnTerminal(state: MemoryTurnState): boolean {
  return state === 'terminal';
}

/**
 * Compact, honest per-turn status label. Counts come only from the native
 * diagnostic; the transient status is used solely while no diagnostic exists.
 * Prepared selection and actually-applied IDs are reported separately.
 */
export function formatMemoryTurnLabel(
  transient: MemoryRecallStatus | null,
  diagnostic: MemoryTurnDiagnosticView | null,
): string | null {
  if (diagnostic) {
    const selected = diagnostic.selectedIds.length;
    const applied = diagnostic.appliedSelectedIds.length;
    // A nonterminal read-back is surfaced explicitly and never presented as
    // completion; only the native `terminal` state is finished.
    const stateSuffix = isMemoryTurnTerminal(diagnostic.state)
      ? ''
      : ` · ${TURN_STATE_LABELS[diagnostic.state]}`;
    const base = `Memory: ${memoryRecallStatusLabel(diagnostic.recallStatus)}${stateSuffix}`;
    if (diagnostic.recallStatus === 'ready' || diagnostic.recallStatus === 'applied' || selected > 0 || applied > 0) {
      return `${base} · selected ${selected} · applied ${applied}`;
    }
    return base;
  }
  if (transient) return `Memory: ${memoryRecallStatusLabel(transient)}`;
  return null;
}
