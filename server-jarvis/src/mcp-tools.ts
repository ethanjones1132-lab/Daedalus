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
  const servers = selected.servers;
  const outputs: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
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