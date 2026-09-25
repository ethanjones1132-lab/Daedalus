import { AsyncLocalStorage } from "node:async_hooks";
import type { OrchestratorAgent } from "../orchestration/agent-pool";
import {
  applyThetaPatchGlobally,
  BASELINE_THETA,
  runWithTheta,
  type ThetaPatch,
} from "../orchestration/orchestration-policy";

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
  /**
   * Deadline ledger for cron-produced values, keyed
   * `<field><NUL><key>` (see {@link recordInferenceFeedbackExpiry}).
   *
   * The four cron-managed maps above are seeded once per process and only
   * reloaded by the six-hourly refresh, so a producer that never runs would
   * otherwise leave one measurement steering routing and the first-token
   * watchdog forever. Freshness therefore travels with the value: a key
   * present in this ledger is honoured only while its report's `expires_at`
   * is still in the future. Promoted policy and session-learned values carry no
   * ledger entry and never expire.
   */
  inferenceFeedbackExpiries: Map<string, number>;
}

/** Cron-produced maps whose values are governed by a report deadline. */
export type FeedbackManagedField =
  | "modelCapabilityDeltas"
  | "modelRoutingScoreDeltas"
  | "stageModelRoutingScoreDeltas"
  | "modelFirstTokenTimeouts";

/** Namespaces ledger keys; NUL cannot appear in a provider/model/stage key. */
const FEEDBACK_KEY_SEPARATOR = "\u0000";

let learnedPoolClock: () => number = () => Date.now();

/**
 * Test-only clock override so freshness can be exercised without sleeping.
 * `null` restores wall time. Production never calls this.
 */
export function setLearnedPoolClockForTests(next: (() => number) | null): void {
  learnedPoolClock = next ?? (() => Date.now());
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
  /**
   * Phase C: partial θ overlay. When present, merged onto baseline and applied
   * as the active orchestration policy (global on promote; ALS on canary).
   */
  theta?: Record<string, number>;
}

const globalState: LearnedPoolState = {
  capabilityDeltas: new Map(),
  fallbackBoosts: new Map(),
  modelCapabilityDeltas: new Map(),
  modelRoutingScoreDeltas: new Map(),
  stageModelRoutingScoreDeltas: new Map(),
  modelFirstTokenTimeouts: new Map(),
  recoveryPolicy: new Map(),
  inferenceFeedbackExpiries: new Map(),
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

function feedbackExpiryKey(field: FeedbackManagedField, key: string): string {
  return `${field}${FEEDBACK_KEY_SEPARATOR}${key}`;
}

/**
 * Pure freshness decision for a learned value.
 *
 * An absent deadline means the value is not cron-managed (promoted production
 * policy or session learning) and stays authoritative; an unusable one fails
 * closed so a corrupt ledger cannot silently keep steering routing.
 */
export function isLearnedValueFresh(expiresAtMs: number | undefined, now: number): boolean {
  if (expiresAtMs === undefined) return true;
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs > now;
}

/** Attach the report deadline to a value just written into a cron-managed map. */
export function recordInferenceFeedbackExpiry(
  field: FeedbackManagedField,
  key: string,
  expiresAtMs: number,
  state: LearnedPoolState = globalState,
): void {
  if (!Number.isFinite(expiresAtMs)) return;
  state.inferenceFeedbackExpiries.set(feedbackExpiryKey(field, key), expiresAtMs);
}

/** Deadline recorded for a cron-managed key, if any. */
export function inferenceFeedbackExpiryFor(
  field: FeedbackManagedField,
  key: string,
  state: LearnedPoolState = globalState,
): number | undefined {
  return state.inferenceFeedbackExpiries.get(feedbackExpiryKey(field, key));
}

function releaseFeedbackExpiry(
  field: FeedbackManagedField,
  key: string,
  state: LearnedPoolState,
): void {
  state.inferenceFeedbackExpiries.delete(feedbackExpiryKey(field, key));
}

/** Drop every recorded deadline (the cron maps were cleared with them). */
export function clearInferenceFeedbackExpiries(state: LearnedPoolState = globalState): void {
  state.inferenceFeedbackExpiries.clear();
}

function isFeedbackKeyFresh(
  field: FeedbackManagedField,
  key: string,
  now: number,
  state: LearnedPoolState,
): boolean {
  return isLearnedValueFresh(state.inferenceFeedbackExpiries.get(feedbackExpiryKey(field, key)), now);
}

/**
 * Read a cron-managed value, releasing it when its report has expired.
 *
 * A released entry is deleted rather than merely hidden so it cannot be
 * captured by a later production snapshot and re-promoted as durable policy.
 */
function freshValue<T>(
  map: Map<string, T>,
  field: FeedbackManagedField,
  key: string,
  now: number,
  state: LearnedPoolState,
): T | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  if (isFeedbackKeyFresh(field, key, now, state)) return value;
  map.delete(key);
  releaseFeedbackExpiry(field, key, state);
  return undefined;
}

function freshNumberRecord(
  map: Map<string, number>,
  field: FeedbackManagedField,
  now: number,
  state: LearnedPoolState,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [key, value] of map) {
    if (isFeedbackKeyFresh(field, key, now, state)) next[key] = value;
  }
  // Release expired entries so a released measurement cannot be captured by a
  // later snapshot and re-promoted as durable production policy.
  for (const key of map.keys()) {
    if (Object.prototype.hasOwnProperty.call(next, key)) continue;
    map.delete(key);
    releaseFeedbackExpiry(field, key, state);
  }
  return next;
}

export function clearInferenceFeedbackState(): void {
  globalState.modelCapabilityDeltas.clear();
  globalState.modelRoutingScoreDeltas.clear();
  globalState.stageModelRoutingScoreDeltas.clear();
  globalState.modelFirstTokenTimeouts.clear();
  clearInferenceFeedbackExpiries();
}

export function resetLearnedPoolStateForTests(): void {
  globalState.capabilityDeltas.clear();
  globalState.fallbackBoosts.clear();
  globalState.recoveryPolicy.clear();
  clearInferenceFeedbackState();
}

/** Snapshot the staged-policy fields (routing / budget / recovery). */
export function snapshotStagedPolicyFields(state: LearnedPoolState = globalState): PolicySnapshot {
  const now = learnedPoolClock();
  return {
    modelRoutingScoreDeltas: freshNumberRecord(
      state.modelRoutingScoreDeltas,
      "modelRoutingScoreDeltas",
      now,
      state,
    ),
    stageModelRoutingScoreDeltas: freshNumberRecord(
      state.stageModelRoutingScoreDeltas,
      "stageModelRoutingScoreDeltas",
      now,
      state,
    ),
    fallbackBoosts: Object.fromEntries(state.fallbackBoosts),
    modelFirstTokenTimeouts: freshNumberRecord(
      state.modelFirstTokenTimeouts,
      "modelFirstTokenTimeouts",
      now,
      state,
    ),
    recovery: Object.fromEntries(state.recoveryPolicy),
    // θ is applied via orchestration-policy ALS/global — not mirrored in maps.
  };
}

function mergeNumberMap(
  target: Map<string, number>,
  next: Record<string, number> | undefined,
  previous?: Record<string, number>,
  options: { feedbackField?: FeedbackManagedField; state?: LearnedPoolState } = {},
): void {
  const state = options.state ?? globalState;
  // Drop keys that were exclusive to the previous snapshot (rollback of
  // canary-only keys) without wiping concurrent learning outside either snap.
  if (previous) {
    for (const key of Object.keys(previous)) {
      if (!(next && Object.prototype.hasOwnProperty.call(next, key))) {
        target.delete(key);
        // A promoted key is durable production policy: it is no longer the
        // cron measurement, so the report deadline no longer governs it.
        if (options.feedbackField) releaseFeedbackExpiry(options.feedbackField, key, state);
      }
    }
  }
  for (const [key, value] of Object.entries(next ?? {})) {
    target.set(key, value);
    if (options.feedbackField) releaseFeedbackExpiry(options.feedbackField, key, state);
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
    { feedbackField: "modelRoutingScoreDeltas", state },
  );
  mergeNumberMap(
    state.stageModelRoutingScoreDeltas,
    snapshot.stageModelRoutingScoreDeltas,
    prev?.stageModelRoutingScoreDeltas,
    { feedbackField: "stageModelRoutingScoreDeltas", state },
  );
  mergeNumberMap(state.fallbackBoosts, snapshot.fallbackBoosts, prev?.fallbackBoosts, { state });
  mergeNumberMap(
    state.modelFirstTokenTimeouts,
    snapshot.modelFirstTokenTimeouts,
    prev?.modelFirstTokenTimeouts,
    { feedbackField: "modelFirstTokenTimeouts", state },
  );
  mergeRecoveryMap(state.recoveryPolicy, snapshot.recovery, prev?.recovery);
  // Phase C: promote/rollback of θ patch onto the process-global active policy.
  if (snapshot.theta && Object.keys(snapshot.theta).length > 0) {
    applyThetaPatchGlobally(snapshot.theta as ThetaPatch, BASELINE_THETA);
  }
}

/**
 * Run `fn` with a request-scoped policy overlay. Overlay keys win for score
 * and timeout reads; global maps are not mutated. Nested calls restore the
 * prior overlay on exit. When `snapshot.theta` is set, θ is ALS-scoped too.
 */
export function runWithPolicyOverlay<T>(snapshot: PolicySnapshot | null | undefined, fn: () => T): T {
  if (!snapshot) return fn();
  const body = () => policyOverlayAls.run(snapshot, fn);
  if (snapshot.theta && Object.keys(snapshot.theta).length > 0) {
    return runWithTheta(snapshot.theta as ThetaPatch, body);
  }
  return body();
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
  return freshValue(
    globalState.modelRoutingScoreDeltas,
    "modelRoutingScoreDeltas",
    key,
    learnedPoolClock(),
    globalState,
  ) ?? 0;
}

export function stageModelFeedbackKey(provider: string, modelId: string, stage: string): string {
  return `${provider}:${modelId}:${stage}`;
}

export function stageRoutingScoreDelta(agent: OrchestratorAgent, stage: string): number {
  const key = stageModelFeedbackKey(agent.provider, agent.model_id, stage);
  const overlay = overlayNumber("stageModelRoutingScoreDeltas", key);
  if (overlay !== undefined) return overlay;
  return freshValue(
    globalState.stageModelRoutingScoreDeltas,
    "stageModelRoutingScoreDeltas",
    key,
    learnedPoolClock(),
    globalState,
  ) ?? 0;
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
  const now = learnedPoolClock();
  if (provider) {
    return freshValue(
      globalState.modelFirstTokenTimeouts,
      "modelFirstTokenTimeouts",
      modelFeedbackKey(provider, modelId),
      now,
      globalState,
    );
  }
  // A released measurement must not win the max over a live one, so expired
  // entries are dropped from the map as they are filtered out.
  const matches: number[] = [];
  for (const key of [...globalState.modelFirstTokenTimeouts.keys()]) {
    const live = freshValue(
      globalState.modelFirstTokenTimeouts,
      "modelFirstTokenTimeouts",
      key,
      now,
      globalState,
    );
    if (live !== undefined && key.endsWith(`:${modelId}`)) matches.push(live);
  }
  return matches.length > 0 ? Math.max(...matches) : undefined;
}

export function applyLearnedCapabilities(agent: OrchestratorAgent): OrchestratorAgent {
  const now = learnedPoolClock();
  const agentDeltas = globalState.capabilityDeltas.get(agent.id);
  const modelDeltas = freshValue(
    globalState.modelCapabilityDeltas,
    "modelCapabilityDeltas",
    modelFeedbackKey(agent.provider, agent.model_id),
    now,
    globalState,
  );
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
