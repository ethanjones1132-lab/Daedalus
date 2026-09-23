export interface RegistrySnapshotState<S> {
  snapshot: S | null;
  loading: boolean;
  error: boolean;
  requestId: number;
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
