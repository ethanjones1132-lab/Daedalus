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
}

// ── Tool Call ──

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ── Tool Result ──

export interface ToolResult {
  call_id: string;
  name: string;
  output: string;
  is_error: boolean;
  error?: string;
  duration_ms: number;
}
