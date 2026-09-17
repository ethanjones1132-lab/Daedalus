export interface LifecycleAgent {
  id: string;
  slug: string;
  status: string;
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
