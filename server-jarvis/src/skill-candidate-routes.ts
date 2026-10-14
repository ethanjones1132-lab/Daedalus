import type { SkillDistillationConfig } from "./config";
import {
  promoteSkillCandidate,
  runGroundingJudge,
  type SnapshotFetcher,
} from "./intelligence/skill-promotion";
import {
  isCanonicalIsoTimestamp,
  readSkillCandidate,
  rollbackSkillCandidateFromAcceptedDecision,
  skillCandidateLifecycleVersion,
  transitionSkillCandidate,
  type SkillCandidateRollbackResult,
  type SkillCandidateTransitionResult,
} from "./intelligence/skill-store";
import type { SkillCandidate } from "./intelligence/skill-types";
import type { CallModelFn } from "./orchestration/coordinator";
import {
  candidateContentDigestV1,
  listLearningEvalDecisionsForCandidate,
  type LearningEvalDecisionRecordV1,
} from "./self-tuning/rollout/learning-eval-decision-store";

export interface SkillCandidateRouteDependencies {
  loadDistillationConfig: () => SkillDistillationConfig;
  makeCallModel: (config: SkillDistillationConfig) => CallModelFn;
  fetchSnapshot?: SnapshotFetcher;
}

type CandidateAction = "eval" | "promote" | "reject" | "demote" | "evaluation" | "rollback";

const ROLLBACK_REASON_CODES = [
  "regression_detected",
  "superseded_by_newer_evidence",
  "manual_rollback",
] as const;
type RollbackReasonCode = (typeof ROLLBACK_REASON_CODES)[number];

function responseBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function transitionErrorResponse(result: Extract<SkillCandidateTransitionResult, { ok: false }>): Response {
  const current = result.current;
  const status = result.error === "candidate_not_found"
    ? 404
    : result.error === "invalid_candidate_record" ? 422 : 409;
  return Response.json({
    error: result.error,
    ...(result.error === "invalid_candidate_record" ? { reason: "invalid_candidate_record" } : {}),
    current_status: current?.status,
    current_version: current ? skillCandidateLifecycleVersion(current) : undefined,
  }, { status });
}

function promotionErrorResponse(result: Awaited<ReturnType<typeof promoteSkillCandidate>>): Response {
  const status = result.error === "candidate_not_found"
    ? 404
    : result.error === "invalid_candidate_record"
      ? 422
      : result.error === "wrong_status" || result.error === "stale_version" ? 409 : 503;
  return Response.json({
    error: result.error,
    ...(result.error === "invalid_candidate_record" ? { reason: "invalid_candidate_record" } : { detail: result.detail }),
    current_status: result.candidate?.status,
    current_version: result.candidate ? skillCandidateLifecycleVersion(result.candidate) : undefined,
  }, { status });
}

function projectEvaluationRecord(
  record: LearningEvalDecisionRecordV1,
  currentStatus: SkillCandidate["status"],
  currentVersion: number,
  currentContentDigest: string,
): Record<string, unknown> {
  const report = record.report;
  return {
    report_hash: report.reportHash,
    record_hash: record.recordHash,
    manifest_hash: report.manifestHash,
    decision: report.decision,
    generated_at: report.generatedAt,
    candidate: {
      id: report.candidate.id,
      content_digest: report.candidate.contentDigest,
      artifact_digest: report.candidate.artifactDigest,
    },
    coverage: {
      planned_task_count: report.coverage.plannedTaskCount,
      seeds_per_task: report.coverage.seedsPerTask,
      arms_per_block: report.coverage.armsPerBlock,
      planned_block_count: report.coverage.plannedBlockCount,
      planned_outcome_count: report.coverage.plannedOutcomeCount,
      observed_outcome_count: report.coverage.observedOutcomeCount,
      missing_outcome_count: report.coverage.missingOutcomeCount,
    },
    criteria: report.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      threshold: criterion.threshold,
      observed: criterion.observed,
      status: criterion.status,
      reason: criterion.reason,
    })),
    reasons: report.reasons,
    observed_status: record.observedCandidateStatus,
    observed_version: record.observedCandidateLifecycleVersion,
    content_match: record.candidateContentDigest === currentContentDigest,
    stale:
      record.observedCandidateStatus !== currentStatus ||
      record.observedCandidateLifecycleVersion !== currentVersion,
  };
}

function evaluationReadErrorResponse(
  failure: Extract<ReturnType<typeof listLearningEvalDecisionsForCandidate>, { ok: false }>,
): Response {
  const status = failure.code === "invalid_record"
    ? 422
    : failure.code === "corrupt_store" ? 500 : 503;
  return Response.json(
    { error: "evaluation_unavailable", code: failure.code, detail: failure.error },
    { status },
  );
}

function rollbackErrorResponse(
  result: Extract<SkillCandidateRollbackResult, { ok: false }>,
): Response {
  const status = result.error === "candidate_not_found"
    ? 404
    : result.error === "record_corrupt"
      ? 500
      : result.error === "evidence_required" ||
          result.error === "decision_not_accepted" ||
          result.error === "candidate_binding_mismatch"
        ? 422
        : result.error === "stale_version" ||
            result.error === "wrong_status" ||
            result.error === "event_conflict" ||
            result.error === "rollback_recorded"
          ? 409
          : 503;
  return Response.json({
    error: result.error,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    current_status: result.current?.status,
    current_version: result.current ? skillCandidateLifecycleVersion(result.current) : undefined,
  }, { status });
}

export async function handleSkillCandidateRequest(
  req: Request,
  dependencies: SkillCandidateRouteDependencies,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const match = path.match(
    /^\/skills\/candidates\/([^/]+)\/(eval|promote|reject|demote|evaluation|rollback)$/,
  );
  if (!match) return null;
  const action = match[2] as CandidateAction;
  if (action === "evaluation" ? req.method !== "GET" : req.method !== "POST") return null;

  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return Response.json({ error: "invalid_candidate_id" }, { status: 400 });
  }
  const read = readSkillCandidate(id);
  if (!read.ok) {
    if (read.error === "invalid_candidate_record") {
      return Response.json({ error: read.error, reason: read.error }, { status: 422 });
    }
    return Response.json({ error: read.error }, { status: 404 });
  }
  const candidate = read.candidate;

  if (action === "evaluation") {
    const listed = listLearningEvalDecisionsForCandidate(id);
    if (!listed.ok) return evaluationReadErrorResponse(listed);
    const currentVersion = skillCandidateLifecycleVersion(candidate);
    const currentContentDigest = candidateContentDigestV1(candidate);
    return Response.json({
      candidate_id: id,
      current_status: candidate.status,
      current_version: currentVersion,
      count: listed.values.length,
      evaluations: listed.values.map((record) =>
        projectEvaluationRecord(record, candidate.status, currentVersion, currentContentDigest),
      ),
    });
  }

  const body = responseBody(await req.json().catch(() => ({})));

  if (action === "promote") {
    if (
      !Object.hasOwn(body, "report_hash") ||
      typeof body.report_hash !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(body.report_hash)
    ) {
      return Response.json({ error: "invalid_report_hash" }, { status: 400 });
    }
    if (
      !Object.hasOwn(body, "record_hash") ||
      typeof body.record_hash !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(body.record_hash)
    ) {
      return Response.json({ error: "invalid_record_hash" }, { status: 400 });
    }
    if (
      !Object.hasOwn(body, "expected_version") ||
      !Number.isSafeInteger(body.expected_version) ||
      (body.expected_version as number) < 0
    ) {
      return Response.json({ error: "invalid_expected_version" }, { status: 400 });
    }
  }

  if (action === "rollback") {
    if (
      !Object.hasOwn(body, "report_hash") ||
      typeof body.report_hash !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(body.report_hash)
    ) {
      return Response.json({ error: "invalid_report_hash" }, { status: 400 });
    }
    if (
      !Object.hasOwn(body, "record_hash") ||
      typeof body.record_hash !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(body.record_hash)
    ) {
      return Response.json({ error: "invalid_record_hash" }, { status: 400 });
    }
    if (
      !Object.hasOwn(body, "expected_version") ||
      !Number.isSafeInteger(body.expected_version) ||
      (body.expected_version as number) < 0
    ) {
      return Response.json({ error: "invalid_expected_version" }, { status: 400 });
    }
    if (
      typeof body.reason_code !== "string" ||
      !(ROLLBACK_REASON_CODES as readonly string[]).includes(body.reason_code)
    ) {
      return Response.json({ error: "invalid_reason_code" }, { status: 400 });
    }
    if (
      !Object.hasOwn(body, "event_timestamp") ||
      typeof body.event_timestamp !== "string" ||
      !isCanonicalIsoTimestamp(body.event_timestamp)
    ) {
      return Response.json({ error: "invalid_event_timestamp" }, { status: 400 });
    }
    const result = rollbackSkillCandidateFromAcceptedDecision({
      candidateId: id,
      expectedLifecycleVersion: body.expected_version as number,
      reportHash: body.report_hash as string,
      decisionRecordHash: body.record_hash as string,
      reasonCode: body.reason_code as RollbackReasonCode,
      eventTimestamp: body.event_timestamp as string,
    });
    if (!result.ok) return rollbackErrorResponse(result);
    return Response.json({ candidate: result.candidate, event: result.event });
  }

  const suppliedVersion = body.expected_version;
  if (suppliedVersion !== undefined && (!Number.isSafeInteger(suppliedVersion) || (suppliedVersion as number) < 0)) {
    return Response.json({ error: "invalid_expected_version" }, { status: 400 });
  }
  const expectedVersion = suppliedVersion === undefined
    ? skillCandidateLifecycleVersion(candidate)
    : suppliedVersion as number;
  const config = dependencies.loadDistillationConfig();
  const callModel = dependencies.makeCallModel(config);

  if (action === "promote") {
    const proof = {
      reportHash: body.report_hash as string,
      decisionRecordHash: body.record_hash as string,
      expectedLifecycleVersion: body.expected_version as number,
    };
    const result = await promoteSkillCandidate(
      id,
      callModel,
      config,
      proof,
      dependencies.fetchSnapshot,
    );
    if (!result.ok) return promotionErrorResponse(result);
    return Response.json(result.candidate);
  }

  if (action === "eval") {
    const grounding = await runGroundingJudge(candidate, callModel, dependencies.fetchSnapshot);
    if (!grounding.ok) {
      return Response.json({ error: grounding.error, detail: grounding.detail }, { status: 503 });
    }
    const result = transitionSkillCandidate(id, expectedVersion, candidate.status, (current) => ({
      ...current,
      eval_score: grounding.verdict.score,
      eval_missed: grounding.verdict.missed,
    }));
    if (!result.ok) return transitionErrorResponse(result);
    return Response.json(result.candidate);
  }

  if (action === "reject") {
    const result = transitionSkillCandidate(id, expectedVersion, "candidate", (current) => ({
      ...current,
      status: "rejected",
      rejection_reason: "manual",
      rejection_detail: typeof body.reason === "string" ? body.reason : undefined,
      promoted_at: undefined,
    }));
    if (!result.ok) return transitionErrorResponse(result);
    return Response.json(result.candidate);
  }

  const result = transitionSkillCandidate(id, expectedVersion, "promoted", (current) => ({
    ...current,
    status: "candidate",
    rejection_reason: undefined,
    rejection_detail: undefined,
    promoted_at: undefined,
  }));
  if (!result.ok) return transitionErrorResponse(result);
  return Response.json(result.candidate);
}
