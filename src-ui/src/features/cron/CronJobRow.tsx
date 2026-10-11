import { ChevronRight, Pencil, Play, Trash2 } from 'lucide-react';
import {
  AlertLine,
  Badge,
  cn,
  Chip,
  IconButton,
  Spinner,
  StatusDot,
  StatusLine,
  Switch,
  ToneText,
} from '../../design';
import type { CronOperation } from '../../domain/cron-operation-state';
import {
  JOB_TYPES,
  cronOperationFailureText,
  cronOperationReadFailureText,
  cronOperationStatusText,
  detectJobType,
  formatWhen,
  statusTone,
  type CronJob,
} from './cron-model';
import { describeSchedule } from './cron-schedule';

/** Shared column template so the header strip and every row line up. */
export const JOB_GRID = '@5xl:grid-cols-[44px_minmax(0,1fr)_190px_132px_112px_112px]';

export function CronJobHeader() {
  return (
    <div
      aria-hidden="true"
      className={cn('hidden gap-x-4 border-b border-line px-4 py-2 @5xl:grid', JOB_GRID)}
    >
      <span className="d-label">On</span>
      <span className="d-label">Job</span>
      <span className="d-label">Schedule</span>
      <span className="d-label">Last run</span>
      <span className="d-label">Next run</span>
      <span className="d-label text-right">Actions</span>
    </div>
  );
}

export function CronJobRow({
  job,
  now,
  isInFlight,
  isHistoryOpen,
  lastOutcome,
  operation,
  onToggle,
  onRun,
  onEdit,
  onDelete,
  onRetry,
  onToggleHistory,
}: {
  job: CronJob;
  now: number;
  isInFlight: boolean;
  isHistoryOpen: boolean;
  /** Status of the most recent run we have actually read, if any. */
  lastOutcome: string | undefined;
  operation?: CronOperation<CronJob>;
  onToggle: (job: CronJob) => void;
  onRun: (job: CronJob) => void;
  onEdit: (job: CronJob) => void;
  onDelete: (job: CronJob) => void;
  onRetry: (job: CronJob) => void;
  onToggleHistory: (job: CronJob) => void;
}) {
  const operationBlocked = operation !== undefined;
  const typeConfig = JOB_TYPES.find((t) => t.id === detectJobType(job));
  const described = describeSchedule(job.schedule);
  const nextAt = job.next_run ? new Date(job.next_run).getTime() : NaN;
  const overdue = job.enabled && !Number.isNaN(nextAt) && nextAt < now;
  const runBusy = (operation?.kind === 'run' && operation.phase === 'writing') || isInFlight;
  const outcomeTone = lastOutcome ? statusTone(lastOutcome) : 'muted';

  return (
    <li
      id={`cron-job-${job.id}`}
      tabIndex={-1}
      className={cn(
        'group px-4 py-3 outline-none transition-colors target:bg-accent-wash focus-visible:bg-accent-wash',
        isHistoryOpen && 'bg-raised',
        !job.enabled && 'bg-sunken/40',
      )}
    >
      <div className={cn('grid grid-cols-[44px_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1.5', JOB_GRID)}>
        <div className="pt-0.5">
          <Switch
            pressed
            checked={job.enabled}
            aria-label={`${job.enabled ? 'Disable' : 'Enable'} ${job.name}`}
            onChange={() => onToggle(job)}
            disabled={operationBlocked}
          />
        </div>

        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn('truncate text-[13.5px] font-medium', job.enabled ? 'text-ink' : 'text-ink-3')}>{job.name}</span>
            {isInFlight && (
              <Badge tone="accent" dot>
                Running
              </Badge>
            )}
            {!job.enabled && <Badge tone="warn">disabled</Badge>}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">{job.prompt}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip>{job.agent_id}</Chip>
            {typeConfig && typeConfig.id !== 'custom' && (
              <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
                <typeConfig.icon aria-hidden="true" className="size-3" />
                {typeConfig.label}
              </span>
            )}
          </div>
        </div>

        {/* actions: third track on narrow widths, sixth on wide */}
        <div className="flex items-center justify-end gap-0.5 @5xl:col-start-6 @5xl:row-start-1">
          <IconButton
            aria-label={`Run ${job.name}`}
            title={runBusy ? 'Running…' : 'Run now'}
            onClick={() => onRun(job)}
            disabled={operationBlocked || isInFlight || !job.enabled}
          >
            {runBusy ? <Spinner size={14} /> : <Play />}
          </IconButton>
          <IconButton aria-label={`Edit ${job.name}`} title="Edit" onClick={() => onEdit(job)} disabled={operationBlocked}>
            <Pencil />
          </IconButton>
          <IconButton
            aria-label={`Delete ${job.name}`}
            title="Delete"
            variant="danger"
            onClick={() => onDelete(job)}
            disabled={operationBlocked}
          >
            <Trash2 />
          </IconButton>
        </div>

        <div className="col-span-full col-start-2 flex flex-wrap items-start gap-x-6 gap-y-1.5 @5xl:contents">
          <div className="min-w-0 @5xl:col-start-3 @5xl:row-start-1">
            <code className="block truncate font-mono text-[12px] text-accent-hot">{job.schedule}</code>
            {described && <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{described}</span>}
          </div>

          <div className="min-w-0 text-[12px] @5xl:col-start-4 @5xl:row-start-1">
            <div className="tabular text-ink-2">{formatWhen(job.last_run, now)}</div>
            {lastOutcome && job.last_run && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px]">
                <StatusDot tone={outcomeTone} />
                <ToneText tone={outcomeTone}>{lastOutcome}</ToneText>
              </div>
            )}
            {job.run_count > 0 ? (
              <button
                type="button"
                aria-expanded={isHistoryOpen}
                onClick={() => onToggleHistory(job)}
                className="mt-1 inline-flex items-center gap-0.5 rounded font-mono text-[11px] text-ink-3 transition-colors hover:text-accent-hot focus-visible:text-accent-hot"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn('size-3 transition-transform duration-200', isHistoryOpen && 'rotate-90')}
                />
                {job.run_count} runs
              </button>
            ) : (
              <div className="mt-0.5 text-[11.5px] text-ink-4">no runs recorded</div>
            )}
          </div>

          <div className="min-w-0 text-[12px] @5xl:col-start-5 @5xl:row-start-1">
            {!job.enabled ? (
              <span className="text-ink-4">paused</span>
            ) : job.next_run ? (
              <span className={cn('tabular', overdue ? 'text-warn' : 'text-ink-2')} title={new Date(job.next_run).toLocaleString()}>
                {overdue ? `overdue ${formatWhen(job.next_run, now).replace(' ago', '')}` : formatWhen(job.next_run, now)}
              </span>
            ) : (
              <span className="text-ink-4">—</span>
            )}
          </div>
        </div>
      </div>

      {operation && (
        <div className="mt-2.5 pl-[60px]">
          {operation.phase === 'write-failed' ? (
            <AlertLine
              label="Cron job operation"
              onRetry={() => onRetry(job)}
              retryLabel={`Retry ${job.name}`}
            >
              {cronOperationFailureText(operation)}
            </AlertLine>
          ) : operation.phase === 'read-failed' ? (
            <AlertLine label="Cron job operation" onRetry={() => onRetry(job)} retryLabel={`Retry ${job.name}`}>
              {cronOperationReadFailureText(operation)}
            </AlertLine>
          ) : (
            <StatusLine label="Cron job operation">{cronOperationStatusText(operation)}</StatusLine>
          )}
        </div>
      )}
    </li>
  );
}
