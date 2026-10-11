import type { AgentProjection } from '../../domain/agent-lifecycle-state';

export type { AgentProjection };

export interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

export interface AgentDraft {
  name: string;
  model: string;
  description: string;
  system_prompt: string;
}

export const EMPTY_DRAFT: AgentDraft = { name: '', model: '', description: '', system_prompt: '' };

export type LifecycleOperationPhase = 'writing' | 'reconciling' | 'write-failed' | 'read-failed';

export interface LifecycleOperation {
  slug: string;
  action: 'activate' | 'deactivate';
  phase: LifecycleOperationPhase;
  expectedSourceHash?: string;
}

export interface LifecycleMutationResponse {
  success: boolean;
  code?: string;
  projection?: AgentProjection;
}

/** The Bun server hosts the Agent lifecycle HTTP surface. */
export const BUN_URL = 'http://127.0.0.1:19877';
