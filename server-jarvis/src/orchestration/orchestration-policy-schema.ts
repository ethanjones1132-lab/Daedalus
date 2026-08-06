import type { OrchestrationTheta } from "./orchestration-policy";

/** Direct decision owners for each inventory-approved runtime policy dimension. */
export const THETA_DECISION_OWNERS: Record<keyof OrchestrationTheta, readonly string[]> = {
  force_write_nudge_cap: ["orchestration/mid-loop-intervention.ts"],
  max_quality_pushes: ["orchestration/pipeline.ts", "orchestration/mid-loop-intervention.ts"],
  max_mid_loop_checks: ["orchestration/mid-loop-intervention.ts"],
  max_mid_loop_escalations: ["orchestration/conductor.ts", "orchestration/mid-loop-intervention.ts"],
  reserved_mid_loop_escalations: ["orchestration/mid-loop-intervention.ts"],
  mid_loop_endgame_budget_ms: ["orchestration/mid-loop-intervention.ts"],
  mid_loop_endgame_turn_ratio: ["orchestration/mid-loop-intervention.ts"],
  max_failed_write_attempts_without_effect: ["orchestration/effect-gate.ts"],
  identical_write_pressure_note_cap: ["orchestration/effect-gate.ts"],
  repeated_failed_writes_threshold: ["orchestration/delegate-intervention-policy.ts"],
  max_directives_per_turn: ["orchestration/directive-budget.ts"],
  default_max_reroutes_per_segment: ["orchestration/reroute-policy.ts"],
  local_stage_min_window_ms: ["orchestration/agent-pool.ts"],
  synthesis_runway_ms: ["orchestration/pipeline.ts"],
  routing_timeout_ms: ["orchestration/persistent-conductor.ts"],
  no_tool_retry_budget_floor_ms: ["orchestration/executor-progress-policy.ts"],
  no_tool_ratio_ceiling: ["orchestration/executor-progress-policy.ts"],
  no_tool_ratio_min_turns: ["orchestration/executor-progress-policy.ts"],
  min_no_tool_sample: ["orchestration/model-health.ts"],
  no_tool_demotion_threshold: ["orchestration/model-health.ts"],
  min_error_rate_sample: ["orchestration/model-health.ts"],
  error_rate_bench_threshold: ["orchestration/model-health.ts"],
  trial_sample_target: ["orchestration/model-trial-policy.ts"],
  reliability_latency_min_samples: ["orchestration/reliability-latency-rank.ts"],
  max_delegate_launches_per_run: ["orchestration/pipeline.ts"],
  default_free_thrash_threshold: ["orchestration/delegate-model-select.ts"],
  delegate_write_scoreboard_bench_attempts: ["orchestration/delegate-model-select.ts"],
  thrash_ttl_ms: ["orchestration/delegate-model-select.ts", "orchestration/pipeline.ts"],
  delegate_health_cooldown_ms: ["orchestration/claude-delegate.ts"],
  delegate_availability_cache_ms: ["orchestration/claude-delegate.ts"],
  delegate_api_retry_abort_threshold: ["orchestration/claude-delegate.ts"],
  max_handoff_seed_paths: ["orchestration/delegate-handoff-seed.ts"],
  deep_read_min_content_reads: ["orchestration/evidence-sufficiency.ts"],
  max_grounding_symbols: ["orchestration/symbol-grounding.ts"],
  max_grounding_greps: ["orchestration/symbol-grounding.ts"],
  grounding_grep_head_limit: ["orchestration/symbol-grounding.ts"],
  grounding_block_context_chars: ["orchestration/symbol-grounding.ts"],
  executor_tool_result_context_chars: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  executor_preflight_result_context_chars: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  write_turn_tool_result_context_chars: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  executor_transcript_budget_tokens: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  write_turn_transcript_budget_tokens: ["orchestration/context-budget.ts", "orchestration/pipeline.ts"],
  repetition_similarity_threshold: ["orchestration/repetition-guard.ts"],
  default_min_viable_stage_ms: ["orchestration/turn-budget.ts"],
  progress_extension_ms: ["orchestration/turn-budget.ts"],
  stage_extension_ceiling_ms: ["orchestration/turn-budget.ts"],
  absolute_turn_cap_ms: ["orchestration/turn-budget.ts"],
  model_scorecard_window_size: ["orchestration/model-scorecard.ts"],
  model_scorecard_unfit_error_rate: ["orchestration/model-scorecard.ts"],
  default_max_repair_cycles: ["orchestration/runtime-loop.ts"],
  max_review_repair_rounds_cap: ["orchestration/pipeline.ts"],
  dead_tool_suppress_threshold: ["orchestration/dead-tool-suppression.ts"],
};

export type ThetaKind = "integer" | "float";

export interface ThetaDimensionSpec {
  baseline: number;
  min: number;
  max: number;
  kind: ThetaKind;
  owners: readonly string[];
}

const count = (baseline: number, min: number, max: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min, max, kind: "integer", owners });
const ratio = (baseline: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min: 0, max: 1, kind: "float", owners });
const ms = (baseline: number, min: number, max: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min, max, kind: "integer", owners });
const budget = (baseline: number, min: number, max: number, owners: readonly string[]): ThetaDimensionSpec =>
  ({ baseline, min, max, kind: "integer", owners });

const owners = THETA_DECISION_OWNERS;

/** Canonical θ dimensions: baseline, valid domain, and direct decision owners. */
export const THETA_SPEC: Record<keyof OrchestrationTheta, ThetaDimensionSpec> = {
  force_write_nudge_cap: count(2, 0, 8, owners.force_write_nudge_cap),
  max_quality_pushes: count(2, 0, 8, owners.max_quality_pushes),
  max_mid_loop_checks: count(2, 0, 8, owners.max_mid_loop_checks),
  max_mid_loop_escalations: count(3, 0, 8, owners.max_mid_loop_escalations),
  reserved_mid_loop_escalations: count(1, 0, 8, owners.reserved_mid_loop_escalations),
  mid_loop_endgame_budget_ms: budget(45_000, 1_000, 600_000, owners.mid_loop_endgame_budget_ms),
  mid_loop_endgame_turn_ratio: ratio(0.8, owners.mid_loop_endgame_turn_ratio),
  max_failed_write_attempts_without_effect: count(2, 1, 10, owners.max_failed_write_attempts_without_effect),
  identical_write_pressure_note_cap: count(2, 0, 8, owners.identical_write_pressure_note_cap),
  repeated_failed_writes_threshold: count(2, 1, 10, owners.repeated_failed_writes_threshold),
  max_directives_per_turn: count(24, 1, 100, owners.max_directives_per_turn),
  default_max_reroutes_per_segment: count(3, 1, 100, owners.default_max_reroutes_per_segment),
  local_stage_min_window_ms: ms(75_000, 1_000, 600_000, owners.local_stage_min_window_ms),
  synthesis_runway_ms: ms(30_000, 1_000, 600_000, owners.synthesis_runway_ms),
  routing_timeout_ms: ms(20_000, 1_000, 600_000, owners.routing_timeout_ms),
  no_tool_retry_budget_floor_ms: budget(20_000, 1_000, 600_000, owners.no_tool_retry_budget_floor_ms),
  no_tool_ratio_ceiling: ratio(0.5, owners.no_tool_ratio_ceiling),
  no_tool_ratio_min_turns: count(6, 1, 100, owners.no_tool_ratio_min_turns),
  default_min_viable_stage_ms: ms(5_000, 1_000, 600_000, owners.default_min_viable_stage_ms),
  progress_extension_ms: ms(20_000, 1_000, 120_000, owners.progress_extension_ms),
  stage_extension_ceiling_ms: budget(90_000, 10_000, 3_600_000, owners.stage_extension_ceiling_ms),
  absolute_turn_cap_ms: budget(180_000, 10_000, 3_600_000, owners.absolute_turn_cap_ms),
  min_no_tool_sample: count(12, 1, 100, owners.min_no_tool_sample),
  no_tool_demotion_threshold: ratio(0.6, owners.no_tool_demotion_threshold),
  min_error_rate_sample: count(10, 1, 100, owners.min_error_rate_sample),
  error_rate_bench_threshold: ratio(0.7, owners.error_rate_bench_threshold),
  trial_sample_target: count(6, 1, 100, owners.trial_sample_target),
  reliability_latency_min_samples: count(6, 1, 100, owners.reliability_latency_min_samples),
  model_scorecard_window_size: count(20, 1, 1_000, owners.model_scorecard_window_size),
  model_scorecard_unfit_error_rate: ratio(0.5, owners.model_scorecard_unfit_error_rate),
  max_delegate_launches_per_run: count(4, 0, 8, owners.max_delegate_launches_per_run),
  default_free_thrash_threshold: count(2, 1, 10, owners.default_free_thrash_threshold),
  delegate_write_scoreboard_bench_attempts: count(3, 1, 100, owners.delegate_write_scoreboard_bench_attempts),
  thrash_ttl_ms: ms(30 * 60_000, 1_000, 86_400_000, owners.thrash_ttl_ms),
  delegate_health_cooldown_ms: ms(10 * 60_000, 1_000, 86_400_000, owners.delegate_health_cooldown_ms),
  delegate_availability_cache_ms: ms(5 * 60_000, 1_000, 86_400_000, owners.delegate_availability_cache_ms),
  delegate_api_retry_abort_threshold: count(3, 1, 10, owners.delegate_api_retry_abort_threshold),
  max_handoff_seed_paths: count(3, 1, 100, owners.max_handoff_seed_paths),
  deep_read_min_content_reads: count(3, 1, 100, owners.deep_read_min_content_reads),
  max_grounding_symbols: count(8, 1, 100, owners.max_grounding_symbols),
  max_grounding_greps: count(16, 1, 256, owners.max_grounding_greps),
  grounding_grep_head_limit: count(3, 1, 100, owners.grounding_grep_head_limit),
  grounding_block_context_chars: budget(4_000, 256, 1_000_000, owners.grounding_block_context_chars),
  executor_tool_result_context_chars: budget(6_000, 256, 1_000_000, owners.executor_tool_result_context_chars),
  executor_preflight_result_context_chars: budget(3_000, 256, 1_000_000, owners.executor_preflight_result_context_chars),
  write_turn_tool_result_context_chars: budget(24_000, 256, 1_000_000, owners.write_turn_tool_result_context_chars),
  executor_transcript_budget_tokens: budget(12_000, 256, 200_000, owners.executor_transcript_budget_tokens),
  write_turn_transcript_budget_tokens: budget(24_000, 256, 200_000, owners.write_turn_transcript_budget_tokens),
  repetition_similarity_threshold: ratio(0.25, owners.repetition_similarity_threshold),
  default_max_repair_cycles: count(2, 0, 8, owners.default_max_repair_cycles),
  max_review_repair_rounds_cap: count(2, 0, 8, owners.max_review_repair_rounds_cap),
  dead_tool_suppress_threshold: count(2, 1, 10, owners.dead_tool_suppress_threshold),
};
