import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import { registerShellBundle } from "./shell-bundle";
import { registerMcpClientBundle } from "./mcp-client-bundle";
import { registerTaskBundle } from "./task-bundle";
import { mcpRequest } from "./mcp-tools";
import { defaultConfig } from "./config";
import { assessWorkspaceEvidence } from "./orchestration/evidence-sufficiency";

const originalFetch = globalThis.fetch;
const workspaces: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "jarvis-foreground-"));
  workspaces.push(workspace);
  return workspace;
}

function makeConfig(workspace: string) {
  const cfg = defaultConfig();
  cfg.jarvis_path = workspace;
  cfg.tools.enabled = true;
  cfg.tools.sandbox_mode = "off";
  return cfg;
}

function makeShellContext(overrides: Record<string, unknown> = {}) {
  return makeExecutionContext("chat", makeConfig(makeWorkspace()), {
    requestApproval: async () => true,
    ...overrides,
  });
}

function makeShellRuntime() {
  const runtime = createToolRuntime();
  registerShellBundle(runtime);
  return runtime;
}

function makeMcpRuntime(workspace: string) {
  const runtime = createToolRuntime();
  registerMcpClientBundle(runtime);
  return runtime;
}

function writeMcpConfig(workspace: string, server: Record<string, unknown>): void {
  writeFileSync(
    join(workspace, ".mcp.json"),
    JSON.stringify({ mcpServers: { alpha: server } }),
    "utf8",
  );
}

describe("foreground shell outcomes", () => {
  test("non-zero exit is an error rather than successful output", async () => {
    const result = await makeShellRuntime().execute(
      { id: "shell-exit", name: "bash", arguments: { command: "exit 7" } },
      makeShellContext(),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("execution_error");
    expect(result.output).toContain("exit code 7");
  });

  test("signal termination is an error", async () => {
    const result = await makeShellRuntime().execute(
      { id: "shell-signal", name: "bash", arguments: { command: "kill -TERM $$" } },
      makeShellContext(),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("execution_error");
    expect(result.error).toContain("SIGTERM");
  });

  test("shell timeout aborts the child and returns a timeout outcome", async () => {
    const result = await makeShellRuntime().execute(
      { id: "shell-timeout", name: "bash", arguments: { command: "sleep 1", timeout_ms: 20 } },
      makeShellContext(),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("timeout");
  }, 2_000);

  test("context timeout composes with the shell ceiling", async () => {
    const result = await makeShellRuntime().execute(
      { id: "shell-context-timeout", name: "bash", arguments: { command: "sleep 1", timeout_ms: 1_000 } },
      makeShellContext({ timeout_ms: 20 }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("timeout");
  }, 2_000);

  test("spawn failure is not normalized as successful text", async () => {
    const workspace = makeWorkspace();
    const cfg = makeConfig(workspace);
    cfg.tools.bash_path = join(workspace, "missing-bash");
    const result = await makeShellRuntime().execute(
      { id: "shell-spawn", name: "bash", arguments: { command: "echo hi" } },
      makeExecutionContext("chat", cfg, { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("spawn_error");
  });

  test("caller abort waits for the child and reports cancellation", async () => {
    const controller = new AbortController();
    const pending = makeShellRuntime().execute(
      { id: "shell-cancel", name: "bash", arguments: { command: "sleep 1" } },
      makeShellContext({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort("operator cancelled"), 20);
    const result = await pending;

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("cancelled");
  }, 2_000);

  test("cancelled shell work leaves no delayed side effect", async () => {
    const workspace = makeWorkspace();
    const marker = join(workspace, "late-side-effect");
    const controller = new AbortController();
    const pending = makeShellRuntime().execute(
      {
        id: "shell-no-late",
        name: "bash",
        arguments: { command: `sleep 0.1; printf late > '${marker}'` },
      },
      makeShellContext({ workspace_path: workspace, signal: controller.signal }),
    );
    setTimeout(() => controller.abort("operator cancelled"), 20);
    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(result.error_code).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
  }, 2_000);

  test("successful empty output remains successful", async () => {
    const result = await makeShellRuntime().execute(
      { id: "shell-empty", name: "bash", arguments: { command: "printf ''" } },
      makeShellContext(),
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toBe("(no output)");
  });

  test("a returned Error-like string is still successful", async () => {
    const runtime = createToolRuntime();
    runtime.register({
      type: "function",
      function: { name: "description", description: "", parameters: { type: "object", properties: {}, required: [] } },
      requires_approval: false,
      dangerous: false,
    }, async () => "Error: this is descriptive text");

    const result = await runtime.execute(
      { id: "error-like", name: "description", arguments: {} },
      makeShellContext(),
    );

    expect(result.is_error).toBe(false);
  });
});

describe("foreground MCP outcomes", () => {
  test("HTTP non-OK responses are errors", async () => {
    const workspace = makeWorkspace();
    writeMcpConfig(workspace, { url: "https://mcp.invalid" });
    globalThis.fetch = (async () => new Response("upstream failed", { status: 502 })) as typeof fetch;

    const result = await makeMcpRuntime(workspace).execute(
      { id: "mcp-http", name: "mcp_call_tool", arguments: { server: "alpha", tool: "ping" } },
      makeExecutionContext("chat", makeConfig(workspace), { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("execution_error");
    expect(result.output).toContain("502");
  });

  test("malformed HTTP JSON is an error", async () => {
    const workspace = makeWorkspace();
    writeMcpConfig(workspace, { url: "https://mcp.invalid" });
    globalThis.fetch = (async () => new Response("{", { status: 200 })) as typeof fetch;

    const result = await makeMcpRuntime(workspace).execute(
      { id: "mcp-json", name: "mcp_call_tool", arguments: { server: "alpha", tool: "ping" } },
      makeExecutionContext("chat", makeConfig(workspace), { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("protocol_error");
  });

  test("mismatched JSON-RPC response identities are errors", async () => {
    const workspace = makeWorkspace();
    writeMcpConfig(workspace, { url: "https://mcp.invalid" });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "wrong-request",
      result: {},
    }), { status: 200 })) as typeof fetch;

    const result = await makeMcpRuntime(workspace).execute(
      { id: "mcp-identity", name: "mcp_call_tool", arguments: { server: "alpha", tool: "ping" } },
      makeExecutionContext("chat", makeConfig(workspace), { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("protocol_error");
  });

  test("JSON-RPC errors are errors", async () => {
    const workspace = makeWorkspace();
    writeMcpConfig(workspace, { url: "https://mcp.invalid" });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "remote failure" },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await makeMcpRuntime(workspace).execute(
      { id: "mcp-rpc", name: "mcp_call_tool", arguments: { server: "alpha", tool: "ping" } },
      makeExecutionContext("chat", makeConfig(workspace), { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("protocol_error");
    expect(result.output).toContain("remote failure");
  });

  test("HTTP requests receive the caller signal", async () => {
    const workspace = makeWorkspace();
    writeMcpConfig(workspace, { url: "https://mcp.invalid" });
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("request was not cancelled")), 200);
        observedSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const pending = makeMcpRuntime(workspace).execute(
      { id: "mcp-cancel", name: "mcp_call_tool", arguments: { server: "alpha", tool: "ping" } },
      makeExecutionContext("chat", makeConfig(workspace), {
        requestApproval: async () => true,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort("operator cancelled"), 20);
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("cancelled");
  }, 2_000);

  test("stdio child exit is an error", async () => {
    const workspace = makeWorkspace();
    writeMcpConfig(workspace, { command: "sh", args: ["-c", "exit 7"] });
    const result = await makeMcpRuntime(workspace).execute(
      { id: "mcp-stdio-exit", name: "mcp_call_tool", arguments: { server: "alpha", tool: "ping" } },
      makeExecutionContext("chat", makeConfig(workspace), { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("execution_error");
  }, 2_000);

  test("stdio timeout terminates the child before returning", async () => {
    const workspace = makeWorkspace();
    const cfg = makeConfig(workspace);
    const result = await mcpRequest(
      "alpha",
      { command: "sh", args: ["-c", "sleep 1"] },
      "tools/call",
      {},
      cfg,
      { timeoutMs: 20 },
    ).then(() => null, (error) => error);

    expect(result).toBeInstanceOf(Error);
    expect((result as any).code).toBe("timeout");
  }, 2_000);

  test("a valid empty stdio result is successful", async () => {
    const workspace = makeWorkspace();
    writeMcpConfig(workspace, { command: "sh", args: ["-c", "cat"] });
    const result = await makeMcpRuntime(workspace).execute(
      { id: "mcp-stdio-success", name: "mcp_call_tool", arguments: { server: "alpha", tool: "ping" } },
      makeExecutionContext("chat", makeConfig(workspace), { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toBe("{}");
  }, 2_000);
});

describe("foreground delegate outcomes", () => {
  test("foreground task lookup failure is an error", async () => {
    const runtime = createToolRuntime();
    registerTaskBundle(runtime);
    const cfg = makeConfig(makeWorkspace());
    const result = await runtime.execute(
      { id: "task-missing", name: "task_get", arguments: { id: "missing-foreground-task" } },
      makeExecutionContext("chat", cfg),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("execution_error");
  });

  test("delegate model failure is not returned as successful text", async () => {
    const workspace = makeWorkspace();
    const cfg = makeConfig(workspace);
    cfg.claude_cli.enabled = false;
    cfg.active_backend = "ollama";
    globalThis.fetch = (async () => new Response("model unavailable", { status: 503 })) as typeof fetch;
    const runtime = createToolRuntime();
    registerTaskBundle(runtime);

    const result = await runtime.execute(
      { id: "agent-failure", name: "agent", arguments: { prompt: "inspect" } },
      makeExecutionContext("chat", cfg, { requestApproval: async () => true }),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("execution_error");
  });

  test("delegate request receives caller cancellation", async () => {
    const workspace = makeWorkspace();
    const cfg = makeConfig(workspace);
    cfg.claude_cli.enabled = false;
    cfg.active_backend = "ollama";
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("request was not cancelled")), 250);
        observedSignal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const runtime = createToolRuntime();
    registerTaskBundle(runtime);
    const pending = runtime.execute(
      { id: "agent-cancel", name: "agent", arguments: { prompt: "inspect" } },
      makeExecutionContext("chat", cfg, {
        requestApproval: async () => true,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort("operator cancelled"), 20);
    const result = await pending;

    expect(observedSignal?.aborted).toBe(true);
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("cancelled");
  }, 2_000);
});

test("failed shell execution cannot satisfy command evidence", async () => {
  const runtime = makeShellRuntime();
  const result = await runtime.execute(
    { id: "evidence-failure", name: "bash", arguments: { command: "exit 9" } },
    makeShellContext(),
  );
  const assessment = assessWorkspaceEvidence([{
    call_id: result.call_id,
    name: result.name,
    arguments: { command: "exit 9" },
    output: result.output,
    is_error: result.is_error,
    error_code: result.error_code,
  }], "Run the command", undefined, {}, "command");

  expect(result.is_error).toBe(true);
  expect(assessment.sufficient).toBe(false);
});
