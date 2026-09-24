import type { SkillDistillationConfig } from "./config";
import {
  promoteSkillCandidate,
  runGroundingJudge,
  type SnapshotFetcher,
} from "./intelligence/skill-promotion";
import {
  readSkillCandidate,
  skillCandidateLifecycleVersion,
  transitionSkillCandidate,
  type SkillCandidateTransitionResult,
} from "./intelligence/skill-store";
import type { SkillCandidate } from "./intelligence/skill-types";
import type { CallModelFn } from "./orchestration/coordinator";

export interface SkillCandidateRouteDependencies {
  loadDistillationConfig: () => SkillDistillationConfig;
  makeCallModel: (config: SkillDistillationConfig) => CallModelFn;
  fetchSnapshot?: SnapshotFetcher;
}

type CandidateAction = "eval" | "promote" | "reject" | "demote";

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

export async function handleSkillCandidateRequest(
  req: Request,
  dependencies: SkillCandidateRouteDependencies,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const match = path.match(/^\/skills\/candidates\/([^/]+)\/(eval|promote|reject|demote)$/);
  if (!match || req.method !== "POST") return null;

  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return Response.json({ error: "invalid_candidate_id" }, { status: 400 });
  }
  const action = match[2] as CandidateAction;
  const read = readSkillCandidate(id);
  if (!read.ok) {
    if (read.error === "invalid_candidate_record") {
      return Response.json({ error: read.error, reason: read.error }, { status: 422 });
    }
    return Response.json({ error: read.error }, { status: 404 });
  }
  const candidate = read.candidate;

  const body = responseBody(await req.json().catch(() => ({})));
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
    const result = await promoteSkillCandidate(
      id,
      callModel,
      config,
      dependencies.fetchSnapshot,
      expectedVersion,
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
