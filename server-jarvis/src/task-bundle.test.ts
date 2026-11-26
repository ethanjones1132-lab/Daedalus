import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createToolRuntime, makeExecutionContext, TOOL_TIMEOUT_REASON, ToolExecutionError, type ExecutionContext } from "./tool-runtime";
import { registerTaskBundle, registerTaskControlBundle } from "./task-bundle";
import { defaultConfig } from "./config";
import {
  DEFAULT_BG_COMMAND_TIMEOUT_MS,
  MAX_BG_COMMAND_TIMEOUT_MS,
  MIN_BG_COMMAND_TIMEOUT_MS,
  resolveBackgroundCommandTimeoutMs,
  toolAgent,
  toolTaskGet,
  toolTaskStop,
} from "./agent-tools";

/** Bound for "the tool must stop promptly", not the request's own timeout. */
const PROMPT_STOP_BOUND_MS = 2_000;

/** Wait for `promise`, failing (instead of hanging) if it outlives `ms`. */
async function withinBound<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`tool still running after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A `fetch` stub that accepts the request and never answers, recording the
 * abort the tool is supposed to deliver to it.
 */
function hangingFetch() {
  const state = {
    requests: 0,
    aborted: 0,
    fetch: undefined as unknown as typeof fetch,
  };
  state.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    state.requests += 1;
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = (): void => {
        state.aborted += 1;
        reject(new Error("model request aborted"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as typeof fetch;
  return state;
}

function modelCfg() {
  const cfg = defaultConfig();
  // Force the native model branch: no Claude CLI spawn in these tests.
  cfg.claude_cli.enabled = false;
  return cfg;
}

function makeRuntime() {
  const rt = createToolRuntime();
  registerTaskBundle(rt);
  return rt;
}
function ctx(overrides?: Pick<ExecutionContext, "requestApproval">) {
  const cfg = defaultConfig();
  cfg.tools.enabled = true;
  return makeExecutionContext("chat", cfg, overrides);
}
function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${name}`, name, arguments: args };
}

describe("task bundle", () => {
  test("registers all 7 task tools", () => {
    const names = makeRuntime().listTools().map((t) => t.function.name).sort();
    expect(names).toEqual([
      "agent", "run_background_command", "task_create",
      "task_get", "task_list", "task_output", "task_stop",
    ]);
  });

  test("task-control registration is the non-spawning subset for delegate MCP", () => {
    const rt = createToolRuntime();
    registerTaskControlBundle(rt);
    expect(rt.listTools().map((t) => t.function.name).sort()).toEqual([
      "task_get", "task_list", "task_output", "task_stop",
    ]);
  });

  test("only the process-spawning tools are dangerous + approval-required", () => {
    const defs = Object.fromEntries(makeRuntime().listTools().map((d) => [d.function.name, d]));
    for (const n of ["run_background_command", "agent", "task_create"]) {
      expect(defs[n].dangerous).toBe(true);
      expect(defs[n].requires_approval).toBe(true);
    }
    for (const n of ["task_list", "task_get", "task_output", "task_stop"]) {
      expect(defs[n].dangerous).toBe(false);
      expect(defs[n].requires_approval).toBe(false);
    }
  });

  test("task_list executes without spawning anything", async () => {
    const result = await makeRuntime().execute(call("task_list", {}), ctx());
    expect(result.is_error).toBe(false);
    expect(typeof result.output).toBe("string");
  });

  test("task_get without an id is rejected by runtime validation", async () => {
    const result = await makeRuntime().execute(call("task_get", {}), ctx());
    expect(result.is_error).toBe(true);
    expect(result.error).toContain("Missing required argument");
  });

  test("run_background_command schema advertises timeout_ms", () => {
    const def = makeRuntime().listTools().find((t) => t.function.name === "run_background_command");
    expect(def).toBeDefined();
    const props = def!.function.parameters.properties as Record<string, unknown>;
    expect(props.timeout_ms).toBeDefined();
  });

  test("run_background_command without a chat approval hook is denied before invoking its handler", async () => {
    const runtime = createToolRuntime();
    const backgroundHandler = mock(async () => "unexpected execution");
    // Keep the bundle's real definition, but never spawn a process in this test.
    registerTaskBundle({
      ...runtime,
      register(def, handler) {
        runtime.register(def, def.function.name === "run_background_command" ? backgroundHandler : handler);
      },
    });

    const result = await runtime.execute(
      call("run_background_command", { command: "echo approval-required" }),
      ctx(),
    );
    expect(result.is_error).toBe(true);
    expect(result.error_code).toBe("approval_required");
    expect(backgroundHandler).not.toHaveBeenCalled();
  });
});

describe("resolveBackgroundCommandTimeoutMs", () => {
  test("defaults to 5 minutes when omitted", () => {
    expect(resolveBackgroundCommandTimeoutMs(undefined)).toBe(DEFAULT_BG_COMMAND_TIMEOUT_MS);
    expect(resolveBackgroundCommandTimeoutMs("nope")).toBe(DEFAULT_BG_COMMAND_TIMEOUT_MS);
  });

  test("clamps below the floor and above the ceiling", () => {
    expect(resolveBackgroundCommandTimeoutMs(0)).toBe(MIN_BG_COMMAND_TIMEOUT_MS);
    expect(resolveBackgroundCommandTimeoutMs(-50)).toBe(MIN_BG_COMMAND_TIMEOUT_MS);
    expect(resolveBackgroundCommandTimeoutMs(MAX_BG_COMMAND_TIMEOUT_MS + 1)).toBe(
      MAX_BG_COMMAND_TIMEOUT_MS,
    );
  });

  test("honors an in-range request", () => {
    expect(resolveBackgroundCommandTimeoutMs(15_000)).toBe(15_000);
  });
});

describe("run_background_command timeout (live)", () => {
  test("kills a non-terminating child within the requested timeout_ms", async () => {
    // Regression for the 65-minute Phase-D hang: a model-spawned infinite
    // loop through run_background_command must not outlive timeout_ms.
    const runtime = makeRuntime();
    const context = ctx({ requestApproval: async () => true });
    // Use the host shell so the child actually starts and reaches the timeout.
    const hang = `node -e "setInterval(()=>{}, 1000)"`;
    const started = await runtime.execute(
      call("run_background_command", {
        command: hang,
        powershell: process.platform === "win32",
        timeout_ms: 1_500,
        description: "hang-for-timeout-test",
      }),
      context,
    );
    expect(started.is_error).toBe(false);
    expect(String(started.output)).toMatch(/Task ID: (bg_\w+)/);
    expect(String(started.output)).toContain("Timeout: 1500ms");
    const idMatch = String(started.output).match(/Task ID: (bg_\w+)/);
    expect(idMatch).toBeTruthy();
    const taskId = idMatch![1]!;

    // Wait past the timeout + a little slack for process reaping.
    await new Promise((r) => setTimeout(r, 4_000));

    const status = await toolTaskGet({ id: taskId });
    // Stop if still running so we do not leak across tests.
    if (status.includes("running")) {
      await toolTaskStop({ id: taskId });
    }
    expect(status).toMatch(/failed|stopped/);
    if (status.includes("failed")) {
      expect(status.toLowerCase()).toMatch(/timeout|timed out/);
    }
  }, 15_000);
});

describe("run_background_command tree kill on timeout (live)", () => {
  test("kills a grandchild that outlives the shell", async () => {
    // Regression for DD-169: on timeout only the shell was signalled, so a
    // child kept running after the task reported "timed out". The command
    // starts a node child (a grandchild of the tool process on POSIX) that
    // would write `late` 6s later, while the shell itself stays busy until
    // timeout_ms. If the whole tree is killed, the child dies long before
    // its 6s timer and `late` never appears.
    const dir = mkdtempSync(join(tmpdir(), "jarvis-bg-tree-kill-"));
    const startMarker = join(dir, "child-started.txt");
    const lateMarker = join(dir, "child-finished.txt");
    // One expression, no spaces/quotes/semicolons, so it survives both the
    // POSIX `bash -c` quoting and PowerShell's `$env:` expansion unchanged.
    // writeFileSync needs its data argument: a one-argument call throws
    // ERR_INVALID_ARG_TYPE before either marker is written, which would make
    // "the late marker is absent" pass for the wrong reason.
    const childCode =
      "(require(process.env.DD169_FS).writeFileSync(process.env.DD169_START,'')," +
      "setTimeout(()=>require(process.env.DD169_FS).writeFileSync(process.env.DD169_LATE,''),6000))";
    const command = process.platform === "win32"
      // node runs in the shell's foreground, so it is a real child in the
      // tree `taskkill /T /F` has to reach, and outlives the shell if only
      // the shell is killed.
      ? "node -e $env:DD169_CODE"
      : "node -e \"$DD169_CODE\" & sleep 30";
    const previousEnv = {
      code: process.env.DD169_CODE,
      fs: process.env.DD169_FS,
      start: process.env.DD169_START,
      late: process.env.DD169_LATE,
    };
    process.env.DD169_CODE = childCode;
    process.env.DD169_FS = "fs";
    process.env.DD169_START = startMarker;
    process.env.DD169_LATE = lateMarker;

    try {
      const started = await makeRuntime().execute(
        call("run_background_command", {
          command,
          powershell: process.platform === "win32",
          timeout_ms: 3_000,
          description: "tree-kill-for-timeout-test",
        }),
        ctx({ requestApproval: async () => true }),
      );
      expect(started.is_error).toBe(false);
      const idMatch = String(started.output).match(/Task ID: (bg_\w+)/);
      expect(idMatch).toBeTruthy();
      const taskId = idMatch![1]!;

      // 3s timeout + 1s exit grace + up to 2s kill confirmation, then the
      // child's 6s write (which must never happen). Leave slack for a slow
      // shell startup so the assertion is not vacuous.
      await new Promise((r) => setTimeout(r, 10_000));

      const status = await toolTaskGet({ id: taskId });
      if (status.includes("running")) {
        await toolTaskStop({ id: taskId });
      }
      // The grandchild really started, so "no late marker" means "killed",
      // not "never spawned".
      expect(existsSync(startMarker)).toBe(true);
      expect(existsSync(lateMarker)).toBe(false);
      expect(status).toMatch(/failed/);
      expect(status.toLowerCase()).toMatch(/timed out/);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        const envKey = `DD169_${key.toUpperCase()}`;
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
});

describe("agent model request stop paths (DD-171)", () => {
  test("a runtime timeout aborts the in-flight model fetch and reports timeout", async () => {
    // Today the caller's TOOL_TIMEOUT_REASON abort is skipped, so the fetch
    // keeps running until the request's own (long) timer: this must return
    // well before PROMPT_STOP_BOUND_MS instead.
    const cfg = modelCfg();
    const stub = hangingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub.fetch;
    const controller = new AbortController();
    const startedAt = Date.now();
    try {
      const pending = toolAgent(
        { prompt: "dd-171 runtime timeout", timeout_ms: 4_000 },
        cfg,
        makeExecutionContext("agent", cfg, { signal: controller.signal }),
      );
      // The request is issued synchronously; give it a beat, then time out.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stub.requests).toBe(1);
      controller.abort(TOOL_TIMEOUT_REASON);

      const outcome = await withinBound(
        pending.then(() => "resolved" as const, (error: unknown) => error),
        PROMPT_STOP_BOUND_MS,
      );
      expect(outcome).not.toBe("resolved");
      expect(outcome).toBeInstanceOf(ToolExecutionError);
      expect((outcome as ToolExecutionError).code).toBe("timeout");
      expect((outcome as ToolExecutionError).message).toContain("timed out");
      // The stub saw the abort, and it happened promptly.
      expect(stub.aborted).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(PROMPT_STOP_BOUND_MS);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a caller cancellation still reports cancelled, not timeout", async () => {
    const cfg = modelCfg();
    const stub = hangingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub.fetch;
    const controller = new AbortController();
    try {
      const pending = toolAgent(
        { prompt: "dd-171 cancel", timeout_ms: 4_000 },
        cfg,
        makeExecutionContext("agent", cfg, { signal: controller.signal }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stub.requests).toBe(1);
      controller.abort();

      const outcome = await withinBound(
        pending.then(() => "resolved" as const, (error: unknown) => error),
        PROMPT_STOP_BOUND_MS,
      );
      expect(outcome).not.toBe("resolved");
      expect(outcome).toBeInstanceOf(ToolExecutionError);
      expect((outcome as ToolExecutionError).code).toBe("cancelled");
      expect(stub.aborted).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the request's own timeout_ms still fires", async () => {
    // Pins the inner timer: a request that outlives its OWN timeout_ms aborts
    // even when no caller signal ever fires.
    const cfg = modelCfg();
    const stub = hangingFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = stub.fetch;
    const startedAt = Date.now();
    try {
      const outcome = await withinBound(
        toolAgent(
          { prompt: "dd-171 own timeout", timeout_ms: 250 },
          cfg,
          makeExecutionContext("agent", cfg),
        ).then(() => "resolved" as const, (error: unknown) => error),
        PROMPT_STOP_BOUND_MS,
      );
      expect(outcome).not.toBe("resolved");
      expect(outcome).toBeInstanceOf(ToolExecutionError);
      expect((outcome as ToolExecutionError).code).toBe("timeout");
      expect((outcome as ToolExecutionError).message).toContain("after 250ms");
      expect(stub.aborted).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(PROMPT_STOP_BOUND_MS);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
