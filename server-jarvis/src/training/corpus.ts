/**
 * D-01: Trajectory corpus export for future GRPO conductor training.
 *
 * Pure library: takes a `SelfTuningStore` + options, returns rows ready to be
 * JSONL-serialized. CLI wrapper lives in `./export-corpus.ts`.
 *
 * ## JSONL schema (one JSON object per line)
 *
 * - `id`              — trajectory snapshot id (string)
 * - `agent_run_id`    — agent_runs.id (string, join key)
 * - `session_id`      — session id (string)
 * - `task_type`       — task_type from agent_runs (string)
 * - `user_request`    — raw user prompt (string)
 * - `pipeline`        — executable pipeline array (string[])
 * - `worker_instructions` — per-stage worker instructions (Record<string,string>)
 * - `stage_runs`      — verbatim stage_runs array (each with was_successful/had_error/duration_ms/tokens)
 * - `model_attributions` — canonical same-run model attributions when available,
 *                           otherwise the frozen snapshot copy
 * - `replan_count`    — number of `conductor_replan` events for this agent_run_id
 * - `run_outcome`     — "success" | "degraded" | "failed" (truthful run outcome)
 * - `duration_ms`     — total run duration (number)
 * - `user_rating`     — 1..5 if the operator rated the run, else null
 * - `reward`          — composite reward in [0, 1] (see below)
 * - `reward_components` — object with each weighted component in [0, 1]
 *
 * ## Composite reward
 *
 *   reward = (w_outcome * outcome_score
 *           + w_user    * user_rating_score
 *           + w_eval    * eval_replay_score
 *           + w_tokens  * token_efficiency_score
 *           + w_errors  * stage_error_absence_score)
 *          / sum_of_supplied_weights
 *
 * Default weights (`DEFAULT_REWARD_WEIGHTS`):
 *   outcome=0.40, user=0.25, eval=0.15, tokens=0.10, errors=0.10
 *
 * - `outcome_score`           = 1.0 (success) / 0.5 (degraded) / 0.0 (failed)
 * - `user_rating_score`       = (rating - 1) / 4 if rating ∈ [1, 5], else 0.5 (neutral)
 * - `eval_replay_score`       = 1.0 if eval present and passed, 0.0 if present and failed, 0.5 if no eval recorded
 * - `token_efficiency_score`  = clamp(1 - tokens / TOKEN_BUDGET, 0, 1) (neutral 0.5 if no token data)
 * - `stage_error_absence_score` = 1 - (error_stages / total_stages), or 1.0 if no stages
 *
 * Pass `rewardWeights: { ... }` to override individual weights. Omit a
 * component (or set its weight to 0) and it stops contributing.
 *
 * ## Quality filtering
 *
 * The CLI / `exportCorpus` honor `minReward` (default 0.0) — rows with reward
 * below the threshold are dropped. Per the D-01 spec, rows with
 * `run_outcome ∈ {"failed", "degraded"}` AND a reward below the quality
 * threshold are skipped automatically; the threshold is the gate.
 *
 * The CLI default is `minReward: 0.25`, which drops the worst "failed with no
 * eval, all stages errored" rows while keeping degraded-but-usable runs that
 * still have signal for preference learning.
 */

import { SelfTuningStore, type TrajectorySnapshot, type AgentRun } from "../self-tuning/store";

/** Weights for each component of the composite reward. Sum does not need to
 *  be 1 — the final reward is normalized by the sum of supplied weights so
 *  omitting a component (weight 0) is safe. */
export interface RewardWeights {
  outcome?: number;
  user?: number;
  eval?: number;
  tokens?: number;
  errors?: number;
}

export const DEFAULT_REWARD_WEIGHTS: Required<RewardWeights> = {
  outcome: 0.40,
  user: 0.25,
  eval: 0.15,
  tokens: 0.10,
  errors: 0.10,
};

/** Soft cap for the token-efficiency term. Runs under the cap get 1.0; runs
 *  at or over the cap get 0.0. Configurable so a "more patient" training run
 *  can stretch the budget. */
export const DEFAULT_TOKEN_BUDGET = 16_000;

/** Per-agent_run_id eval-replay result. Built by the caller from the eval
 *  harness's `baseline.json` (latest run) or a fresh eval sweep. */
export type EvalResults = ReadonlyMap<string, boolean>;

export interface ExportedRow {
  id: string;
  agent_run_id: string;
  session_id: string;
  task_type: string;
  user_request: string;
  pipeline: string[];
  worker_instructions: Record<string, string>;
  stage_runs: unknown[];
  model_attributions: unknown[];
  replan_count: number;
  run_outcome: "success" | "degraded" | "failed";
  duration_ms: number;
  user_rating: number | null;
  reward: number;
  reward_components: {
    outcome: number;
    user: number;
    eval: number;
    tokens: number;
    errors: number;
  };
}

export interface ExportOptions {
  rewardWeights?: RewardWeights;
  tokenBudget?: number;
  /** Min reward (0..1). Rows below are dropped. Default 0.0 (keep all). */
  minReward?: number;
  /** Eval-replay results, agent_run_id → passed. Omitted ids get a neutral 0.5. */
  evalResults?: EvalResults;
  /** Per-run replan counts, agent_run_id → count. Omitted ids get 0. */
  replanCounts?: ReadonlyMap<string, number>;
}

export interface ExportResult {
  /** Rows that passed quality filtering. Each row is a fully-resolved export. */
  rows: ExportedRow[];
  /** Counts for operator visibility: kept, dropped, malformed. */
  stats: {
    scanned: number;
    kept: number;
    droppedBelowThreshold: number;
    droppedMalformed: number;
  };
}

interface ParsedTrajectory {
  agent_run_id?: string;
  session_id?: string;
  task_type?: string;
  run_outcome?: string;
  duration_ms?: number;
  routing?: { pipeline?: unknown };
  worker_instructions?: Record<string, string>;
  stage_runs?: Array<{ was_successful?: number; had_error?: number; input_tokens?: number; output_tokens?: number }>;
  model_attributions?: Array<{ was_successful?: number; had_error?: number }>;
  user_request?: string;
}

function parseSnapshot(snap: TrajectorySnapshot): ParsedTrajectory | null {
  try {
    const parsed = JSON.parse(snap.snapshot_json);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ParsedTrajectory;
  } catch {
    return null;
  }
}

function isRunOutcome(value: unknown): value is ExportedRow["run_outcome"] {
  return value === "success" || value === "degraded" || value === "failed";
}

function outcomeScore(o: string | undefined): number {
  if (o === "success") return 1.0;
  if (o === "degraded") return 0.5;
  return 0.0; // "failed" or anything unknown
}

function userRatingScore(rating: number | null | undefined): number {
  if (rating == null) return 0.5;
  if (rating < 1 || rating > 5) return 0.5;
  return (rating - 1) / 4;
}

function evalReplayScore(passed: boolean | undefined): number {
  if (passed === true) return 1.0;
  if (passed === false) return 0.0;
  return 0.5; // neutral: no eval recorded
}

function tokenEfficiencyScore(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  budget: number,
): number {
  const total = (inputTokens ?? 0) + (outputTokens ?? 0);
  if (total <= 0) return 0.5; // neutral: no token data
  if (total >= budget) return 0.0;
  return 1 - total / budget;
}

function stageErrorAbsenceScore(
  stageRuns: Array<{ had_error?: number }> | undefined,
): number {
  if (!stageRuns || stageRuns.length === 0) return 1.0;
  const errors = stageRuns.filter((s) => s.had_error && s.had_error > 0).length;
  return 1 - errors / stageRuns.length;
}

function computeReward(
  components: { outcome: number; user: number; eval: number; tokens: number; errors: number },
  weights: Required<RewardWeights>,
): number {
  const totalWeight =
    weights.outcome + weights.user + weights.eval + weights.tokens + weights.errors;
  if (totalWeight <= 0) return 0;
  const weighted =
    weights.outcome * components.outcome +
    weights.user * components.user +
    weights.eval * components.eval +
    weights.tokens * components.tokens +
    weights.errors * components.errors;
  return weighted / totalWeight;
}

function resolvePipeline(traj: ParsedTrajectory, agentRun: AgentRun | undefined): string[] {
  if (agentRun) {
    try {
      const executable = JSON.parse(agentRun.pipeline);
      if (Array.isArray(executable) && executable.every((x) => typeof x === "string")) {
        return executable;
      }
    } catch {
      // Fall through to the snapshot's raw route for legacy/corrupt run rows.
    }
  }
  const p = traj.routing?.pipeline;
  if (!Array.isArray(p)) return [];
  return p.filter((x): x is string => typeof x === "string");
}

function stageTokenTotals(
  stageRuns: Array<{ input_tokens?: number; output_tokens?: number }> | undefined,
): { inputTokens: number; outputTokens: number } {
  if (!stageRuns) return { inputTokens: 0, outputTokens: 0 };
  let input = 0;
  let output = 0;
  for (const s of stageRuns) {
    if (typeof s.input_tokens === "number") input += s.input_tokens;
    if (typeof s.output_tokens === "number") output += s.output_tokens;
  }
  return { inputTokens: input, outputTokens: output };
}

/** Build a single export row from a snapshot + the joined agent_runs row.
 *  Returns null if the snapshot cannot be parsed or is missing required fields. */
export function buildExportRow(
  snapshot: TrajectorySnapshot,
  agentRun: AgentRun | undefined,
  options: ExportOptions,
): ExportedRow | null {
  const traj = parseSnapshot(snapshot);
  if (!traj) return null;
  if (typeof traj.agent_run_id !== "string") return null;
  if (traj.agent_run_id !== snapshot.agent_run_id) return null;
  if (agentRun && agentRun.id !== traj.agent_run_id) return null;

  // `agent_runs` is the repairable canonical run record. Historical snapshot
  // copies can be stale after a retro-repair, so only fall back to the frozen
  // snapshot outcome when the joined run has no valid outcome yet.
  const runOutcome = isRunOutcome(agentRun?.outcome)
    ? agentRun.outcome
    : isRunOutcome(traj.run_outcome)
      ? traj.run_outcome
      : null;
  if (!runOutcome) return null;

  const weights: Required<RewardWeights> = {
    outcome: options.rewardWeights?.outcome ?? DEFAULT_REWARD_WEIGHTS.outcome,
    user: options.rewardWeights?.user ?? DEFAULT_REWARD_WEIGHTS.user,
    eval: options.rewardWeights?.eval ?? DEFAULT_REWARD_WEIGHTS.eval,
    tokens: options.rewardWeights?.tokens ?? DEFAULT_REWARD_WEIGHTS.tokens,
    errors: options.rewardWeights?.errors ?? DEFAULT_REWARD_WEIGHTS.errors,
  };
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const evalResults = options.evalResults;
  const replanCounts = options.replanCounts;

  const stageRuns = Array.isArray(traj.stage_runs) ? traj.stage_runs : [];
  const modelAttributions = Array.isArray(traj.model_attributions) ? traj.model_attributions : [];
  const { inputTokens, outputTokens } = stageTokenTotals(stageRuns);

  const components = {
    outcome: outcomeScore(runOutcome),
    user: userRatingScore(agentRun?.user_rating),
    eval: evalReplayScore(evalResults?.get(traj.agent_run_id)),
    tokens: tokenEfficiencyScore(inputTokens, outputTokens, tokenBudget),
    errors: stageErrorAbsenceScore(stageRuns),
  };
  const reward = computeReward(components, weights);

  return {
    id: snapshot.id,
    agent_run_id: traj.agent_run_id,
    session_id: typeof traj.session_id === "string" ? traj.session_id : snapshot.session_id,
    task_type: typeof traj.task_type === "string" ? traj.task_type : (agentRun?.task_type ?? "unknown"),
    user_request: typeof traj.user_request === "string" ? traj.user_request : (agentRun?.user_request ?? ""),
    pipeline: resolvePipeline(traj, agentRun),
    worker_instructions: traj.worker_instructions ?? {},
    stage_runs: stageRuns,
    model_attributions: modelAttributions,
    replan_count: replanCounts?.get(traj.agent_run_id) ?? 0,
    run_outcome: runOutcome,
    duration_ms: typeof traj.duration_ms === "number" ? traj.duration_ms : (agentRun?.duration_ms ?? 0),
    user_rating: typeof agentRun?.user_rating === "number" ? agentRun.user_rating : null,
    reward,
    reward_components: components,
  };
}

/** Top-level export entry point. Scans trajectory_snapshots (newest first, up
 *  to `limit`) and applies the join + reward + quality filter.
 *
 *  Returns the kept rows + per-pass stats so a CLI can surface what was
 *  filtered and why. The function is pure with respect to its arguments —
 *  it opens the production DB only via the injected `store`, so tests pass
 *  `new SelfTuningStore(":memory:")`. */
export function exportCorpus(
  store: SelfTuningStore,
  limit: number,
  options: ExportOptions = {},
): ExportResult {
  const minReward = options.minReward ?? 0.0;
  const snapshots = store.getTrajectorySnapshots(limit);

  // Build a lookup of agent_runs by id so each snapshot can be joined cheaply.
  const allRuns = store.getAgentRuns();
  const runsById = new Map<string, AgentRun>();
  for (const r of allRuns) runsById.set(r.id, r);

  const rows: ExportedRow[] = [];
  let droppedBelowThreshold = 0;
  let droppedMalformed = 0;

  for (const snap of snapshots) {
    const traj = parseSnapshot(snap);
    if (!traj || typeof traj.agent_run_id !== "string") {
      droppedMalformed++;
      continue;
    }
    const row = buildExportRow(snap, runsById.get(traj.agent_run_id), options);
    if (!row) {
      droppedMalformed++;
      continue;
    }

    // The same-run attribution table is the repairable canonical source. A
    // retro-repair can intentionally flip an attribution after the immutable
    // trajectory copy was written; do not re-export that stale success signal.
    const canonicalAttributions = store.getModelAttributions(row.agent_run_id);
    if (canonicalAttributions.length > 0) {
      row.model_attributions = canonicalAttributions;
    }
    if (row.reward < minReward) {
      droppedBelowThreshold++;
      continue;
    }
    rows.push(row);
  }

  return {
    rows,
    stats: {
      scanned: snapshots.length,
      kept: rows.length,
      droppedBelowThreshold,
      droppedMalformed,
    },
  };
}
