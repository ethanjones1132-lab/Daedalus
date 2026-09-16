import { describe, expect, it } from 'vitest';
import { aggregateInsights, selectInsightJobs } from './cron-insights';

describe('cron insight sampling', () => {
  it('selects only the four most active jobs without mutating the list', () => {
    const jobs = [1, 5, 2, 4, 3].map(run_count => ({ id: String(run_count), run_count }));
    expect(selectInsightJobs(jobs).map(j => j.id)).toEqual(['5', '4', '3', '2']);
    expect(jobs.map(j => j.id)).toEqual(['1', '5', '2', '4', '3']);
  });

  it('caps each successful job at five runs and records rejected job coverage', () => {
    const result = aggregateInsights([
      { jobId: 'a', runs: [1, 2, 3, 4, 5, 6] },
      { jobId: 'b', runs: null },
      { jobId: 'c', runs: [7] },
    ]);
    expect(result).toEqual({ runs: [1, 2, 3, 4, 5, 7], failedJobIds: ['b'], selectedCount: 3 });
  });

  it('distinguishes successful empty results from rejected histories', () => {
    expect(aggregateInsights([{ jobId: 'a', runs: [] }])).toEqual({
      runs: [], failedJobIds: [], selectedCount: 1,
    });
    expect(aggregateInsights([{ jobId: 'a', runs: null }, { jobId: 'b', runs: null }])).toEqual({
      runs: [], failedJobIds: ['a', 'b'], selectedCount: 2,
    });
    expect(aggregateInsights([])).toEqual({ runs: [], failedJobIds: [], selectedCount: 0 });
  });
});
