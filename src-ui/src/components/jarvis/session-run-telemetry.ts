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

export type SessionRunRead =
  | { ok: true; value: unknown }
  | { ok: false };

export type SessionRunTelemetry =
  | { state: 'pending' }
  | { state: 'unavailable' }
  | { state: 'available'; runs: Record<string, SessionRunRecord> };

export type SessionOutcomeView =
  | { kind: 'pending' }
  | { kind: 'unavailable' }
  | { kind: 'not_recorded' }
  | { kind: 'recorded'; run: SessionRunRecord };

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
 * later rows are its older runs. Runs for Sessions that are not visible are
 * dropped, and the input array is never mutated.
 */
export function indexSessionRuns(
  runs: SessionRunRecord[],
  visibleSessionIds: Iterable<string>,
): Record<string, SessionRunRecord> {
  const visible = new Set(visibleSessionIds);
  const indexed: Record<string, SessionRunRecord> = {};
  for (const run of runs) {
    if (visible.has(run.session_id) && !indexed[run.session_id]) {
      indexed[run.session_id] = run;
    }
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
  const run = telemetry.runs[sessionId];
  return run ? { kind: 'recorded', run } : { kind: 'not_recorded' };
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
