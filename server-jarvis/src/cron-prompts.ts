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
    label: "Ag