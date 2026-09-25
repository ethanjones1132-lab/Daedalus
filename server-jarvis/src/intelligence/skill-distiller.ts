import { createHash } from "node:crypto";
import type { TaskType, WorkerInstructions } from "../orchestration/coordinator";
import type { StageRun } from "../self-tuning/store";
import type { TurnRequirement } from "../orchestration/turn-requirements";
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import type { SkillCandidate, SkillTrigger } from "./skill-types";
import { readSkillCandidate, saveSkillCandidate, pruneSkillCandidates } from "./skill-store";
import type { SkillDistillationConfig } from "../config";
import type { TrajectorySnapshot } from "../self-tuning/store";
import {
  computeSkillToolSequenceDigest,
  decodeSkillStageRuns,
  decodeSkillTrajectorySnapshot,
  type DecodedSkillStageEvidence,
} from "./skill-source-evidence";

export interface DistillationInput {
  agentRunId: string;
  sessionId: string;
  taskType: TaskType;
  userRequest: string;
  workerInstructions?: WorkerInstructions;
  stageRuns: StageRun[];
  runOutcome: "success" | "degraded" | "failed";
  /** Task-level acceptance gate. Undefined preserves legacy replay behavior. */
  taskRunAccepted?: boolean;
  /** Effective requirement inherited from a durable task run. */
  turnRequirement?: TurnRequirement;
}

/** Distillation from a stored trajectory snapshot (for audit/replay). */
export interface TrajectoryDistillationInput {
  snapshot: TrajectorySnapshot;
  config: SkillDistillationConfig;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "distilled-skill";
}

function buildSkillBody(input: DistillationInput, stages: readonly DecodedSkillStageEvidence[]): string {
  const blocks: string[] = [
    `# Distilled: ${input.taskType}`,
    "",
    "Learned from a successful orchestrator run. Reuse this guidance when triggers match.",
    "",
  ];

  if (input.workerInstructions) {
    blocks.push("## Conductor worker guidance");
    for (const [stage, text] of Object.entries(input.workerInstructions)) {
      if (text?.trim()) blocks.push(`### ${stage}\n${text.trim()}`);
    }
    blocks.push("");
  }

  const toolStages = stages.filter((stage) => stage.tool_names.length > 0);
  if (toolStages.length > 0) {
    blocks.push("## Successful tool usage pattern");
    for (const stage of toolStages) {
      const names = stage.tool_names.slice(0, 32);
      const suffix = stage.tool_names.length > names.length ? ", …" : "";
      blocks.push(`- ${stage.mode_id}: ${names.join(", ")}${suffix} on turn ${stage.turn_number}`);
    }
    blocks.push("");
  }

  blocks.push("## Request context (abbreviated)");
  blocks.push(input.userRequest.slice(0, 1200));

  return blocks.join("\n");
}

function computeConfidence(input: DistillationInput): number {
  // Baseline is outcome-dependent: success gets a 0.45 floor, degraded
  // (e.g., replan-rescued with a clean synthesizer) gets a 0.30 floor so it
  // can still clear a reasonable min_confidence gate when distill_on allows
  // it. Failed outcomes are excluded by the distill_on policy gate above
  // and never reach this function in practice, but the explicit return 0
  // is a belt-and-braces guard.
  if (input.runOutcome === "failed") return 0;
  let score = input.runOutcome === "success" ? 0.45 : 0.30;
  const stagesOk = input.stageRuns.filter((s) => s.was_successful === 1 && s.had_error === 0).length;
  const total = input.stageRuns.length || 1;
  score += (stagesOk / total) * 0.35;
  if (input.workerInstructions && Object.keys(input.workerInstructions).length > 0) score += 0.15;
  return Math.min(1, score);
}

export function buildSkillCandidate(
  input: DistillationInput,
  config: SkillDistillationConfig,
): SkillCandidate | null {
  if (!config.enabled) return null;
  if (input.taskRunAccepted === false) return null;

  const evidence = decodeSkillStageRuns(input.stageRuns, input.agentRunId);
  if (!evidence.ok) return null;

  const distillOn = config.distill_on ?? ["success"];
  if (!distillOn.includes(input.runOutcome)) return null;

  const confidence = computeConfidence(input);
  if (confidence < config.min_confidence) return null;

  const turnReq = input.turnRequirement
    ? { requirement: input.turnRequirement, signals: [`task_run_inherit:${input.turnRequirement}`] }
    : classifyTurnRequirements(input.userRequest);
  const trigger: SkillTrigger = {
    task_types: [input.taskType],
    requirements: [turnReq.requirement],
    signals: turnReq.signals.slice(0, 8),
  };

  const now = new Date().toISOString();
  const id = `skill_${slugify(input.taskType)}_${input.agentRunId.slice(-8)}`;
  return {
    id,
    name: `distilled-${input.taskType}-${input.agentRunId.slice(-6)}`,
    description: `Distilled orchestration pattern for ${input.taskType} (${turnReq.requirement})`,
    trigger,
    body: buildSkillBody(input, evidence.stages),
    tool_sequence_digest: computeSkillToolSequenceDigest(evidence.stages),
    source_run_ids: [input.agentRunId],
    source_session_id: input.sessionId,
    confidence,
    status: "candidate",
    created_at: now,
    updated_at: now,
  };
}

function candidateDigest(candidate: SkillCandidate): string {
  return createHash("sha256")
    .update(JSON.stringify({
      body: candidate.body,
      trigger: candidate.trigger,
      source_run_ids: candidate.source_run_ids,
      source_session_id: candidate.source_session_id ?? null,
      ...(candidate.tool_sequence_digest === undefined
        ? {}
        : { tool_sequence_digest: candidate.tool_sequence_digest }),
    }))
    .digest("hex")
    .slice(0, 12);
}

function rebuiltSkillCandidate(candidate: SkillCandidate, id: string, suffix: string): SkillCandidate {
  return {
    ...candidate,
    id,
    name: `${candidate.name}-r${suffix}`,
  };
}

function resolveRebuiltSkillCandidate(candidate: SkillCandidate): SkillCandidate {
  const digest = candidateDigest(candidate);
  const baseId = `${candidate.id}_r${digest}`;
  let id = baseId;
  let suffix = digest.slice(0, 8);
  let index = 0;
  while (true) {
    const existing = readSkillCandidate(id);
    if (!existing.ok) {
      if (existing.error === "candidate_not_found") return rebuiltSkillCandidate(candidate, id, suffix);
      index += 1;
      suffix = `${digest.slice(0, 8)}_${index}`;
      id = `${baseId}_${index}`;
      continue;
    }
    return existing.candidate;
  }
}

function resolveSkillCandidate(candidate: SkillCandidate): SkillCandidate {
  const existing = readSkillCandidate(candidate.id);
  if (!existing.ok) {
    return existing.error === "candidate_not_found" ? candidate : resolveRebuiltSkillCandidate(candidate);
  }
  if (existing.candidate.status === "candidate") return candidate;
  return resolveRebuiltSkillCandidate(candidate);
}

function persistSkillCandidate(candidate: SkillCandidate): SkillCandidate {
  const resolved = resolveSkillCandidate(candidate);
  if (resolved.id === candidate.id) {
    saveSkillCandidate(candidate);
    return candidate;
  }
  const existing = readSkillCandidate(resolved.id);
  if (!existing.ok) {
    saveSkillCandidate(resolved);
    return resolved;
  }
  return existing.candidate;
}

export function distillSkillCandidate(
  input: DistillationInput,
  config: SkillDistillationConfig,
): SkillCandidate | null {
  const candidate = buildSkillCandidate(input, config);
  if (!candidate) return null;
  const persisted = persistSkillCandidate(candidate);
  pruneSkillCandidates(config.max_candidates);
  return persisted;
}

/** Distill a skill candidate from a stored trajectory snapshot (C-01 hardening).
 *  Used for audit/replay: e.g., CLI `bun run src/intelligence/redistill.ts --agent-run-id=...` */
export interface TrajectoryDistillationOptions {
  persist?: boolean;
}

export function distillFromTrajectorySnapshot(
  input: TrajectoryDistillationInput,
  options: TrajectoryDistillationOptions = {},
): SkillCandidate | null {
  const { snapshot, config } = input;
  if (!config.enabled) return null;

  const decoded = decodeSkillTrajectorySnapshot(snapshot);
  if (!decoded.ok) return null;
  const traj = decoded.trajectory;
  if (traj.run_outcome !== "success") return null;

  const distillOn = config.distill_on ?? ["success"];
  if (!distillOn.includes(traj.run_outcome)) return null;

  const candidate = buildSkillCandidate(
    {
      agentRunId: traj.agent_run_id,
      sessionId: traj.session_id,
      taskType: traj.task_type,
      userRequest: traj.user_request,
      workerInstructions: traj.worker_instructions,
      stageRuns: traj.stage_runs.map((stage) => stage.stage),
      runOutcome: traj.run_outcome,
    },
    config,
  );
  if (!candidate) return null;
  if (options.persist === false) return resolveSkillCandidate(candidate);
  const persisted = persistSkillCandidate(candidate);
  pruneSkillCandidates(config.max_candidates);
  return persisted;
}
