// ═══════════════════════════════════════════════════════════════
// ── P2A-01/02/03: Jarvis MCP Adapter ──
// ═══════════════════════════════════════════════════════════════
// Exposes Jarvis's canonical ToolRuntime as a minimal MCP server.
// The adapter intentionally stays small: initialize/ping plus tools/list and
// tools/call are enough for another MCP client to discover and invoke Jarvis
// tools through the same runtime used by chat, cron, and agent surfaces.
//
// The Claude executor delegate reuses this adapter (via a stdio entrypoint and
// generated --mcp-config) for filesystem/git/task control tools — never shell
// or Task-spawning, which remain the root-confinement boundary.

import { createInterface } from "readline";
import { join } from "path";
import { defaultConfig, type JarvisConfig } from "./config";
import { registerFilesystemBundle } from "./filesystem-bundle";
import { registerGitMetadataBundle } from "./git-metadata-bundle";
import { registerTaskControlBundle } from "./task-bundle";
import {
  createToolRuntime,
  makeExecutionContext,
  type ExecutionContext,
  type ToolCall,
  type ToolRuntime,
} from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";

export const MCP_SCHEMA_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** MCP server name exposed to Claude CLI for the executor delegate. */
export const DELEGATE_MCP_SERVER_NAME = "jarvis";

/** Env vars the stdio MCP server reads for workspace scoping. */
export const DELEGATE_MCP_WORKSPACE_ENV = "JARVIS_MCP_WORKSPACE";
export const DELEGATE_MCP_SESSION_GRANTS_ENV = "JARVIS_MCP_SESSION_GRANTS";

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

export interface McpServerLaunchConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  type?: "stdio";
}

export interface DelegateMcpConfigFile {
  mcpServers: Record<string, McpServerLaunchConfig>;
}

export interface BuildDelegateMcpConfigInput {
  workspacePath: string;
  allowedRoots: string[];
  /** Bun/node executable that can run TypeScript entrypoints. Defaults to process.execPath. */
  bunExecutable?: string;
  /** Absolute path to mcp-stdio-server.ts. Defaults to the sibling of this module. */
  serverScriptPath?: string;
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

/**
 * Register the filesystem + git + task-control bundles the Claude delegate MCP
 * surface exposes. Shell and Task-spawning tools are intentionally omitted —
 * they remain the root-confinement boundary of the stock CLI --tools allowlist.
 */
export function registerDelegateMcpBundles(runtime: ToolRuntime): void {
  registerFilesystemBundle(runtime);
  registerGitMetadataBundle(runtime);
  registerTaskControlBundle(runtime);
}

export function createMcpAdapter(
  runtime: ToolRuntime,
  config: JarvisConfig = defaultConfig(),
  contextOverrides?: Partial<Omit<ExecutionContext, "surface" | "config">>,
): McpAdapter {
  const ctx = makeExecutionContext("mcp", config, contextOverrides);

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

/**
 * Build the ToolRuntime + MCP adapter used by the Claude executor delegate.
 * Approvals are skipped (the delegate already enforces P0 roots + write
 * verification); workspace scope is projected from the allowed roots.
 */
export function createDelegateMcpAdapter(
  config: JarvisConfig,
  options: { workspacePath: string; allowedRoots: string[] },
): McpAdapter {
  const runtime = createToolRuntime();
  registerDelegateMcpBundles(runtime);
  return createMcpAdapter(runtime, config, {
    workspace_path: options.workspacePath,
    session_grants: options.allowedRoots,
    // Delegate is automated; stock CLI already confines roots and verifies writes.
    skip_approval_gate: true,
  });
}

/** Resolve the default stdio entrypoint next to this module. */
export function defaultDelegateMcpServerScriptPath(): string {
  return join(import.meta.dir, "mcp-stdio-server.ts");
}

/**
 * Build a Claude-compatible `.mcp.json` / `--mcp-config` payload that launches
 * the Jarvis stdio MCP server with the delegate tool bundles.
 */
export function buildDelegateMcpConfig(input: BuildDelegateMcpConfigInput): DelegateMcpConfigFile {
  const workspacePath = input.workspacePath.trim() || input.allowedRoots[0] || process.cwd();
  const allowedRoots = input.allowedRoots.length > 0 ? input.allowedRoots : [workspacePath];
  return {
    mcpServers: {
      [DELEGATE_MCP_SERVER_NAME]: {
        type: "stdio",
        command: input.bunExecutable ?? process.execPath,
        args: [input.serverScriptPath ?? defaultDelegateMcpServerScriptPath()],
        env: {
          [DELEGATE_MCP_WORKSPACE_ENV]: workspacePath,
          [DELEGATE_MCP_SESSION_GRANTS_ENV]: JSON.stringify(allowedRoots),
        },
      },
    },
  };
}

/**
 * True when a stock Claude tool name is an MCP tool from the Jarvis delegate
 * server (`mcp__jarvis__…`).
 */
export function isJarvisDelegateMcpTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized.startsWith(`mcp__${DELEGATE_MCP_SERVER_NAME}__`);
}

/**
 * Extract the underlying Jarvis tool name from `mcp__jarvis__tool_name`.
 * Returns null when the name is not a Jarvis delegate MCP tool.
 */
export function jarvisDelegateMcpToolName(toolName: string): string | null {
  if (!isJarvisDelegateMcpTool(toolName)) return null;
  const parts = toolName.trim().split("__");
  if (parts.length < 3) return null;
  return parts.slice(2).join("__");
}

/**
 * NDJSON stdio loop for MCP clients (Claude CLI, mcp-tools.ts, etc.).
 * Writes only JSON-RPC messages to stdout; log on stderr if needed.
 */
export async function runMcpStdioLoop(
  adapter: McpAdapter,
  options: {
    input?: NodeJS.ReadableStream;
    output?: { write(chunk: string): unknown };
  } = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: McpJsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as McpJsonRpcRequest;
    } catch {
      // Ignore malformed lines; keep the loop alive for the next frame.
      continue;
    }
    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      continue;
    }
    const response = await adapter.handle(req);
    if (response !== undefined) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
