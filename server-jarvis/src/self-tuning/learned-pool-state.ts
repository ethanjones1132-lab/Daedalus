import type { OrchestratorAgent } from "../orchestration/agent-pool";

/** In-memory learned adjustments applied across orchestrator turns. */
export interface LearnedPoolState {
  /** Per-agent capability deltas keyed by agent id. */
  capabilityDeltas: Map<string, Partial<Record<keyof OrchestratorAgent["capabilities"], number>>>;
  /**
   * Fallback priority boost keyed by `${agentId}:${stage}:${taskType}`.
   * Higher = prefer earlier in fallback chain.
   */
  fallbackBoosts: Map<string, number>;
}

const globalState: LearnedPoolState = {
  capabilityDeltas: new Map(),
  fallbackBoosts: new Map(),
};

export function getLearnedPoolState(): LearnedPoolState {
  return globalState;
}

export function resetLearnedPoolStateForTests(): void {
  globalState.capabilityDeltas.clear();
  globalState.fallbackBoosts.clear();
}

export function fallbackBoostKey(agentId: string, stage: string, taskType: string): string {
  return `${agentId}:${stage}:${taskType}`;
}

export function applyLearnedCapabilities(agent: OrchestratorAgent): OrchestratorAgent {
  const deltas = globalState.capabilityDeltas.get(agent.id);
  if (!deltas) return agent;
  const caps = { ...agent.capabilities };
  for (const [key, delta] of Object.entries(deltas)) {
    const k = key as keyof typeof caps;
    caps[k] = Math.max(0, Math.min(1, caps[k] + (delta ?? 0)));
  }
  return { ...agent, capabilities: caps };
}