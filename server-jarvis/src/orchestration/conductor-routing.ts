/** JSON schema + tool definition for Gemma 4 native structured conductor output. */

export const COORDINATOR_ROUTE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    task_type: {
      type: "string",
      enum: ["code_review", "debug", "refactor", "general", "plan", "research", "test", "docs"],
    },
    pipeline: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        anyOf: [
          { type: "string", enum: ["planner", "executor", "reviewer", "rewriter", "synthesizer"] },
          { type: "string", pattern: "^re-enter:(planner|executor|reviewer|rewriter|synthesizer)$" },
          // B-01 (Track B, Conductor Recursive Self-Selection): "conductor_replan"
          // is a META decision, not an executable stage. It tells the runtime
          // to pause and re-invoke the local persistent conductor for revised
          // worker_instructions / pipeline / shared_context (B-02 will wire the
          // behavior). Routing is normalized to skip it in the executable
          // pipeline but preserve it in original_pipeline for telemetry.
          { type: "string", enum: ["conductor_replan"] },
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
      additionalProperties: false,
      properties: {
        needs_workspace_inspection: { type: "boolean" },
        needs_memory: { type: "boolean" },
        estimated_complexity: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["needs_workspace_inspection", "needs_memory", "estimated_complexity"],
    },
    coordinator_rationale: { type: "string", maxLength: 240 },
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

/** Compact structured-output contract for post-stage live supervision. */
export const CONDUCTOR_DIRECTIVE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    directive: {
      type: "string",
      enum: ["continue", "reroute", "inject_context", "abort_stage"],
    },
    newRemaining: {
      type: "array",
      maxItems: 5,
      items: {
        type: "string",
        enum: [
          "planner", "executor", "reviewer", "rewriter", "synthesizer",
          "re-enter:planner", "re-enter:executor", "re-enter:reviewer",
          "re-enter:rewriter", "re-enter:synthesizer",
        ],
      },
    },
    forStage: {
      type: "string",
      enum: ["planner", "executor", "reviewer", "rewriter", "synthesizer"],
    },
    note: { type: "string", maxLength: 600 },
    stage: {
      type: "string",
      enum: ["planner", "executor", "reviewer", "rewriter", "synthesizer"],
    },
    reason: { type: "string", maxLength: 240 },
  },
  required: ["directive"],
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
