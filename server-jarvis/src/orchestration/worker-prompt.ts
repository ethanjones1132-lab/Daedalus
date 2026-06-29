import type { SharedContextHints, StageName, WorkerInstructions } from "./coordinator";

export interface InstructionVariantSelection {
  instructions?: WorkerInstructions;
  variants: Partial<Record<StageName, string>>;
}

/** Stable short hash for instruction telemetry and A/B variant keys. */
export function hashInstruction(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const STAGE_PROMPT_FILES: Record<StageName, string> = {
  planner: "modes/planner.md",
  executor: "modes/executor.md",
  reviewer: "modes/reviewer.md",
  rewriter: "modes/rewriter.md",
  synthesizer: "modes/synthesizer.md",
};

function formatSharedContext(shared?: SharedContextHints): string {
  if (!shared) return "";
  const blocks: string[] = [];

  if (shared.relevant_memories?.length) {
    blocks.push(
      "Relevant memories from prior turns:\n" +
      shared.relevant_memories.map((m) => `- ${m}`).join("\n"),
    );
  }

  if (shared.failure_patterns?.length) {
    blocks.push(
      "Known failure patterns to avoid:\n" +
      shared.failure_patterns.map((p) => `- ${p}`).join("\n"),
    );
  }

  const cached = shared.prior_tool_results ?? {};
  const entries = Object.entries(cached).filter(([, value]) => value?.trim());
  if (entries.length > 0) {
    blocks.push(
      "Cached tool results (reuse when still valid; do not rediscover):\n" +
      entries.map(([key, value]) => `### ${key}\n${value}`).join("\n\n"),
    );
  }

  return blocks.join("\n\n");
}

/**
 * Merge conductor-generated worker guidance with the static stage baseline.
 * When no custom instruction exists for a stage, returns the static prompt only.
 */
export function resolveStagePrompt(
  stage: StageName,
  basePrompt: string,
  workerInstructions?: WorkerInstructions,
  sharedContext?: SharedContextHints,
  distilledSkillsBlock?: string,
): string {
  const custom = workerInstructions?.[stage]?.trim();
  const sharedBlock = formatSharedContext(sharedContext);
  const skills = distilledSkillsBlock?.trim();

  if (!custom && !skills) return basePrompt;

  return [
    custom ? "Conductor instructions for this request:" : "",
    custom ?? "",
    skills,
    sharedBlock,
    "Stage baseline contract (always applies):",
    basePrompt,
  ].filter(Boolean).join("\n\n");
}

export function stagePromptFile(stage: StageName): string {
  return STAGE_PROMPT_FILES[stage];
}