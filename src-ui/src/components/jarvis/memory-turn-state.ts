// ─── Native memory turn state (UI decoders) ─────────────────────────────────
// Phase 2.4. This module mirrors the frozen Phase 2.1/2.2 wire vocabulary for
// the UI only. It decodes native preparation/diagnostic envelopes and the
// transient `memory_status` / `memory_applied` SSE frames.
//
// Discipline: the UI never sees recalled text, capability, scope, or source
// hashes. SSE frames are informational only; the native `memory_turn_diagnostic`
// read-back is the authority for persisted selected/applied metadata. No frame
// is ever treated as durable native evidence.

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

/**
 * UI projection of the authoritative native `MemoryTurnDiagnostic`. Prepared
 * `selectedIds` and actual `appliedSelectedIds` stay distinct; the latter may
 * validly be empty even after a model turn.
 */
export interface MemoryTurnDiagnosticView {
  turnId: string;
  sessionId: string;
  state: MemoryTurnState;
  recallStatus: MemoryRecallStatus;
  errorCode: string | null;
  terminalStatus: MemoryTurnTerminalStatus | null;
  selectedIds: string[];
  appliedSelectedIds: string[];
  storeRevision: number;
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
  const selected = Array.isArray(value.selected) ? value.selected : [];
  const selectedIds = selected
    .map((entry) => (isRecord(entry) && typeof entry.id === 'string' ? entry.id : null))
    .filter((id): id is string => id !== null);
  const appliedSelectedIds = isStringArray(value.applied_selected_ids)
    ? value.applied_selected_ids
    : [];
  return {
    turnId,
    sessionId,
    state,
    recallStatus,
    errorCode: errorCode ?? null,
    terminalStatus: terminalStatus ?? null,
    selectedIds,
    appliedSelectedIds,
    storeRevision,
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
