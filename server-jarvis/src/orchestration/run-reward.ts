/**
 * Phase B1 — Single scalar run reward, ground truth only.
 *
 * Offline-computable from a stored run (write effects, CheckResult, plan
 * ledger counts). No model-judged component: reviewer opinion is not a term.
 *
 * Composition (default equal weights, re-normalized when a term is N/A):
 *   writes — filesystem content delta (not "the model said it wrote")
 *   check  — runtime build/test CheckResult only
 *   plan   — plan items verified by acceptance checks (objective counts)
 *
 * B2 hooks already present: `check_tier: none` / !ran → check term 0 so
 * declining checks cannot be profitable; optional targetPaths for write credit.
 */

import type { CheckResult } from "./check-runner";
import type { WriteEffectObservation } from "./content-fingerprint";
import { hasContentDelta } from "./content-fingerprint";

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

export interface RunRewardWriteEvidence {
  /**
   * Absolute or workspace-relative paths that actually changed on disk
   * (before/after fingerprint delta). Empty when nothing landed.
   */
  changedPaths: string[];
  /**
   * When set, only these paths credit the write term (task targets).
   * Writing NOTES.md or other non-targets does not count.
   */
  targetPaths?: string[];
  /**
   * Write-intent / full_execution turns require a content delta.
   * When false, the write term is N/A (weight dropped, others re-normalized).
   */
  writeRequired: boolean;
}

export interface RunRewardPlanEvidence {
  /** Total plan items that had objective acceptance criteria. */
  itemsTotal: number;
  /** Items whose acceptance checks passed (not reviewer prose). */
  itemsVerified: number;
}

export interface RunRewardInput {
  writes: RunRewardWriteEvidence;
  /**
   * Runtime check only. Pass null when no check was attached to the run.
   * Reviewer confirmation is intentionally not an input.
   */
  check: Pick<CheckResult, "tier" | "ran" | "passed"> | null;
  plan?: RunRewardPlanEvidence | null;
  weights?: Partial<RunRewardWeights>;
}

export interface RunRewardBreakdown {
  /** Scalar in [0, 1]. */
  score: number;
  /** Per-term scores in [0, 1] before weighting. */
  terms: { writes: number; check: number; plan: number };
  /** Effective weights after N/A re-normalization (sum to 1, or all 0). */
  weights: RunRewardWeights;
  /** Paths that counted toward the write term. */
  creditedWritePaths: string[];
  /** Human-readable notes for telemetry / anti-gaming audit. */
  notes: string[];
}

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function pathMatchesTarget(changed: string, target: string): boolean {
  const c = normPath(changed);
  const t = normPath(target);
  return c === t || c.endsWith("/" + t) || c.endsWith(t) || t.endsWith("/" + c) || t.endsWith(c);
}

/**
 * Build write evidence from recorded write-effect fingerprints (preferred).
 */
export function writeEvidenceFromEffects(
  effects: readonly WriteEffectObservation[],
  opts: { targetPaths?: string[]; writeRequired: boolean },
): RunRewardWriteEvidence {
  const changedPaths = effects
    .filter((e) => e.changed)
    .map((e) => e.path);
  return {
    changedPaths,
    targetPaths: opts.targetPaths,
    writeRequired: opts.writeRequired,
  };
}

/**
 * Weaker fallback when fingerprints were not recorded: successful write tool
 * names only. Prefer writeEvidenceFromEffects — tool success is not a content
 * delta proof if the handler lied, but our handlers only report success after
 * a real write.
 */
export function writeEvidenceFromToolCalls(
  toolCalls: ReadonlyArray<{ name: string; is_error?: boolean; arguments?: Record<string, unknown> }>,
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
  let credited: string[];
  if (targets.length > 0) {
    credited = writes.changedPaths.filter((c) =>
      targets.some((t) => pathMatchesTarget(c, t)),
    );
    if (credited.length === 0 && writes.changedPaths.length > 0) {
      notes.push(
        `writes landed but none matched task targets (${writes.changedPaths.length} non-target change(s))`,
      );
    }
  } else {
    credited = [...writes.changedPaths];
  }

  if (credited.length === 0) {
    notes.push("write-required turn with zero credited content deltas");
    return { term: 0, credited: [], applicable: true, notes };
  }

  // Any credited target write is full write credit for B1 (binary).
  // Fractional credit can come later if multi-target plans need it.
  notes.push(`credited ${credited.length} write path(s)`);
  return { term: 1, credited, applicable: true, notes };
}

function computeCheckTerm(
  check: RunRewardInput["check"],
): { term: number; applicable: boolean; notes: string[] } {
  const notes: string[] = [];
  if (!check) {
    notes.push("check term N/A (no CheckResult on run)");
    return { term: 0, applicable: false, notes };
  }
  // Always applicable when a check object exists: declining / none scores 0
  // so the optimizer cannot farm "skip checks" (B2 foundation).
  if (check.tier === "none" || !check.ran) {
    notes.push(`check term 0 (tier=${check.tier}, ran=${check.ran})`);
    return { term: 0, applicable: true, notes };
  }
  if (check.passed === true) {
    notes.push(`check passed (tier=${check.tier})`);
    return { term: 1, applicable: true, notes };
  }
  if (check.passed === false) {
    notes.push(`check failed (tier=${check.tier})`);
    return { term: 0, applicable: true, notes };
  }
  // passed === null: detected but could not run — same as decline for reward
  notes.push("check term 0 (check detected but did not produce pass/fail)");
  return { term: 0, applicable: true, notes };
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
 * Compute the B1 scalar run reward. Deterministic and pure.
 */
export function computeRunReward(input: RunRewardInput): RunRewardBreakdown {
  const base: RunRewardWeights = {
    writes: input.weights?.writes ?? DEFAULT_RUN_REWARD_WEIGHTS.writes,
    check: input.weights?.check ?? DEFAULT_RUN_REWARD_WEIGHTS.check,
    plan: input.weights?.plan ?? DEFAULT_RUN_REWARD_WEIGHTS.plan,
  };

  const w = computeWriteTerm(input.writes);
  const c = computeCheckTerm(input.check);
  const p = computePlanTerm(input.plan);

  const raw: RunRewardWeights = {
    writes: w.applicable ? Math.max(0, base.writes) : 0,
    check: c.applicable ? Math.max(0, base.check) : 0,
    plan: p.applicable ? Math.max(0, base.plan) : 0,
  };
  const sum = raw.writes + raw.check + raw.plan;
  const weights: RunRewardWeights =
    sum > 0
      ? { writes: raw.writes / sum, check: raw.check / sum, plan: raw.plan / sum }
      : { writes: 0, check: 0, plan: 0 };

  const terms = {
    writes: w.term,
    check: c.term,
    plan: p.term,
  };

  const score =
    sum > 0
      ? clamp01(
        terms.writes * weights.writes
          + terms.check * weights.check
          + terms.plan * weights.plan,
      )
      : 0;

  const notes = [
    ...w.notes,
    ...c.notes,
    ...p.notes,
    sum === 0 ? "no applicable reward terms (score 0)" : `weighted score=${score.toFixed(4)}`,
  ];

  return {
    score,
    terms,
    weights,
    creditedWritePaths: w.credited,
    notes,
  };
}

/**
 * Convenience: compute reward when write effects were captured on the run.
 * Prefer this over tool-call inference.
 */
export function computeRunRewardFromEffects(input: {
  effects: readonly WriteEffectObservation[];
  check: RunRewardInput["check"];
  plan?: RunRewardPlanEvidence | null;
  targetPaths?: string[];
  writeRequired: boolean;
  weights?: Partial<RunRewardWeights>;
}): RunRewardBreakdown {
  return computeRunReward({
    writes: writeEvidenceFromEffects(input.effects, {
      targetPaths: input.targetPaths,
      writeRequired: input.writeRequired,
    }),
    check: input.check,
    plan: input.plan,
    weights: input.weights,
  });
}

/** True when any observation shows a real content delta (re-export helper). */
export { hasContentDelta };
