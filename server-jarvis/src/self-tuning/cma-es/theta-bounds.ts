/**
 * Per-dimension box constraints for the 43-dim orchestration policy vector θ.
 *
 * `mergeTheta`/`vectorToTheta` only check `Number.isFinite`, so the optimizer
 * owns domain validity: every candidate produced by sep-CMA-ES is projected
 * through `projectToBounds` before it is ever converted back to a theta.
 *
 * Bounds were set dimension-by-dimension against BASELINE_THETA
 * (orchestration-policy.ts), not by a generic formula:
 *  - ratios clamp to [0, 1];
 *  - integer counts/caps round and floor at 0 only where 0 is a meaningful
 *    "disable" (caps), otherwise at 1 (thresholds that must fire);
 *  - millisecond budgets floor above a real minimum — a 0/negative timeout
 *    would crash a rollout outright, not just underperform;
 *  - cross-field invariant: reserved_mid_loop_escalations <=
 *    max_mid_loop_escalations (enforced in projectToBounds).
 */

import {
  THETA_KEYS,
  type OrchestrationTheta,
} from "../../orchestration/orchestration-policy";

export interface ThetaBound {
  min: number;
  max: number;
  kind: "integer" | "ratio01" | "ms" | "count";
}

export const THETA_BOUNDS: Record<keyof OrchestrationTheta, ThetaBound> = {
  // Write pressure / mid-loop
  force_write_nudge_cap: { min: 0, max: 8, kind: "count" },
  max_quality_pushes: { min: 0, max: 6, kind: "count" },
  max_mid_loop_checks: { min: 0, max: 8, kind: "count" },
  max_mid_loop_escalations: { min: 1, max: 8, kind: "count" },
  reserved_mid_loop_escalations: { min: 0, max: 4, kind: "count" },
  mid_loop_endgame_budget_ms: { min: 5_000, max: 180_000, kind: "ms" },
  mid_loop_endgame_turn_ratio: { min: 0, max: 1, kind: "ratio01" },
  // Directives / reroute
  max_failed_write_attempts_without_effect: { min: 1, max: 6, kind: "count" },
  identical_write_pressure_note_cap: { min: 0, max: 6, kind: "count" },
  repeated_failed_writes_threshold: { min: 1, max: 6, kind: "count" },
  max_directives_per_turn: { min: 4, max: 64, kind: "count" },
  default_max_reroutes_per_segment: { min: 0, max: 8, kind: "count" },
  // Stage timing
  local_stage_min_window_ms: { min: 10_000, max: 300_000, kind: "ms" },
  synthesis_runway_ms: { min: 5_000, max: 120_000, kind: "ms" },
  routing_timeout_ms: { min: 1_000, max: 60_000, kind: "ms" },
  no_tool_retry_budget_floor_ms: { min: 2_000, max: 120_000, kind: "ms" },
  // Model health
  no_tool_ratio_ceiling: { min: 0, max: 1, kind: "ratio01" },
  no_tool_ratio_min_turns: { min: 2, max: 24, kind: "count" },
  min_no_tool_sample: { min: 4, max: 48, kind: "count" },
  no_tool_demotion_threshold: { min: 0, max: 1, kind: "ratio01" },
  min_error_rate_sample: { min: 4, max: 48, kind: "count" },
  error_rate_bench_threshold: { min: 0, max: 1, kind: "ratio01" },
  trial_sample_target: { min: 2, max: 24, kind: "count" },
  reliability_latency_min_samples: { min: 2, max: 24, kind: "count" },
  // Delegate
  max_delegate_launches_per_run: { min: 0, max: 12, kind: "count" },
  default_free_thrash_threshold: { min: 1, max: 8, kind: "count" },
  delegate_write_scoreboard_bench_attempts: { min: 1, max: 10, kind: "count" },
  thrash_ttl_ms: { min: 60_000, max: 7_200_000, kind: "ms" },
  delegate_health_cooldown_ms: { min: 30_000, max: 3_600_000, kind: "ms" },
  delegate_availability_cache_ms: { min: 10_000, max: 1_800_000, kind: "ms" },
  delegate_api_retry_abort_threshold: { min: 1, max: 10, kind: "count" },
  // Evidence / grounding
  max_handoff_seed_paths: { min: 0, max: 10, kind: "count" },
  deep_read_min_content_reads: { min: 1, max: 10, kind: "count" },
  max_grounding_symbols: { min: 2, max: 32, kind: "count" },
  max_grounding_greps: { min: 4, max: 64, kind: "count" },
  grounding_grep_head_limit: { min: 1, max: 10, kind: "count" },
  grounding_block_context_chars: { min: 1_000, max: 16_000, kind: "integer" },
  executor_tool_result_context_chars: { min: 2_000, max: 24_000, kind: "integer" },
  executor_preflight_result_context_chars: { min: 1_000, max: 12_000, kind: "integer" },
  write_turn_tool_result_context_chars: { min: 4_000, max: 64_000, kind: "integer" },
  // Context budgets
  executor_transcript_budget_tokens: { min: 4_000, max: 48_000, kind: "integer" },
  write_turn_transcript_budget_tokens: { min: 8_000, max: 64_000, kind: "integer" },
  // Misc
  repetition_similarity_threshold: { min: 0, max: 1, kind: "ratio01" },
};

const RESERVED_IDX = THETA_KEYS.indexOf("reserved_mid_loop_escalations");
const MAX_ESC_IDX = THETA_KEYS.indexOf("max_mid_loop_escalations");

/**
 * Clamp + round a dense THETA_KEYS-order vector into the valid domain.
 * Enforces the one cross-field invariant after per-dimension projection.
 */
export function projectToBounds(vector: number[]): number[] {
  const out = new Array<number>(THETA_KEYS.length);
  for (let i = 0; i < THETA_KEYS.length; i++) {
    const bound = THETA_BOUNDS[THETA_KEYS[i]];
    let v = vector[i];
    if (!Number.isFinite(v)) v = bound.min;
    v = Math.min(bound.max, Math.max(bound.min, v));
    if (bound.kind !== "ratio01") v = Math.round(v);
    out[i] = v;
  }
  if (out[RESERVED_IDX] > out[MAX_ESC_IDX]) out[RESERVED_IDX] = out[MAX_ESC_IDX];
  return out;
}

/** True when every dimension of a THETA_KEYS-order vector is already valid. */
export function vectorInBounds(vector: number[]): boolean {
  if (vector.length !== THETA_KEYS.length) return false;
  const projected = projectToBounds(vector);
  return projected.every((v, i) => v === vector[i]);
}
