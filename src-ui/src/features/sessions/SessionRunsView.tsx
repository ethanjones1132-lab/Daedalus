import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RotateCw } from 'lucide-react';
import { Spinner, cn } from '../../design';
import {
  decodeSessionRuns,
  singleFlightSessionRunRead,
  type SessionRunRead,
} from '../../domain/session-run-telemetry';
import type { SessionRunRecord } from '../../domain/types';
import { outcomeTone } from './outcome';

export const SESSION_RUNS_PENDING_TEXT = 'Reading recorded runs…';
export const SESSION_RUNS_EMPTY_TEXT = 'No runs recorded for this Session.';
export const SESSION_RUNS_UNAVAILABLE_TEXT = 'Could not read the recorded runs for this Session.';

/**
 * Every terminal run Native recorded for one Session, read through the
 * per-Session `get_session_runs` command. A failed or undecodable read is
 * `unavailable` — never an empty history — and every row names its durable
 * `run_id`.
 */
export default function SessionRunsView({ sessionId, className }: { sessionId: string; className?: string }) {
  const [read, setRead] = useState<SessionRunRead | null>(null);
  const [retry, setRetry] = useState(0);
  const reader = useRef<ReturnType<typeof singleFlightSessionRunRead> | null>(null);
  const readRuns =
    reader.current ??
    (reader.current = singleFlightSessionRunRead(() =>
      invoke<unknown>('get_session_runs', { sessionId, session_id: sessionId }),
    ));
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  useEffect(() => {
    void readRuns().then((next) => {
      if (mountedRef.current) setRead(next);
    });
  }, [readRuns, retry]);

  const onRetry = useCallback(() => setRetry((value) => value + 1), []);

  const runs: SessionRunRecord[] | null = !read || !read.ok ? null : decodeSessionRuns(read.value);
  const unavailable = read !== null && runs === null;

  return (
    <div data-testid="session-runs-view" className={cn('text-[11.5px] text-ink-2', className)}>
      <h3 className="sr-only">{`Session ${sessionId} recorded runs`}</h3>
      {read === null && (
        <span role="status" className="flex items-center gap-1.5 text-ink-3">
          <Spinner size={11} />
          {SESSION_RUNS_PENDING_TEXT}
        </span>
      )}
      {unavailable && (
        <span role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-warn">
          {SESSION_RUNS_UNAVAILABLE_TEXT}{' '}
          <button
            type="button"
            onClick={onRetry}
            aria-label="Retry recorded runs"
            className="inline-flex items-center gap-1 rounded-[4px] border border-warn/30 px-1.5 py-px text-[11px] hover:bg-warn-wash"
          >
            <RotateCw aria-hidden="true" className="size-3" />
            Retry recorded runs
          </button>
        </span>
      )}
      {runs !== null && runs.length === 0 && <span className="text-ink-3">{SESSION_RUNS_EMPTY_TEXT}</span>}
      {runs !== null && runs.length > 0 && (
        <ol className="relative ml-1 space-y-2 border-l border-line pl-3.5">
          {runs.map((run, index) => (
            <li key={run.run_id} className="relative leading-snug">
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -left-[18px] top-[5px] size-[7px] rounded-full border border-canvas',
                  index === 0 ? 'bg-accent' : 'bg-ink-4',
                )}
              />
              <span className={cn('font-medium', outcomeTone(run.outcome))}>{run.outcome}</span>
              {run.selected_model && <span className="text-ink-3"> ({run.selected_model})</span>}
              <span className="font-mono text-[10.5px] text-ink-3"> · run {run.run_id}</span>
              <span className="block font-mono text-[10.5px] text-ink-4">
                {' '}
                · {run.token_count} tokens · {run.tool_count} tools
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
