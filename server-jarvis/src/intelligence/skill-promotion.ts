import type { SkillDistillationConfig } from "../config";
import type { SkillCandidate, SkillRejectionReason } from "./skill-types";
import { listSkillCandidates, loadSkillCandidate, updateSkillCandidateStatus } from "./skill-store";
import { judgeAnswer, type JudgeVerdict } from "../eval/judge";
import type { CallModelFn } from "../orchestration/coordinator";
import { SelfTuningStore, type TrajectorySnapshot } from "../self-tuning/store";

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

export interface SkillPromotionVerdict {
  promote: boolean;
  score: number;
  baseline: number;
  /**
   * Why the candidate was not promoted, if applicable. Absent when
   * `promote === true` (or when the verdict is "wrong_status" but the
   * candidate was already a non-candidate, in which case promotion
   * shouldn't be re-attempted).
   */
  reason?: SkillRejectionReason;
  detail?: string;
}

/**
 * Evaluate a candidate for promotion and return a structured verdict
 * including the reason for rejection. The reason is stable, machine-
 * typed, and human-readable via `detail` so it can be logged, returned
 * over HTTP, and shown in the operator UI without re-deriving it.
 */
export function evaluateSkillPromotion(
  candidate: SkillCandidate,
  config: SkillDistillationConfig,
): SkillPromotionVerdict {
  if (candidate.status !== "candidate") {
    return {
      promote: false,
      score: candidate.eval_score ?? scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "wrong_status",
      detail: `candidate status is "${candidate.status}", not "candidate"`,
    };
  }
  if (candidate.confidence < config.min_confidence) {
    return {
      promote: false,
      score: candidate.confidence,
      baseline: 0.5,
      reason: "low_confidence",
      detail: `confidence ${candidate.confidence.toFixed(3)} < min_confidence ${config.min_confidence}`,
    };
  }
  if (candidate.trigger.signals.length === 0) {
    return {
      promote: false,
      score: candidate.confidence,
      baseline: 0.5,
      reason: "missing_signals",
      detail: "trigger has no signals — would match every turn, unsafe to promote",
    };
  }
  if (candidate.body.length <= 400 || candidate.body.length >= 4000) {
    return {
      promote: false,
      score: scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "body_length_out_of_range",
      detail: `body length ${candidate.body.length} outside 400..4000 sweet spot`,
    };
  }
  const suspiciousPaths = (candidate.body.match(/\b[A-Z]:\\|\b\/etc\/|\b\/usr\//g) ?? []).length;
  if (suspiciousPaths > 2) {
    return {
      promote: false,
      score: scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "suspicious_paths",
      detail: `${suspiciousPaths} absolute/rooted paths in body — likely hallucinated`,
    };
  }
  const score = scoreSkillCandidate(candidate);
  const baseline = 0.5;
  const delta = score - baseline;
  if (delta < config.promotion_eval_delta) {
    return {
      promote: false,
      score,
      baseline,
      reason: "below_eval_delta",
      detail: `score delta ${delta.toFixed(3)} < promotion_eval_delta ${config.promotion_eval_delta}`,
    };
  }
  return { promote: true, score, baseline };
}

export interface SkillPromotionPassResult {
  promoted: SkillCandidate[];
  rejected: SkillCandidate[];
  total_evaluated: number;
}

export function runSkillPromotionPass(
  config: SkillDistillationConfig,
): SkillPromotionPassResult {
  const result: SkillPromotionPassResult = { promoted: [], rejected: [], total_evaluated: 0 };
  if (!config.enabled) return result;
  for (const candidate of listSkillCandidates("candidate")) {
    result.total_evaluated += 1;
    const verdict = evaluateSkillPromotion(candidate, config);
    if (verdict.promote) {
      const updated = updateSkillCandidateStatus(candidate.id, "promoted", verdict.score);
      if (updated) result.promoted.push(updated);
      continue;
    }
    // Persist the rejection so the operator can diagnose why a candidate
    // didn't promote and so the next pass doesn't re-evaluate it. Clear
    // the stale rejection_reason if the candidate was previously
    // rejected and is now being re-evaluated (only happens after a
    // manual status reset, which is rare but supported).
    if (verdict.reason) {
      const updated = updateSkillCandidateStatus(
        candidate.id,
        "rejected",
        verdict.score,
        verdict.reason,
        verdict.detail,
      );
      if (updated) result.rejected.push(updated);
    }
  }
  return result;
}

export type SkillPromotionDecision = {
  candidate_id: string;
  judge_score: number;
  decision: "promote" | "reject";
  rationale: string;
  /** Snapshot of the candidate JSON before promotion, used for rollback. */
  rollback_revision_id?: string;
};

/**
 * Bulk-promote only candidates that already have a passing judge decision.
 * Unlike `runSkillPromotionPass` (heuristic-only), this gate refuses to act
 * on any candidate whose `eval_score` is missing or below `min_judge_score`,
 * ensuring scheduled/bulk promotion cannot bypass the semantic judge.
 *
 * Throws "judge_required" if any requested candidate lacks a passing judge
 * decision, leaving all candidates untouched.
 */
export async function promoteCandidates(
  ids: string[],
  callModel: CallModelFn,
  config: SkillDistillationConfig,
  fetchSnapshot: SnapshotFetcher = defaultSnapshotFetcher,
): Promise<SkillPromotionDecision[]> {
  const minJudgeScore = config.min_judge_score ?? 0.75;

  // Pre-flight: every candidate must have a passing judge decision. This is
  // intentionally strict — a missing decision aborts the whole batch so an
  // operator cannot accidentally promote an un-judged candidate through a
  // bulk call.
  const pending: { candidate: SkillCandidate; priorJson: string }[] = [];
  for (const id of ids) {
    const candidate = loadSkillCandidate(id);
    if (!candidate) {
      throw new Error(`judge_required: candidate ${id} not found`);
    }
    if (candidate.status !== "candidate") {
      throw new Error(
        `judge_required: candidate ${id} status is ${candidate.status}, expected candidate`,
      );
    }
    const score = candidate.eval_score;
    if (score === undefined || score < minJudgeScore) {
      throw new Error(
        `judge_required: candidate ${id} has eval_score ${score ?? "undefined"} < ${minJudgeScore}`,
      );
    }
    pending.push({ candidate, priorJson: JSON.stringify(candidate) });
  }

  const decisions: SkillPromotionDecision[] = [];
  for (const { candidate, priorJson } of pending) {
    const result = await promoteSkillCandidate(candidate.id, callModel, config, fetchSnapshot);
    if (!result.ok) {
      // Re-evaluate after a fresh judge call failed: this is an infra issue,
      // not a grounded rejection. Surface it as a reject decision but do not
      // leave the candidate promoted.
      if (result.error === "judge_unavailable") {
        decisions.push({
          candidate_id: candidate.id,
          judge_score: candidate.eval_score ?? 0,
          decision: "reject",
          rationale: result.detail ?? "judge unavailable",
        });
        continue;
      }
      // For other hard errors (should not happen after pre-flight), treat as reject.
      decisions.push({
        candidate_id: candidate.id,
        judge_score: candidate.eval_score ?? 0,
        decision: "reject",
        rationale: result.detail ?? result.error ?? "unknown",
      });
      continue;
    }

    const finalScore = result.candidate?.eval_score ?? candidate.eval_score ?? 0;
    if (result.candidate?.status === "promoted") {
      decisions.push({
        candidate_id: candidate.id,
        judge_score: finalScore,
        decision: "promote",
        rationale: "passed judge and heuristic gates",
        rollback_revision_id: priorJson,
      });
    } else {
      decisions.push({
        candidate_id: candidate.id,
        judge_score: finalScore,
        decision: "reject",
        rationale: result.candidate?.rejection_detail ?? "failed promotion gates",
      });
    }
  }

  return decisions;
}

// ═══════════════════════════════════════════════════════════════
// D2 (organism loop v1): judge-gated promotion. The heuristic gates above
// are a cheap pre-screen; a candidate that clears them still has to ground
// against its source trajectory via an LLM judge before it can actually be
// promoted and start injecting into live prompts.
// ═══════════════════════════════════════════════════════════════

/** Minimal shape of a parsed trajectory snapshot this module needs — see
 *  `conductor-learning.ts`'s `completeRun()` for the full snapshot schema. */
export interface GroundingSnapshot {
  worker_instructions?: Record<string, string>;
  user_request?: string;
}

/** Fetches the grounding snapshot for an agent run. Injectable for tests;
 *  defaults to a real lookup against the self-tuning trajectory store. */
export type SnapshotFetcher = (agentRunId: string) => GroundingSnapshot | null;

function defaultSnapshotFetcher(agentRunId: string): GroundingSnapshot | null {
  const store = new SelfTuningStore();
  const match = store
    .getTrajectorySnapshots(1000)
    .find((s: TrajectorySnapshot) => s.agent_run_id === agentRunId);
  if (!match) return null;
  try {
    return JSON.parse(match.snapshot_json) as GroundingSnapshot;
  } catch {
    return null;
  }
}

/**
 * Deterministic rubric derived from the candidate and its source trajectory
 * snapshot. Kept deliberately small and factual — the judge does exact-
 * verbatim matching on rubric item text (see `eval/judge.ts`), so items are
 * short claims a reader can check against the candidate body, not open-ended
 * questions.
 */
export function buildGroundingRubric(
  candidate: SkillCandidate,
  snapshot: GroundingSnapshot | null,
): string[] {
  const rubric: string[] = [];
  const taskType = candidate.trigger.task_types[0];
  if (taskType) {
    rubric.push(`the body mentions the task type "${taskType}"`);
  }
  rubric.push("the body does not state an absolute path that is absent from the source run");
  const hasWorkerInstructions =
    !!snapshot?.worker_instructions && Object.keys(snapshot.worker_instructions).length > 0;
  if (hasWorkerInstructions) {
    rubric.push("the body includes a worker guidance section");
  }
  return rubric;
}

export type GroundingJudgeResult =
  | { ok: true; verdict: JudgeVerdict }
  | { ok: false; error: "no_grounding_source" | "judge_unavailable"; detail?: string };

/**
 * Runs the semantic grounding check for a candidate: fetch its source
 * trajectory snapshot, build the rubric, and judge the candidate body
 * against it. Shared between `promoteSkillCandidate` (which acts on the
 * verdict) and the eval-only HTTP endpoint (which just records it).
 */
export async function runGroundingJudge(
  candidate: SkillCandidate,
  callModel: CallModelFn,
  fetchSnapshot: SnapshotFetcher = defaultSnapshotFetcher,
): Promise<GroundingJudgeResult> {
  const sourceRunId = candidate.source_run_ids[0];
  const snapshot = sourceRunId ? fetchSnapshot(sourceRunId) : null;
  if (!snapshot) {
    return { ok: false, error: "no_grounding_source" };
  }

  const rubric = buildGroundingRubric(candidate, snapshot);
  const request = snapshot.user_request ?? candidate.description;

  try {
    const verdict = await judgeAnswer(callModel, request, candidate.body, rubric);
    return { ok: true, verdict };
  } catch (e) {
    return {
      ok: false,
      error: "judge_unavailable",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface PromoteSkillCandidateResult {
  ok: boolean;
  error?: "candidate_not_found" | "wrong_status" | "judge_unavailable";
  detail?: string;
  candidate?: SkillCandidate;
  verdict?: JudgeVerdict;
}

/**
 * Promote (or reject) a single candidate: heuristic gates first (reused from
 * `evaluateSkillPromotion`, unchanged), then — only if those pass — a
 * semantic grounding check via `runGroundingJudge` against the candidate's
 * source trajectory. A judge call failure leaves the candidate untouched in
 * "candidate" status (infra failure is not evidence the skill is bad); only
 * an actual sub-threshold score produces a rejection.
 */
export async function promoteSkillCandidate(
  id: string,
  callModel: CallModelFn,
  config: SkillDistillationConfig,
  fetchSnapshot: SnapshotFetcher = defaultSnapshotFetcher,
): Promise<PromoteSkillCandidateResult> {
  const candidate = loadSkillCandidate(id);
  if (!candidate) {
    return { ok: false, error: "candidate_not_found" };
  }
  if (candidate.status !== "candidate") {
    return { ok: false, error: "wrong_status", detail: `status is ${candidate.status}` };
  }

  const heuristic = evaluateSkillPromotion(candidate, config);
  if (!heuristic.promote) {
    const updated = updateSkillCandidateStatus(
      id,
      "rejected",
      heuristic.score,
      heuristic.reason,
      heuristic.detail,
    );
    return { ok: true, candidate: updated ?? undefined };
  }

  const grounding = await runGroundingJudge(candidate, callModel, fetchSnapshot);
  if (!grounding.ok) {
    if (grounding.error === "no_grounding_source") {
      const updated = updateSkillCandidateStatus(
        id,
        "rejected",
        heuristic.score,
        "eval_failed",
        "no grounding source available",
      );
      return { ok: true, candidate: updated ?? undefined };
    }
    return { ok: false, error: "judge_unavailable", detail: grounding.detail };
  }

  const verdict = grounding.verdict;
  const minJudgeScore = config.min_judge_score ?? 0.75;
  if (verdict.score >= minJudgeScore) {
    const updated = updateSkillCandidateStatus(id, "promoted", verdict.score, undefined, undefined, verdict.missed);
    return { ok: true, candidate: updated ?? undefined, verdict };
  }
  const updated = updateSkillCandidateStatus(
    id,
    "rejected",
    verdict.score,
    "eval_failed",
    `missed: ${verdict.missed.join("; ")}`,
    verdict.missed,
  );
  return { ok: true, candidate: updated ?? undefined, verdict };
}

// ═══════════════════════════════════════════════════════════════
// D5: "performance since promotion" — compares run success rate in the
// window before promotion against the window after, so the operator can see
// whether a promoted skill actually helped.
// ═══════════════════════════════════════════════════════════════

export interface PerformanceWindowStats {
  runs: number;
  successes: number;
  success_rate: number | null;
}

export interface CandidatePerformance {
  id: string;
  promoted_at: string;
  task_types: string[];
  before: PerformanceWindowStats;
  after: PerformanceWindowStats;
  delta: number | null;
}

/** Minimal run shape this computation needs — a real fetch returns `AgentRun[]`
 *  (see `self-tuning/store.ts`), which structurally satisfies this. */
export interface RunOutcomeRow {
  outcome?: string;
}

export type RunWindowFetcher = (
  taskTypes: string[],
  startIsoInclusive: string,
  endIsoExclusive: string,
) => RunOutcomeRow[];

function summarizeWindow(runs: RunOutcomeRow[]): PerformanceWindowStats {
  const successes = runs.filter((r) => r.outcome === "success").length;
  return {
    runs: runs.length,
    successes,
    success_rate: runs.length > 0 ? successes / runs.length : null,
  };
}

/**
 * Compares the candidate's task-type run success rate in an equal-length
 * window before and after `promoted_at`. The "before" window duration
 * matches however much time has elapsed since promotion (capped implicitly
 * by whatever history `fetchRuns` actually returns) — a skill promoted an
 * hour ago is compared against the preceding hour, not an arbitrary fixed
 * window. Returns `null` if the candidate was never promoted.
 */
export function computeCandidatePerformance(
  candidate: SkillCandidate,
  fetchRuns: RunWindowFetcher,
  now: Date = new Date(),
): CandidatePerformance | null {
  if (!candidate.promoted_at) return null;
  const promotedAt = new Date(candidate.promoted_at);
  const elapsedMs = now.getTime() - promotedAt.getTime();
  const beforeStart = new Date(promotedAt.getTime() - elapsedMs);
  const taskTypes = candidate.trigger.task_types;

  const beforeRuns = fetchRuns(taskTypes, beforeStart.toISOString(), promotedAt.toISOString());
  const afterRuns = fetchRuns(taskTypes, promotedAt.toISOString(), now.toISOString());

  const before = summarizeWindow(beforeRuns);
  const after = summarizeWindow(afterRuns);
  const delta =
    before.success_rate !== null && after.success_rate !== null
      ? after.success_rate - before.success_rate
      : null;

  return { id: candidate.id, promoted_at: candidate.promoted_at, task_types: taskTypes, before, after, delta };
}