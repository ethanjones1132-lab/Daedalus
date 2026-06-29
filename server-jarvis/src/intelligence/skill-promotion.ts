import type { SkillDistillationConfig } from "../config";
import type { SkillCandidate, SkillRejectionReason } from "./skill-types";
import { listSkillCandidates, updateSkillCandidateStatus } from "./skill-store";

/** Deterministic eval proxy until live replay harness covers distilled skills. */
export function scoreSkillCandidate(candidate: SkillCandidate): number {
  let score = candidate.confidence;
  if (candidate.body.includes("## Conductor worker guidance")) score += 0.05;
  if (candidate.trigger.signals.length >= 2) score += 0.03;
  if (candidate.body.length > 400 && candidate.body.length < 4000) score += 0.02;
  // Penalize likely hallucinated absolute paths not grounded in source runs.
  const suspiciousPaths = (candidate.body.match(/\b[A-Z]:\\|\b\/etc\/|\b\/usr\//g) ?? []).length;
  if (suspiciousPaths > 2) score -= 0.15;
  return Math.max(0, Math.min(1, score));
}

export interface SkillPromotionVerdict {
  promote: boolean;
  score: number;
  baseline: number;
  /**
   * Why the candidate was not promoted, if applicable. Absent when
   * `promote === true` (or when the verdict is "wrong_status" but the
   * candidate was already a non-candidate, in which case promotion
   * shouldn't be re-attempted).
   */
  reason?: SkillRejectionReason;
  detail?: string;
}

/**
 * Evaluate a candidate for promotion and return a structured verdict
 * including the reason for rejection. The reason is stable, machine-
 * typed, and human-readable via `detail` so it can be logged, returned
 * over HTTP, and shown in the operator UI without re-deriving it.
 */
export function evaluateSkillPromotion(
  candidate: SkillCandidate,
  config: SkillDistillationConfig,
): SkillPromotionVerdict {
  if (candidate.status !== "candidate") {
    return {
      promote: false,
      score: candidate.eval_score ?? scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "wrong_status",
      detail: `candidate status is "${candidate.status}", not "candidate"`,
    };
  }
  if (candidate.confidence < config.min_confidence) {
    return {
      promote: false,
      score: candidate.confidence,
      baseline: 0.5,
      reason: "low_confidence",
      detail: `confidence ${candidate.confidence.toFixed(3)} < min_confidence ${config.min_confidence}`,
    };
  }
  if (candidate.trigger.signals.length === 0) {
    return {
      promote: false,
      score: candidate.confidence,
      baseline: 0.5,
      reason: "missing_signals",
      detail: "trigger has no signals — would match every turn, unsafe to promote",
    };
  }
  if (candidate.body.length <= 400 || candidate.body.length >= 4000) {
    return {
      promote: false,
      score: scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "body_length_out_of_range",
      detail: `body length ${candidate.body.length} outside 400..4000 sweet spot`,
    };
  }
  const suspiciousPaths = (candidate.body.match(/\b[A-Z]:\\|\b\/etc\/|\b\/usr\//g) ?? []).length;
  if (suspiciousPaths > 2) {
    return {
      promote: false,
      score: scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "suspicious_paths",
      detail: `${suspiciousPaths} absolute/rooted paths in body — likely hallucinated`,
    };
  }
  const score = scoreSkillCandidate(candidate);
  const baseline = 0.5;
  const delta = score - baseline;
  if (delta < config.promotion_eval_delta) {
    return {
      promote: false,
      score,
      baseline,
      reason: "below_eval_delta",
      detail: `score delta ${delta.toFixed(3)} < promotion_eval_delta ${config.promotion_eval_delta}`,
    };
  }
  return { promote: true, score, baseline };
}

export interface SkillPromotionPassResult {
  promoted: SkillCandidate[];
  rejected: SkillCandidate[];
  total_evaluated: number;
}

export function runSkillPromotionPass(
  config: SkillDistillationConfig,
): SkillPromotionPassResult {
  const result: SkillPromotionPassResult = { promoted: [], rejected: [], total_evaluated: 0 };
  if (!config.enabled) return result;
  for (const candidate of listSkillCandidates("candidate")) {
    result.total_evaluated += 1;
    const verdict = evaluateSkillPromotion(candidate, config);
    if (verdict.promote) {
      const updated = updateSkillCandidateStatus(candidate.id, "promoted", verdict.score);
      if (updated) result.promoted.push(updated);
      continue;
    }
    // Persist the rejection so the operator can diagnose why a candidate
    // didn't promote and so the next pass doesn't re-evaluate it. Clear
    // the stale rejection_reason if the candidate was previously
    // rejected and is now being re-evaluated (only happens after a
    // manual status reset, which is rare but supported).
    if (verdict.reason) {
      const updated = updateSkillCandidateStatus(
        candidate.id,
        "rejected",
        verdict.score,
        verdict.reason,
        verdict.detail,
      );
      if (updated) result.rejected.push(updated);
    }
  }
  return result;
}