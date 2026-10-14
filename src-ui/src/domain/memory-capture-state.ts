// ─── Memory capture receipt state (UI projection) ───────────────────────────
// Phase 3.3. Honest, minimal projection of a committed native `CaptureReceipt`
// onto one transport status. This module NEVER substitutes assistant prose for
// a receipt: a `saved` state requires a committed native receipt whose
// `saved_count` is positive. A blocked-only receipt or a capture error is
// `failed`; an unresolved operation is `pending`; anything else is `unchanged`.
//
// Field names and enum values mirror the frozen Rust/TS capture contracts in
// `src-tauri/src/jarvis/memory/capture_contracts.rs` and
// `server-jarvis/src/memory-contract.ts`. Phase 4 owns the fuller controls.

export type CaptureOperationStatus =
  | 'saved'
  | 'forgotten'
  | 'corrected'
  | 'pending'
  | 'blocked';

export type MemoryTurnTerminalStatus =
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed'
  | 'unterminated';

export interface CaptureOperationReceipt {
  operation_id: string;
  status: CaptureOperationStatus;
  memory_id: string | null;
  replacement_id: string | null;
  reason_code: string | null;
}

export interface CaptureReceipt {
  turn_id: string;
  session_id: string;
  terminal_status: MemoryTurnTerminalStatus | null;
  operations: CaptureOperationReceipt[];
  store_revision: number;
  continuity_revision: number;
  saved_count: number;
  pending_count: number;
}

export type CaptureStateName = 'saved' | 'pending' | 'unchanged' | 'failed';

export interface CaptureStateView {
  state: CaptureStateName;
  savedCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const OPERATION_STATUSES: ReadonlySet<string> = new Set<CaptureOperationStatus>([
  'saved',
  'forgotten',
  'corrected',
  'pending',
  'blocked',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<MemoryTurnTerminalStatus>([
  'completed',
  'partial',
  'cancelled',
  'failed',
  'unterminated',
]);

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decode a native `CaptureReceipt`. Malformed input is rejected with `null` so
 * the caller surfaces `failed` rather than inventing a saved count.
 *
 * Fail-closed rules (Phase 3.3): `terminal_status` must be a frozen enum value
 * or `null`; revisions/counts must be nonnegative safe integers; every
 * `operation_id` must be nonempty and unique; optional fields must be
 * `null`/string; and the declared counts must equal the statuses they describe
 * (`saved_count` = saved+corrected, `pending_count` = pending only).
 */
export function decodeCaptureReceipt(value: unknown): CaptureReceipt | null {
  if (!isRecord(value)) return null;
  if (typeof value.turn_id !== 'string' || value.turn_id.length === 0) return null;
  if (typeof value.session_id !== 'string' || value.session_id.length === 0) return null;
  const terminal = value.terminal_status;
  if (terminal !== null && !(typeof terminal === 'string' && TERMINAL_STATUSES.has(terminal))) return null;
  if (!Array.isArray(value.operations)) return null;
  const operations: CaptureOperationReceipt[] = [];
  const seenOperationIds = new Set<string>();
  for (const entry of value.operations) {
    if (!isRecord(entry)) return null;
    const status = entry.status;
    if (typeof status !== 'string' || !OPERATION_STATUSES.has(status)) return null;
    if (typeof entry.operation_id !== 'string' || entry.operation_id.length === 0) return null;
    if (seenOperationIds.has(entry.operation_id)) return null;
    seenOperationIds.add(entry.operation_id);
    const memoryId = entry.memory_id;
    const replacementId = entry.replacement_id;
    const reasonCode = entry.reason_code;
    if (memoryId !== null && memoryId !== undefined && typeof memoryId !== 'string') return null;
    if (replacementId !== null && replacementId !== undefined && typeof replacementId !== 'string') return null;
    if (reasonCode !== null && reasonCode !== undefined && typeof reasonCode !== 'string') return null;
    operations.push({
      operation_id: entry.operation_id,
      status: status as CaptureOperationStatus,
      memory_id: memoryId ?? null,
      replacement_id: replacementId ?? null,
      reason_code: reasonCode ?? null,
    });
  }
  if (!isNonNegativeInt(value.store_revision)) return null;
  if (!isNonNegativeInt(value.continuity_revision)) return null;
  if (!isNonNegativeInt(value.saved_count)) return null;
  if (!isNonNegativeInt(value.pending_count)) return null;
  const committedSaved = operations.filter(
    (op) => op.status === 'saved' || op.status === 'corrected',
  ).length;
  const committedPending = operations.filter((op) => op.status === 'pending').length;
  if (value.saved_count !== committedSaved) return null;
  if (value.pending_count !== committedPending) return null;
  return {
    turn_id: value.turn_id,
    session_id: value.session_id,
    terminal_status: (terminal as MemoryTurnTerminalStatus | null) ?? null,
    operations,
    store_revision: value.store_revision,
    continuity_revision: value.continuity_revision,
    saved_count: value.saved_count,
    pending_count: value.pending_count,
  };
}

/**
 * Project a committed receipt (or a capture error code) onto the honest
 * transport status the UI may show.
 *
 * Priority (Phase 3.3):
 * - an ACTUAL capture error -> `failed`, even when the payload also carries a
 *   receipt; the bounded `capture_pending` timeout metadata stays `pending`;
 * - a missing/malformed receipt -> `failed`;
 * - a committed blocked-only receipt -> `failed`;
 * - ANY pending operation -> `pending`, before any saved count;
 * - committed `saved_count > 0` -> `saved`;
 * - otherwise `unchanged`.
 *
 * Separated `sync_failed` / `append_failed` metadata is NOT an `errorCode`, so
 * it never fails a committed receipt: a saved receipt stays `saved`.
 */
export function captureReceiptState(
  receipt: CaptureReceipt | null,
  errorCode: string | null,
): CaptureStateView {
  // The bounded timeout metadata is pending, never a hard failure.
  if (errorCode === 'capture_pending') {
    return { state: 'pending', savedCount: 0 };
  }
  // Any other ACTUAL capture error wins even when a receipt is present.
  if (errorCode !== null) {
    return { state: 'failed', savedCount: 0 };
  }
  if (receipt === null) {
    return { state: 'failed', savedCount: 0 };
  }
  const savedCount = receipt.saved_count;
  const hasOperations = receipt.operations.length > 0;
  const blockedOnly = hasOperations
    && receipt.operations.every((op) => op.status === 'blocked');
  if (blockedOnly) {
    return { state: 'failed', savedCount: 0 };
  }
  if (receipt.pending_count > 0) {
    return { state: 'pending', savedCount: 0 };
  }
  if (savedCount > 0) {
    return { state: 'saved', savedCount };
  }
  return { state: 'unchanged', savedCount: 0 };
}
