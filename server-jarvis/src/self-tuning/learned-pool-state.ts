import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * Request-scoped policy overlay (canary arm). Score/timeout readers prefer
 * overlay keys when present so a canary turn can use a staged snapshot without
 * permanently mutating the global production maps.
 */
const policyOverlayAls = new AsyncLocalStorage<PolicySnapshot>();

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

function mergeNumberMap(
  target: Map<string, number>,
  next: Record<string, number> | undefined,
  previous?: Record<string, number>,
): void {
  // Drop keys that were exclusive to the previous snapshot (rollback of
  // canary-only keys) without wiping concurrent learning outside either snap.
  if (previous) {
    for (const key of Object.keys(previous)) {
      if (!(next && Object.prototype.hasOwnProperty.call(next, key))) {
        target.delete(key);
      }
    }
  }
  for (const [key, value] of Object.entries(next ?? {})) {
    target.set(key, value);
  }
}

function mergeRecoveryMap(
  target: Map<string, number | string | boolean>,
  next: Record<string, number | string | boolean> | undefined,
  previous?: Record<string, number | string | boolean>,
): void {
  if (previous) {
    for (const key of Object.keys(previous)) {
      if (!(next && Object.prototype.hasOwnProperty.call(next, key))) {
        target.delete(key);
      }
    }
  }
  for (const [key, value] of Object.entries(next ?? {})) {
    target.set(key, value);
  }
}

/**
 * Merge staged-policy fields from a snapshot into the live pool.
 *
 * Keys present in `snapshot` are written. Keys absent from the snapshot are
 * left alone so concurrent inference-feedback / heuristic learning is not
 * wiped on promote. When `previous` is supplied (promote/rollback), keys that
 * existed only on the outgoing snapshot are removed so canary-only keys do not
 * linger after rollback.
 *
 * Capability deltas and modelCapabilityDeltas are never touched.
 */
export function applyPolicySnapshotToPool(
  snapshot: PolicySnapshot,
  state: LearnedPoolState = globalState,
  options: { previous?: PolicySnapshot } = {},
): void {
  const prev = options.previous;
  mergeNumberMap(
    state.modelRoutingScoreDeltas,
    snapshot.modelRoutingScoreDeltas,
    prev?.modelRoutingScoreDeltas,
  );
  mergeNumberMap(
    state.stageModelRoutingScoreDeltas,
    snapshot.stageModelRoutingScoreDeltas,
    prev?.stageModelRoutingScoreDeltas,
  );
  mergeNumberMap(state.fallbackBoosts, snapshot.fallbackBoosts, prev?.fallbackBoosts);
  mergeNumberMap(
    state.modelFirstTokenTimeouts,
    snapshot.modelFirstTokenTimeouts,
    prev?.modelFirstTokenTimeouts,
  );
  mergeRecoveryMap(state.recoveryPolicy, snapshot.recovery, prev?.recovery);
}

/**
 * Run `fn` with a request-scoped policy overlay. Overlay keys win for score
 * and timeout reads; global maps are not mutated. Nested calls restore the
 * prior overlay on exit.
 */
export function runWithPolicyOverlay<T>(snapshot: PolicySnapshot | null | undefined, fn: () => T): T {
  if (!snapshot) return fn();
  return policyOverlayAls.run(snapshot, fn);
}

function overlayNumber(
  field: keyof Pick<
    PolicySnapshot,
    | "modelRoutingScoreDeltas"
    | "stageModelRoutingScoreDeltas"
    | "fallbackBoosts"
    | "modelFirstTokenTimeouts"
  >,
  key: string,
): number | undefined {
  const overlay = policyOverlayAls.getStore();
  if (!overlay) return undefined;
  const map = overlay[field];
  if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  return map[key];
}

export function fallbackBoostKey(agentId: string, stage: string, taskType: string): string {
  return `${agentId}:${stage}:${taskType}`;
}

/** Fallback boost with request-scoped canary overlay support. */
export function fallbackBoostFor(agentId: string, stage: string, taskType: string): number {
  const key = fallbackBoostKey(agentId, stage, taskType);
  const overlay = overlayNumber("fallbackBoosts", key);
  if (overlay !== undefined) return overlay;
  return globalState.fallbackBoosts.get(key) ?? 0;
}

export function modelRoutingScoreDelta(agent: OrchestratorAgent): number {
  const key = modelFeedbackKey(agent.provider, agent.model_id);
  const overlay = overlayNumber("modelRoutingScoreDeltas", key);
  if (overlay !== undefined) return overlay;
  return globalState.modelRoutingScoreDeltas.get(key) ?? 0;
}

export function stageModelFeedbackKey(provider: string, modelId: string, stage: string): string {
  return `${provider}:${modelId}:${stage}`;
}

export function stageRoutingScoreDelta(agent: OrchestratorAgent, stage: string): number {
  const key = stageModelFeedbackKey(agent.provider, agent.model_id, stage);
  const overlay = overlayNumber("stageModelRoutingScoreDeltas", key);
  if (overlay !== undefined) return overlay;
  return globalState.stageModelRoutingScoreDeltas.get(key) ?? 0;
}

export function empiricalFirstTokenTimeoutFor(modelId: string, provider?: string): number | undefined {
  const overlay = policyOverlayAls.getStore();
  if (overlay?.modelFirstTokenTimeouts) {
    if (provider) {
      const key = modelFeedbackKey(provider, modelId);
      if (Object.prototype.hasOwnProperty.call(overlay.modelFirstTokenTimeouts, key)) {
        return overlay.modelFirstTokenTimeouts[key];
      }
    } else {
      const matches = Object.entries(overlay.modelFirstTokenTimeouts)
        .filter(([key]) => key.endsWith(`:${modelId}`))
        .map(([, value]) => value);
      if (matches.length > 0) return Math.max(...matches);
    }
  }
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
