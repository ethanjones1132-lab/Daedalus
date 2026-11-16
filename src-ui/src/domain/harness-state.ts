import type { HarnessManifest, HarnessRun, SavedHarnessManifest } from '../features/workflows/harness-api';

export type HarnessSensorStatus = 'zero' | 'nonzero' | 'failed' | 'not_applicable' | 'unapproved';
export interface LiveHarnessSensor { sensor_id: string; status: HarnessSensorStatus; counter: number | null; exit_code?: number | null; reason?: string }
export interface LiveHarnessRun { run_id: string; round: number; counter_vector: Record<string, number | null | 'not_applicable'>; sensors: LiveHarnessSensor[] }
export interface HarnessState {
  manifests: SavedHarnessManifest[];
  selected: SavedHarnessManifest | null;
  dirty: { guides: Partial<HarnessManifest['guides']> | null; sensors: HarnessManifest['sensors'] | null };
  approvalNeeded: Record<string, boolean>;
  liveRun: LiveHarnessRun | null;
  runHistory: HarnessRun[];
  historyStatus: 'idle' | 'loading' | 'loaded' | 'empty' | 'error';
  historyError: string | null;
  selectedHistoryRunId: string | null;
  selectedHistoryRun: HarnessRun | null;
  selectedHistoryRunStatus: 'idle' | 'loading' | 'loaded' | 'error';
  selectedHistoryRunError: string | null;
  conflict: { expectedRevision: number; currentRevision: number | null } | null;
}

export const initialHarnessState: HarnessState = {
  manifests: [], selected: null, dirty: { guides: null, sensors: null }, approvalNeeded: {}, liveRun: null, runHistory: [],
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

export function selectApprovalNeeded(state: HarnessState, sensorId: string): boolean {
  return state.approvalNeeded[sensorId] === true;
}

export function selectSensorGreen(sensor: LiveHarnessSensor | undefined): boolean {
  return sensor !== undefined && sensor.status === 'zero' && Number.isInteger(sensor.counter) && sensor.counter === 0 && sensor.exit_code === 0;
}

export function selectRunGreen(run: LiveHarnessRun | null): boolean {
  return run !== null && run.sensors.length > 0 && run.sensors.every(selectSensorGreen);
}
