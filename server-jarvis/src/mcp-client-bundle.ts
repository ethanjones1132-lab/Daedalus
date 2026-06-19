// ═══════════════════════════════════════════════════════════════
// ── MCP Client Bundle ──
// ═══════════════════════════════════════════════════════════════
// Wires the (previously orphaned) mcp-tools.ts outbound MCP client into the
// ToolRuntime: list/call tools and resources on external MCP servers. Tool names
// match the aliases already present in text-tools.ts.
//
// This is the OUTBOUND client (Jarvis calling other MCP servers). It is distinct
// from mcp-adapter.ts, which exposes Jarvis's own runtime AS an MCP server.
//
// mcp_call_tool is dangerous (executes a tool on an external server); the
// list/read tools are safe.

import type { ToolRuntime } from "./tool-runtime";
import type { ToolDefinition, ToolParameter } from "./tool-types";
import {
  toolMcpListServers, toolMcpListTools, toolMcpCallTool,
  toolMcpListResources, toolMcpReadResource,
} from "./mcp-tools";

function def(
  name: string,
  description: string,
  properties: Record<string, ToolParameter>,
  required: string[],
  dangerous = false,
): ToolDefinition {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
    requires_approval: dangerous,
    dangerous,
  };
}

const LIST_SERVERS_DEF = def("mcp_list_servers",
  "List configured MCP servers (from .mcp.json).", {}, []);

const LIST_TOOLS_DEF = def("mcp_list_tools",
  "List the tools exposed by one or all configured MCP servers.",
  { server: { type: "string", description: "Server name (omit for all servers)" } }, []);

const CALL_TOOL_DEF = def("mcp_call_tool",
  "Call a tool on a configured MCP server.",
  {
    server: { type: "string", description: "MCP server name" },
    tool: { type: "string", description: "Tool name to call on the server" },
    arguments: { type: "object", description: "Arguments object for the tool" },
  }, ["server", "tool"], true);

const LIST_RESOURCES_DEF = def("mcp_list_resources",
  "List resources exposed by one or all configured MCP servers.",
  { server: { type: "string", description: "Server name (omit for all servers)" } }, []);

const READ_RESOURCE_DEF = def("mcp_read_resource",
  "Read a resource from a configured MCP server by URI.",
  {
    server: { type: "string", description: "MCP server name" },
    uri: { type: "string", description: "Resource URI to read" },
  }, ["server", "uri"]);

export function registerMcpClientBundle(rt: ToolRuntime): void {
  rt.register(LIST_SERVERS_DEF, (a, c) => toolMcpListServers(a, c.config));
  rt.register(LIST_TOOLS_DEF, (a, c) => toolMcpListTools(a, c.config));
  rt.register(CALL_TOOL_DEF, (a, c) => toolMcpCallTool(a, c.config));
  rt.register(LIST_RESOURCES_DEF, (a, c) => toolMcpListResources(a, c.config));
  rt.register(READ_RESOURCE_DEF, (a, c) => toolMcpReadResource(a, c.config));
}
