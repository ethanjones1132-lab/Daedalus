import type { TaskType, WorkerInstructions } from "../orchestration/coordinator";
import type { StageRun } from "../self-tuning/store";
import type { TurnRequirement } from "../orchestration/turn-requirements";
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import type { SkillCandidate, SkillTrigger } from "./skill-types";
import { saveSkillCandidate, pruneSkillCandidates } from "./skill-store";
import type { SkillDistillationConfig } from "../config";

export interface DistillationInput {
  agentRunId: string;
  sessionId: string;
  taskType: TaskType;
  userRequest: string;
  workerInstructions?: WorkerInstructions;
  stageRuns: StageRun[];
  runOutcome: "success" | "degraded" | "failed";
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
  if (input.runOutcome !== "success") return 0;
  let score = 0.45;
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
  if (!config.enabled || input.runOutcome !== "success") return null;

  const confidence = computeConfidence(input);
  if (confidence < config.min_confidence) return null;

  const turnReq = classifyTurnRequirements(input.userRequest);
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