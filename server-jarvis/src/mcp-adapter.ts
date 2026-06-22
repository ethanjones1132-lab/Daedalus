// ═══════════════════════════════════════════════════════════════
// ── P2A-01/02/03: Jarvis MCP Adapter ──
// ═══════════════════════════════════════════════════════════════
// Exposes Jarvis's canonical ToolRuntime as a minimal MCP server.
// The adapter intentionally stays small: initialize/ping plus tools/list and
// tools/call are enough for another MCP client to discover and invoke Jarvis
// tools through the same runtime used by chat, cron, and agent surfaces.

import { defaultConfig, type JarvisConfig } from "./config";
import { makeExecutionContext, type ToolCall, type ToolRuntime } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";

export const MCP_SCHEMA_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

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

export interface McpInitializeResult {
  protocolVersion: typeof MCP_PROTOCOL_VERSION;
  capabilities: { tools: Record<string, never> };
  serverInfo: { name: string; version: string };
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
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

export type McpAdapterResponse = McpJsonRpcResponse | undefined;

export interface McpAdapter {
  handle(req: McpJsonRpcRequest): Promise<McpAdapterResponse>;
  listTools(): McpListToolsResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotification(req: McpJsonRpcRequest): boolean {
  return !Object.prototype.hasOwnProperty.call(req, "id");
}

function error(req: McpJsonRpcRequest, code: number, message: string): McpJsonRpcErrorResponse {
  return { jsonrpc: "2.0", id: req.id ?? null, error: { code, message } };
}

function success(req: McpJsonRpcRequest, result: unknown): McpJsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id: req.id ?? null, result };
}

function toMcpToolSchema(def: ToolDefinition): McpToolSchema {
  return {
    name: def.function.name,
    description: def.function.description,
    inputSchema: def.function.parameters,
  };
}

export function createMcpAdapter(runtime: ToolRuntime, config: JarvisConfig = defaultConfig()): McpAdapter {
  const ctx = makeExecutionContext("mcp", config);

  return {
    listTools(): McpListToolsResult {
      return {
        tools: runtime.listTools().map(toMcpToolSchema),
        _meta: { schemaVersion: MCP_SCHEMA_VERSION },
      };
    },

    async handle(req: McpJsonRpcRequest): Promise<McpAdapterResponse> {
      if (isNotification(req)) return undefined;

      switch (req.method) {
        case "initialize":
          return success(req, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "Jarvis", version: "3.0.0" },
          } satisfies McpInitializeResult);

        case "ping":
          return success(req, {});

        case "tools/list":
          return success(req, this.listTools());

        case "tools/call": {
          const params = req.params ?? {};
          if (!isRecord(params)) return error(req, -32602, "Invalid tools/call params");

          const name = params.name;
          if (typeof name !== "string" || !name) {
            return error(req, -32602, "Missing tool name");
          }

          const args = params.arguments;
          const call: ToolCall = {
            id: req.id === null ? `${name}-${Date.now()}` : String(req.id),
            name,
            arguments: isRecord(args) ? args : {},
          };

          const result = await runtime.execute(call, ctx);
          return success(req, {
            content: [{ type: "text", text: result.output }],
            isError: result.is_error,
          } satisfies McpCallResult);
        }

        default:
          return error(req, -32601, "Method not found");
      }
    },
  };
}
