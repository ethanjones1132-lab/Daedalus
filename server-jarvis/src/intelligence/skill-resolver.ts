import type { TaskType } from "../orchestration/coordinator";
import type { StageName } from "../orchestration/coordinator";
import { classifyTurnRequirements } from "../orchestration/turn-requirements";
import { countTokens } from "../tokens";
import { truncateToTokenBudget } from "../orchestration/context-budget";
import type { SkillCandidate } from "./skill-types";
import { isValidSkillCandidate } from "./skill-candidate-validation";
import { listSkillCandidates } from "./skill-store";

export const MAX_PROMOTED_SKILLS_PER_TURN = 3;
export const PROMOTED_SKILL_BLOCK_BUDGET_TOKENS = 1_200;
export const MAX_SKILL_OMISSION_SAMPLES = 5;

export type SkillOmissionReason = "max_skills" | "token_budget";

export interface SkillOmissionSample {
  id: string;
  name: string;
  reason: SkillOmissionReason;
  renderedTokens: number;
}

export interface ResolvedSkills {
  matched: SkillCandidate[];
  promptBlock: string;
  promptTokens: number;
  totalMatched: number;
  omitted: {
    count: number;
    byReason: Record<SkillOmissionReason, number>;
    samples: SkillOmissionSample[];
  };
}

export interface ResolveSkillsOptions {
  stage?: StageName;
  maxSkills?: number;
  maxTokens?: number;
}

function triggerMatches(candidate: SkillCandidate, taskType: TaskType, message: string): boolean {
  const { requirement, signals } = classifyTurnRequirements(message);
  const trigger = candidate.trigger;
  if (
    !trigger
    || !Array.isArray(trigger.task_types)
    || !Array.isArray(trigger.requirements)
    || !Array.isArray(trigger.signals)
    || !trigger.task_types.includes(taskType)
  ) return false;
  if (trigger.requirements.length > 0 && !trigger.requirements.includes(requirement)) return false;
  if (trigger.signals.length === 0) return true;
  return trigger.signals.some((sig) => signals.includes(sig));
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function renderSkill(candidate: SkillCandidate): string {
  const name = typeof candidate.name === "string" && candidate.name.trim()
    ? candidate.name
    : candidate.id;
  const body = typeof candidate.body === "string" ? candidate.body : "";
  return `### ${name}\n${body}`;
}

function renderPrompt(header: string, selected: SkillCandidate[]): string {
  if (selected.length === 0) return "";
  return `${header}\n\n${selected.map(renderSkill).join("\n\n")}`;
}

function emptyResolution(): ResolvedSkills {
  return {
    matched: [],
    promptBlock: "",
    promptTokens: 0,
    totalMatched: 0,
    omitted: {
      count: 0,
      byReason: { max_skills: 0, token_budget: 0 },
      samples: [],
    },
  };
}

export function resolveSkillsForTurn(
  message: string,
  taskType: TaskType,
  stageOrOptions?: StageName | ResolveSkillsOptions,
): ResolvedSkills {
  const options = typeof stageOrOptions === "string"
    ? { stage: stageOrOptions }
    : stageOrOptions ?? {};
  const maxSkills = normalizeLimit(options.maxSkills, MAX_PROMOTED_SKILLS_PER_TURN);
  const maxTokens = normalizeLimit(options.maxTokens, PROMOTED_SKILL_BLOCK_BUDGET_TOKENS);
  const candidates = listSkillCandidates("promoted").filter((candidate) => isValidSkillCandidate(candidate) && candidate.source_run_ids.length > 0);
  const allMatches = candidates.filter((candidate) => triggerMatches(candidate, taskType, message));
  if (allMatches.length === 0) return emptyResolution();

  const header = options.stage
    ? `Promoted distilled skills for ${options.stage}:`
    : "Promoted distilled skills for this turn:";
  const selected: SkillCandidate[] = [];
  const omitted: ResolvedSkills["omitted"] = {
    count: 0,
    byReason: { max_skills: 0, token_budget: 0 },
    samples: [],
  };

  for (const candidate of allMatches) {
    if (selected.length >= maxSkills) {
      omitted.count++;
      omitted.byReason.max_skills++;
      if (omitted.samples.length < MAX_SKILL_OMISSION_SAMPLES) {
        omitted.samples.push({
          id: candidate.id,
          name: candidate.name,
          reason: "max_skills",
          renderedTokens: countTokens(renderSkill(candidate)),
        });
      }
      continue;
    }

    const prospective = renderPrompt(header, [...selected, candidate]);
    if (countTokens(prospective) > maxTokens) {
      omitted.count++;
      omitted.byReason.token_budget++;
      if (omitted.samples.length < MAX_SKILL_OMISSION_SAMPLES) {
        omitted.samples.push({
          id: candidate.id,
          name: candidate.name,
          reason: "token_budget",
          renderedTokens: countTokens(renderSkill(candidate)),
        });
      }
      continue;
    }

    selected.push(candidate);
  }

  const promptBlock = renderPrompt(header, selected);
  return {
    matched: selected,
    promptBlock,
    promptTokens: countTokens(promptBlock),
    totalMatched: allMatches.length,
    omitted,
  };
}

export function appendSkillsToPrompt(basePrompt: string, skillsBlock: string): string {
  if (!skillsBlock.trim()) return basePrompt;
  const bounded = truncateToTokenBudget(skillsBlock.trim(), PROMOTED_SKILL_BLOCK_BUDGET_TOKENS);
  return [basePrompt, bounded].filter(Boolean).join("\n\n");
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
  if (
    !trigger
    || !Array.isArray(trigger.requirements)
    || !Array.isArray(trigger.signals)
    || !Array.isArray(trigger.task_types)
  ) return false;
  if (trigger.requirements.length > 0 && !trigger.requirements.includes(requirement as any)) return false;
  if (trigger.signals.length === 0) return true;
  return trigger.signals.some((sig) => typeof sig === "string" && signals.includes(sig));
}

/**
 * Compact, KV-safe hint of promoted skills relevant to the raw message,
 * built without knowing `task_type` (routing hasn't happened yet). Returns
 * an empty string when nothing matches — callers should treat that as "add
 * nothing to the turn", not as an error.
 */
export function resolveSkillsForConductor(message: string): string {
  const { requirement, signals } = classifyTurnRequirements(message);
  const candidates = listSkillCandidates("promoted").filter((candidate) => isValidSkillCandidate(candidate) && candidate.source_run_ids.length > 0);
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