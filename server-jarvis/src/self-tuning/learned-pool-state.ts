import type { OrchestratorAgent } from "../orchestration/agent-pool";

/** In-memory learned adjustments applied across orchestrator turns. */
export interface LearnedPoolState {
  /** Per-agent capability deltas keyed by agent id. */
  capabilityDeltas: Map<string, Partial<Record<keyof OrchestratorAgent["capabilities"], number>>>;
  /** Fallback priority boost keyed by `${agentId}:${stage}:${taskType}`. */
  fallbackBoosts: Map<string, number>;
  /** Cron-produced capability deltas keyed by `${provider}:${model_id}`. */
  modelCapabilityDeltas: Map<string, Partial<Record<keyof OrchestratorAgent["capabilities"], number>>>;
  /** Cron-produced primary/fallback score delta keyed by model feedback key. */
  modelRoutingScoreDeltas: Map<string, number>;
  /** Empirical first-token watchdog budgets keyed by model feedback key. */
  modelFirstTokenTimeouts: Map<string, number>;
}

const globalState: LearnedPoolState = {
  capabilityDeltas: new Map(),
  fallbackBoosts: new Map(),
  modelCapabilityDeltas: new Map(),
  modelRoutingScoreDeltas: new Map(),
  modelFirstTokenTimeouts: new Map(),
};

export function getLearnedPoolState(): LearnedPoolState {
  return globalState;
}

export function modelFeedbackKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function clearInferenceFeedbackState(): void {
  globalState.modelCapabilityDeltas.clear();
  globalState.modelRoutingScoreDeltas.clear();
  globalState.modelFirstTokenTimeouts.clear();
}

export function resetLearnedPoolStateForTests(): void {
  globalState.capabilityDeltas.clear();
  globalState.fallbackBoosts.clear();
  clearInferenceFeedbackState();
}

export function fallbackBoostKey(agentId: string, stage: string, taskType: string): string {
  return `${agentId}:${stage}:${taskType}`;
}

export function modelRoutingScoreDelta(agent: OrchestratorAgent): number {
  return globalState.modelRoutingScoreDeltas.get(modelFeedbackKey(agent.provider, agent.model_id)) ?? 0;
}

export function empiricalFirstTokenTimeoutFor(modelId: string, provider?: string): number | undefined {
  if (provider) return globalState.modelFirstTokenTimeouts.get(modelFeedbackKey(provider, modelId));
  const matches = [...globalState.modelFirstTokenTimeouts.entries()]
    .filter(([key]) => key.endsWith(`:${modelId}`))
    .map(([, value]) => value);
  return matches.length > 0 ? Math.max(...matches) : undefined;
}

export function applyLearnedCapabilities(agent: OrchestratorAgent): OrchestratorAgent {
  const agentDeltas = globalState.capabilityDeltas.get(agent.id);
  const modelDeltas = globalState.modelCapabilityDeltas.get(modelFeedbackKey(agent.provider, agent.model_id));
  if (!agentDeltas && !modelDeltas) return agent;
  const caps = { ...agent.capabilities };
  for (const deltas of [agentDeltas, modelDeltas]) {
    for (const [key, delta] of Object.entries(deltas ?? {})) {
      const capability = key as keyof typeof caps;
      caps[capability] = Math.max(0, Math.min(1, caps[capability] + (delta ?? 0)));
    }
  }
  return { ...agent, capabilities: caps };
}
