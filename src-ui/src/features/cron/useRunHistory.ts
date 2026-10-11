// Per-job run history. State is keyed by job id and lives above the panel so a
// collapse/re-expand keeps the last loaded runs (labelled stale if the next
// read fails) and never starts a second request while one is pending.

import { invoke } from '@tauri-apps/api/core';
import { useCallback, useRef, useState } from 'react';
import type { CronRun } from './cron-model';

export interface RunHistoryState {
  runs: CronRun[];
  loading: boolean;
  loadError: boolean;
}

const EMPTY: RunHistoryState = { runs: [], loading: false, loadError: false };

export function useRunHistory() {
  const [byJob, setByJob] = useState<Record<string, RunHistoryState>>({});
  const pending = useRef(new Set<string>());

  const patch = useCallback((jobId: string, next: Partial<RunHistoryState>) => {
    setByJob((current) => ({ ...current, [jobId]: { ...(current[jobId] ?? EMPTY), ...next } }));
  }, []);

  const fetchRuns = useCallback(async (jobId: string) => {
    if (pending.current.has(jobId)) return;
    pending.current.add(jobId);
    patch(jobId, { loading: true });
    try {
      const runs = await invoke<CronRun[]>('get_cron_runs', { cronId: jobId });
      patch(jobId, { runs, loadError: false });
    } catch {
      patch(jobId, { loadError: true });
    } finally {
      pending.current.delete(jobId);
      patch(jobId, { loading: false });
    }
  }, [patch]);

  const stateFor = useCallback((jobId: string): RunHistoryState => byJob[jobId] ?? { ...EMPTY, loading: true }, [byJob]);

  return { byJob, stateFor, fetchRuns };
}
