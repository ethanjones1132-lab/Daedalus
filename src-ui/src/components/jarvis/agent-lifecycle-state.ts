import type { LifecycleAgent } from './agent-discovery-state';

export interface AgentProjection {
  slug: string;
  source_path: string;
  source_hash: string;
  projection_version: number;
  status: string;
  name?: string;
  description?: string;
  tools?: string[];
  version_tag?: string;
  source_size_bytes?: number;
  validation_errors?: string;
  active: boolean;
  activated_at?: string | null;
  deactivated_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type EffectiveLifecycleState = 'active' | 'inactive' | 'stale' | 'invalid' | 'unavailable';

export function effectiveLifecycleState(
  agent: LifecycleAgent | undefined,
  projection: AgentProjection | undefined,
): EffectiveLifecycleState {
  if (!agent) return 'unavailable';
  if (agent.status !== 'valid') return 'invalid';
  if (!agent.source_hash) return 'unavailable';
  if (!projection || !projection.active) return 'inactive';
  if (projection.source_hash !== agent.source_hash) return 'stale';
  return 'active';
}

export function canActivateLifecycle(agent: LifecycleAgent | undefined, _projection: AgentProjection | undefined): boolean {
  return Boolean(agent && agent.status === 'valid' && /^[a-f0-9]{64}$/i.test(agent.source_hash ?? ''));
}

export function canDeactivateLifecycle(_agent: LifecycleAgent | undefined, projection: AgentProjection | undefined): boolean {
  return projection?.active === true;
}
