import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerMcpClientBundle } from "./mcp-client-bundle";
import { defaultConfig } from "./config";

function makeRuntime() {
  const rt = createToolRuntime();
  registerMcpClientBundle(rt);
  return rt;
}
function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${name}`, name, arguments: args };
}

describe("mcp client bundle", () => {
  test("registers all 5 outbound MCP tools", () => {
    const names = makeRuntime().listTools().map((t) => t.function.name).sort();
    expect(names).toEqual([
      "mcp_call_tool", "mcp_list_resources", "mcp_list_servers",
      "mcp_list_tools", "mcp_read_resource",
    ]);
  });

  test("only mcp_call_tool is dangerous", () => {
    const defs = Object.fromEntries(makeRuntime().listTools().map((d) => [d.function.name, d]));
    expect(defs["mcp_call_tool"].dangerous).toBe(true);
    for (const n of ["mcp_list_servers", "mcp_list_tools", "mcp_list_resources", "mcp_read_resource"]) {
      expect(defs[n].dangerous).toBe(false);
    }
  });

  test("mcp_list_servers returns a non-error envelope", async () => {
    const ws = mkdtempSync(join(tmpdir(), "jarvis-mcp-test-"));
    try {
      const cfg = defaultConfig();
      cfg.jarvis_path = ws;
      cfg.tools.enabled = true;
      const ctx = makeExecutionContext("chat", cfg);
      const result = await makeRuntime().execute(call("mcp_list_servers", {}), ctx);
      expect(result.is_error).toBe(false);
      expect(typeof result.output).toBe("string");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
