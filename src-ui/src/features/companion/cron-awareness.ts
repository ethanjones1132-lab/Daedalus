/*
 * Cron awareness — the one-sentence summary of what the scheduler is up to,
 * shown by the companion dock and the Overview hero. Pure: no React, no Tauri.
 * The sentences are pinned by tests; reword them only with the tests.
 */

export interface AwarenessCronJob {
  id?: string;
  name?: string;
  prompt: string;
  enabled: boolean;
}

export const AWARENESS_PENDING = 'Loading cron awareness…';
export const AWARENESS_UNAVAILABLE = 'Cron awareness unavailable. Waiting for the next refresh.';

const SELF_IMPROVEMENT_MARKERS = [
  'autonomous learning session',
  'credibility_gate',
  'self-improvement review',
  'durable learnable insights',
];

export function isSelfImprovementCron(job: Pick<AwarenessCronJob, 'prompt'>): boolean {
  const prompt = (job.prompt ?? '').toLowerCase();
  return SELF_IMPROVEMENT_MARKERS.some((marker) => prompt.includes(marker));
}

export function buildCronAwarenessMessage({
  activeSelfImprovement,
  activeTotal,
  missedCount,
}: {
  activeSelfImprovement: number;
  activeTotal: number;
  missedCount: number;
}): string {
  if (missedCount > 0) {
    return `Reflecting on ${missedCount} missed self-improvement routine${missedCount === 1 ? '' : 's'}...`;
  }
  if (activeSelfImprovement > 0) {
    return `Tracking ${activeSelfImprovement} self-improvement cron${activeSelfImprovement === 1 ? '' : 's'}.`;
  }
  if (activeTotal > 0) {
    return `Monitoring ${activeTotal} active cron${activeTotal === 1 ? '' : 's'}.`;
  }
  return 'Ready for your next improvement cycle.';
}

/** Awareness sentence from one observation of the cron jobs + pending missed jobs. */
export function summarizeCronAwareness(jobs: AwarenessCronJob[], missed: unknown[]): string {
  const active = jobs.filter((job) => job.enabled);
  return buildCronAwarenessMessage({
    activeSelfImprovement: active.filter(isSelfImprovementCron).length,
    activeTotal: active.length,
    missedCount: missed.length,
  });
}

/** Awareness sentence when the `cron://missed-jobs` event reports `count` missed jobs. */
export function missedEventAwareness(count: number): string {
  return buildCronAwarenessMessage({ activeSelfImprovement: count, activeTotal: count, missedCount: count });
}
