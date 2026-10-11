export interface LifecycleAgent {
  id: string;
  slug: string;
  status: string;
  source_path?: string;
  name?: string;
  description?: string;
  version?: string;
  source_hash?: string;
  source_size_bytes?: number;
  active?: boolean;
  projection_version?: number;
  activated_at?: string | null;
  deactivated_at?: string | null;
}

interface DiscoveryState {
  agents: LifecycleAgent[] | null;
  loading: boolean;
  error: boolean;
}
type DiscoveryAction =
  | { type: 'pending' }
  | { type: 'failure' }
  | { type: 'success'; agents: LifecycleAgent[] };

export const initialDiscoveryState: DiscoveryState = { agents: null, loading: true, error: false };

// A failed scan cannot establish an empty Agents root or erase a known snapshot.
export function reduceDiscoveryState(state: DiscoveryState, action: DiscoveryAction): DiscoveryState {
  switch (action.type) {
    case 'pending': return { ...state, loading: true };
    case 'failure': return { ...state, loading: false, error: true };
    case 'success': return { agents: action.agents, loading: false, error: false };
  }
}
