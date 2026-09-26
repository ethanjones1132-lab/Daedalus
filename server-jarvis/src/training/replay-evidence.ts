/** Strict decoding for the replay evidence the offline promotion gate scores.
 *
 * Replay rows reach the gate from a serialized report or an adapter, never from
 * a value this process built, so nothing about them may be taken on trust. A
 * missing, duplicated, or unlisted case id, an absent score, or a score that is
 * not a finite fraction has to be a decode failure: every one of them would
 * otherwise shrink the pass-rate denominator or drop a regression from the
 * count while still reading as a pass.
 *
 * Coverage is stated positively, by a versioned expected-case manifest, because
 * a gate can only prove the cases it was told to expect. Case ids here are eval
 * suite case ids; corpus row ids, `agent_run_id`s, and `session_id`s are
 * trajectory provenance and never satisfy an expected case.
 *
 * No model, filesystem, network, or tool-runtime dependency: pure in, pure out.
 */

export type ReplayEvidenceErrorCode =
  // replay rows
  | "root_not_array"
  | "row_not_object"
  | "unknown_field"
  | "blank_case_id"
  | "duplicate_case_id"
  | "invalid_passed"
  | "missing_baseline_score"
  | "missing_candidate_score"
  | "invalid_score"
  | "score_out_of_range"
  // expected-case coverage contract
  | "root_not_object"
  | "missing_schema"
  | "unknown_schema"
  | "missing_metadata"
  | "invalid_timestamp"
  | "missing_payload"
  | "invalid_payload"
  | "empty_case_id"
  | "empty_manifest"
  | "unexpected_field";

/** The one code vocabulary both decoders report through. Carries the offending
 * entry's index (and case id, when it parsed) so a caller can point at the row
 * without echoing the whole report back. */
export class ReplayEvidenceError extends Error {
  readonly code: ReplayEvidenceErrorCode;
  readonly entryIndex?: number;
  readonly caseId?: string;

  constructor(code: ReplayEvidenceErrorCode, entryIndex?: number, caseId?: string) {
    super(entryIndex === undefined ? code : `${code}:entry_${entryIndex}`);
    this.name = "ReplayEvidenceError";
    this.code = code;
    this.entryIndex = entryIndex;
    this.caseId = caseId;
  }
}

/** One replay row as an adapter emits it, before anything has verified it.
 * `baseline_score` is genuinely optional here: a report run with no pinned
 * baseline has no A side, and the gate has to reject that rather than score the
 * B side on its own. */
export interface ReplayEvidenceRow {
  case_id: string;
  passed: boolean;
  baseline_score?: number | null;
  candidate_score?: number;
}

/** A replay row that has passed strict decoding: every score present, finite,
 * and inside [0, 1]; every id non-blank and unique. */
export interface ReplayResult {
  case_id: string;
  passed: boolean;
  baseline_score: number;
  candidate_score: number;
}

/** The versioned answer to "which cases was this evidence supposed to cover?" */
export interface ReplayCoverageContract {
  schemaVersion: 1;
  evalSuite: string;
  /** `null` when the manifest did not record one; coverage does not depend on it. */
  generatedAt: string | null;
  expectedCaseIds: readonly string[];
}

export interface ReplayCoverage {
  suite: string;
  expectedCount: number;
  providedCount: number;
  matchedCount: number;
  missingCount: number;
  unexpectedCount: number;
  missingCaseIds: string[];
  unexpectedCaseIds: string[];
  truncated: boolean;
  complete: boolean;
}

export const MAX_REPORTED_CASE_IDS = 20;

const REPLAY_ROW_FIELDS = new Set(["case_id", "passed", "baseline_score", "candidate_score"]);
const CONTRACT_FIELDS = new Set(["schema_version", "eval_suite", "generated_at", "expected_cases"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeScore(value: unknown, absentCode: ReplayEvidenceErrorCode, caseId: string, index: number): number {
  if (value === undefined || value === null) throw new ReplayEvidenceError(absentCode, index, caseId);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReplayEvidenceError("invalid_score", index, caseId);
  }
  if (value < 0 || value > 1) throw new ReplayEvidenceError("score_out_of_range", index, caseId);
  return value;
}

export function decodeReplayEvidence(value: unknown): ReplayResult[] {
  if (!Array.isArray(value)) throw new ReplayEvidenceError("root_not_array");

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ReplayEvidenceError("row_not_object", index);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!REPLAY_ROW_FIELDS.has(key)) throw new ReplayEvidenceError("unknown_field", index);
    }

    const rawId = record.case_id;
    if (!isNonEmptyString(rawId)) throw new ReplayEvidenceError("blank_case_id", index);
    if (rawId !== rawId.trim()) throw new ReplayEvidenceError("blank_case_id", index);
    if (seen.has(rawId)) throw new ReplayEvidenceError("duplicate_case_id", index, rawId);
    seen.add(rawId);

    if (typeof record.passed !== "boolean") throw new ReplayEvidenceError("invalid_passed", index, rawId);

    return {
      case_id: rawId,
      passed: record.passed,
      baseline_score: decodeScore(record.baseline_score, "missing_baseline_score", rawId, index),
      candidate_score: decodeScore(record.candidate_score, "missing_candidate_score", rawId, index),
    };
  });
}

export function decodeReplayCoverageContract(value: unknown): ReplayCoverageContract {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReplayEvidenceError("root_not_object");
  }
  const record = value as Record<string, unknown>;

  if (record.schema_version === undefined) throw new ReplayEvidenceError("missing_schema");
  if (record.schema_version !== 1) throw new ReplayEvidenceError("unknown_schema");
  for (const key of Object.keys(record)) {
    if (!CONTRACT_FIELDS.has(key)) throw new ReplayEvidenceError("unexpected_field");
  }
  if (!isNonEmptyString(record.eval_suite)) throw new ReplayEvidenceError("missing_metadata");

  let generatedAt: string | null = null;
  if (record.generated_at !== undefined && record.generated_at !== null) {
    if (typeof record.generated_at !== "string" || !Number.isFinite(Date.parse(record.generated_at))) {
      throw new ReplayEvidenceError("invalid_timestamp");
    }
    generatedAt = record.generated_at;
  }

  const payload = record.expected_cases;
  if (payload === undefined) throw new ReplayEvidenceError("missing_payload");
  if (!Array.isArray(payload)) throw new ReplayEvidenceError("invalid_payload");
  if (payload.length === 0) throw new ReplayEvidenceError("empty_manifest");

  const seen = new Set<string>();
  for (const [index, entry] of payload.entries()) {
    if (!isNonEmptyString(entry) || entry !== entry.trim()) {
      throw new ReplayEvidenceError("empty_case_id", index);
    }
    if (seen.has(entry)) throw new ReplayEvidenceError("duplicate_case_id", index, entry);
    seen.add(entry);
  }

  return {
    schemaVersion: 1,
    evalSuite: record.eval_suite,
    generatedAt,
    expectedCaseIds: payload,
  };
}

export function verifyReplayCoverage(
  rows: readonly ReplayResult[],
  contract: ReplayCoverageContract,
): ReplayCoverage {
  const expected = new Set(contract.expectedCaseIds);
  const provided = new Set(rows.map((r) => r.case_id));

  const missing = [...expected].filter((id) => !provided.has(id)).sort();
  const unexpected = [...provided].filter((id) => !expected.has(id)).sort();
  const matched = [...provided].filter((id) => expected.has(id)).length;

  return {
    suite: contract.evalSuite,
    expectedCount: expected.size,
    providedCount: provided.size,
    matchedCount: matched,
    missingCount: missing.length,
    unexpectedCount: unexpected.length,
    missingCaseIds: missing.slice(0, MAX_REPORTED_CASE_IDS),
    unexpectedCaseIds: unexpected.slice(0, MAX_REPORTED_CASE_IDS),
    truncated: missing.length > MAX_REPORTED_CASE_IDS || unexpected.length > MAX_REPORTED_CASE_IDS,
    complete: missing.length === 0 && unexpected.length === 0,
  };
}
