import type { TaskType, WorkerInstructions } from "../orchestration/coordinator";
import type { StageRun } from "../self-tuning/store";
import type { TurnRequirement } from "../orchestration/turn-requirements";
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import type { SkillCandidate, SkillTrigger } from "./skill-types";
import { saveSkillCandidate, pruneSkillCandidates } from "./skill-store";
import type { SkillDistillationConfig } from "../config";
import type { TrajectorySnapshot } from "../self-tuning/store";

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

function buildSkillBody(input: DistillationInput): string {
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

  const toolStages = input.stageRuns.filter((s) => {
    try {
      const tools = JSON.parse(s.tool_calls_json ?? "[]");
      return Array.isArray(tools) && tools.length > 0;
    } catch {
      return false;
    }
  });
  if (toolStages.length > 0) {
    blocks.push("## Successful tool usage pattern");
    for (const stage of toolStages) {
      blocks.push(`- ${stage.mode_id}: tools used on turn ${stage.turn_number}`);
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

export function distillSkillCandidate(
  input: DistillationInput,
  config: SkillDistillationConfig,
): SkillCandidate | null {
  if (!config.enabled) return null;
  if (input.taskRunAccepted === false) return null;
  
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
  const candidate: SkillCandidate = {
    id,
    name: `distilled-${input.taskType}-${input.agentRunId.slice(-6)}`,
    description: `Distilled orchestration pattern for ${input.taskType} (${turnReq.requirement})`,
    trigger,
    body: buildSkillBody(input),
    source_run_ids: [input.agentRunId],
    source_session_id: input.sessionId,
    confidence,
    status: "candidate",
    created_at: now,
    updated_at: now,
  };

  saveSkillCandidate(candidate);
  pruneSkillCandidates(config.max_candidates);
  return candidate;
}

/** Distill a skill candidate from a stored trajectory snapshot (C-01 hardening).
 *  Used for audit/replay: e.g., CLI `bun run src/intelligence/redistill.ts --agent-run-id=...` */
export function distillFromTrajectorySnapshot(
  input: TrajectoryDistillationInput,
): SkillCandidate | null {
  const { snapshot, config } = input;
  if (!config.enabled) return null;

  let traj: {
    version: number;
    agent_run_id: string;
    session_id: string;
    task_type: TaskType;
    run_outcome: "success" | "degraded" | "failed";
    duration_ms: number;
    routing: any;
    worker_instructions?: WorkerInstructions;
    instruction_variants: Record<string, string>;
    stage_runs: StageRun[];
    model_attributions: any[];
    user_request: string;
  };

  try {
    traj = JSON.parse(snapshot.snapshot_json);
  } catch {
    return null;
  }

  // Policy: only distill from success outcomes (degraded only if replan-rescued with clean synthesizer)
  if (traj.run_outcome !== "success") return null;

  // Check if this was a replan-rescued degraded run - if so, allow distillation
  const distillOn = config.distill_on ?? ["success"];
  if (!distillOn.includes(traj.run_outcome)) return null;

  const candidate = distillSkillCandidate(
    {
      agentRunId: traj.agent_run_id,
      sessionId: traj.session_id,
      taskType: traj.task_type,
      userRequest: traj.user_request,
      workerInstructions: traj.worker_instructions,
      stageRuns: traj.stage_runs,
      runOutcome: traj.run_outcome,
    },
    config,
  );

  return candidate;
}
