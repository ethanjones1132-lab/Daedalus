import type { HarnessManifest, HarnessRun, SavedHarnessManifest } from '../features/workflows/harness-api';

export type HarnessSensorStatus = 'zero' | 'nonzero' | 'failed' | 'not_applicable' | 'unapproved';
export interface LiveHarnessSensor { sensor_id: string; status: HarnessSensorStatus; counter: number | null; exit_code?: number | null; reason?: string }
export interface LiveHarnessRun { run_id: string; round: number; counter_vector: Record<string, number | null | 'not_applicable'>; sensors: LiveHarnessSensor[] }
/** Panel state for a run started from the page. Every round and event is read back from GET /harness/runs/:id. */
export interface HarnessLiveState {
  phase: 'idle' | 'starting' | 'running' | 'settled';
  runId: string | null;
  /** Why the start was refused. `execution_unavailable` is the server's own answer, not a failed start. */
  startRefusal: 'execution_unavailable' | null;
  startError: string | null;
  detail: HarnessRun | null;
  detailStatus: 'idle' | 'loading' | 'loaded' | 'error';
  detailError: string | null;
  cancelStatus: 'idle' | 'cancelling' | 'cancelled' | 'not_running' | 'error';
  cancelError: string | null;
  stopReason: string | null;
}
export interface HarnessState {
  manifests: SavedHarnessManifest[];
  selected: SavedHarnessManifest | null;
  dirty: { guides: Partial<HarnessManifest['guides']> | null; sensors: HarnessManifest['sensors'] | null };
  approvalNeeded: Record<string, boolean>;
  liveRun: LiveHarnessRun | null;
  live: HarnessLiveState;
  runHistory: HarnessRun[];
  historyStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  historyError: string | null;
  selectedHistoryRunId: string | null;
  selectedHistoryRun: HarnessRun | null;
  selectedHistoryRunStatus: 'idle' | 'loading' | 'loaded' | 'error';
  selectedHistoryRunError: string | null;
  conflict: { expectedRevision: number; currentRevision: number | null } | null;
}

export const initialLiveState: HarnessLiveState = {
  phase: 'idle', runId: null, startRefusal: null, startError: null, detail: null,
  detailStatus: 'idle', detailError: null, cancelStatus: 'idle', cancelError: null, stopReason: null,
};

export const initialHarnessState: HarnessState = {
  manifests: [], selected: null, dirty: { guides: null, sensors: null }, approvalNeeded: {}, liveRun: null, live: initialLiveState, runHistory: [],
  historyStatus: 'idle', historyError: null, selectedHistoryRunId: null, selectedHistoryRun: null,
  selectedHistoryRunStatus: 'idle', selectedHistoryRunError: null, conflict: null,
};

export type HarnessAction =
  | { type: 'manifests-loaded'; manifests: SavedHarnessManifest[] }
  | { type: 'manifest-selected'; saved: SavedHarnessManifest | null }
  | { type: 'manifest-refreshed'; saved: SavedHarnessManifest }
  | { type: 'guides-edited'; guides: Partial<HarnessManifest['guides']> }
  | { type: 'sensors-edited'; sensors: HarnessManifest['sensors'] }
  | { type: 'approval-needed'; sensorId: string; needed: boolean }
  | { type: 'manifest-saved'; saved: SavedHarnessManifest }
  | { type: 'revision-conflict'; expectedRevision: number; currentRevision?: number }
  | { type: 'run-updated'; run: LiveHarnessRun }
  | { type: 'run-finished'; run: HarnessRun }
  | { type: 'live-starting' }
  | { type: 'live-start-refused' }
  | { type: 'live-start-failed'; message: string }
  | { type: 'live-started'; runId: string }
  | { type: 'live-read-loading'; runId: string }
  | { type: 'live-loaded'; run: HarnessRun }
  | { type: 'live-read-failed'; runId: string; message: string }
  | { type: 'live-cancelling' }
  | { type: 'live-cancelled'; runId: string; stopReason: string }
  | { type: 'live-not-running' }
  | { type: 'live-cancel-failed'; message: string }
  | { type: 'live-reset' }
  | { type: 'history-loading' }
  | { type: 'history-loaded'; runs: HarnessRun[] }
  | { type: 'history-error'; message: string }
  | { type: 'history-reset' }
  | { type: 'history-run-selected'; id: string }
  | { type: 'history-run-loading'; id: string }
  | { type: 'history-run-loaded'; run: HarnessRun }
  | { type: 'history-run-error'; id: string; message: string };

export function harnessReducer(state: HarnessState, action: HarnessAction): HarnessState {
  switch (action.type) {
    case 'manifests-loaded': return { ...state, manifests: [...action.manifests] };
    case 'manifest-selected': return { ...state, selected: action.saved, dirty: { guides: null, sensors: null }, conflict: null };
    case 'manifest-refreshed': {
      // Re-read after a revision conflict: adopt the fresh copy so the next save
      // targets the new revision, but keep the operator's unsaved guide edits.
      const manifests = state.manifests.map(item => item.manifest.id === action.saved.manifest.id ? action.saved : item);
      return { ...state, manifests, selected: action.saved, conflict: null };
    }
    case 'guides-edited': return { ...state, dirty: { ...state.dirty, guides: { ...state.dirty.guides, ...action.guides } } };
    case 'sensors-edited': return { ...state, dirty: { ...state.dirty, sensors: action.sensors.map(sensor => ({ ...sensor, args: [...sensor.args] })) } };
    case 'approval-needed': return { ...state, approvalNeeded: { ...state.approvalNeeded, [action.sensorId]: action.needed } };
    case 'manifest-saved': {
      const manifests = [...state.manifests.filter(item => item.manifest.id !== action.saved.manifest.id), action.saved];
      return { ...state, manifests, selected: action.saved, dirty: { guides: null, sensors: null }, conflict: null };
    }
    case 'revision-conflict': return { ...state, conflict: { expectedRevision: action.expectedRevision, currentRevision: action.currentRevision ?? null } };
    case 'run-updated': return { ...state, liveRun: action.run };
    case 'run-finished': return { ...state, liveRun: null, runHistory: orderRuns([action.run, ...state.runHistory]) };
    // Starting a run replaces the panel's subject. Until the read comes back,
    // the panel knows only the id the start route returned.
    case 'live-starting': return { ...state, live: { ...initialLiveState, phase: 'starting' } };
    case 'live-start-refused': return { ...state, live: { ...initialLiveState, startRefusal: 'execution_unavailable' } };
    case 'live-start-failed': return { ...state, live: { ...initialLiveState, startError: action.message } };
    case 'live-started': return {
      ...state, live: {
        ...initialLiveState, phase: 'running', runId: action.runId, detailStatus: 'loading',
      },
    };
    case 'live-read-loading': {
      if (state.live.runId !== action.runId) return state;
      return { ...state, live: { ...state.live, detailStatus: 'loading', detailError: null } };
    }
    case 'live-loaded': {
      // A poll answer for a superseded run is stale, not evidence about this one.
      if (state.live.runId !== action.run.id) return state;
      const stopReason = stopReasonFromRun(action.run) ?? state.live.stopReason;
      // The run record's status stays "running" after the loop stops, so the
      // stopped event (or an accepted cancel) is the only settlement evidence.
      const settled = stopReason !== null || state.live.cancelStatus === 'cancelled';
      return {
        ...state, live: {
          ...state.live, detail: action.run, detailStatus: 'loaded', detailError: null,
          phase: settled ? 'settled' : 'running', stopReason,
        },
      };
    }
    case 'live-read-failed': {
      if (state.live.runId !== action.runId) return state;
      // A failed read shows no rounds or events rather than the last read's,
      // and never settles the run: the phase keeps polling while the page is open.
      return { ...state, live: { ...state.live, detail: null, detailStatus: 'error', detailError: action.message } };
    }
    case 'live-cancelling': return { ...state, live: { ...state.live, cancelStatus: 'cancelling', cancelError: null } };
    case 'live-cancelled': {
      if (state.live.runId !== action.runId) return state;
      return {
        ...state, live: {
          ...state.live, phase: 'settled', cancelStatus: 'cancelled', cancelError: null,
          stopReason: action.stopReason,
        },
      };
    }
    // The server said the run is not active on it. That says nothing about the
    // run's evidence, so the phase is left alone and the page re-reads the run.
    case 'live-not-running': return { ...state, live: { ...state.live, cancelStatus: 'not_running', cancelError: null } };
    case 'live-cancel-failed': return { ...state, live: { ...state.live, cancelStatus: 'error', cancelError: action.message } };
    case 'live-reset': return { ...state, live: initialLiveState };
    case 'history-loading': return {
      ...state, runHistory: [], historyStatus: 'loading', historyError: null,
      selectedHistoryRunId: null, selectedHistoryRun: null, selectedHistoryRunStatus: 'idle', selectedHistoryRunError: null,
    };
    case 'history-loaded': {
      const runs = orderRuns(action.runs);
      return {
        ...state, runHistory: runs, historyStatus: runs.length ? 'loaded' : 'empty', historyError: null,
        selectedHistoryRunId: null, selectedHistoryRun: null, selectedHistoryRunStatus: 'idle', selectedHistoryRunError: null,
      };
    }
    case 'history-error': return {
      ...state, runHistory: [], historyStatus: 'error', historyError: action.message,
      selectedHistoryRunId: null, selectedHistoryRun: null, selectedHistoryRunStatus: 'idle', selectedHistoryRunError: null,
    };
    case 'history-reset': return {
      ...state, runHistory: [], historyStatus: 'idle', historyError: null,
      selectedHistoryRunId: null, selectedHistoryRun: null, selectedHistoryRunStatus: 'idle', selectedHistoryRunError: null,
    };
    case 'history-run-selected': return {
      ...state, selectedHistoryRunId: action.id, selectedHistoryRun: null,
      selectedHistoryRunStatus: 'loading', selectedHistoryRunError: null,
    };
    case 'history-run-loading': {
      if (state.selectedHistoryRunId !== action.id) return state;
      return { ...state, selectedHistoryRun: null, selectedHistoryRunStatus: 'loading', selectedHistoryRunError: null };
    }
    case 'history-run-loaded': {
      if (state.selectedHistoryRunId !== action.run.id) return state;
      return { ...state, selectedHistoryRun: action.run, selectedHistoryRunStatus: 'loaded', selectedHistoryRunError: null };
    }
    case 'history-run-error': {
      if (state.selectedHistoryRunId !== action.id) return state;
      return { ...state, selectedHistoryRun: null, selectedHistoryRunStatus: 'error', selectedHistoryRunError: action.message };
    }
  }
}

export function orderRuns(runs: HarnessRun[]): HarnessRun[] {
  return [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

/**
 * The stop reason the run itself recorded, read from its `stopped` event. A run
 * row's `status` never leaves "running", so this is the only honest settlement
 * signal the GET route carries.
 */
export function stopReasonFromRun(run: HarnessRun): string | null {
  const stopped = [...run.events].reverse().find((event) => event.event_type === 'stopped');
  const payload = stopped?.payload;
  if (typeof payload === 'object' && payload !== null && 'stop_reason' in payload) {
    const reason = (payload as { stop_reason?: unknown }).stop_reason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return null;
}

export function selectApprovalNeeded(state: HarnessState, sensorId: string): boolean {
  return state.approvalNeeded[sensorId] === true;
}

export function selectSensorGreen(sensor: LiveHarnessSensor | undefined): boolean {
  return sensor !== undefined && sensor.status === 'zero' && Number.isInteger(sensor.counter) && sensor.counter === 0 && sensor.exit_code === 0;
}

export function selectRunGreen(run: LiveHarnessRun | null): boolean {
  return run !== null && run.sensors.length > 0 && run.sensors.every(selectSensorGreen);
}
