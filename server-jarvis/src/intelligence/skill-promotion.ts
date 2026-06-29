import type { SkillDistillationConfig } from "../config";
import type { SkillCandidate } from "./skill-types";
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

export function evaluateSkillPromotion(
  candidate: SkillCandidate,
  config: SkillDistillationConfig,
): { promote: boolean; score: number; baseline: number } {
  const score = scoreSkillCandidate(candidate);
  const baseline = 0.5;
  const delta = score - baseline;
  return {
    promote: delta >= config.promotion_eval_delta && candidate.status === "candidate",
    score,
    baseline,
  };
}

export function runSkillPromotionPass(config: SkillDistillationConfig): SkillCandidate[] {
  if (!config.enabled) return [];
  const promoted: SkillCandidate[] = [];
  for (const candidate of listSkillCandidates("candidate")) {
    const verdict = evaluateSkillPromotion(candidate, config);
    if (verdict.promote) {
      const updated = updateSkillCandidateStatus(candidate.id, "promoted", verdict.score);
      if (updated) promoted.push(updated);
    }
  }
  return promoted;
}