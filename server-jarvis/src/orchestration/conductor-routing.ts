/** JSON schema + tool definition for Gemma 4 native structured conductor output. */

export const COORDINATOR_ROUTE_JSON_SCHEMA = {
  type: "object",
  properties: {
    task_type: {
      type: "string",
      enum: ["code_review", "debug", "refactor", "general", "plan", "research", "test", "docs"],
    },
    pipeline: {
      type: "array",
      items: {
        anyOf: [
          { type: "string", enum: ["planner", "executor", "reviewer", "rewriter", "synthesizer"] },
          { type: "string", pattern: "^re-enter:(planner|executor|reviewer|rewriter|synthesizer)$" },
          { type: "null" },
        ],
      },
    },
    topology: {
      type: "string",
      enum: ["linear", "speculative_parallel", "speculative_cascade", "recursive"],
    },
    context: {
      type: "object",
      properties: {
        needs_workspace_inspection: { type: "boolean" },
        needs_memory: { type: "boolean" },
        estimated_complexity: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["needs_workspace_inspection", "needs_memory", "estimated_complexity"],
    },
    coordinator_rationale: { type: "string" },
    worker_instructions: {
      type: "object",
      properties: {
        planner: { type: "string" },
        executor: { type: "string" },
        reviewer: { type: "string" },
        rewriter: { type: "string" },
        synthesizer: { type: "string" },
      },
    },
    shared_context: {
      type: "object",
      properties: {
        relevant_memories: { type: "array", items: { type: "string" } },
        prior_tool_results: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        failure_patterns: { type: "array", items: { type: "string" } },
      },
    },
  },
  required: ["task_type", "pipeline", "topology", "context", "coordinator_rationale"],
} as const;

export const COORDINATOR_ROUTE_TOOL = {
  type: "function",
  function: {
    name: "route_pipeline",
    description: "Select the Jarvis orchestration route for the current session turn.",
    parameters: COORDINATOR_ROUTE_JSON_SCHEMA,
  },
} as const;

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

export interface OllamaChatMessage {
  role?: string;
  content?: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
}

export function stripGemmaThinkingArtifacts(text: string): string {
  return text
    .replace(/<\|channel>thought[\s\S]*?(?:<channel\|>|$)/g, "")
    .replace(/<\|think\|>/g, "")
    .trim();
}

function normalizeToolArguments(args: Record<string, unknown> | string | undefined): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return args;
}

export function extractConductorRoutingJson(message: OllamaChatMessage | undefined): string {
  if (!message) {
    throw new Error("Ollama conductor returned no message");
  }

  const toolCall = message.tool_calls?.find((tc) => tc.function?.name === "route_pipeline");
  if (toolCall?.function) {
    const args = normalizeToolArguments(toolCall.function.arguments);
    if (args) {
      return JSON.stringify(args);
    }
  }

  const content = stripGemmaThinkingArtifacts(message.content ?? "");
  if (content) {
    return content;
  }

  throw new Error("Ollama conductor returned empty routing output");
}