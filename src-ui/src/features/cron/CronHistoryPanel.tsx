import { X } from 'lucide-react';
import {
  AlertLine,
  Badge,
  IconButton,
  Panel,
  PanelHeader,
  StatusDot,
  StatusLine,
  ToneText,
} from '../../design';
import { clip, formatDuration, formatWhen, statusTone, type CronJob } from './cron-model';
import type { RunHistoryState } from './useRunHistory';

/** Right-hand detail panel: the recorded runs of one cron job. */
export function CronHistoryPanel({
  job,
  history,
  onRetry,
  onClose,
}: {
  job: CronJob;
  history: RunHistoryState;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { runs, loading, loadError } = history;
  return (
    <Panel as="section" aria-label={`Run history for ${job.name}`} className="lg:sticky lg:top-0">
      <PanelHeader
        title="Run history"
        description={
          <>
            <span className="text-ink-2">{job.name}</span> · {job.run_count} recorded
          </>
        }
        actions={
          <IconButton aria-label="Close run history" size="xs" onClick={onClose}>
            <X />
          </IconButton>
        }
      />
      <div className="space-y-2.5">
        {loadError && (
          <AlertLine onRetry={onRetry} retryDisabled={loading}>
            {runs.length > 0
              ? 'Could not refresh run history. Showing previously loaded runs; they may be stale.'
              : 'Could not load run history.'}
          </AlertLine>
        )}
        {loading && <StatusLine>Loading runs…</StatusLine>}
        {!loading && !loadError && runs.length === 0 && <p className="py-4 text-center text-[12.5px] text-ink-3">No runs yet</p>}
        {(!loading || loadError) && runs.length > 0 && (
          <ol className="relative space-y-0 border-l border-line pl-4">
            {runs.map((run) => {
              const tone = statusTone(run.status);
              return (
                <li key={run.id} className="relative border-b border-line py-2.5 last:border-b-0">
                  <StatusDot tone={tone} className="absolute -left-[20px] top-[15px]" />
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tone={tone}>{run.status}</Badge>
                    {run.execution_evidence && (
                      <Badge tone={statusTone(run.execution_evidence.status)}>
                        {`evidence: ${run.execution_evidence.status}`}
                      </Badge>
                    )}
                    <span className="font-mono text-[11px] text-ink-3 tabular">{formatWhen(run.started_at)}</span>
                    {run.duration_ms > 0 && (
                      <span className="font-mono text-[11px] text-ink-2 tabular">{formatDuration(run.duration_ms)}</span>
                    )}
                  </div>
                  {run.execution_evidence?.acceptance_result && (
                    <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{clip(run.execution_evidence.acceptance_result)}</p>
                  )}
                  {run.output && (
                    <p className="mt-1 break-words font-mono text-[11px] leading-snug text-ink-3">{clip(run.output)}</p>
                  )}
                  {run.error && (
                    <p className="mt-1 break-words font-mono text-[11px] leading-snug">
                      <ToneText tone="error">{clip(run.error)}</ToneText>
                    </p>
                  )}
                  {run.execution_evidence?.error_code && (
                    <p className="mt-1 font-mono text-[11px]">
                      <ToneText tone="error">{`code: ${run.execution_evidence.error_code}`}</ToneText>
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Panel>
  );
}
