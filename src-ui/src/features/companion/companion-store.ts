import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useSyncExternalStore } from 'react';
import type { CompanionState } from '../../domain/types';
import {
  AWARENESS_PENDING,
  AWARENESS_UNAVAILABLE,
  missedEventAwareness,
  summarizeCronAwareness,
  type AwarenessCronJob,
} from './cron-awareness';

/*
 * Companion signals: the companion's own state (`jarvis_get_companion`) and the
 * cron-awareness sentence (`list_cron_jobs` + `list_pending_missed_jobs`, plus
 * the `cron://missed-jobs` event). Both used to ride on whichever JarvisView
 * happened to be mounted; they now load wherever a consumer is mounted (the
 * rail dock, the Overview hero).
 *
 * One shared, ref-counted store: any number of consumers means one 60 s poll.
 * The store starts with its first subscriber and resets when the last leaves,
 * so a remount never shows a previous mount's observation as current.
 */

export const COMPANION_POLL_MS = 60_000;

export type CompanionLoad = 'pending' | 'ready' | 'unavailable';

export interface CompanionSignals {
  /** Last good companion observation (kept across failed refreshes). */
  companion: CompanionState | null;
  /** `pending` before the first read settles; `unavailable` when it failed with nothing retained. */
  companionLoad: CompanionLoad;
  /** True when the latest refresh failed and `companion` is a retained earlier observation. */
  companionStale: boolean;
  awareness: string;
}

const INITIAL: CompanionSignals = {
  companion: null,
  companionLoad: 'pending',
  companionStale: false,
  awareness: AWARENESS_PENDING,
};

export interface CompanionStore {
  getSnapshot: () => CompanionSignals;
  subscribe: (listener: () => void) => () => void;
  refresh: () => void;
}

export function createCompanionStore(): CompanionStore {
  let state: CompanionSignals = INITIAL;
  const listeners = new Set<() => void>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let unlisten: (() => void) | null = null;
  let disposed = true;
  // Newest-wins fencing, one counter per observation kind.
  let awarenessRead = 0;
  let companionRead = 0;

  const set = (patch: Partial<CompanionSignals>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  const refreshAwareness = async () => {
    const id = ++awarenessRead;
    try {
      const [jobs, missed] = await Promise.all([
        invoke<AwarenessCronJob[]>('list_cron_jobs'),
        invoke<unknown[]>('list_pending_missed_jobs'),
      ]);
      if (disposed || id !== awarenessRead) return;
      set({ awareness: summarizeCronAwareness(jobs, missed) });
    } catch {
      if (disposed || id !== awarenessRead) return;
      set({ awareness: AWARENESS_UNAVAILABLE });
    }
  };

  const refreshCompanion = async () => {
    const id = ++companionRead;
    try {
      const next = await invoke<CompanionState | null>('jarvis_get_companion');
      if (disposed || id !== companionRead) return;
      set({ companion: next ?? null, companionLoad: 'ready', companionStale: false });
    } catch {
      if (disposed || id !== companionRead) return;
      set(state.companion ? { companionStale: true } : { companionLoad: 'unavailable' });
    }
  };

  const refresh = () => {
    void refreshAwareness();
    void refreshCompanion();
  };

  const start = () => {
    disposed = false;
    refresh();
    interval = setInterval(refresh, COMPANION_POLL_MS);
    void listen<unknown[]>('cron://missed-jobs', (e) => {
      const count = Array.isArray(e.payload) ? e.payload.length : 0;
      if (count > 0) {
        // The event is newer than any read in flight: it wins.
        awarenessRead += 1;
        set({ awareness: missedEventAwareness(count) });
      } else {
        void refreshAwareness();
      }
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
  };

  const stop = () => {
    disposed = true;
    if (interval) clearInterval(interval);
    interval = null;
    unlisten?.();
    unlisten = null;
    state = INITIAL;
  };

  return {
    getSnapshot: () => state,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
}

const shared = createCompanionStore();

/** Subscribe to the shared companion signals. */
export function useCompanionSignals(): CompanionSignals & { refresh: () => void } {
  const snapshot = useSyncExternalStore(shared.subscribe, shared.getSnapshot, shared.getSnapshot);
  return { ...snapshot, refresh: shared.refresh };
}

/** Re-read awareness/companion whenever `key` changes (e.g. the user lands on the Cron page). */
export function useRefreshOn(active: boolean) {
  useEffect(() => {
    if (active) shared.refresh();
  }, [active]);
}
