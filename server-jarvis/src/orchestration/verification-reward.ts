import type { CheckResult } from "./check-runner";

export type VerifiedVia = "runtime_check" | "synth" | "reviewer" | "heuristic";

export interface RewardMapping {
  outcomeFloor: "success" | "degraded" | "failed" | null;
  verifiedVia: VerifiedVia;
  checkTier: CheckResult["tier"];
  rewardWeight: number;
}

export function mapCheckToReward(
  check: CheckResult,
  weights: { existing: number; builtin: number; synth: number; none: number },
  reviewerConfirmed: boolean,
): RewardMapping {
  if (check.tier === "none" || !check.ran) {
    return { outcomeFloor: null, verifiedVia: "heuristic", checkTier: check.tier, rewardWeight: 0 };
  }
  if (check.passed === false) {
    return { outcomeFloor: "failed", verifiedVia: "runtime_check", checkTier: check.tier, rewardWeight: 0 };
  }
  if (check.tier === "synth") {
    return reviewerConfirmed
      ? { outcomeFloor: "success", verifiedVia: "reviewer", checkTier: "synth", rewardWeight: weights.synth }
      : { outcomeFloor: "degraded", verifiedVia: "synth", checkTier: "synth", rewardWeight: weights.synth };
  }
  return {
    outcomeFloor: "success",
    verifiedVia: "runtime_check",
    checkTier: check.tier,
    rewardWeight: check.tier === "existing" ? weights.existing : weights.builtin,
  };
}
