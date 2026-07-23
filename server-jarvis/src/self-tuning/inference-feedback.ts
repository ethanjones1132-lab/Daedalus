/**
 * Operational inference-feedback loader.
 *
 * Domain ownership:
 * - This path is **immediate operational feedback** from the cron-produced
 *   inference-feedback report (routing score deltas, stage adjustments,
 *   empirical first-token budgets, model capability nudges). It is NOT the
 *   staged shadow→canary→promote lifecycle.
 * - Explicit staged proposals for routing / budget / recovery go through
 *   `ConductorLearningLoop.proposeStagedPolicy` → policy-staging holdback.
 * - Instruction A/B and per-agent capability deltas remain immediate via
 *   conductor-learning (optimizeAndApply / selectInstructionVariants).
 *
 * Promote/rollback of staged policy merges keys into the same maps without
 * clobbering concurrent operational feedback for keys outside the snapshot.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearInferenceFeedbackState, getLearnedPoolState } from "./learned-pool-state";

export interface FeedbackApplyResult {
  applied: number;
  ignored: number;
  reason?: "missing" | "invalid" | "expired";
}

export function inferenceFeedbackPath(): string {
  return join(homedir(), ".openclaw", "jarvis", "inference-feedback.json");
}

function finiteClamped(value: unknown, low: number, high: number): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(low, Math.min(high, numeric));
}

/**
 * Apply operational inference-feedback into live learned-pool maps immediately.
 * Staged policy proposals must not use this path — use proposeStagedPolicy.
 */
export function applyInferenceFeedback(
  value: unknown,
  options: { now?: Date } = {},
): FeedbackApplyResult {
  clearInferenceFeedbackState();
  if (!value || typeof value !== "object") return { applied: 0, ignored: 0, reason: "invalid" };
  const report = value as Record<string, any>;
  if (report.schema_version !== 1 || !report.routing_policy?.model_adjustments) {
    return { applied: 0, ignored: 0, reason: "invalid" };
  }
  const expiresAt = Date.parse(String(report.expires_at ?? ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? new Date()).getTime()) {
    return { applied: 0, ignored: 0, reason: "expired" };
  }

  const state = getLearnedPoolState();
  const minSamples = Math.max(1, Number(report.routing_policy.min_samples) || 1);
  let applied = 0;
  let ignored = 0;
  for (const [key, raw] of Object.entries(report.routing_policy.model_adjustments as Record<string, any>)) {
    if (!key.includes(":") || !raw || typeof raw !== "object" || Number(raw.sample_count) < minSamples) {
      ignored += 1;
      continue;
    }
    const routing = finiteClamped(raw.routing_score_delta, -0.25, 0.15);
    const speed = finiteClamped(raw.speed_capability_delta, -0.15, 0.10);
    const reliability = finiteClamped(raw.reliability_capability_delta, -0.15, 0.10);
    const firstToken = finiteClamped(raw.first_token_timeout_ms, 1_000, 55_000);
    if (routing !== undefined) state.modelRoutingScoreDeltas.set(key, routing);
    const deltas: Record<string, number> = {};
    if (speed !== undefined) deltas.speed = speed;
    if (reliability !== undefined) deltas.json_reliability = reliability;
    if (Object.keys(deltas).length > 0) state.modelCapabilityDeltas.set(key, deltas);
    if (firstToken !== undefined) state.modelFirstTokenTimeouts.set(key, firstToken);
    applied += 1;
  }
  for (const [key, raw] of Object.entries(report.routing_policy.stage_adjustments ?? {})) {
    if (key.split(":").length < 3 || !raw || typeof raw !== "object") {
      ignored += 1;
      continue;
    }
    const stageAdj = raw as Record<string, unknown>;
    const sampleCount = Number(stageAdj.sample_count);
    if (!Number.isFinite(sampleCount) || sampleCount < minSamples) {
      ignored += 1;
      continue;
    }
    const routing = finiteClamped(stageAdj.routing_score_delta, -0.25, 0.15);
    if (routing !== undefined) state.stageModelRoutingScoreDeltas.set(key, routing);
    applied += 1;
  }
  return { applied, ignored, reason: undefined };
}

export function loadInferenceFeedback(path = inferenceFeedbackPath()): FeedbackApplyResult {
  if (!existsSync(path)) {
    clearInferenceFeedbackState();
    return { applied: 0, ignored: 0, reason: "missing" };
  }
  try {
    return applyInferenceFeedback(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    clearInferenceFeedbackState();
    return { applied: 0, ignored: 0, reason: "invalid" };
  }
}
