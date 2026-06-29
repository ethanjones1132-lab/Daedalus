import type { TaskType } from "../orchestration/coordinator";
import type { StageName } from "../orchestration/coordinator";
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import type { SkillCandidate } from "./skill-types";
import { listSkillCandidates } from "./skill-store";

export interface ResolvedSkills {
  matched: SkillCandidate[];
  promptBlock: string;
}

function triggerMatches(candidate: SkillCandidate, taskType: TaskType, message: string): boolean {
  const { requirement, signals } = classifyTurnRequirements(message);
  const trigger = candidate.trigger;
  if (!trigger.task_types.includes(taskType)) return false;
  if (trigger.requirements.length > 0 && !trigger.requirements.includes(requirement)) return false;
  if (trigger.signals.length === 0) return true;
  return trigger.signals.some((sig) => signals.includes(sig));
}

export function resolveSkillsForTurn(
  message: string,
  taskType: TaskType,
  stage?: StageName,
): ResolvedSkills {
  const candidates = listSkillCandidates("promoted");
  const matched = candidates.filter((c) => triggerMatches(c, taskType, message));

  if (matched.length === 0) {
    return { matched: [], promptBlock: "" };
  }

  const header = stage
    ? `Promoted distilled skills for ${stage}:`
    : "Promoted distilled skills for this turn:";
  const body = matched
    .map((s) => `### ${s.name}\n${s.body.slice(0, 2000)}`)
    .join("\n\n");

  return {
    matched,
    promptBlock: `${header}\n\n${body}`,
  };
}

export function appendSkillsToPrompt(basePrompt: string, skillsBlock: string): string {
  if (!skillsBlock.trim()) return basePrompt;
  return [basePrompt, skillsBlock].filter(Boolean).join("\n\n");
}