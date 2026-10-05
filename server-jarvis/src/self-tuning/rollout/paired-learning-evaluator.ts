// ═══════════════════════════════════════════════════════════════
// Priority 3 Phase 2 — paired baseline/candidate/neutral evaluator
// ═══════════════════════════════════════════════════════════════
//
// Implements, but does NOT run, the frozen paired-transfer study. The evaluator
//
//   * derives one candidate from a declared *training* fixture trajectory with
//     the existing distiller at `persist: false`,
//   * injects candidate/neutral skills through the production resolver and the
//     existing rollout path (never persisted, never promoted),
//   * runs baseline/candidate/neutral serially per held-out task/seed block with
//     identical frozen model/sampler/tool/budget settings,
//   * keeps one outcome row for every scheduled arm, including failures, and
//   * computes only descriptive Phase 2 outputs.
//
// Phase 3 owns independent acceptance and the pass/reject/inconclusive gate.
// This module never calls a promotion path, never writes a production store,
// and never asserts that learning improved anything.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { defaultConfig, type JarvisConfig, type SkillDistillationConfig } from "../../config";
import type { CallModelFn, TaskType } from "../../orchestration/coordinator";
import type { RunRewardBreakdown } from "../../orchestration/run-reward";
import { BASELINE_THETA } from "../../orchestration/orchestration-policy";
import {
  readOllamaVersion,
  type OllamaTransportDeps,
} from "./ollama-local-transport";
import { makeLocalCallModel } from "./local-call-model";
import {
  buildFixtureRolloutRequest,
  runOneRollout,
  rolloutRunId,
  type RolloutBudgetSpec,
  type RolloutOutcome,
  type RolloutSamplerSpec,
  type RolloutSkillOverride,
} from "./rollout-runner";
import { HELD_OUT_TASKS, TRAINING_TASKS, type FixtureTask } from "./fixture-tasks";
import { validateSkillCandidate } from "../../intelligence/skill-candidate-validation";
import { distillFromTrajectorySnapshot } from "../../intelligence/skill-distiller";
import type { SkillCandidate, SkillTrigger } from "../../intelligence/skill-types";
import type { StageRun, TrajectorySnapshot } from "../store";
import {
  LEARNING_EVAL_ARMS,
  LEARNING_EVAL_GOVERNANCE_VERSION,
  LEARNING_EVAL_REQUIRED_MODEL_CALL_TIMEOUT_MS,
  LEARNING_EVAL_REQUIRED_PAIRED_SEEDS,
  LEARNING_EVAL_REQUIRED_ROLLOUT_CAP_MS,
  LEARNING_EVAL_REQUIRED_SAMPLER,
  LEARNING_EVAL_REQUIRED_TOOL_BUNDLE,
  LEARNING_EVAL_SCHEMA_VERSION,
  LEARNING_EVAL_TRAINING_EVIDENCE_VERSION,
  computeBodyDigest,
  computeCandidateArtifactDigest,
  computeDigest,
  computeManifestHash,
  decodeLearningEvalManifest,
  stableStringify,
  validateLearningEvalManifest,
  type FrozenLearningEvalManifest,
  type LearningEvalArm,
  type LearningEvalBlockArmOrder,
  type LearningEvalHeldOutTask,
  type LearningEvalManifest,
  type LearningEvalModelIdentity,
  type LearningEvalPreflightPlan,
  type LearningEvalTrainingFixture,
} from "./learning-eval-types";

const ALL_TASK_TYPES: readonly TaskType[] = [
  "code_review",
  "debug",
  "refactor",
  "general",
  "plan",
  "research",
  "test",
  "docs",
];

/**
 * Frozen neutral-control trigger: matches every task type and every requirement
 * (empty requirement/signal filters mean "always"). The neutral body itself is
 * frozen in the manifest; only this mechanical trigger is fixed by source.
 */
const NEUTRAL_CONTROL_TRIGGER: SkillTrigger = {
  task_types: [...ALL_TASK_TYPES],
  requirements: [],
  signals: [],
};

const NEUTRAL_CONTROL_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Frozen rollout stage list + tool bundle name/contents for a manifest. */
const LEARNING_EVAL_ROLLOUT_STAGES = ["planner", "executor", "reviewer", "synthesizer"];
const LEARNING_EVAL_ROLLOUT_PROFILE = "full";
const LEARNING_EVAL_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
];

// ── Fixture hashing ─────────────────────────────────────────────

function canonicalFixturePayload(task: FixtureTask): string {
  return stableStringify({
    name: task.name,
    category: task.category,
    entry: task.entry,
    files: task.files,
    spec: task.spec,
    test: task.test,
    hiddenFile: task.hiddenFile ?? null,
  });
}

export function hashFixtureTask(task: FixtureTask): string {
  return computeDigest(canonicalFixturePayload(task));
}

export function expectedHeldOutFixtures(): LearningEvalHeldOutTask[] {
  return HELD_OUT_TASKS.map((task) => ({ name: task.name, fixtureDigest: hashFixtureTask(task) }));
}

export function expectedTrainingFixtures(): LearningEvalHeldOutTask[] {
  return TRAINING_TASKS.map((task) => ({ name: task.name, fixtureDigest: hashFixtureTask(task) }));
}

// ── Source binding digests ──────────────────────────────────────

/** Canonical digest of every checked-in fixture (training + held-out). */
export function computeFixtureSourceDigest(): string {
  return computeDigest(
    stableStringify([...TRAINING_TASKS, ...HELD_OUT_TASKS].map(canonicalFixturePayload)),
  );
}

/** Digest of the authentic held-out graded tests — the frozen oracle/rubric. */
export function computeRubricDigest(): string {
  return computeDigest(stableStringify(HELD_OUT_TASKS.map((task) => task.test)));
}

/**
 * Digest of the exact source that runs the independent oracle and computes the
 * descriptive report. It deliberately includes the oracle runner
 * (`orchestration/run-gate.ts`) and the narrow reward/scoring source
 * (`orchestration/run-reward.ts`) alongside the evaluator modules, so any
 * change that could move accepted-correctness invalidates comparability.
 */
export function computeAcceptanceCodeDigest(): string {
  const files: Array<[string, string]> = [
    ["rollout-runner.ts", join(import.meta.dir, "rollout-runner.ts")],
    ["paired-learning-evaluator.ts", join(import.meta.dir, "paired-learning-evaluator.ts")],
    ["learning-eval-types.ts", join(import.meta.dir, "learning-eval-types.ts")],
    ["orchestration/run-gate.ts", join(import.meta.dir, "..", "..", "orchestration", "run-gate.ts")],
    ["orchestration/run-reward.ts", join(import.meta.dir, "..", "..", "orchestration", "run-reward.ts")],
  ];
  const payload = files
    .map(([label, path]) => `${label}:${computeDigest(readFileSync(path, "utf8"))}`)
    .join("|");
  return computeDigest(payload);
}

export interface SourceBindingResult {
  ok: boolean;
  mismatches: string[];
}

export function validateSourceBindings(manifest: FrozenLearningEvalManifest): SourceBindingResult {
  const mismatches: string[] = [];
  if (manifest.fixtureSourceDigest !== computeFixtureSourceDigest()) mismatches.push("fixtureSourceDigest");
  if (manifest.rubricDigest !== computeRubricDigest()) mismatches.push("rubricDigest");
  if (manifest.acceptanceCodeDigest !== computeAcceptanceCodeDigest()) mismatches.push("acceptanceCodeDigest");
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Resolve a declared training fixture by name. A held-out name is refused
 * explicitly — held-out fixtures must never be reachable from candidate
 * generation.
 */
export function resolveTrainingFixture(ref: LearningEvalTrainingFixture): FixtureTask {
  const heldOut = HELD_OUT_TASKS.find((task) => task.name === ref.name);
  if (heldOut) {
    throw new Error(`refusing to train on held-out fixture "${ref.name}"`);
  }
  const task = TRAINING_TASKS.find((candidate) => candidate.name === ref.name);
  if (!task) throw new Error(`unknown training fixture "${ref.name}"`);
  if (hashFixtureTask(task) !== ref.fixtureDigest) {
    throw new Error(`training fixture digest mismatch for "${ref.name}"`);
  }
  return task;
}

// ── Local model identity pin (loopback-only, artifact-digest bound) ──

export interface PinnedModelIdentity {
  name: string;
  /** Immutable `/api/tags` artifact digest (`sha256:<hex>`). */
  digest: string;
  /** Ollama *server* version from `/api/version`; distinct from the artifact. */
  serverVersion: string | null;
  baseUrl: string;
  supportsNativeTools: boolean;
}

export type PinnedModelIdentityResult =
  | { ok: true; identity: PinnedModelIdentity }
  | {
      ok: false;
      code:
        | "unreachable"
        | "non_loopback"
        | "model_not_installed"
        | "mixed_model_identity"
        | "model_digest_mismatch"
        | "server_version_mismatch";
      detail: string;
    };

function normalizedModelName(value: string): string {
  return value.trim().toLowerCase().replace(/:latest$/, "");
}

/**
 * Normalize an installed model digest to canonical `sha256:<hex>`. Ollama's
 * `/api/tags` digest is normally already prefixed, but a bare 64-hex value is
 * accepted and canonicalized so the frozen pin is unambiguous.
 */
function normalizeInstalledDigest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Loopback-only Ollama base-url candidates. A configured non-loopback base url
 * is dropped entirely (never probed) so the evaluation can only ever reach the
 * local daemon.
 */
export function loopbackOllamaCandidates(cfg: JarvisConfig): string[] {
  const urls: string[] = [];
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    const cleaned = raw.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    try {
      if (isLoopbackHost(new URL(cleaned).hostname)) urls.push(cleaned);
    } catch {
      // Malformed configured url: ignore; the standard loopback candidates remain.
    }
  };
  push(cfg.ollama?.base_url);
  urls.push("http://127.0.0.1:11434", "http://localhost:11434");
  return [...new Set(urls)];
}

async function probeSupportsNativeTools(
  fetchFn: typeof fetch,
  baseUrl: string,
  modelName: string,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetchFn(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const json = (await res.json()) as { capabilities?: string[] };
    return Array.isArray(json.capabilities) && json.capabilities.includes("tools");
  } catch {
    return false;
  }
}

export interface InstalledLoopbackModel {
  name: string;
  digest: string;
  serverVersion: string | null;
  baseUrl: string;
  supportsNativeTools: boolean;
}

export type InstalledLoopbackModelResult =
  | { ok: true; model: InstalledLoopbackModel }
  | { ok: false; code: "unreachable" | "non_loopback" | "model_not_installed" | "missing_model_digest"; detail: string };

/**
 * Resolve the requested model against a loopback Ollama `/api/tags` listing and
 * require an installed artifact digest. Only `/api/tags`, `/api/show`, and
 * `/api/version` are issued — never a chat completion. Used both to freeze a
 * candidate manifest and to pin one during preflight.
 */
export async function resolveInstalledLoopbackModel(
  cfg: JarvisConfig,
  desiredModel: string,
  deps: OllamaTransportDeps = {},
): Promise<InstalledLoopbackModelResult> {
  const fetchFn = deps.fetch ?? fetch;
  const candidates = loopbackOllamaCandidates(cfg);
  if (candidates.length === 0) {
    return { ok: false, code: "non_loopback", detail: "no loopback Ollama endpoint configured" };
  }
  const wanted = normalizedModelName(desiredModel);
  const tried: string[] = [];
  for (const baseUrl of candidates) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3000);
      const tagsResp = await fetchFn(`${baseUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!tagsResp.ok) {
        tried.push(`${baseUrl} -> HTTP ${tagsResp.status}`);
        continue;
      }
      const tagsJson = (await tagsResp.json()) as {
        models?: Array<{ name?: string; model?: string; digest?: string }>;
      };
      const models = tagsJson.models ?? [];
      const match = models.find(
        (entry) => normalizedModelName(entry.name ?? entry.model ?? "") === wanted,
      );
      if (!match) {
        tried.push(`${baseUrl} -> ${desiredModel} not installed`);
        continue;
      }
      const name = match.name ?? match.model ?? desiredModel;
      const digest = normalizeInstalledDigest(match.digest);
      if (!digest) {
        return { ok: false, code: "missing_model_digest", detail: name };
      }
      const supportsNativeTools = await probeSupportsNativeTools(fetchFn, baseUrl, name);
      const serverVersion = await readOllamaVersion(baseUrl, deps);
      return { ok: true, model: { name, digest, serverVersion, baseUrl, supportsNativeTools } };
    } catch (error) {
      tried.push(`${baseUrl} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ok: false,
    code: "unreachable",
    detail: `loopback Ollama unreachable or model absent (tried: ${tried.join("; ")})`,
  };
}

/**
 * Prove the live installed model matches the frozen manifest. The immutable
 * model artifact digest (`/api/tags`) is compared directly; the Ollama server
 * version (`/api/version`) is a separate, optional server-identity check. A
 * non-loopback endpoint can never satisfy the pin.
 */
export async function resolvePinnedModelIdentity(
  manifest: FrozenLearningEvalManifest,
  cfg: JarvisConfig,
  deps: OllamaTransportDeps = {},
): Promise<PinnedModelIdentityResult> {
  const resolved = await resolveInstalledLoopbackModel(cfg, manifest.model.name, deps);
  if (!resolved.ok) {
    if (resolved.code === "unreachable") return { ok: false, code: "unreachable", detail: resolved.detail };
    if (resolved.code === "non_loopback") return { ok: false, code: "non_loopback", detail: resolved.detail };
    if (resolved.code === "missing_model_digest") return { ok: false, code: "model_not_installed", detail: resolved.detail };
    return { ok: false, code: "model_not_installed", detail: resolved.detail };
  }
  const installed = resolved.model;
  if (normalizedModelName(installed.name) !== normalizedModelName(manifest.model.name)) {
    return { ok: false, code: "mixed_model_identity", detail: `${installed.name} != ${manifest.model.name}` };
  }
  if (manifest.model.digest !== installed.digest) {
    return {
      ok: false,
      code: "model_digest_mismatch",
      detail: `live=${installed.digest} frozen=${manifest.model.digest}`,
    };
  }
  if (manifest.model.baseUrl !== installed.baseUrl) {
    return {
      ok: false,
      code: "mixed_model_identity",
      detail: `baseUrl live=${installed.baseUrl} frozen=${manifest.model.baseUrl}`,
    };
  }
  if (manifest.model.supportsNativeTools !== installed.supportsNativeTools) {
    return {
      ok: false,
      code: "mixed_model_identity",
      detail: `supportsNativeTools ${installed.supportsNativeTools} != ${manifest.model.supportsNativeTools}`,
    };
  }
  if (manifest.model.version !== undefined && manifest.model.version !== (installed.serverVersion ?? "")) {
    return {
      ok: false,
      code: "server_version_mismatch",
      detail: `Ollama server live=${installed.serverVersion ?? "(unknown)"} frozen=${manifest.model.version}`,
    };
  }
  return {
    ok: true,
    identity: {
      name: installed.name,
      digest: installed.digest,
      serverVersion: installed.serverVersion,
      baseUrl: installed.baseUrl,
      supportsNativeTools: installed.supportsNativeTools,
    },
  };
}

/**
 * Build the single frozen local CallModelFn used by every arm. It pins the
 * exact frozen loopback base url, model name, and installed artifact digest via
 * a fixed-target resolver (no fallback to configured remote urls, effective host
 * IP, another daemon, another model, or a changed digest), and forces the frozen
 * `top_p`, `num_ctx`, and per-model-call deadline. `temperature`/`num_predict`
 * are additionally forced by `runOneRollout`'s wrapper. All three arms share
 * this exact function.
 */
export function makeFrozenArmCallModel(
  manifest: FrozenLearningEvalManifest,
  cfg: JarvisConfig,
  deps: OllamaTransportDeps = {},
): ReturnType<typeof makeLocalCallModel> {
  const frozenCfg: JarvisConfig = {
    ...cfg,
    temperature: manifest.sampler.temperature,
    top_p: manifest.sampler.top_p,
    max_tokens: manifest.sampler.num_predict,
  };
  return makeLocalCallModel(frozenCfg, {
    num_ctx: manifest.sampler.num_ctx,
    timeoutMs: manifest.budgets.modelCallTimeoutMs,
    fixedTarget: {
      baseUrl: manifest.model.baseUrl,
      model: manifest.model.name,
      digest: manifest.model.digest,
      supportsNativeTools: manifest.model.supportsNativeTools,
    },
    deps,
  });
}

// ── Training fixture → frozen candidate ─────────────────────────

/** Frozen neutral-control body. Only this body is fixed by source. */
export const NEUTRAL_CONTROL_BODY =
  "Neutral control: no task-specific guidance is applied for this arm.";

/**
 * The complete neutral-control candidate that is frozen into the manifest. It is
 * built here (never in the campaign path) so the artifact digest is fixed at
 * freeze time; the campaign reconstructs and validates this exact object.
 */
export function createNeutralSkillCandidate(): SkillCandidate {
  return {
    id: "neutral-control",
    name: "neutral-control",
    description: "Frozen neutral control skill for the paired transfer study",
    trigger: { ...NEUTRAL_CONTROL_TRIGGER, task_types: [...NEUTRAL_CONTROL_TRIGGER.task_types] },
    body: NEUTRAL_CONTROL_BODY,
    source_run_ids: [],
    confidence: 0,
    status: "candidate",
    lifecycle_version: 0,
    created_at: NEUTRAL_CONTROL_TIMESTAMP,
    updated_at: NEUTRAL_CONTROL_TIMESTAMP,
  };
}

export interface AcquireTrainingCandidateOptions {
  campaignId: string;
  trainingFixture: LearningEvalTrainingFixture;
  trainingSeed: number;
  taskType: TaskType;
  distillation: SkillDistillationConfig;
  /** Frozen sampler to force on the training rollout, when declared. */
  sampler?: RolloutSamplerSpec;
  /** Frozen deadlines to force on the training rollout, when declared. */
  budgets?: RolloutBudgetSpec;
}

export interface TrainingCandidateEvidence {
  /** Terminal training-run outcome; only `success` ever produces evidence. */
  runOutcome: "success";
  trainingFixture: LearningEvalTrainingFixture;
  trajectory: { agentRunId: string; sessionId: string; digest: string };
  candidate: SkillCandidate;
  oracle: { tier: string; ran: boolean; passed: boolean | null; detail: string };
  stageRunCount: number;
  modelCalls: number | null;
}

export type TrainingCandidateAcquisitionErrorCode =
  | "fixture_not_trainable"
  | "run_failed"
  | "oracle_unavailable"
  | "oracle_not_passed"
  | "trajectory_unavailable"
  | "distillation_failed"
  | "candidate_invalid"
  | "candidate_sourceless";

export type TrainingCandidateAcquisitionResult =
  | { ok: true; evidence: TrainingCandidateEvidence }
  | { ok: false; code: TrainingCandidateAcquisitionErrorCode; detail: string };

function snapshotJsonFromStages(
  agentRunId: string,
  sessionId: string,
  taskType: TaskType,
  userRequest: string,
  runOutcome: "success" | "degraded" | "failed",
  stages: readonly StageRun[],
): string {
  return JSON.stringify({
    version: 1,
    agent_run_id: agentRunId,
    session_id: sessionId,
    task_type: taskType,
    run_outcome: runOutcome,
    worker_instructions: {},
    user_request: userRequest,
    stage_runs: stages.map((stage) => ({
      id: stage.id,
      agent_run_id: stage.agent_run_id,
      mode_id: stage.mode_id,
      turn_number: stage.turn_number,
      was_successful: stage.was_successful,
      had_error: stage.had_error,
      ...(typeof stage.tool_calls_json === "string" ? { tool_calls_json: stage.tool_calls_json } : {}),
    })),
  });
}

/**
 * Run one declared synthetic training fixture, capture its real in-memory
 * trajectory and authentic oracle outcome, and derive a candidate with the
 * existing distiller at `persist: false`. Anything failed, unaccepted,
 * malformed, unsupported, or source-less is rejected — never repaired.
 */
export async function acquireTrainingCandidate(
  opts: AcquireTrainingCandidateOptions,
  callModel: CallModelFn,
): Promise<TrainingCandidateAcquisitionResult> {
  let task: FixtureTask;
  try {
    task = resolveTrainingFixture(opts.trainingFixture);
  } catch (error) {
    return { ok: false, code: "fixture_not_trainable", detail: error instanceof Error ? error.message : String(error) };
  }

  const outcome = await runOneRollout(
    {
      theta: BASELINE_THETA,
      task,
      seed: opts.trainingSeed,
      captureStageRuns: true,
      ...(opts.sampler ? { sampler: opts.sampler } : {}),
      ...(opts.budgets ? { budgets: opts.budgets } : {}),
    },
    callModel,
  );

  // Distillation is accepted only from a training rollout whose terminal
  // outcome is exactly `success`. Partial/degraded/failed/cancelled evidence is
  // rejected rather than repaired — this is the frozen train/held-out boundary.
  if (outcome.runOutcome !== "success") {
    return {
      ok: false,
      code: "run_failed",
      detail: `training rollout runOutcome=${outcome.runOutcome ?? "(none)"}${outcome.error ? `: ${outcome.error}` : ""}`,
    };
  }
  if (!outcome.gradedCheck || !outcome.gradedCheck.ran) {
    return {
      ok: false,
      code: "oracle_unavailable",
      detail: outcome.error ?? outcome.gradedCheck?.declinedReason ?? "authentic oracle did not run",
    };
  }
  if (outcome.gradedCheck.passed !== true) {
    return { ok: false, code: "oracle_not_passed", detail: outcome.gradedCheck.detail || "authentic oracle failed" };
  }
  const stages = outcome.stageRuns ?? [];
  if (stages.length === 0) {
    return { ok: false, code: "trajectory_unavailable", detail: outcome.error ?? "no captured stage runs" };
  }

  const agentRunId = rolloutRunId(task.name, opts.trainingSeed);
  const sessionId = `eval-training:${opts.campaignId}:${task.name}:${opts.trainingSeed}`;
  const runOutcome = "success";
  const userRequest = buildFixtureRolloutRequest(task);
  const snapshotJson = snapshotJsonFromStages(agentRunId, sessionId, opts.taskType, userRequest, runOutcome, stages);
  const snapshot: TrajectorySnapshot = {
    id: `traj-${agentRunId}`,
    agent_run_id: agentRunId,
    session_id: sessionId,
    snapshot_json: snapshotJson,
  };

  const candidate = distillFromTrajectorySnapshot({ snapshot, config: opts.distillation }, { persist: false });
  if (!candidate) {
    return { ok: false, code: "distillation_failed", detail: `${runOutcome} trajectory produced no candidate` };
  }
  const validated = validateSkillCandidate(candidate);
  if (!validated.ok) {
    return { ok: false, code: "candidate_invalid", detail: validated.reason };
  }
  if (validated.candidate.body.trim().length === 0 || validated.candidate.source_run_ids.length === 0) {
    return { ok: false, code: "candidate_sourceless", detail: candidate.id };
  }
  // Source lineage must point exactly at the training run/session — not at any
  // other run, session, or empty placeholder.
  if (!validated.candidate.source_run_ids.includes(agentRunId)) {
    return { ok: false, code: "candidate_sourceless", detail: `missing source run ${agentRunId}` };
  }
  if (
    validated.candidate.source_session_id !== undefined &&
    validated.candidate.source_session_id !== sessionId
  ) {
    return {
      ok: false,
      code: "candidate_sourceless",
      detail: `source session ${validated.candidate.source_session_id} != ${sessionId}`,
    };
  }

  return {
    ok: true,
    evidence: {
      runOutcome,
      trainingFixture: opts.trainingFixture,
      trajectory: { agentRunId, sessionId, digest: computeDigest(stableStringify(JSON.parse(snapshotJson))) },
      candidate: validated.candidate,
      oracle: {
        tier: outcome.gradedCheck.tier,
        ran: outcome.gradedCheck.ran,
        passed: outcome.gradedCheck.passed,
        detail: outcome.gradedCheck.detail,
      },
      stageRunCount: stages.length,
      modelCalls: outcome.telemetry?.modelCalls ?? null,
    },
  };
}

/**
 * Verify a manifest's frozen candidate/neutral artifacts in-process before any
 * held-out arm runs. The full `SkillCandidate` is reconstructed from the frozen
 * artifact, revalidated, and its canonical full-artifact digest recomputed. The
 * candidate lineage must bind exactly to the frozen training trajectory.
 * Throws on any drift — this is the campaign's "execute only what was frozen"
 * boundary and it never issues a training-fixture model call.
 */
export function assertFrozenCandidateArtifacts(manifest: LearningEvalManifest): void {
  for (const [label, artifact] of [
    ["candidate", manifest.candidate],
    ["neutral", manifest.neutral],
  ] as const) {
    const validated = validateSkillCandidate(artifact.candidate);
    if (!validated.ok) {
      throw new Error(`frozen ${label} is not a valid skill candidate`);
    }
    if (computeCandidateArtifactDigest(artifact.candidate) !== artifact.artifactDigest) {
      throw new Error(`frozen ${label} artifact digest mismatch`);
    }
  }
  if (!manifest.candidate.candidate.source_run_ids.includes(manifest.trainingTrajectory.agentRunId)) {
    throw new Error(
      `frozen candidate lineage does not include training run ${manifest.trainingTrajectory.agentRunId}`,
    );
  }
  if (
    manifest.candidate.candidate.source_session_id !== undefined &&
    manifest.candidate.candidate.source_session_id !== manifest.trainingTrajectory.sessionId
  ) {
    throw new Error(
      `frozen candidate source session ${manifest.candidate.candidate.source_session_id} != ${manifest.trainingTrajectory.sessionId}`,
    );
  }
}

// ── Outcome rows ────────────────────────────────────────────────

export interface PairedOutcomeRow {
  campaignId: string;
  manifestHash: string;
  task: string;
  fixtureDigest: string;
  seed: number;
  arm: LearningEvalArm;
  agentRunId: string;
  appliedSkillId: string | null;
  appliedSkillDigest: string | null;
  appliedSkillMatched: boolean | null;
  appliedSkillPromptTokens: number | null;
  oracleTier: string | null;
  oracleRan: boolean | null;
  oraclePassed: boolean | null;
  acceptedCorrectness: boolean | null;
  reward: number | null;
  rewardBreakdown: RunRewardBreakdown | null;
  rewardHardZero: boolean | null;
  /** True only when a verified target-path write was credited. */
  verifiedTargetWrite: boolean | null;
  creditedWritePaths: string[];
  durationMs: number | null;
  modelCalls: number | null;
  toolErrors: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  tokenMissingReason: string | null;
  timeout: boolean | null;
  cancelled: boolean | null;
  stageDurationMs: number | null;
  runOutcome: string | null;
  error: string | null;
  telemetryMissingReason: string | null;
}

export function outcomeKey(row: Pick<PairedOutcomeRow, "campaignId" | "manifestHash" | "task" | "seed" | "arm">): string {
  return `${row.campaignId}|${row.manifestHash}|${row.task}|${row.seed}|${row.arm}`;
}

function plannedRowKey(
  manifest: FrozenLearningEvalManifest,
  task: string,
  seed: number,
  arm: LearningEvalArm,
): { campaignId: string; manifestHash: string; task: string; seed: number; arm: LearningEvalArm } {
  return { campaignId: manifest.campaignId, manifestHash: manifest.manifestHash, task, seed, arm };
}

function outcomeRowFromRollout(
  manifest: FrozenLearningEvalManifest,
  fixture: LearningEvalHeldOutTask,
  seed: number,
  arm: LearningEvalArm,
  outcome: RolloutOutcome,
): PairedOutcomeRow {
  const telemetry = outcome.telemetry;
  const oracle = outcome.gradedCheck;
  const acceptedCorrectness = oracle ? (oracle.ran ? oracle.passed === true : null) : null;
  return {
    campaignId: manifest.campaignId,
    manifestHash: manifest.manifestHash,
    task: fixture.name,
    fixtureDigest: fixture.fixtureDigest,
    seed,
    arm,
    agentRunId: rolloutRunId(fixture.name, seed),
    appliedSkillId: outcome.appliedSkill?.id ?? null,
    appliedSkillDigest: outcome.appliedSkill?.bodyDigest ?? null,
    appliedSkillMatched: outcome.appliedSkill?.matched ?? null,
    appliedSkillPromptTokens: outcome.appliedSkill?.promptTokens ?? null,
    oracleTier: oracle?.tier ?? null,
    oracleRan: oracle?.ran ?? null,
    oraclePassed: oracle?.passed ?? null,
    acceptedCorrectness,
    reward: outcome.reward,
    rewardBreakdown: outcome.breakdown,
    rewardHardZero: outcome.breakdown.hardZero,
    verifiedTargetWrite: outcome.breakdown.hardZero
      ? false
      : outcome.breakdown.creditedWritePaths.length > 0,
    creditedWritePaths: [...outcome.breakdown.creditedWritePaths],
    durationMs: outcome.durationMs,
    modelCalls: telemetry?.modelCalls ?? null,
    toolErrors: telemetry?.toolErrors ?? null,
    tokenInput: telemetry?.tokenInput ?? null,
    tokenOutput: telemetry?.tokenOutput ?? null,
    tokenMissingReason:
      telemetry?.tokenMissingReason ?? (telemetry ? null : "rollout ended before telemetry was captured"),
    timeout: telemetry?.timeout ?? null,
    cancelled: telemetry?.cancelled ?? null,
    stageDurationMs: telemetry?.stageDurationMs ?? null,
    runOutcome: outcome.runOutcome ?? null,
    error: outcome.error ?? null,
    telemetryMissingReason: telemetry ? null : "rollout ended before telemetry was captured",
  };
}

/**
 * Durable failure row for one scheduled arm whose execution threw. It keeps the
 * arm in the denominator with every measurement explicitly unavailable, rather
 * than letting a single throwing arm abort the campaign and drop later rows.
 */
export function failureOutcomeRow(
  manifest: FrozenLearningEvalManifest,
  fixture: LearningEvalHeldOutTask,
  seed: number,
  arm: LearningEvalArm,
  message: string,
): PairedOutcomeRow {
  return {
    campaignId: manifest.campaignId,
    manifestHash: manifest.manifestHash,
    task: fixture.name,
    fixtureDigest: fixture.fixtureDigest,
    seed,
    arm,
    agentRunId: rolloutRunId(fixture.name, seed),
    appliedSkillId: null,
    appliedSkillDigest: null,
    appliedSkillMatched: null,
    appliedSkillPromptTokens: null,
    oracleTier: null,
    oracleRan: null,
    oraclePassed: null,
    acceptedCorrectness: null,
    reward: null,
    rewardBreakdown: null,
    rewardHardZero: null,
    verifiedTargetWrite: null,
    creditedWritePaths: [],
    durationMs: null,
    modelCalls: null,
    toolErrors: null,
    tokenInput: null,
    tokenOutput: null,
    tokenMissingReason: "arm threw before telemetry was captured",
    timeout: null,
    cancelled: null,
    stageDurationMs: null,
    runOutcome: null,
    error: message,
    telemetryMissingReason: "arm threw before telemetry was captured",
  };
}

// ── Append-only JSONL ───────────────────────────────────────────

const OUTCOME_ROW_KEYS: readonly (keyof PairedOutcomeRow)[] = [
  "campaignId",
  "manifestHash",
  "task",
  "fixtureDigest",
  "seed",
  "arm",
  "agentRunId",
  "appliedSkillId",
  "appliedSkillDigest",
  "appliedSkillMatched",
  "appliedSkillPromptTokens",
  "oracleTier",
  "oracleRan",
  "oraclePassed",
  "acceptedCorrectness",
  "reward",
  "rewardBreakdown",
  "rewardHardZero",
  "verifiedTargetWrite",
  "creditedWritePaths",
  "durationMs",
  "modelCalls",
  "toolErrors",
  "tokenInput",
  "tokenOutput",
  "tokenMissingReason",
  "timeout",
  "cancelled",
  "stageDurationMs",
  "runOutcome",
  "error",
  "telemetryMissingReason",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullOrString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullOrNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullOrBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

/**
 * Strictly validate one outcome row: exact key set, correct types, and a valid
 * arm/identity. Unknown, missing, mistyped, or malformed rows are rejected.
 */
export function validateOutcomeRow(value: unknown): PairedOutcomeRow {
  if (!isRecord(value)) throw new Error("outcome row is not an object");
  for (const key of Object.keys(value)) {
    if (!(OUTCOME_ROW_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unexpected outcome row field "${key}"`);
    }
  }
  for (const key of OUTCOME_ROW_KEYS) {
    if (!(key in value)) throw new Error(`missing outcome row field "${key}"`);
  }
  for (const key of ["campaignId", "manifestHash", "task", "fixtureDigest", "agentRunId"] as const) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
      throw new Error(`invalid outcome row field "${key}"`);
    }
  }
  if (!Number.isSafeInteger(value.seed) || (value.seed as number) < 0) {
    throw new Error('invalid outcome row field "seed"');
  }
  if (value.arm !== "baseline" && value.arm !== "candidate" && value.arm !== "neutral") {
    throw new Error('invalid outcome row field "arm"');
  }
  for (const key of [
    "appliedSkillId",
    "appliedSkillDigest",
    "oracleTier",
    "tokenMissingReason",
    "runOutcome",
    "error",
    "telemetryMissingReason",
  ] as const) {
    if (!isNullOrString(value[key])) throw new Error(`invalid outcome row field "${key}"`);
  }
  for (const key of [
    "appliedSkillPromptTokens",
    "reward",
    "durationMs",
    "modelCalls",
    "toolErrors",
    "tokenInput",
    "tokenOutput",
    "stageDurationMs",
  ] as const) {
    if (!isNullOrNumber(value[key])) throw new Error(`invalid outcome row field "${key}"`);
  }
  for (const key of [
    "appliedSkillMatched",
    "oracleRan",
    "oraclePassed",
    "acceptedCorrectness",
    "rewardHardZero",
    "verifiedTargetWrite",
    "timeout",
    "cancelled",
  ] as const) {
    if (!isNullOrBoolean(value[key])) throw new Error(`invalid outcome row field "${key}"`);
  }
  if (!Array.isArray(value.creditedWritePaths) || !value.creditedWritePaths.every((p) => typeof p === "string")) {
    throw new Error('invalid outcome row field "creditedWritePaths"');
  }
  if (value.rewardBreakdown !== null && !isRecord(value.rewardBreakdown)) {
    throw new Error('invalid outcome row field "rewardBreakdown"');
  }
  return value as unknown as PairedOutcomeRow;
}

/**
 * Read and strictly validate an append-only JSONL outcome file. Malformed rows,
 * unknown/missing fields, and duplicate or conflicting keys are rejected.
 */
export function readOutcomeRows(path: string): PairedOutcomeRow[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const rows: PairedOutcomeRow[] = [];
  const seen = new Map<string, string>();
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`malformed outcome JSONL at ${path}:${index + 1}`);
    }
    const row = validateOutcomeRow(parsed);
    const key = outcomeKey(row);
    if (seen.has(key)) {
      const conflicting = seen.get(key) !== stableStringify(row);
      throw new Error(
        `${conflicting ? "conflicting" : "duplicate"} outcome row for key=${key} at ${path}:${index + 1}`,
      );
    }
    seen.set(key, stableStringify(row));
    rows.push(row);
  }
  return rows;
}

/**
 * Append rows, rejecting any duplicate/conflicting key. The key includes the
 * immutable manifest hash, so a re-frozen manifest cannot silently overwrite a
 * prior campaign's evidence.
 */
export function appendOutcomeRows(path: string, rows: readonly PairedOutcomeRow[]): void {
  if (rows.length === 0) return;
  const validated = rows.map(validateOutcomeRow);
  const existing = readOutcomeRows(path);
  const byKey = new Map<string, string>();
  for (const row of existing) byKey.set(outcomeKey(row), stableStringify(row));
  for (const row of validated) {
    const key = outcomeKey(row);
    if (byKey.has(key)) throw new Error(`duplicate outcome row for key=${key}`);
    byKey.set(key, stableStringify(row));
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, validated.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

export function plannedOutcomeKeys(
  manifest: FrozenLearningEvalManifest,
  plan: LearningEvalPreflightPlan,
): string[] {
  const keys: string[] = [];
  for (const block of plan.blocks) {
    for (const arm of block.armOrder) keys.push(outcomeKey(plannedRowKey(manifest, block.task, block.seed, arm)));
  }
  return keys;
}

export function detectMissingOutcomeKeys(
  manifest: FrozenLearningEvalManifest,
  plan: LearningEvalPreflightPlan,
  rows: readonly PairedOutcomeRow[],
): string[] {
  const observed = new Set(rows.map(outcomeKey));
  return plannedOutcomeKeys(manifest, plan).filter((key) => !observed.has(key));
}

export function detectUnexpectedOutcomeKeys(
  manifest: FrozenLearningEvalManifest,
  plan: LearningEvalPreflightPlan,
  rows: readonly PairedOutcomeRow[],
): string[] {
  const planned = new Set(plannedOutcomeKeys(manifest, plan));
  return rows.map(outcomeKey).filter((key) => !planned.has(key));
}

/**
 * Strict plan match: every row must belong to this exact campaign/manifest and
 * map to a scheduled arm key, and no key may repeat. Called before report
 * generation so a foreign or unexpected row cannot silently enter the artifact.
 */
export function assertOutcomeRowsMatchPlan(
  manifest: FrozenLearningEvalManifest,
  plan: LearningEvalPreflightPlan,
  rows: readonly PairedOutcomeRow[],
): void {
  const planned = new Set(plannedOutcomeKeys(manifest, plan));
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.campaignId !== manifest.campaignId || row.manifestHash !== manifest.manifestHash) {
      throw new Error(`outcome row belongs to a different campaign/manifest: ${outcomeKey(row)}`);
    }
    const key = outcomeKey(row);
    if (seen.has(key)) throw new Error(`duplicate outcome row: ${key}`);
    seen.add(key);
    if (!planned.has(key)) throw new Error(`unexpected outcome row: ${key}`);
  }
}

// ── Store isolation ─────────────────────────────────────────────

/**
 * Point the skill-candidate store at an isolated directory for the duration of
 * `fn`. This is the evaluation's "no production stores" guard: the resolver may
 * list promoted candidates, but during a campaign it can only see this empty
 * root plus the explicitly injected skill. The previous override is restored.
 */
export async function withIsolatedSkillStore<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const globalState = globalThis as { __skillCandidatesDirOverride?: string };
  const previous = globalState.__skillCandidatesDirOverride;
  mkdirSync(root, { recursive: true });
  globalState.__skillCandidatesDirOverride = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete globalState.__skillCandidatesDirOverride;
    else globalState.__skillCandidatesDirOverride = previous;
  }
}

export function makeIsolatedSkillStoreRoot(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-learning-eval-store-"));
}

// ── Paired campaign ─────────────────────────────────────────────

function skillOverrideForArm(
  arm: LearningEvalArm,
  manifest: FrozenLearningEvalManifest,
  candidate: SkillCandidate,
  neutral: SkillCandidate,
): RolloutSkillOverride | undefined {
  if (arm === "baseline") return undefined;
  if (arm === "candidate") {
    return {
      arm: "candidate",
      skill: candidate,
      bodyDigest: computeBodyDigest(candidate.body),
      taskType: manifest.rollout.skillMatchTaskType,
    };
  }
  return {
    arm: "neutral",
    skill: neutral,
    bodyDigest: computeBodyDigest(neutral.body),
    taskType: manifest.rollout.skillMatchTaskType,
  };
}

export interface PairedLearningCampaignOptions {
  manifest: FrozenLearningEvalManifest;
  callModel: CallModelFn;
  /** Append-only JSONL path for per-arm outcome rows. */
  outcomePath: string;
  /** Explicit campaign authorization. Source/preflight work must pass false. */
  authorizeCampaign: boolean;
  /** Expected authentic held-out identity; defaults to the checked-in fixtures. */
  expectedHeldOut?: readonly LearningEvalHeldOutTask[];
  /** Injected for tests; defaults to a fresh temp dir. */
  skillStoreRoot?: string;
}

export interface PairedLearningCampaignResult {
  plan: LearningEvalPreflightPlan;
  rows: PairedOutcomeRow[];
  missingOutcomeKeys: string[];
  report: LearningEvalDescriptiveReport;
}

/**
 * Execute the frozen paired campaign. Requires an explicit authorization flag
 * and a manifest whose canonical hash matches its frozen `manifestHash`. The
 * campaign reconstructs and validates the full frozen candidate/neutral
 * artifacts and executes only held-out arms — it never acquires a training
 * candidate, retrains, or issues a training-fixture model call.
 */
export async function runPairedLearningCampaign(
  opts: PairedLearningCampaignOptions,
): Promise<PairedLearningCampaignResult> {
  if (!opts.authorizeCampaign) {
    throw new Error("paired learning campaign requires explicit authorization");
  }
  const manifest = opts.manifest;
  if (computeManifestHash(manifest) !== manifest.manifestHash) {
    throw new Error("manifest hash mismatch: refusing to run a mutated manifest");
  }
  const preflight = validateLearningEvalManifest(manifest, opts.expectedHeldOut ?? expectedHeldOutFixtures());
  if (!preflight.ok) {
    throw new Error(`manifest preflight failed (${preflight.code}): ${preflight.detail}`);
  }
  // Reconstruct and revalidate exactly the frozen full candidate/neutral
  // artifacts, including lineage against the frozen training evidence tuple.
  assertFrozenCandidateArtifacts(manifest);
  const candidate = manifest.candidate.candidate;
  const neutral = manifest.neutral.candidate;

  const fixtureByName = new Map(HELD_OUT_TASKS.map((task) => [task.name, task]));
  const storeRoot = opts.skillStoreRoot ?? makeIsolatedSkillStoreRoot();
  const rows: PairedOutcomeRow[] = [];
  // Every arm call shares these frozen sampler values and deadlines.
  const sampler: RolloutSamplerSpec = { ...manifest.sampler };
  const budgets: RolloutBudgetSpec = { ...manifest.budgets };

  await withIsolatedSkillStore(storeRoot, async () => {
    for (const block of preflight.plan.blocks) {
      const fixture = fixtureByName.get(block.task);
      if (!fixture) throw new Error(`held-out fixture disappeared: ${block.task}`);
      const fixtureIdentity: LearningEvalHeldOutTask = {
        name: fixture.name,
        fixtureDigest: hashFixtureTask(fixture),
      };
      for (const arm of block.armOrder) {
        // A thrown arm must never abort the campaign or drop later rows: it
        // becomes one durable failure row that keeps the arm in the denominator.
        let row: PairedOutcomeRow;
        try {
          const outcome = await runOneRollout(
            {
              theta: BASELINE_THETA,
              task: fixture,
              seed: block.seed,
              skillOverride: skillOverrideForArm(arm, manifest, candidate, neutral),
              // Capture bounded runtime evidence per arm (timeout/cancel/stage
              // durations). Serial execution keeps this bounded; rows retain only
              // derived fields, not the stage array.
              captureStageRuns: true,
              sampler,
              budgets,
            },
            opts.callModel,
          );
          row = outcomeRowFromRollout(manifest, fixtureIdentity, block.seed, arm, outcome);
        } catch (error) {
          row = failureOutcomeRow(
            manifest,
            fixtureIdentity,
            block.seed,
            arm,
            error instanceof Error ? error.message : String(error),
          );
        }
        appendOutcomeRows(opts.outcomePath, [row]);
        rows.push(row);
      }
    }
  });

  assertOutcomeRowsMatchPlan(manifest, preflight.plan, rows);
  const missingOutcomeKeys = detectMissingOutcomeKeys(manifest, preflight.plan, rows);
  const report = computeDescriptiveReport(manifest, preflight.plan, rows, missingOutcomeKeys);
  return { plan: preflight.plan, rows, missingOutcomeKeys, report };
}

// ── Descriptive report (no acceptance decision) ─────────────────

export interface ArmDescriptiveSummary {
  arm: LearningEvalArm;
  scheduled: number;
  completed: number;
  failures: number;
  accepted: number;
  acceptedRate: number | null;
  meanReward: number | null;
  medianDurationMs: number | null;
  p90DurationMs: number | null;
  totalModelCalls: number;
  totalToolErrors: number;
}

export interface PairedDelta {
  task: string;
  seed: number;
  baselineAccepted: boolean | null;
  candidateAccepted: boolean | null;
  neutralAccepted: boolean | null;
  candidateMinusBaseline: number | null;
  neutralMinusBaseline: number | null;
  candidateRewardMinusBaseline: number | null;
  neutralRewardMinusBaseline: number | null;
}

export interface LearningEvalDescriptiveReport {
  campaignId: string;
  manifestHash: string;
  generatedAt: string;
  /** Descriptive only — Phase 3 owns the gate. Never a pass/reject claim. */
  status: "descriptive_only" | "inconclusive_incomplete";
  plannedOutcomeCount: number;
  observedOutcomeCount: number;
  missingOutcomeCount: number;
  missingOutcomeKeys: string[];
  arms: ArmDescriptiveSummary[];
  pairs: PairedDelta[];
  pairedCandidateMinusBaselineMean: number | null;
  pairedNeutralMinusBaselineMean: number | null;
  pairedCandidateMinusBaselineVariability: number | null;
  pairedNeutralMinusBaselineVariability: number | null;
  sampleCount: number;
  failureCount: number;
  notes: string[];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function acceptedValue(row: PairedOutcomeRow): number | null {
  if (row.acceptedCorrectness === true) return 1;
  if (row.acceptedCorrectness === false) return 0;
  return null;
}

export function computeDescriptiveReport(
  manifest: FrozenLearningEvalManifest,
  plan: LearningEvalPreflightPlan,
  rows: readonly PairedOutcomeRow[],
  missingOutcomeKeys: readonly string[] = detectMissingOutcomeKeys(manifest, plan, rows),
): LearningEvalDescriptiveReport {
  const byKey = new Map<string, PairedOutcomeRow>();
  for (const row of rows) byKey.set(outcomeKey(row), row);

  const arms: ArmDescriptiveSummary[] = [];
  for (const arm of ["baseline", "candidate", "neutral"] as const) {
    const armRows = rows.filter((row) => row.arm === arm);
    const accepted = armRows.filter((row) => row.acceptedCorrectness === true).length;
    const anyMissing = armRows.some((row) => row.acceptedCorrectness === null);
    const durations = armRows
      .map((row) => row.durationMs)
      .filter((value): value is number => typeof value === "number");
    arms.push({
      arm,
      scheduled: plan.blocks.length,
      completed: armRows.length,
      failures: armRows.filter((row) => row.error !== null).length,
      accepted,
      acceptedRate: armRows.length === 0 || anyMissing ? null : accepted / armRows.length,
      meanReward: mean(armRows.map((row) => row.reward).filter((value): value is number => typeof value === "number")),
      medianDurationMs: median(durations),
      p90DurationMs: percentile(durations, 0.9),
      totalModelCalls: armRows.reduce((sum, row) => sum + (row.modelCalls ?? 0), 0),
      totalToolErrors: armRows.reduce((sum, row) => sum + (row.toolErrors ?? 0), 0),
    });
  }

  const pairs: PairedDelta[] = [];
  for (const block of plan.blocks) {
    const baseline = byKey.get(outcomeKey(plannedRowKey(manifest, block.task, block.seed, "baseline")));
    const candidate = byKey.get(outcomeKey(plannedRowKey(manifest, block.task, block.seed, "candidate")));
    const neutral = byKey.get(outcomeKey(plannedRowKey(manifest, block.task, block.seed, "neutral")));
    const baselineAccepted = baseline ? acceptedValue(baseline) : null;
    const candidateAccepted = candidate ? acceptedValue(candidate) : null;
    const neutralAccepted = neutral ? acceptedValue(neutral) : null;
    pairs.push({
      task: block.task,
      seed: block.seed,
      baselineAccepted: baseline?.acceptedCorrectness ?? null,
      candidateAccepted: candidate?.acceptedCorrectness ?? null,
      neutralAccepted: neutral?.acceptedCorrectness ?? null,
      candidateMinusBaseline:
        baselineAccepted === null || candidateAccepted === null ? null : candidateAccepted - baselineAccepted,
      neutralMinusBaseline:
        baselineAccepted === null || neutralAccepted === null ? null : neutralAccepted - baselineAccepted,
      candidateRewardMinusBaseline:
        baseline?.reward == null || candidate?.reward == null ? null : candidate.reward - baseline.reward,
      neutralRewardMinusBaseline:
        baseline?.reward == null || neutral?.reward == null ? null : neutral.reward - baseline.reward,
    });
  }

  const candidateDeltas = pairs
    .map((pair) => pair.candidateMinusBaseline)
    .filter((value): value is number => value !== null);
  const neutralDeltas = pairs
    .map((pair) => pair.neutralMinusBaseline)
    .filter((value): value is number => value !== null);

  const notes = [
    "Descriptive Phase 2 output only. No pass/reject/inconclusive decision is made here.",
    "Accepted correctness is derived solely from the authentic graded-fixture oracle; model wording and pipeline completion are ignored.",
    "Every scheduled arm is retained in the denominator, including failures and missing telemetry.",
    "No candidate was promoted, and no production store was written.",
  ];
  if (missingOutcomeKeys.length > 0) notes.push(`incomplete coverage: ${missingOutcomeKeys.length} scheduled row(s) missing`);

  return {
    campaignId: manifest.campaignId,
    manifestHash: manifest.manifestHash,
    generatedAt: new Date().toISOString(),
    status: missingOutcomeKeys.length > 0 ? "inconclusive_incomplete" : "descriptive_only",
    plannedOutcomeCount: plan.plannedOutcomeCount,
    observedOutcomeCount: rows.length,
    missingOutcomeCount: missingOutcomeKeys.length,
    missingOutcomeKeys: [...missingOutcomeKeys],
    arms,
    pairs,
    pairedCandidateMinusBaselineMean: mean(candidateDeltas),
    pairedNeutralMinusBaselineMean: mean(neutralDeltas),
    pairedCandidateMinusBaselineVariability: variance(candidateDeltas),
    pairedNeutralMinusBaselineVariability: variance(neutralDeltas),
    sampleCount: candidateDeltas.length,
    failureCount: rows.filter((row) => row.error !== null).length,
    notes,
  };
}

/** Render the descriptive report as Markdown evidence. Never claims benefit. */
export function renderDescriptiveReportMarkdown(report: LearningEvalDescriptiveReport): string {
  const lines: string[] = [
    `# Paired learning transfer — descriptive report`,
    "",
    `- campaign: ${report.campaignId}`,
    `- manifest hash: ${report.manifestHash}`,
    `- generated: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- planned outcomes: ${report.plannedOutcomeCount}`,
    `- observed outcomes: ${report.observedOutcomeCount}`,
    `- missing outcomes: ${report.missingOutcomeCount}`,
    `- candidate-baseline pairs with deltas: ${report.sampleCount}`,
    "",
    "## Accepted correctness by arm",
    "",
    "| arm | scheduled | completed | accepted | accepted rate | failures | mean reward | median ms | p90 ms | model calls | tool errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of report.arms) {
    lines.push(
      `| ${arm.arm} | ${arm.scheduled} | ${arm.completed} | ${arm.accepted} | ` +
        `${arm.acceptedRate === null ? "n/a" : arm.acceptedRate.toFixed(3)} | ${arm.failures} | ` +
        `${arm.meanReward === null ? "n/a" : arm.meanReward.toFixed(4)} | ` +
        `${arm.medianDurationMs === null ? "n/a" : Math.round(arm.medianDurationMs)} | ` +
        `${arm.p90DurationMs === null ? "n/a" : Math.round(arm.p90DurationMs)} | ` +
        `${arm.totalModelCalls} | ${arm.totalToolErrors} |`,
    );
  }
  lines.push(
    "",
    `Paired candidate-minus-baseline accepted delta mean: ${report.pairedCandidateMinusBaselineMean ?? "n/a"}`,
    `Paired neutral-minus-baseline accepted delta mean: ${report.pairedNeutralMinusBaselineMean ?? "n/a"}`,
    "",
    "## Notes",
    "",
  );
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

export function decodeFrozenManifest(value: unknown): FrozenLearningEvalManifest {
  const decoded = decodeLearningEvalManifest(value);
  if (!decoded.ok) {
    throw new Error(`invalid learning eval manifest (${decoded.code}${decoded.field ? `:${decoded.field}` : ""})`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.manifestHash !== "string" || raw.manifestHash.length === 0) {
    throw new Error("invalid learning eval manifest (missing manifestHash)");
  }
  const manifest = decoded.manifest;
  const computed = computeManifestHash(manifest);
  if (computed !== raw.manifestHash) {
    throw new Error(`learning eval manifest hash mismatch: expected ${raw.manifestHash}, recomputed ${computed}`);
  }
  return { ...manifest, manifestHash: raw.manifestHash };
}

// ── Candidate freeze path ───────────────────────────────────────

function deterministicArmOrder(campaignId: string, task: string, seed: number): LearningEvalArm[] {
  const digest = createHash("sha256").update(`${campaignId}|${task}|${seed}`, "utf8").digest();
  let state = digest.readUInt32BE(0) || 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const arms = [...LEARNING_EVAL_ARMS];
  for (let i = arms.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const tmp = arms[i]!;
    arms[i] = arms[j]!;
    arms[j] = tmp;
  }
  return arms;
}

/**
 * Build one deterministic-but-randomized arm permutation per held-out task +
 * seed block. Derived solely from the campaign id and the block identity, so
 * the permutation is reproducible from the manifest inputs yet differs between
 * blocks.
 */
export function buildBlockArmOrders(
  campaignId: string,
  tasks: readonly { name: string }[],
  seeds: readonly number[],
): LearningEvalBlockArmOrder[] {
  const blocks: LearningEvalBlockArmOrder[] = [];
  for (const task of tasks) {
    for (const seed of seeds) {
      blocks.push({ task: task.name, seed, armOrder: deterministicArmOrder(campaignId, task.name, seed) });
    }
  }
  return blocks;
}

export interface FreezeLearningEvalManifestInput {
  campaignId: string;
  baseSourceSha: string;
  trainingFixtureName: string;
  trainingSeed: number;
  pairedSeeds: number[];
  taskType: TaskType;
  /** Live, loopback-pinned model identity resolved before freezing. */
  model: LearningEvalModelIdentity;
  distillation?: SkillDistillationConfig;
}

/**
 * Practical candidate freeze path. Runs only the declared training fixture,
 * derives the candidate at `persist: false`, then assembles and hashes a full
 * manifest. No held-out fixture is read and no outcome file is touched, so the
 * candidate body/digest and the split are frozen before any transfer result can
 * exist. The caller writes the returned manifest.
 */
export async function freezeLearningEvalManifest(
  input: FreezeLearningEvalManifestInput,
  callModel: CallModelFn,
): Promise<FrozenLearningEvalManifest> {
  if (input.pairedSeeds.length !== LEARNING_EVAL_REQUIRED_PAIRED_SEEDS) {
    throw new Error(
      `freeze requires exactly ${LEARNING_EVAL_REQUIRED_PAIRED_SEEDS} paired seeds, got ${input.pairedSeeds.length}`,
    );
  }
  if (new Set(input.pairedSeeds).size !== input.pairedSeeds.length) {
    throw new Error("freeze requires unique paired seeds");
  }
  const trainingFixture = expectedTrainingFixtures().find((task) => task.name === input.trainingFixtureName);
  if (!trainingFixture) {
    throw new Error(`unknown or held-out training fixture "${input.trainingFixtureName}"`);
  }
  const heldOutTasks = expectedHeldOutFixtures();
  const pairedBlockCount = heldOutTasks.length * input.pairedSeeds.length;

  // Isolate the skill store for the training run: the distiller must never read
  // (or collide with) the production candidate store while freezing.
  const storeRoot = makeIsolatedSkillStoreRoot();
  let acquisition: TrainingCandidateAcquisitionResult;
  try {
    acquisition = await withIsolatedSkillStore(storeRoot, () =>
      acquireTrainingCandidate(
        {
          campaignId: input.campaignId,
          trainingFixture,
          trainingSeed: input.trainingSeed,
          taskType: input.taskType,
          distillation: input.distillation ?? defaultEvalDistillationConfig(),
          sampler: { ...LEARNING_EVAL_REQUIRED_SAMPLER },
          budgets: {
            modelCallTimeoutMs: LEARNING_EVAL_REQUIRED_MODEL_CALL_TIMEOUT_MS,
            rolloutTimeoutMs: LEARNING_EVAL_REQUIRED_ROLLOUT_CAP_MS,
          },
        },
        callModel,
      ),
    );
  } finally {
    removeIsolatedSkillStoreRoot(storeRoot);
  }
  if (!acquisition.ok) {
    throw new Error(`candidate freeze failed (${acquisition.code}): ${acquisition.detail}`);
  }
  const evidence = acquisition.evidence;

  // Freeze the COMPLETE validated candidate exactly as `validateSkillCandidate`
  // returned it, plus its canonical full-artifact digest. No id/body/source
  // reduction: every behavior and lineage field is part of the frozen artifact.
  const candidateArtifact = {
    candidate: evidence.candidate,
    artifactDigest: computeCandidateArtifactDigest(evidence.candidate),
  };
  const neutralCandidate = createNeutralSkillCandidate();
  const neutralValidated = validateSkillCandidate(neutralCandidate);
  if (!neutralValidated.ok) {
    throw new Error("frozen neutral control candidate failed validation");
  }
  const neutralArtifact = {
    candidate: neutralValidated.candidate,
    artifactDigest: computeCandidateArtifactDigest(neutralValidated.candidate),
  };

  const manifest: LearningEvalManifest = {
    schemaVersion: LEARNING_EVAL_SCHEMA_VERSION,
    governanceVersion: LEARNING_EVAL_GOVERNANCE_VERSION,
    campaignId: input.campaignId,
    baseSourceSha: input.baseSourceSha,
    fixtureSourceDigest: computeFixtureSourceDigest(),
    rubricDigest: computeRubricDigest(),
    acceptanceCodeDigest: computeAcceptanceCodeDigest(),
    trainingFixture,
    trainingSeed: input.trainingSeed,
    trainingTrajectory: { ...evidence.trajectory },
    // Frozen successful training-run + authentic-oracle receipt, produced ONLY
    // here from the acquisition result. A campaign never synthesizes these.
    trainingEvidence: {
      trainingEvidenceVersion: LEARNING_EVAL_TRAINING_EVIDENCE_VERSION,
      runOutcome: evidence.runOutcome,
      trainingFixture: { ...evidence.trainingFixture },
      trainingSeed: input.trainingSeed,
      trajectory: { ...evidence.trajectory },
      oracle: { ...evidence.oracle },
      stageRunCount: evidence.stageRunCount,
      modelCalls: evidence.modelCalls,
      candidateArtifactDigest: candidateArtifact.artifactDigest,
      candidateSourceRunIds: [...evidence.candidate.source_run_ids],
      candidateSourceSessionId: evidence.candidate.source_session_id ?? null,
    },
    candidate: candidateArtifact,
    neutral: neutralArtifact,
    heldOutTasks,
    model: { ...input.model },
    sampler: { ...LEARNING_EVAL_REQUIRED_SAMPLER },
    toolBundle: {
      name: LEARNING_EVAL_REQUIRED_TOOL_BUNDLE,
      tools: [...LEARNING_EVAL_TOOL_NAMES],
      network: false,
      delegates: false,
    },
    rollout: {
      executionProfile: LEARNING_EVAL_ROLLOUT_PROFILE,
      stages: [...LEARNING_EVAL_ROLLOUT_STAGES],
      skillMatchTaskType: input.taskType,
    },
    budgets: {
      modelCallTimeoutMs: LEARNING_EVAL_REQUIRED_MODEL_CALL_TIMEOUT_MS,
      rolloutTimeoutMs: LEARNING_EVAL_REQUIRED_ROLLOUT_CAP_MS,
    },
    pairedSeeds: [...input.pairedSeeds],
    blockArmOrders: buildBlockArmOrders(input.campaignId, heldOutTasks, input.pairedSeeds),
    plannedOutcomeCount: pairedBlockCount * LEARNING_EVAL_ARMS.length,
    pairedBlockCount,
  };
  // Never return a manifest that cannot pass its own structural preflight.
  const selfCheck = validateLearningEvalManifest(manifest, heldOutTasks);
  if (!selfCheck.ok) {
    throw new Error(`frozen manifest failed self-preflight (${selfCheck.code}): ${selfCheck.detail}`);
  }
  return { ...manifest, manifestHash: computeManifestHash(manifest) };
}

/** Canonical JSON for a frozen manifest, including its `manifestHash`. */
export function serializeFrozenManifest(manifest: FrozenLearningEvalManifest): string {
  return `${stableStringify(manifest)}\n`;
}

/** Write a frozen manifest as canonical, hashed JSON. */
export function writeFrozenManifest(path: string, manifest: FrozenLearningEvalManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeFrozenManifest(manifest), "utf8");
}

/** Default distillation config for the evaluator, derived from production config. */
export function defaultEvalDistillationConfig(): SkillDistillationConfig {
  return defaultConfig().orchestrator.skill_distillation;
}

export function loadFrozenManifestFile(path: string): FrozenLearningEvalManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return decodeFrozenManifest(parsed);
}

export function removeIsolatedSkillStoreRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
