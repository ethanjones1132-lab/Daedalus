// ═══════════════════════════════════════════════════════════════
// ── P2A-01/02/03: Jarvis MCP Adapter ──
// ═══════════════════════════════════════════════════════════════
// RECOVERY NOTE (2026-06-20): This file was truncated during recovery.
// Stub implementation provided for build compatibility.

import type { ToolRuntime, ToolDefinition } from "./tool-runtime";

export const MCP_SCHEMA_VERSION = "1.0.0";

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface McpListToolsResult {
  tools: McpToolSchema[];
  _meta: { schemaVersion: string };
}

export interface McpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

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

export interface McpAdapter {
  handle(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse>;
  listTools(): McpListToolsResult;
}

export function createMcpAdapter(_runtime: ToolRuntime): McpAdapter {
  return {
    async handle(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Method not found (stub)" },
      };
    },
    listTools(): McpListToolsResult {
      return {
        tools: [],
        _meta: { schemaVersion: MCP_SCHEMA_VERSION },
      };
    },
  };
}
