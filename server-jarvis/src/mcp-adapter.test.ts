import { describe, expect, test } from "bun:test";
import { createToolRuntime } from "./tool-runtime";
import { defaultConfig } from "./config";
import { createMcpAdapter } from "./mcp-adapter";

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
});
