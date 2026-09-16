// Bound native history sampling without changing the job list or returned runs.
export function selectInsightJobs<T extends { run_count: number }>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => b.run_count - a.run_count).slice(0, 4);
}

export function aggregateInsights<T>(results: { jobId: string; runs: T[] | null }[]) {
  const runs: T[] = [];
  const failedJobIds: string[] = [];
  for (const result of results) {
    if (result.runs === null) failedJobIds.push(result.jobId);
    else runs.push(...result.runs.slice(0, 5));
  }
  return { runs, failedJobIds, selectedCount: results.length };
}
