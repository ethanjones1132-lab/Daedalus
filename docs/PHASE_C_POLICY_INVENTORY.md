# Phase C policy inventory

Only request-scoped runtime decisions are optimizable. The owner map in
`server-jarvis/src/orchestration/orchestration-policy-schema.ts` is the
enforced audit surface: every key below has a live `policy().key` decision read.

## Optimizable theta dimensions

| Key | Baseline | Owner | Decision |
|---|---:|---|---|
| force_write_nudge_cap | 2 | mid-loop-intervention | Force-write pressure cap |
| max_quality_pushes | 2 | pipeline, mid-loop-intervention | Quality coaching cap |
| max_mid_loop_checks / max_mid_loop_escalations / reserved_mid_loop_escalations | 2 / 3 / 1 | mid-loop-intervention, conductor | Supervision budget and reserve |
| mid_loop_endgame_budget_ms / mid_loop_endgame_turn_ratio | 45000 / 0.8 | mid-loop-intervention | Endgame admission |
| max_failed_write_attempts_without_effect / identical_write_pressure_note_cap / repeated_failed_writes_threshold | 2 / 2 / 2 | effect-gate, delegate-intervention-policy | Write recovery pressure |
| max_directives_per_turn / default_max_reroutes_per_segment | 24 / 3 | directive-budget, reroute-policy | Control-loop limits |
| local_stage_min_window_ms / synthesis_runway_ms / routing_timeout_ms | 75000 / 30000 / 20000 | agent-pool, pipeline, persistent-conductor | Stage timing |
| no_tool_retry_budget_floor_ms / no_tool_ratio_ceiling / no_tool_ratio_min_turns | 20000 / 0.5 / 6 | executor-progress-policy | No-tool stop/retry |
| default_min_viable_stage_ms / progress_extension_ms / stage_extension_ceiling_ms / absolute_turn_cap_ms | 5000 / 20000 / 90000 / 180000 | turn-budget | Turn/stage budget |
| min_no_tool_sample / no_tool_demotion_threshold / min_error_rate_sample / error_rate_bench_threshold | 12 / 0.6 / 10 / 0.7 | model-health | Model health demotion |
| trial_sample_target / reliability_latency_min_samples | 6 / 6 | model-trial-policy, reliability-latency-rank | Model selection evidence |
| model_scorecard_window_size / model_scorecard_unfit_error_rate | 20 / 0.5 | model-scorecard | Scorecard retention/unfit threshold |
| max_delegate_launches_per_run / default_free_thrash_threshold / delegate_write_scoreboard_bench_attempts / thrash_ttl_ms | 4 / 2 / 3 / 1800000 | pipeline, delegate-model-select | Delegate routing recovery |
| delegate_health_cooldown_ms / delegate_availability_cache_ms / delegate_api_retry_abort_threshold | 600000 / 300000 / 3 | claude-delegate | Delegate availability/retry |
| max_handoff_seed_paths / deep_read_min_content_reads | 3 / 3 | delegate-handoff-seed, evidence-sufficiency | Evidence handoff/depth |
| max_grounding_symbols / max_grounding_greps / grounding_grep_head_limit / grounding_block_context_chars | 8 / 16 / 3 / 4000 | symbol-grounding | Grounding work budget |
| executor_tool_result_context_chars / executor_preflight_result_context_chars / write_turn_tool_result_context_chars | 6000 / 3000 / 24000 | context-budget, pipeline | Result visibility |
| executor_transcript_budget_tokens / write_turn_transcript_budget_tokens | 12000 / 24000 | context-budget, pipeline | Transcript capacity |
| repetition_similarity_threshold | 0.25 | repetition-guard | No-progress repeat detection |
| default_max_repair_cycles / max_review_repair_rounds_cap | 2 / 2 | runtime-loop, pipeline | Repair-loop cap |
| dead_tool_suppress_threshold | 2 | dead-tool-suppression | Structural tool suppression |

## Fixed evaluator and governance rules

| Rule | Fixed value / rationale |
|---|---|
| Run reward objective | `RUN_REWARD_POLICY`; a candidate policy must not tune its own fitness. |
| Canary traffic | `POLICY_STAGING_GOVERNANCE.canaryTrafficFraction = 0.1`. |
| Shadow admission | `minEligibleOutcomesBeforeShadow = 20`. |
| Promotion | `minCanaryRunsBeforePromotion = 20`, `minCanarySuccessRate = 0.6`. |
| Rollback | Fixed underperformance, sample, failure-rate, and regression guards in `POLICY_STAGING_GOVERNANCE`. |

## Fixed mechanism and safety rules

| Rule | Rationale |
|---|---|
| `FINAL_STREAM_GRACE_MS` | Protect a visible final stream from mid-word termination. |
| Extended-deep hard ceilings | Keep a deep request bounded without allowing the candidate to erase the safety ceiling. |
| Cryptographic hash algorithm | SHA-256 is a provenance mechanism, not a quality preference. |
| Provider/API safety ceilings | Network, retry, and process-safety limits are operational safeguards, not candidate optimization knobs. |

This inventory intentionally does not claim that every numeric constant is optimizable.
