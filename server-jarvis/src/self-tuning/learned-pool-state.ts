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
  /** Stage-specific routing adjustments; these may rank fallback candidates. */
  stageModelRoutingScoreDeltas: Map<string, number>;
  /** Empirical first-token watchdog budgets keyed by model feedback key. */
  modelFirstTokenTimeouts: Map<string, number>;
  /**
   * Free-form recovery knobs held back via policy staging (not applied by
   * capability-delta / instruction A/B paths). Keys are stable policy ids.
   */
  recoveryPolicy: Map<string, number | string | boolean>;
}

/**
 * Serializable slice of learned-pool fields that routing / budget / recovery
 * policy staging is allowed to mutate. Capability deltas are intentionally
 * excluded — those remain the immediate low-risk path.
 */
export interface PolicySnapshot {
  modelRoutingScoreDeltas: Record<string, number>;
  stageModelRoutingScoreDeltas: Record<string, number>;
  fallbackBoosts: Record<string, number>;
  modelFirstTokenTimeouts: Record<string, number>;
  recovery: Record<string, number | string | boolean>;
}

const globalState: LearnedPoolState = {
  capabilityDeltas: new Map(),
  fallbackBoosts: new Map(),
  modelCapabilityDeltas: new Map(),
  modelRoutingScoreDeltas: new Map(),
  stageModelRoutingScoreDeltas: new Map(),
  modelFirstTokenTimeouts: new Map(),
  recoveryPolicy: new Map(),
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
  globalState.stageModelRoutingScoreDeltas.clear();
  globalState.modelFirstTokenTimeouts.clear();
}

export function resetLearnedPoolStateForTests(): void {
  globalState.capabilityDeltas.clear();
  globalState.fallbackBoosts.clear();
  globalState.recoveryPolicy.clear();
  clearInferenceFeedbackState();
}

/** Snapshot the staged-policy fields (routing / budget / recovery). */
export function snapshotStagedPolicyFields(state: LearnedPoolState = globalState): PolicySnapshot {
  return {
    modelRoutingScoreDeltas: Object.fromEntries(state.modelRoutingScoreDeltas),
    stageModelRoutingScoreDeltas: Object.fromEntries(state.stageModelRoutingScoreDeltas),
    fallbackBoosts: Object.fromEntries(state.fallbackBoosts),
    modelFirstTokenTimeouts: Object.fromEntries(state.modelFirstTokenTimeouts),
    recovery: Object.fromEntries(state.recoveryPolicy),
  };
}

/**
 * Replace staged-policy fields from a snapshot. Capability deltas and
 * modelCapabilityDeltas are left untouched (immediate low-risk path).
 */
export function applyPolicySnapshotToPool(
  snapshot: PolicySnapshot,
  state: LearnedPoolState = globalState,
): void {
  state.modelRoutingScoreDeltas = new Map(Object.entries(snapshot.modelRoutingScoreDeltas ?? {}));
  state.stageModelRoutingScoreDeltas = new Map(
    Object.entries(snapshot.stageModelRoutingScoreDeltas ?? {}),
  );
  state.fallbackBoosts = new Map(Object.entries(snapshot.fallbackBoosts ?? {}));
  state.modelFirstTokenTimeouts = new Map(
    Object.entries(snapshot.modelFirstTokenTimeouts ?? {}),
  );
  state.recoveryPolicy = new Map(Object.entries(snapshot.recovery ?? {}));
}

export function fallbackBoostKey(agentId: string, stage: string, taskType: string): string {
  return `${agentId}:${stage}:${taskType}`;
}

export function modelRoutingScoreDelta(agent: OrchestratorAgent): number {
  return globalState.modelRoutingScoreDeltas.get(modelFeedbackKey(agent.provider, agent.model_id)) ?? 0;
}

export function stageModelFeedbackKey(provider: string, modelId: string, stage: string): string {
  return `${provider}:${modelId}:${stage}`;
}

export function stageRoutingScoreDelta(agent: OrchestratorAgent, stage: string): number {
  return globalState.stageModelRoutingScoreDeltas.get(
    stageModelFeedbackKey(agent.provider, agent.model_id, stage),
  ) ?? 0;
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
