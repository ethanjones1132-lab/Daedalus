import { Button, AlertLine, StatusLine } from '../../design';
import {
  formatWhen,
  missedOperationFailureText,
  missedOperationReadFailureText,
  missedOperationStatusText,
  type CronJob,
  type MissedOperation,
} from './cron-model';

/**
 * Missed-job recovery: scheduled runs that passed while Jarvis was closed.
 * The operator either triggers each one now or dismisses it to the next
 * scheduled interval; a job stays listed until a confirmed read-back drops it.
 */
export function CronMissedJobs({
  missed,
  operation,
  onTrigger,
  onDismiss,
  onDismissAll,
  onRetry,
}: {
  missed: CronJob[];
  operation: MissedOperation | null;
  onTrigger: (id: string) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
  onRetry: () => void;
}) {
  if (missed.length === 0) return null;
  const busy = operation !== null;

  return (
    <section className="mb-6" aria-label="Missed cron jobs">
      {operation && (
        operation.phase === 'write-failed' ? (
          <AlertLine
            label="Missed cron operation"
            className="mb-2"
            onRetry={onRetry}
            retryLabel={operation.kind === 'dismiss-all' ? 'Retry remaining missed dismissals' : 'Retry missed action'}
          >
            {missedOperationFailureText(operation)}
          </AlertLine>
        ) : operation.phase === 'read-failed' ? (
          <AlertLine label="Missed cron operation" className="mb-2" onRetry={onRetry} retryLabel="Retry missed list">
            {missedOperationReadFailureText()}
          </AlertLine>
        ) : (
          <StatusLine label="Missed cron operation" className="mb-2">
            {missedOperationStatusText(operation)}
          </StatusLine>
        )
      )}

      <AlertLine
        tone="warn"
        className="rounded-b-none"
        actions={
          <Button size="xs" variant="secondary" onClick={onDismissAll} disabled={busy}>
            Dismiss All
          </Button>
        }
      >
        <p className="font-medium">{missed.length} Missed Cron Job(s) Pending Action</p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          These scheduled runs passed while Jarvis was closed. Choose to execute them now, or dismiss to skip to their next
          scheduled interval.
        </p>
      </AlertLine>
      <ul className="divide-y divide-line overflow-hidden rounded-b-lg border border-t-0 border-warn/25 bg-surface">
        {missed.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-ink">{m.name}</div>
              <div className="mt-0.5 font-mono text-[11px] text-ink-3">
                <span className="text-ink-2">{m.schedule}</span> · was due {m.next_run ? formatWhen(m.next_run) : '—'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="xs" variant="ghost" aria-label={`Dismiss ${m.name}`} onClick={() => onDismiss(m.id)} disabled={busy}>
                Dismiss
              </Button>
              <Button size="xs" variant="primary" aria-label={`Trigger ${m.name}`} onClick={() => onTrigger(m.id)} disabled={busy}>
                Trigger Now
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
