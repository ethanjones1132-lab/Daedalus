import { BarChart3 } from 'lucide-react';
import { AlertLine, Badge, cn, Panel, PanelHeader, StatusLine } from '../../design';
import { detectJobType, formatDuration, type CronJob, type CronRun } from './cron-model';

interface Coverage {
  failedJobIds: string[];
  selectedCount: number;
}

/** A readout like the design `Stat`, but sized to hold either a number or a name. */
function Readout({
  label,
  value,
  sub,
  tone,
  text,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'ok' | 'accent';
  /** Render the value as a name (smaller, truncating) instead of a big number. */
  text?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-sunken px-3.5 py-3">
      <span className="d-label">{label}</span>
      <span
        className={cn(
          'd-display truncate leading-none text-ink',
          text ? 'text-[24px]' : 'tabular text-[30px]',
          tone === 'ok' && 'text-ok',
          tone === 'accent' && 'text-accent-hot',
        )}
      >
        {value}
      </span>
      <span className="truncate text-[11.5px] text-ink-3">{sub}</span>
    </div>
  );
}

function runBarTone(status: string) {
  if (status === 'success') return 'bg-ok';
  if (status === 'failed') return 'bg-err';
  return 'bg-warn';
}

export function CronInsights({
  jobs,
  pendingMissedCount,
  runs,
  loading,
  stale,
  coverage,
  onRetry,
  className,
}: {
  className?: string;
  jobs: CronJob[];
  pendingMissedCount: number;
  runs: CronRun[];
  loading: boolean;
  stale: boolean;
  coverage: Coverage;
  onRetry: () => void;
}) {
  const partial = coverage.failedJobIds.length > 0;
  const badge = loading
    ? 'syncing…'
    : stale
      ? runs.length > 0 ? `${runs.length} stale samples` : 'unavailable'
      : `${runs.length} samples${partial ? ' (partial)' : ''}`;

  const total = runs.length;
  const successful = runs.filter((r) => r.status === 'success').length;
  const successRate = total > 0 ? Math.round((successful / total) * 100) : null;
  const avgDuration = total > 0 ? Math.round(runs.reduce((acc, r) => acc + r.duration_ms, 0) / total) : null;
  const mostActive = jobs.length > 0 ? jobs.reduce((a, b) => (b.run_count > a.run_count ? b : a)).name : '—';
  const learningEnabled = jobs.filter((j) => j.enabled && detectJobType(j) === 'learning').length;
  const reviewEnabled = jobs.filter((j) => j.enabled && detectJobType(j) === 'review').length;
  const recommendation = pendingMissedCount > 0
    ? `${pendingMissedCount} missed cron job${pendingMissedCount === 1 ? '' : 's'} need review to keep your loop tight.`
    : learningEnabled > reviewEnabled + 1
      ? 'You have more learning jobs than review jobs — add a review pass to turn research into durable insights.'
      : reviewEnabled > learningEnabled + 1
        ? 'Reflection is strong — add another learning cron to feed the review loop with fresh signal.'
        : 'Learning and review routines are balanced — your self-improvement loop looks healthy.';

  return (
    <Panel className={className} aria-label="Cron insights">
      <PanelHeader
        icon={<BarChart3 />}
        title="Insights"
        description="Live execution quality, run history, and balance recommendations for your automation loop."
        actions={<Badge tone="info">{badge}</Badge>}
      />

      {partial && (
        <AlertLine className="mb-3" onRetry={onRetry} retryDisabled={loading}>
          {stale ? 'Could not load insights.' : 'Partial insights.'}
          {' '}Run history unavailable for {coverage.failedJobIds.length} of {coverage.selectedCount} selected jobs.
          {' '}{stale && runs.length > 0
            ? 'Showing previously loaded samples; they may be stale.'
            : !stale ? 'Statistics cover only the available subset.' : ''}
        </AlertLine>
      )}

      {loading ? (
        <StatusLine>Loading premium cron insights from recent run history…</StatusLine>
      ) : stale && runs.length === 0 ? null : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Readout
              label="Success Rate"
              value={successRate === null ? '—' : `${successRate}%`}
              sub={`${successful} of ${total} sampled runs`}
              tone={successRate !== null && successRate >= 90 ? 'ok' : undefined}
            />
            <Readout
              label="Avg Duration"
              value={avgDuration === null ? '—' : formatDuration(avgDuration)}
              sub="Recent execution latency"
            />
            <Readout label="Analysed Samples" value={String(total)} sub="Top 4 jobs, 5 recent runs each" />
            <Readout label="Most Active" value={mostActive} sub="Highest run-count automation" text />
          </div>

          <div className={cn('grid gap-3', !partial && 'lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]')}>
          <div className="rounded-lg border border-line bg-sunken p-3">
            <div className="d-label mb-2">Recent Run History</div>
            {total === 0 ? (
              <p className="text-[12.5px] text-ink-3">
                {partial
                  ? 'No runs in the available subset; other selected histories could not be loaded.'
                  : 'No historical runs found yet — let a cron execute and this panel will start charting the loop.'}
              </p>
            ) : (
              <div className="flex h-12 items-end gap-1" role="img" aria-label={`${Math.min(total, 16)} most recent sampled runs by duration`}>
                {runs.slice(0, 16).map((run) => (
                  <div
                    key={run.id}
                    className={cn('flex-1 rounded-t-[3px] opacity-80 transition-opacity hover:opacity-100', runBarTone(run.status))}
                    style={{ height: `${Math.max(14, Math.min(100, (run.duration_ms || 50) / 6))}%` }}
                    title={`${run.status} • ${formatDuration(run.duration_ms)}`}
                  />
                ))}
              </div>
            )}
          </div>

          {!partial && (
            <div className="rounded-lg border border-accent-line bg-accent-wash px-3.5 py-3">
              <span className="d-label text-accent">Recommendation</span>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{recommendation}</p>
            </div>
          )}
          </div>
        </div>
      )}
    </Panel>
  );
}
