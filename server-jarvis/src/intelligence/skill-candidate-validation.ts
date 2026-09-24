import type { TaskType } from "../orchestration/coordinator";
import type { TurnRequirement } from "../orchestration/turn-requirements";
import type { SkillCandidate, SkillCandidateStatus, SkillRejectionReason } from "./skill-types";

const VALID_TASK_TYPES = new Set<TaskType>([
  "code_review",
  "debug",
  "refactor",
  "general",
  "plan",
  "research",
  "test",
  "docs",
]);

const VALID_REQUIREMENTS = new Set<TurnRequirement>([
  "conversational",
  "answer_only",
  "workspace_read",
  "full_execution",
]);

const VALID_STATUSES = new Set<SkillCandidateStatus>(["candidate", "promoted", "rejected"]);

const VALID_REJECTION_REASONS = new Set<SkillRejectionReason>([
  "below_eval_delta",
  "wrong_status",
  "low_confidence",
  "suspicious_paths",
  "body_length_out_of_range",
  "missing_signals",
  "eval_failed",
  "manual",
]);

export type SkillCandidateValidationResult =
  | { ok: true; candidate: SkillCandidate }
  | { ok: false; reason: "invalid_candidate_record" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isTaskTypeArray(value: unknown): value is TaskType[] {
  return Array.isArray(value) && value.every((item): item is TaskType => typeof item === "string" && VALID_TASK_TYPES.has(item as TaskType));
}

function isRequirementArray(value: unknown): value is TurnRequirement[] {
  return Array.isArray(value) && value.every((item): item is TurnRequirement => typeof item === "string" && VALID_REQUIREMENTS.has(item as TurnRequirement));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function optionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isTimestamp(value);
}

function optionalUnitInterval(value: unknown): value is number | undefined {
  return value === undefined || isUnitInterval(value);
}

function lifecycleVersion(value: unknown): number | null {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
  return value as number;
}

export function validateSkillCandidate(value: unknown): SkillCandidateValidationResult {
  if (!isRecord(value)) return { ok: false, reason: "invalid_candidate_record" };
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name) || typeof value.description !== "string" || typeof value.body !== "string") {
    return { ok: false, reason: "invalid_candidate_record" };
  }
  if (!isRecord(value.trigger) || !isTaskTypeArray(value.trigger.task_types) || !isRequirementArray(value.trigger.requirements) || !isStringArray(value.trigger.signals)) {
    return { ok: false, reason: "invalid_candidate_record" };
  }
  if (!isStringArray(value.source_run_ids) || !optionalString(value.source_session_id)) {
    return { ok: false, reason: "invalid_candidate_record" };
  }
  if (!VALID_STATUSES.has(value.status as SkillCandidateStatus) || !isUnitInterval(value.confidence)) {
    return { ok: false, reason: "invalid_candidate_record" };
  }
  const version = lifecycleVersion(value.lifecycle_version);
  if (version === null || !isTimestamp(value.created_at) || !isTimestamp(value.updated_at)) {
    return { ok: false, reason: "invalid_candidate_record" };
  }
  if (!optionalUnitInterval(value.eval_score) || !optionalStringArray(value.eval_missed) || !optionalString(value.rejection_detail) || !optionalTimestamp(value.promoted_at)) {
    return { ok: false, reason: "invalid_candidate_record" };
  }
  if (value.rejection_reason !== undefined && !VALID_REJECTION_REASONS.has(value.rejection_reason as SkillRejectionReason)) {
    return { ok: false, reason: "invalid_candidate_record" };
  }
  if (value.tool_sequence_digest !== undefined && !isNonEmptyString(value.tool_sequence_digest)) {
    return { ok: false, reason: "invalid_candidate_record" };
  }

  const candidate = {
    ...value,
    id: value.id,
    name: value.name,
    description: value.description,
    trigger: {
      task_types: [...value.trigger.task_types],
      requirements: [...value.trigger.requirements],
      signals: [...value.trigger.signals],
    },
    body: value.body,
    source_run_ids: [...value.source_run_ids],
    source_session_id: value.source_session_id,
    confidence: value.confidence,
    status: value.status,
    lifecycle_version: version,
    eval_score: value.eval_score,
    eval_missed: value.eval_missed === undefined ? undefined : [...value.eval_missed],
    rejection_reason: value.rejection_reason,
    rejection_detail: value.rejection_detail,
    promoted_at: value.promoted_at,
    tool_sequence_digest: value.tool_sequence_digest,
    created_at: value.created_at,
    updated_at: value.updated_at,
  } as SkillCandidate;
  return { ok: true, candidate };
}

export function isValidSkillCandidate(value: unknown): value is SkillCandidate {
  return validateSkillCandidate(value).ok;
}
