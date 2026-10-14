import type { SkillPromotionRequest } from "./intelligence/skill-promotion";

export class PromoteRequestInvalidError extends Error {}

/** Decode the HTTP bulk proof envelope without starting the server. */
export function decodeBulkSkillPromotionRequest(parsedBody: unknown): SkillPromotionRequest[] {
  const rawCandidates =
    parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? (parsedBody as { candidates?: unknown }).candidates
      : undefined;
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    throw new PromoteRequestInvalidError("candidates must be a nonempty array");
  }
  const seenCandidateIds = new Set<string>();
  return rawCandidates.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new PromoteRequestInvalidError(`candidate[${index}] must be a plain object`);
    }
    const record = entry as Record<string, unknown>;
    const candidateId = record.candidate_id;
    const reportHash = record.report_hash;
    const decisionRecordHash = record.record_hash;
    const expectedLifecycleVersion = record.expected_version;
    if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
      throw new PromoteRequestInvalidError(`candidate[${index}].candidate_id must be a nonempty string`);
    }
    if (seenCandidateIds.has(candidateId)) {
      throw new PromoteRequestInvalidError(`duplicate candidate_id ${candidateId}`);
    }
    seenCandidateIds.add(candidateId);
    if (typeof reportHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(reportHash)) {
      throw new PromoteRequestInvalidError(`candidate[${index}].report_hash must be a canonical sha256 digest`);
    }
    if (typeof decisionRecordHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(decisionRecordHash)) {
      throw new PromoteRequestInvalidError(`candidate[${index}].record_hash must be a canonical sha256 digest`);
    }
    if (
      typeof expectedLifecycleVersion !== "number" ||
      !Number.isSafeInteger(expectedLifecycleVersion) ||
      expectedLifecycleVersion < 0
    ) {
      throw new PromoteRequestInvalidError(`candidate[${index}].expected_version must be a nonnegative safe integer`);
    }
    return { candidateId, reportHash, decisionRecordHash, expectedLifecycleVersion };
  });
}
