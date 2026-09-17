import type { BackendSession } from './types';

interface SessionListState {
  sessions: BackendSession[] | null;
  loading: boolean;
  error: boolean;
}
type SessionListAction =
  | { type: 'pending' }
  | { type: 'failure' }
  | { type: 'success'; sessions: BackendSession[] };

export const initialSessionListState: SessionListState = { sessions: null, loading: true, error: false };

// Retrieval is serialized by the view. Failure cannot establish an empty list
// or discard the known snapshot; a retry stays stale until it succeeds.
export function reduceSessionListState(state: SessionListState, action: SessionListAction): SessionListState {
  switch (action.type) {
    case 'pending': return { ...state, loading: true };
    case 'failure': return { ...state, loading: false, error: true };
    case 'success': return { sessions: action.sessions, loading: false, error: false };
  }
}
