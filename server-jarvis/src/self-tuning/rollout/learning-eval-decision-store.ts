import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { CONFIG_DIR } from "../../config";
import {
  decodeLearningEvalAcceptanceReport,
  verifyLearningEvalAcceptanceReportHash,
  type LearningEvalAcceptanceReportV1,
} from "./learning-eval-report";
import type { SkillCandidate } from "../../intelligence/skill-types";
import { validateSkillCandidate } from "../../intelligence/skill-candidate-validation";
import {
  computeBodyDigest,
  computeCandidateArtifactDigest,
  computeDigest,
  stableStringify,
} from "./learning-eval-types";

export const LEARNING_EVAL_DECISION_RECORD_SCHEMA_VERSION = 1 as const;

export interface LearningEvalDecisionRecordV1 {
  schemaVersion: 1;
  report: LearningEvalAcceptanceReportV1;
  reportHash: string;
  candidateArtifact: SkillCandidate;
  candidateArtifactDigest: string;
  candidateContentDigest: string;
  observedCandidateStatus: "candidate" | "staged" | "promoted" | "rejected" | "rolled_back" | null;
  observedCandidateLifecycleVersion: number | null;
  createdAt: string;
  recordHash: string;
}

export type ObservedCandidateStatus = LearningEvalDecisionRecordV1["observedCandidateStatus"];

export type LearningEvalDecisionRecordHashInput = Omit<LearningEvalDecisionRecordV1, "recordHash">;

export type LearningEvalDecisionRecordResult =
  | { ok: true; value: LearningEvalDecisionRecordV1 }
  | { ok: false; error: string };

export interface CreateLearningEvalDecisionRecordInput {
  report: unknown;
  candidate: unknown;
  observedCandidateStatus: ObservedCandidateStatus;
  observedCandidateLifecycleVersion: number | null;
  createdAt?: string;
}

const CANDIDATE_CONTENT_FIELDS = [
  "id",
  "name",
  "description",
  "trigger",
  "body",
  "source_run_ids",
  "source_session_id",
  "confidence",
  "tool_sequence_digest",
  "created_at",
] as const;

const OBSERVED_CANDIDATE_STATUSES = [
  "candidate",
  "staged",
  "promoted",
  "rejected",
  "rolled_back",
] as const;

const DECISION_RECORD_KEYS = [
  "schemaVersion",
  "report",
  "reportHash",
  "candidateArtifact",
  "candidateArtifactDigest",
  "candidateContentDigest",
  "observedCandidateStatus",
  "observedCandidateLifecycleVersion",
  "createdAt",
  "recordHash",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeAcceptanceReportFailure(failure: {
  code: unknown;
  field?: unknown;
  detail?: unknown;
}): string {
  const parts = [String(failure.code)];
  if (failure.field !== undefined && failure.field !== null) {
    parts.push(String(failure.field));
  }
  if (failure.detail !== undefined && failure.detail !== null) {
    parts.push(String(failure.detail));
  }
  return parts.join(": ");
}

function isValidObservedStatus(value: unknown): value is ObservedCandidateStatus {
  return (
    value === null ||
    (typeof value === "string" && (OBSERVED_CANDIDATE_STATUSES as readonly string[]).includes(value))
  );
}

function isValidObservedLifecycleVersion(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function candidateContentDigestV1(candidate: SkillCandidate): string {
  const source = candidate as unknown as Record<string, unknown>;
  const projection: Record<string, unknown> = {};
  for (const field of CANDIDATE_CONTENT_FIELDS) {
    if (source[field] !== undefined) {
      projection[field] = source[field];
    }
  }
  return computeDigest(stableStringify(projection));
}

export function computeLearningEvalDecisionRecordHash(
  record: LearningEvalDecisionRecordHashInput,
): string {
  const hashable = {
    schemaVersion: record.schemaVersion,
    report: record.report,
    reportHash: record.reportHash,
    candidateArtifact: record.candidateArtifact,
    candidateArtifactDigest: record.candidateArtifactDigest,
    candidateContentDigest: record.candidateContentDigest,
    observedCandidateStatus: record.observedCandidateStatus,
    observedCandidateLifecycleVersion: record.observedCandidateLifecycleVersion,
    createdAt: record.createdAt,
  };
  return computeDigest(stableStringify(hashable));
}

export function createLearningEvalDecisionRecord(
  input: CreateLearningEvalDecisionRecordInput,
): LearningEvalDecisionRecordResult {
  const decodedReport = decodeLearningEvalAcceptanceReport(input.report);
  if (!decodedReport.ok) {
    return { ok: false, error: describeAcceptanceReportFailure(decodedReport) };
  }
  const report = decodedReport.report;
  if (!verifyLearningEvalAcceptanceReportHash(report)) {
    return { ok: false, error: "learning eval report hash mismatch" };
  }

  const validatedCandidate = validateSkillCandidate(input.candidate);
  if (!validatedCandidate.ok) {
    return { ok: false, error: String(validatedCandidate.reason) };
  }
  const candidate = validatedCandidate.candidate;

  if (!isValidObservedStatus(input.observedCandidateStatus)) {
    return { ok: false, error: "invalid observed candidate status" };
  }
  if (!isValidObservedLifecycleVersion(input.observedCandidateLifecycleVersion)) {
    return { ok: false, error: "invalid observed candidate lifecycle version" };
  }
  if (
    (input.observedCandidateStatus === null) !==
    (input.observedCandidateLifecycleVersion === null)
  ) {
    return {
      ok: false,
      error: "observed candidate status and lifecycle version must both be null or both be present",
    };
  }
  if (input.createdAt !== undefined && !isIsoTimestamp(input.createdAt)) {
    return { ok: false, error: "invalid createdAt" };
  }

  const candidateArtifactDigest = computeCandidateArtifactDigest(candidate);
  if (report.candidate.id !== candidate.id) {
    return { ok: false, error: "report candidate id mismatch" };
  }
  if (report.candidate.artifactDigest !== candidateArtifactDigest) {
    return { ok: false, error: "report artifact digest mismatch" };
  }
  if (report.candidate.contentDigest !== computeBodyDigest(candidate.body)) {
    return { ok: false, error: "report content digest mismatch" };
  }
  const candidateContentDigest = candidateContentDigestV1(candidate);

  const recordWithoutHash: LearningEvalDecisionRecordHashInput = {
    schemaVersion: LEARNING_EVAL_DECISION_RECORD_SCHEMA_VERSION,
    report,
    reportHash: report.reportHash,
    candidateArtifact: candidate,
    candidateArtifactDigest,
    candidateContentDigest,
    observedCandidateStatus: input.observedCandidateStatus,
    observedCandidateLifecycleVersion: input.observedCandidateLifecycleVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  return {
    ok: true,
    value: {
      ...recordWithoutHash,
      recordHash: computeLearningEvalDecisionRecordHash(recordWithoutHash),
    },
  };
}

export function decodeLearningEvalDecisionRecord(
  value: unknown,
): LearningEvalDecisionRecordResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: "decision record must be an object" };
  }
  for (const key of DECISION_RECORD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return { ok: false, error: `missing key: ${key}` };
    }
  }
  for (const key of Object.keys(value)) {
    if (!(DECISION_RECORD_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown key: ${key}` };
    }
  }

  if (value.schemaVersion !== LEARNING_EVAL_DECISION_RECORD_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported schema version" };
  }
  if (!isIsoTimestamp(value.createdAt)) {
    return { ok: false, error: "invalid createdAt" };
  }
  if (typeof value.reportHash !== "string") {
    return { ok: false, error: "invalid reportHash" };
  }
  if (typeof value.recordHash !== "string") {
    return { ok: false, error: "invalid recordHash" };
  }

  const decodedReport = decodeLearningEvalAcceptanceReport(value.report);
  if (!decodedReport.ok) {
    return { ok: false, error: describeAcceptanceReportFailure(decodedReport) };
  }
  const report = decodedReport.report;
  if (!verifyLearningEvalAcceptanceReportHash(report)) {
    return { ok: false, error: "learning eval report hash mismatch" };
  }
  if (value.reportHash !== report.reportHash) {
    return { ok: false, error: "report hash reference mismatch" };
  }

  const validatedCandidate = validateSkillCandidate(value.candidateArtifact);
  if (!validatedCandidate.ok) {
    return { ok: false, error: String(validatedCandidate.reason) };
  }
  const candidate = validatedCandidate.candidate;

  if (report.candidate.id !== candidate.id) {
    return { ok: false, error: "report candidate id mismatch" };
  }

  const candidateArtifactDigest = computeCandidateArtifactDigest(candidate);
  if (value.candidateArtifactDigest !== candidateArtifactDigest) {
    return { ok: false, error: "artifact digest mismatch" };
  }
  if (report.candidate.artifactDigest !== candidateArtifactDigest) {
    return { ok: false, error: "report artifact digest mismatch" };
  }
  if (report.candidate.contentDigest !== computeBodyDigest(candidate.body)) {
    return { ok: false, error: "report content digest mismatch" };
  }

  const candidateContentDigest = candidateContentDigestV1(candidate);
  if (value.candidateContentDigest !== candidateContentDigest) {
    return { ok: false, error: "content digest mismatch" };
  }

  if (!isValidObservedStatus(value.observedCandidateStatus)) {
    return { ok: false, error: "invalid observed candidate status" };
  }
  if (!isValidObservedLifecycleVersion(value.observedCandidateLifecycleVersion)) {
    return { ok: false, error: "invalid observed candidate lifecycle version" };
  }
  if (
    (value.observedCandidateStatus === null) !==
    (value.observedCandidateLifecycleVersion === null)
  ) {
    return {
      ok: false,
      error: "observed candidate status and lifecycle version must both be null or both be present",
    };
  }

  const decoded: LearningEvalDecisionRecordV1 = {
    schemaVersion: LEARNING_EVAL_DECISION_RECORD_SCHEMA_VERSION,
    report,
    reportHash: value.reportHash,
    candidateArtifact: candidate,
    candidateArtifactDigest,
    candidateContentDigest,
    observedCandidateStatus: value.observedCandidateStatus,
    observedCandidateLifecycleVersion: value.observedCandidateLifecycleVersion,
    createdAt: value.createdAt,
    recordHash: value.recordHash,
  };

  if (computeLearningEvalDecisionRecordHash(decoded) !== decoded.recordHash) {
    return { ok: false, error: "record hash mismatch" };
  }

  return { ok: true, value: decoded };
}

export interface LearningEvalDecisionStoreOptions {
  root?: string;
}

export type LearningEvalDecisionStoreErrorCode =
  | "conflict"
  | "not_found"
  | "invalid_record"
  | "corrupt_store"
  | "io_error";

export interface LearningEvalDecisionStoreFailure {
  ok: false;
  code: LearningEvalDecisionStoreErrorCode;
  error: string;
}

export type WriteLearningEvalDecisionResult =
  | { ok: true; value: LearningEvalDecisionRecordV1; created: boolean }
  | LearningEvalDecisionStoreFailure;

export type ReadLearningEvalDecisionResult =
  | { ok: true; value: LearningEvalDecisionRecordV1 }
  | LearningEvalDecisionStoreFailure;

interface LearningEvalReportIdentity {
  campaignId: string;
  manifestHash: string;
  candidateId: string;
}

interface LearningEvalStorePaths {
  root: string;
  recordsDir: string;
  realRoot: string;
  realRecordsDir: string;
}

type LearningEvalLayoutFailure = {
  ok: false;
  code: "not_found" | "corrupt_store" | "io_error";
  error: string;
};

type LearningEvalLayoutResult =
  | { ok: true; paths: LearningEvalStorePaths }
  | LearningEvalLayoutFailure;

interface LearningEvalStoredRecordEntry {
  filename: string;
  path: string;
  bytes: Buffer;
  record: LearningEvalDecisionRecordV1;
}

const RECORDS_SUBDIR = ["learning-evaluations", "records"] as const;
const RECORD_FILENAME_PATTERN = /^[0-9A-Za-z]+\.json$/;

function storeError(
  code: LearningEvalDecisionStoreErrorCode,
  error: string,
): LearningEvalDecisionStoreFailure {
  return { ok: false, code, error };
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isMissingError(error: unknown): boolean {
  return errorCodeOf(error) === "ENOENT";
}

function isExistError(error: unknown): boolean {
  return errorCodeOf(error) === "EEXIST";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasTraversalSegments(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

function isContainedWithin(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function recordFilenameForIdentity(identity: LearningEvalReportIdentity): string {
  const tuple = [identity.campaignId, identity.manifestHash, identity.candidateId];
  const digest = computeDigest(stableStringify(tuple)).replace(/[^0-9A-Za-z]+/g, "");
  return `${digest.length > 0 ? digest : "record"}.json`;
}

function readReportIdentity(report: unknown): LearningEvalReportIdentity | null {
  if (!isPlainObject(report)) {
    return null;
  }
  const campaignId = report["campaignId"];
  const manifestHash = report["manifestHash"];
  const candidate = report["candidate"];
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    return null;
  }
  if (typeof manifestHash !== "string" || manifestHash.length === 0) {
    return null;
  }
  if (!isPlainObject(candidate)) {
    return null;
  }
  const candidateId = candidate["id"];
  if (typeof candidateId !== "string" || candidateId.length === 0) {
    return null;
  }
  return { campaignId, manifestHash, candidateId };
}

function sameReportIdentity(
  left: LearningEvalReportIdentity,
  right: LearningEvalReportIdentity,
): boolean {
  return (
    left.campaignId === right.campaignId &&
    left.manifestHash === right.manifestHash &&
    left.candidateId === right.candidateId
  );
}

function ensureStoreDirectory(
  dir: string,
  create: boolean,
  allowRecursiveCreate: boolean,
): { ok: true; real: string } | LearningEvalLayoutFailure {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    if (!isMissingError(error)) {
      return { ok: false, code: "io_error", error: describeError(error) };
    }
    if (!create) {
      return { ok: false, code: "not_found", error: `store directory not found: ${dir}` };
    }
    try {
      mkdirSync(dir, { recursive: allowRecursiveCreate });
    } catch (mkdirError) {
      return { ok: false, code: "io_error", error: describeError(mkdirError) };
    }
    try {
      stats = lstatSync(dir);
    } catch (relstatError) {
      return { ok: false, code: "io_error", error: describeError(relstatError) };
    }
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, code: "corrupt_store", error: `symlinked store path component: ${dir}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, code: "corrupt_store", error: `store path component is not a directory: ${dir}` };
  }
  try {
    return { ok: true, real: realpathSync(dir) };
  } catch (error) {
    return { ok: false, code: "io_error", error: describeError(error) };
  }
}

function prepareLearningEvalStore(
  opts: LearningEvalDecisionStoreOptions | undefined,
  create: boolean,
): LearningEvalLayoutResult {
  const configuredRoot = opts?.root ?? CONFIG_DIR;
  if (typeof configuredRoot !== "string" || configuredRoot.length === 0) {
    return { ok: false, code: "io_error", error: "invalid learning eval store root" };
  }
  if (!isAbsolute(configuredRoot)) {
    return { ok: false, code: "io_error", error: "learning eval store root must be absolute" };
  }
  if (hasTraversalSegments(configuredRoot)) {
    return {
      ok: false,
      code: "corrupt_store",
      error: "learning eval store root contains a traversal segment",
    };
  }
  const root = resolve(configuredRoot);

  const rootState = ensureStoreDirectory(root, create, true);
  if (!rootState.ok) {
    return rootState;
  }

  let recordsDir = root;
  let recordsState: { ok: true; real: string } = rootState;
  for (const segment of RECORDS_SUBDIR) {
    recordsDir = join(recordsDir, segment);
    const state = ensureStoreDirectory(recordsDir, create, false);
    if (!state.ok) {
      return state;
    }
    recordsState = state;
  }

  if (!isContainedWithin(rootState.real, recordsState.real)) {
    return {
      ok: false,
      code: "corrupt_store",
      error: "records directory escapes canonical store root",
    };
  }

  return {
    ok: true,
    paths: {
      root,
      recordsDir,
      realRoot: rootState.real,
      realRecordsDir: recordsState.real,
    },
  };
}

function scanLearningEvalStore(
  recordsDir: string,
  realRecordsDir: string,
): { ok: true; records: LearningEvalStoredRecordEntry[] } | LearningEvalLayoutFailure {
  let entries;
  try {
    entries = readdirSync(recordsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingError(error)) {
      return { ok: false, code: "not_found", error: "learning eval store directory not found" };
    }
    return { ok: false, code: "io_error", error: describeError(error) };
  }

  const records: LearningEvalStoredRecordEntry[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".")) {
      continue;
    }
    const fullPath = join(recordsDir, name);

    if (!name.endsWith(".json")) {
      let stats;
      try {
        stats = lstatSync(fullPath);
      } catch (error) {
        return { ok: false, code: "io_error", error: describeError(error) };
      }
      if (stats.isSymbolicLink()) {
        return { ok: false, code: "corrupt_store", error: `symlinked entry in learning eval store: ${name}` };
      }
      if (stats.isDirectory()) {
        return { ok: false, code: "corrupt_store", error: `unexpected directory in learning eval store: ${name}` };
      }
      continue;
    }

    if (!RECORD_FILENAME_PATTERN.test(name)) {
      return { ok: false, code: "corrupt_store", error: `unexpected record filename: ${name}` };
    }

    let stats;
    try {
      stats = lstatSync(fullPath);
    } catch (error) {
      return { ok: false, code: "io_error", error: describeError(error) };
    }
    if (stats.isSymbolicLink()) {
      return { ok: false, code: "corrupt_store", error: `symlinked record file: ${name}` };
    }
    if (!stats.isFile()) {
      return { ok: false, code: "corrupt_store", error: `record entry is not a regular file: ${name}` };
    }

    let realPath;
    try {
      realPath = realpathSync(fullPath);
    } catch (error) {
      return { ok: false, code: "io_error", error: describeError(error) };
    }
    if (!isContainedWithin(realRecordsDir, realPath) || dirname(realPath) !== realRecordsDir) {
      return { ok: false, code: "corrupt_store", error: `record escapes canonical store root: ${name}` };
    }

    let bytes;
    try {
      bytes = readFileSync(fullPath);
    } catch (error) {
      return { ok: false, code: "io_error", error: describeError(error) };
    }

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { ok: false, code: "corrupt_store", error: `record is not valid JSON: ${name}` };
    }

    const decoded = decodeLearningEvalDecisionRecord(parsed);
    if (!decoded.ok) {
      return { ok: false, code: "corrupt_store", error: `malformed existing record ${name}: ${decoded.error}` };
    }
    const recordIdentity = readReportIdentity(decoded.value.report);
    if (!recordIdentity) {
      return { ok: false, code: "corrupt_store", error: `record identity could not be derived: ${name}` };
    }
    if (recordFilenameForIdentity(recordIdentity) !== name) {
      return { ok: false, code: "corrupt_store", error: `record filename does not match record identity: ${name}` };
    }

    records.push({ filename: name, path: fullPath, bytes, record: decoded.value });
  }

  return { ok: true, records };
}

function loadLearningEvalRecordAtPath(
  recordPath: string,
  realRecordsDir: string,
): { ok: true; bytes: Buffer; record: LearningEvalDecisionRecordV1 } | LearningEvalDecisionStoreFailure {
  let stats;
  try {
    stats = lstatSync(recordPath);
  } catch (error) {
    if (isMissingError(error)) {
      return storeError("not_found", "learning eval decision record not found");
    }
    return storeError("io_error", describeError(error));
  }
  if (stats.isSymbolicLink()) {
    return storeError("corrupt_store", "record path is a symlink");
  }
  if (!stats.isFile()) {
    return storeError("corrupt_store", "record path is not a regular file");
  }

  let realPath;
  try {
    realPath = realpathSync(recordPath);
  } catch (error) {
    return storeError("io_error", describeError(error));
  }
  if (!isContainedWithin(realRecordsDir, realPath) || dirname(realPath) !== realRecordsDir) {
    return storeError("corrupt_store", "record path escapes canonical store root");
  }

  let bytes;
  try {
    bytes = readFileSync(recordPath);
  } catch (error) {
    return storeError("io_error", describeError(error));
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return storeError("invalid_record", "record is not valid JSON");
  }

  const decoded = decodeLearningEvalDecisionRecord(parsed);
  if (!decoded.ok) {
    return storeError("invalid_record", decoded.error);
  }

  return { ok: true, bytes, record: decoded.value };
}

export function readLearningEvalDecision(
  reportHash: string,
  opts?: LearningEvalDecisionStoreOptions,
): ReadLearningEvalDecisionResult {
  if (typeof reportHash !== "string" || reportHash.length === 0) {
    return storeError("invalid_record", "invalid report hash");
  }

  const layout = prepareLearningEvalStore(opts, false);
  if (!layout.ok) {
    if (layout.code === "not_found") {
      return storeError("not_found", "learning eval decision record not found");
    }
    return layout;
  }

  const scanned = scanLearningEvalStore(layout.paths.recordsDir, layout.paths.realRecordsDir);
  if (!scanned.ok) {
    if (scanned.code === "not_found") {
      return storeError("not_found", "learning eval decision record not found");
    }
    return scanned;
  }

  const matches = scanned.records.filter((entry) => entry.record.reportHash === reportHash);
  if (matches.length === 0) {
    return storeError("not_found", "learning eval decision record not found");
  }
  if (matches.length > 1) {
    return storeError("corrupt_store", "duplicate learning eval decision records for report hash");
  }

  const match = matches[0];
  if (!match) {
    return storeError("not_found", "learning eval decision record not found");
  }
  return { ok: true, value: match.record };
}

export type ListLearningEvalDecisionsForCandidateResult =
  | { ok: true; values: LearningEvalDecisionRecordV1[] }
  | LearningEvalDecisionStoreFailure;

export function listLearningEvalDecisionsForCandidate(
  candidateId: string,
  opts?: LearningEvalDecisionStoreOptions,
): ListLearningEvalDecisionsForCandidateResult {
  if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
    return storeError("invalid_record", "invalid candidate id");
  }

  const layout = prepareLearningEvalStore(opts, false);
  if (!layout.ok) {
    if (layout.code === "not_found") {
      return { ok: true, values: [] };
    }
    return layout;
  }

  const scanned = scanLearningEvalStore(layout.paths.recordsDir, layout.paths.realRecordsDir);
  if (!scanned.ok) {
    if (scanned.code === "not_found") {
      return { ok: true, values: [] };
    }
    return scanned;
  }

  const values = scanned.records
    .filter(
      (entry) =>
        entry.record.candidateArtifact.id === candidateId &&
        entry.record.report.candidate.id === candidateId,
    )
    .map((entry) => entry.record)
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
      }
      if (left.reportHash !== right.reportHash) {
        return left.reportHash < right.reportHash ? -1 : 1;
      }
      return 0;
    });

  return { ok: true, values };
}

export function writeLearningEvalDecision(
  record: LearningEvalDecisionRecordV1,
  opts?: LearningEvalDecisionStoreOptions,
): WriteLearningEvalDecisionResult {
  const decoded = decodeLearningEvalDecisionRecord(record);
  if (!decoded.ok) {
    return storeError("invalid_record", decoded.error);
  }
  const canonicalRecord = decoded.value;

  const identity = readReportIdentity(canonicalRecord.report);
  if (!identity) {
    return storeError("invalid_record", "unable to derive learning eval record identity");
  }

  const canonicalBytes = Buffer.from(stableStringify(canonicalRecord), "utf8");
  const filename = recordFilenameForIdentity(identity);

  const layout = prepareLearningEvalStore(opts, true);
  if (!layout.ok) {
    return layout;
  }

  const { recordsDir, realRecordsDir } = layout.paths;
  const recordPath = join(recordsDir, filename);
  if (dirname(resolve(recordPath)) !== resolve(recordsDir)) {
    return storeError("corrupt_store", "record path escapes learning eval store directory");
  }

  const scanned = scanLearningEvalStore(recordsDir, realRecordsDir);
  if (!scanned.ok) {
    return scanned;
  }

  for (const existing of scanned.records) {
    const existingIdentity = readReportIdentity(existing.record.report);
    const matchesIdentity = existingIdentity !== null && sameReportIdentity(existingIdentity, identity);
    const matchesTarget = existing.filename === filename;
    if (!matchesIdentity && !matchesTarget) {
      continue;
    }
    if (
      existing.record.reportHash === canonicalRecord.reportHash &&
      existing.bytes.equals(canonicalBytes)
    ) {
      return { ok: true, value: existing.record, created: false };
    }
    return storeError(
      "conflict",
      matchesIdentity
        ? "learning eval record identity already exists with different content"
        : "learning eval record already exists with different content",
    );
  }

  try {
    writeFileSync(recordPath, canonicalBytes, { flag: "wx" });
  } catch (error) {
    if (!isExistError(error)) {
      return storeError("io_error", describeError(error));
    }
    const raced = loadLearningEvalRecordAtPath(recordPath, realRecordsDir);
    if (!raced.ok) {
      if (raced.code === "not_found") {
        return storeError("io_error", "learning eval record creation raced and disappeared");
      }
      if (raced.code === "invalid_record") {
        return storeError("corrupt_store", "learning eval record creation raced into an invalid record");
      }
      return raced;
    }
    if (
      raced.record.reportHash === canonicalRecord.reportHash &&
      raced.bytes.equals(canonicalBytes)
    ) {
      return { ok: true, value: raced.record, created: false };
    }
    return storeError("conflict", "learning eval record already exists with different content");
  }

  const verified = loadLearningEvalRecordAtPath(recordPath, realRecordsDir);
  if (!verified.ok) {
    return storeError("corrupt_store", "written learning eval record could not be verified");
  }
  if (!verified.bytes.equals(canonicalBytes)) {
    return storeError("corrupt_store", "written learning eval record bytes do not match canonical bytes");
  }

  return { ok: true, value: verified.record, created: true };
}

export const LEARNING_EVAL_LIFECYCLE_EVENT_SCHEMA_VERSION = 1 as const;

export type LearningEvalLifecycleAction =
  | "stage_candidate"
  | "reject_candidate"
  | "promote_candidate"
  | "rollback_candidate";

/**
 * Closed, bounded rollback motivations. A rollback is only ever recorded with
 * one of these codes; the code is bound into the deterministic rollback event
 * hash.
 */
export type LearningEvalRollbackReasonCode =
  | "regression_detected"
  | "superseded_by_newer_evidence"
  | "manual_rollback";

export type LearningEvalLifecycleReasonCode =
  | "accepted_transfer_gate"
  | "transfer_gate_failed"
  | "accepted_learning_eval"
  | LearningEvalRollbackReasonCode;

export type LearningEvalLifecycleToStatus = "staged" | "rejected" | "promoted" | "rolled_back";

export type LearningEvalLifecycleFromStatus =
  | "candidate"
  | "staged"
  | "promoted"
  | "rejected"
  | "rolled_back";

export interface LearningEvalLifecycleEventV1 {
  schemaVersion: 1;
  eventId: string;
  reportHash: string;
  candidateId: string;
  candidateContentDigest: string;
  priorLifecycleVersion: number | null;
  newLifecycleVersion: number;
  fromStatus: LearningEvalLifecycleFromStatus | null;
  toStatus: LearningEvalLifecycleToStatus;
  action: LearningEvalLifecycleAction;
  timestamp: string;
  reasonCode: LearningEvalLifecycleReasonCode;
  eventHash: string;
}

export type LearningEvalLifecycleEventHashInput = Omit<LearningEvalLifecycleEventV1, "eventHash">;

export interface LearningEvalLifecycleEventIdInput {
  reportHash: string;
  candidateId: string;
  action: LearningEvalLifecycleAction;
}

export interface CreateLearningEvalLifecycleEventInput {
  reportHash: string;
  candidateId: string;
  candidateContentDigest: string;
  priorLifecycleVersion: number | null;
  newLifecycleVersion: number;
  fromStatus: LearningEvalLifecycleFromStatus | null;
  toStatus: LearningEvalLifecycleToStatus;
  action: LearningEvalLifecycleAction;
  timestamp?: string;
  reasonCode: LearningEvalLifecycleReasonCode;
}

export type LearningEvalLifecycleEventDecodeResult =
  | { ok: true; value: LearningEvalLifecycleEventV1 }
  | { ok: false; error: string };

export type AppendLearningEvalLifecycleEventResult =
  | { ok: true; value: LearningEvalLifecycleEventV1; created: boolean }
  | LearningEvalDecisionStoreFailure;

export type ReadLearningEvalLifecycleEventResult =
  | { ok: true; value: LearningEvalLifecycleEventV1 }
  | LearningEvalDecisionStoreFailure;

const LEARNING_EVAL_LIFECYCLE_ACTIONS = [
  "stage_candidate",
  "reject_candidate",
  "promote_candidate",
  "rollback_candidate",
] as const;

const LEARNING_EVAL_ROLLBACK_REASON_CODES = [
  "regression_detected",
  "superseded_by_newer_evidence",
  "manual_rollback",
] as const;

const LEARNING_EVAL_LIFECYCLE_REASON_CODES = [
  "accepted_transfer_gate",
  "transfer_gate_failed",
  "accepted_learning_eval",
  "regression_detected",
  "superseded_by_newer_evidence",
  "manual_rollback",
] as const;

const LEARNING_EVAL_LIFECYCLE_TO_STATUSES = ["staged", "rejected", "promoted", "rolled_back"] as const;

const LEARNING_EVAL_LIFECYCLE_FROM_STATUSES = [
  "candidate",
  "staged",
  "promoted",
  "rejected",
  "rolled_back",
] as const;

const LIFECYCLE_EVENT_KEYS = [
  "schemaVersion",
  "eventId",
  "reportHash",
  "candidateId",
  "candidateContentDigest",
  "priorLifecycleVersion",
  "newLifecycleVersion",
  "fromStatus",
  "toStatus",
  "action",
  "timestamp",
  "reasonCode",
  "eventHash",
] as const;

const LIFECYCLE_EVENT_INPUT_KEYS = [
  "reportHash",
  "candidateId",
  "candidateContentDigest",
  "priorLifecycleVersion",
  "newLifecycleVersion",
  "fromStatus",
  "toStatus",
  "action",
  "timestamp",
  "reasonCode",
] as const;

const CANONICAL_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

const EVENTS_SUBDIR = ["learning-evaluations", "events"] as const;

function isCanonicalSha256(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_SHA256_PATTERN.test(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLifecycleAction(value: unknown): value is LearningEvalLifecycleAction {
  return (
    typeof value === "string" &&
    (LEARNING_EVAL_LIFECYCLE_ACTIONS as readonly string[]).includes(value)
  );
}

function isLifecycleReasonCode(value: unknown): value is LearningEvalLifecycleReasonCode {
  return (
    typeof value === "string" &&
    (LEARNING_EVAL_LIFECYCLE_REASON_CODES as readonly string[]).includes(value)
  );
}

function isRollbackReasonCode(value: unknown): value is LearningEvalRollbackReasonCode {
  return (
    typeof value === "string" &&
    (LEARNING_EVAL_ROLLBACK_REASON_CODES as readonly string[]).includes(value)
  );
}

function isLifecycleToStatus(value: unknown): value is LearningEvalLifecycleToStatus {
  return (
    typeof value === "string" &&
    (LEARNING_EVAL_LIFECYCLE_TO_STATUSES as readonly string[]).includes(value)
  );
}

function isLifecycleFromStatus(value: unknown): value is LearningEvalLifecycleFromStatus {
  return (
    typeof value === "string" &&
    (LEARNING_EVAL_LIFECYCLE_FROM_STATUSES as readonly string[]).includes(value)
  );
}

export function computeLearningEvalLifecycleEventId(
  input: LearningEvalLifecycleEventIdInput,
): string {
  return computeDigest(
    stableStringify({
      reportHash: input.reportHash,
      candidateId: input.candidateId,
      action: input.action,
    }),
  );
}

export function computeLearningEvalLifecycleEventHash(
  event: LearningEvalLifecycleEventHashInput,
): string {
  return computeDigest(
    stableStringify({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      reportHash: event.reportHash,
      candidateId: event.candidateId,
      candidateContentDigest: event.candidateContentDigest,
      priorLifecycleVersion: event.priorLifecycleVersion,
      newLifecycleVersion: event.newLifecycleVersion,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      action: event.action,
      timestamp: event.timestamp,
      reasonCode: event.reasonCode,
    }),
  );
}

export function createLearningEvalLifecycleEvent(
  input: CreateLearningEvalLifecycleEventInput,
): LearningEvalLifecycleEventDecodeResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "lifecycle event input must be an object" };
  }
  for (const key of Object.keys(input)) {
    if (!(LIFECYCLE_EVENT_INPUT_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown key: ${key}` };
    }
  }

  const timestamp = input.timestamp ?? new Date().toISOString();
  const eventId = computeLearningEvalLifecycleEventId({
    reportHash: input.reportHash,
    candidateId: input.candidateId,
    action: input.action,
  });
  const withoutHash: LearningEvalLifecycleEventHashInput = {
    schemaVersion: LEARNING_EVAL_LIFECYCLE_EVENT_SCHEMA_VERSION,
    eventId,
    reportHash: input.reportHash,
    candidateId: input.candidateId,
    candidateContentDigest: input.candidateContentDigest,
    priorLifecycleVersion: input.priorLifecycleVersion,
    newLifecycleVersion: input.newLifecycleVersion,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    action: input.action,
    timestamp,
    reasonCode: input.reasonCode,
  };

  return decodeLearningEvalLifecycleEvent({
    ...withoutHash,
    eventHash: computeLearningEvalLifecycleEventHash(withoutHash),
  });
}

export function decodeLearningEvalLifecycleEvent(
  value: unknown,
): LearningEvalLifecycleEventDecodeResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: "lifecycle event must be an object" };
  }
  for (const key of LIFECYCLE_EVENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return { ok: false, error: `missing key: ${key}` };
    }
  }
  for (const key of Object.keys(value)) {
    if (!(LIFECYCLE_EVENT_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown key: ${key}` };
    }
  }

  if (value.schemaVersion !== LEARNING_EVAL_LIFECYCLE_EVENT_SCHEMA_VERSION) {
    return { ok: false, error: "unsupported schema version" };
  }

  const eventId = value.eventId;
  if (!isCanonicalSha256(eventId)) {
    return { ok: false, error: "invalid eventId" };
  }
  const reportHash = value.reportHash;
  if (!isCanonicalSha256(reportHash)) {
    return { ok: false, error: "invalid reportHash" };
  }
  const candidateId = value.candidateId;
  if (typeof candidateId !== "string" || candidateId.length === 0) {
    return { ok: false, error: "invalid candidateId" };
  }
  const candidateContentDigest = value.candidateContentDigest;
  if (!isCanonicalSha256(candidateContentDigest)) {
    return { ok: false, error: "invalid candidateContentDigest" };
  }

  const rawFromStatus = value.fromStatus;
  let fromStatus: LearningEvalLifecycleFromStatus | null;
  if (rawFromStatus === null) {
    fromStatus = null;
  } else if (isLifecycleFromStatus(rawFromStatus)) {
    fromStatus = rawFromStatus;
  } else {
    return { ok: false, error: "invalid fromStatus" };
  }

  const toStatus = value.toStatus;
  if (!isLifecycleToStatus(toStatus)) {
    return { ok: false, error: "invalid toStatus" };
  }
  const action = value.action;
  if (!isLifecycleAction(action)) {
    return { ok: false, error: "invalid action" };
  }
  const timestamp = value.timestamp;
  if (!isIsoTimestamp(timestamp)) {
    return { ok: false, error: "invalid timestamp" };
  }
  const reasonCode = value.reasonCode;
  if (!isLifecycleReasonCode(reasonCode)) {
    return { ok: false, error: "invalid reasonCode" };
  }
  const eventHash = value.eventHash;
  if (!isCanonicalSha256(eventHash)) {
    return { ok: false, error: "invalid eventHash" };
  }

  const rawPriorLifecycleVersion = value.priorLifecycleVersion;
  if (rawPriorLifecycleVersion !== null && !isSafeNonnegativeInteger(rawPriorLifecycleVersion)) {
    return { ok: false, error: "invalid priorLifecycleVersion" };
  }
  const newLifecycleVersion = value.newLifecycleVersion;
  if (!isSafeNonnegativeInteger(newLifecycleVersion)) {
    return { ok: false, error: "invalid newLifecycleVersion" };
  }
  if (rawPriorLifecycleVersion === null) {
    if (fromStatus !== null) {
      return { ok: false, error: "absent prior lifecycle version requires null fromStatus" };
    }
    if (newLifecycleVersion !== 0) {
      return { ok: false, error: "absent prior lifecycle version requires newLifecycleVersion 0" };
    }
  } else {
    if (fromStatus === null) {
      return { ok: false, error: "existing prior lifecycle version requires non-null fromStatus" };
    }
    if (newLifecycleVersion !== rawPriorLifecycleVersion + 1) {
      return {
        ok: false,
        error: "newLifecycleVersion must equal priorLifecycleVersion + 1",
      };
    }
  }
  const priorLifecycleVersion = rawPriorLifecycleVersion;

  if (action === "stage_candidate") {
    if (toStatus !== "staged") {
      return { ok: false, error: "stage_candidate requires toStatus staged" };
    }
    if (fromStatus !== null && fromStatus !== "candidate") {
      return { ok: false, error: "stage_candidate requires fromStatus candidate" };
    }
    if (reasonCode !== "accepted_transfer_gate") {
      return {
        ok: false,
        error: "stage_candidate requires reasonCode accepted_transfer_gate",
      };
    }
  } else if (action === "reject_candidate") {
    if (toStatus !== "rejected") {
      return { ok: false, error: "reject_candidate requires toStatus rejected" };
    }
    if (fromStatus !== null && fromStatus !== "candidate") {
      return { ok: false, error: "reject_candidate requires fromStatus candidate" };
    }
    if (reasonCode !== "transfer_gate_failed") {
      return {
        ok: false,
        error: "reject_candidate requires reasonCode transfer_gate_failed",
      };
    }
  } else if (action === "promote_candidate") {
    if (toStatus !== "promoted") {
      return { ok: false, error: "promote_candidate requires toStatus promoted" };
    }
    if (fromStatus !== "staged") {
      return { ok: false, error: "promote_candidate requires fromStatus staged" };
    }
    if (priorLifecycleVersion === null) {
      return { ok: false, error: "promote_candidate requires non-null priorLifecycleVersion" };
    }
    if (reasonCode !== "accepted_learning_eval") {
      return {
        ok: false,
        error: "promote_candidate requires reasonCode accepted_learning_eval",
      };
    }
  } else if (action === "rollback_candidate") {
    if (toStatus !== "rolled_back") {
      return { ok: false, error: "rollback_candidate requires toStatus rolled_back" };
    }
    if (fromStatus !== "promoted") {
      return { ok: false, error: "rollback_candidate requires fromStatus promoted" };
    }
    if (priorLifecycleVersion === null) {
      return { ok: false, error: "rollback_candidate requires non-null priorLifecycleVersion" };
    }
    if (!isRollbackReasonCode(reasonCode)) {
      return {
        ok: false,
        error: "rollback_candidate requires a bounded rollback reasonCode",
      };
    }
  }

  const expectedEventId = computeLearningEvalLifecycleEventId({
    reportHash,
    candidateId,
    action,
  });
  if (eventId !== expectedEventId) {
    return { ok: false, error: "event id mismatch" };
  }

  const decoded: LearningEvalLifecycleEventV1 = {
    schemaVersion: LEARNING_EVAL_LIFECYCLE_EVENT_SCHEMA_VERSION,
    eventId,
    reportHash,
    candidateId,
    candidateContentDigest,
    priorLifecycleVersion,
    newLifecycleVersion,
    fromStatus,
    toStatus,
    action,
    timestamp,
    reasonCode,
    eventHash,
  };

  if (computeLearningEvalLifecycleEventHash(decoded) !== decoded.eventHash) {
    return { ok: false, error: "event hash mismatch" };
  }

  return { ok: true, value: decoded };
}

interface LearningEvalEventStorePaths {
  root: string;
  eventsDir: string;
  realRoot: string;
  realEventsDir: string;
}

function eventFilenameForEventId(eventId: string): string {
  const digest = eventId.replace(/[^0-9A-Za-z]+/g, "");
  return `${digest.length > 0 ? digest : "event"}.json`;
}

function prepareLearningEvalEventStore(
  opts: LearningEvalDecisionStoreOptions | undefined,
  create: boolean,
): { ok: true; paths: LearningEvalEventStorePaths } | LearningEvalLayoutFailure {
  const configuredRoot = opts?.root ?? CONFIG_DIR;
  if (typeof configuredRoot !== "string" || configuredRoot.length === 0) {
    return { ok: false, code: "io_error", error: "invalid learning eval store root" };
  }
  if (!isAbsolute(configuredRoot)) {
    return { ok: false, code: "io_error", error: "learning eval store root must be absolute" };
  }
  if (hasTraversalSegments(configuredRoot)) {
    return {
      ok: false,
      code: "corrupt_store",
      error: "learning eval store root contains a traversal segment",
    };
  }
  const root = resolve(configuredRoot);

  const rootState = ensureStoreDirectory(root, create, true);
  if (!rootState.ok) {
    return rootState;
  }

  let eventsDir = root;
  let eventsState: { ok: true; real: string } = rootState;
  for (const segment of EVENTS_SUBDIR) {
    eventsDir = join(eventsDir, segment);
    const state = ensureStoreDirectory(eventsDir, create, false);
    if (!state.ok) {
      return state;
    }
    eventsState = state;
  }

  if (!isContainedWithin(rootState.real, eventsState.real)) {
    return {
      ok: false,
      code: "corrupt_store",
      error: "events directory escapes canonical store root",
    };
  }

  return {
    ok: true,
    paths: {
      root,
      eventsDir,
      realRoot: rootState.real,
      realEventsDir: eventsState.real,
    },
  };
}

function loadLearningEvalEventAtPath(
  eventPath: string,
  realEventsDir: string,
):
  | { ok: true; bytes: Buffer; event: LearningEvalLifecycleEventV1 }
  | LearningEvalDecisionStoreFailure {
  let stats;
  try {
    stats = lstatSync(eventPath);
  } catch (error) {
    if (isMissingError(error)) {
      return storeError("not_found", "learning eval lifecycle event not found");
    }
    return storeError("io_error", describeError(error));
  }
  if (stats.isSymbolicLink()) {
    return storeError("corrupt_store", "lifecycle event path is a symlink");
  }
  if (!stats.isFile()) {
    return storeError("corrupt_store", "lifecycle event path is not a regular file");
  }

  let realPath;
  try {
    realPath = realpathSync(eventPath);
  } catch (error) {
    return storeError("io_error", describeError(error));
  }
  if (!isContainedWithin(realEventsDir, realPath) || dirname(realPath) !== realEventsDir) {
    return storeError("corrupt_store", "lifecycle event path escapes canonical store root");
  }

  let bytes;
  try {
    bytes = readFileSync(eventPath);
  } catch (error) {
    return storeError("io_error", describeError(error));
  }

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return storeError("invalid_record", "lifecycle event is not valid JSON");
  }

  const decoded = decodeLearningEvalLifecycleEvent(parsed);
  if (!decoded.ok) {
    return storeError("invalid_record", decoded.error);
  }
  if (eventFilenameForEventId(decoded.value.eventId) !== basename(eventPath)) {
    return storeError("corrupt_store", "lifecycle event filename does not match event id");
  }

  return { ok: true, bytes, event: decoded.value };
}

export function appendLearningEvalLifecycleEvent(
  event: LearningEvalLifecycleEventV1,
  opts?: LearningEvalDecisionStoreOptions,
): AppendLearningEvalLifecycleEventResult {
  const decoded = decodeLearningEvalLifecycleEvent(event);
  if (!decoded.ok) {
    return storeError("invalid_record", decoded.error);
  }
  const canonicalEvent = decoded.value;
  const canonicalBytes = Buffer.from(stableStringify(canonicalEvent), "utf8");
  const filename = eventFilenameForEventId(canonicalEvent.eventId);

  const layout = prepareLearningEvalEventStore(opts, true);
  if (!layout.ok) {
    return layout;
  }

  const { eventsDir, realEventsDir } = layout.paths;
  const eventPath = join(eventsDir, filename);
  if (dirname(resolve(eventPath)) !== resolve(eventsDir)) {
    return storeError("corrupt_store", "event path escapes learning eval store directory");
  }

  try {
    writeFileSync(eventPath, canonicalBytes, { flag: "wx" });
  } catch (error) {
    if (!isExistError(error)) {
      return storeError("io_error", describeError(error));
    }
    const raced = loadLearningEvalEventAtPath(eventPath, realEventsDir);
    if (!raced.ok) {
      if (raced.code === "not_found") {
        return storeError("io_error", "lifecycle event creation raced and disappeared");
      }
      if (raced.code === "invalid_record") {
        return storeError("corrupt_store", "lifecycle event creation raced into an invalid event");
      }
      return raced;
    }
    if (raced.event.eventId === canonicalEvent.eventId && raced.bytes.equals(canonicalBytes)) {
      return { ok: true, value: raced.event, created: false };
    }
    return storeError("conflict", "lifecycle event already exists with different content");
  }

  const verified = loadLearningEvalEventAtPath(eventPath, realEventsDir);
  if (!verified.ok) {
    return storeError("corrupt_store", "written lifecycle event could not be verified");
  }
  if (!verified.bytes.equals(canonicalBytes)) {
    return storeError("corrupt_store", "written lifecycle event bytes do not match canonical bytes");
  }

  return { ok: true, value: verified.event, created: true };
}

export function readLearningEvalLifecycleEvent(
  eventId: string,
  opts?: LearningEvalDecisionStoreOptions,
): ReadLearningEvalLifecycleEventResult {
  if (!isCanonicalSha256(eventId)) {
    return storeError("invalid_record", "invalid lifecycle event id");
  }

  const layout = prepareLearningEvalEventStore(opts, false);
  if (!layout.ok) {
    if (layout.code === "not_found") {
      return storeError("not_found", "learning eval lifecycle event not found");
    }
    return layout;
  }

  const { eventsDir, realEventsDir } = layout.paths;
  const eventPath = join(eventsDir, eventFilenameForEventId(eventId));
  if (dirname(resolve(eventPath)) !== resolve(eventsDir)) {
    return storeError("corrupt_store", "event path escapes learning eval store directory");
  }

  const loaded = loadLearningEvalEventAtPath(eventPath, realEventsDir);
  if (!loaded.ok) {
    if (loaded.code === "not_found") {
      return storeError("not_found", "learning eval lifecycle event not found");
    }
    return loaded;
  }
  if (loaded.event.eventId !== eventId) {
    return storeError("corrupt_store", "lifecycle event id mismatch");
  }

  return { ok: true, value: loaded.event };
}
