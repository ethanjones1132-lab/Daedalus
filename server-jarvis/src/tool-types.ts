// ═══════════════════════════════════════════════════════════════
// ── Shared Tool Type Contracts ──
// ═══════════════════════════════════════════════════════════════
// Extracted from the legacy tools.ts so the type contracts outlive it.
// The canonical ToolRuntime and every tool bundle import their types from here.

// ── Tool Parameter Schema ──

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: { type: string; description?: string };
  default?: unknown;
}

// ── Tool Definition (OpenAI format) ──

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameter>;
      required: string[];
    };
  };
  /** Whether this tool requires user approval */
  requires_approval: boolean;
  /** Whether this tool is potentially dangerous */
  dangerous: boolean;
  /**
   * When true, this tool is only registered for the text-tool-protocol fallback
   * path and should NOT be sent to native-function-calling models via the API.
   * The tool remains callable through the runtime (text-protocol dispatch),
   * but toApiTools() will filter it out of the schema sent to the LLM.
   */
  text_protocol_only?: boolean;
}

// ── Tool Call ──

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ── Tool Result ──

/** Normalized error classification for tool execution failures. */
export type ToolErrorCode =
  | "unknown_tool"
  | "missing_args"
  | "policy_denied"
  | "approval_rejected"
  | "approval_unavailable"
  | "handler_error";

export interface ToolResult {
  call_id: string;
  name: string;
  output: string;
  is_error: boolean;
  error?: string;
  /** Set when `is_error` is true — stable machine-readable category. */
  error_code?: ToolErrorCode;
  duration_ms: number;
}
