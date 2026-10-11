interface BindingState {
  bound: string[] | null;
  phase: 'loading' | 'updating' | 'ready' | 'failed';
  error: 'read' | 'write' | null;
}
type BindingAction =
  | { type: 'pending'; phase: 'loading' | 'updating' }
  | { type: 'failure'; error: 'read' | 'write' }
  | { type: 'success'; ids: string[] };

export const initialBindingState: BindingState = { bound: null, phase: 'loading', error: null };

// Only a retrieved snapshot establishes whether a channel is bound. A write
// remains pending until reconciliation; failed reads never manufacture emptiness.
export function reduceBindingState(state: BindingState, action: BindingAction): BindingState {
  switch (action.type) {
    case 'pending': return { ...state, phase: action.phase };
    case 'failure': return { ...state, phase: 'failed', error: action.error };
    case 'success': return { bound: action.ids, phase: 'ready', error: null };
  }
}
