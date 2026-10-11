/**
 * Session run-outcome telemetry — pure decision helpers for the Jarvis
 * SessionsPanel.
 *
 * `get_all_session_runs` used to be read inside the Session list's
 * `Promise.all` with an inline `.catch(() => [])`. Because the failure was
 * caught inline, the list's only error path could never see it: a rejected
 * read removed every outcome badge and left each row byte-identical to a
 * Session with no recorded run — the exact "session_runs stayed empty while
 * the UI was in daily use" misdiagnosis already recorded in
 * `src-tauri/src/commands/sessions.rs`. These helpers keep the three states
 * apart and never infer an outcome:
 *
 *   - `unavailable`  — the read failed or returned something that is not a
 *                      list of run records. The outcome is unknown.
 *   - `recorded`     — Native returned a run for this Session.
 *   - `not_recorded` — the read succeeded and contained no run for this
 *                      Session. A confirmed absence, not a failure.
 *
 * Native SQLite (`record_terminal_run` / `list_all_session_runs`) stays the
 * durable authority; nothing here writes, retries, or guesses.
 */
import type { SessionRunRecord } from './types';

/**
 * The terminal-outcome vocabulary `persist_terminal_run` validates on write
 * (`src-tauri/src/commands/sessions.rs`). Pinned so the surface cannot drift
 * into rendering an outcome Native would never have stored.
 */
export const RUN_OUTCOMES = ['success', 'partial', 'failed', 'timed_out', 'cancelled'] as const;
export type SessionRunOutcome = (typeof RUN_OUTCOMES)[number];

/** Announced summary shown above the list when the outcome read is unavailable. */
export const RUN_TELEMETRY_UNAVAILABLE_MESSAGE =
  'Could not read recorded run outcomes. Every Session below shows its run outcome as unavailable until a read succeeds.';

/** Per-row marker for a Session whose outcome read is still in flight. */
export const RUN_OUTCOME_PENDING_TEXT = 'reading run outcome…';

/** Per-row marker for a Session whose outcome could not be read. */
export const RUN_OUTCOME_UNAVAILABLE_TEXT = 'run outcome unavailable';

/** Per-row marker for a Session the read confirmed has no recorded run. */
export const RUN_NOT_RECORDED_TEXT = 'no run recorded';

/**
 * Per-row marker for a Session whose most recent turn never got a confirmed
 * run record. The durable read may honestly report no run for it; that alone
 * must not let a turn the operator watched finish read as a clean run.
 */
export const RUN_ROW_UNCONFIRMED_TEXT = "last turn's run outcome not confirmed";

// ── Run-record read-back (Task 4.1 durable outcome confirmation) ─────
//
// `record_terminal_run` used to be fire-and-forget: its only failure handling
// was a `console.warn`, and nothing ever read the row back. A rejected write
// (invalid outcome, locked DB, a command missing from the shipped binary)
// therefore left the Session reading as one that never ran, while the
// operator had just watched a terminal frame render. These helpers decide one
// run record from the write's own outcome plus a `get_session_runs`
// read-back, and never infer a record that Native did not report.

/** Pending text for the durable write itself. */
export const RUN_RECORD_WRITING_TEXT = 'Recording the run outcome for this turn…';

/** Pending text for the read-back that decides whether the write landed. */
export const RUN_RECORD_CONFIRMING_TEXT =
  'Reading the recorded run back from the Session store…';

/** Confirmed success: Native's read-back reports this run with this outcome. */
export const RUN_RECORD_CONFIRMED_MESSAGE = (runId: string, outcome: string) =>
  `Recorded run ${runId} as ${outcome}.`;

/** The read-back disagrees with the local outcome: the stored one is shown. */
export const RUN_RECORD_DISAGREED_MESSAGE = (
  runId: string,
  localOutcome: string,
  storedOutcome: string,
) => `Native recorded run ${runId} as ${storedOutcome}, not ${localOutcome}. The stored outcome is shown.`;

/** The write resolved but the read-back does not report the run. */
export const RUN_RECORD_UNRECORDED_MESSAGE = (runId: string) =>
  `Native does not report run ${runId} for this Session, so the recorded run outcome is not confirmed.`;

/** The write resolved but the read-back could not be decoded or failed. */
export const RUN_RECORD_READ_FAILED_MESSAGE = (runId: string) =>
  `Run ${runId} was written but could not be read back, so the recorded run outcome is not confirmed.`;

/** Native rejected the write outright. */
export const RUN_RECORD_WRITE_FAILED_MESSAGE = (runId: string) =>
  `Native rejected the record for run ${runId}, so this Session has no confirmed run outcome.`;

export type SessionRunWrite = { ok: true } | { ok: false };

/** What the UI believes it recorded, and for which Session. */
export interface RunRecordIntent {
  sessionId: string;
  runId: string;
  outcome: SessionRunOutcome;
}

export type RunRecordVerdict =
  | { phase: 'confirmed'; run: SessionRunRecord }
  | { phase: 'disagreed'; run: SessionRunRecord }
  | { phase: 'unrecorded' }
  | { phase: 'unreadable' }
  | { phase: 'write_failed' };

export type RunRecordPhase = 'writing' | 'confirming' | RunRecordVerdict['phase'];

export interface RunRecordState {
  intent: RunRecordIntent;
  phase: RunRecordPhase;
  run?: SessionRunRecord;
}

export interface RunRecordView {
  phase: RunRecordPhase;
  text: string;
  /** True only when Native's read-back reports this run with this outcome. */
  confirmed: boolean;
  /** True when a deliberate re-record/re-read can still resolve the record. */
  retryable: boolean;
  runId: string;
}

export type SessionRunRead =
  | { ok: true; value: unknown }
  | { ok: false };

export type SessionRunTelemetry =
  | { state: 'pending' }
  | { state: 'unavailable' }
  | { state: 'available'; runs: Record<string, SessionRunHistoryEntry> };

export type SessionOutcomeView =
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'not_recorded' }
  | { kind: 'recorded'; run: SessionRunRecord; olderCount: number };

/** The newest recorded run of one Session plus how many older ones exist. */
export interface SessionRunHistoryEntry {
  run: SessionRunRecord;
  olderCount: number;
}

function isRunRecord(value: unknown): value is SessionRunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.session_id === 'string' &&
    row.session_id.length > 0 &&
    typeof row.run_id === 'string' &&
    row.run_id.length > 0 &&
    typeof row.outcome === 'string' &&
    row.outcome.length > 0
  );
}

/**
 * Decode a native read result. Returns `null` for anything that is not a
 * complete list of run records — a non-array root, or one malformed entry —
 * so a schema-drifted or truncated result can never be presented as a
 * confirmed absence of runs.
 */
export function decodeSessionRuns(value: unknown): SessionRunRecord[] | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!isRunRecord(entry)) return null;
  }
  return value as SessionRunRecord[];
}

/**
 * Index decoded runs by Session. Native lists newest-first
 * (`ORDER BY finished_at DESC`), so the first entry for a Session wins and
 * every later row is one of its older runs. Runs for Sessions that are not
 * visible are dropped, and the input array is never mutated.
 */
export function indexSessionRuns(
  runs: SessionRunRecord[],
  visibleSessionIds: Iterable<string>,
): Record<string, SessionRunHistoryEntry> {
  const visible = new Set(visibleSessionIds);
  const indexed: Record<string, SessionRunHistoryEntry> = {};
  for (const run of runs) {
    if (!visible.has(run.session_id)) continue;
    const current = indexed[run.session_id];
    if (current) current.olderCount += 1;
    else indexed[run.session_id] = { run, olderCount: 0 };
  }
  return indexed;
}

/** Decide the list's run-telemetry state from one native read. */
export function decideSessionRunTelemetry(
  read: SessionRunRead,
  visibleSessionIds: Iterable<string>,
): SessionRunTelemetry {
  if (!read.ok) return { state: 'unavailable' };
  const runs = decodeSessionRuns(read.value);
  if (runs === null) return { state: 'unavailable' };
  return { state: 'available', runs: indexSessionRuns(runs, visibleSessionIds) };
}

/** Project one Session row's outcome from the list's telemetry state. */
export function sessionOutcomeView(
  telemetry: SessionRunTelemetry,
  sessionId: string,
): SessionOutcomeView {
  if (telemetry.state === 'pending') return { kind: 'pending' };
  if (telemetry.state === 'unavailable') return { kind: 'unavailable' };
  const entry = telemetry.runs[sessionId];
  return entry
    ? { kind: 'recorded', run: entry.run, olderCount: entry.olderCount }
    : { kind: 'not_recorded' };
}

/**
 * Decide one run record from the durable write and a `get_session_runs`
 * read-back. The webview's own terminal frame is never evidence: only a row
 * Native reports for this `run_id` can confirm a record, and only a stored
 * outcome inside the recorded vocabulary can read as success. A disagreeing
 * read-back is reported verbatim and is never rewritten.
 */
export function decideRunRecord(
  intent: RunRecordIntent,
  write: SessionRunWrite,
  read: SessionRunRead,
): RunRecordVerdict {
  if (!write.ok) return { phase: 'write_failed' };
  if (!read.ok) return { phase: 'unreadable' };
  const runs = decodeSessionRuns(read.value);
  if (runs === null) return { phase: 'unreadable' };
  const stored = runs.find(entry => entry.run_id === intent.runId);
  if (!stored) return { phase: 'unrecorded' };
  const agrees = stored.session_id === intent.sessionId
    && stored.outcome === intent.outcome
    && (RUN_OUTCOMES as readonly string[]).includes(stored.outcome);
  return agrees ? { phase: 'confirmed', run: stored } : { phase: 'disagreed', run: stored };
}

/** Project a run record onto the one fixed sentence the surface shows. */
export function runRecordView(state: RunRecordState | null): RunRecordView | null {
  if (!state) return null;
  const { intent, phase, run } = state;
  const base = { phase, runId: intent.runId };
  if (phase === 'writing') {
    return { ...base, text: RUN_RECORD_WRITING_TEXT, confirmed: false, retryable: false };
  }
  if (phase === 'confirming') {
    return { ...base, text: RUN_RECORD_CONFIRMING_TEXT, confirmed: false, retryable: false };
  }
  if (phase === 'confirmed') {
    return {
      ...base,
      text: RUN_RECORD_CONFIRMED_MESSAGE(intent.runId, run?.outcome ?? intent.outcome),
      confirmed: true,
      retryable: false,
    };
  }
  if (phase === 'disagreed') {
    return {
      ...base,
      text: RUN_RECORD_DISAGREED_MESSAGE(
        intent.runId,
        intent.outcome,
        run?.outcome ?? 'an unrecognised outcome',
      ),
      confirmed: false,
      // A disagreement is the stored row winning. Re-recording would overwrite
      // it, so this state is deliberately not retryable.
      retryable: false,
    };
  }
  if (phase === 'unrecorded') {
    return { ...base, text: RUN_RECORD_UNRECORDED_MESSAGE(intent.runId), confirmed: false, retryable: true };
  }
  if (phase === 'unreadable') {
    return { ...base, text: RUN_RECORD_READ_FAILED_MESSAGE(intent.runId), confirmed: false, retryable: true };
  }
  return { ...base, text: RUN_RECORD_WRITE_FAILED_MESSAGE(intent.runId), confirmed: false, retryable: true };
}

/**
 * Wrap the native read so concurrent list loads share one in-flight request.
 * A delete reconciliation and a new Session from Chat can both reload the
 * list while the first read is still pending; without this they would issue
 * duplicate `get_all_session_runs` calls against the same table. The
 * in-flight slot is cleared on settle (success or failure) so a later load
 * always re-reads, and a rejection is reported as a bare `{ ok: false }` so
 * no native error text can reach the surface.
 */
export function singleFlightSessionRunRead(
  read: () => Promise<unknown>,
): () => Promise<SessionRunRead> {
  let inFlight: Promise<SessionRunRead> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const request: Promise<SessionRunRead> = read().then(
      value => ({ ok: true, value }),
      () => ({ ok: false }),
    );
    inFlight = request;
    void request.then(() => {
      if (inFlight === request) inFlight = null;
    });
    return request;
  };
}
