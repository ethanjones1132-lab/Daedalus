import type { SkillDistillationConfig } from "../config";
import type { SkillCandidate, SkillRejectionReason } from "./skill-types";
import {
  decodeSkillTrajectoryPayload,
  decodeSkillTrajectorySnapshot,
  type DecodedSkillTrajectory,
} from "./skill-source-evidence";
import { isValidSkillCandidate } from "./skill-candidate-validation";
import {
  listSkillCandidates,
  promoteSkillCandidateFromAcceptedDecision,
  readSkillCandidate,
  skillCandidateLifecycleVersion,
  updateSkillCandidateStatus,
  verifySkillCandidatePromotionEvidence,
  type SkillCandidatePromotionError,
} from "./skill-store";
import { judgeAnswer, type JudgeVerdict } from "../eval/judge";
import type { CallModelFn } from "../orchestration/coordinator";
import { SelfTuningStore, type TrajectorySnapshot } from "../self-tuning/store";

/**
 * Body-length sweet spot for a distilled skill.
 *
 * 2026-07-15 cron observation: in 197 production-distilled candidates the
 * 400-char floor was rejecting 89 candidates whose bodies were 157-391
 * chars — all from legitimate short user requests (median 225, p90 305).
 * The body template is ~110 chars on its own, so 400 over-fitted to the
 * original "must have substantial guidance" intent. 150 is the smallest
 * floor that still keeps a blank template from clearing the gate.
 */
export const MIN_DISTILLED_BODY_LENGTH = 150;
/** Above 4000 chars the body is almost certainly copying the full conversation
 * history into the skill, which makes it brittle and unfocused. */
export const MAX_DISTILLED_BODY_LENGTH = 4000;

/** Marker that separates the distiller's "guidance" section from the verbatim
 * user request. Only suspicious paths appearing BEFORE this marker are counted
 * as evidence the model invented paths in its own guidance. Paths inside the
 * request context are by definition the user's, not the model's. */
const REQUEST_CONTEXT_MARKER = "## Request context (abbreviated)";

/** Return the part of the body that the model authored (everything before
 * the request-context marker). Empty string if the marker is missing. */
function bodyGuidanceSection(body: string): string {
  const idx = body.indexOf(REQUEST_CONTEXT_MARKER);
  return idx === -1 ? body : body.slice(0, idx);
}

/** Deterministic eval proxy until live replay harness covers distilled skills. */
export function scoreSkillCandidate(candidate: SkillCandidate): number {
  if (!isValidSkillCandidate(candidate)) return 0;
  let score = candidate.confidence;
  if (candidate.body.includes("## Conductor worker guidance")) score += 0.05;
  if (candidate.trigger.signals.length >= 2) score += 0.03;
  if (candidate.body.length > MIN_DISTILLED_BODY_LENGTH && candidate.body.length < MAX_DISTILLED_BODY_LENGTH) score += 0.02;
  // Penalize likely hallucinated absolute paths not grounded in source runs.
  const suspiciousPaths = (bodyGuidanceSection(candidate.body).match(/\b[A-Z]:\\|\b\/etc\/|\b\/usr\//g) ?? []).length;
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
  if (!isValidSkillCandidate(candidate)) {
    return {
      promote: false,
      score: 0,
      baseline: 0.5,
      reason: "manual",
      detail: "invalid candidate record",
    };
  }
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
  if (candidate.body.length <= MIN_DISTILLED_BODY_LENGTH || candidate.body.length >= MAX_DISTILLED_BODY_LENGTH) {
    return {
      promote: false,
      score: scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "body_length_out_of_range",
      detail: `body length ${candidate.body.length} outside ${MIN_DISTILLED_BODY_LENGTH}..${MAX_DISTILLED_BODY_LENGTH} sweet spot`,
    };
  }
  // 2026-07-15 cron fix: only count suspicious paths in the model-authored
  // "guidance" section. Paths in the user request (everything after the
  // request-context marker) are legitimate by definition — the model
  // can't have hallucinated them, the user typed them. Before this fix
  // the check was rejecting 15 real candidates whose user request
  // legitimately contained 3+ project paths (median body 1341, p90 2370).
  const guidanceSection = bodyGuidanceSection(candidate.body);
  const suspiciousPaths = (guidanceSection.match(/\b[A-Z]:\\|\b\/etc\/|\b\/usr\//g) ?? []).length;
  if (suspiciousPaths > 2) {
    return {
      promote: false,
      score: scoreSkillCandidate(candidate),
      baseline: 0.5,
      reason: "suspicious_paths",
      detail: `${suspiciousPaths} absolute/rooted paths in body guidance — likely hallucinated`,
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

/** A heuristic-passing candidate that this pass refuses to promote because it
 *  carries no content-addressed promotion proof. `evidence_required` means,
 *  literally, that explicit evidence must be supplied through
 *  `promoteSkillCandidate`/`promoteCandidates` before any promotion. */
export interface SkillPromotionEvidenceRequired {
  candidate: SkillCandidate;
  verdict: SkillPromotionVerdict;
}

export interface SkillPromotionPassResult {
  /**
   * Always empty: this heuristic pass has no promotion authority. Retained so
   * callers that read a `promoted` field keep a stable shape.
   */
  promoted: SkillCandidate[];
  rejected: SkillCandidate[];
  /** Heuristic-passing candidates left untouched, pending explicit proof. */
  evidence_required: SkillPromotionEvidenceRequired[];
  total_evaluated: number;
}

/**
 * Heuristic-only pre-screen. It never promotes: a candidate that clears every
 * cheap gate is left in place and surfaced as `evidence_required`, because a
 * heuristic score is not promotion authority. Only a heuristic failure is
 * persisted, and only for a still-`candidate` record under its lifecycle
 * version guard — staged/inactive records are never listed here and are never
 * touched. Promotion itself must go through `promoteSkillCandidate` with
 * explicit proof.
 */
export function runSkillPromotionPass(
  config: SkillDistillationConfig,
): SkillPromotionPassResult {
  const result: SkillPromotionPassResult = {
    promoted: [],
    rejected: [],
    evidence_required: [],
    total_evaluated: 0,
  };
  if (!config.enabled) return result;
  for (const candidate of listSkillCandidates("candidate")) {
    result.total_evaluated += 1;
    const verdict = evaluateSkillPromotion(candidate, config);
    if (verdict.promote) {
      // No promotion authority here — record the heuristic pass and move on.
      result.evidence_required.push({ candidate, verdict });
      continue;
    }
    // Persist the heuristic rejection so the operator can diagnose why a
    // candidate didn't promote and so the next pass doesn't re-evaluate it.
    // Guarded to candidate records under their current lifecycle version so a
    // concurrent write (e.g. staging) can never be clobbered.
    if (verdict.reason && candidate.status === "candidate") {
      const updated = updateSkillCandidateStatus(
        candidate.id,
        "rejected",
        verdict.score,
        verdict.reason,
        verdict.detail,
        undefined,
        skillCandidateLifecycleVersion(candidate),
      );
      if (updated) result.rejected.push(updated);
    }
  }
  return result;
}

export type SkillPromotionDecision = {
  candidate_id: string;
  judge_score: number;
  decision: "promote" | "reject" | "blocked";
  rationale: string;
  /**
   * Machine-readable cause when `decision === "blocked"` — a gate, proof, or
   * write failure. A blocked decision leaves the staged candidate exactly as
   * it was; it is not a persisted rejection.
   */
  reason?: string;
  /** Snapshot of the candidate JSON before promotion, used for rollback. */
  rollback_revision_id?: string;
};

/**
 * A bulk promotion request: the exact content-addressed proof produced for one
 * authoritative candidate, bound to that candidate's id. Callers cannot pass
 * raw ids, caller-supplied metrics, or judge scores; the only authority is the
 * proof, which `promoteSkillCandidate` re-verifies before any gate runs.
 */
export type SkillPromotionRequest = SkillPromotionProof & {
  candidateId: string;
};

function isSkillPromotionRequest(value: unknown): value is SkillPromotionRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.candidateId === "string" &&
    value.candidateId.length > 0 &&
    typeof value.reportHash === "string" &&
    value.reportHash.length > 0 &&
    typeof value.decisionRecordHash === "string" &&
    value.decisionRecordHash.length > 0 &&
    typeof value.expectedLifecycleVersion === "number" &&
    Number.isSafeInteger(value.expectedLifecycleVersion) &&
    value.expectedLifecycleVersion >= 0
  );
}

/**
 * Bulk-promote candidates that each carry explicit, content-addressed proof.
 *
 * This surface has no id-only authority and never trusts caller metrics. Every
 * request must name a candidate id and the exact proof tuple produced for it;
 * empty, malformed, or duplicate-candidate request lists are rejected before
 * any model call. Each authoritative candidate must be either the exact
 * staged/version named by the proof or the exact promoted-retry (version + 1).
 * A fresh staged candidate additionally keeps the saved `eval_score >=
 * min_judge_score` precondition, which is a precondition only and never
 * promotion authority.
 *
 * All candidate evidence verifications run before any model call; each passing
 * request is then handed to `promoteSkillCandidate`, which re-verifies the
 * proof before its own gates. A decision is `"promote"` only when the candidate
 * reads back exactly as promoted. Every gate, proof, or write failure is an
 * honest `"blocked"` result that leaves the staged candidate unchanged — it is
 * never reported as a persisted rejection.
 */
export async function promoteCandidates(
  requests: readonly SkillPromotionRequest[],
  callModel: CallModelFn,
  config: SkillDistillationConfig,
  fetchSnapshot: SnapshotFetcher = defaultSnapshotFetcher,
): Promise<SkillPromotionDecision[]> {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error("promotion_request_invalid: at least one promotion request is required");
  }
  const seenCandidateIds = new Set<string>();
  for (const request of requests) {
    if (!isSkillPromotionRequest(request)) {
      throw new Error("promotion_request_invalid: malformed promotion request");
    }
    if (seenCandidateIds.has(request.candidateId)) {
      throw new Error(`promotion_request_invalid: duplicate candidate ${request.candidateId}`);
    }
    seenCandidateIds.add(request.candidateId);
  }

  const minJudgeScore = config.min_judge_score ?? 0.75;
  const decisions = new Map<string, SkillPromotionDecision>();
  const preflight: { request: SkillPromotionRequest; candidate: SkillCandidate; priorJson: string; isPromotedRetry: boolean }[] = [];

  const block = (candidateId: string, reason: string, rationale: string, judgeScore = 0): void => {
    decisions.set(candidateId, {
      candidate_id: candidateId,
      judge_score: judgeScore,
      decision: "blocked",
      reason,
      rationale,
    });
  };

  // Pre-flight every request before any model call: resolve the authoritative
  // candidate, pin the permitted lifecycle revision, keep the saved judge
  // precondition for fresh staged candidates, then verify the proof. This
  // verification only fails fast — the actual authority is re-verified inside
  // `promoteSkillCandidate` immediately before its gates.
  for (const request of requests) {
    const candidateId = request.candidateId;
    const read = readSkillCandidate(candidateId);
    if (!read.ok) {
      block(candidateId, read.error, `candidate ${candidateId} could not be resolved (${read.error})`);
      continue;
    }
    const candidate = read.candidate;
    const observedVersion = skillCandidateLifecycleVersion(candidate);
    const isFreshStaged =
      candidate.status === "staged" && observedVersion === request.expectedLifecycleVersion;
    const isPromotedRetry =
      candidate.status === "promoted" && observedVersion === request.expectedLifecycleVersion + 1;
    if (!isFreshStaged && !isPromotedRetry) {
      if (observedVersion !== request.expectedLifecycleVersion) {
        block(
          candidateId,
          "stale_version",
          `current version is ${observedVersion}, proof expected ${request.expectedLifecycleVersion}`,
          candidate.eval_score ?? 0,
        );
      } else {
        block(
          candidateId,
          "wrong_status",
          `status is ${candidate.status}, proof expected staged or a promoted retry`,
          candidate.eval_score ?? 0,
        );
      }
      continue;
    }
    if (isFreshStaged) {
      const score = candidate.eval_score;
      if (score === undefined || score < minJudgeScore) {
        block(
          candidateId,
          "judge_required",
          `saved eval_score ${score ?? "undefined"} < min_judge_score ${minJudgeScore}`,
          score ?? 0,
        );
        continue;
      }
    }
    const verification = verifySkillCandidatePromotionEvidence({
      candidateId,
      reportHash: request.reportHash,
      decisionRecordHash: request.decisionRecordHash,
      expectedLifecycleVersion: request.expectedLifecycleVersion,
    });
    if (!verification.ok) {
      block(
        candidateId,
        verification.error,
        verification.detail ?? "promotion evidence verification failed",
        candidate.eval_score ?? 0,
      );
      continue;
    }
    preflight.push({ request, candidate, priorJson: JSON.stringify(candidate), isPromotedRetry });
  }

  // Only after every request has been resolved and verified do model calls
  // begin. `promoteSkillCandidate` re-verifies the proof before its gates, so
  // no model or gate work can establish provenance on its own.
  for (const { request, candidate, priorJson, isPromotedRetry } of preflight) {
    const result = await promoteSkillCandidate(
      candidate.id,
      callModel,
      config,
      {
        reportHash: request.reportHash,
        decisionRecordHash: request.decisionRecordHash,
        expectedLifecycleVersion: request.expectedLifecycleVersion,
      },
      fetchSnapshot,
    );

    if (result.ok && result.candidate?.status === "promoted") {
      decisions.set(candidate.id, {
        candidate_id: candidate.id,
        judge_score: result.candidate.eval_score ?? result.verdict?.score ?? candidate.eval_score ?? 0,
        decision: "promote",
        rationale: "verified promotion proof; candidate reads back as promoted",
        ...(isPromotedRetry ? {} : { rollback_revision_id: priorJson }),
      });
      continue;
    }
    block(
      candidate.id,
      result.error ?? "promotion_not_confirmed",
      result.detail ?? result.error ?? "promotion did not read back as promoted",
      result.verdict?.score ?? candidate.eval_score ?? 0,
    );
  }

  return requests.map((request) => {
    const decision = decisions.get(request.candidateId);
    if (decision) return decision;
    return {
      candidate_id: request.candidateId,
      judge_score: 0,
      decision: "blocked",
      reason: "promotion_not_confirmed",
      rationale: "candidate was not processed",
    };
  });
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
  [key: string]: unknown;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecodedTrajectory(value: GroundingSnapshot | DecodedSkillTrajectory | null): value is DecodedSkillTrajectory {
  return isRecord(value) && value.version === 1 && Array.isArray(value.stage_runs) && typeof value.tool_sequence_digest === "string";
}

function decodeGroundingSnapshot(
  snapshot: GroundingSnapshot,
  sourceRunId: string,
  sourceSessionId?: string,
) {
  if (typeof snapshot.snapshot_json === "string") {
    return decodeSkillTrajectorySnapshot(snapshot as unknown as TrajectorySnapshot);
  }
  return decodeSkillTrajectoryPayload(snapshot, {
    agentRunId: sourceRunId,
    ...(sourceSessionId === undefined ? {} : { sessionId: sourceSessionId }),
  });
}

const OBSERVABLE_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
  "bash",
  "powershell",
  "web_fetch",
  "web_search",
  "git_metadata",
  "mcp_call_tool",
  "todo_write",
  "todo_list",
  "tools_enum",
  "run_background_command",
  "agent",
  "task_create",
  "task_list",
  "task_get",
  "task_output",
  "task_stop",
  "delegate",
  "shell_execute",
]);

function looksLikeToolToken(value: string): boolean {
  if (OBSERVABLE_TOOL_NAMES.has(value)) return true;
  if (!value.includes("_")) return false;
  return /(tool|file|read|write|edit|patch|glob|grep|list|fetch|search|bash|shell|agent|task|delegate|mcp|git|todo|powershell|run)/.test(value);
}

function mentionedToolNames(body: string): string[] {
  const guidance = bodyGuidanceSection(body);
  const names = new Set<string>();
  for (const match of guidance.matchAll(/`([^`\n]{1,80})`/g)) {
    const value = match[1].trim();
    if (/^[a-z][a-z0-9_]*$/.test(value) && looksLikeToolToken(value)) names.add(value);
  }
  for (const match of guidance.matchAll(/\b[a-z][a-z0-9_]{1,63}\b/g)) {
    const value = match[0];
    if (looksLikeToolToken(value)) names.add(value);
  }
  return [...names];
}

function pathValues(text: string): string[] {
  const values: string[] = [];
  const pattern = /(?:[A-Za-z]:[\\/][^\s"'`<>]+|(?:~|\.{1,2})?\/[^\s"'`<>]+|\b[\w.-]+\/[\w./-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|toml|yaml|yml|html|css|sh)\b)/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[0].replace(/[),.;:!?]+$/g, "").replace(/\\/g, "/");
    if (value.length <= 240) values.push(value);
    if (values.length >= 64) break;
  }
  return values;
}

function collectArgumentPaths(value: unknown, key: string, result: Set<string>, depth = 0): void {
  if (depth > 4 || result.size >= 64) return;
  if (typeof value === "string") {
    if (/path|file|dir|cwd|target|root/i.test(key) || /[\\/]|\.[a-z0-9]+$/i.test(value)) {
      for (const path of pathValues(value)) result.add(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArgumentPaths(item, key, result, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectArgumentPaths(childValue, childKey, result, depth + 1);
    }
  }
}

function observedPaths(trajectory: DecodedSkillTrajectory): string[] {
  const result = new Set<string>();
  for (const stage of trajectory.stage_runs) {
    for (const call of stage.tool_calls) {
      if (call.arguments) collectArgumentPaths(call.arguments, "argument", result);
    }
  }
  for (const path of pathValues(trajectory.user_request)) result.add(path);
  for (const instruction of Object.values(trajectory.worker_instructions)) {
    for (const path of pathValues(instruction)) result.add(path);
  }
  return [...result].slice(0, 64);
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function pathIsObserved(candidatePath: string, sourcePaths: readonly string[]): boolean {
  const candidate = normalizedPath(candidatePath);
  return sourcePaths.some((sourcePath) => {
    const source = normalizedPath(sourcePath);
    return source === candidate || source.endsWith(`/${candidate}`) || candidate.endsWith(`/${source}`);
  });
}

function ungroundedClaim(candidate: SkillCandidate, trajectory: DecodedSkillTrajectory): string | null {
  const observedTools = new Set(trajectory.stage_runs.flatMap((stage) => stage.tool_names));
  for (const tool of mentionedToolNames(candidate.body)) {
    if (!observedTools.has(tool)) return "tool claim is absent from source evidence";
  }
  const sourcePaths = observedPaths(trajectory);
  for (const path of pathValues(bodyGuidanceSection(candidate.body))) {
    if (!pathIsObserved(path, sourcePaths)) return "path claim is absent from source evidence";
  }
  return null;
}

function evidenceSummary(trajectory: DecodedSkillTrajectory): string {
  const tools = trajectory.stage_runs.flatMap((stage) => stage.tool_names).slice(0, 64);
  const paths = observedPaths(trajectory).slice(0, 32);
  return [
    `Observed tools (ordered): ${tools.length > 0 ? tools.join(", ") : "none recorded"}`,
    `Observed paths (bounded): ${paths.length > 0 ? paths.join(", ") : "none recorded"}`,
  ].join("\n");
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
  snapshot: GroundingSnapshot | DecodedSkillTrajectory | null,
): string[] {
  const rubric: string[] = [];
  const taskType = candidate.trigger.task_types[0];
  if (taskType) {
    rubric.push(`the body mentions the task type "${taskType}"`);
  }
  rubric.push("the body does not state an absolute path that is absent from the source run");
  const workerInstructions = snapshot && isRecord(snapshot.worker_instructions)
    ? snapshot.worker_instructions
    : undefined;
  if (workerInstructions && Object.keys(workerInstructions).length > 0) {
    rubric.push("the body includes a worker guidance section");
  }
  if (isDecodedTrajectory(snapshot)) {
    const tools = snapshot.stage_runs.flatMap((stage) => stage.tool_names).slice(0, 32);
    const paths = observedPaths(snapshot).slice(0, 16);
    rubric.push(`the body names only tools observed in the source run: ${tools.length > 0 ? tools.join(", ") : "none recorded"}`);
    rubric.push(`the body names only paths observed in the source run: ${paths.length > 0 ? paths.join(", ") : "none recorded"}`);
  }
  return rubric;
}

export type GroundingJudgeResult =
  | { ok: true; verdict: JudgeVerdict }
  | { ok: false; error: "no_grounding_source" | "judge_unavailable" | "judge_invalid"; detail?: string };

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
  if (!isValidSkillCandidate(candidate)) {
    return { ok: false, error: "judge_invalid", detail: "invalid candidate record" };
  }
  const sourceRunId = candidate.source_run_ids[0];
  const snapshot = sourceRunId ? fetchSnapshot(sourceRunId) : null;
  if (!snapshot) {
    return { ok: false, error: "no_grounding_source" };
  }
  const decoded = decodeGroundingSnapshot(
    snapshot,
    sourceRunId,
    candidate.source_session_id,
  );
  if (!decoded.ok) {
    return { ok: false, error: "no_grounding_source", detail: "source evidence failed validation" };
  }
  if (decoded.trajectory.tool_sequence_digest !== candidate.tool_sequence_digest) {
    return { ok: false, error: "no_grounding_source", detail: "source tool evidence digest is missing or mismatched" };
  }
  const claim = ungroundedClaim(candidate, decoded.trajectory);
  if (claim) {
    return { ok: false, error: "no_grounding_source", detail: claim };
  }

  const rubric = buildGroundingRubric(candidate, decoded.trajectory);
  const request = [
    decoded.trajectory.user_request,
    "",
    "Source-run evidence (bounded, tool names and path targets only):",
    evidenceSummary(decoded.trajectory),
  ].join("\n");

  try {
    const verdict = await judgeAnswer(callModel, request, candidate.body, rubric);
    if (!verdict.valid) {
      return { ok: false, error: "judge_invalid", detail: verdict.rationale };
    }
    return { ok: true, verdict };
  } catch {
    return { ok: false, error: "judge_unavailable", detail: "grounding judge unavailable" };
  }
}

/** Explicit proof that must accompany a promotion request. The evidence
 *  report and the accepted-decision record are content-addressed by hash, and
 *  `expectedLifecycleVersion` pins the exact staged revision the proof was
 *  produced against so verification cannot race a concurrent write. */
export type SkillPromotionProof = {
  reportHash: string;
  decisionRecordHash: string;
  expectedLifecycleVersion: number;
};

export interface PromoteSkillCandidateResult {
  ok: boolean;
  error?:
    | "candidate_not_found"
    | "invalid_candidate_record"
    | "wrong_status"
    | "stale_version"
    | "evidence_verification_failed"
    | "heuristic_rejected"
    | "no_grounding_source"
    | "judge_unavailable"
    | "judge_invalid"
    | "below_judge_threshold"
    | "promotion_write_failed"
    | SkillCandidatePromotionError;
  detail?: string;
  candidate?: SkillCandidate;
  verdict?: JudgeVerdict;
}

/**
 * Promote a single staged candidate backed by explicit promotion evidence.
 *
 * Ordering is load-bearing:
 *  1. authoritative read + lifecycle-version check,
 *  2. `verifySkillCandidatePromotionEvidence` — proof is checked *before* any
 *     heuristic, grounding, or judge work, so none of that work is trusted to
 *     establish the provenance of the promotion,
 *  3. `alreadyPromoted` short-circuits without calling the model,
 *  4. otherwise the existing heuristic, grounding/source, and judge gates run
 *     against a shallow local copy (persisted object is never mutated),
 *  5. only after every gate passes is the accepted-decision writer invoked,
 *     and promotion is reported only if that write reads back as promoted.
 *
 * Any gate failure leaves the staged candidate untouched — there is no generic
 * lifecycle transition or rejection write here.
 */
export async function promoteSkillCandidate(
  id: string,
  callModel: CallModelFn,
  config: SkillDistillationConfig,
  proof: SkillPromotionProof,
  fetchSnapshot: SnapshotFetcher = defaultSnapshotFetcher,
): Promise<PromoteSkillCandidateResult> {
  const proofTuple = {
    reportHash: proof.reportHash,
    decisionRecordHash: proof.decisionRecordHash,
    expectedLifecycleVersion: proof.expectedLifecycleVersion,
  };

  const read = readSkillCandidate(id);
  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  const candidate = read.candidate;
  const observedVersion = skillCandidateLifecycleVersion(candidate);
  const isFreshStaged =
    candidate.status === "staged" && observedVersion === proof.expectedLifecycleVersion;
  const isPromotedRetry =
    candidate.status === "promoted" && observedVersion === proof.expectedLifecycleVersion + 1;
  if (!isFreshStaged && !isPromotedRetry) {
    if (observedVersion !== proof.expectedLifecycleVersion) {
      return { ok: false, error: "stale_version", detail: `current version is ${observedVersion}` };
    }
    return { ok: false, error: "wrong_status", detail: `status is ${candidate.status}` };
  }

  const verification = verifySkillCandidatePromotionEvidence({ candidateId: id, ...proofTuple });
  if (!verification.ok) {
    return { ok: false, error: verification.error, detail: verification.detail };
  }
  if (isPromotedRetry) {
    if (verification.alreadyPromoted !== true) {
      return {
        ok: false,
        error: "evidence_verification_failed",
        detail: "promoted retry did not verify as the exact promotion event and post-state",
      };
    }
    return { ok: true, candidate: verification.candidate };
  }
  if (verification.alreadyPromoted === true) {
    return { ok: true, candidate: verification.candidate };
  }

  const evaluationCandidate: SkillCandidate = { ...candidate, status: "candidate" };
  const heuristic = evaluateSkillPromotion(evaluationCandidate, config);
  if (!heuristic.promote) {
    return { ok: false, error: "heuristic_rejected", detail: heuristic.detail, candidate };
  }

  const grounding = await runGroundingJudge(candidate, callModel, fetchSnapshot);
  if (!grounding.ok) {
    if (grounding.error === "no_grounding_source") {
      return { ok: false, error: "no_grounding_source", detail: grounding.detail, candidate };
    }
    if (grounding.error === "judge_invalid") {
      return { ok: false, error: "judge_invalid", detail: grounding.detail, candidate };
    }
    return { ok: false, error: "judge_unavailable", detail: grounding.detail, candidate };
  }

  const verdict = grounding.verdict;
  const minJudgeScore = config.min_judge_score ?? 0.75;
  if (verdict.score < minJudgeScore) {
    return {
      ok: false,
      error: "below_judge_threshold",
      detail: `judge score ${verdict.score.toFixed(3)} < min_judge_score ${minJudgeScore}`,
      candidate,
      verdict,
    };
  }

  const writer = promoteSkillCandidateFromAcceptedDecision({ candidateId: id, ...proofTuple });
  if (!writer.ok) {
    return {
      ok: false,
      error: "promotion_write_failed",
      detail: writer.detail ?? (typeof writer.error === "string" ? writer.error : "promotion write failed"),
      candidate,
      verdict,
    };
  }

  return { ok: true, candidate: writer.candidate, verdict };
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