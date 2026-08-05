/**
 * Phase B — Scalar run reward (B1 + B2 anti-gaming + B3 calibration).
 *
 * Offline-computable from a stored snapshot. No model-judged component:
 * reviewer opinion is never a reward term.
 *
 * Terms (default equal weights; N/A terms re-normalize):
 *   writes — filesystem content delta on task-target / non-status paths
 *   check  — independent runtime CheckResult only (`existing` / `builtin`)
 *   plan   — objective plan-item verification counts
 *
 * B2 hard rules:
 *   - Status/log docs never credit writes unless they are explicit targets
 *   - Task targets required for credit when known
 *   - `synth` checks are runtime-authored → not independent → check term 0
 *   - Write-required + check declined (`none` / !ran / missing) → **score 0**
 *
 * B3 calibration:
 *   - Declared success when check did not pass → overclaim penalty
 *     (worse than an honest partial with the same base terms)
 *
 * Score range: [-1, 1] after B3 (base terms in [0, 1]).
 */

import type { CheckResult, CheckTier } from "./check-runner";
import type { WriteEffectObservation } from "./content-fingerprint";
import { hasContentDelta } from "./content-fingerprint";
import {
  countsTowardWriteEffect,
  isStatusOrLogDocPath,
  pathInTargetSet,
} from "./effect-gate";

export interface RunRewardWeights {
  writes: number;
  check: number;
  plan: number;
}

export const DEFAULT_RUN_REWARD_WEIGHTS: RunRewardWeights = {
  writes: 1,
  check: 1,
  plan: 1,
};

/** B3: subtracted when outcome claims success without a passing independent check. */
export const OVERCLAIM_PENALTY = 0.5;

/** Check tiers that count as an independent oracle (not runtime-authored). */
export const INDEPENDENT_CHECK_TIERS: ReadonlySet<CheckTier> = new Set([
  "existing",
  "builtin",
]);

export type DeclaredRunOutcome =
  | "success"
  | "degraded"
  | "failed"
  | "partial"
  | "cancelled";

export interface RunRewardWriteEvidence {
  changedPaths: string[];
  targetPaths?: string[];
  writeRequired: boolean;
}

export interface RunRewardPlanEvidence {
  itemsTotal: number;
  itemsVerified: number;
}

export interface RunRewardInput {
  writes: RunRewardWriteEvidence;
  check: Pick<CheckResult, "tier" | "ran" | "passed"> | null;
  plan?: RunRewardPlanEvidence | null;
  /**
   * Outcome the system is about to persist / declared to the user.
   * Used only for B3 overclaim detection — never as a positive reward term.
   */
  declaredOutcome?: DeclaredRunOutcome | null;
  weights?: Partial<RunRewardWeights>;
  /** When false, skip B2 hard-zero on declined check (tests / ablations). Default true. */
  antiGaming?: boolean;
  /** When false, skip B3 overclaim penalty. Default true. */
  calibration?: boolean;
}

export interface RunRewardBreakdown {
  /** Scalar in [-1, 1] after calibration; base composition is [0, 1]. */
  score: number;
  /** Pre-calibration weighted score in [0, 1]. */
  baseScore: number;
  terms: { writes: number; check: number; plan: number };
  weights: RunRewardWeights;
  creditedWritePaths: string[];
  notes: string[];
  /** B2: write-required run with declined/missing check → forced zero. */
  hardZero: boolean;
  hardZeroReason?: string;
  /** B3: claimed success without independent passing check. */
  overclaim: boolean;
  overclaimPenalty: number;
}

/**
 * Minimal offline snapshot — everything needed to recompute reward from a
 * stored run without re-executing tools or calling a model.
 */
export interface StoredRunRewardSnapshot {
  writeRequired: boolean;
  changedPaths: string[];
  targetPaths?: string[];
  check: Pick<CheckResult, "tier" | "ran" | "passed"> | null;
  plan?: RunRewardPlanEvidence | null;
  declaredOutcome?: DeclaredRunOutcome | null;
  weights?: Partial<RunRewardWeights>;
}

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/**
 * Build write evidence from recorded write-effect fingerprints (preferred).
 */
export function writeEvidenceFromEffects(
  effects: readonly WriteEffectObservation[],
  opts: { targetPaths?: string[]; writeRequired: boolean },
): RunRewardWriteEvidence {
  const changedPaths = effects.filter((e) => e.changed).map((e) => e.path);
  return {
    changedPaths,
    targetPaths: opts.targetPaths,
    writeRequired: opts.writeRequired,
  };
}

/**
 * Weaker fallback when fingerprints were not recorded.
 */
export function writeEvidenceFromToolCalls(
  toolCalls: ReadonlyArray<{
    name: string;
    is_error?: boolean;
    arguments?: Record<string, unknown>;
  }>,
  opts: { targetPaths?: string[]; writeRequired: boolean },
): RunRewardWriteEvidence {
  const changedPaths: string[] = [];
  for (const call of toolCalls) {
    if (call.is_error) continue;
    if (!WRITE_TOOL_NAMES.has(call.name)) continue;
    const p = call.arguments?.path ?? call.arguments?.file_path;
    if (typeof p === "string" && p.trim()) changedPaths.push(p);
  }
  return {
    changedPaths,
    targetPaths: opts.targetPaths,
    writeRequired: opts.writeRequired,
  };
}

/** Plan evidence from a TaskPlan-shaped ledger (objective verified counts only). */
export function planEvidenceFromItems(
  items: ReadonlyArray<{ status?: string; acceptanceChecks?: unknown[] }> | null | undefined,
): RunRewardPlanEvidence | null {
  if (!items || items.length === 0) return null;
  // Only items that had acceptance checks are objective.
  const withChecks = items.filter(
    (i) => Array.isArray(i.acceptanceChecks) && i.acceptanceChecks.length > 0,
  );
  if (withChecks.length === 0) return null;
  const verified = withChecks.filter((i) => i.status === "verified").length;
  return { itemsTotal: withChecks.length, itemsVerified: verified };
}

function computeWriteTerm(writes: RunRewardWriteEvidence): {
  term: number;
  credited: string[];
  applicable: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  if (!writes.writeRequired) {
    notes.push("write term N/A (not a write-required turn)");
    return { term: 0, credited: [], applicable: false, notes };
  }

  const targets = (writes.targetPaths ?? []).filter((p) => p.trim().length > 0);
  const targetOpt = targets.length > 0 ? targets : undefined;

  // B2: same filter as effect-gate — targets win; else status/log denylist.
  const credited = writes.changedPaths.filter((path) =>
    countsTowardWriteEffect(path, targetOpt),
  );

  if (credited.length === 0 && writes.changedPaths.length > 0) {
    const onlyStatus = writes.changedPaths.every((p) => isStatusOrLogDocPath(p));
    notes.push(
      onlyStatus
        ? "writes landed only on status/log docs (B2: not credited)"
        : targetOpt
          ? `writes landed but none matched task targets (${writes.changedPaths.length} non-target)`
          : "writes landed but none credited",
    );
  }

  if (credited.length === 0) {
    notes.push("write-required turn with zero credited content deltas");
    return { term: 0, credited: [], applicable: true, notes };
  }

  notes.push(`credited ${credited.length} write path(s)`);
  return { term: 1, credited, applicable: true, notes };
}

/**
 * Independent check term. `synth` is runtime-authored → never full credit.
 */
function computeCheckTerm(
  check: RunRewardInput["check"],
): { term: number; applicable: boolean; notes: string[]; independentPass: boolean; declined: boolean } {
  const notes: string[] = [];
  if (!check) {
    notes.push("check term N/A (no CheckResult on run)");
    return { term: 0, applicable: false, notes, independentPass: false, declined: true };
  }

  if (check.tier === "none" || !check.ran) {
    notes.push(`check declined (tier=${check.tier}, ran=${check.ran})`);
    return { term: 0, applicable: true, notes, independentPass: false, declined: true };
  }

  if (check.tier === "synth") {
    // B2: oracle the runtime authored is not independent.
    notes.push("check term 0 (synth tier is runtime-authored, not independent)");
    return {
      term: 0,
      applicable: true,
      notes,
      independentPass: false,
      declined: false,
    };
  }

  if (!INDEPENDENT_CHECK_TIERS.has(check.tier)) {
    notes.push(`check term 0 (unrecognized tier=${check.tier})`);
    return { term: 0, applicable: true, notes, independentPass: false, declined: true };
  }

  if (check.passed === true) {
    notes.push(`independent check passed (tier=${check.tier})`);
    return { term: 1, applicable: true, notes, independentPass: true, declined: false };
  }
  if (check.passed === false) {
    notes.push(`independent check failed (tier=${check.tier})`);
    return { term: 0, applicable: true, notes, independentPass: false, declined: false };
  }
  notes.push("check term 0 (check ran but produced no pass/fail)");
  return { term: 0, applicable: true, notes, independentPass: false, declined: true };
}

function computePlanTerm(
  plan: RunRewardPlanEvidence | null | undefined,
): { term: number; applicable: boolean; notes: string[] } {
  const notes: string[] = [];
  if (!plan || plan.itemsTotal <= 0) {
    notes.push("plan term N/A (no objective plan items)");
    return { term: 0, applicable: false, notes };
  }
  const verified = Math.max(0, Math.min(plan.itemsVerified, plan.itemsTotal));
  const term = clamp01(verified / plan.itemsTotal);
  notes.push(`plan ${verified}/${plan.itemsTotal} verified`);
  return { term, applicable: true, notes };
}

/**
 * Compute Phase B scalar run reward. Deterministic and pure.
 */
export function computeRunReward(input: RunRewardInput): RunRewardBreakdown {
  const antiGaming = input.antiGaming !== false;
  const calibration = input.calibration !== false;

  const baseWeights: RunRewardWeights = {
    writes: input.weights?.writes ?? DEFAULT_RUN_REWARD_WEIGHTS.writes,
    check: input.weights?.check ?? DEFAULT_RUN_REWARD_WEIGHTS.check,
    plan: input.weights?.plan ?? DEFAULT_RUN_REWARD_WEIGHTS.plan,
  };

  const w = computeWriteTerm(input.writes);
  const c = computeCheckTerm(input.check);
  const p = computePlanTerm(input.plan);

  // B2: write-required + declined/missing check → hard zero (none never profitable).
  let hardZero = false;
  let hardZeroReason: string | undefined;
  if (antiGaming && input.writes.writeRequired && c.declined) {
    hardZero = true;
    hardZeroReason =
      "B2: write-required turn with declined/missing check — score forced to 0 (check_tier none must not be profitable)";
  }

  const raw: RunRewardWeights = {
    writes: w.applicable ? Math.max(0, baseWeights.writes) : 0,
    check: c.applicable ? Math.max(0, baseWeights.check) : 0,
    plan: p.applicable ? Math.max(0, baseWeights.plan) : 0,
  };
  const sum = raw.writes + raw.check + raw.plan;
  const weights: RunRewardWeights =
    sum > 0
      ? { writes: raw.writes / sum, check: raw.check / sum, plan: raw.plan / sum }
      : { writes: 0, check: 0, plan: 0 };

  const terms = { writes: w.term, check: c.term, plan: p.term };

  let baseScore =
    sum > 0
      ? clamp01(
        terms.writes * weights.writes
          + terms.check * weights.check
          + terms.plan * weights.plan,
      )
      : 0;

  if (hardZero) baseScore = 0;

  // B3: overclaim = declared success without independent passing check.
  const declared = input.declaredOutcome ?? null;
  const overclaim =
    calibration
    && declared === "success"
    && !c.independentPass;
  const overclaimPenalty = overclaim ? OVERCLAIM_PENALTY : 0;
  let score = baseScore;
  if (overclaim) {
    // Harder than honest partial: base may be >0 (writes), but success claim
    // without check is driven below an equivalent honest partial.
    score = clamp(baseScore - OVERCLAIM_PENALTY, -1, 1);
  }

  const notes = [
    ...w.notes,
    ...c.notes,
    ...p.notes,
    ...(hardZero && hardZeroReason ? [hardZeroReason] : []),
    ...(overclaim
      ? [
        `B3 overclaim: declared success without independent passing check (−${OVERCLAIM_PENALTY})`,
      ]
      : []),
    sum === 0 && !hardZero
      ? "no applicable reward terms (score 0)"
      : `baseScore=${baseScore.toFixed(4)} score=${score.toFixed(4)}`,
  ];

  return {
    score,
    baseScore,
    terms,
    weights,
    creditedWritePaths: w.credited,
    notes,
    hardZero,
    hardZeroReason,
    overclaim,
    overclaimPenalty,
  };
}

/**
 * Offline replay: same pure function, explicit snapshot shape.
 * Guarantees: identical snapshot → identical breakdown (byte-stable fields).
 */
export function computeRunRewardFromStored(
  snapshot: StoredRunRewardSnapshot,
): RunRewardBreakdown {
  return computeRunReward({
    writes: {
      changedPaths: snapshot.changedPaths,
      targetPaths: snapshot.targetPaths,
      writeRequired: snapshot.writeRequired,
    },
    check: snapshot.check,
    plan: snapshot.plan,
    declaredOutcome: snapshot.declaredOutcome,
    weights: snapshot.weights,
  });
}

export function computeRunRewardFromEffects(input: {
  effects: readonly WriteEffectObservation[];
  check: RunRewardInput["check"];
  plan?: RunRewardPlanEvidence | null;
  targetPaths?: string[];
  writeRequired: boolean;
  declaredOutcome?: DeclaredRunOutcome | null;
  weights?: Partial<RunRewardWeights>;
}): RunRewardBreakdown {
  return computeRunReward({
    writes: writeEvidenceFromEffects(input.effects, {
      targetPaths: input.targetPaths,
      writeRequired: input.writeRequired,
    }),
    check: input.check,
    plan: input.plan,
    declaredOutcome: input.declaredOutcome,
    weights: input.weights,
  });
}

/**
 * Build a portable snapshot from live turn evidence (for persist + replay).
 */
export function buildStoredRunRewardSnapshot(input: {
  writeRequired: boolean;
  effects?: readonly WriteEffectObservation[] | null;
  toolCalls?: ReadonlyArray<{
    name: string;
    is_error?: boolean;
    arguments?: Record<string, unknown>;
  }> | null;
  targetPaths?: string[];
  check: RunRewardInput["check"];
  plan?: RunRewardPlanEvidence | null;
  declaredOutcome?: DeclaredRunOutcome | null;
  weights?: Partial<RunRewardWeights>;
}): StoredRunRewardSnapshot {
  const writes =
    input.effects && input.effects.length > 0
      ? writeEvidenceFromEffects(input.effects, {
        targetPaths: input.targetPaths,
        writeRequired: input.writeRequired,
      })
      : writeEvidenceFromToolCalls(input.toolCalls ?? [], {
        targetPaths: input.targetPaths,
        writeRequired: input.writeRequired,
      });
  return {
    writeRequired: input.writeRequired,
    changedPaths: writes.changedPaths,
    targetPaths: input.targetPaths,
    check: input.check,
    plan: input.plan ?? null,
    declaredOutcome: input.declaredOutcome ?? null,
    weights: input.weights,
  };
}

/** Serialize breakdown for agent_runs.reward_json (stable field order). */
export function serializeRunRewardBreakdown(b: RunRewardBreakdown): string {
  return JSON.stringify({
    score: b.score,
    baseScore: b.baseScore,
    terms: b.terms,
    weights: b.weights,
    creditedWritePaths: b.creditedWritePaths,
    hardZero: b.hardZero,
    hardZeroReason: b.hardZeroReason ?? null,
    overclaim: b.overclaim,
    overclaimPenalty: b.overclaimPenalty,
    notes: b.notes,
  });
}

export { hasContentDelta, pathInTargetSet, isStatusOrLogDocPath };
