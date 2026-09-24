export interface RegistrySnapshotState<S> {
  snapshot: S | null;
  loading: boolean;
  error: boolean;
  requestId: number;
}

export interface ActionRegistryAlert {
  id: string;
  kind: string;
  severity: string;
  title: string;
  message: string;
  action_id?: string | null;
  count?: number | null;
  created_at: string;
}

export type RegistrySnapshotAction<S> =
  | { type: 'pending'; requestId: number }
  | { type: 'success'; requestId: number; snapshot: S }
  | { type: 'failure'; requestId: number }
  | { type: 'invalidate'; requestId: number };

export function initialRegistryState<S>(): RegistrySnapshotState<S> {
  return { snapshot: null, loading: true, error: false, requestId: 0 };
}

// A failed snapshot read cannot establish empty buckets or erase a known
// snapshot, and a response older than the latest issued request is ignored
// without ending that request's pending state.
export function reduceRegistryState<S>(
  state: RegistrySnapshotState<S>,
  action: RegistrySnapshotAction<S>,
): RegistrySnapshotState<S> {
  if (action.requestId < state.requestId) return state;
  switch (action.type) {
    case 'pending': return { ...state, loading: true, requestId: action.requestId };
    case 'invalidate': return { ...state, loading: false, error: false, requestId: action.requestId };
    case 'failure': return { ...state, loading: false, error: true };
    case 'success': return { snapshot: action.snapshot, loading: false, error: false, requestId: action.requestId };
  }
}

export function parseActionRegistryAlerts(value: unknown): ActionRegistryAlert[] {
  if (!Array.isArray(value)) throw new Error('Invalid Action Registry alerts');
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('Invalid Action Registry alert');
    const alert = item as Record<string, unknown>;
    if (
      typeof alert.id !== 'string' ||
      typeof alert.kind !== 'string' ||
      typeof alert.severity !== 'string' ||
      typeof alert.title !== 'string' ||
      typeof alert.message !== 'string' ||
      typeof alert.created_at !== 'string' ||
      !(alert.action_id === undefined || alert.action_id === null || typeof alert.action_id === 'string') ||
      !(alert.count === undefined || alert.count === null || (
        typeof alert.count === 'number' && Number.isInteger(alert.count) && alert.count >= 0
      ))
    ) {
      throw new Error('Invalid Action Registry alert');
    }
  }
  return value as ActionRegistryAlert[];
}
