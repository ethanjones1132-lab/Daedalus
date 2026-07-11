/** Offline-only quality gate for promoting a trained or distilled candidate.
 *
 * This module deliberately has no model, filesystem, network, or tool-runtime
 * dependencies. A caller must provide redacted corpus rows and replay results;
 * a candidate cannot become primary merely because a heuristic score looks good.
 */

export interface PromotionCorpusRow {
  id?: string;
  agent_run_id?: string;
  session_id?: string;
  task_type?: string;
  user_request?: string;
  pipeline?: readonly string[];
  stage_runs?: readonly unknown[];
  model_attributions?: readonly unknown[];
  run_outcome?: string;
}

export interface ReplayResult {
  case_id: string;
  passed: boolean;
  baseline_score?: number;
  candidate_score?: number;
}

export interface PromotionGateInput {
  corpus: readonly PromotionCorpusRow[];
  replay: readonly ReplayResult[];
  min_replay_pass_rate?: number;
  max_regression_count?: number;
  regression_tolerance?: number;
}

export interface PromotionGateDecision {
  decision: "approve" | "reject";
  provenance_ok: boolean;
  replay_pass_rate: number;
  regression_count: number;
  reason: string;
}

function hasProvenance(row: PromotionCorpusRow): boolean {
  return Boolean(
    row.id?.trim() &&
      row.agent_run_id?.trim() &&
      row.session_id?.trim() &&
      row.task_type?.trim() &&
      row.user_request?.trim() &&
      Array.isArray(row.pipeline) &&
      row.pipeline.length > 0 &&
      Array.isArray(row.stage_runs) &&
      Array.isArray(row.model_attributions) &&
      ["success", "degraded", "failed"].includes(row.run_outcome ?? ""),
  );
}

export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateDecision {
  const provenanceOk = input.corpus.length > 0 && input.corpus.every(hasProvenance);
  if (!provenanceOk) {
    return {
      decision: "reject",
      provenance_ok: false,
      replay_pass_rate: 0,
      regression_count: 0,
      reason: "missing_provenance",
    };
  }

  if (input.replay.length === 0) {
    return {
      decision: "reject",
      provenance_ok: true,
      replay_pass_rate: 0,
      regression_count: 0,
      reason: "replay_missing",
    };
  }

  const tolerance = Math.max(0, input.regression_tolerance ?? 0.05);
  const regressions = input.replay.filter(
    (r) =>
      typeof r.baseline_score === "number" &&
      typeof r.candidate_score === "number" &&
      r.candidate_score < r.baseline_score - tolerance,
  ).length;
  const passRate = input.replay.filter((r) => r.passed).length / input.replay.length;
  const minimumPassRate = Math.min(1, Math.max(0, input.min_replay_pass_rate ?? 0.8));
  const maxRegressions = Math.max(0, input.max_regression_count ?? 0);

  if (regressions > maxRegressions) {
    return {
      decision: "reject",
      provenance_ok: true,
      replay_pass_rate: passRate,
      regression_count: regressions,
      reason: "replay_regression",
    };
  }
  if (passRate < minimumPassRate) {
    return {
      decision: "reject",
      provenance_ok: true,
      replay_pass_rate: passRate,
      regression_count: regressions,
      reason: "replay_failed",
    };
  }
  return {
    decision: "approve",
    provenance_ok: true,
    replay_pass_rate: passRate,
    regression_count: regressions,
    reason: "quality_gate_passed",
  };
}
