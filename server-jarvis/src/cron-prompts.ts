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
    label: "Agentic loop design patterns and tool-use optimization",
    description: "Patterns for building reliable, efficient AI agents with tool use and memory" },
  { id: "context-management",
    label: "Context window management and long-context strategies",
    description: "Techniques for handling long inputs: chunking, summarization, RAG, sliding window" },
  { id: "prompt-engineering",
    label: "Advanced prompt engineering (chain-of-thought, few-shot, structured output)",
    description: "Strategies for eliciting better outputs through prompt design" },
  { id: "fine-tuning",
    label: "Fine-tuning strategies (LoRA, QLoRA, PEFT, DPO, RLHF)",
    description: "Methods for adapting pretrained models to specific tasks with limited compute" },
  { id: "evaluation",
    label: "Model evaluation, benchmarking, and evals-driven development",
    description: "Frameworks for measuring model performance and driving improvement via evals" },
  { id: "retrieval",
    label: "Retrieval-augmented generation (RAG) architecture and retrieval quality",
    description: "Design patterns for grounding LLM outputs in up-to-date, factual knowledge" },
  { id: "multimodal",
    label: "Multimodal models and vision-language integration",
    description: "Architectures and use cases for models that process both text and images/audio" },
];

// ── Exported prompt builders ──────────────────────────────────

export function buildLearningPrompt(subtopicId?: string): string {
  const subtopic = subtopicId
    ? LEARNING_SUBTOPICS.find(s => s.id === subtopicId) ?? LEARNING_SUBTOPICS[0]
    : LEARNING_SUBTOPICS[Math.floor(Math.random() * LEARNING_SUBTOPICS.length)];

  return `You are Jarvis, an autonomous AI assistant performing a self-directed learning session.

## Topic: ${subtopic.label}

${subtopic.description}

## Your Task

Research and synthesize the most important, actionable insights on this topic. Focus on:
1. Practical implementation details relevant to a local AI assistant platform
2. Trade-offs between different approaches
3. Concrete recommendations for this specific use case (Tauri desktop app, Bun server, Ollama/OpenRouter backends)
4. Emerging best practices as of 2025

## Output Format

Produce a concise but comprehensive learning note in this format:

**TOPIC:** ${subtopic.label}
**DATE:** (today's date)

**KEY INSIGHTS:**
- (3-5 bullet points of the most important learnings)

**PRACTICAL APPLICATIONS:**
- (2-3 specific ways this applies to the Jarvis platform)

**RECOMMENDED NEXT STEPS:**
- (1-2 concrete things to try or implement)

**RESOURCES:**
- (1-2 high-quality references for further reading)

Keep the note focused and actionable. This will be stored in the long-term memory system.`;
}

export function buildReviewPrompt(context?: string): string {
  return `You are Jarvis, performing an automated self-review session.

## Purpose

Review recent performance, identify patterns, and generate improvement recommendations that will be stored in the memory system for future reference.

${context ? `## Context\n\n${context}\n` : ""}

## Review Areas

1. **Chat Quality**: Were responses accurate, helpful, and well-calibrated?
2. **Tool Use Efficiency**: Were tools used appropriately? Any unnecessary calls?
3. **Memory Utilization**: Was relevant memory recalled and applied effectively?
4. **Error Patterns**: Any recurring failure modes that need addressing?
5. **User Satisfaction Signals**: Based on conversation patterns, where was engagement highest/lowest?

## Output Format

Produce a structured review in this format:

**REVIEW DATE:** (today's date)
**PERIOD:** Last 7 days

**PERFORMANCE SUMMARY:**
(2-3 sentences on overall performance)

**STRENGTHS OBSERVED:**
- (2-3 bullet points)

**AREAS FOR IMPROVEMENT:**
- (2-3 bullet points with specific recommendations)

**ACTION ITEMS:**
- (1-2 concrete changes to implement)

Be honest and specific. Vague observations aren't useful.`;
}

export function buildCodebaseAuditPrompt(context?: string): string {
  return `You are Jarvis, performing an automated codebase audit.

## Purpose

Analyze the home-base codebase for technical debt, architectural inconsistencies, and improvement opportunities. Generate a focused audit report for the memory system.

${context ? `## Context\n\n${context}\n` : ""}

## Audit Scope

Focus on the Jarvis platform components:
- \`src-tauri/\` — Rust/Tauri backend commands and state management
- \`server-jarvis/\` — Bun server, tool runtime, inference routing
- \`src-ui/\` — React UI components and state
- Inter-component contracts (IPC commands, REST API, SSE events)

## Audit Areas

1. **Type Safety**: Unchecked any/unknown types that could cause runtime errors
2. **Error Handling**: Missing error boundaries, unhandled promise rejections
3. **Performance**: N+1 patterns, unnecessary re-renders, blocking operations
4. **Architecture**: Components doing too much, missing abstractions, coupling
5. **Test Coverage**: Critical paths without tests
6. **Security**: Input validation at boundaries, path traversal risks

## Output Format

**AUDIT DATE:** (today's date)
**SCOPE:** Jarvis Platform Codebase

**CRITICAL ISSUES (fix immediately):**
- (list any blocking issues)

**HIGH PRIORITY:**
- (2-3 items that should be addressed soon)

**MEDIUM PRIORITY:**
- (2-3 items for the next sprint)

**POSITIVE OBSERVATIONS:**
- (what's working well)

Be specific — include file paths and line numbers where relevant.`;
}

export function buildFootballAuditPrompt(context?: string): string {
  return `You are Jarvis, performing an audit of the PrizePicks football prediction system.

## Purpose

Review recent prediction accuracy, update model calibration notes, and identify systematic biases that should be corrected.

${context ? `## Context\n\n${context}\n` : ""}

## Audit Areas

1. **Prediction Accuracy**: Which prop types had the highest/lowest accuracy last week?
2. **Line Value**: Were there edges (props with positive expected value) that were identified correctly?
3. **Model Biases**: Any systematic over/under-estimation patterns?
4. **Situational Factors Missed**: Weather, injury reports, or game script factors that weren't weighted properly?
5. **Confidence Calibration**: Were high-confidence picks more accurate than low-confidence ones?

## Output Format

**AUDIT DATE:** (today's date)
**WEEK REVIEWED:** NFL Week (current)

**ACCURACY BY PROP TYPE:**
- Passing yards: (estimated hit rate)
- Rushing yards: (estimated hit rate)
- Receiving yards: (estimated hit rate)
- TDs: (estimated hit rate)

**TOP EDGES IDENTIFIED:**
- (1-2 props where the model had a clear edge)

**SYSTEMATIC BIASES TO CORRECT:**
- (1-2 patterns to adjust in future predictions)

**MODEL UPDATES:**
- (specific parameter or weighting adjustments for next week)

Focus on actionable calibration improvements.`;
}
