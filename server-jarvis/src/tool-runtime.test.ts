import { describe, expect, spyOn, test } from "bun:test";
import { defaultConfig } from "./config";
import type { JarvisConfig } from "./config";
import {
  createToolRuntime,
  makeExecutionContext,
  TOOL_TIMEOUT_REASON,
} from "./tool-runtime";
import type { ExecutionContext, ToolDefinition } from "./tool-runtime";
import * as ToolRuntimeModule from "./tool-runtime";
import { createApprovalRegistry } from "./approval-registry";

// ─── P1-06: Jarvis Tool Runtime Contract ─────────────────────────────────────
// Tests verify behavior through the public ToolRuntime interface only.
// No inspection of internal registries or dispatch tables.

const cfg = defaultConfig();

function makeCtx(surface: ExecutionContext["surface"] = "chat"): ExecutionContext {
  return { surface, interactive: surface === "chat", config: cfg };
}

/** Minimal tool definition for tests — no real implementation needed. */
function makeDef(name: string, required: string[] = []): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `Test tool: ${name}`,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          required.map((r) => [r, { type: "string", description: r }]),
        ),
        required,
      },
    },
    requires_approval: false,
    dangerous: false,
  };
}

describe("ToolRuntime", () => {
  test("toolResultModelText surfaces error detail and preserves successful output", () => {
    const helper = (ToolRuntimeModule as typeof ToolRuntimeModule & {
      toolResultModelText?: (result: any) => string;
    }).toolResultModelText;
    expect(typeof helper).toBe("function");
    expect(helper?.({ output: "", error: "boom", is_error: true })).toBe("boom");
    expect(helper?.({ output: "ok", is_error: false })).toBe("ok");
    expect(helper?.({ output: "", is_error: true })).toBe("Tool failed with no error detail.");
  });

  // ── Tracer bullet ──────────────────────────────────────────────────────────

  test("registered tool executes and returns ToolResult with is_error:false", async () => {
    const runtime = createToolRuntime();
    runtime.register(makeDef("echo"), async (args) => `pong: ${args.msg ?? ""}`);

    const result = await runtime.execute(
      { id: "call-1", name: "echo", arguments: { msg: "hello" } },
      makeCtx(),
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toBe("pong: hello");
    expect(result.call_id).toBe("call-1");
    expect(result.name).toBe("echo");
    expect(typeof result.duration_ms).toBe("number");
  });

  test("filesystem path alias is normalized before validation and dispatch", async () => {
    const runtime = createToolRuntime();
    let received: Record<string, unknown> | undefined;
    runtime.register(makeDef("list_directory", ["path"]), async (args) => {
      received = args;
      return "listed";
    });

    const result = await runtime.execute(
      {
        id: "call-path-alias",
        name: "list_directory",
        arguments: { relative_workspace_path: "src/app" },
      },
      makeCtx(),
    );

    expect(result.is_error).toBe(false);
    expect(received?.path).toBe("src/app");
  });

  test("empty filesystem path alias does not bypass required argument validation", async () => {
    const runtime = createToolRuntime();
    runtime.register(makeDef("read_file", ["path"]), async () => "unexpected");

    const result = await runtime.execute(
      {
        id: "call-empty-path-alias",
        name: "read_file",
        arguments: { relative_workspace_path: "   " },
      },
      makeCtx(),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("missing_args");
  });

  // ── Unknown tool ───────────────────────────────────────────────────────────

  test("executing unknown tool returns is_error:true containing the tool name", async () => {
    const runtime = createToolRuntime();

    const result = await runtime.execute(
      { id: "call-x", name: "no_such_tool", arguments: {} },
      makeCtx(),
    );

    expect(result.is_error).toBe(true);
    expect(result.output).toContain("no_such_tool");
    expect(result.call_id).toBe("call-x");
  });

  // ── Handler throw normalization ────────────────────────────────────────────

  test("handler throw is caught and returns is_error:true without propagating", async () => {
    const runtime = createToolRuntime();
    runtime.register(makeDef("bomb"), async () => {
      throw new Error("handler exploded");
    });

    const result = await runtime.execute(
      { id: "call-2", name: "bomb", arguments: {} },
      makeCtx(),
    );

    expect(result.is_error).toBe(true);
    expect(result.error).toContain("handler exploded");
    // Must NOT throw — the promise must resolve
  });

  // ── Surface parity ─────────────────────────────────────────────────────────

  test("same call from chat and agent surfaces returns identical output", async () => {
    const runtime = createToolRuntime();
    runtime.register(makeDef("greet"), async (args, ctx) => `hello from ${ctx.surface}`);

    // chat surface
    const chatResult = await runtime.execute(
      { id: "call-3a", name: "greet", arguments: {} },
      makeCtx("chat"),
    );

    // agent surface
    const agentResult = await runtime.execute(
      { id: "call-3b", name: "greet", arguments: {} },
      makeCtx("agent"),
    );

    // Both execute the same handler — surface is available inside but
    // the routing/dispatch path must be identical
    expect(chatResult.is_error).toBe(false);
    expect(agentResult.is_error).toBe(false);
    // The handler can see surface; what matters is same code path was taken
    expect(chatResult.output).toBe("hello from chat");
    expect(agentResult.output).toBe("hello from agent");
  });

  // ── Duplicate registration ─────────────────────────────────────────────────

  test("registering the same tool name twice throws at registration time", () => {
    const runtime = createToolRuntime();
    runtime.register(makeDef("dupe"), async () => "first");

    expect(() => {
      runtime.register(makeDef("dupe"), async () => "second");
    }).toThrow();
  });

  // ── Missing required argument ──────────────────────────────────────────────

  test("missing required argument returns is_error:true without invoking the handler", async () => {
    const runtime = createToolRuntime();
    let handlerCalled = false;
    runtime.register(makeDef("needs_arg", ["required_param"]), async () => {
      handlerCalled = true;
      return "should not reach here";
    });

    const result = await runtime.execute(
      { id: "call-4", name: "needs_arg", arguments: {} },
      makeCtx(),
    );

    expect(result.is_error).toBe(true);
    expect(handlerCalled).toBe(false);
    expect(result.output).toContain("required_param");
  });

  // ── listTools ──────────────────────────────────────────────────────────────

  test("listTools returns all registered tool definitions", () => {
    const runtime = createToolRuntime();
    runtime.register(makeDef("tool_a"), async () => "a");
    runtime.register(makeDef("tool_b"), async () => "b");

    const tools = runtime.listTools();
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("tool_a");
    expect(names).toContain("tool_b");
  });

  // ── is_error: no false positives on error-like strings ────────────────────

  test("handler returning a string that starts with 'Error:' does not set is_error:true", async () => {
    const runtime = createToolRuntime();
    runtime.register(
      makeDef("describe_error"),
      async () => "Error: this is a description, not a failure",
    );

    const result = await runtime.execute(
      { id: "call-fp", name: "describe_error", arguments: {} },
      makeCtx(),
    );

    expect(result.is_error).toBe(false);
    expect(result.output).toBe("Error: this is a description, not a failure");
  });
});

// ─── P1-07: Execution Context Model ──────────────────────────────────────────
// Tests verify makeExecutionContext defaults and override behaviour.

describe("ExecutionContext", () => {
  // ── Surface → interactive default ─────────────────────────────────────────

  test("chat surface has interactive:true by default", () => {
    const ctx = makeExecutionContext("chat", cfg);
    expect(ctx.interactive).toBe(true);
  });

  test("agent surface has interactive:false by default", () => {
    expect(makeExecutionContext("agent", cfg).interactive).toBe(false);
  });

  test("cron surface has interactive:false by default", () => {
    expect(makeExecutionContext("cron", cfg).interactive).toBe(false);
  });

  test("mcp surface has interactive:false by default", () => {
    expect(makeExecutionContext("mcp", cfg).interactive).toBe(false);
  });

  // ── Override interactive ───────────────────────────────────────────────────

  test("interactive can be overridden to true on a non-chat surface", () => {
    const ctx = makeExecutionContext("agent", cfg, { interactive: true });
    expect(ctx.interactive).toBe(true);
  });

  // ── timeout_ms ────────────────────────────────────────────────────────────

  test("timeout_ms defaults to undefined when not set", () => {
    const ctx = makeExecutionContext("chat", cfg);
    expect(ctx.timeout_ms).toBeUndefined();
  });

  test("timeout_ms is propagated to the context when set", () => {
    const ctx = makeExecutionContext("chat", cfg, { timeout_ms: 5000 });
    expect(ctx.timeout_ms).toBe(5000);
  });

  // ── agents_root ───────────────────────────────────────────────────────────

  test("agents_root defaults to undefined (falls back to config.agents_root)", () => {
    const ctx = makeExecutionContext("chat", cfg);
    expect(ctx.agents_root).toBeUndefined();
  });

  test("agents_root override is preserved in context", () => {
    const ctx = makeExecutionContext("agent", cfg, { agents_root: "/custom/agents" });
    expect(ctx.agents_root).toBe("/custom/agents");
  });

  // ── workspace_path ────────────────────────────────────────────────────────

  test("workspace_path defaults to undefined (unrestricted)", () => {
    const ctx = makeExecutionContext("chat", cfg);
    expect(ctx.workspace_path).toBeUndefined();
  });

  test("workspace_path override is preserved in context", () => {
    const ctx = makeExecutionContext("agent", cfg, { workspace_path: "/workspace/project" });
    expect(ctx.workspace_path).toBe("/workspace/project");
  });
});

// ─── P1-08: Runtime Permission Policy Layer ───────────────────────────────────
// Tests verify policy is enforced inside execute() — not at prompt level.

describe("ToolRuntime permission policy", () => {
  /** Build a config override for tools settings only. */
  function makeToolsCfg(overrides: Partial<JarvisConfig["tools"]>): JarvisConfig {
    const base = defaultConfig();
    base.tools = { ...base.tools, ...overrides };
    return base;
  }

  /** Tool definition with custom approval/dangerous flags. */
  function makeDefWithFlags(
    name: string,
    flags: { requires_approval?: boolean; dangerous?: boolean } = {},
  ): ToolDefinition {
    return { ...makeDef(name), ...flags };
  }

  // ── allow path ────────────────────────────────────────────────────────────

  test("non-approval-required safe tool executes in any surface", async () => {
    const runtime = createToolRuntime();
    runtime.register(makeDef("safe_tool"), async () => "ok");
    const result = await runtime.execute(
      { id: "c1", name: "safe_tool", arguments: {} },
      makeExecutionContext("cron", defaultConfig()),
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toBe("ok");
  });

  // ── deny path: tools globally disabled ────────────────────────────────────

  test("any tool call is denied when config.tools.enabled is false", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ enabled: false });
    runtime.register(makeDef("any_tool"), async () => "result");
    const ctx = makeExecutionContext("chat", cfg);
    const result = await runtime.execute({ id: "c2", name: "any_tool", arguments: {} }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.error).toMatch(/disabled/i);
    expect(result.error_code).toBe("policy_denied");
  });

  test("unknown tool returns error_code unknown_tool", async () => {
    const runtime = createToolRuntime();
    const result = await runtime.execute(
      { id: "c0", name: "missing_tool", arguments: {} },
      makeExecutionContext("chat", defaultConfig()),
    );
    expect(result.error_code).toBe("unknown_tool");
  });

  // ── ask path: requires_approval → interactive allowed ─────────────────────

  test("approval-required tool in interactive chat WITHOUT an approval hook is DENIED when interactive approval is enabled", async () => {
    // Regression: the old behavior let an approval-gated tool fall through and
    // execute when the surface provided no requestApproval hook. That silently
    // ran writes/shell unapproved. It must now deny with approval_unavailable.
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ interactive_approval: true });
    let handlerRan = false;
    runtime.register(
      makeDefWithFlags("gated_chat", { requires_approval: true }),
      async () => { handlerRan = true; return "should not run"; },
    );
    const result = await runtime.execute(
      { id: "c3", name: "gated_chat", arguments: {} },
      makeExecutionContext("chat", cfg),
    );
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("approval_required");
    expect(handlerRan).toBe(false);
  });

  test("approval-required chat tool without a hook is denied even with interactive approval disabled", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ interactive_approval: false });
    let handlerRan = false;
    runtime.register(
      makeDefWithFlags("gated_passthrough", { requires_approval: true }),
      async () => { handlerRan = true; return "passthrough result"; },
    );
    const result = await runtime.execute(
      { id: "c3b", name: "gated_passthrough", arguments: {} },
      makeExecutionContext("chat", cfg),
    );
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("approval_required");
    expect(result.output).toContain("this surface cannot prompt");
    expect(handlerRan).toBe(false);
  });

  test("chat cannot skip config-required approval when interactive approval is disabled", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ interactive_approval: false, require_approval: ["gated"] });
    let handlerRan = false;
    runtime.register(makeDef("gated"), async () => { handlerRan = true; return "ran"; });
    const result = await runtime.execute(
      { id: "c3c", name: "gated", arguments: {} },
      makeExecutionContext("chat", cfg, {
        skip_approval_gate: true,
        requestApproval: async () => false,
      }),
    );
    expect(result.error_code).toBe("approval_rejected");
    expect(handlerRan).toBe(false);
  });

  test("cron cannot skip approval for a tool even in permissive mode", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ sandbox_mode: "permissive", require_approval: [] });
    runtime.register(makeDefWithFlags("shell", { requires_approval: true }), async () => "must not run");
    const result = await runtime.execute(
      { id: "cron-gated", name: "shell", arguments: {} },
      makeExecutionContext("cron", cfg, { skip_approval_gate: true }),
    );
    expect(result.error_code).toBe("policy_denied");
  });

  test("approval-required tool runs when the approval hook approves", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ interactive_approval: true });
    runtime.register(
      makeDefWithFlags("gated_chat", { requires_approval: true }),
      async () => "approved result",
    );
    const result = await runtime.execute(
      { id: "c3", name: "gated_chat", arguments: {} },
      makeExecutionContext("chat", cfg, { requestApproval: async () => true }),
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toBe("approved result");
  });

  test("approval-required tool is rejected when the approval hook declines", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ interactive_approval: true });
    let handlerRan = false;
    runtime.register(
      makeDefWithFlags("gated_chat", { requires_approval: true }),
      async () => { handlerRan = true; return "should not run"; },
    );
    const result = await runtime.execute(
      { id: "c3", name: "gated_chat", arguments: {} },
      makeExecutionContext("chat", cfg, { requestApproval: async () => false }),
    );
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("approval_rejected");
    expect(handlerRan).toBe(false);
  });

  // ── ask path: requires_approval → non-interactive denied ─────────────────

  test("approval-required tool in non-interactive context is denied without invoking handler", async () => {
    const runtime = createToolRuntime();
    let handlerCalled = false;
    runtime.register(
      makeDefWithFlags("gated_cron", { requires_approval: true }),
      async () => { handlerCalled = true; return "should not run"; },
    );
    const ctx = makeExecutionContext("cron", defaultConfig());
    const result = await runtime.execute({ id: "c4", name: "gated_cron", arguments: {} }, ctx);
    expect(result.is_error).toBe(true);
    expect(handlerCalled).toBe(false);
    expect(result.error).toMatch(/non-interactive|approval/i);
  });

  // ── config require_approval list → non-interactive denied ─────────────────

  test("tool listed in config.tools.require_approval is denied in non-interactive context", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ require_approval: ["cfg_gated"] });
    // Definition has requires_approval: false — config overrides it
    runtime.register(makeDef("cfg_gated"), async () => "result");
    const ctx = makeExecutionContext("agent", cfg);
    const result = await runtime.execute({ id: "c5", name: "cfg_gated", arguments: {} }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.error).toMatch(/non-interactive|approval/i);
  });

  // ── dangerous + strict + non-interactive → denied ─────────────────────────

  test("dangerous tool in strict sandbox + non-interactive context is denied", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ sandbox_mode: "strict", require_approval: [] });
    runtime.register(
      makeDefWithFlags("dangerous_tool", { dangerous: true, requires_approval: false }),
      async () => "boom",
    );
    const ctx = makeExecutionContext("cron", cfg);
    const result = await runtime.execute({ id: "c6", name: "dangerous_tool", arguments: {} }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.error).toMatch(/dangerous|sandbox/i);
  });

  // ── dangerous + permissive + non-interactive → allowed ────────────────────

  test("dangerous tool in permissive sandbox + non-interactive context is allowed", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ sandbox_mode: "permissive", require_approval: [] });
    runtime.register(
      makeDefWithFlags("permissive_danger", { dangerous: true, requires_approval: false }),
      async () => "ran",
    );
    const ctx = makeExecutionContext("cron", cfg);
    const result = await runtime.execute({ id: "c7", name: "permissive_danger", arguments: {} }, ctx);
    expect(result.is_error).toBe(false);
    expect(result.output).toBe("ran");
  });

  test("dangerous interactive tool requires an approval decision by default", async () => {
    const runtime = createToolRuntime();
    const cfg = makeToolsCfg({ sandbox_mode: "strict", interactive_approval: true, require_approval: [] });
    runtime.register(
      makeDefWithFlags("shell_execute", { dangerous: true, requires_approval: false }),
      async () => "unexpected",
    );
    const result = await runtime.execute(
      { id: "d1", name: "shell_execute", arguments: { command: "echo safe" } },
      makeExecutionContext("chat", cfg),
    );
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("approval_required");
  });
});

// ─── Track B: blocking approval callback ──────────────────────────────────────
// When ctx.requestApproval is supplied, an "ask" decision must await it and
// only run the handler on approval. No callback → backward-compatible passthrough.

describe("ToolRuntime approval callback", () => {
  function cfgWithInteractiveApproval(): JarvisConfig {
    const cfg = defaultConfig();
    cfg.tools = { ...cfg.tools, interactive_approval: true };
    return cfg;
  }

  function makeDefWithFlags(
    name: string,
    flags: { requires_approval?: boolean; dangerous?: boolean } = {},
  ): ToolDefinition {
    return { ...makeDef(name), ...flags };
  }

  test("ask + requestApproval(true) runs the handler and returns success", async () => {
    const runtime = createToolRuntime();
    const cfg = cfgWithInteractiveApproval();
    let handlerCalled = false;
    runtime.register(
      makeDefWithFlags("gated_ok", { requires_approval: true }),
      async () => { handlerCalled = true; return "did the thing"; },
    );
    const ctx = makeExecutionContext("chat", cfg, {
      requestApproval: async () => true,
    });
    const result = await runtime.execute({ id: "a1", name: "gated_ok", arguments: {} }, ctx);
    expect(handlerCalled).toBe(true);
    expect(result.is_error).toBe(false);
    expect(result.output).toBe("did the thing");
  });

  test("ask + requestApproval(false) denies and does NOT run the handler", async () => {
    const runtime = createToolRuntime();
    const cfg = cfgWithInteractiveApproval();
    let handlerCalled = false;
    runtime.register(
      makeDefWithFlags("gated_no", { requires_approval: true }),
      async () => { handlerCalled = true; return "should not run"; },
    );
    const ctx = makeExecutionContext("chat", cfg, {
      requestApproval: async () => false,
    });
    const result = await runtime.execute({ id: "a2", name: "gated_no", arguments: {} }, ctx);
    expect(handlerCalled).toBe(false);
    expect(result.is_error).toBe(true);
    expect(result.error).toMatch(/reject|denied|approval/i);
  });

  /** Run `fn` with console.error silenced — these paths log by design. */
  async function withoutErrorLog<T>(fn: () => Promise<T>): Promise<T> {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  }

  test("ask + an approval id that is already pending returns approval_unavailable and does not run the handler", async () => {
    // Regression (DD-090): the registry rejects a duplicate pending call id.
    // That rejection used to escape execute(), aborting the turn with a raw
    // error string and leaving the streamed tool card with no result.
    const runtime = createToolRuntime();
    const cfg = cfgWithInteractiveApproval();
    const registry = createApprovalRegistry({ dbPath: ":memory:" });
    const first = registry.request({
      call_id: "a5",
      tool_name: "gated_dup",
      arguments: {},
      policy_source: "tool_requires_approval",
    });
    let handlerCalled = false;
    runtime.register(
      makeDefWithFlags("gated_dup", { requires_approval: true }),
      async () => { handlerCalled = true; return "should not run"; },
    );
    const ctx = makeExecutionContext("chat", cfg, {
      requestApproval: (req) =>
        registry.request({
          call_id: req.call_id,
          tool_name: req.name,
          arguments: req.arguments,
          policy_source: req.policy_source,
        }),
    });

    const result = await withoutErrorLog(() =>
      runtime.execute({ id: "a5", name: "gated_dup", arguments: {} }, ctx),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("approval_unavailable");
    expect(result.call_id).toBe("a5");
    expect(result.name).toBe("gated_dup");
    expect(result.error).toContain("gated_dup");
    expect(result.error).toMatch(/approval could not be requested/i);
    expect(handlerCalled).toBe(false);

    // Release the deliberately-blocking first request so no timer outlives us.
    registry.resolve("a5", false);
    expect(await first).toBe(false);
  });

  test("ask + an approval request that throws returns approval_unavailable instead of throwing", async () => {
    // Regression (DD-090): a failing durable audit insert (or any registry
    // throw) used to reject out of execute() and abort the turn.
    const runtime = createToolRuntime();
    const cfg = cfgWithInteractiveApproval();
    let handlerCalled = false;
    runtime.register(
      makeDefWithFlags("gated_broken", { requires_approval: true }),
      async () => { handlerCalled = true; return "should not run"; },
    );
    const ctx = makeExecutionContext("chat", cfg, {
      requestApproval: async () => {
        throw new Error("SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: approval_records.request_id");
      },
    });

    const result = await withoutErrorLog(() =>
      runtime.execute({ id: "a6", name: "gated_broken", arguments: {} }, ctx),
    );

    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("approval_unavailable");
    expect(result.call_id).toBe("a6");
    expect(result.name).toBe("gated_broken");
    expect(result.error).toContain("gated_broken");
    expect(result.error).toMatch(/approval could not be requested/i);
    // Storage text is diagnostics, not model-facing content.
    expect(result.error).not.toContain("SQLITE");
    expect(handlerCalled).toBe(false);
  });

  test("requestApproval receives the call id, name, arguments, and policy source", async () => {
    const runtime = createToolRuntime();
    const cfg = cfgWithInteractiveApproval();
    let seen: any = null;
    runtime.register(
      makeDefWithFlags("gated_info", { requires_approval: true }),
      async () => "ok",
    );
    const ctx = makeExecutionContext("chat", cfg, {
      requestApproval: async (req) => { seen = req; return true; },
    });
    await runtime.execute({ id: "a3", name: "gated_info", arguments: { path: "/x" } }, ctx);
    expect(seen.call_id).toBe("a3");
    expect(seen.name).toBe("gated_info");
    expect(seen.arguments).toEqual({ path: "/x" });
    expect(seen.policy_source).toBe("tool_requires_approval");
  });

  test("allow-policy tools never invoke requestApproval", async () => {
    const runtime = createToolRuntime();
    let asked = false;
    runtime.register(makeDef("safe_noask"), async () => "ok");
    const ctx = makeExecutionContext("chat", defaultConfig(), {
      requestApproval: async () => { asked = true; return true; },
    });
    const result = await runtime.execute({ id: "a4", name: "safe_noask", arguments: {} }, ctx);
    expect(asked).toBe(false);
    expect(result.is_error).toBe(false);
  });
});

// ─── DD-172: caller aborts carry their reason into the result envelope ───────
// The runtime reports its own `ctx.timeout_ms` expiry as `timeout`. A caller
// that aborts with `TOOL_TIMEOUT_REASON` (its own budget expired) must get the
// same truthful label; only a plain abort is a `cancelled`.

describe("ToolRuntime caller stop labelling", () => {
  /**
   * Register a handler that never settles on its own. It settles only when the
   * signal it is handed aborts — like `fetch` or a subprocess waiting on
   * cancellation — so the runtime's stop path is what produces the result.
   */
  function registerHangingTool(
    runtime: ReturnType<typeof createToolRuntime>,
    name: string,
  ): void {
    runtime.register(makeDef(name), (_args, ctx) =>
      new Promise<string>((_resolve, reject) => {
        const signal = ctx.signal;
        if (!signal) return; // no signal → intentionally never settles
        const stop = () => reject(new Error("tool stopped"));
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }),
    );
  }

  test("a caller abort with TOOL_TIMEOUT_REASON reports error_code timeout", async () => {
    const runtime = createToolRuntime();
    registerHangingTool(runtime, "hangs_caller_timeout");
    const controller = new AbortController();
    const ctx = makeExecutionContext("chat", cfg, { signal: controller.signal });

    const started = Date.now();
    const pending = runtime.execute(
      { id: "stop-timeout", name: "hangs_caller_timeout", arguments: {} },
      ctx,
    );
    setTimeout(() => controller.abort(TOOL_TIMEOUT_REASON), 5);
    const result = await pending;

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("timeout");
    expect(result.error).toBe("Tool execution timed out");
    expect(result.output).toBe("Tool execution timed out");
    expect(typeof result.duration_ms).toBe("number");
  });

  test("a caller abort with a plain reason reports error_code cancelled", async () => {
    const runtime = createToolRuntime();
    registerHangingTool(runtime, "hangs_caller_cancel");
    const controller = new AbortController();
    const ctx = makeExecutionContext("chat", cfg, { signal: controller.signal });

    const started = Date.now();
    const pending = runtime.execute(
      { id: "stop-cancel", name: "hangs_caller_cancel", arguments: {} },
      ctx,
    );
    setTimeout(() => controller.abort("user_cancelled"), 5);
    const result = await pending;

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("cancelled");
    expect(result.error).toBe("Tool execution cancelled");
    expect(typeof result.duration_ms).toBe("number");
  });

  test("the runtime's own ctx.timeout_ms still reports error_code timeout", async () => {
    const runtime = createToolRuntime();
    registerHangingTool(runtime, "hangs_runtime_timeout");
    // No caller signal: only the inner timer can stop this tool.
    const ctx = makeExecutionContext("chat", cfg, { timeout_ms: 10 });

    const started = Date.now();
    const result = await runtime.execute(
      { id: "stop-runtime-timeout", name: "hangs_runtime_timeout", arguments: {} },
      ctx,
    );

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("timeout");
    expect(result.error).toBe("Tool execution timed out after 10ms");
    expect(typeof result.duration_ms).toBe("number");
  });
});
