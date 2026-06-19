// ═══════════════════════════════════════════════════════════════
// ── P2A-01/02/03: Jarvis MCP Adapter ──
// ═══════════════════════════════════════════════════════════════
//
// Exposes the canonical Jarvis ToolRuntime as an inbound MCP server.
// All tool calls route through the same runtime dispatcher and policy
// evaluator used by internal chat/agent/cron surfaces.
//
// This module is NOT the outbound MCP client (mcp-tools.ts).
    // This is Jarvis acting as an MCP server for external callers.

import type { ToolRuntime, ToolDefinition } from "./tool-runtime";
import { makeExecutionContext } from "./tool-runtime";
import type { JarvisConfig } from "./config";

// ── Schema version — bump major on breaking changes, minor on additions ───────
export const MCP_SCHEMA_VERSION = "1.0.0";

// ── JSON-RPC 2.0 error codes (standard) ──────────────────────────────────────
    const METHOD_NOT_FOUND = -32601;

// ── MCP type definitions ──────────────────────────────────────────────────────

/** A single tool exposed via MCP tool list. */
export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
        properties: Record<string, unknown>;
    required: string[];
  };
}

/** Response body for tools/list. */
export interface McpListToolsResult {
  tools: McpToolSchema[];
  _meta: { schemaVersion: string };
}
    
/** Response body for tools/call. */
export interface McpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/** Inbound JSON-RPC 2.0 request. */
export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
      id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}
    
export interface McpJsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

export type McpJsonRpcResponse = McpJsonRpcSuccessResponse | McpJsonRpcErrorResponse;

/** The adapter handle returned by createMcpAdapter. */
    export interface McpAdapter {
  /**
   * Handle an inbound MCP JSON-RPC request.
   * Supported methods: `tools/list`, `tools/call`.
   * Any other method returns a -32601 Method Not Found error.
   */
  handle(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse>;

  /**
   * Return the MCP-format tool list directly (without JSON-RPC wrapper).
       * Useful for HTTP endpoints that skip JSON-RPC framing.
   */
  listTools(): McpListToolsResult;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function defToMcpSchema(def: ToolDefinition): McpToolSchema {
  return {
    name: def.function.name,
        description: def.function.description,
    inputSchema: {
      type: "object",
      properties: def.function.parameters.properties as Record<string, unknown>,
      required: def.function.parameters.required,
    },
  };
}

function ok(id: McpJsonRpcRequest["id"], result: unknown): McpJsonRpcSuccessResponse {
     return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: McpJsonRpcRequest["id"],
  code: number,
  message: string,
): McpJsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
   
// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an MCP adapter over the provided ToolRuntime.
 *
 * The adapter constructs an ExecutionContext with:
 *   - `surface: "mcp"`
 *   - `interactive: false` (MCP callers are non-interactive by default)
 *
    * Policy evaluation occurs inside `runtime.execute()` — the same path used
... 51 lines not shown ...