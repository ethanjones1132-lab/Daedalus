import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import type { JarvisConfig } from "./config";

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

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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

async function mcpRequest(
  serverName: string,
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown> = {},
  cfg: JarvisConfig,
  timeoutMs = 15_000,
): Promise<any> {
  const requestId = `${serverName}-${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = { jsonrpc: "2.0", id: requestId, method, params };

  if (server.url) {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${serverName} returned ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(json.error.message || `MCP error ${json.error.code}`);
    return json.result ?? {};
  }

  if (!server.command) throw new Error(`MCP server ${serverName} has no command or URL`);

  return new Promise((resolveReq, rejectReq) => {
    const child = spawn(server.command!, server.args || [], {
      cwd: server.cwd ? resolve(server.cwd) : cfg.jarvis_path,
      env: { ...process.env, ...(server.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectReq(new Error(`MCP server ${serverName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const pending = new Map<string, PendingRequest>();
    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeout);
        try { child.kill(); } catch {}
        resolveReq(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        try { child.kill(); } catch {}
        rejectReq(error);
      },
      timeout,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          const pendingReq = pending.get(String(msg.id ?? ""));
          if (!pendingReq) continue;
          clearTimeout(pendingReq.timeout);
          pending.delete(String(msg.id ?? ""));
          if (msg.error) pendingReq.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
          else pendingReq.resolve(msg.result ?? {});
        } catch { /* keep buffering */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectReq(error);
    });
    child.on("close", (code) => {
      if (pending.size > 0) {
        const error = new Error(stderr || `MCP server ${serverName} exited with code ${code}`);
        for (const pendingReq of pending.values()) pendingReq.reject(error);
      }
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
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

export async function toolMcpListTools(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const selected = pickServers(args, cfg);
  if (selected.error) return selected.error;
  const outputs: string[] = [];
  for (const [name, server] of Object.entries(selected.servers)) {
    try {
      const result = await mcpRequest(name, server, "tools/list", {}, cfg);
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      outputs.push(`Server ${name}:`);
      outputs.push(...(tools.length ? tools.map((tool: any) => {
        const input = tool.inputSchema ? ` schema=${JSON.stringify(tool.inputSchema).slice(0, 500)}` : "";
        return `- ${tool.name}: ${tool.description || ""}${input}`;
      }) : ["- No tools reported."]));
    } catch (e: any) {
      outputs.push(`Server ${name}: Error: ${e.message}`);
    }
  }
  return outputs.join("\n") || "No MCP servers selected.";
}

export async function toolMcpCallTool(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const serverName = String(args.server || "");
  const toolName = String(args.tool || "");
  if (!serverName || !toolName) return "MCP server and tool are required.";
  const servers = loadMcpServers(cfg);
  const server = servers[serverName];
  if (!server) return `MCP server not found: ${serverName}`;
  try {
    const result = await mcpRequest(serverName, server, "tools/call", {
      name: toolName,
      arguments: args.arguments && typeof args.arguments === "object" ? args.arguments : {},
    }, cfg);
    return JSON.stringify(result, null, 2);
  } catch (e: any) {
    return `MCP tool call failed: ${e.message}`;
  }
}

export async function toolMcpListResources(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const selected = pickServers(args, cfg);
  if (selected.error) return selected.error;
  const outputs: string[] = [];
  for (const [name, server] of Object.entries(selected.servers)) {
    try {
      const result = await mcpRequest(name, server, "resources/list", {}, cfg);
      const resources = Array.isArray(result?.resources) ? result.resources : [];
      outputs.push(`Server ${name}:`);
      outputs.push(...(resources.length ? resources.map((resource: any) => `- ${resource.uri}: ${resource.name || resource.description || ""}`) : ["- No resources reported."]));
    } catch (e: any) {
      outputs.push(`Server ${name}: Error: ${e.message}`);
    }
  }
  return outputs.join("\n") || "No MCP servers selected.";
}

export async function toolMcpReadResource(args: Record<string, unknown>, cfg: JarvisConfig): Promise<string> {
  const serverName = String(args.server || "");
  const uri = String(args.uri || "");
  if (!serverName || !uri) return "MCP server and resource URI are required.";
  const servers = loadMcpServers(cfg);
  const server = servers[serverName];
  if (!server) return `MCP server not found: ${serverName}`;
  try {
    const result = await mcpRequest(serverName, server, "resources/read", { uri }, cfg);
    return JSON.stringify(result, null, 2);
  } catch (e: any) {
    return `MCP resource read failed: ${e.message}`;
  }
}
