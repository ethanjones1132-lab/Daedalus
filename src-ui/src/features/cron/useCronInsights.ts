// Insights sampling: the busiest jobs' recent runs, fetched one job at a time
// so a single failing history never hides the others (partial vs stale vs
// unavailable are distinguished — see cron-insights.ts).

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { aggregateInsights, selectInsightJobs } from '../../domain/cron-insights';
import type { CronJob, CronRun } from './cron-model';

export function useCronInsights(jobs: CronJob[]) {
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [insightRuns, setInsightRuns] = useState<CronRun[]>([]);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const insightsPending = useRef(false);
  const [insightsCoverage, setInsightsCoverage] = useState({ failedJobIds: [] as string[], selectedCount: 0 });
  const [insightsStale, setInsightsStale] = useState(false);
  const [hasAutoOpenedInsights, setHasAutoOpenedInsights] = useState(false);

  const loadInsights = useCallback(async () => {
    if (insightsPending.current) return;
    insightsPending.current = true;
    setInsightsLoading(true);
    try {
      const results: { jobId: string; runs: CronRun[] | null }[] = [];
      const topJobs = selectInsightJobs(jobs);
      for (const j of topJobs) {
        try {
          const rs: CronRun[] = await invoke('get_cron_runs', { cronId: j.id });
          results.push({ jobId: j.id, runs: rs });
        } catch {
          results.push({ jobId: j.id, runs: null });
        }
      }
      const sample = aggregateInsights(results);
      const allFailed = sample.selectedCount > 0 && sample.failedJobIds.length === sample.selectedCount;
      setInsightsCoverage({ failedJobIds: sample.failedJobIds, selectedCount: sample.selectedCount });
      // Retain the previous snapshot only when no history request succeeded.
      // Partial responses replace it rather than mixing fresh and stale runs.
      if (!allFailed) setInsightRuns(sample.runs);
      setInsightsStale(allFailed);
    } finally {
      insightsPending.current = false;
      setInsightsLoading(false);
    }
  }, [jobs]);

  const toggleInsights = useCallback(async () => {
    if (insightsOpen) {
      setInsightsOpen(false);
      return;
    }
    setInsightsOpen(true);
    await loadInsights();
  }, [insightsOpen, loadInsights]);

  useEffect(() => {
    if (!hasAutoOpenedInsights && jobs.length > 0) {
      setHasAutoOpenedInsights(true);
      setInsightsOpen(true);
      void loadInsights();
    }
  }, [hasAutoOpenedInsights, jobs.length, loadInsights]);

  return {
    insightsOpen,
    insightRuns,
    insightsLoading,
    insightsCoverage,
    insightsStale,
    loadInsights,
    toggleInsights,
  };
}
