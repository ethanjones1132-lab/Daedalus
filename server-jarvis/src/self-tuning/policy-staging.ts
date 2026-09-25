/**
 * Guarded self-evolution for routing / budget / recovery policy changes.
 *
 * Instruction A/B and capability-delta nudges remain immediate low-risk paths
 * in conductor-learning.ts. This module holds higher-impact policy proposals
 * in a staged lifecycle:
 *
 *   candidate (held back)
 *     → 20 candidate-executed outcomes
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
import { getGlobalTheta, setGlobalTheta, THETA_KEYS } from "../orchestration/orchestration-policy";

/** Re-export so consumers can import staged-policy types from one module. */
export type { PolicySnapshot } from "./learned-pool-state";

// ── Governance (immutable — deliberately outside optimizable θ) ─────────────
// Same values previously on BASELINE_THETA.policy_* but excluded from
// OrchestrationTheta so Phase D CMA-ES cannot tune its own promotion
// admission criteria (reward-isolation class, sibling of 0c1face).

export const POLICY_STAGING_GOVERNANCE = Object.freeze({
  canaryTrafficFraction: 0.1,
  minCanarySuccessRate: 0.6,
  minEligibleOutcomesBeforeShadow: 20,
  minCanaryRunsBeforePromotion: 20,
});

// ── Thresholds (governance + operational rollback knobs) ────────────────────

export const POLICY_STAGING_THRESHOLDS = {
  /** Eligible outcomes required before a candidate may enter shadow replay. */
  minEligibleOutcomesBeforeShadow: POLICY_STAGING_GOVERNANCE.minEligibleOutcomesBeforeShadow,
  /** Fraction of live traffic that receives the canary policy. */
  canaryTrafficFraction: POLICY_STAGING_GOVERNANCE.canaryTrafficFraction,
  /** Minimum canary runs before promotion may be evaluated. */
  minCanaryRunsBeforePromotion: POLICY_STAGING_GOVERNANCE.minCanaryRunsBeforePromotion,
  /** Absolute floor on canary success rate for promotion. */
  minCanarySuccessRate: POLICY_STAGING_GOVERNANCE.minCanarySuccessRate,
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
  /** Phase C: partial θ dimensions to stage through canary/LKG. */
  theta?: Record<string, number>;
}

export type PolicyOutcome = "success" | "degraded" | "failed";
export type PolicyEvidenceSource = "live_turn" | "candidate_execution" | "offline_replay";
export type PolicyEvidenceArm = "production" | "candidate" | "canary" | "offline_replay";

export interface PolicyEvidence {
  evidenceId: string;
  policyId: string;
  policyVersion: number;
  patch: PolicyPatch;
  source: PolicyEvidenceSource;
  arm: PolicyEvidenceArm;
  runId: string;
  sessionId: string;
  taskType: string;
  outcome: PolicyOutcome;
}

export interface PolicyEvidenceLedger {
  evidenceIds: string[];
  runIds: string[];
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
  qualificationEvidence?: PolicyEvidenceLedger;
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

export interface PolicyProposalPersistenceOptions {
  root?: string;
  baseline?: PolicySnapshot;
  now?: string;
  persist?: (root?: string) => boolean;
}

export interface PolicyProposalCommit {
  transition: TransitionResult;
  persisted: boolean;
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
    theta: {},
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
    theta: {
      ...(base.theta ?? {}),
      ...(patch.theta ?? {}),
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
    Object.keys(patch.recovery ?? {}).length === 0 &&
    Object.keys(patch.theta ?? {}).length === 0
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
    qualificationEvidence: { evidenceIds: [], runIds: [] },
    history: [{ at: createdAt, from: "candidate", to: "candidate", reason: "proposed" }],
  };
  store.candidate = version;
  return { action: "proposed", reason: "held_as_candidate", version, store };
}

export function proposeAndPersistPolicy(
  patch: PolicyPatch,
  rationale: string,
  options: PolicyProposalPersistenceOptions = {},
): PolicyProposalCommit {
  const previous = JSON.parse(JSON.stringify(store)) as PolicyVersionStore;
  const transition = proposePolicy(patch, rationale, {
    baseline: options.baseline,
    now: options.now,
  });
  if (transition.action !== "proposed") return { transition, persisted: false };

  let persisted = false;
  try {
    persisted = (options.persist ?? persistPolicyVersions)(options.root) === true;
  } catch {
    persisted = false;
  }
  if (!persisted) {
    store = previous;
    return {
      transition: { ...transition, version: null, store },
      persisted: false,
    };
  }
  return { transition, persisted: true };
}

// ── Eligible outcomes → shadow ──────────────────────────────────────────────

function evidenceFailure(candidate: PolicyVersion, reason: string): TransitionResult {
  return { action: "none", reason, version: candidate, store };
}

function isPolicyOutcome(value: unknown): value is PolicyOutcome {
  return value === "success" || value === "degraded" || value === "failed";
}

function isPolicyEvidenceSource(value: unknown): value is PolicyEvidenceSource {
  return value === "live_turn" || value === "candidate_execution" || value === "offline_replay";
}

function isPolicyEvidenceArm(value: unknown): value is PolicyEvidenceArm {
  return (
    value === "production" ||
    value === "candidate" ||
    value === "canary" ||
    value === "offline_replay"
  );
}

function evidenceLedger(candidate: PolicyVersion): PolicyEvidenceLedger {
  if (!candidate.qualificationEvidence) {
    candidate.qualificationEvidence = { evidenceIds: [], runIds: [] };
  }
  return candidate.qualificationEvidence;
}

function validateQualificationEvidence(
  candidate: PolicyVersion,
  evidence: PolicyEvidence | undefined,
  expectedOutcome: PolicyOutcome,
): string | null {
  if (!evidence || typeof evidence !== "object") return "evidence_required";
  if (
    typeof evidence.evidenceId !== "string" ||
    evidence.evidenceId.length === 0 ||
    typeof evidence.policyId !== "string" ||
    evidence.policyId.length === 0 ||
    !isCounter(evidence.policyVersion) ||
    !isPolicyEvidenceSource(evidence.source) ||
    !isPolicyEvidenceArm(evidence.arm) ||
    typeof evidence.runId !== "string" ||
    evidence.runId.length === 0 ||
    typeof evidence.sessionId !== "string" ||
    evidence.sessionId.length === 0 ||
    typeof evidence.taskType !== "string" ||
    evidence.taskType.length === 0 ||
    !isPolicyOutcome(evidence.outcome)
  ) {
    return "invalid_evidence";
  }
  if (evidence.outcome !== expectedOutcome) return "outcome_mismatch";
  if (evidence.source === "live_turn") return "live_turn_not_qualifying";
  if (evidence.source === "candidate_execution" && evidence.arm !== "candidate") {
    return "wrong_policy_arm";
  }
  if (evidence.source === "offline_replay" && evidence.arm !== "offline_replay") {
    return "wrong_policy_arm";
  }
  if (evidence.policyId !== candidate.id) return "stale_policy_id";
  if (evidence.policyVersion !== candidate.version) return "stale_policy_version";
  try {
    if (policyPatchFingerprint(evidence.patch) !== policyPatchFingerprint(candidate.patch)) {
      return "patch_mismatch";
    }
  } catch {
    return "invalid_evidence";
  }
  const ledger = candidate.qualificationEvidence;
  if (ledger?.evidenceIds.includes(evidence.evidenceId)) return "duplicate_evidence";
  if (ledger?.runIds.includes(evidence.runId)) return "duplicate_run";
  return null;
}

function rememberEvidence(candidate: PolicyVersion, evidence: PolicyEvidence): boolean {
  const ledger = evidenceLedger(candidate);
  if (ledger.evidenceIds.length >= 256) return false;
  ledger.evidenceIds.push(evidence.evidenceId);
  ledger.runIds.push(evidence.runId);
  return true;
}

export function recordEligibleOutcome(
  outcome: PolicyOutcome,
  evidence?: PolicyEvidence,
): TransitionResult {
  const candidate = store.candidate;
  if (!candidate) {
    return {
      action: "none",
      reason: "no_candidate",
      version: null,
      store,
    };
  }

  if (candidate.stage === "shadow") {
    const reason = validateQualificationEvidence(candidate, evidence, outcome);
    if (reason) return evidenceFailure(candidate, reason);
    if (!rememberEvidence(candidate, evidence!)) {
      return evidenceFailure(candidate, "evidence_capacity_exceeded");
    }
    return recordShadowLiveOutcome(candidate, evidence!);
  }

  if (candidate.stage !== "candidate") {
    return evidenceFailure(candidate, `stage_${candidate.stage}`);
  }

  const reason = validateQualificationEvidence(candidate, evidence, outcome);
  if (reason) return evidenceFailure(candidate, reason);
  if (evidence!.source === "offline_replay") {
    return evidenceFailure(candidate, "offline_replay_requires_shadow");
  }
  if (!rememberEvidence(candidate, evidence!)) {
    return evidenceFailure(candidate, "evidence_capacity_exceeded");
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

function recordShadowLiveOutcome(
  candidate: PolicyVersion,
  evidence: PolicyEvidence,
): TransitionResult {
  if (!candidate.shadow) {
    candidate.shadow = { replayed: 0, successCount: 0, failureCount: 0 };
  }
  candidate.shadow.replayed += 1;
  if (evidence.outcome === "success") candidate.shadow.successCount += 1;
  else candidate.shadow.failureCount += 1;
  candidate.updatedAt = nowIso();

  if (candidate.shadow.replayed < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow) {
    return {
      action: "eligible_recorded",
      reason: `shadow_live_${candidate.shadow.replayed}_of_${POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow}`,
      version: candidate,
      store,
    };
  }

  return finalizeShadowReplay(candidate);
}

// ── Shadow replay ───────────────────────────────────────────────────────────

function finalizeShadowReplay(candidate: PolicyVersion): TransitionResult {
  if (!candidate.shadow) {
    candidate.shadow = { replayed: 0, successCount: 0, failureCount: 0 };
  }

  if (candidate.shadow.replayed < POLICY_STAGING_THRESHOLDS.minEligibleOutcomesBeforeShadow) {
    return {
      action: "eligible_recorded",
      reason: `shadow_partial_${candidate.shadow.replayed}`,
      version: candidate,
      store,
    };
  }

  const shadowRate = successRate(candidate.shadow.successCount, candidate.shadow.failureCount);
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
  return {
    action: "entered_canary",
    reason: "shadow_replay_passed",
    version: candidate,
    store,
  };
}

export function runShadowReplay(
  outcomes: ReadonlyArray<PolicyEvidence>,
): TransitionResult {
  const candidate = store.candidate;
  if (!candidate || candidate.stage !== "shadow") {
    return {
      action: "none",
      reason: candidate
        ? candidate.stage === "candidate"
          ? "replay_requires_shadow"
          : `stage_${candidate.stage}`
        : "no_candidate",
      version: candidate,
      store,
    };
  }

  if (outcomes.length === 0) return evidenceFailure(candidate, "empty_replay");

  const evidenceIds = new Set(candidate.qualificationEvidence?.evidenceIds ?? []);
  const runIds = new Set(candidate.qualificationEvidence?.runIds ?? []);
  if (evidenceIds.size + outcomes.length > 256) {
    return evidenceFailure(candidate, "evidence_capacity_exceeded");
  }
  for (const row of outcomes) {
    if (!row || typeof row !== "object") {
      return evidenceFailure(candidate, "invalid_evidence");
    }
    if (row.source !== "offline_replay" || row.arm !== "offline_replay") {
      return evidenceFailure(candidate, "replay_source_mismatch");
    }
    const reason = validateQualificationEvidence(candidate, row, row.outcome);
    if (reason) return evidenceFailure(candidate, reason);
    if (evidenceIds.has(row.evidenceId)) return evidenceFailure(candidate, "duplicate_evidence");
    if (runIds.has(row.runId)) return evidenceFailure(candidate, "duplicate_run");
    evidenceIds.add(row.evidenceId);
    runIds.add(row.runId);
  }

  if (!candidate.shadow) {
    candidate.shadow = { replayed: 0, successCount: 0, failureCount: 0 };
  }
  for (const row of outcomes) {
    if (!rememberEvidence(candidate, row)) {
      return evidenceFailure(candidate, "evidence_capacity_exceeded");
    }
    candidate.shadow.replayed += 1;
    if (row.outcome === "success") candidate.shadow.successCount += 1;
    else candidate.shadow.failureCount += 1;
  }
  candidate.updatedAt = nowIso();

  return finalizeShadowReplay(candidate);
}

// ── Canary traffic selection ────────────────────────────────────────────────

/**
 * Whether this live run should receive the canary policy (10% default).
 * Only true while a canary is active.
 */
export function shouldApplyCanary(rng: () => number = Math.random): boolean {
  if (!store.canary || store.canary.stage !== "canary") return false;
  // Governance constant — never policy()/θ, so a candidate cannot widen its
  // own canary traffic fraction into production.
  return rng() < POLICY_STAGING_GOVERNANCE.canaryTrafficFraction;
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
  // `previous` for merge is only the staged production snapshot — never the
  // full live maps — so concurrent inference-feedback keys outside staged
  // versions are not treated as "outgoing" and deleted on promote.
  const previousProductionSnapshot = store.production?.snapshot;
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
      qualificationEvidence: { evidenceIds: [], runIds: [] },
      history: [],
    };
    store.lastKnownGood = seed;
  }

  // Merge canary keys into the live pool; drop keys exclusive to prior staged
  // production so concurrent learning outside either snapshot is preserved.
  applyPolicySnapshotToPool(version.snapshot, getLearnedPoolState(), {
    previous: previousProductionSnapshot,
  });
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
    // Merge LKG keys and drop keys exclusive to the rolled-back version.
    applyPolicySnapshotToPool(lkg.snapshot, getLearnedPoolState(), {
      previous: active?.snapshot,
    });
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

const POLICY_DOMAINS = new Set<PolicyDomain>(["routing", "budget", "recovery"]);
const POLICY_STAGES = new Set<PolicyStage>([
  "candidate",
  "shadow",
  "canary",
  "production",
  "rolled_back",
  "rejected",
]);
const THETA_KEY_NAMES = new Set<string>(THETA_KEYS);

class PolicyVersionValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function rejectPolicyState(reason: string): never {
  throw new PolicyVersionValidationError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

export function policyPatchFingerprint(patch: PolicyPatch): string {
  return JSON.stringify(canonicalize(patch)) ?? "null";
}

function isPolicyDomain(value: unknown): value is PolicyDomain {
  return typeof value === "string" && POLICY_DOMAINS.has(value as PolicyDomain);
}

function isPolicyStage(value: unknown): value is PolicyStage {
  return typeof value === "string" && POLICY_STAGES.has(value as PolicyStage);
}

function validateNumberMap(
  value: unknown,
  missingReason: string,
  invalidReason: string,
): void {
  if (!isRecord(value)) rejectPolicyState(missingReason);
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || !isFiniteNumber(entry)) rejectPolicyState(invalidReason);
  }
}

function validateRecoveryMap(value: unknown, missingReason: string, invalidReason: string): void {
  if (!isRecord(value)) rejectPolicyState(missingReason);
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0) rejectPolicyState(invalidReason);
    if (typeof entry === "string" || typeof entry === "boolean") continue;
    if (!isFiniteNumber(entry)) rejectPolicyState(invalidReason);
  }
}

function validateTheta(value: unknown): void {
  if (!isRecord(value)) rejectPolicyState("invalid_theta");
  for (const [key, entry] of Object.entries(value)) {
    if (!THETA_KEY_NAMES.has(key) || !isFiniteNumber(entry)) rejectPolicyState("invalid_theta");
  }
}

function validateSnapshot(value: unknown): PolicySnapshot {
  if (!isRecord(value)) rejectPolicyState("missing_snapshot");
  validateNumberMap(
    value.modelRoutingScoreDeltas,
    "missing_map",
    "nonnumeric_map",
  );
  validateNumberMap(
    value.stageModelRoutingScoreDeltas,
    "missing_map",
    "nonnumeric_map",
  );
  validateNumberMap(value.fallbackBoosts, "missing_map", "nonnumeric_map");
  validateNumberMap(value.modelFirstTokenTimeouts, "missing_map", "nonnumeric_map");
  validateRecoveryMap(value.recovery, "missing_map", "invalid_recovery");
  if (value.theta !== undefined) validateTheta(value.theta);
  return value as unknown as PolicySnapshot;
}

function validatePatch(value: unknown, versionDomain: PolicyDomain): PolicyPatch {
  if (!isRecord(value) || !isPolicyDomain(value.domain) || value.domain !== versionDomain) {
    rejectPolicyState("invalid_patch");
  }
  const patch = value as Record<string, unknown>;
  if (patch.modelRoutingScoreDeltas !== undefined) {
    validateNumberMap(patch.modelRoutingScoreDeltas, "invalid_patch", "nonnumeric_map");
  }
  if (patch.stageModelRoutingScoreDeltas !== undefined) {
    validateNumberMap(patch.stageModelRoutingScoreDeltas, "invalid_patch", "nonnumeric_map");
  }
  if (patch.fallbackBoosts !== undefined) {
    validateNumberMap(patch.fallbackBoosts, "invalid_patch", "nonnumeric_map");
  }
  if (patch.modelFirstTokenTimeouts !== undefined) {
    validateNumberMap(patch.modelFirstTokenTimeouts, "invalid_patch", "nonnumeric_map");
  }
  if (patch.recovery !== undefined) {
    validateRecoveryMap(patch.recovery, "invalid_patch", "invalid_recovery");
  }
  if (patch.theta !== undefined) validateTheta(patch.theta);
  return value as unknown as PolicyPatch;
}

function validateCounterSet(
  value: Record<string, unknown>,
  fields: readonly string[],
  totalField: string,
  mismatchReason: string,
): void {
  let total = 0;
  for (const field of fields) {
    const counter = value[field];
    if (!isCounter(counter)) rejectPolicyState("invalid_counter");
    total += counter;
  }
  const totalValue = value[totalField];
  if (!isCounter(totalValue)) rejectPolicyState("invalid_counter");
  if (totalValue !== total) rejectPolicyState(mismatchReason);
}

function validateShadow(value: unknown): void {
  if (!isRecord(value)) rejectPolicyState("invalid_shadow");
  validateCounterSet(value, ["successCount", "failureCount"], "replayed", "counter_mismatch");
  if (value.completedAt !== undefined && typeof value.completedAt !== "string") {
    rejectPolicyState("invalid_shadow");
  }
}

function validateEvidenceLedger(value: unknown, version: Record<string, unknown>): void {
  if (!isRecord(value)) rejectPolicyState("invalid_evidence_ledger");
  const lengths: number[] = [];
  for (const field of ["evidenceIds", "runIds"] as const) {
    const entries = value[field];
    if (!Array.isArray(entries) || entries.length > 256) {
      rejectPolicyState("invalid_evidence_ledger");
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.length === 0 || seen.has(entry)) {
        rejectPolicyState("invalid_evidence_ledger");
      }
      seen.add(entry);
    }
    lengths.push(entries.length);
  }
  if (lengths[0] !== lengths[1]) rejectPolicyState("invalid_evidence_ledger");
  const eligible = isCounter(version.eligibleOutcomes) ? version.eligibleOutcomes : 0;
  const shadow = isRecord(version.shadow) && isCounter(version.shadow.replayed)
    ? version.shadow.replayed
    : 0;
  if (lengths[0] < eligible + shadow) rejectPolicyState("invalid_evidence_ledger");
}

function validateCanaryStats(value: unknown): void {
  if (!isRecord(value)) rejectPolicyState("invalid_canary_stats");
  validateCounterSet(
    value,
    ["successCount", "failureCount"],
    "runs",
    "counter_mismatch",
  );
  validateCounterSet(
    value,
    ["productionSuccessCount", "productionFailureCount"],
    "productionRuns",
    "counter_mismatch",
  );
}

function validateHistory(value: unknown): void {
  if (!Array.isArray(value)) rejectPolicyState("invalid_history");
  for (const entry of value) {
    if (!isRecord(entry)) rejectPolicyState("invalid_history");
    if (typeof entry.at !== "string" || typeof entry.reason !== "string") {
      rejectPolicyState("invalid_history");
    }
    if (!isPolicyStage(entry.from) || !isPolicyStage(entry.to)) rejectPolicyState("invalid_history");
  }
}

function validateVersion(value: unknown, slot: keyof PolicyVersionStore): PolicyVersion | null {
  if (value === null) return null;
  if (!isRecord(value)) rejectPolicyState("invalid_version");
  if (typeof value.id !== "string" || value.id.length === 0) rejectPolicyState("invalid_version");
  if (!isCounter(value.version)) rejectPolicyState("invalid_version");
  if (!isPolicyStage(value.stage)) rejectPolicyState("invalid_stage");
  if (!isPolicyDomain(value.domain)) rejectPolicyState("invalid_domain");
  if (typeof value.rationale !== "string") rejectPolicyState("invalid_version");
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    rejectPolicyState("invalid_version");
  }
  validateSnapshot(value.snapshot);
  validatePatch(value.patch, value.domain);
  validateCounterSet(
    value,
    ["eligibleSuccessCount", "eligibleFailureCount"],
    "eligibleOutcomes",
    "counter_mismatch",
  );
  validateHistory(value.history);
  if (value.shadow !== undefined) validateShadow(value.shadow);
  if (value.qualificationEvidence !== undefined) {
    validateEvidenceLedger(value.qualificationEvidence, value);
  }
  if (value.canaryStats !== undefined) validateCanaryStats(value.canaryStats);

  if (value.stage === "shadow" && value.shadow === undefined) {
    rejectPolicyState("missing_shadow");
  }
  if (value.stage === "canary" && value.canaryStats === undefined) {
    rejectPolicyState("missing_canary_stats");
  }
  if (slot === "production" && value.stage !== "production") rejectPolicyState("invalid_stage");
  if (slot === "lastKnownGood" && value.stage !== "production") rejectPolicyState("invalid_stage");
  if (slot === "canary" && value.stage !== "canary") rejectPolicyState("invalid_stage");
  if (slot === "candidate" && !["candidate", "shadow", "canary"].includes(value.stage)) {
    rejectPolicyState("invalid_stage");
  }
  return value as unknown as PolicyVersion;
}

function validateStorePointerConsistency(store: {
  production: PolicyVersion | null;
  candidate: PolicyVersion | null;
  canary: PolicyVersion | null;
  lastKnownGood: PolicyVersion | null;
}): void {
  const { production, candidate, canary, lastKnownGood } = store;
  if (canary && !candidate) rejectPolicyState("pointer_mismatch");
  if (candidate?.stage === "canary" && !canary) rejectPolicyState("pointer_mismatch");
  if (canary && candidate && JSON.stringify(candidate) !== JSON.stringify(canary)) {
    rejectPolicyState("pointer_mismatch");
  }
  if (lastKnownGood && !production) rejectPolicyState("pointer_mismatch");

  const ids = new Map<string, string>();
  const versions = new Set<number>();
  for (const [slot, version] of [
    ["production", production],
    ["candidate", candidate],
    ["canary", canary],
    ["lastKnownGood", lastKnownGood],
  ] as const) {
    if (!version) continue;
    if (slot !== "canary" && ids.has(version.id)) rejectPolicyState("pointer_mismatch");
    ids.set(version.id, slot);
    if (slot !== "canary" && versions.has(version.version)) {
      rejectPolicyState("pointer_mismatch");
    }
    versions.add(version.version);
  }
  if (lastKnownGood && production && lastKnownGood.id === production.id) {
    rejectPolicyState("pointer_mismatch");
  }
  if (production && candidate && candidate.id === production.id) {
    rejectPolicyState("pointer_mismatch");
  }
  if (production && canary && canary.id === production.id) {
    rejectPolicyState("pointer_mismatch");
  }
}

function parsePolicyVersionStore(raw: unknown): PolicyVersionStore {
  if (!isRecord(raw)) rejectPolicyState("invalid_root");
  if (raw.schemaVersion !== 1) rejectPolicyState("unknown_schema");
  if (!isCounter(raw.nextVersion) || raw.nextVersion < 1) rejectPolicyState("invalid_next_version");
  for (const field of ["production", "candidate", "canary", "lastKnownGood"] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) rejectPolicyState("missing_slot");
  }

  const production = validateVersion(raw.production, "production");
  const candidate = validateVersion(raw.candidate, "candidate");
  const canary = validateVersion(raw.canary, "canary");
  const lastKnownGood = validateVersion(raw.lastKnownGood, "lastKnownGood");
  const parsed: PolicyVersionStore = {
    schemaVersion: 1,
    nextVersion: raw.nextVersion,
    production,
    candidate,
    canary,
    lastKnownGood,
  };
  validateStorePointerConsistency(parsed);
  let maxVersion = 0;
  for (const version of [production, candidate, canary, lastKnownGood]) {
    if (version) maxVersion = Math.max(maxVersion, version.version);
  }
  if (parsed.nextVersion <= maxVersion) rejectPolicyState("invalid_next_version");
  return parsed;
}

function restoreStagedPolicyMaps(snapshot: PolicySnapshot): void {
  const state = getLearnedPoolState();
  state.modelRoutingScoreDeltas.clear();
  state.stageModelRoutingScoreDeltas.clear();
  state.fallbackBoosts.clear();
  state.modelFirstTokenTimeouts.clear();
  state.recoveryPolicy.clear();
  applyPolicySnapshotToPool(snapshot, state);
}

function warnInvalidPolicyVersions(reason: string): void {
  console.warn(`[PolicyStaging] Ignoring invalid policy versions: ${reason}`);
}

export function policyVersionsPath(root: string = SESSIONS_DIR): string {
  return join(root, "self-tuning", "policy-versions.json");
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = `${path}.${suffix}.tmp`;
  const backup = `${path}.${suffix}.bak`;
  let backupCreated = false;
  let preserveBackup = false;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    try {
      renameSync(tmp, path);
    } catch {
      let movedExisting = false;
      if (existsSync(path)) {
        renameSync(path, backup);
        movedExisting = true;
        backupCreated = true;
      }
      try {
        renameSync(tmp, path);
      } catch (error) {
        if (movedExisting && !existsSync(path) && existsSync(backup)) {
          try {
            renameSync(backup, path);
          } catch {
            preserveBackup = true;
          }
        }
        throw error;
      }
      if (movedExisting) {
        try {
          unlinkSync(backup);
        } catch {
          preserveBackup = true;
        }
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      preserveBackup = true;
    }
    if (backupCreated && !preserveBackup) {
      try {
        unlinkSync(backup);
      } catch {
        preserveBackup = true;
      }
    }
  }
}

/** Persist production / candidate / canary / last-known-good so restarts keep rollback. */
export function persistPolicyVersions(root: string = SESSIONS_DIR): boolean {
  try {
    atomicWriteJson(policyVersionsPath(root), store);
    return true;
  } catch (e) {
    console.warn(
      `[PolicyStaging] Failed to persist: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * Re-merge the staged production snapshot into live learned-pool maps.
 *
 * Call after any path that clears inference-feedback maps (cron refresh /
 * loadInferenceFeedback / applyInferenceFeedback) so promoted routing /
 * budget / recovery keys survive in-process without requiring a restart.
 * Merge is additive for keys present in the snapshot; concurrent operational
 * feedback for other keys is preserved.
 */
export function reapplyProductionPolicySnapshot(): boolean {
  const production = store.production;
  if (!production?.snapshot) return false;
  applyPolicySnapshotToPool(production.snapshot);
  return true;
}

/** Load persisted policy versions. No-op when the file is missing. */
export function loadPolicyVersions(root: string = SESSIONS_DIR): boolean {
  const path = policyVersionsPath(root);
  if (!existsSync(path)) return true;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    warnInvalidPolicyVersions("invalid_json");
    return false;
  }

  let validated: PolicyVersionStore;
  try {
    validated = parsePolicyVersionStore(raw);
  } catch (error) {
    const reason = error instanceof PolicyVersionValidationError ? error.reason : "invalid_state";
    warnInvalidPolicyVersions(reason === "unknown_schema" ? reason : `invalid_state (${reason})`);
    return false;
  }

  const previousStore = store;
  const previousPool = snapshotStagedPolicyFields(getLearnedPoolState());
  const previousTheta = getGlobalTheta();
  try {
    store = validated;
    reapplyProductionPolicySnapshot();
  } catch {
    store = previousStore;
    restoreStagedPolicyMaps(previousPool);
    setGlobalTheta(previousTheta);
    warnInvalidPolicyVersions("apply_failed");
    return false;
  }
  return true;
}
