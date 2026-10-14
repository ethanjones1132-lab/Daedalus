import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  decodeFrozenManifest,
  type FrozenLearningEvalManifest,
} from "../src/self-tuning/rollout/paired-learning-evaluator";
import {
  LEARNING_EVAL_ACCEPTANCE_CRITERION_IDS,
  computeLearningEvalAcceptance,
  decodeLearningEvalAcceptanceReport,
  verifyLearningEvalAcceptanceReportHash,
  verifyLearningEvalArtifacts,
  type LearningEvalAcceptanceReportV1,
  type LearningEvalCriterionResultV1,
} from "../src/self-tuning/rollout/learning-eval-report";
import {
  createLearningEvalDecisionRecord,
  readLearningEvalDecision,
  writeLearningEvalDecision,
  type LearningEvalDecisionRecordV1,
} from "../src/self-tuning/rollout/learning-eval-decision-store";
import {
  applyLearningEvalDecision,
  readSkillCandidate,
  skillCandidateLifecycleVersion,
} from "../src/intelligence/skill-store";

const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_DETAIL_LENGTH = 256;
const MAX_REASON_DETAIL_LENGTH = 256;
const MAX_REASONS = 64;
const ARTIFACT_VERIFICATION_FAILURE_KIND = "artifact_verification_failure";

export interface AcceptanceArgs {
  campaignId: string;
  generatedAt: string;
}

export type ParseAcceptanceArgsResult =
  | { ok: true; args: AcceptanceArgs }
  | { ok: false; error: string };

export type LoadAcceptanceInputsErrorCode =
  | "invalid-arguments"
  | "missing-path-component"
  | "symlink-rejected"
  | "not-a-directory"
  | "not-a-regular-file"
  | "resolve-failed"
  | "path-escape"
  | "read-failed"
  | "invalid-utf8"
  | "invalid-json"
  | "manifest-validation-failed";

export interface LoadAcceptanceInputsError {
  code: LoadAcceptanceInputsErrorCode;
  detail: string;
  safeCampaignDirectory?: string;
  manifestBytesDigest?: string;
  outcomesBytesDigest?: string;
}

export type ArtifactVerificationFailureReasonCode =
  | LoadAcceptanceInputsErrorCode
  | "artifact-verification-failed";

export interface ArtifactVerificationFailureReasonV1 {
  code: ArtifactVerificationFailureReasonCode;
  detail: string;
}

export interface ArtifactVerificationFailureV1 {
  schemaVersion: 1;
  kind: typeof ARTIFACT_VERIFICATION_FAILURE_KIND;
  campaignId: string;
  manifestBytesDigest: string | null;
  outcomesBytesDigest: string | null;
  generatedAt: string;
  reasons: ReadonlyArray<ArtifactVerificationFailureReasonV1>;
  failureHash: string;
}

export type ArtifactVerificationFailureNoHashV1 = Omit<
  ArtifactVerificationFailureV1,
  "failureHash"
>;

export type ArtifactVerificationFailureInputV1 =
  ArtifactVerificationFailureNoHashV1;

export type LoadAcceptanceInputsSuccess = {
  ok: true;
  manifest: FrozenLearningEvalManifest;
  manifestBytes: Buffer;
  outcomesBytes: Buffer;
  manifestBytesDigest: string;
  outcomesBytesDigest: string;
  campaignDirectory: string;
};

export type LoadAcceptanceInputsResult =
  | LoadAcceptanceInputsSuccess
  | { ok: false; error: LoadAcceptanceInputsError };

function isCanonicalIsoString(value: string): boolean {
  if (!CANONICAL_ISO_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString() === value;
}

function boundDetail(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.length > MAX_DETAIL_LENGTH
    ? `${message.slice(0, MAX_DETAIL_LENGTH)}...`
    : message;
}

function loadError(
  code: LoadAcceptanceInputsErrorCode,
  detail: string,
  context: Pick<
    LoadAcceptanceInputsError,
    "safeCampaignDirectory" | "manifestBytesDigest" | "outcomesBytesDigest"
  > = {},
): { ok: false; error: LoadAcceptanceInputsError } {
  const error: LoadAcceptanceInputsError = { code, detail };
  if (context.safeCampaignDirectory !== undefined) {
    error.safeCampaignDirectory = context.safeCampaignDirectory;
  }
  if (context.manifestBytesDigest !== undefined) {
    error.manifestBytesDigest = context.manifestBytesDigest;
  }
  if (context.outcomesBytesDigest !== undefined) {
    error.outcomesBytesDigest = context.outcomesBytesDigest;
  }
  return { ok: false, error };
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function sha256(buffer: Buffer): Promise<string> {
  return createHash("sha256").update(buffer).digest("hex");
}

type SafeFileLoadResult =
  | { ok: true; bytes: Buffer; digest: string }
  | { ok: false; code: LoadAcceptanceInputsErrorCode; detail: string };

async function loadSafeCampaignFile(
  campaignDirectory: string,
  realCampaignDirectory: string,
  name: string,
): Promise<SafeFileLoadResult> {
  const filePath = join(campaignDirectory, name);

  let stats;
  try {
    stats = await lstatOrNull(filePath);
  } catch (err) {
    return { ok: false, code: "missing-path-component", detail: boundDetail(err) };
  }
  if (stats === null) {
    return {
      ok: false,
      code: "missing-path-component",
      detail: `missing required file: ${name}`,
    };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, code: "symlink-rejected", detail: `symlink file rejected: ${name}` };
  }
  if (!stats.isFile()) {
    return { ok: false, code: "not-a-regular-file", detail: `not a regular file: ${name}` };
  }

  let realFilePath: string;
  try {
    realFilePath = await realpath(filePath);
  } catch (err) {
    return { ok: false, code: "resolve-failed", detail: boundDetail(err) };
  }

  const rel = relative(realCampaignDirectory, realFilePath);
  if (rel !== name || realFilePath !== join(realCampaignDirectory, name)) {
    return {
      ok: false,
      code: "path-escape",
      detail: `${name} does not remain within the campaign directory`,
    };
  }

  try {
    const bytes = await readFile(realFilePath);
    return { ok: true, bytes, digest: `sha256:${await sha256(bytes)}` };
  } catch (err) {
    return { ok: false, code: "read-failed", detail: boundDetail(err) };
  }
}

export function parseAcceptanceArgs(
  argv: string[],
): ParseAcceptanceArgsResult {
  if (argv.length !== 5) {
    return {
      ok: false,
      error: `expected exactly 5 tokens, received ${argv.length}`,
    };
  }

  if (argv[0] !== "--evaluate") {
    return { ok: false, error: "expected --evaluate as token 1" };
  }
  if (argv[1] !== "--campaign-id") {
    return { ok: false, error: "expected --campaign-id as token 2" };
  }
  if (argv[3] !== "--generated-at") {
    return { ok: false, error: "expected --generated-at as token 4" };
  }

  for (const flag of ["--evaluate", "--campaign-id", "--generated-at"]) {
    const occurrences = argv.filter((token) => token === flag).length;
    if (occurrences !== 1) {
      return { ok: false, error: `duplicate or missing flag ${flag}` };
    }
  }

  const campaignId = argv[2];
  const generatedAt = argv[4];

  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    return { ok: false, error: "invalid campaign id" };
  }
  if (!isCanonicalIsoString(generatedAt)) {
    return { ok: false, error: "invalid generated-at timestamp" };
  }

  return { ok: true, args: { campaignId, generatedAt } };
}

export async function loadAcceptanceInputs(
  args: AcceptanceArgs,
): Promise<LoadAcceptanceInputsResult> {
  const campaignId = args?.campaignId;
  if (typeof campaignId !== "string" || !CAMPAIGN_ID_PATTERN.test(campaignId)) {
    return {
      ok: false,
      error: { code: "invalid-arguments", detail: "invalid campaign id" },
    };
  }

  const generatedAt = args?.generatedAt;
  if (typeof generatedAt !== "string" || !isCanonicalIsoString(generatedAt)) {
    return {
      ok: false,
      error: { code: "invalid-arguments", detail: "invalid generated-at timestamp" },
    };
  }

  const repoRoot = resolve(import.meta.dir, "..", "..");
  const campaignRelativeComponents = [
    "work",
    "opencode-memory",
    "priority3-evaluations",
    campaignId,
  ];

  let currentPath = repoRoot;
  for (const component of campaignRelativeComponents) {
    const candidate = join(currentPath, component);
    let stats;
    try {
      stats = await lstatOrNull(candidate);
    } catch (err) {
      return {
        ok: false,
        error: { code: "missing-path-component", detail: boundDetail(err) },
      };
    }
    if (stats === null) {
      return {
        ok: false,
        error: {
          code: "missing-path-component",
          detail: `missing path component: ${component}`,
        },
      };
    }
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        error: {
          code: "symlink-rejected",
          detail: `symlink path component rejected: ${component}`,
        },
      };
    }
    if (!stats.isDirectory()) {
      return {
        ok: false,
        error: {
          code: "not-a-directory",
          detail: `path component is not a directory: ${component}`,
        },
      };
    }
    currentPath = candidate;
  }

  const campaignDirectory = currentPath;

  let realRepoRoot: string;
  try {
    realRepoRoot = await realpath(repoRoot);
  } catch (err) {
    return loadError("resolve-failed", boundDetail(err));
  }

  let realCampaignDirectory: string;
  try {
    realCampaignDirectory = await realpath(campaignDirectory);
  } catch (err) {
    return loadError("resolve-failed", boundDetail(err));
  }

  const expectedCampaignDirectory = join(
    realRepoRoot,
    "work",
    "opencode-memory",
    "priority3-evaluations",
    campaignId,
  );
  if (realCampaignDirectory !== expectedCampaignDirectory) {
    return loadError(
      "path-escape",
      "campaign directory does not match the expected repository location",
    );
  }

  const manifestResult = await loadSafeCampaignFile(
    campaignDirectory,
    realCampaignDirectory,
    "manifest.json",
  );
  const outcomesResult = await loadSafeCampaignFile(
    campaignDirectory,
    realCampaignDirectory,
    "outcomes.jsonl",
  );

  const availableDigests = {
    ...(manifestResult.ok ? { manifestBytesDigest: manifestResult.digest } : {}),
    ...(outcomesResult.ok ? { outcomesBytesDigest: outcomesResult.digest } : {}),
  };

  if (!manifestResult.ok) {
    return loadError(manifestResult.code, manifestResult.detail, {
      safeCampaignDirectory: realCampaignDirectory,
      ...availableDigests,
    });
  }
  if (!outcomesResult.ok) {
    return loadError(outcomesResult.code, outcomesResult.detail, {
      safeCampaignDirectory: realCampaignDirectory,
      ...availableDigests,
    });
  }

  const manifestBytes = manifestResult.bytes;
  const outcomesBytes = outcomesResult.bytes;

  const readContext = {
    safeCampaignDirectory: realCampaignDirectory,
    manifestBytesDigest: manifestResult.digest,
    outcomesBytesDigest: outcomesResult.digest,
  };

  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch (err) {
    return loadError("invalid-utf8", boundDetail(err), readContext);
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestText);
  } catch (err) {
    return loadError("invalid-json", boundDetail(err), readContext);
  }

  let manifest: FrozenLearningEvalManifest;
  try {
    manifest = decodeFrozenManifest(parsedManifest);
  } catch (err) {
    return loadError("manifest-validation-failed", boundDetail(err), readContext);
  }

  return {
    ok: true,
    manifest,
    manifestBytes,
    outcomesBytes,
    manifestBytesDigest: manifestResult.digest,
    outcomesBytesDigest: outcomesResult.digest,
    campaignDirectory: realCampaignDirectory,
  };
}

const ARTIFACT_VERIFICATION_FAILURE_NO_HASH_KEYS = [
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestBytesDigest",
  "outcomesBytesDigest",
  "generatedAt",
  "reasons",
] as const;

const ARTIFACT_VERIFICATION_REASON_CODES: ReadonlySet<string> = new Set<string>([
  "invalid-arguments",
  "missing-path-component",
  "symlink-rejected",
  "not-a-directory",
  "not-a-regular-file",
  "resolve-failed",
  "path-escape",
  "read-failed",
  "invalid-utf8",
  "invalid-json",
  "manifest-validation-failed",
  "artifact-verification-failed",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} has unknown field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      throw new Error(`${label} is missing field: ${key}`);
    }
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function canonicalSha256(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function decodeArtifactVerificationDigest(
  value: unknown,
  field: string,
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !CANONICAL_SHA256_PATTERN.test(value)) {
    throw new Error(`invalid ${field} digest format`);
  }
  return value;
}

function decodeArtifactVerificationFailureReasonV1(
  value: unknown,
): ArtifactVerificationFailureReasonV1 {
  if (!isPlainObject(value)) {
    throw new Error("artifact verification failure reason must be an object");
  }
  assertAllowedKeys(value, ["code", "detail"], "artifact verification failure reason");
  if (typeof value.code !== "string" || !ARTIFACT_VERIFICATION_REASON_CODES.has(value.code)) {
    throw new Error("invalid artifact verification failure reason code");
  }
  if (typeof value.detail !== "string") {
    throw new Error("artifact verification failure reason detail must be a string");
  }
  if (value.detail.length === 0) {
    throw new Error("artifact verification failure reason detail must not be empty");
  }
  if (value.detail.length > MAX_REASON_DETAIL_LENGTH) {
    throw new Error("artifact verification failure reason detail too long");
  }
  return {
    code: value.code as ArtifactVerificationFailureReasonCode,
    detail: value.detail,
  };
}

function validateArtifactVerificationFailureNoHash(
  value: unknown,
): ArtifactVerificationFailureNoHashV1 {
  if (!isPlainObject(value)) {
    throw new Error("artifact verification failure must be an object");
  }
  assertAllowedKeys(
    value,
    ARTIFACT_VERIFICATION_FAILURE_NO_HASH_KEYS,
    "artifact verification failure",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("invalid artifact verification failure schema version");
  }
  if (value.kind !== ARTIFACT_VERIFICATION_FAILURE_KIND) {
    throw new Error("invalid artifact verification failure kind");
  }
  if (
    typeof value.campaignId !== "string" ||
    !CAMPAIGN_ID_PATTERN.test(value.campaignId)
  ) {
    throw new Error("unsafe artifact verification failure campaign id");
  }
  const manifestBytesDigest = decodeArtifactVerificationDigest(
    value.manifestBytesDigest,
    "manifestBytesDigest",
  );
  const outcomesBytesDigest = decodeArtifactVerificationDigest(
    value.outcomesBytesDigest,
    "outcomesBytesDigest",
  );
  if (
    typeof value.generatedAt !== "string" ||
    !isCanonicalIsoString(value.generatedAt)
  ) {
    throw new Error("invalid artifact verification failure generatedAt timestamp");
  }
  if (!Array.isArray(value.reasons)) {
    throw new Error("artifact verification failure reasons must be an array");
  }
  if (value.reasons.length === 0) {
    throw new Error("artifact verification failure reasons must not be empty");
  }
  if (value.reasons.length > MAX_REASONS) {
    throw new Error("artifact verification failure has too many reasons");
  }
  const reasons = value.reasons.map((entry) =>
    decodeArtifactVerificationFailureReasonV1(entry),
  );
  return {
    schemaVersion: 1,
    kind: ARTIFACT_VERIFICATION_FAILURE_KIND,
    campaignId: value.campaignId,
    manifestBytesDigest,
    outcomesBytesDigest,
    generatedAt: value.generatedAt,
    reasons,
  };
}

export function hashArtifactVerificationFailureV1(
  input: ArtifactVerificationFailureNoHashV1,
): string {
  const payload: ArtifactVerificationFailureNoHashV1 = {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    campaignId: input.campaignId,
    manifestBytesDigest: input.manifestBytesDigest,
    outcomesBytesDigest: input.outcomesBytesDigest,
    generatedAt: input.generatedAt,
    reasons: input.reasons,
  };
  return canonicalSha256(stableStringify(payload));
}

export function createArtifactVerificationFailureV1(
  input: ArtifactVerificationFailureInputV1,
): ArtifactVerificationFailureV1 {
  const noHash = validateArtifactVerificationFailureNoHash(input);
  return {
    ...noHash,
    failureHash: hashArtifactVerificationFailureV1(noHash),
  };
}

export function decodeArtifactVerificationFailureV1(
  value: unknown,
): ArtifactVerificationFailureV1 {
  if (!isPlainObject(value)) {
    throw new Error("artifact verification failure must be an object");
  }
  assertAllowedKeys(
    value,
    [...ARTIFACT_VERIFICATION_FAILURE_NO_HASH_KEYS, "failureHash"],
    "artifact verification failure",
  );
  if (
    typeof value.failureHash !== "string" ||
    !CANONICAL_SHA256_PATTERN.test(value.failureHash)
  ) {
    throw new Error("invalid artifact verification failure hash format");
  }
  const noHash = validateArtifactVerificationFailureNoHash({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    campaignId: value.campaignId,
    manifestBytesDigest: value.manifestBytesDigest,
    outcomesBytesDigest: value.outcomesBytesDigest,
    generatedAt: value.generatedAt,
    reasons: value.reasons,
  });
  const expectedHash = hashArtifactVerificationFailureV1(noHash);
  if (expectedHash !== value.failureHash) {
    throw new Error("artifact verification failure hash mismatch");
  }
  return { ...noHash, failureHash: value.failureHash };
}

// ── Campaign output persistence ─────────────────────────────────

export type CampaignOutputErrorCode =
  | "invalid-arguments"
  | "missing-path-component"
  | "symlink-rejected"
  | "not-a-directory"
  | "not-a-regular-file"
  | "resolve-failed"
  | "path-escape"
  | "read-failed"
  | "write-failed"
  | "conflict"
  | "corrupt-output";

export interface CampaignOutputError {
  code: CampaignOutputErrorCode;
  detail: string;
}

export type CampaignOutputReadResult =
  | { ok: true; bytes: Buffer; path: string }
  | { ok: false; error: CampaignOutputError };

export type CampaignOutputWriteResult =
  | { ok: true; bytes: Buffer; path: string; created: boolean }
  | { ok: false; error: CampaignOutputError };

export type PersistArtifactVerificationFailureResult =
  | {
      ok: true;
      path: string;
      created: boolean;
      receipt: ArtifactVerificationFailureV1;
    }
  | { ok: false; error: CampaignOutputError };

export interface PersistArtifactVerificationFailureInput {
  campaignId: string;
  generatedAt: string;
  safeCampaignDirectory: string;
  manifestBytesDigest: string | null;
  outcomesBytesDigest: string | null;
  reasons: ReadonlyArray<ArtifactVerificationFailureReasonV1>;
}

export type PersistAcceptanceReportResult =
  | {
      ok: true;
      report: LearningEvalAcceptanceReportV1;
      jsonPath: string;
      markdownPath: string;
      created: boolean;
    }
  | { ok: false; error: CampaignOutputError };

function outputError(
  code: CampaignOutputErrorCode,
  detail: string,
): { ok: false; error: CampaignOutputError } {
  return { ok: false, error: { code, detail: boundDetail(detail) } };
}

function isValidOutputFilename(filename: unknown): filename is string {
  if (typeof filename !== "string" || filename.length === 0) {
    return false;
  }
  if (filename === "." || filename === "..") {
    return false;
  }
  if (basename(filename) !== filename) {
    return false;
  }
  return !filename.includes("/") && !filename.includes("\\");
}

async function resolveSafeCampaignDirectory(
  safeCampaignDirectory: string,
): Promise<{ ok: true; real: string } | { ok: false; error: CampaignOutputError }> {
  if (
    typeof safeCampaignDirectory !== "string" ||
    safeCampaignDirectory.length === 0
  ) {
    return outputError("invalid-arguments", "invalid campaign directory");
  }

  let stats;
  try {
    stats = await lstatOrNull(safeCampaignDirectory);
  } catch (err) {
    return outputError("missing-path-component", boundDetail(err));
  }
  if (stats === null) {
    return outputError("missing-path-component", "missing campaign directory");
  }
  if (stats.isSymbolicLink()) {
    return outputError("symlink-rejected", "symlinked campaign directory rejected");
  }
  if (!stats.isDirectory()) {
    return outputError("not-a-directory", "campaign path is not a directory");
  }

  let real: string;
  try {
    real = await realpath(safeCampaignDirectory);
  } catch (err) {
    return outputError("resolve-failed", boundDetail(err));
  }
  if (real !== safeCampaignDirectory) {
    return outputError("not-a-directory", "campaign directory changed after safety resolution");
  }
  return { ok: true, real };
}

async function resolveCanonicalCampaignDirectory(
  campaignId: string,
): Promise<{ ok: true; real: string } | { ok: false; error: CampaignOutputError }> {
  if (typeof campaignId !== "string" || !CAMPAIGN_ID_PATTERN.test(campaignId)) {
    return outputError("invalid-arguments", "invalid campaign id");
  }

  const repoRoot = resolve(import.meta.dir, "..", "..");
  const campaignRelativeComponents = [
    "work",
    "opencode-memory",
    "priority3-evaluations",
    campaignId,
  ];

  let currentPath = repoRoot;
  for (const component of campaignRelativeComponents) {
    const candidate = join(currentPath, component);
    let stats;
    try {
      stats = await lstatOrNull(candidate);
    } catch (err) {
      return outputError("missing-path-component", boundDetail(err));
    }
    if (stats === null) {
      return outputError(
        "missing-path-component",
        `missing path component: ${component}`,
      );
    }
    if (stats.isSymbolicLink()) {
      return outputError(
        "symlink-rejected",
        `symlink path component rejected: ${component}`,
      );
    }
    if (!stats.isDirectory()) {
      return outputError(
        "not-a-directory",
        `path component is not a directory: ${component}`,
      );
    }
    currentPath = candidate;
  }

  let realRepoRoot: string;
  try {
    realRepoRoot = await realpath(repoRoot);
  } catch (err) {
    return outputError("resolve-failed", boundDetail(err));
  }

  let realCampaignDirectory: string;
  try {
    realCampaignDirectory = await realpath(currentPath);
  } catch (err) {
    return outputError("resolve-failed", boundDetail(err));
  }

  const expectedCampaignDirectory = join(
    realRepoRoot,
    "work",
    "opencode-memory",
    "priority3-evaluations",
    campaignId,
  );
  if (realCampaignDirectory !== expectedCampaignDirectory) {
    return outputError(
      "path-escape",
      "campaign directory does not match the expected repository location",
    );
  }

  return { ok: true, real: realCampaignDirectory };
}

async function requireSuppliedCampaignDirectoryMatches(
  suppliedDirectory: string,
  canonicalDirectory: string,
): Promise<{ ok: true } | { ok: false; error: CampaignOutputError }> {
  if (typeof suppliedDirectory !== "string" || suppliedDirectory.length === 0) {
    return outputError("invalid-arguments", "invalid campaign directory");
  }

  let stats;
  try {
    stats = await lstatOrNull(suppliedDirectory);
  } catch (err) {
    return outputError("missing-path-component", boundDetail(err));
  }
  if (stats === null) {
    return outputError("missing-path-component", "missing campaign directory");
  }
  if (stats.isSymbolicLink()) {
    return outputError("symlink-rejected", "symlinked campaign directory rejected");
  }
  if (!stats.isDirectory()) {
    return outputError("not-a-directory", "campaign path is not a directory");
  }

  let realSupplied: string;
  try {
    realSupplied = await realpath(suppliedDirectory);
  } catch (err) {
    return outputError("resolve-failed", boundDetail(err));
  }
  if (realSupplied !== canonicalDirectory) {
    return outputError(
      "path-escape",
      "campaign directory does not match the expected repository location",
    );
  }
  return { ok: true };
}

async function resolveBoundCampaignDirectory(
  campaignId: string,
  suppliedDirectory: string,
): Promise<{ ok: true; real: string } | { ok: false; error: CampaignOutputError }> {
  const canonical = await resolveCanonicalCampaignDirectory(campaignId);
  if (!canonical.ok) {
    return canonical;
  }
  if (basename(canonical.real) !== campaignId) {
    return outputError(
      "path-escape",
      "campaign directory does not match the campaign id",
    );
  }
  const supplied = await requireSuppliedCampaignDirectoryMatches(
    suppliedDirectory,
    canonical.real,
  );
  if (!supplied.ok) {
    return supplied;
  }
  return { ok: true, real: canonical.real };
}

async function readCampaignOutputFile(
  safeCampaignDirectory: string,
  filename: string,
): Promise<CampaignOutputReadResult> {
  if (!isValidOutputFilename(filename)) {
    return outputError("invalid-arguments", "invalid output filename");
  }

  const directory = await resolveSafeCampaignDirectory(safeCampaignDirectory);
  if (!directory.ok) {
    return directory;
  }

  const filePath = join(directory.real, filename);
  if (dirname(filePath) !== directory.real) {
    return outputError("path-escape", "output path escapes campaign directory");
  }

  let stats;
  try {
    stats = await lstatOrNull(filePath);
  } catch (err) {
    return outputError("missing-path-component", boundDetail(err));
  }
  if (stats === null) {
    return outputError("missing-path-component", `missing output file: ${filename}`);
  }
  if (stats.isSymbolicLink()) {
    return outputError("symlink-rejected", `symlink output rejected: ${filename}`);
  }
  if (stats.isDirectory()) {
    return outputError("not-a-regular-file", `output is a directory: ${filename}`);
  }
  if (!stats.isFile()) {
    return outputError("not-a-regular-file", `not a regular file: ${filename}`);
  }

  let realPath: string;
  try {
    realPath = await realpath(filePath);
  } catch (err) {
    return outputError("resolve-failed", boundDetail(err));
  }
  if (dirname(realPath) !== directory.real) {
    return outputError("path-escape", "output real path escapes campaign directory");
  }

  try {
    const bytes = await readFile(realPath);
    return { ok: true, bytes, path: realPath };
  } catch (err) {
    return outputError("read-failed", boundDetail(err));
  }
}

async function writeCampaignOutputFileExclusive(
  safeCampaignDirectory: string,
  filename: string,
  bytes: Buffer,
): Promise<CampaignOutputWriteResult> {
  if (!isValidOutputFilename(filename)) {
    return outputError("invalid-arguments", "invalid output filename");
  }
  if (!Buffer.isBuffer(bytes)) {
    return outputError("invalid-arguments", "output bytes must be a buffer");
  }

  const directory = await resolveSafeCampaignDirectory(safeCampaignDirectory);
  if (!directory.ok) {
    return directory;
  }

  const filePath = join(directory.real, filename);
  if (dirname(filePath) !== directory.real) {
    return outputError("path-escape", "output path escapes campaign directory");
  }

  let created: boolean;
  try {
    await writeFile(filePath, bytes, { flag: "wx" });
    created = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return outputError("write-failed", boundDetail(err));
    }
    created = false;
  }

  const verified = await readCampaignOutputFile(directory.real, filename);
  if (!verified.ok) {
    return created
      ? outputError("corrupt-output", "written output could not be verified")
      : verified;
  }
  if (!verified.bytes.equals(bytes)) {
    return outputError("conflict", `existing output differs for ${filename}`);
  }
  return { ok: true, bytes: verified.bytes, path: verified.path, created };
}

function artifactVerificationFailureFilename(
  receipt: ArtifactVerificationFailureV1,
): string {
  const digestTuple = [
    receipt.campaignId,
    receipt.manifestBytesDigest,
    receipt.outcomesBytesDigest,
    receipt.generatedAt,
    receipt.failureHash,
  ];
  const digest = canonicalSha256(stableStringify(digestTuple)).slice(
    "sha256:".length,
  );
  return `artifact-verification-failure-${digest}.json`;
}

export async function persistArtifactVerificationFailure(
  input: PersistArtifactVerificationFailureInput,
): Promise<PersistArtifactVerificationFailureResult> {
  let receipt: ArtifactVerificationFailureV1;
  try {
    receipt = createArtifactVerificationFailureV1({
      schemaVersion: 1,
      kind: ARTIFACT_VERIFICATION_FAILURE_KIND,
      campaignId: input.campaignId,
      manifestBytesDigest: input.manifestBytesDigest,
      outcomesBytesDigest: input.outcomesBytesDigest,
      generatedAt: input.generatedAt,
      reasons: input.reasons,
    });
  } catch (err) {
    return outputError("invalid-arguments", `invalid artifact verification failure: ${boundDetail(err)}`);
  }

  const boundDirectory = await resolveBoundCampaignDirectory(
    receipt.campaignId,
    input.safeCampaignDirectory,
  );
  if (!boundDirectory.ok) {
    return boundDirectory;
  }

  const filename = artifactVerificationFailureFilename(receipt);
  const canonicalBytes = Buffer.from(`${stableStringify(receipt)}\n`, "utf8");
  const written = await writeCampaignOutputFileExclusive(
    boundDirectory.real,
    filename,
    canonicalBytes,
  );
  if (!written.ok) {
    return written;
  }

  let reread: ArtifactVerificationFailureV1;
  try {
    const parsed: unknown = JSON.parse(written.bytes.toString("utf8"));
    reread = decodeArtifactVerificationFailureV1(parsed);
  } catch (err) {
    return outputError(
      "corrupt-output",
      `artifact verification failure readback failed: ${boundDetail(err)}`,
    );
  }
  if (stableStringify(reread) !== stableStringify(receipt)) {
    return outputError("corrupt-output", "artifact verification failure canonical bytes mismatch");
  }
  if (reread.failureHash !== receipt.failureHash) {
    return outputError("corrupt-output", "artifact verification failure hash mismatch");
  }

  return {
    ok: true,
    path: written.path,
    created: written.created,
    receipt: reread,
  };
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|");
}

function orderCriteria(
  criteria: readonly LearningEvalCriterionResultV1[],
): LearningEvalCriterionResultV1[] {
  const index = new Map<string, number>();
  LEARNING_EVAL_ACCEPTANCE_CRITERION_IDS.forEach((id, position) => {
    index.set(id, position);
  });
  return [...criteria].sort((left, right) => {
    const leftIndex = index.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = index.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function orderReasons(reasons: readonly string[]): string[] {
  return [...reasons].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function renderAcceptanceReportMarkdown(
  report: LearningEvalAcceptanceReportV1,
): string {
  const lines: string[] = [];
  lines.push("# Learning Eval Acceptance Report");
  lines.push("");
  lines.push(`- Campaign: ${escapeMarkdownText(report.campaignId)}`);
  lines.push(`- Decision: ${report.decision}`);
  lines.push(`- Generated at: ${escapeMarkdownText(report.generatedAt)}`);
  lines.push(`- Report hash: ${report.reportHash}`);
  lines.push(`- Manifest hash: ${report.manifestHash}`);
  lines.push(`- Input outcomes digest: ${report.inputOutcomesDigest}`);
  lines.push(`- Candidate: ${escapeMarkdownText(report.candidate.id)}`);
  lines.push("");
  lines.push("## Criteria");
  lines.push("");
  lines.push("| Criterion | Status | Threshold | Observed | Reason |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const criterion of orderCriteria(report.criteria)) {
    lines.push(
      `| ${escapeMarkdownText(criterion.id)} | ${criterion.status} | ${escapeMarkdownText(criterion.threshold)} | ${escapeMarkdownText(criterion.observed ?? "unknown")} | ${escapeMarkdownText(criterion.reason)} |`,
    );
  }
  lines.push("");
  lines.push("## Reasons");
  lines.push("");
  const reasons = orderReasons(report.reasons);
  if (reasons.length === 0) {
    lines.push("_None._");
  } else {
    for (const reason of reasons) {
      lines.push(`- ${escapeMarkdownText(reason)}`);
    }
  }
  return lines.join("\n");
}

export async function persistAcceptanceReport(
  report: unknown,
  campaignDir: string,
): Promise<PersistAcceptanceReportResult> {
  const decoded = decodeLearningEvalAcceptanceReport(report);
  if (!decoded.ok) {
    return outputError(
      "invalid-arguments",
      `acceptance report rejected at ${decoded.field}: ${decoded.detail}`,
    );
  }
  const canonical = decoded.report;
  if (!verifyLearningEvalAcceptanceReportHash(canonical)) {
    return outputError("invalid-arguments", "acceptance report hash mismatch");
  }

  const boundDirectory = await resolveBoundCampaignDirectory(
    canonical.campaignId,
    campaignDir,
  );
  if (!boundDirectory.ok) {
    return boundDirectory;
  }

  const reportHashHex = canonical.reportHash.slice("sha256:".length);
  const jsonFilename = `acceptance-${reportHashHex}.json`;
  const markdownFilename = `acceptance-${reportHashHex}.md`;
  const jsonBytes = Buffer.from(`${stableStringify(canonical)}\n`, "utf8");
  const markdownBytes = Buffer.from(
    renderAcceptanceReportMarkdown(canonical),
    "utf8",
  );

  const jsonWrite = await writeCampaignOutputFileExclusive(
    boundDirectory.real,
    jsonFilename,
    jsonBytes,
  );
  if (!jsonWrite.ok) {
    return jsonWrite;
  }

  let reread: LearningEvalAcceptanceReportV1;
  try {
    const parsed: unknown = JSON.parse(jsonWrite.bytes.toString("utf8"));
    const decodedJson = decodeLearningEvalAcceptanceReport(parsed);
    if (!decodedJson.ok) {
      return outputError(
        "corrupt-output",
        `acceptance report readback rejected at ${decodedJson.field}: ${decodedJson.detail}`,
      );
    }
    reread = decodedJson.report;
  } catch (err) {
    return outputError(
      "corrupt-output",
      `acceptance report readback failed: ${boundDetail(err)}`,
    );
  }
  if (!verifyLearningEvalAcceptanceReportHash(reread)) {
    return outputError("corrupt-output", "acceptance report readback hash mismatch");
  }
  if (!jsonWrite.bytes.equals(jsonBytes)) {
    return outputError("corrupt-output", "acceptance report canonical bytes mismatch");
  }

  const markdownWrite = await writeCampaignOutputFileExclusive(
    boundDirectory.real,
    markdownFilename,
    markdownBytes,
  );
  if (!markdownWrite.ok) {
    return markdownWrite;
  }
  if (!markdownWrite.bytes.equals(markdownBytes)) {
    return outputError("corrupt-output", "acceptance report markdown readback mismatch");
  }

  return {
    ok: true,
    report: reread,
    jsonPath: jsonWrite.path,
    markdownPath: markdownWrite.path,
    created: jsonWrite.created,
  };
}

export type ProcessAcceptanceArtifactsResult =
  | {
      status: "verified";
      report: LearningEvalAcceptanceReportV1;
      decision: LearningEvalDecisionRecordV1;
      observed: {
        candidateId: string;
        status: string | null;
        version: number | null;
      };
      jsonPath: string;
      markdownPath: string;
      reportCreated: boolean;
      decisionCreated: boolean;
    }
  | {
      status: "artifact_verification_failed";
      receipt: ArtifactVerificationFailureV1;
      path: string;
      created: boolean;
    }
  | {
      status: "failed";
      error: {
        code: string;
        detail: string;
      };
    };

export async function processAcceptanceArtifacts(
  args: AcceptanceArgs,
  inputs: LoadAcceptanceInputsSuccess,
): Promise<ProcessAcceptanceArtifactsResult> {
  const verification = verifyLearningEvalArtifacts({
    manifest: inputs.manifest,
    outcomeBytes: inputs.outcomesBytes,
  });

  if (!verification.ok) {
    const reasons: ArtifactVerificationFailureReasonV1[] =
      verification.reasons.map((reason) => ({
        code: "artifact-verification-failed",
        detail: boundDetail(reason),
      }));

    const persisted = await persistArtifactVerificationFailure({
      campaignId: args.campaignId,
      generatedAt: args.generatedAt,
      safeCampaignDirectory: inputs.campaignDirectory,
      manifestBytesDigest: inputs.manifestBytesDigest,
      outcomesBytesDigest: inputs.outcomesBytesDigest,
      reasons,
    });
    if (!persisted.ok) {
      return {
        status: "failed",
        error: {
          code: persisted.error.code,
          detail: persisted.error.detail,
        },
      };
    }
    return {
      status: "artifact_verification_failed",
      receipt: persisted.receipt,
      path: persisted.path,
      created: persisted.created,
    };
  }

  const report = computeLearningEvalAcceptance(verification.verified, {
    generatedAt: args.generatedAt,
  });

  const persistedReport = await persistAcceptanceReport(
    report,
    inputs.campaignDirectory,
  );
  if (!persistedReport.ok) {
    return {
      status: "failed",
      error: {
        code: persistedReport.error.code,
        detail: persistedReport.error.detail,
      },
    };
  }
  const durableReport = persistedReport.report;

  const candidateId = durableReport.candidate.id;
  const candidateRead = await readSkillCandidate(candidateId);
  let current:
    | Extract<
        Awaited<ReturnType<typeof readSkillCandidate>>,
        { ok: true }
      >["candidate"]
    | null = null;
  if (candidateRead.ok) {
    current = candidateRead.candidate;
  } else if (candidateRead.error !== "candidate_not_found") {
    return {
      status: "failed",
      error: {
        code: "candidate-read-failed",
        detail: boundDetail(candidateRead.error),
      },
    };
  }

  const observedStatus = current === null ? null : current.status;
  const observedVersion =
    current === null ? null : skillCandidateLifecycleVersion(current);

  const decisionCreation = createLearningEvalDecisionRecord({
    report: durableReport,
    candidate: inputs.manifest.candidate,
    observedCandidateStatus: observedStatus,
    observedCandidateLifecycleVersion: observedVersion,
    createdAt: args.generatedAt,
  });
  if (!decisionCreation.ok) {
    return {
      status: "failed",
      error: {
        code: "decision-record-creation-failed",
        detail: boundDetail(decisionCreation.error),
      },
    };
  }
  const createdDecision = decisionCreation.value;

  const decisionWrite = await writeLearningEvalDecision(createdDecision);
  if (!decisionWrite.ok) {
    return {
      status: "failed",
      error: {
        code: decisionWrite.code,
        detail: boundDetail(decisionWrite.error),
      },
    };
  }

  const decisionRead = await readLearningEvalDecision(durableReport.reportHash);
  if (!decisionRead.ok) {
    return {
      status: "failed",
      error: {
        code: decisionRead.code,
        detail: boundDetail(decisionRead.error),
      },
    };
  }

  if (
    stableStringify(createdDecision) !== stableStringify(decisionWrite.value) ||
    stableStringify(createdDecision) !== stableStringify(decisionRead.value)
  ) {
    return {
      status: "failed",
      error: {
        code: "decision-readback-mismatch",
        detail: "learning eval decision canonical bytes mismatch",
      },
    };
  }
  if (
    decisionRead.value.reportHash !== durableReport.reportHash ||
    decisionRead.value.recordHash !== createdDecision.recordHash
  ) {
    return {
      status: "failed",
      error: {
        code: "decision-readback-mismatch",
        detail: "learning eval decision hash mismatch",
      },
    };
  }

  return {
    status: "verified",
    report: durableReport,
    decision: decisionRead.value,
    observed: {
      candidateId,
      status: observedStatus,
      version: observedVersion,
    },
    jsonPath: persistedReport.jsonPath,
    markdownPath: persistedReport.markdownPath,
    reportCreated: persistedReport.created,
    decisionCreated: decisionWrite.created,
  };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseAcceptanceArgs(argv);
  if (!parsed.ok) {
    console.error(`error: invalid arguments: ${parsed.error}`);
    return 2;
  }
  const args = parsed.args;

  try {
    const loaded = await loadAcceptanceInputs(args);
    if (!loaded.ok) {
      const loadFailure = loaded.error;
      if (loadFailure.safeCampaignDirectory !== undefined) {
        const persisted = await persistArtifactVerificationFailure({
          campaignId: args.campaignId,
          generatedAt: args.generatedAt,
          safeCampaignDirectory: loadFailure.safeCampaignDirectory,
          manifestBytesDigest: loadFailure.manifestBytesDigest ?? null,
          outcomesBytesDigest: loadFailure.outcomesBytesDigest ?? null,
          reasons: [
            {
              code: loadFailure.code,
              detail:
                loadFailure.detail.length > 0
                  ? loadFailure.detail.slice(0, MAX_REASON_DETAIL_LENGTH)
                  : "unspecified",
            },
          ],
        });
        if (persisted.ok) {
          console.log(`artifact verification failure receipt: ${persisted.path}`);
          return 1;
        }
        console.error(
          `error: failed to persist artifact verification failure: ${persisted.error.code}: ${persisted.error.detail}`,
        );
        return 2;
      }
      console.error(`error: failed to load acceptance inputs: ${loadFailure.code}: ${loadFailure.detail}`);
      return 2;
    }

    if (loaded.manifest.campaignId !== args.campaignId) {
      console.error(
        `error: manifest campaign id mismatch: expected ${args.campaignId}, received ${loaded.manifest.campaignId}`,
      );
      return 2;
    }

    const result = await processAcceptanceArtifacts(args, loaded);
    if (result.status === "failed") {
      console.error(`error: acceptance processing failed: ${result.error.code}: ${result.error.detail}`);
      return 2;
    }
    if (result.status === "artifact_verification_failed") {
      console.log("inconclusive: artifact verification failure");
      console.log(`artifact verification failure receipt: ${result.path}`);
      return 1;
    }

    console.log(`report decision: ${result.report.decision}`);
    if (result.report.decision === "inconclusive") {
      console.log("lifecycle: unchanged (report decision is inconclusive)");
      return 1;
    }

    const accepted = result.report.decision === "accepted";
    const applied = applyLearningEvalDecision(result.decision, {
      action: accepted ? "stage_candidate" : "reject_candidate",
      expectedLifecycleVersion: result.observed.version,
      timestamp: args.generatedAt,
    });
    if (!applied.ok) {
      console.error(
        `lifecycle: unresolved (${applied.error})${applied.detail !== undefined ? `: ${applied.detail}` : ""}`,
      );
      return 2;
    }

    console.log(`lifecycle: ${accepted ? "staged" : "rejected"}`);
    return 0;
  } catch (err) {
    console.error(
      `error: acceptance processing threw unexpectedly: ${boundDetail(err)}`,
    );
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
