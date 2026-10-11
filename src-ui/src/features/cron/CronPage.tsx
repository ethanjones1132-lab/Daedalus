// Cron — scheduled jobs: a next-runs timeline, missed-job recovery, the job
// table with per-job operations, run history, and insights.
//
// Data and mutation coordination live in useCronJobs (the legacy CronView
// logic, ported verbatim); this file composes the surface.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Plus, RotateCw } from 'lucide-react';
import {
  AlertLine,
  Button,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  StatusLine,
} from '../../design';
import { CronHistoryPanel } from './CronHistoryPanel';
import { CronInsights } from './CronInsights';
import { AddJobDialog, EditJobDialog } from './CronJobDialogs';
import { CronJobHeader, CronJobRow } from './CronJobRow';
import { CronMissedJobs } from './CronMissedJobs';
import { CronTimeline } from './CronTimeline';
import { detectJobType, type CronJob, type CronRun } from './cron-model';
import { useCronInsights } from './useCronInsights';
import { useCronJobs } from './useCronJobs';
import { useRunHistory } from './useRunHistory';

/** The newest run we have actually read for each job (history beats nothing). */
function latestOutcomes(runs: CronRun[]): Record<string, string> {
  const newest: Record<string, CronRun> = {};
  for (const run of runs) {
    const seen = newest[run.cron_id];
    if (!seen || run.started_at > seen.started_at) newest[run.cron_id] = run;
  }
  return Object.fromEntries(Object.entries(newest).map(([id, run]) => [id, run.status]));
}

export default function CronPage() {
  const cron = useCronJobs();
  const {
    jobs,
    inFlightIds,
    pendingMissed,
    error,
    loading,
    hasLoaded,
    refreshing,
    showAddForm,
    creating,
    createError,
    operations,
    missedOperation,
    hasMutation,
    fetchJobs,
  } = cron;
  const insights = useCronInsights(jobs);
  const history = useRunHistory();
  const [editing, setEditing] = useState<CronJob | null>(null);
  const [historyJobId, setHistoryJobId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const historyJob = historyJobId ? jobs.find((job) => job.id === historyJobId) ?? null : null;

  const toggleHistory = useCallback((job: CronJob) => {
    if (historyJobId === job.id) {
      setHistoryJobId(null);
      return;
    }
    setHistoryJobId(job.id);
    void history.fetchRuns(job.id);
  }, [history, historyJobId]);

  const jumpToJob = useCallback((jobId: string) => {
    const row = listRef.current?.querySelector<HTMLElement>(`#cron-job-${CSS.escape(jobId)}`);
    row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    row?.focus({ preventScroll: true });
  }, []);

  const outcomes = useMemo(() => {
    const runs = [...insights.insightRuns, ...Object.values(history.byJob).flatMap((h) => h.runs)];
    return latestOutcomes(runs);
  }, [history.byJob, insights.insightRuns]);

  const enabledCount = jobs.filter((j) => j.enabled).length;
  const learningCount = jobs.filter((j) => detectJobType(j) === 'learning').length;
  const reviewCount = jobs.filter((j) => detectJobType(j) === 'review').length;
  const showHistory = historyJob !== null;

  return (
    <Page wide>
      <PageHeader
        eyebrow="Automate"
        title="Cron"
        description="Cron jobs hand a prompt to an Agent on a schedule and record every run. Missed runs wait here for you to trigger or dismiss them."
        actions={
          <>
            <Button
              variant="ghost"
              icon={<RotateCw />}
              aria-label="Refresh jobs"
              onClick={() => void fetchJobs()}
              disabled={refreshing || hasMutation()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            {jobs.length > 0 && (
              <Button
                variant="secondary"
                icon={<BarChart3 />}
                busy={insights.insightsLoading}
                aria-pressed={insights.insightsOpen}
                onClick={() => void insights.toggleInsights()}
              >
                {insights.insightsOpen ? 'Hide Insights' : 'Show Insights'}
              </Button>
            )}
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={cron.handleToggleAddForm}
              disabled={creating}
              aria-haspopup="dialog"
            >
              New job
            </Button>
          </>
        }
      />

      {refreshing && !loading && (
        <StatusLine label="Cron jobs loading" className="mb-3">
          Refreshing cron jobs…
        </StatusLine>
      )}
      {error && (
        <AlertLine
          label="Cron jobs loading"
          className="mb-4"
          onRetry={() => void fetchJobs()}
          retryDisabled={refreshing || hasMutation()}
        >
          {error}
        </AlertLine>
      )}

      <CronMissedJobs
        missed={pendingMissed}
        operation={missedOperation}
        onTrigger={cron.handleTriggerMissed}
        onDismiss={cron.handleDismissMissed}
        onDismissAll={cron.handleDismissAllMissed}
        onRetry={cron.handleRetryMissed}
      />

      {hasLoaded && jobs.length > 0 && <CronTimeline jobs={jobs} inFlightIds={inFlightIds} onSelect={jumpToJob} />}

      <div className={showHistory ? 'grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]' : undefined}>
        <Panel flush aria-label="Cron jobs" className="@container min-w-0">
          {loading ? (
            <div className="space-y-3 p-4">
              <StatusLine>Loading cron jobs…</StatusLine>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-[13px] font-semibold text-ink">Cron Jobs</h2>
                  <span className="font-mono text-[11px] text-ink-3 tabular">{jobs.length}</span>
                </div>
                {jobs.length > 0 && (
                  <span className="font-mono text-[11px] text-ink-3">
                    {enabledCount} enabled · {learningCount} learning · {reviewCount} review
                  </span>
                )}
              </div>
              {jobs.length === 0 ? (
                hasLoaded && !error ? (
                  <EmptyState
                    title="No cron jobs configured"
                    description="Use New job to have an Agent run a prompt on a schedule."
                  />
                ) : null
              ) : (
                <>
                  <CronJobHeader />
                  <ul ref={listRef} className="divide-y divide-line">
                    {jobs.map((job) => (
                      <CronJobRow
                        key={job.id}
                        job={job}
                        now={now}
                        isInFlight={inFlightIds.has(job.id)}
                        isHistoryOpen={historyJobId === job.id}
                        lastOutcome={outcomes[job.id]}
                        operation={operations[job.id]}
                        onToggle={cron.handleToggle}
                        onRun={cron.handleRun}
                        onEdit={setEditing}
                        onDelete={cron.handleDelete}
                        onRetry={cron.handleRetry}
                        onToggleHistory={toggleHistory}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </Panel>

        {historyJob && (
          <CronHistoryPanel
            job={historyJob}
            history={history.stateFor(historyJob.id)}
            onRetry={() => void history.fetchRuns(historyJob.id)}
            onClose={() => setHistoryJobId(null)}
          />
        )}
      </div>

      {insights.insightsOpen && (
        <CronInsights
          className="mt-6"
          jobs={jobs}
          pendingMissedCount={pendingMissed.length}
          runs={insights.insightRuns}
          loading={insights.insightsLoading}
          stale={insights.insightsStale}
          coverage={insights.insightsCoverage}
          onRetry={() => void insights.loadInsights()}
        />
      )}

      {showAddForm && (
        <AddJobDialog
          onCreate={cron.handleCreate}
          onCancel={cron.handleCancelAdd}
          creating={creating}
          createError={createError}
        />
      )}
      {editing && (
        <EditJobDialog
          job={editing}
          onClose={() => setEditing(null)}
          onSave={() => {
            void fetchJobs();
          }}
        />
      )}
    </Page>
  );
}
