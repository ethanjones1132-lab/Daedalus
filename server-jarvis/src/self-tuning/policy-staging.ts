/**
 * Guarded self-evolution for routing / budget / recovery policy changes.
 *
 * Instruction A/B and capability-delta nudges remain immediate low-risk paths
 * in conductor-learning.ts. This module holds higher-impact policy proposals
 * in a staged lifecycle:
 *
 *   candidate (held back)
 *     → 20 eligible outcomes
 *     → shadow replay
 *     → canary (10% traffic, ≥20 runs)
 *     → promotion criteria
 *     → production
 *     ↘ rollback → last-known-good
 *
 * Production / candidate / canary / last-known-good versions are persisted so
 * a process restart cannot lose rollback capability.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SESSIONS_DIR } from "../config";
import {
  applyPolicySnapshotToPool,
  getLearnedPoolState,
  snapshotStagedPolicyFields,
  type PolicySnapshot,
} from "./learned-pool-state";

// ── Thresholds (from plan) ──────────────────────────────────────────────────

export const POLICY_STAGING_THRESHOLDS = {
  /** Eligible outcomes required before a candidate may enter shadow replay. */
  minEligibleOutcomesBeforeShadow: 20,
  /** Fraction of live traffic that receives the canary policy. */
  canaryTrafficFraction: 0.1,
  /** Minimum canary runs before promotion may be evaluated. */
  minCanaryRunsBeforePromotion: 20,
  /** Absolute floor on canary success rate for promotion. */
  minCanarySuccessRate: 0.6,
  /**
   * Canary must not underperform production by more than this margin
   * (success-rate points) at promotion time.
   */
  maxCanaryUnderperformance: 0.05,
  /** After this many canary samples, extreme failure triggers auto-rollback. */
  minSamplesForRollback: 10,
  /** Canary failure rate at/above this → auto-rollback. */
  maxCanaryFailureRate: 0.5,
  /**
   * If canary success rate is this far below concurrent production arm
   * after minSamplesForRollback, auto-rollback.
   */
  maxCanaryRegressionVsProduction: 0.15,
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

export type PolicyDomain = "routing" | "budget" | "recovery";

export type PolicyStage =
  | "candidate"
  | "shadow"
  | "canary"
  | "production"
  | "rolled_back"
  | "rejected";

export interface PolicyPatch {
  domain: PolicyDomain;
  modelRoutingScoreDeltas?: Record<string, number>;
  stageModelRoutingScoreDeltas?: Record<string, number>;
  fallbackBoosts?: Record<string, number>;
  modelFirstTokenTimeouts?: Record<string, number>;
  recovery?: Record<string, number | string | boolean>;
}

export interface PolicyVersion {
  id: string;
  version: number;
  stage: PolicyStage;
  domain: PolicyDomain;
  /** Full desired state of staged fields (baseline production ⊕ patch). */
  snapshot: PolicySnapshot;
  /** The delta that produced this version (for audit). */
  patch: PolicyPatch;
  rationale: string;
  createdAt: string;
  updatedAt: string;
  eligibleOutcomes: number;
  eligibleSuccessCount: number;
  eligibleFailureCount: number;
  shadow?: {
    replayed: number;
    successCount: number;
    failureCount: number;
    completedAt?: string;
  };
  canaryStats?: {
    runs: number;
    successCount: number;
    failureCount: number;
    productionRuns: number;
    productionSuccessCount: number;
    productionFailureCount: number;
  };
  history: Array<{ at: string; from: PolicyStage; to: PolicyStage; reason: string }>;
}

export interface PolicyVersionStore {
  schemaVersion: 1;
  nextVersion: number;
  production: PolicyVersion | null;
  candidate: PolicyVersion | null;
  canary: PolicyVersion | null;
  lastKnownGood: PolicyVersion | null;
}

export type TransitionAction =
  | "none"
  | "proposed"
  | "eligible_recorded"
  | "entered_shadow"
  | "shadow_completed"
  | "entered_canary"
  | "canary_outcome_recorded"
  | "promoted"
  | "rolled_back"
  | "rejected";

export interface TransitionResult {
  action: TransitionAction;
  reason: string;
  version: PolicyVersion | null;
  store: PolicyVersionStore;
}

// ── In-memory store ─────────────────────────────────────────────────────────

function emptyStore(): PolicyVersionStore {
  return {
    schemaVersion: 1,
    nextVersion: 1,
    production: null,
    candidate: null,
    canary: null,
    lastKnownGood: null,
  };
}

let store: PolicyVersionStore = emptyStore();

export function getPolicyVersionStore(): PolicyVersionStore {
  return store;
}

export function resetPolicyStagingForTests(): void {
  store = emptyStore();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function cloneVersion(v: PolicyVersion): PolicyVersion {
  return JSON.parse(JSON.stringify(v)) as PolicyVersion;
}

function emptySnapshot(): PolicySnapshot {
  return {
    modelRoutingScoreDeltas: {},
    stageModelRoutingScoreDeltas: {},
    fallbackBoosts: {},
    modelFirstTokenTimeouts: {},
    recovery: {},
  };
}

export function mergePatchIntoSnapshot(
  base: PolicySnapshot,
  patch: PolicyPatch,
): PolicySnapshot {
  return {
    modelRoutingScoreDeltas: {
      ...base.modelRoutingScoreDeltas,
      ...(patch.modelRoutingScoreDeltas ?? {}),
    },
    stageModelRoutingScoreDeltas: {
      ...base.stageModelRoutingScoreDeltas,
      ...(patch.stageModelRoutingScoreDeltas ?? {}),
    },
    fallbackBoosts: {
      ...base.fallbackBoosts,
      ...(patch.fallbackBoosts ?? {}),
    },
    modelFirstTokenTimeouts: {
      ...base.modelFirstTokenTimeouts,
      ...(patch.modelFirstTokenTimeouts ?? {}),
    },
    recovery: {
      ...base.recovery,
      ...(patch.recovery ?? {}),
    },
  };
}

function recordTransition(
  version: PolicyVersion,
  to: PolicyStage,
  reason: string,
): void {
  const from = version.stage;
  version.stage = to;
  version.updatedAt = nowIso();
  version.history.push({ at: version.updatedAt, from, to, reason });
}

function successRate(success: number, failure: number): number {
  const total = success + failure;
  return total === 0 ? 0.5 : success / total;
}

function patchIsEmpty(patch: PolicyPatch): boolean {
  return (
    Object.keys(patch.modelRoutingScoreDeltas ?? {}).length === 0 &&
    Object.keys(patch.stageModelRoutingScoreDeltas ?? {}).length === 0 &&
    Object.keys(patch.fallbackBoosts ?? {}).length === 0 &&
    Object.keys(patch.modelFirstTokenTimeouts ?? {}).length === 0 &&
    Object.keys(patch.recovery ?? {}).length === 0
  );
}

// ── Propose ─────────────────────────────────────────────────────────────────

/**
 * Hold back a routing/budget/recovery policy change as a candidate.
 * Rejects if a candidate/canary is already in flight, or the patch is empty.
 * Does not mutate production learned-pool maps.
 */
export function proposePolicy(
  patch: PolicyPatch,
  rationale: string,
  options: { baseline?: PolicySnapshot; now?: string } = {},
): TransitionResult {
  if (store.candidate || store.canary) {
    return {
      action: "rejected",
      reason: "in_flight_exists",
      version: store.candidate ?? store.canary,
      store,
    };
  }
  if (patchIsEmpty(patch)) {
    return { action: "rejected", reason: "empty_patch", version: null, store };
  }

  const baseline =
    options.baseline ??
    store.production?.snapshot ??
    snapshotStagedPolicyFields(getLearnedPoolState());
  const createdAt = options.now ?? nowIso();
  const versionNum = store.nextVersion++;
  const version: PolicyVersion = {
    id: `pol_${versionNum}_${crypto.randomUUID().slice(0, 8)}`,
    version: versionNum,
    stage: "candidate",
    domain: patch.domain,
    snapshot: mergePatchIntoSnapshot(baseline, patch),
    patch,
    rationale,
    createdAt,
    updatedAt: createdAt,
    eligibleOutcomes: 0,
    eligibleSuccessCount: 0,
    eligibleFailureCount: 0,
    history: [{ at: createdAt, from: "candidate", to: "candidate", reason: "proposed" }],
  };
  store.candidate = version;
  return { action: "proposed", reason: "held_as_candidate", version, store };
}

// ── Eligible outcomes → shadow ──────────────────────────────────────────────

/**
 * Record an eligible production outcome while a candidate is held back.
 * After {@link POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow}
 * outcomes the candidate automatically enters the `shadow` stage.
 */
export function recordEligibleOutcome(
  outcome: "success" | "degraded" | "failed",
): TransitionResult {
  const candidate = store.candidate;
  if (!candidate || candidate.stage !== "candidate") {
    return {
      action: "none",
      reason: candidate ? `stage_${candidate.stage}` : "no_candidate",
      version: candidate,
      store,
    };
  }

  candidate.eligibleOutcomes += 1;
  if (outcome === "success") candidate.eligibleSuccessCount += 1;
  else candidate.eligibleFailureCount += 1;
  candidate.updatedAt = nowIso();

  if (
    candidate.eligibleOutcomes >= POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow
  ) {
    recordTransition(candidate, "shadow", "eligible_threshold_met");
    candidate.shadow = { replayed: 0, successCount: 0, failureCount: 0 };
    return {
      action: "entered_shadow",
      reason: "eligible_threshold_met",
      version: candidate,
      store,
    };
  }

  return {
    action: "eligible_recorded",
    reason: `eligible_${candidate.eligibleOutcomes}_of_${POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow}`,
    version: candidate,
    store,
  };
}

// ── Shadow replay ───────────────────────────────────────────────────────────

/**
 * Feed offline / historical replay results into a shadow-stage candidate.
 * Completing the required replay count advances the candidate into canary.
 */
export function runShadowReplay(
  outcomes: ReadonlyArray<{ success: boolean }>,
): TransitionResult {
  const candidate = store.candidate;
  if (!candidate || candidate.stage !== "shadow") {
    return {
      action: "none",
      reason: candidate ? `stage_${candidate.stage}` : "no_candidate",
      version: candidate,
      store,
    };
  }

  if (!candidate.shadow) {
    candidate.shadow = { replayed: 0, successCount: 0, failureCount: 0 };
  }

  for (const row of outcomes) {
    candidate.shadow.replayed += 1;
    if (row.success) candidate.shadow.successCount += 1;
    else candidate.shadow.failureCount += 1;
  }
  candidate.updatedAt = nowIso();

  // Require a full shadow pass of at least minEligibleOutcomesBeforeShadow replays.
  if (candidate.shadow.replayed < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow) {
    return {
      action: "none",
      reason: `shadow_partial_${candidate.shadow.replayed}`,
      version: candidate,
      store,
    };
  }

  const shadowRate = successRate(candidate.shadow.successCount, candidate.shadow.failureCount);
  // Reject shadow if absolute rate is catastrophic.
  if (shadowRate < POLICY_STAGING_THRESHOLDS.minCanarySuccessRate) {
    recordTransition(candidate, "rejected", `shadow_rate_${shadowRate.toFixed(3)}`);
    store.candidate = null;
    return {
      action: "rejected",
      reason: "shadow_failed_quality_gate",
      version: candidate,
      store,
    };
  }

  candidate.shadow.completedAt = nowIso();
  recordTransition(candidate, "canary", "shadow_replay_passed");
  candidate.canaryStats = {
    runs: 0,
    successCount: 0,
    failureCount: 0,
    productionRuns: 0,
    productionSuccessCount: 0,
    productionFailureCount: 0,
  };
  store.canary = candidate;
  // Candidate pointer remains while canarying so restart reloads both slots.
  return {
    action: "entered_canary",
    reason: "shadow_replay_passed",
    version: candidate,
    store,
  };
}

// ── Canary traffic selection ────────────────────────────────────────────────

/**
 * Whether this live run should receive the canary policy (10% default).
 * Only true while a canary is active.
 */
export function shouldApplyCanary(rng: () => number = Math.random): boolean {
  if (!store.canary || store.canary.stage !== "canary") return false;
  return rng() < POLICY_STAGING_THRESHOLDS.canaryTrafficFraction;
}

/**
 * Snapshot to apply for a given arm. Callers merge this into request-local
 * routing/budget decisions; production maps are only mutated on promote/rollback.
 */
export function activeSnapshotForArm(arm: "production" | "canary"): PolicySnapshot {
  if (arm === "canary" && store.canary?.stage === "canary") {
    return store.canary.snapshot;
  }
  return store.production?.snapshot ?? emptySnapshot();
}

// ── Canary outcomes + promotion / rollback ──────────────────────────────────

function maybeAutoRollback(version: PolicyVersion): TransitionResult | null {
  const stats = version.canaryStats;
  if (!stats) return null;
  const samples = stats.runs;
  if (samples < POLICY_STAGING_THRESHOLDS.minSamplesForRollback) return null;

  const failRate = stats.failureCount / Math.max(1, stats.runs);
  if (failRate >= POLICY_STAGING_THRESHOLDS.maxCanaryFailureRate) {
    return rollbackPolicy(`canary_failure_rate_${failRate.toFixed(3)}`);
  }

  if (stats.productionRuns >= POLICY_STAGING_THRESHOLDS.minSamplesForRollback) {
    const canaryRate = successRate(stats.successCount, stats.failureCount);
    const prodRate = successRate(stats.productionSuccessCount, stats.productionFailureCount);
    if (canaryRate < prodRate - POLICY_STAGING_THRESHOLDS.maxCanaryRegressionVsProduction) {
      return rollbackPolicy(
        `canary_regression_${canaryRate.toFixed(3)}_vs_${prodRate.toFixed(3)}`,
      );
    }
  }
  return null;
}

function evaluatePromotionUnlocked(version: PolicyVersion): TransitionResult | null {
  const stats = version.canaryStats;
  if (!stats) return null;
  if (stats.runs < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion) return null;

  const canaryRate = successRate(stats.successCount, stats.failureCount);
  if (canaryRate < POLICY_STAGING_THRESHOLDS.minCanarySuccessRate) {
    return rollbackPolicy(`promotion_floor_failed_${canaryRate.toFixed(3)}`);
  }

  if (stats.productionRuns > 0) {
    const prodRate = successRate(stats.productionSuccessCount, stats.productionFailureCount);
    if (canaryRate + POLICY_STAGING_THRESHOLDS.maxCanaryUnderperformance < prodRate) {
      return rollbackPolicy(
        `promotion_underperform_${canaryRate.toFixed(3)}_vs_${prodRate.toFixed(3)}`,
      );
    }
  }

  return promoteCanary("promotion_criteria_met");
}

/**
 * Record a live outcome for either the canary or production arm during canary.
 * May auto-promote or auto-rollback when thresholds are crossed.
 */
export function recordCanaryOutcome(
  arm: "canary" | "production",
  success: boolean,
): TransitionResult {
  const version = store.canary;
  if (!version || version.stage !== "canary" || !version.canaryStats) {
    return {
      action: "none",
      reason: version ? `stage_${version.stage}` : "no_canary",
      version,
      store,
    };
  }

  const stats = version.canaryStats;
  if (arm === "canary") {
    stats.runs += 1;
    if (success) stats.successCount += 1;
    else stats.failureCount += 1;
  } else {
    stats.productionRuns += 1;
    if (success) stats.productionSuccessCount += 1;
    else stats.productionFailureCount += 1;
  }
  version.updatedAt = nowIso();

  const rolled = maybeAutoRollback(version);
  if (rolled) return rolled;

  const promoted = evaluatePromotionUnlocked(version);
  if (promoted) return promoted;

  return {
    action: "canary_outcome_recorded",
    reason: `${arm}_${success ? "success" : "failure"}`,
    version,
    store,
  };
}

/**
 * Explicit promotion check (also invoked automatically from recordCanaryOutcome).
 */
export function evaluatePromotion(): TransitionResult {
  const version = store.canary;
  if (!version || version.stage !== "canary") {
    return {
      action: "none",
      reason: version ? `stage_${version.stage}` : "no_canary",
      version,
      store,
    };
  }
  const stats = version.canaryStats;
  if (!stats || stats.runs < POLICY_STAGING_THRESHOLDS.minCanaryRunsBeforePromotion) {
    return {
      action: "none",
      reason: `insufficient_canary_runs_${stats?.runs ?? 0}`,
      version,
      store,
    };
  }
  return evaluatePromotionUnlocked(version) ?? {
    action: "none",
    reason: "criteria_not_met",
    version,
    store,
  };
}

function promoteCanary(reason: string): TransitionResult {
  const version = store.canary ?? store.candidate;
  if (!version || (version.stage !== "canary" && version.stage !== "shadow")) {
    return {
      action: "none",
      reason: "nothing_to_promote",
      version,
      store,
    };
  }

  // Preserve prior production as last-known-good before mutating maps.
  if (store.production) {
    store.lastKnownGood = cloneVersion(store.production);
  } else if (!store.lastKnownGood) {
    // Seed LKG from the pre-promote live maps so a rollback has something.
    const seed: PolicyVersion = {
      id: `pol_lkg_seed`,
      version: 0,
      stage: "production",
      domain: version.domain,
      snapshot: snapshotStagedPolicyFields(getLearnedPoolState()),
      patch: { domain: version.domain },
      rationale: "seeded last-known-good from live maps at first promotion",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      eligibleOutcomes: 0,
      eligibleSuccessCount: 0,
      eligibleFailureCount: 0,
      history: [],
    };
    store.lastKnownGood = seed;
  }

  applyPolicySnapshotToPool(version.snapshot);
  recordTransition(version, "production", reason);
  store.production = version;
  store.candidate = null;
  store.canary = null;

  return {
    action: "promoted",
    reason,
    version,
    store,
  };
}

/**
 * Roll back the active canary (or newly-promoted production) to last-known-good.
 * Restores staged learned-pool maps from the LKG snapshot.
 */
export function rollbackPolicy(reason: string): TransitionResult {
  const active = store.canary ?? (store.production?.stage === "production" ? store.production : null);
  const lkg = store.lastKnownGood;

  if (store.canary) {
    recordTransition(store.canary, "rolled_back", reason);
  } else if (store.production && store.production !== lkg) {
    recordTransition(store.production, "rolled_back", reason);
  }

  if (lkg) {
    applyPolicySnapshotToPool(lkg.snapshot);
    // Re-assert LKG as production.
    const restored = cloneVersion(lkg);
    restored.stage = "production";
    restored.updatedAt = nowIso();
    restored.history.push({
      at: restored.updatedAt,
      from: lkg.stage,
      to: "production",
      reason: `restored_after_${reason}`,
    });
    store.production = restored;
  }

  const rolled = active ? cloneVersion(active) : null;
  if (rolled && rolled.stage !== "rolled_back") {
    rolled.stage = "rolled_back";
  }

  store.candidate = null;
  store.canary = null;

  return {
    action: "rolled_back",
    reason,
    version: rolled,
    store,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function policyVersionsPath(root: string = SESSIONS_DIR): string {
  return join(root, "self-tuning", "policy-versions.json");
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  try {
    renameSync(tmp, path);
  } catch {
    // Windows: rename over existing can fail; fall back to overwrite.
    writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Persist production / candidate / canary / last-known-good so restarts keep rollback. */
export function persistPolicyVersions(root: string = SESSIONS_DIR): void {
  try {
    atomicWriteJson(policyVersionsPath(root), store);
  } catch (e) {
    console.warn(
      `[PolicyStaging] Failed to persist: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Load persisted policy versions. No-op when the file is missing. */
export function loadPolicyVersions(root: string = SESSIONS_DIR): void {
  const path = policyVersionsPath(root);
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<PolicyVersionStore>;
    if (raw.schemaVersion !== 1) {
      console.warn(`[PolicyStaging] Unknown schema_version=${String(raw.schemaVersion)}; ignoring`);
      return;
    }
    store = {
      schemaVersion: 1,
      nextVersion: Math.max(1, Number(raw.nextVersion) || 1),
      production: (raw.production as PolicyVersion | null) ?? null,
      candidate: (raw.candidate as PolicyVersion | null) ?? null,
      canary: (raw.canary as PolicyVersion | null) ?? null,
      lastKnownGood: (raw.lastKnownGood as PolicyVersion | null) ?? null,
    };
    // Re-apply production snapshot so routing/budget maps match disk after restart.
    if (store.production?.snapshot) {
      applyPolicySnapshotToPool(store.production.snapshot);
    }
  } catch (e) {
    console.warn(
      `[PolicyStaging] Failed to load: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
