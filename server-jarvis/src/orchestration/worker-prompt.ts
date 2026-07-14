import type { SharedContextHints, StageName, WorkerInstructions } from "./coordinator";
import { truncateToTokenBudget } from "./context-budget";

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

  const memories = (shared.relevant_memories ?? []).slice(-16);
  if (memories.length) {
    blocks.push(
      "Relevant memories from prior turns:\n" +
        memories.map((m) => `- ${m.slice(0, 1500)}`).join("\n"),
    );
  }

  const failures = (shared.failure_patterns ?? []).slice(-8);
  if (failures.length) {
    blocks.push(
      "Known failure patterns to avoid:\n" +
        failures.map((p) => `- ${p.slice(0, 600)}`).join("\n"),
    );
  }

  const cached = shared.prior_tool_results ?? {};
  const entries = Object.entries(cached)
    .filter(([, value]) => value?.trim())
    .slice(-8);
  if (entries.length > 0) {
    blocks.push(
      "Cached tool results (reuse when still valid; do not rediscover):\n" +
        entries.map(([key, value]) => `### ${key.slice(0, 200)}\n${value.slice(0, 2000)}`).join("\n\n"),
    );
  }

  return truncateToTokenBudget(blocks.join("\n\n"), 1_500);
}

/**
 * Merge conductor-generated worker guidance and retrieved shared context with
 * the static stage baseline. The shared context is independent of whether the
 * conductor emitted a stage-specific instruction: parse-fallback routes often
 * have no `worker_instructions`, but must still receive cached tool results and
 * the active workspace root.
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

  if (!custom && !skills && !sharedBlock) return basePrompt;

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
