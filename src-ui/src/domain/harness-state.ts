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
  conflict: { expectedRevision: number; currentRevision: number | null } | null;
}

export const initialHarnessState: HarnessState = {
  manifests: [], selected: null, dirty: { guides: null, sensors: null }, approvalNeeded: {}, liveRun: null, runHistory: [], conflict: null,
};

export type HarnessAction =
  | { type: 'manifests-loaded'; manifests: SavedHarnessManifest[] }
  | { type: 'manifest-selected'; saved: SavedHarnessManifest | null }
  | { type: 'guides-edited'; guides: Partial<HarnessManifest['guides']> }
  | { type: 'sensors-edited'; sensors: HarnessManifest['sensors'] }
  | { type: 'approval-needed'; sensorId: string; needed: boolean }
  | { type: 'manifest-saved'; saved: SavedHarnessManifest }
  | { type: 'revision-conflict'; expectedRevision: number; currentRevision?: number }
  | { type: 'run-updated'; run: LiveHarnessRun }
  | { type: 'run-finished'; run: HarnessRun }
  | { type: 'history-loaded'; runs: HarnessRun[] };

export function harnessReducer(state: HarnessState, action: HarnessAction): HarnessState {
  switch (action.type) {
    case 'manifests-loaded': return { ...state, manifests: [...action.manifests] };
    case 'manifest-selected': return { ...state, selected: action.saved, dirty: { guides: null, sensors: null }, conflict: null };
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
    case 'history-loaded': return { ...state, runHistory: orderRuns(action.runs) };
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
