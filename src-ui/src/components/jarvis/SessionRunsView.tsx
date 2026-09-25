import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  decodeSessionRuns,
  singleFlightSessionRunRead,
  type SessionRunRead,
} from './session-run-telemetry';
import type { SessionRunRecord } from './types';

export const SESSION_RUNS_PENDING_TEXT = 'Reading recorded runs…';
export const SESSION_RUNS_EMPTY_TEXT = 'No runs recorded for this Session.';
export const SESSION_RUNS_UNAVAILABLE_TEXT =
  'Could not read the recorded runs for this Session.';

/**
 * Every terminal run Native recorded for one Session.
 *
 * This view used to swallow its read (`.catch(() => setRuns([]))`) and had no
 * loading, empty, or error state, so a failed `get_session_runs` was
 * indistinguishable from a Session that never ran. It now decodes through the
 * canonical `session-run-telemetry` helpers — a failed or undecodable read is
 * `unavailable`, a confirmed empty read is empty — and renders the durable
 * `run_id` for every run.
 */
export default function SessionRunsView({ sessionId }: { sessionId: string }) {
  const [read, setRead] = useState<SessionRunRead | null>(null);
  const [retry, setRetry] = useState(0);
  const reader = useRef<ReturnType<typeof singleFlightSessionRunRead> | null>(null);
  const readRuns = reader.current
    ?? (reader.current = singleFlightSessionRunRead(
      () => invoke<unknown>('get_session_runs', { sessionId, session_id: sessionId }),
    ));
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => {
    void readRuns().then(next => {
      if (mountedRef.current) setRead(next);
    });
  }, [readRuns, retry]);

  const onRetry = useCallback(() => setRetry(value => value + 1), []);

  const runs: SessionRunRecord[] | null = !read || !read.ok
    ? null
    : decodeSessionRuns(read.value);
  const unavailable = read !== null && runs === null;

  return (
    <div data-testid="session-runs-view" className="mt-1 rounded-md border border-iron/30 px-2 py-1.5 text-[11px] font-mono text-bone-dim">
      <h3 className="sr-only">{`Session ${sessionId} recorded runs`}</h3>
      {read === null && <span role="status">{SESSION_RUNS_PENDING_TEXT}</span>}
      {unavailable && (
        <span role="alert" className="text-amber-200/90">
          {SESSION_RUNS_UNAVAILABLE_TEXT}{' '}
          <button type="button" onClick={onRetry} className="underline" aria-label="Retry recorded runs">
            Retry recorded runs
          </button>
        </span>
      )}
      {runs !== null && runs.length === 0 && <span>{SESSION_RUNS_EMPTY_TEXT}</span>}
      {runs !== null && runs.length > 0 && (
        <ul className="space-y-0.5">
          {runs.map(run => (
            <li key={run.run_id}>
              <span>{run.outcome}</span>
              {run.selected_model && <span className="text-bone-faint"> ({run.selected_model})</span>}
              <span className="text-bone-faint"> · run {run.run_id}</span>
              <span className="text-bone-faint"> · {run.token_count} tokens · {run.tool_count} tools</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
