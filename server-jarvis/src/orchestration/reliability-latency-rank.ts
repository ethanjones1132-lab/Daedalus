/**
 * M5 — Latency- and reliability-aware model ranking.
 *
 * Pure helper used by stage model selection. Inputs are measured stats from
 * ModelScorecard / model_attributions (first_token_ms, was_successful, had_error).
 *
 * Policy:
 *   1. Refuse models with sampleCount >= MIN_SAMPLES whose p50 first_token_ms
 *      exceeds the remaining stage budget (they cannot win the race).
 *   2. Rank survivors by successRate / max(p50_ms, 1) — prefer models that
 *      both succeed and stream quickly, not just the cheapest tier pin.
 *
 * Models below MIN_SAMPLES are never refused for latency (insufficient data)
 * and still participate in ranking with whatever successRate / p50 we have.
 */

/** Aligns with ModelScorecard's grading floor and TRIAL_SAMPLE_TARGET. */
export const RELIABILITY_LATENCY_MIN_SAMPLES = 6;

export interface ReliabilityLatencyEntry {
  /** `provider:model_id` (or any stable pool key). */
  key: string;
  sampleCount: number;
  /** 0..1 fraction of successful attempts. */
  successRate: number;
  /** p50 first-token latency in ms when known. */
  p50FirstTokenMs?: number;
}

/**
 * Score used for ranking: successRate / max(p50_ms, 1).
 * Missing p50 is treated as 1 so unmeasured models are not artificially
 * demoted below every measured slow model — callers that need a neutral
 * unknown should omit the entry entirely rather than pass p50=undefined
 * with a high sampleCount.
 */
export function reliabilityLatencyScore(entry: ReliabilityLatencyEntry): number {
  const p50 =
    typeof entry.p50FirstTokenMs === "number" && Number.isFinite(entry.p50FirstTokenMs)
      ? Math.max(entry.p50FirstTokenMs, 1)
      : 1;
  const rate =
    typeof entry.successRate === "number" && Number.isFinite(entry.successRate)
      ? Math.min(1, Math.max(0, entry.successRate))
      : 0;
  return rate / p50;
}

/**
 * Drop models that cannot meet the remaining stage budget, then rank by
 * reliability/latency score (highest first). Stable on ties (key ASC).
 *
 * When `remainingStageMs` is null/undefined/non-finite, no latency refuse
 * is applied — only ranking.
 */
export function rankModelsByReliabilityLatency(
  entries: readonly ReliabilityLatencyEntry[],
  remainingStageMs?: number | null,
): ReliabilityLatencyEntry[] {
  const budget =
    typeof remainingStageMs === "number" && Number.isFinite(remainingStageMs)
      ? remainingStageMs
      : undefined;

  const survivors = entries.filter((entry) => {
    if (budget === undefined) return true;
    if (entry.sampleCount < RELIABILITY_LATENCY_MIN_SAMPLES) return true;
    if (
      typeof entry.p50FirstTokenMs !== "number"
      || !Number.isFinite(entry.p50FirstTokenMs)
    ) {
      return true;
    }
    return entry.p50FirstTokenMs <= budget;
  });

  return [...survivors].sort((a, b) => {
    const scoreDelta = reliabilityLatencyScore(b) - reliabilityLatencyScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    // Prefer more samples on equal score (more trustworthy), then key.
    if (b.sampleCount !== a.sampleCount) return b.sampleCount - a.sampleCount;
    return a.key.localeCompare(b.key);
  });
}

/**
 * Keys of models refused solely because p50 first_token exceeds remaining budget.
 * Useful for building exclude sets / logging without re-ranking.
 */
export function refusedForStageBudget(
  entries: readonly ReliabilityLatencyEntry[],
  remainingStageMs?: number | null,
): Set<string> {
  const budget =
    typeof remainingStageMs === "number" && Number.isFinite(remainingStageMs)
      ? remainingStageMs
      : undefined;
  const refused = new Set<string>();
  if (budget === undefined) return refused;
  for (const entry of entries) {
    if (entry.sampleCount < RELIABILITY_LATENCY_MIN_SAMPLES) continue;
    if (
      typeof entry.p50FirstTokenMs !== "number"
      || !Number.isFinite(entry.p50FirstTokenMs)
    ) {
      continue;
    }
    if (entry.p50FirstTokenMs > budget) refused.add(entry.key);
  }
  return refused;
}
