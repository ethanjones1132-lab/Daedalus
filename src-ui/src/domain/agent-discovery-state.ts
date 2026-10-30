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

/**
 * What the discovery response could establish about the Agents root itself.
 * `unconfigured` is a settings statement (no root was ever chosen); the other
 * three are filesystem observations. A payload without a reason code (an older
 * server surface) stays `null`: unknown, never moulded into one of these.
 */
export type DiscoveryRootVerdict = 'ok' | 'unconfigured' | 'missing' | 'unreadable';

const ROOT_REASON_CODES: Record<string, DiscoveryRootVerdict> = {
  agents_root_ok: 'ok',
  agents_root_missing: 'missing',
  agents_root_unreadable: 'unreadable',
  agents_root_unconfigured: 'unconfigured',
};

interface DiscoveryState {
  agents: LifecycleAgent[] | null;
  loading: boolean;
  error: boolean;
  rootVerdict: DiscoveryRootVerdict | null;
  /** The resolved root; rendered only through the explicit path disclosure. */
  rootResolvedPath: string | null;
}
type DiscoveryAction =
  | { type: 'pending' }
  | { type: 'failure' }
  | {
      type: 'success';
      agents: LifecycleAgent[];
      rootVerdict?: DiscoveryRootVerdict | null;
      rootResolvedPath?: string | null;
    };

export const initialDiscoveryState: DiscoveryState = {
  agents: null,
  loading: true,
  error: false,
  rootVerdict: null,
  rootResolvedPath: null,
};

// A failed scan cannot establish an empty Agents root or erase a known snapshot:
// the agents, the error flag and the last root verdict all stay until a success
// replaces them.
export function reduceDiscoveryState(state: DiscoveryState, action: DiscoveryAction): DiscoveryState {
  switch (action.type) {
    case 'pending': return { ...state, loading: true };
    case 'failure': return { ...state, loading: false, error: true };
    case 'success': return {
      agents: action.agents,
      loading: false,
      error: false,
      rootVerdict: action.rootVerdict ?? null,
      rootResolvedPath: action.rootResolvedPath ?? null,
    };
  }
}

/** What GET /agents answered: the agent list plus, on newer surfaces, the root statement. */
export interface DiscoveryPayload {
  agents: LifecycleAgent[];
  rootVerdict: DiscoveryRootVerdict | null;
  rootResolvedPath: string | null;
}

/**
 * Accepts both server shapes: the historical bare array and the current
 * `{ agents, root_state, reason_code, resolved_path }` object. A reason code
 * is mapped through a fixed table so an unrecognised value can never dress
 * itself up as one of the four verdicts.
 */
export function parseDiscoveryPayload(data: unknown): DiscoveryPayload {
  if (Array.isArray(data)) {
    return { agents: data as LifecycleAgent[], rootVerdict: null, rootResolvedPath: null };
  }
  const record = (data ?? {}) as { agents?: unknown; reason_code?: unknown; resolved_path?: unknown };
  if (!Array.isArray(record.agents)) {
    throw new Error('agents response carries no agent list');
  }
  return {
    agents: record.agents as LifecycleAgent[],
    rootVerdict: typeof record.reason_code === 'string' ? ROOT_REASON_CODES[record.reason_code] ?? null : null,
    rootResolvedPath: typeof record.resolved_path === 'string' ? record.resolved_path : null,
  };
}
