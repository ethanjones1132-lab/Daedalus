/**
 * Phase C — Orchestration policy vector θ.
 *
 * Every hand-tuned routing / budget / threshold constant is a named dimension
 * of a single explicit vector. Baseline values match today's shipped behaviour
 * exactly. Live decisions read via `policy()` so CMA-ES (Phase D) can swap θ
 * without rewriting call sites.
 *
 * C1: define θ (this file).
 * C2: route decisions through `policy()` (wired at decision sites).
 * C3: θ snapshot + seed → `rolloutFingerprint` for reproducible rollouts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "crypto";
import { THETA_SPEC } from "./orchestration-policy-schema";

/**
 * Numeric policy vector. All dimensions are numbers for sep-CMA-ES comfort.
 * Booleans are encoded 0/1; ratios in [0,1]; counts and millisecond budgets as integers.
 */
export interface OrchestrationTheta {
  // ── Write pressure / mid-loop ───────────────────────────────────────────
  force_write_nudge_cap: number;
  max_quality_pushes: number;
  max_mid_loop_checks: number;
  max_mid_loop_escalations: number;
  reserved_mid_loop_escalations: number;
  mid_loop_endgame_budget_ms: number;
  mid_loop_endgame_turn_ratio: number;
  max_failed_write_attempts_without_effect: number;
  identical_write_pressure_note_cap: number;
  repeated_failed_writes_threshold: number;

  // ── Directives / reroute ────────────────────────────────────────────────
  max_directives_per_turn: number;
  default_max_reroutes_per_segment: number;

  // ── Stage timing / budgets ──────────────────────────────────────────────
  local_stage_min_window_ms: number;
  synthesis_runway_ms: number;
  routing_timeout_ms: number;
  no_tool_retry_budget_floor_ms: number;
  no_tool_ratio_ceiling: number;
  no_tool_ratio_min_turns: number;
  default_min_viable_stage_ms: number;
  progress_extension_ms: number;
  stage_extension_ceiling_ms: number;
  absolute_turn_cap_ms: number;

  // ── Model health / demotion ─────────────────────────────────────────────
  min_no_tool_sample: number;
  no_tool_demotion_threshold: number;
  min_error_rate_sample: number;
  error_rate_bench_threshold: number;
  trial_sample_target: number;
  reliability_latency_min_samples: number;
  model_scorecard_window_size: number;
  model_scorecard_unfit_error_rate: number;

  // ── Delegate ────────────────────────────────────────────────────────────
  max_delegate_launches_per_run: number;
  default_free_thrash_threshold: number;
  delegate_write_scoreboard_bench_attempts: number;
  thrash_ttl_ms: number;
  delegate_health_cooldown_ms: number;
  delegate_availability_cache_ms: number;
  delegate_api_retry_abort_threshold: number;
  max_handoff_seed_paths: number;

  // ── Evidence / grounding (Phase A) ──────────────────────────────────────
  deep_read_min_content_reads: number;
  max_grounding_symbols: number;
  max_grounding_greps: number;
  grounding_grep_head_limit: number;
  grounding_block_context_chars: number;

  // ── Context budgets ─────────────────────────────────────────────────────
  executor_tool_result_context_chars: number;
  executor_preflight_result_context_chars: number;
  write_turn_tool_result_context_chars: number;
  executor_transcript_budget_tokens: number;
  write_turn_transcript_budget_tokens: number;

  // Reward weights / overclaim penalty are evaluator-owned (Phase B) and
  // deliberately excluded from θ so Phase D cannot optimize its own fitness.

  // ── Misc ────────────────────────────────────────────────────────────────
  repetition_similarity_threshold: number;

  // ── Policy staging traffic (meta-θ) ─────────────────────────────────────
  default_max_repair_cycles: number;
  max_review_repair_rounds_cap: number;
  dead_tool_suppress_threshold: number;
}

/** Ordered keys — stable serialization / CMA-ES vector layout. */
export const LEGACY_THETA_KEYS: readonly (keyof OrchestrationTheta)[] = [
  "force_write_nudge_cap",
  "max_quality_pushes",
  "max_mid_loop_checks",
  "max_mid_loop_escalations",
  "reserved_mid_loop_escalations",
  "mid_loop_endgame_budget_ms",
  "mid_loop_endgame_turn_ratio",
  "max_failed_write_attempts_without_effect",
  "identical_write_pressure_note_cap",
  "repeated_failed_writes_threshold",
  "max_directives_per_turn",
  "default_max_reroutes_per_segment",
  "local_stage_min_window_ms",
  "synthesis_runway_ms",
  "routing_timeout_ms",
  "no_tool_retry_budget_floor_ms",
  "no_tool_ratio_ceiling",
  "no_tool_ratio_min_turns",
  "default_min_viable_stage_ms",
  "progress_extension_ms",
  "stage_extension_ceiling_ms",
  "absolute_turn_cap_ms",
  "min_no_tool_sample",
  "no_tool_demotion_threshold",
  "min_error_rate_sample",
  "error_rate_bench_threshold",
  "trial_sample_target",
  "reliability_latency_min_samples",
  "model_scorecard_window_size",
  "model_scorecard_unfit_error_rate",
  "max_delegate_launches_per_run",
  "default_free_thrash_threshold",
  "delegate_write_scoreboard_bench_attempts",
  "thrash_ttl_ms",
  "delegate_health_cooldown_ms",
  "delegate_availability_cache_ms",
  "delegate_api_retry_abort_threshold",
  "max_handoff_seed_paths",
  "deep_read_min_content_reads",
  "max_grounding_symbols",
  "max_grounding_greps",
  "grounding_grep_head_limit",
  "grounding_block_context_chars",
  "executor_tool_result_context_chars",
  "executor_preflight_result_context_chars",
  "write_turn_tool_result_context_chars",
  "executor_transcript_budget_tokens",
  "write_turn_transcript_budget_tokens",
  "repetition_similarity_threshold",
  "default_max_repair_cycles",
  "max_review_repair_rounds_cap",
  "dead_tool_suppress_threshold",
] as const;

/**
 * Baseline θ — exact values of the hand-tuned constants as of Phase C land.
 * Changing a baseline value IS a behaviour change; tests pin key dimensions.
 */
export const LEGACY_BASELINE_THETA: OrchestrationTheta = {
  force_write_nudge_cap: 2,
  max_quality_pushes: 2,
  max_mid_loop_checks: 2,
  max_mid_loop_escalations: 3,
  reserved_mid_loop_escalations: 1,
  mid_loop_endgame_budget_ms: 45_000,
  mid_loop_endgame_turn_ratio: 0.8,
  max_failed_write_attempts_without_effect: 2,
  identical_write_pressure_note_cap: 2,
  repeated_failed_writes_threshold: 2,

  max_directives_per_turn: 24,
  default_max_reroutes_per_segment: 3,

  local_stage_min_window_ms: 75_000,
  synthesis_runway_ms: 30_000,
  routing_timeout_ms: 20_000,
  no_tool_retry_budget_floor_ms: 20_000,
  no_tool_ratio_ceiling: 0.5,
  no_tool_ratio_min_turns: 6,
  default_min_viable_stage_ms: 5_000,
  progress_extension_ms: 20_000,
  stage_extension_ceiling_ms: 90_000,
  absolute_turn_cap_ms: 180_000,

  min_no_tool_sample: 12,
  no_tool_demotion_threshold: 0.6,
  min_error_rate_sample: 10,
  error_rate_bench_threshold: 0.7,
  trial_sample_target: 6,
  reliability_latency_min_samples: 6,
  model_scorecard_window_size: 20,
  model_scorecard_unfit_error_rate: 0.5,

  max_delegate_launches_per_run: 4,
  default_free_thrash_threshold: 2,
  delegate_write_scoreboard_bench_attempts: 3,
  thrash_ttl_ms: 30 * 60_000,
  delegate_health_cooldown_ms: 10 * 60_000,
  delegate_availability_cache_ms: 5 * 60_000,
  delegate_api_retry_abort_threshold: 3,
  max_handoff_seed_paths: 3,

  deep_read_min_content_reads: 3,
  max_grounding_symbols: 8,
  max_grounding_greps: 16,
  grounding_grep_head_limit: 3,
  grounding_block_context_chars: 4_000,

  executor_tool_result_context_chars: 6_000,
  executor_preflight_result_context_chars: 3_000,
  write_turn_tool_result_context_chars: 24_000,
  executor_transcript_budget_tokens: 12_000,
  write_turn_transcript_budget_tokens: 24_000,

  repetition_similarity_threshold: 0.25,

  default_max_repair_cycles: 2,
  max_review_repair_rounds_cap: 2,
  dead_tool_suppress_threshold: 2,
};

/** Ordered keys and baseline are derived from the single schema source. */
export const THETA_KEYS = Object.keys(THETA_SPEC) as Array<keyof OrchestrationTheta>;
export const BASELINE_THETA: OrchestrationTheta = Object.fromEntries(
  Object.entries(THETA_SPEC).map(([key, spec]) => [key, spec.baseline]),
) as unknown as OrchestrationTheta;

export type ThetaPatch = Partial<OrchestrationTheta>;

export interface ThetaValidationIssue {
  key: string;
  value: unknown;
  reason: "unknown" | "non_finite" | "below_min" | "above_max" | "not_integer" | "cross_field";
  message: string;
}

export class ThetaValidationError extends Error {
  constructor(public readonly issues: readonly ThetaValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ThetaValidationError";
  }
}

function issue(
  key: string,
  value: unknown,
  reason: ThetaValidationIssue["reason"],
  message: string,
): ThetaValidationIssue {
  return { key, value, reason, message };
}

/** Strict validation for all manual, staged, and persisted θ inputs. */
export function validateThetaPatch(patch: Record<string, unknown>): ThetaValidationIssue[] {
  const issues: ThetaValidationIssue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const spec = THETA_SPEC[key as keyof OrchestrationTheta];
    if (!spec) {
      issues.push(issue(key, value, "unknown", `${key} is not a θ dimension`));
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push(issue(key, value, "non_finite", `${key} must be finite`));
      continue;
    }
    if (value < spec.min) {
      issues.push(issue(key, value, "below_min", `${key} must be at least ${spec.min}`));
    } else if (value > spec.max) {
      issues.push(issue(key, value, "above_max", `${key} must be at most ${spec.max}`));
    } else if (spec.kind === "integer" && !Number.isInteger(value)) {
      issues.push(issue(key, value, "not_integer", `${key} must be an integer`));
    }
  }

  const maxEscalations = patch.max_mid_loop_escalations;
  const reservedEscalations = patch.reserved_mid_loop_escalations;
  if (
    typeof maxEscalations === "number" &&
    typeof reservedEscalations === "number" &&
    reservedEscalations > maxEscalations
  ) {
    issues.push(issue(
      "reserved_mid_loop_escalations",
      reservedEscalations,
      "cross_field",
      "reserved_mid_loop_escalations must not exceed max_mid_loop_escalations",
    ));
  }

  const absoluteTurnCap = patch.absolute_turn_cap_ms;
  const stageExtensionCap = patch.stage_extension_ceiling_ms;
  if (
    typeof absoluteTurnCap === "number" &&
    typeof stageExtensionCap === "number" &&
    stageExtensionCap > absoluteTurnCap
  ) {
    issues.push(issue(
      "stage_extension_ceiling_ms",
      stageExtensionCap,
      "cross_field",
      "stage_extension_ceiling_ms must not exceed absolute_turn_cap_ms",
    ));
  }
  return issues;
}

export function assertValidTheta(theta: OrchestrationTheta): OrchestrationTheta {
  const raw = theta as unknown as Record<string, unknown>;
  const issues = validateThetaPatch(raw);
  for (const key of THETA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      issues.push(issue(key, undefined, "non_finite", `${key} must be finite`));
    }
  }
  if (issues.length > 0) throw new ThetaValidationError(issues);
  return theta;
}

/** Optimizer-only path: sanitize candidate values instead of rejecting the generation. */
export function projectThetaPatch(
  base: OrchestrationTheta,
  patch: Record<string, unknown>,
): OrchestrationTheta {
  const projected = { ...assertValidTheta(base) };
  for (const key of THETA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const spec = THETA_SPEC[key];
    const clamped = Math.min(spec.max, Math.max(spec.min, value));
    projected[key] = spec.kind === "integer" ? Math.round(clamped) : clamped;
  }
  projected.reserved_mid_loop_escalations = Math.min(
    projected.reserved_mid_loop_escalations,
    projected.max_mid_loop_escalations,
  );
  projected.stage_extension_ceiling_ms = Math.min(
    projected.stage_extension_ceiling_ms,
    projected.absolute_turn_cap_ms,
  );
  return assertValidTheta(projected);
}

export const LEGACY_REMOVED_THETA_KEYS = new Set([
  "reward_weight_writes",
  "reward_weight_check",
  "reward_weight_plan",
  "overclaim_penalty",
  "policy_canary_traffic_fraction",
  "policy_min_canary_success_rate",
  "policy_min_eligible_outcomes_before_shadow",
  "policy_min_canary_runs_before_promotion",
]);

/** Strip only historic evaluator/governance keys during persisted-snapshot migration. */
export function migrateLegacyThetaPatch(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !LEGACY_REMOVED_THETA_KEYS.has(key)),
  );
}

const thetaAls = new AsyncLocalStorage<OrchestrationTheta>();

/** Process-global override (production promote / test install). */
let globalTheta: OrchestrationTheta = { ...BASELINE_THETA };

/** Active θ: request ALS overlay → global override → baseline. */
export function policy(): OrchestrationTheta {
  return thetaAls.getStore() ?? globalTheta;
}

/** Alias used at decision sites. */
export const getOrchestrationPolicy = policy;

export function getGlobalTheta(): OrchestrationTheta {
  return globalTheta;
}

export function setGlobalTheta(theta: OrchestrationTheta): void {
  globalTheta = freezeTheta(assertValidTheta(theta));
}

export function resetGlobalThetaToBaseline(): void {
  globalTheta = { ...BASELINE_THETA };
}

export function mergeTheta(
  base: OrchestrationTheta,
  patch: ThetaPatch | null | undefined,
): OrchestrationTheta {
  const next = { ...assertValidTheta(base) };
  if (!patch) return next;
  const raw = patch as Record<string, unknown>;
  const patchIssues = validateThetaPatch(raw);
  if (patchIssues.length > 0) throw new ThetaValidationError(patchIssues);
  for (const key of THETA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      next[key] = raw[key] as number;
    }
  }
  return assertValidTheta(next);
}

function freezeTheta(theta: OrchestrationTheta): OrchestrationTheta {
  return { ...theta };
}

/**
 * Run `fn` under a request-scoped θ (canary / rollout). Nested calls restore
 * the prior overlay on exit.
 */
export function runWithTheta<T>(patchOrFull: ThetaPatch | OrchestrationTheta, fn: () => T): T {
  const full = isFullTheta(patchOrFull)
    ? freezeTheta(assertValidTheta(patchOrFull))
    : mergeTheta(policy(), patchOrFull);
  return thetaAls.run(full, fn);
}

function isFullTheta(t: ThetaPatch | OrchestrationTheta): t is OrchestrationTheta {
  return THETA_KEYS.every((k) => typeof (t as OrchestrationTheta)[k] === "number");
}

/** Apply a partial patch on top of baseline (or base) as the new global θ. */
export function applyThetaPatchGlobally(
  patch: ThetaPatch,
  base: OrchestrationTheta = BASELINE_THETA,
): OrchestrationTheta {
  globalTheta = freezeTheta(mergeTheta(base, patch));
  return globalTheta;
}

/** Dense vector in THETA_KEYS order (CMA-ES input). */
export function thetaToVector(theta: OrchestrationTheta = policy()): number[] {
  const valid = assertValidTheta(theta);
  return THETA_KEYS.map((k) => valid[k]);
}

/** Inverse of thetaToVector. */
export function vectorToTheta(vector: number[], base: OrchestrationTheta = BASELINE_THETA): OrchestrationTheta {
  const patch: Record<string, unknown> = {};
  for (let i = 0; i < THETA_KEYS.length && i < vector.length; i++) {
    patch[THETA_KEYS[i]] = vector[i];
  }
  return projectThetaPatch(base, patch);
}

export function thetaEquals(a: OrchestrationTheta, b: OrchestrationTheta, eps = 1e-9): boolean {
  for (const key of THETA_KEYS) {
    if (Math.abs(a[key] - b[key]) > eps) return false;
  }
  return true;
}

/** Canonical JSON (sorted keys) for hashing / persistence. */
export function serializeTheta(theta: OrchestrationTheta = policy()): string {
  const valid = assertValidTheta(theta);
  const obj: Record<string, number> = {};
  for (const key of THETA_KEYS) obj[key] = valid[key];
  return JSON.stringify(obj);
}

export function parseTheta(json: string, base: OrchestrationTheta = BASELINE_THETA): OrchestrationTheta {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return mergeTheta(base, raw as ThetaPatch);
}

export function thetaFingerprint(theta: OrchestrationTheta = policy()): string {
  return createHash("sha256").update(serializeTheta(theta)).digest("hex").slice(0, 16);
}

// ── C3: reproducible rollouts ─────────────────────────────────────────────

export interface RolloutSpec {
  /** Full or patch θ for this rollout. */
  theta: ThetaPatch | OrchestrationTheta;
  /** Integer seed for any stochastic draws during the rollout. */
  seed: number;
  /** Fixture / task id (held-out split lives outside θ). */
  fixtureId: string;
}

/**
 * Stable fingerprint of (θ, seed, fixture). Same inputs → same string forever.
 * Phase D uses this to detect non-deterministic trajectories.
 */
export function rolloutFingerprint(spec: RolloutSpec): string {
  const theta = isFullTheta(spec.theta)
    ? spec.theta
    : mergeTheta(BASELINE_THETA, spec.theta);
  const payload = JSON.stringify({
    theta: JSON.parse(serializeTheta(theta)),
    seed: spec.seed | 0,
    fixtureId: String(spec.fixtureId),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** Mulberry32 PRNG — deterministic stream from seed (for rollout noise). */
export function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run a rollout body under fixed θ + seed. Returns fingerprint + result so
 * callers can assert trajectory identity offline.
 */
export function withRollout<T>(
  spec: RolloutSpec,
  fn: (rng: () => number) => T,
): { fingerprint: string; result: T; theta: OrchestrationTheta } {
  const theta = isFullTheta(spec.theta)
    ? freezeTheta(spec.theta)
    : mergeTheta(BASELINE_THETA, spec.theta);
  const fingerprint = rolloutFingerprint({ ...spec, theta });
  const rng = mulberry32(spec.seed);
  const result = runWithTheta(theta, () => fn(rng));
  return { fingerprint, result, theta };
}

/** Dimension count — for CMA-ES bookkeeping. */
export const THETA_DIM = THETA_KEYS.length;
