// ═══════════════════════════════════════════════════════════════
// ── Cron Job Prompts ──
// ═══════════════════════════════════════════════════════════════
// Structured prompts for automated self-improvement jobs.
// Each prompt is designed to produce durable, actionable output
// that gets written to the memory system.

// ── Subtopic definitions (mirrors Rust learning.rs LEARNING_SUBTOPICS) ───────

    interface LearningSubtopic {
  id: string;
  label: string;
  description: string;
}

const LEARNING_SUBTOPICS: LearningSubtopic[] = [
  { id: "quantization",
    label: "Quantization strategies (Q4_K_M, AWQ, GPTQ, GGUF, mixed precision)",
    description: "Techniques for reducing model size and memory while preserving inference quality" },
      { id: "distillation",
    label: "Distillation techniques for small language models",
    description: "Methods for training smaller models to replicate larger model capabilities" },
  { id: "local-serving",
    label: "Local serving architecture (vLLM, llama.cpp, Ollama internals)",
    description: "Systems and frameworks for running LLMs locally on consumer hardware" },
  { id: "agentic-loop",
    label: "Agentic loop optimization for small contexts",
    description: "Techniques for making agent loops efficient within limited context windows" },
  { id: "multi-model-routing",
        label: "Multi-model routing on consumer GPUs",
    description: "Strategies for switching between models based on task complexity and available VRAM" },
  { id: "kv-cache",
    label: "KV-cache optimization and context window management",
    description: "Techniques for managing key-value caches to extend effective context length" },
  { id: "speculative-decoding",
    label: "Speculative decoding for local inference",
    description: "Using a small draft model to accelerate generation from a larger model" },
];

    function pickSubtopicsForSession(date: Date): LearningSubtopic[] {
  // Use UTC date components for stable daily rotation independent of local TZ/DST
  const utcDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dayIndex = Math.floor(utcDay / 86400000);
  const count = LEARNING_SUBTOPICS.length;
  const start = dayIndex % count;
  return [0, 1, 2].map((i) => LEARNING_SUBTOPICS[(start + i) % count]);
}

// ── Learning Session Prompt ──────────────────────────────────────────────────
    
/**
 * Build the learning session prompt for the current date.
 * Rotates through subtopics on a daily cycle.
 *
 * The model receives this prompt and is expected to:
 * 1. Research each subtopic using web_search and web_fetch
 * 2. Evaluate sources against the credibility allowlist
 * 3. Produce structured findings in markdown format
 * 4. Write findings to ~/.openclaw/jarvis/memory/reference/learnings/
     * 5. Update MEMORY.md with index entries
 */
export function buildLearningPrompt(): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const subtopics = pickSubtopicsForSession(now);

  const topicList = subtopics
    .map(
      (s, i) =>
            `${i + 1}. **${s.label}** (${s.id}): ${s.description}`
    )
    .join('\n');

  return `You are Jarvis conducting an autonomous Learning Session on local agentic AI architecture.

## Session Date: ${dateStr}

## Today's Research Subtopics (rotate daily)
${topicList}
... 244 lines not shown ...