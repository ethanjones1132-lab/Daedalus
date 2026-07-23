import { describe, expect, test } from "bun:test";
import { createToolRuntime } from "./tool-runtime";
import { defaultConfig } from "./config";
import {
  buildDelegateMcpConfig,
  createDelegateMcpAdapter,
  createMcpAdapter,
  DELEGATE_MCP_SERVER_NAME,
  DELEGATE_MCP_SESSION_GRANTS_ENV,
  DELEGATE_MCP_WORKSPACE_ENV,
  isJarvisDelegateMcpTool,
  jarvisDelegateMcpToolName,
  registerDelegateMcpBundles,
  runMcpStdioLoop,
} from "./mcp-adapter";
import { PassThrough } from "stream";

function makeEchoRuntime() {
  const runtime = createToolRuntime();
  runtime.register(
    {
      type: "function",
      function: {
        name: "echo",
        description: "Echoes the provided text.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to echo." },
          },
          required: ["text"],
        },
      },
      requires_approval: false,
      dangerous: false,
    },
    async (args) => `echo:${String(args.text)}`,
  );
  return runtime;
}

describe("MCP adapter", () => {
  test("handles initialize requests", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({ jsonrpc: "2.0", id: "init-1", method: "initialize" })).resolves.toEqual({
      jsonrpc: "2.0",
      id: "init-1",
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "Jarvis", version: "3.0.0" },
      },
    });
  });

  test("handles ping requests", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({ jsonrpc: "2.0", id: "ping-1", method: "ping" })).resolves.toEqual({
      jsonrpc: "2.0",
      id: "ping-1",
      result: {},
    });
  });

  test("lists runtime tools as MCP tool schemas", () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    expect(adapter.listTools().tools).toEqual([
      {
        name: "echo",
        description: "Echoes the provided text.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to echo." },
          },
          required: ["text"],
        },
      },
    ]);
  });

  test("handles tools/list requests", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes the provided text.",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string", description: "Text to echo." },
              },
              required: ["text"],
            },
          },
        ],
        _meta: { schemaVersion: "1.0.0" },
      },
    });
  });

  test("ignores JSON-RPC notifications without an id", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeUndefined();
  });

  test("handles tools/call requests through the runtime", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "echo", arguments: { text: "ok" } },
    })).resolves.toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        content: [{ type: "text", text: "echo:ok" }],
        isError: false,
      },
    });
  });

  test("rejects tools/call requests with non-object params", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({
      jsonrpc: "2.0",
      id: "bad-call-params",
      method: "tools/call",
      params: ["echo"],
    } as never)).resolves.toEqual({
      jsonrpc: "2.0",
      id: "bad-call-params",
      error: { code: -32602, message: "Invalid tools/call params" },
    });
  });

  test("rejects tools/call requests with a missing tool name", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({
      jsonrpc: "2.0",
      id: "bad-call",
      method: "tools/call",
      params: { arguments: { text: "ok" } },
    })).resolves.toEqual({
      jsonrpc: "2.0",
      id: "bad-call",
      error: { code: -32602, message: "Missing tool name" },
    });
  });

  test("reports unknown methods", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());

    await expect(adapter.handle({ jsonrpc: "2.0", id: "unknown", method: "unknown" })).resolves.toEqual({
      jsonrpc: "2.0",
      id: "unknown",
      error: { code: -32601, message: "Method not found" },
    });
  });

  test("delegate MCP bundles expose filesystem/git/task-control without shell or spawn", () => {
    const runtime = createToolRuntime();
    registerDelegateMcpBundles(runtime);
    const names = runtime.listTools().map((t) => t.function.name).sort();

    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("git_metadata");
    expect(names).toContain("task_list");
    expect(names).toContain("task_get");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("run_background_command");
    expect(names).not.toContain("agent");
    expect(names).not.toContain("task_create");
  });

  test("buildDelegateMcpConfig points Claude at the stdio entrypoint with workspace env", () => {
    const config = buildDelegateMcpConfig({
      workspacePath: "C:\\primary",
      allowedRoots: ["C:\\primary", "D:\\extra"],
      bunExecutable: "bun",
      serverScriptPath: "C:\\server\\mcp-stdio-server.ts",
    });
    const server = config.mcpServers[DELEGATE_MCP_SERVER_NAME];
    expect(server).toEqual({
      type: "stdio",
      command: "bun",
      args: ["C:\\server\\mcp-stdio-server.ts"],
      env: {
        [DELEGATE_MCP_WORKSPACE_ENV]: "C:\\primary",
        [DELEGATE_MCP_SESSION_GRANTS_ENV]: JSON.stringify(["C:\\primary", "D:\\extra"]),
      },
    });
  });

  test("createDelegateMcpAdapter executes a registered read tool through the adapter", async () => {
    const adapter = createDelegateMcpAdapter(defaultConfig(), {
      workspacePath: process.cwd(),
      allowedRoots: [process.cwd()],
    });
    const listed = adapter.listTools().tools.map((t) => t.name);
    expect(listed).toContain("git_metadata");
    expect(listed).not.toContain("run_background_command");

    await expect(adapter.handle({
      jsonrpc: "2.0",
      id: "gm-1",
      method: "tools/call",
      params: { name: "git_metadata", arguments: { include: ["branch"] } },
    })).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "gm-1",
      result: { isError: expect.any(Boolean) },
    });
  });

  test("runMcpStdioLoop answers tools/list over NDJSON", async () => {
    const adapter = createMcpAdapter(makeEchoRuntime(), defaultConfig());
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = { write(chunk: string) { chunks.push(chunk); return true; } };

    const loop = runMcpStdioLoop(adapter, { input, output });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    input.end();
    await loop;

    expect(chunks.join("")).toContain('"name":"echo"');
  });

  test("jarvis MCP tool name helpers recognize only the delegate server", () => {
    expect(isJarvisDelegateMcpTool("mcp__jarvis__read_file")).toBe(true);
    expect(isJarvisDelegateMcpTool("mcp__other__read_file")).toBe(false);
    expect(jarvisDelegateMcpToolName("mcp__jarvis__read_file")).toBe("read_file");
    expect(jarvisDelegateMcpToolName("mcp__other__read_file")).toBeNull();
  });
});
