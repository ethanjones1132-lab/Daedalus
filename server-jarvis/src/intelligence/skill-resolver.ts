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

// ═══════════════════════════════════════════════════════════════
// D4 (organism loop v1): conductor-time resolution. The conductor routes
// BEFORE task_type is known, so matching here can only use requirement +
// signals — never `trigger.task_types`. The result must be small enough to
// ride the per-turn user delta without disturbing the KV-cache-guarded
// system prompt (see `persistent-conductor.ts`'s `buildTurnUserContent`).
// ═══════════════════════════════════════════════════════════════

const CONDUCTOR_HINT_MAX_SKILLS = 3;
const CONDUCTOR_HINT_MAX_CHARS = 400;

function triggerMatchesConductor(candidate: SkillCandidate, requirement: string, signals: string[]): boolean {
  const trigger = candidate.trigger;
  if (trigger.requirements.length > 0 && !trigger.requirements.includes(requirement as any)) return false;
  if (trigger.signals.length === 0) return true;
  return trigger.signals.some((sig) => signals.includes(sig));
}

/**
 * Compact, KV-safe hint of promoted skills relevant to the raw message,
 * built without knowing `task_type` (routing hasn't happened yet). Returns
 * an empty string when nothing matches — callers should treat that as "add
 * nothing to the turn", not as an error.
 */
export function resolveSkillsForConductor(message: string): string {
  const { requirement, signals } = classifyTurnRequirements(message);
  const candidates = listSkillCandidates("promoted");
  const matched = candidates.filter((c) => triggerMatchesConductor(c, requirement, signals));
  if (matched.length === 0) return "";

  const lines: string[] = [];
  let total = 0;
  for (const c of matched.slice(0, CONDUCTOR_HINT_MAX_SKILLS)) {
    const line = `- ${c.name}: ${c.description} (tasks: ${c.trigger.task_types.join(", ")})`;
    if (total + line.length > CONDUCTOR_HINT_MAX_CHARS && lines.length > 0) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}