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

// ── Tool Capability Taxonomy ──

/**
 * What a tool DOES. Supervision code (effect gate, profile allowlists,
 * evidence accounting, batch partitioning) branches on this instead of
 * hard-coding tool names, so registering a new tool can no longer silently
 * omit it from a name-list somewhere.
 */
export type ToolCapabilityClass =
  | "read"
  | "list"
  | "write"
  | "shell"
  | "network"
  | "delegate"
  | "meta"
  | "interactive";

/**
 * What KIND of evidence a SUCCESSFUL call produces. Distinct from `class`
 * because two tools in the same class can be worth different evidence:
 * `glob` lists, `read_file` yields content, and both are class `read`-adjacent.
 */
export type ToolEvidenceClass =
  | "content"
  | "listing"
  | "metadata"
  | "execution"
  | "network"
  | "none";

export interface ToolCapability {
  class: ToolCapabilityClass;
  evidence: ToolEvidenceClass;
  /** Safe to execute concurrently with other parallel-safe calls in one batch. */
  parallel_safe?: boolean;
  /** Output may be served from the per-turn read cache. */
  cacheable?: boolean;
  /**
   * Admissible under the `read_only` execution profile. This is a SECURITY
   * allowlist and deliberately narrower than "does not write": `web_fetch` is
   * parallel-safe and non-mutating but still reaches the network, so it is not
   * admitted into a read-only workspace turn.
   */
  read_only_profile?: boolean;
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
  /**
   * Capability taxonomy for this tool. Optional on the type so third-party and
   * dynamically-registered tools (MCP) still typecheck, but every tool
   * registered by a standard bundle sets it — `bundles-registry.test.ts` pins
   * that, and `tool-capabilities.ts` treats an absent capability as the most
   * restrictive interpretation rather than a free pass.
   */
  capability?: ToolCapability;
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
  | "approval_required"
  | "approval_rejected"
  | "approval_unavailable"
  | "handler_error"
  | "delegate_write_unverified"
  | "delegate_cleanup_unconfirmed"
  | "delegate_cleanup_signal_error";

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
