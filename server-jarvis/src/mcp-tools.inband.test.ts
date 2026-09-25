// Contract pin for the OUTBOUND MCP client's in-band refusal handling.
//
// The MCP spec lets a server answer `tools/call` and `resources/read` with
// HTTP 200 / a well-formed JSON-RPC result that still reports a tool-level
// failure through `isError: true`. Both transports hand that result object
// back verbatim (`return json.result ?? {}` in requestHttp,
// `result = message.result ?? {}` in requestStdio) and both tool handlers
// stringify it without ever reading the flag, so a refusal reaches the Tool
// runtime as the success envelope `is_error: false`.
//
// These contracts pin both halves of the fix:
//   red   — an in-band refusal settles as `is_error: true` with a stable code
//           that is distinct from execution/spawn/protocol/cancelled/timeout.
//   green — a normal `isError: false` result stays a success with its content.

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test, afterEach } from "bun:test";
import {
  classifyMcpResult,
  toolMcpCallTool,
  toolMcpReadResource,
} from "./mcp-tools";
import { ToolExecutionError } from "./tool-types";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerMcpClientBundle } from "./mcp-client-bundle";
import { defaultConfig, type JarvisConfig } from "./config";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let activeWorkspaces: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const ws of activeWorkspaces) {
    try { rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  activeWorkspaces = [];
});

function makeWorkspace(): JarvisConfig {
  const ws = mkdtempSync(join(tmpdir(), "jarvis-mcp-inband-"));
  activeWorkspaces.push(ws);
  const cfg = defaultConfig();
  cfg.jarvis_path = ws;
  return cfg;
}

function writeMcpConfig(ws: string, body: unknown) {
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, ".mcp.json"), JSON.stringify(body), "utf-8");
}

function httpServer(cfg: JarvisConfig, name = "remote") {
  writeMcpConfig(cfg.jarvis_path, { mcpServers: { [name]: { url: "https://mcp.example/rpc" } } });
  return name;
}

/**
 * Stub the HTTP transport with one JSON-RPC success envelope around `result`.
 * The envelope echoes the request id because mcpRequest validates it.
 */
function stubHttpResult(result: unknown, status = 200) {
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result,
    }), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

async function callToolError(
  cfg: JarvisConfig,
  args: Record<string, unknown>,
  options: Record<string, unknown> = { strict: true },
): Promise<ToolExecutionError> {
  try {
    await toolMcpCallTool(args, cfg, options as never);
  } catch (error) {
    expect(error).toBeInstanceOf(ToolExecutionError);
    return error as ToolExecutionError;
  }
  throw new Error("expected toolMcpCallTool to throw");
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. classifyMcpResult — the pure in-band verdict
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: classifyMcpResult", () => {
  test("a result with no isError flag is ok", () => {
    expect(classifyMcpResult({ content: [{ type: "text", text: "hello" }] })).toEqual({ kind: "ok" });
  });

  test("isError: false is ok", () => {
    expect(classifyMcpResult({ content: [{ type: "text", text: "hello" }], isError: false })).toEqual({ kind: "ok" });
  });

  test("isError: true is a refusal carrying the remote text", () => {
    const verdict = classifyMcpResult({
      content: [{ type: "text", text: "permission denied by the server" }],
      isError: true,
    });
    expect(verdict).toEqual({ kind: "refusal", detail: "permission denied by the server" });
  });

  test("a resources/read refusal reads its text from contents[]", () => {
    const verdict = classifyMcpResult({
      contents: [{ uri: "file://x", text: "no such resource" }],
      isError: true,
    });
    expect(verdict).toEqual({ kind: "refusal", detail: "no such resource" });
  });

  test("a refusal falls back to an error/message field when content carries no text", () => {
    expect(classifyMcpResult({ error: "upstream unavailable", isError: true }))
      .toEqual({ kind: "refusal", detail: "upstream unavailable" });
    expect(classifyMcpResult({ message: "rate limited", isError: true }))
      .toEqual({ kind: "refusal", detail: "rate limited" });
  });

  test("a refusal with nothing extractable still yields a bounded detail", () => {
    const verdict = classifyMcpResult({ isError: true, content: [{ type: "image" }] });
    expect(verdict.kind).toBe("refusal");
    expect((verdict as { detail: string }).detail.length).toBeGreaterThan(0);
    expect((verdict as { detail: string }).detail.length).toBeLessThanOrEqual(600);
  });

  test("a refusal detail is bounded and never carries the raw payload", () => {
    const verdict = classifyMcpResult({
      content: [{ type: "text", text: "x".repeat(5_000) }],
      isError: true,
      raw_payload: "SUPER-SECRET-RAW-PAYLOAD",
    }) as { kind: string; detail: string };
    expect(verdict.kind).toBe("refusal");
    expect(verdict.detail.length).toBeLessThanOrEqual(600);
    expect(verdict.detail).toContain("…");
    expect(verdict.detail).not.toContain("SUPER-SECRET-RAW-PAYLOAD");
  });

  test("multiple text blocks are joined in order", () => {
    expect(classifyMcpResult({
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      isError: true,
    })).toEqual({ kind: "refusal", detail: "first\nsecond" });
  });

  test("a non-boolean isError is malformed, not a success and not a refusal", () => {
    for (const flag of ["true", "false", 1, 0, {}, []]) {
      expect(classifyMcpResult({ content: [], isError: flag })).toEqual({ kind: "malformed_flag" });
    }
  });

  test("a null isError is treated as absent (no refusal is claimed)", () => {
    expect(classifyMcpResult({ content: [], isError: null })).toEqual({ kind: "ok" });
  });

  test("a non-object result cannot carry an in-band flag", () => {
    expect(classifyMcpResult(undefined)).toEqual({ kind: "ok" });
    expect(classifyMcpResult("refused")).toEqual({ kind: "ok" });
    expect(classifyMcpResult([{ isError: true }])).toEqual({ kind: "ok" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. tools/call over the HTTP transport
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: tools/call in-band refusal (http)", () => {
  test("isError: true settles as a typed refusal, not a success string", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({
      content: [{ type: "text", text: "write_file is not permitted on this server" }],
      isError: true,
      raw_payload: "SUPER-SECRET-RAW-PAYLOAD",
    });

    const error = await callToolError(cfg, { server: "remote", tool: "write_file", arguments: { path: "a.ts" } });
    expect(error.code).toBe("mcp_refusal");
    expect(error.message).toContain("remote");
    expect(error.message).toContain("write_file");
    expect(error.message).toContain("write_file is not permitted on this server");
    expect(error.message).not.toContain("SUPER-SECRET-RAW-PAYLOAD");
    expect(error.output).not.toContain("SUPER-SECRET-RAW-PAYLOAD");
  });

  test("the refusal code is distinct from the existing mcp failure codes", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({ content: [{ type: "text", text: "nope" }], isError: true });

    const error = await callToolError(cfg, { server: "remote", tool: "ping" });
    for (const existing of ["execution_error", "spawn_error", "protocol_error", "cancelled", "timeout"]) {
      expect(error.code).not.toBe(existing);
    }
  });

  test("a non-boolean isError is a protocol_error, never a success", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({ content: [{ type: "text", text: "ok?" }], isError: "true" });

    const error = await callToolError(cfg, { server: "remote", tool: "ping" });
    expect(error.code).toBe("protocol_error");
  });

  test("isError: false stays a success with its content intact", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({ content: [{ type: "text", text: "wrote 3 files" }], isError: false });

    const out = await toolMcpCallTool({ server: "remote", tool: "write_file" }, cfg, { strict: true });
    const parsed = JSON.parse(out);
    expect(parsed.isError).toBe(false);
    expect(parsed.content[0].text).toBe("wrote 3 files");
  });

  test("a result with no isError flag is unchanged", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({ content: [{ type: "text", text: "plain success" }] });

    const out = await toolMcpCallTool({ server: "remote", tool: "ping" }, cfg, { strict: true });
    expect(JSON.parse(out).content[0].text).toBe("plain success");
  });

  test("a non-strict surface keeps its existing text contract for a refusal", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({ content: [{ type: "text", text: "nope" }], isError: true });

    const out = await toolMcpCallTool({ server: "remote", tool: "ping" }, cfg, { strict: false });
    expect(out.startsWith("MCP tool call failed:")).toBe(true);
    expect(out).toContain("nope");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. resources/read over the HTTP transport
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp-tools: resources/read in-band error payload (http)", () => {
  test("an in-band error payload settles as a typed refusal naming the resource", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({ contents: [], error: "resource expired", isError: true, raw_payload: "RAW-SECRET" });

    let error: ToolExecutionError | undefined;
    try {
      await toolMcpReadResource({ server: "remote", uri: "file://notes.md" }, cfg, { strict: true });
    } catch (caught) {
      error = caught as ToolExecutionError;
    }
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error?.code).toBe("mcp_refusal");
    expect(error?.message).toContain("remote");
    expect(error?.message).toContain("file://notes.md");
    expect(error?.message).toContain("resource expired");
    expect(error?.message).not.toContain("RAW-SECRET");
  });

  test("a successful resource read stays a success with its contents intact", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    stubHttpResult({ contents: [{ uri: "file://notes.md", text: "# notes" }], isError: false });

    const out = await toolMcpReadResource({ server: "remote", uri: "file://notes.md" }, cfg, { strict: true });
    expect(JSON.parse(out).contents[0].text).toBe("# notes");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. stdio transport — a real child process answering with an in-band refusal
// ═══════════════════════════════════════════════════════════════════════════

function writeStdioServer(cfg: JarvisConfig, result: unknown) {
  mkdirSync(cfg.jarvis_path, { recursive: true });
  const script = join(cfg.jarvis_path, "fake-stdio-server.mjs");
  writeFileSync(script, [
    "import { createInterface } from 'node:readline';",
    `const result = ${JSON.stringify(result)};`,
    "const rl = createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  let msg;",
    "  try { msg = JSON.parse(line); } catch { return; }",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf-8");
  writeMcpConfig(cfg.jarvis_path, {
    mcpServers: { local: { command: process.execPath, args: [script] } },
  });
  return "local";
}

describe("mcp-tools: tools/call in-band refusal (stdio)", () => {
  test("a stdio server reporting isError: true settles as a typed refusal", async () => {
    const cfg = makeWorkspace();
    writeStdioServer(cfg, {
      content: [{ type: "text", text: "stdio server refused the call" }],
      isError: true,
    });

    const error = await callToolError(cfg, { server: "local", tool: "deploy" });
    expect(error.code).toBe("mcp_refusal");
    expect(error.message).toContain("local");
    expect(error.message).toContain("deploy");
    expect(error.message).toContain("stdio server refused the call");
  });

  test("a stdio server reporting isError: false stays a success with its content", async () => {
    const cfg = makeWorkspace();
    writeStdioServer(cfg, {
      content: [{ type: "text", text: "stdio server ok" }],
      isError: false,
    });

    const out = await toolMcpCallTool({ server: "local", tool: "ping" }, cfg, { strict: true });
    expect(JSON.parse(out).content[0].text).toBe("stdio server ok");
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Tool runtime boundary — the envelope downstream evidence scoring reads
// ═══════════════════════════════════════════════════════════════════════════

describe("mcp client bundle: in-band refusal settles the Tool runtime envelope", () => {
  function runtimeWithWorkspace(cfg: JarvisConfig) {
    const rt = createToolRuntime();
    registerMcpClientBundle(rt);
    return rt;
  }

  test("a refusal returns is_error: true with the mcp_refusal code", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    cfg.tools.enabled = true;
    stubHttpResult({ content: [{ type: "text", text: "refused by policy" }], isError: true });

    const result = await runtimeWithWorkspace(cfg).execute(
      { id: "call-1", name: "mcp_call_tool", arguments: { server: "remote", tool: "write_file" } },
      makeExecutionContext("chat", cfg),
    );
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("mcp_refusal");
    expect(result.output).toContain("refused by policy");
  });

  test("a successful remote call stays a non-error result with its content", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    cfg.tools.enabled = true;
    stubHttpResult({ content: [{ type: "text", text: "deployed cleanly" }], isError: false });

    const result = await runtimeWithWorkspace(cfg).execute(
      { id: "call-2", name: "mcp_call_tool", arguments: { server: "remote", tool: "deploy" } },
      makeExecutionContext("chat", cfg),
    );
    expect(result.is_error).toBe(false);
    expect(result.error_code).toBeUndefined();
    expect(result.output).toContain("deployed cleanly");
  });

  test("an in-band refusal on a resource read is also an errored tool result", async () => {
    const cfg = makeWorkspace();
    httpServer(cfg);
    cfg.tools.enabled = true;
    stubHttpResult({ contents: [], error: "resource expired", isError: true });

    const result = await runtimeWithWorkspace(cfg).execute(
      { id: "call-3", name: "mcp_read_resource", arguments: { server: "remote", uri: "file://notes.md" } },
      makeExecutionContext("chat", cfg),
    );
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("mcp_refusal");
  });
});
