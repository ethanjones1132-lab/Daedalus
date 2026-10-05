// ═══════════════════════════════════════════════════════════════
// Priority 3 Phase 2 — immutable paired-transfer manifest + preflight
// ═══════════════════════════════════════════════════════════════
//
// This module is deliberately free of model, network, filesystem, and store
// access. It defines the versioned manifest the paired learning evaluator
// freezes before any held-out result is read, a strict decoder that refuses an
// unknown/missing/mistyped field at any nesting depth, a stable canonical hash,
// and a pure structural preflight.
//
// The preflight here proves the *shape* and *split* of a manifest. The async
// local-model identity pin lives in `paired-learning-evaluator.ts` because it
// touches the Ollama transport. No function in this file performs a model call.

import { createHash } from "node:crypto";
import type { TaskType } from "../../orchestration/coordinator";
import { validateSkillCandidate } from "../../intelligence/skill-candidate-validation";
import type { SkillCandidate } from "../../intelligence/skill-types";

export const LEARNING_EVAL_SCHEMA_VERSION = 1;
export const LEARNING_EVAL_GOVERNANCE_VERSION = 1;
/** Version of the nested, frozen training-run/oracle-evidence receipt. */
export const LEARNING_EVAL_TRAINING_EVIDENCE_VERSION = 1;

export type LearningEvalArm = "baseline" | "candidate" | "neutral";

/** Frozen arm set. The candidate/neutral arms are injected; baseline is not. */
export const LEARNING_EVAL_ARMS: readonly LearningEvalArm[] = [
  "baseline",
  "candidate",
  "neutral",
];

/**
 * Frozen sampler contract. Language identical across every arm is part of the
 * comparability claim, so an altered value invalidates the manifest.
 */
export const LEARNING_EVAL_REQUIRED_SAMPLER = {
  temperature: 0,
  top_p: 0.95,
  num_ctx: 16_384,
  num_predict: 1_024,
} as const;

/** One model call may take at most this long (Ollama transport default). */
export const LEARNING_EVAL_REQUIRED_MODEL_CALL_TIMEOUT_MS = 180_000;
/** Total wall-clock cap for one rollout. */
export const LEARNING_EVAL_REQUIRED_ROLLOUT_CAP_MS = 300_000;
/** Exactly three paired sampler seeds per held-out task. */
export const LEARNING_EVAL_REQUIRED_PAIRED_SEEDS = 3;
/** The tool bundle name the rollout runner actually registers. */
export const LEARNING_EVAL_REQUIRED_TOOL_BUNDLE = "filesystem-only";

/**
 * A frozen skill artifact: the COMPLETE `SkillCandidate` exactly as returned by
 * `validateSkillCandidate`, plus the canonical `sha256:<hex>` of that full
 * artifact. Freezing only an id/body/source tuple is insufficient: every
 * behavior and lineage field (trigger task_types/requirements/signals, source
 * run ids/session, confidence, status, timestamps, and any optional metadata)
 * is part of the compared artifact and changes the digest.
 */
export interface LearningEvalSkillCandidateArtifact {
  candidate: SkillCandidate;
  /**
   * Canonical `sha256:<hex>` over `stableStringify(candidate)`. The `candidate`
   * object is hashed in full, not reduced to a body digest.
   */
  artifactDigest: string;
}

export interface LearningEvalHeldOutTask {
  name: string;
  fixtureDigest: string;
}

export interface LearningEvalTrainingFixture {
  name: string;
  fixtureDigest: string;
}

export interface LearningEvalTrainingTrajectory {
  agentRunId: string;
  sessionId: string;
  /** `sha256:<hex>` digest of the frozen in-memory trajectory evidence. */
  digest: string;
}

/** Authentic graded-fixture oracle outcome of the single training run. */
export interface LearningEvalTrainingOracle {
  tier: string;
  ran: boolean;
  passed: boolean | null;
  /** Oracle detail; an empty string is a valid passing detail. */
  detail: string;
}

/**
 * Frozen evidence that the candidate was actually distilled from one successful,
 * oracle-verified training run. It is produced ONLY by `--freeze` from the
 * acquisition result and is never synthesized during a campaign. Every field is
 * cross-bound to `trainingFixture`/`trainingSeed`/`trainingTrajectory` and to the
 * frozen candidate artifact by preflight; a mismatch is a hard failure.
 */
export interface LearningEvalTrainingEvidence {
  trainingEvidenceVersion: number;
  /** Terminal training-run outcome. Preflight requires exactly `success`. */
  runOutcome: string;
  trainingFixture: LearningEvalTrainingFixture;
  trainingSeed: number;
  trajectory: LearningEvalTrainingTrajectory;
  oracle: LearningEvalTrainingOracle;
  /** Number of captured stage runs on the successful training trajectory. */
  stageRunCount: number;
  /** Model calls issued by the training run; null only when genuinely unavailable. */
  modelCalls: number | null;
  /** Canonical full-artifact digest of the frozen candidate. */
  candidateArtifactDigest: string;
  /** Full candidate source lineage, bound to the frozen training trajectory. */
  candidateSourceRunIds: string[];
  candidateSourceSessionId: string | null;
}

export interface LearningEvalModelIdentity {
  name: string;
  /**
   * Ollama *server* version from `/api/version`. Distinct from the immutable
   * installed model artifact digest below; the server version is informational
   * and never substitutes for the artifact pin.
   */
  version?: string;
  /**
   * Immutable installed model artifact digest from `/api/tags` (`sha256:<hex>`).
   * Required: comparability depends on the exact model blobs, not just the tag.
   */
  digest: string;
  /** Loopback-only Ollama base url the artifact was pinned at. */
  baseUrl: string;
  supportsNativeTools: boolean;
}

export interface LearningEvalSamplerSettings {
  temperature: number;
  top_p: number;
  num_ctx: number;
  num_predict: number;
}

export interface LearningEvalBudgets {
  modelCallTimeoutMs: number;
  rolloutTimeoutMs: number;
}

export interface LearningEvalToolBundle {
  name: string;
  tools: string[];
  network: boolean;
  delegates: boolean;
}

export interface LearningEvalRolloutSettings {
  executionProfile: string;
  stages: string[];
  /** Task type used for frozen trigger matching of all three arms. */
  skillMatchTaskType: TaskType;
}

/**
 * One frozen, independently randomized arm permutation for a single held-out
 * task + seed block. The manifest must contain exactly one of these per block,
 * each a permutation of `baseline`/`candidate`/`neutral`.
 */
export interface LearningEvalBlockArmOrder {
  task: string;
  seed: number;
  armOrder: LearningEvalArm[];
}

export interface LearningEvalManifest {
  schemaVersion: number;
  governanceVersion: number;
  campaignId: string;
  baseSourceSha: string;
  fixtureSourceDigest: string;
  rubricDigest: string;
  acceptanceCodeDigest: string;
  trainingFixture: LearningEvalTrainingFixture;
  /** Sampler seed used for the single declared training rollout. */
  trainingSeed: number;
  trainingTrajectory: LearningEvalTrainingTrajectory;
  /** Frozen successful training-run + authentic-oracle receipt. */
  trainingEvidence: LearningEvalTrainingEvidence;
  candidate: LearningEvalSkillCandidateArtifact;
  neutral: LearningEvalSkillCandidateArtifact;
  heldOutTasks: LearningEvalHeldOutTask[];
  model: LearningEvalModelIdentity;
  sampler: LearningEvalSamplerSettings;
  toolBundle: LearningEvalToolBundle;
  rollout: LearningEvalRolloutSettings;
  budgets: LearningEvalBudgets;
  pairedSeeds: number[];
  /** Exactly one randomized arm permutation per held-out task + seed block. */
  blockArmOrders: LearningEvalBlockArmOrder[];
  plannedOutcomeCount: number;
  pairedBlockCount: number;
}

/** Manifest with its frozen canonical hash attached. */
export interface FrozenLearningEvalManifest extends LearningEvalManifest {
  manifestHash: string;
}

// ── Canonical serialization ─────────────────────────────────────

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) out[key] = sortValue(input[key]);
    return out;
  }
  return value;
}

/** JSON with recursively sorted object keys; array order is preserved. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function computeBodyDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

/**
 * Canonical digest of the full frozen candidate artifact. Hashes the entire
 * normalized `SkillCandidate` (not just its body), so any behavioral or lineage
 * change invalidates the artifact.
 */
export function computeCandidateArtifactDigest(candidate: SkillCandidate): string {
  return computeDigest(stableStringify(candidate));
}

export function computeDigest(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

/**
 * Canonical manifest hash. The `manifestHash` field is excluded, so the hash is
 * stable regardless of how a caller assembles the frozen wrapper.
 */
export function computeManifestHash(manifest: LearningEvalManifest): string {
  const rest: Record<string, unknown> = { ...manifest };
  delete rest.manifestHash;
  return computeDigest(stableStringify(rest));
}

// ── Strict decode ───────────────────────────────────────────────

export type LearningEvalManifestDecodeErrorCode =
  | "not_object"
  | "unsupported_schema_version"
  | "unsupported_governance_version"
  | "unsupported_training_evidence_version"
  | "missing_field"
  | "unexpected_field"
  | "invalid_field";

export type LearningEvalManifestDecodeResult =
  | { ok: true; manifest: LearningEvalManifest }
  | { ok: false; code: LearningEvalManifestDecodeErrorCode; field?: string; detail?: string };

const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "governanceVersion",
  "campaignId",
  "baseSourceSha",
  "fixtureSourceDigest",
  "rubricDigest",
  "acceptanceCodeDigest",
  "trainingFixture",
  "trainingSeed",
  "trainingTrajectory",
  "trainingEvidence",
  "candidate",
  "neutral",
  "heldOutTasks",
  "model",
  "sampler",
  "toolBundle",
  "rollout",
  "budgets",
  "pairedSeeds",
  "blockArmOrders",
  "plannedOutcomeCount",
  "pairedBlockCount",
]);

/** Allowed frozen-wrapper field; validated separately by `decodeFrozenManifest`. */
const MANIFEST_EXTRA_KEYS = new Set(["manifestHash"]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isArm(value: unknown): value is LearningEvalArm {
  return value === "baseline" || value === "candidate" || value === "neutral";
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && VALID_TASK_TYPES.has(value as TaskType);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function fail(
  code: LearningEvalManifestDecodeErrorCode,
  field?: string,
  detail?: string,
): LearningEvalManifestDecodeResult {
  return { ok: false, code, field, detail };
}

/**
 * Recursively reject unknown keys inside a nested object/array element. Every
 * nested shape in the manifest is closed — a new field at any depth is a hard
 * decode failure so a mutated or forward-incompatible manifest cannot smuggle
 * data past the freeze.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): LearningEvalManifestDecodeResult | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return fail("unexpected_field", `${field}.${key}`, "unknown nested manifest field");
    }
  }
  return null;
}

type DecodeOutcome<T> = T | LearningEvalManifestDecodeResult;

function isDecodeFailure<T>(value: DecodeOutcome<T>): value is LearningEvalManifestDecodeResult {
  return (value as LearningEvalManifestDecodeResult).ok === false;
}

/**
 * The complete, closed key set of a frozen `SkillCandidate`. A field added to
 * the candidate type that is not listed here is a hard decode failure, so a
 * forward-incompatible or tampered artifact cannot pass the freeze boundary.
 */
const SKILL_CANDIDATE_KEYS = [
  "id",
  "name",
  "description",
  "trigger",
  "body",
  "source_run_ids",
  "source_session_id",
  "confidence",
  "status",
  "lifecycle_version",
  "eval_score",
  "eval_missed",
  "rejection_reason",
  "rejection_detail",
  "promoted_at",
  "tool_sequence_digest",
  "created_at",
  "updated_at",
] as const;

const SKILL_TRIGGER_KEYS = ["task_types", "requirements", "signals"] as const;

/**
 * Strict decoder for a full `SkillCandidate`. Refuses any unknown key at the
 * candidate or trigger level, then reuses the single authoritative
 * `validateSkillCandidate` predicate for the nested field shapes. Returns the
 * candidate exactly as `validateSkillCandidate` normalizes it.
 */
function decodeSkillCandidate(value: unknown, field: string): DecodeOutcome<SkillCandidate> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, SKILL_CANDIDATE_KEYS, field);
  if (unknown) return unknown;
  if (isRecord(value.trigger)) {
    const triggerUnknown = rejectUnknownKeys(value.trigger, SKILL_TRIGGER_KEYS, `${field}.trigger`);
    if (triggerUnknown) return triggerUnknown;
  }
  const validated = validateSkillCandidate(value);
  if (!validated.ok) return fail("invalid_field", field, "invalid skill candidate");
  return validated.candidate;
}

/**
 * Strict decoder for a frozen candidate artifact: the full validated candidate
 * plus its canonical full-artifact digest. The digest is recomputed from the
 * decoded candidate and must match byte for byte, so a mutated behavior or
 * lineage field is refused before execution.
 */
function decodeSkillCandidateArtifact(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalSkillCandidateArtifact> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["candidate", "artifactDigest"], field);
  if (unknown) return unknown;
  const artifactDigest = value.artifactDigest;
  if (!isDigest(artifactDigest)) {
    return fail("invalid_field", `${field}.artifactDigest`, "expected sha256:<hex>");
  }
  const candidate = decodeSkillCandidate(value.candidate, `${field}.candidate`);
  if (isDecodeFailure(candidate)) return candidate;
  const computed = computeCandidateArtifactDigest(candidate);
  if (computed !== artifactDigest) {
    return fail(
      "invalid_field",
      `${field}.artifactDigest`,
      `candidate artifact digest mismatch (computed ${computed}, frozen ${artifactDigest})`,
    );
  }
  return { candidate, artifactDigest };
}

function decodeHeldOutTask(value: unknown, field: string): DecodeOutcome<LearningEvalHeldOutTask> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["name", "fixtureDigest"], field);
  if (unknown) return unknown;
  if (!isNonEmptyString(value.name) || !isDigest(value.fixtureDigest)) {
    return fail("invalid_field", field, "expected { name, fixtureDigest }");
  }
  return { name: String(value.name), fixtureDigest: String(value.fixtureDigest) };
}

function decodeTrainingFixture(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalTrainingFixture> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["name", "fixtureDigest"], field);
  if (unknown) return unknown;
  if (!isNonEmptyString(value.name) || !isDigest(value.fixtureDigest)) {
    return fail("invalid_field", field, "expected { name, fixtureDigest }");
  }
  return { name: String(value.name), fixtureDigest: String(value.fixtureDigest) };
}

function decodeTrainingTrajectory(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalTrainingTrajectory> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["agentRunId", "sessionId", "digest"], field);
  if (unknown) return unknown;
  if (
    !isNonEmptyString(value.agentRunId) ||
    !isNonEmptyString(value.sessionId) ||
    !isDigest(value.digest)
  ) {
    return fail("invalid_field", field, "expected { agentRunId, sessionId, digest }");
  }
  return {
    agentRunId: String(value.agentRunId),
    sessionId: String(value.sessionId),
    digest: String(value.digest),
  };
}

function decodeTrainingOracle(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalTrainingOracle> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["tier", "ran", "passed", "detail"], field);
  if (unknown) return unknown;
  const tier = value.tier;
  const ran = value.ran;
  const passed = value.passed;
  const detail = value.detail;
  if (
    !isNonEmptyString(tier) ||
    typeof ran !== "boolean" ||
    !(passed === null || typeof passed === "boolean") ||
    typeof detail !== "string"
  ) {
    return fail("invalid_field", field, "expected { tier, ran, passed, detail }");
  }
  return { tier, ran, passed, detail };
}

/**
 * Strict decoder for the frozen training evidence receipt. The object is closed
 * at every depth, the nested `trainingEvidenceVersion` must match exactly, every
 * count must be a safe integer, and `modelCalls` may be null only when explicitly
 * recorded as unavailable.
 */
function decodeTrainingEvidence(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalTrainingEvidence> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(
    value,
    [
      "trainingEvidenceVersion",
      "runOutcome",
      "trainingFixture",
      "trainingSeed",
      "trajectory",
      "oracle",
      "stageRunCount",
      "modelCalls",
      "candidateArtifactDigest",
      "candidateSourceRunIds",
      "candidateSourceSessionId",
    ],
    field,
  );
  if (unknown) return unknown;
  if (value.trainingEvidenceVersion !== LEARNING_EVAL_TRAINING_EVIDENCE_VERSION) {
    return fail(
      "unsupported_training_evidence_version",
      `${field}.trainingEvidenceVersion`,
      String(value.trainingEvidenceVersion),
    );
  }
  const runOutcome = value.runOutcome;
  if (typeof runOutcome !== "string") {
    return fail("invalid_field", `${field}.runOutcome`, "expected string");
  }
  const trainingFixture = decodeTrainingFixture(value.trainingFixture, `${field}.trainingFixture`);
  if (isDecodeFailure(trainingFixture)) return trainingFixture;
  const trainingSeed = value.trainingSeed;
  if (!isSafeNonNegativeInt(trainingSeed)) {
    return fail("invalid_field", `${field}.trainingSeed`, "expected non-negative integer");
  }
  const trajectory = decodeTrainingTrajectory(value.trajectory, `${field}.trajectory`);
  if (isDecodeFailure(trajectory)) return trajectory;
  const oracle = decodeTrainingOracle(value.oracle, `${field}.oracle`);
  if (isDecodeFailure(oracle)) return oracle;
  const stageRunCount = value.stageRunCount;
  if (!isSafeNonNegativeInt(stageRunCount)) {
    return fail("invalid_field", `${field}.stageRunCount`, "expected non-negative integer");
  }
  const modelCalls = value.modelCalls;
  if (!(modelCalls === null || isSafeNonNegativeInt(modelCalls))) {
    return fail("invalid_field", `${field}.modelCalls`, "expected non-negative integer or null");
  }
  const candidateArtifactDigest = value.candidateArtifactDigest;
  if (!isDigest(candidateArtifactDigest)) {
    return fail("invalid_field", `${field}.candidateArtifactDigest`, "expected sha256:<hex>");
  }
  const candidateSourceRunIds = value.candidateSourceRunIds;
  if (!isStringArray(candidateSourceRunIds)) {
    return fail(
      "invalid_field",
      `${field}.candidateSourceRunIds`,
      "expected array of non-empty strings",
    );
  }
  const candidateSourceSessionId = value.candidateSourceSessionId;
  if (!(candidateSourceSessionId === null || isNonEmptyString(candidateSourceSessionId))) {
    return fail(
      "invalid_field",
      `${field}.candidateSourceSessionId`,
      "expected non-empty string or null",
    );
  }
  return {
    trainingEvidenceVersion: LEARNING_EVAL_TRAINING_EVIDENCE_VERSION,
    runOutcome,
    trainingFixture,
    trainingSeed,
    trajectory,
    oracle,
    stageRunCount,
    modelCalls,
    candidateArtifactDigest,
    candidateSourceRunIds: [...candidateSourceRunIds],
    candidateSourceSessionId,
  };
}

function decodeModelIdentity(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalModelIdentity> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(
    value,
    ["name", "version", "digest", "baseUrl", "supportsNativeTools"],
    field,
  );
  if (unknown) return unknown;
  if (
    !isNonEmptyString(value.name) ||
    !isDigest(value.digest) ||
    !isNonEmptyString(value.baseUrl) ||
    typeof value.supportsNativeTools !== "boolean" ||
    (value.version !== undefined && typeof value.version !== "string")
  ) {
    return fail("invalid_field", field, "expected { name, digest, baseUrl, supportsNativeTools }");
  }
  return {
    name: String(value.name),
    digest: String(value.digest),
    baseUrl: String(value.baseUrl),
    supportsNativeTools: value.supportsNativeTools,
    ...(value.version !== undefined ? { version: String(value.version) } : {}),
  };
}

function decodeSampler(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalSamplerSettings> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["temperature", "top_p", "num_ctx", "num_predict"], field);
  if (unknown) return unknown;
  if (
    !isFiniteNumber(value.temperature) ||
    !isFiniteNumber(value.top_p) ||
    !isFiniteNumber(value.num_ctx) ||
    !isFiniteNumber(value.num_predict)
  ) {
    return fail("invalid_field", field, "expected numeric sampler settings");
  }
  return {
    temperature: value.temperature,
    top_p: value.top_p,
    num_ctx: value.num_ctx,
    num_predict: value.num_predict,
  };
}

function decodeToolBundle(value: unknown, field: string): DecodeOutcome<LearningEvalToolBundle> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["name", "tools", "network", "delegates"], field);
  if (unknown) return unknown;
  if (
    !isNonEmptyString(value.name) ||
    !isStringArray(value.tools) ||
    typeof value.network !== "boolean" ||
    typeof value.delegates !== "boolean"
  ) {
    return fail("invalid_field", field, "expected { name, tools, network, delegates }");
  }
  return {
    name: String(value.name),
    tools: [...(value.tools as string[])],
    network: value.network,
    delegates: value.delegates,
  };
}

function decodeRollout(value: unknown, field: string): DecodeOutcome<LearningEvalRolloutSettings> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["executionProfile", "stages", "skillMatchTaskType"], field);
  if (unknown) return unknown;
  if (
    !isNonEmptyString(value.executionProfile) ||
    !isStringArray(value.stages) ||
    !isTaskType(value.skillMatchTaskType)
  ) {
    return fail("invalid_field", field, "expected { executionProfile, stages, skillMatchTaskType }");
  }
  return {
    executionProfile: String(value.executionProfile),
    stages: [...(value.stages as string[])],
    skillMatchTaskType: value.skillMatchTaskType,
  };
}

function decodeBudgets(value: unknown, field: string): DecodeOutcome<LearningEvalBudgets> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["modelCallTimeoutMs", "rolloutTimeoutMs"], field);
  if (unknown) return unknown;
  if (!isSafeNonNegativeInt(value.modelCallTimeoutMs) || !isSafeNonNegativeInt(value.rolloutTimeoutMs)) {
    return fail("invalid_field", field, "expected numeric budgets");
  }
  return {
    modelCallTimeoutMs: value.modelCallTimeoutMs,
    rolloutTimeoutMs: value.rolloutTimeoutMs,
  };
}

function decodeBlockArmOrder(
  value: unknown,
  field: string,
): DecodeOutcome<LearningEvalBlockArmOrder> {
  if (!isRecord(value)) return fail("invalid_field", field, "expected object");
  const unknown = rejectUnknownKeys(value, ["task", "seed", "armOrder"], field);
  if (unknown) return unknown;
  if (!isNonEmptyString(value.task) || !isSafeNonNegativeInt(value.seed)) {
    return fail("invalid_field", field, "expected { task, seed, armOrder }");
  }
  if (!Array.isArray(value.armOrder) || !value.armOrder.every(isArm)) {
    return fail("invalid_field", `${field}.armOrder`, "expected array of arms");
  }
  return {
    task: String(value.task),
    seed: value.seed,
    armOrder: [...(value.armOrder as LearningEvalArm[])],
  };
}

/**
 * Strict decoder. Refuses unknown fields at every nesting depth, missing
 * required fields, unsupported schema/governance versions, and any mistyped or
 * malformed value before a caller can build a campaign around it.
 */
export function decodeLearningEvalManifest(value: unknown): LearningEvalManifestDecodeResult {
  if (!isRecord(value)) return fail("not_object");

  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key) && !MANIFEST_EXTRA_KEYS.has(key)) {
      return fail("unexpected_field", key, "unknown manifest field");
    }
  }
  for (const key of MANIFEST_KEYS) {
    if (!(key in value)) return fail("missing_field", key, "required manifest field absent");
  }

  if (value.schemaVersion !== LEARNING_EVAL_SCHEMA_VERSION) {
    return fail("unsupported_schema_version", "schemaVersion", String(value.schemaVersion));
  }
  if (value.governanceVersion !== LEARNING_EVAL_GOVERNANCE_VERSION) {
    return fail("unsupported_governance_version", "governanceVersion", String(value.governanceVersion));
  }

  for (const key of ["campaignId", "baseSourceSha"] as const) {
    if (!isNonEmptyString(value[key])) return fail("missing_field", key);
  }
  for (const key of ["fixtureSourceDigest", "rubricDigest", "acceptanceCodeDigest"] as const) {
    if (!isDigest(value[key])) return fail("invalid_field", key, "expected sha256:<hex>");
  }

  const trainingFixture = decodeTrainingFixture(value.trainingFixture, "trainingFixture");
  if (isDecodeFailure(trainingFixture)) return trainingFixture;
  if (!isSafeNonNegativeInt(value.trainingSeed)) {
    return fail("invalid_field", "trainingSeed", "expected non-negative integer");
  }
  const trainingTrajectory = decodeTrainingTrajectory(value.trainingTrajectory, "trainingTrajectory");
  if (isDecodeFailure(trainingTrajectory)) return trainingTrajectory;
  const trainingEvidence = decodeTrainingEvidence(value.trainingEvidence, "trainingEvidence");
  if (isDecodeFailure(trainingEvidence)) return trainingEvidence;
  const candidate = decodeSkillCandidateArtifact(value.candidate, "candidate");
  if (isDecodeFailure(candidate)) return candidate;
  const neutral = decodeSkillCandidateArtifact(value.neutral, "neutral");
  if (isDecodeFailure(neutral)) return neutral;

  const heldOutRaw = value.heldOutTasks;
  if (!Array.isArray(heldOutRaw) || heldOutRaw.length === 0) {
    return fail("invalid_field", "heldOutTasks", "expected non-empty array");
  }
  const heldOutTasks: LearningEvalHeldOutTask[] = [];
  for (const [index, task] of heldOutRaw.entries()) {
    const decoded = decodeHeldOutTask(task, `heldOutTasks[${index}]`);
    if (isDecodeFailure(decoded)) return decoded;
    heldOutTasks.push(decoded);
  }

  const model = decodeModelIdentity(value.model, "model");
  if (isDecodeFailure(model)) return model;
  const sampler = decodeSampler(value.sampler, "sampler");
  if (isDecodeFailure(sampler)) return sampler;
  const toolBundle = decodeToolBundle(value.toolBundle, "toolBundle");
  if (isDecodeFailure(toolBundle)) return toolBundle;
  const rollout = decodeRollout(value.rollout, "rollout");
  if (isDecodeFailure(rollout)) return rollout;
  const budgets = decodeBudgets(value.budgets, "budgets");
  if (isDecodeFailure(budgets)) return budgets;

  if (!Array.isArray(value.pairedSeeds) || !value.pairedSeeds.every((seed) => isSafeNonNegativeInt(seed))) {
    return fail("invalid_field", "pairedSeeds", "expected array of non-negative integers");
  }

  const blockArmOrdersRaw = value.blockArmOrders;
  if (!Array.isArray(blockArmOrdersRaw) || blockArmOrdersRaw.length === 0) {
    return fail("invalid_field", "blockArmOrders", "expected non-empty array");
  }
  const blockArmOrders: LearningEvalBlockArmOrder[] = [];
  for (const [index, block] of blockArmOrdersRaw.entries()) {
    const decoded = decodeBlockArmOrder(block, `blockArmOrders[${index}]`);
    if (isDecodeFailure(decoded)) return decoded;
    blockArmOrders.push(decoded);
  }

  if (!isSafeNonNegativeInt(value.plannedOutcomeCount) || !isSafeNonNegativeInt(value.pairedBlockCount)) {
    return fail("invalid_field", "plannedOutcomeCount/pairedBlockCount", "expected non-negative integers");
  }

  const manifest: LearningEvalManifest = {
    schemaVersion: LEARNING_EVAL_SCHEMA_VERSION,
    governanceVersion: LEARNING_EVAL_GOVERNANCE_VERSION,
    campaignId: String(value.campaignId),
    baseSourceSha: String(value.baseSourceSha),
    fixtureSourceDigest: String(value.fixtureSourceDigest),
    rubricDigest: String(value.rubricDigest),
    acceptanceCodeDigest: String(value.acceptanceCodeDigest),
    trainingFixture,
    trainingSeed: value.trainingSeed,
    trainingTrajectory,
    trainingEvidence,
    candidate,
    neutral,
    heldOutTasks,
    model,
    sampler,
    toolBundle,
    rollout,
    budgets,
    pairedSeeds: [...(value.pairedSeeds as number[])],
    blockArmOrders,
    plannedOutcomeCount: value.plannedOutcomeCount,
    pairedBlockCount: value.pairedBlockCount,
  };
  return { ok: true, manifest };
}

// ── Pure structural preflight ───────────────────────────────────

export interface LearningEvalBlockPlan {
  task: string;
  seed: number;
  armOrder: LearningEvalArm[];
}

export type LearningEvalPreflightFailureCode =
  | "candidate_artifact_invalid"
  | "candidate_artifact_digest_mismatch"
  | "neutral_artifact_invalid"
  | "neutral_artifact_digest_mismatch"
  | "candidate_lineage_mismatch"
  | "held_out_set_mismatch"
  | "fixture_digest_mismatch"
  | "invalid_seed_count"
  | "duplicate_seed"
  | "duplicate_task"
  | "missing_block"
  | "duplicate_block"
  | "unexpected_block"
  | "invalid_arm_order"
  | "planned_count_mismatch"
  | "training_is_held_out"
  | "training_trajectory_mismatch"
  | "training_trajectory_collision"
  | "training_evidence_missing"
  | "training_evidence_unsuccessful"
  | "training_evidence_oracle_missing"
  | "training_evidence_oracle_failed"
  | "training_evidence_inconsistent"
  | "mixed_or_missing_model_identity"
  | "altered_sampler"
  | "altered_budget"
  | "altered_tool_bundle";

export interface LearningEvalPreflightPlan {
  heldOutTaskNames: string[];
  pairedSeeds: number[];
  pairedBlockCount: number;
  plannedOutcomeCount: number;
  blocks: LearningEvalBlockPlan[];
}

export type LearningEvalPreflightResult =
  | { ok: true; plan: LearningEvalPreflightPlan }
  | { ok: false; code: LearningEvalPreflightFailureCode; detail: string };

function isArmPermutation(order: readonly LearningEvalArm[]): boolean {
  return (
    order.length === LEARNING_EVAL_ARMS.length &&
    new Set(order).size === LEARNING_EVAL_ARMS.length &&
    LEARNING_EVAL_ARMS.every((arm) => order.includes(arm))
  );
}

/**
 * Pure preflight. `expectedHeldOut` is the authentic held-out fixture identity
 * (name + fixture digest) resolved from the checked-in fixture source. The
 * manifest must match it exactly, and must carry exactly one valid randomized
 * arm permutation per held-out task + seed block.
 */
export function validateLearningEvalManifest(
  manifest: LearningEvalManifest,
  expectedHeldOut: readonly LearningEvalHeldOutTask[],
): LearningEvalPreflightResult {
  if (!validateSkillCandidate(manifest.candidate.candidate).ok) {
    return { ok: false, code: "candidate_artifact_invalid", detail: manifest.candidate.candidate.id };
  }
  if (computeCandidateArtifactDigest(manifest.candidate.candidate) !== manifest.candidate.artifactDigest) {
    return { ok: false, code: "candidate_artifact_digest_mismatch", detail: manifest.candidate.candidate.id };
  }
  if (!validateSkillCandidate(manifest.neutral.candidate).ok) {
    return { ok: false, code: "neutral_artifact_invalid", detail: manifest.neutral.candidate.id };
  }
  if (computeCandidateArtifactDigest(manifest.neutral.candidate) !== manifest.neutral.artifactDigest) {
    return { ok: false, code: "neutral_artifact_digest_mismatch", detail: manifest.neutral.candidate.id };
  }

  // Frozen training evidence must prove a successful, oracle-verified training
  // run and agree with every tuple the rest of the manifest declares. Absent,
  // unsuccessful, missing/failing-oracle, or internally inconsistent evidence
  // fails closed before any held-out arm can run.
  const trainingEvidence = manifest.trainingEvidence;
  if (!trainingEvidence) {
    return { ok: false, code: "training_evidence_missing", detail: "manifest carries no training evidence" };
  }
  if (trainingEvidence.runOutcome !== "success") {
    return {
      ok: false,
      code: "training_evidence_unsuccessful",
      detail: `training runOutcome=${trainingEvidence.runOutcome}`,
    };
  }
  if (!trainingEvidence.oracle || trainingEvidence.oracle.ran !== true) {
    return {
      ok: false,
      code: "training_evidence_oracle_missing",
      detail: trainingEvidence.oracle?.detail || trainingEvidence.oracle?.tier || "authentic oracle did not run",
    };
  }
  if (trainingEvidence.oracle.passed !== true) {
    return {
      ok: false,
      code: "training_evidence_oracle_failed",
      detail: trainingEvidence.oracle.detail || trainingEvidence.oracle.tier,
    };
  }
  if (
    trainingEvidence.trainingFixture.name !== manifest.trainingFixture.name ||
    trainingEvidence.trainingFixture.fixtureDigest !== manifest.trainingFixture.fixtureDigest
  ) {
    return { ok: false, code: "training_evidence_inconsistent", detail: "trainingFixture" };
  }
  if (trainingEvidence.trainingSeed !== manifest.trainingSeed) {
    return { ok: false, code: "training_evidence_inconsistent", detail: "trainingSeed" };
  }
  if (
    trainingEvidence.trajectory.agentRunId !== manifest.trainingTrajectory.agentRunId ||
    trainingEvidence.trajectory.sessionId !== manifest.trainingTrajectory.sessionId ||
    trainingEvidence.trajectory.digest !== manifest.trainingTrajectory.digest
  ) {
    return { ok: false, code: "training_evidence_inconsistent", detail: "trainingTrajectory" };
  }
  if (trainingEvidence.candidateArtifactDigest !== manifest.candidate.artifactDigest) {
    return { ok: false, code: "training_evidence_inconsistent", detail: "candidateArtifactDigest" };
  }
  if (
    stableStringify(trainingEvidence.candidateSourceRunIds) !==
      stableStringify(manifest.candidate.candidate.source_run_ids) ||
    (trainingEvidence.candidateSourceSessionId ?? null) !==
      (manifest.candidate.candidate.source_session_id ?? null)
  ) {
    return { ok: false, code: "training_evidence_inconsistent", detail: "candidateSourceLineage" };
  }
  if (trainingEvidence.stageRunCount < 1) {
    return { ok: false, code: "training_evidence_inconsistent", detail: "stageRunCount" };
  }

  // The full candidate lineage must bind exactly to the frozen training
  // trajectory: the candidate must have been distilled from the declared
  // training run and, when it carries a session id, that exact session.
  if (!manifest.candidate.candidate.source_run_ids.includes(manifest.trainingTrajectory.agentRunId)) {
    return {
      ok: false,
      code: "candidate_lineage_mismatch",
      detail: `candidate missing source run ${manifest.trainingTrajectory.agentRunId}`,
    };
  }
  if (
    manifest.candidate.candidate.source_session_id !== undefined &&
    manifest.candidate.candidate.source_session_id !== manifest.trainingTrajectory.sessionId
  ) {
    return {
      ok: false,
      code: "candidate_lineage_mismatch",
      detail: `candidate source session ${manifest.candidate.candidate.source_session_id} != ${manifest.trainingTrajectory.sessionId}`,
    };
  }

  const expectedNames = [...expectedHeldOut.map((t) => t.name)].sort();
  const actualNames = [...manifest.heldOutTasks.map((t) => t.name)].sort();
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some((name, index) => name !== actualNames[index])
  ) {
    return { ok: false, code: "held_out_set_mismatch", detail: `expected ${expectedNames.join(",")}` };
  }

  const expectedByName = new Map(expectedHeldOut.map((t) => [t.name, t.fixtureDigest]));
  for (const task of manifest.heldOutTasks) {
    if (expectedByName.get(task.name) !== task.fixtureDigest) {
      return { ok: false, code: "fixture_digest_mismatch", detail: task.name };
    }
  }

  const uniqueTasks = new Set(manifest.heldOutTasks.map((t) => t.name));
  if (uniqueTasks.size !== manifest.heldOutTasks.length) {
    return { ok: false, code: "duplicate_task", detail: "duplicate held-out task name" };
  }

  if (manifest.pairedSeeds.length !== LEARNING_EVAL_REQUIRED_PAIRED_SEEDS) {
    return {
      ok: false,
      code: "invalid_seed_count",
      detail: `expected ${LEARNING_EVAL_REQUIRED_PAIRED_SEEDS}, got ${manifest.pairedSeeds.length}`,
    };
  }
  if (new Set(manifest.pairedSeeds).size !== manifest.pairedSeeds.length) {
    return { ok: false, code: "duplicate_seed", detail: manifest.pairedSeeds.join(",") };
  }

  // Exact block coverage: one permutation per held-out task + seed block.
  const expectedBlockKeys = new Set<string>();
  for (const task of manifest.heldOutTasks) {
    for (const seed of manifest.pairedSeeds) expectedBlockKeys.add(`${task.name}|${seed}`);
  }
  const seenBlockKeys = new Set<string>();
  for (const block of manifest.blockArmOrders) {
    const blockKey = `${block.task}|${block.seed}`;
    if (!uniqueTasks.has(block.task) || !manifest.pairedSeeds.includes(block.seed)) {
      return { ok: false, code: "unexpected_block", detail: blockKey };
    }
    if (seenBlockKeys.has(blockKey)) {
      return { ok: false, code: "duplicate_block", detail: blockKey };
    }
    seenBlockKeys.add(blockKey);
    if (!isArmPermutation(block.armOrder)) {
      return { ok: false, code: "invalid_arm_order", detail: `${blockKey}:${block.armOrder.join(",")}` };
    }
  }
  for (const expectedKey of expectedBlockKeys) {
    if (!seenBlockKeys.has(expectedKey)) {
      return { ok: false, code: "missing_block", detail: expectedKey };
    }
  }

  const pairedBlockCount = manifest.heldOutTasks.length * manifest.pairedSeeds.length;
  const plannedOutcomeCount = pairedBlockCount * LEARNING_EVAL_ARMS.length;
  if (manifest.pairedBlockCount !== pairedBlockCount) {
    return { ok: false, code: "planned_count_mismatch", detail: `pairedBlockCount expected ${pairedBlockCount}` };
  }
  if (manifest.plannedOutcomeCount !== plannedOutcomeCount) {
    return { ok: false, code: "planned_count_mismatch", detail: `plannedOutcomeCount expected ${plannedOutcomeCount}` };
  }

  if (uniqueTasks.has(manifest.trainingFixture.name)) {
    return { ok: false, code: "training_is_held_out", detail: manifest.trainingFixture.name };
  }

  // The frozen training trajectory must be exactly the declared fixture+seed.
  const expectedTrainingRunId = `rollout-${manifest.trainingFixture.name}-${manifest.trainingSeed}`;
  if (manifest.trainingTrajectory.agentRunId !== expectedTrainingRunId) {
    return { ok: false, code: "training_trajectory_mismatch", detail: manifest.trainingTrajectory.agentRunId };
  }
  const expectedTrainingSessionId =
    `eval-training:${manifest.campaignId}:${manifest.trainingFixture.name}:${manifest.trainingSeed}`;
  if (manifest.trainingTrajectory.sessionId !== expectedTrainingSessionId) {
    return { ok: false, code: "training_trajectory_mismatch", detail: manifest.trainingTrajectory.sessionId };
  }

  for (const task of manifest.heldOutTasks) {
    for (const seed of manifest.pairedSeeds) {
      const candidateRunId = `rollout-${task.name}-${seed}`;
      if (manifest.trainingTrajectory.agentRunId === candidateRunId) {
        return { ok: false, code: "training_trajectory_collision", detail: candidateRunId };
      }
      const candidateSessionId = `eval-heldout:${manifest.campaignId}:${task.name}:${seed}`;
      if (manifest.trainingTrajectory.sessionId === candidateSessionId) {
        return { ok: false, code: "training_trajectory_collision", detail: candidateSessionId };
      }
    }
  }

  if (
    !manifest.model.name ||
    typeof manifest.model.supportsNativeTools !== "boolean" ||
    !isDigest(manifest.model.digest) ||
    !isNonEmptyString(manifest.model.baseUrl)
  ) {
    return { ok: false, code: "mixed_or_missing_model_identity", detail: "missing pinned model artifact digest" };
  }

  const s = manifest.sampler;
  const r = LEARNING_EVAL_REQUIRED_SAMPLER;
  if (s.temperature !== r.temperature || s.top_p !== r.top_p || s.num_ctx !== r.num_ctx || s.num_predict !== r.num_predict) {
    return { ok: false, code: "altered_sampler", detail: JSON.stringify(s) };
  }
  if (
    manifest.budgets.modelCallTimeoutMs !== LEARNING_EVAL_REQUIRED_MODEL_CALL_TIMEOUT_MS ||
    manifest.budgets.rolloutTimeoutMs !== LEARNING_EVAL_REQUIRED_ROLLOUT_CAP_MS
  ) {
    return { ok: false, code: "altered_budget", detail: JSON.stringify(manifest.budgets) };
  }
  if (
    manifest.toolBundle.name !== LEARNING_EVAL_REQUIRED_TOOL_BUNDLE ||
    manifest.toolBundle.network !== false ||
    manifest.toolBundle.delegates !== false
  ) {
    return { ok: false, code: "altered_tool_bundle", detail: JSON.stringify(manifest.toolBundle) };
  }

  const blocks: LearningEvalBlockPlan[] = manifest.blockArmOrders.map((block) => ({
    task: block.task,
    seed: block.seed,
    armOrder: [...block.armOrder],
  }));

  return {
    ok: true,
    plan: {
      heldOutTaskNames: manifest.heldOutTasks.map((t) => t.name),
      pairedSeeds: [...manifest.pairedSeeds],
      pairedBlockCount,
      plannedOutcomeCount,
      blocks,
    },
  };
}
