import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { JarvisConfig } from "./config";
import { ToolExecutionError } from "./tool-types";

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  disabled?: boolean;
  type?: string;
}

type McpServers = Record<string, McpServerConfig>;

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeout_ms?: number;
  timeoutMs?: number;
  strict?: boolean;
}

const DEFAULT_MCP_TIMEOUT_MS = 15_000;
const MAX_MCP_ERROR_CHARS = 1_000;

function boundedMcpText(value: string): string {
  if (value.length <= MAX_MCP_ERROR_CHARS) return value;
  return `${value.slice(0, MAX_MCP_ERROR_CHARS)}… [truncated]`;
}

function mcpFailure(
  code: "execution_error" | "spawn_error" | "protocol_error" | "cancelled" | "timeout",
  message: string,
  cause?: unknown,
): ToolExecutionError {
  const bounded = boundedMcpText(message);
  return new ToolExecutionError(code, bounded, bounded, cause);
}

function mcpConfigPath(cfg: JarvisConfig): string {
  return join(cfg.jarvis_path || process.cwd(), ".mcp.json");
}

export function loadMcpServers(cfg: JarvisConfig): McpServers {
  const path = mcpConfigPath(cfg);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as any;
    const servers = parsed.mcpServers || parsed.servers || {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
    return Object.fromEntries(
      Object.entries(servers)
        .filter(([, value]: [string, any]) => value && typeof value === "object" && !value.disabled)
    ) as McpServers;
  } catch {
    return {};
  }
}

function pickServers(
  args: Record<string, unknown>,
  cfg: JarvisConfig,
): { error?: string; servers: McpServers } {
  const servers = loadMcpServers(cfg);
  const server = typeof args.server === "string" && args.server ? args.server : undefined;
  if (!server) return { servers };
  const selected = servers[server];
  if (!selected) return { error: `MCP server not found: ${server}`, servers: {} };
  return { servers: { [server]: selected } };
}

interface RequestControl {
  signal: AbortSignal;
  reason: () => "cancelled" | "timeout" | undefined;
  cleanup: () => void;
}

function createRequestControl(options: McpRequestOptions): RequestControl {
  const controller = new AbortController();
  let reason: "cancelled" | "timeout" | undefined;
  const requested = options.timeout_ms ?? options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const timeoutMs = typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.floor(requested))
    : DEFAULT_MCP_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (reason) return;
    reason = "timeout";
    controller.abort("mcp_timeout");
  }, timeoutMs);
  const onAbort = (): void => {
    if (reason) return;
    reason = "cancelled";
    controller.abort(options.signal?.reason);
  };

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    reason: () => reason,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}

function stopFailure(serverName: string, reason: "cancelled" | "timeout"): ToolExecutionError {
  return mcpFailure(
    reason,
    reason === "timeout"
      ? `MCP server ${serverName} timed out`
      : `MCP server ${serverName} was cancelled`,
  );
}

function terminateProcess(child: ChildProcessWithoutNullStreams, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

async function requestHttp(
  serverName: string,
  server: McpServerConfig,
  payload: Record<string, unknown>,
  control: RequestControl,
): Promise<any> {
  const response = await fetch(String(server.url), {
    method: "POST",
    signal: control.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const reason = control.reason();
  if (reason) throw stopFailure(serverName, reason);
  if (!response.ok) {
    throw mcpFailure("execution_error", `MCP ${serverName} returned ${response.status}: ${boundedMcpText(text)}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw mcpFailure("protocol_error", `MCP ${serverName} returned malformed JSON`, error);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw mcpFailure("protocol_error", `MCP ${serverName} returned an invalid JSON-RPC response`);
  }
  if (json.jsonrpc !== "2.0" || String(json.id ?? "") !== String(payload.id)) {
    throw mcpFailure("protocol_error", `MCP ${serverName} returned a mismatched JSON-RPC response`);
  }
  if (json.error) {
    const message = typeof json.error === "object" && json.error !== null
      ? json.error.message
      : undefined;
    throw mcpFailure("protocol_error", `MCP ${serverName} returned an error: ${message || json.error.code || "unknown"}`);
  }
  return json.result ?? {};
}

function requestStdio(
  serverName: string,
  server: McpServerConfig,
  command: string,
  payload: Record<string, unknown>,
  cfg: JarvisConfig,
  control: RequestControl,
): Promise<any> {
  return new Promise((resolveReq, rejectReq) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, server.args || [], {
        cwd: server.cwd ? resolve(server.cwd) : cfg.jarvis_path,
        env: { ...process.env, ...(server.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      }) as ChildProcessWithoutNullStreams;
    } catch (error: any) {
      rejectReq(mcpFailure("spawn_error", `MCP ${serverName} failed to start: ${error?.message ?? String(error)}`, error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let closed = false;
    let result: any;
    let failure: ToolExecutionError | undefined;
    let malformed = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      control.signal.removeEventListener("abort", onAbort);
    };
    const stopChild = (): void => {
      if (closed || hardKillTimer) return;
      terminateProcess(child);
      hardKillTimer = setTimeout(() => {
        if (!closed) terminateProcess(child, "SIGKILL");
      }, 250);
      hardKillTimer.unref?.();
    };
    const failAndStop = (error: ToolExecutionError): void => {
      failure ??= error;
      stopChild();
    };
    const onAbort = (): void => {
      const reason = control.reason();
      if (reason) failAndStop(stopFailure(serverName, reason));
    };
    control.signal.addEventListener("abort", onAbort, { once: true });
    if (control.signal.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = boundedMcpText(stdout + chunk.toString());
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: any;
        try {
          message = JSON.parse(trimmed);
        } catch {
          malformed = true;
          continue;
        }
        if (!message || typeof message !== "object" || String(message.id ?? "") !== String(payload.id)) continue;
        if (message.jsonrpc !== "2.0") {
          failAndStop(mcpFailure("protocol_error", `MCP ${serverName} returned an invalid JSON-RPC response`));
          continue;
        }
        if (message.error) {
          const detail = typeof message.error === "object" && message.error !== null
            ? message.error.message
            : undefined;
          failAndStop(mcpFailure("protocol_error", `MCP ${serverName} returned an error: ${detail || message.error.code || "unknown"}`));
        } else {
          result = message.result ?? {};
          stopChild();
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedMcpText(stderr + chunk.toString());
    });
    child.once("error", (error) => {
      failure ??= mcpFailure("spawn_error", `MCP ${serverName} failed to start: ${error.message}`, error);
      if (child.pid === undefined) {
        closed = true;
        cleanup();
        rejectReq(failure);
      } else {
        stopChild();
      }
    });
    child.once("close", (code, signal) => {
      if (closed) return;
      closed = true;
      cleanup();
      if (failure) {
        rejectReq(failure);
        return;
      }
      const reason = control.reason();
      if (reason) {
        rejectReq(stopFailure(serverName, reason));
        return;
      }
      if (result !== undefined) {
        resolveReq(result);
        return;
      }
      if (malformed) {
        rejectReq(mcpFailure("protocol_error", `MCP ${serverName} returned malformed JSON`));
        return;
      }
      if (signal) {
        rejectReq(mcpFailure("execution_error", `MCP ${serverName} terminated by ${signal}`));
        return;
      }
      const detail = stderr.trim() || `MCP server ${serverName} exited with code ${code}`;
      rejectReq(mcpFailure("execution_error", detail));
    });

    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error: any) {
      failAndStop(mcpFailure("spawn_error", `MCP ${serverName} failed to accept request: ${error?.message ?? String(error)}`, error));
    }
  });
}

export async function mcpRequest(
  serverName: string,
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown> = {},
  cfg: JarvisConfig,
  options: McpRequestOptions = {},
): Promise<any> {
  const requestId = `${serverName}-${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = { jsonrpc: "2.0", id: requestId, method, params };
  const control = createRequestControl(options);
  try {
    if (server.url) return await requestHttp(serverName, server, payload, control);
    const command = server.command;
    if (!command) throw mcpFailure("execution_error", `MCP server ${serverName} has no command or URL`);
    return await requestStdio(serverName, server, command, payload, cfg, control);
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    const reason = control.reason();
    if (reason) throw stopFailure(serverName, reason);
    const message = error instanceof Error ? error.message : String(error);
    throw mcpFailure("execution_error", `MCP ${serverName} request failed: ${message}`, error);
  } finally {
    control.cleanup();
  }
}

function requestOptions(options?: McpRequestOptions): McpRequestOptions {
  return {
    signal: options?.signal,
    timeout_ms: options?.timeout_ms,
    timeoutMs: options?.timeoutMs,
    strict: options?.strict,
  };
}

function shouldPropagate(error: unknown, strict: boolean | undefined): boolean {
  if (strict === false) return false;
  if (strict === true) return true;
  return !(error instanceof ToolExecutionError && error.code === "spawn_error");
}

function rethrowOrText(error: unknown, prefix: string, strict: boolean | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  if (shouldPropagate(error, strict)) throw error;
  return `${prefix}: ${message}`;
}

export async function toolMcpListServers(_args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const servers = loadMcpServers(cfg);
  const names = Object.keys(servers);
  if (names.length === 0) return "No MCP servers found. Add .mcp.json with an mcpServers object.";
  return names.map(name => {
    const server = servers[name];
    const transport = server.url ? "http" : "stdio";
    const target = server.url || [server.command, ...(server.args || [])].filter(Boolean).join(" ");
    return `${name} [${transport}] ${target}`;
  }).join("\n");
}

export async function toolMcpListTools(
  args: Record<string, unknown>,
  cfg: JarvisConfig,
  options: McpRequestOptions = {},
): Promise<string> {
  const selected = pickServers(args, cfg);
  if (selected.error) {
    if (options.strict) throw mcpFailure("execution_error", selected.error);
    return selected.error;
  }
  const outputs: string[] = [];
  for (const [name, server] of Object.entries(selected.servers)) {
    try {
      const result = await mcpRequest(name, server, "tools/list", {}, cfg, requestOptions(options));
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      outputs.push(`Server ${name}:`);
      outputs.push(...(tools.length ? tools.map((tool: any) => {
        const input = tool.inputSchema ? ` schema=${JSON.stringify(tool.inputSchema).slice(0, 500)}` : "";
        return `- ${tool.name}: ${tool.description || ""}${input}`;
      }) : ["- No tools reported."]));
    } catch (error) {
      outputs.push(rethrowOrText(error, `Server ${name}: Error`, options.strict));
    }
  }
  return outputs.join("\n") || "No MCP servers selected.";
}

export async function toolMcpCallTool(
  args: Record<string, unknown>,
  cfg: JarvisConfig,
  options: McpRequestOptions = {},
): Promise<string> {
  const serverName = String(args.server || "");
  const toolName = String(args.tool || "");
  if (!serverName || !toolName) return "MCP server and tool are required.";
  const servers = loadMcpServers(cfg);
  const server = servers[serverName];
  if (!server) {
    if (options.strict) throw mcpFailure("execution_error", `MCP server not found: ${serverName}`);
    return `MCP server not found: ${serverName}`;
  }
  try {
    const result = await mcpRequest(serverName, server, "tools/call", {
      name: toolName,
      arguments: args.arguments && typeof args.arguments === "object" ? args.arguments : {},
    }, cfg, requestOptions(options));
    return JSON.stringify(result, null, 2);
  } catch (error) {
    return rethrowOrText(error, "MCP tool call failed", options.strict);
  }
}

export async function toolMcpListResources(
  args: Record<string, unknown>,
  cfg: JarvisConfig,
  options: McpRequestOptions = {},
): Promise<string> {
  const selected = pickServers(args, cfg);
  if (selected.error) {
    if (options.strict) throw mcpFailure("execution_error", selected.error);
    return selected.error;
  }
  const outputs: string[] = [];
  for (const [name, server] of Object.entries(selected.servers)) {
    try {
      const result = await mcpRequest(name, server, "resources/list", {}, cfg, requestOptions(options));
      const resources = Array.isArray(result?.resources) ? result.resources : [];
      outputs.push(`Server ${name}:`);
      outputs.push(...(resources.length ? resources.map((resource: any) => `- ${resource.uri}: ${resource.name || resource.description || ""}`) : ["- No resources reported."]));
    } catch (error) {
      outputs.push(rethrowOrText(error, `Server ${name}: Error`, options.strict));
    }
  }
  return outputs.join("\n") || "No MCP servers selected.";
}

export async function toolMcpReadResource(
  args: Record<string, unknown>,
  cfg: JarvisConfig,
  options: McpRequestOptions = {},
): Promise<string> {
  const serverName = String(args.server || "");
  const uri = String(args.uri || "");
  if (!serverName || !uri) return "MCP server and resource URI are required.";
  const servers = loadMcpServers(cfg);
  const server = servers[serverName];
  if (!server) {
    if (options.strict) throw mcpFailure("execution_error", `MCP server not found: ${serverName}`);
    return `MCP server not found: ${serverName}`;
  }
  try {
    const result = await mcpRequest(serverName, server, "resources/read", { uri }, cfg, requestOptions(options));
    return JSON.stringify(result, null, 2);
  } catch (error) {
    return rethrowOrText(error, "MCP resource read failed", options.strict);
  }
}
