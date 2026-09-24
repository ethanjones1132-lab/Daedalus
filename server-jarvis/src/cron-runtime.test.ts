// ═══════════════════════════════════════════════════════════════
// ── P2B-01: Cron Runtime Tests ──
// ═══════════════════════════════════════════════════════════════
// Verifies that cron runs bind a projection snapshot at run start,
// create a non-interactive ExecutionContext, and execute through the
// canonical ToolRuntime contract.

import { describe, expect, it } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { createCronRuntime, runCronRequest, runCronWithRetries } from "./cron-runtime";
import { createToolRuntime } from "./tool-runtime";
import type { ProjectionSnapshot } from "./activation-boundary";
import { defaultConfig } from "./config";
import type { ToolDefinition } from "./tool-types";

function makeSnapshot(overrides?: Partial<ProjectionSnapshot>): ProjectionSnapshot {
  return {
    slug: "test-agent",
    active: true,
    updated_at: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

function makeTool(name = "ping"): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: "test tool",
      parameters: { type: "object", properties: {}, required: [] },
    },
    requires_approval: false,
    dangerous: false,
  };
}

describe("Cron runtime adapter", () => {
  it("restores a projection boundary at run start", () => {
    const snapshot = makeSnapshot({ slug: "cron-boundary-test" });
    const { boundary } = createCronRuntime(defaultConfig, snapshot);

    expect(boundary.slug).toBe(snapshot.slug);
    expect(boundary.snapshot.slug).toBe(snapshot.slug);
    expect(boundary.snapshot.active).toBe(true);
  });

  it("creates a non-interactive cron ExecutionContext", () => {
    const { ctx } = createCronRuntime(defaultConfig(), makeSnapshot());

    expect(ctx.surface).toBe("cron");
    expect(ctx.interactive).toBe(false);
    expect(ctx.config.tools.interactive_approval).toBe(false);
  });

  it("routes tool calls through ToolRuntime.execute policy checks", async () => {
    const { runtime, ctx } = createCronRuntime(defaultConfig(), makeSnapshot());
    runtime.register(makeTool("cron_echo"), async () => "ok");

    const result = await runtime.execute({ id: "call-1", name: "cron_echo", arguments: {} }, ctx);

    expect(result.is_error).toBe(false);
    expect(result.output).toBe("ok");
  });

  it("keeps cron runs non-interactive for approval-required tools", async () => {
    const { runtime, ctx } = createCronRuntime(defaultConfig(), makeSnapshot());
    runtime.register({ ...makeTool("dangerous_tool"), requires_approval: true }, async () => "blocked");

    const result = await runtime.execute({ id: "call-1", name: "dangerous_tool", arguments: {} }, ctx);

    expect(result.is_error).toBe(true);
    expect(result.error).toContain("requires approval");
  });
});

// ── runCronRequest contract pins ──
// The shadow commit 6e18f1e added `executeWithTimeout` (15-min default,
// env-override via JARVIS_CRON_TOOL_TIMEOUT_MS) so a hung tool call fails
// fast with an error result instead of leaving the cron job idle until
// the Hermes watchdog kills it. The 31b5676 follow-up fixed a ToolResult
// shape mismatch in the catch branch. These tests pin the four
// observable contracts of the production path:
//   1. empty tools list → ok:true, results:[]
//   2. unknown tool name → ok:false + per-call is_error envelope with the
//      runtime's "unknown_tool" error_code preserved
//   3. results array order matches the order of req.tools
//   4. the boundary's slug is restored from req.slug (per-tool timeout
//      does not change the projection boundary)
describe("runCronRequest contract", () => {
  it("returns ok:true and an empty results list when no tool calls are requested", async () => {
    const result = await runCronRequest(
      { slug: "empty-cron", prompt: "noop", tools: [] },
      defaultConfig(),
    );

    expect(result.ok).toBe(true);
    expect(result.slug).toBe("empty-cron");
    expect(result.results).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("preserves the unknown-tool is_error envelope and returns ok:false", async () => {
    const result = await runCronRequest(
      {
        slug: "unknown-tool-cron",
        prompt: "missing",
        tools: [{ id: "call-x", name: "definitely_not_a_real_tool", arguments: {} }],
      },
      defaultConfig(),
    );

    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(1);
    const [only] = result.results;
    expect(only.call_id).toBe("call-x");
    expect(only.name).toBe("definitely_not_a_real_tool");
    expect(only.is_error).toBe(true);
    // The runtime's stable machine-readable error category survives the
    // cron adapter — operators can distinguish "unknown tool" from
    // "handler_error" (timeout) without parsing the error string.
    expect(only.error_code).toBe("unknown_tool");
    expect(only.error).toContain("Unknown tool: definitely_not_a_real_tool");
  });

  it("preserves the order of results to match the order of req.tools", async () => {
    const result = await runCronRequest(
      {
        slug: "order-cron",
        prompt: "mixed",
        tools: [
          { id: "call-a", name: "missing_tool_alpha", arguments: {} },
          { id: "call-b", name: "missing_tool_beta", arguments: {} },
          { id: "call-c", name: "missing_tool_gamma", arguments: {} },
        ],
      },
      defaultConfig(),
    );

    expect(result.ok).toBe(false);
    expect(result.results.map((r) => r.call_id)).toEqual(["call-a", "call-b", "call-c"]);
    expect(result.results.map((r) => r.name)).toEqual([
      "missing_tool_alpha",
      "missing_tool_beta",
      "missing_tool_gamma",
    ]);
  });

  it("restores the projection boundary from req.slug", async () => {
    const result = await runCronRequest(
      { slug: "boundary-pin", prompt: "noop", tools: [] },
      defaultConfig(),
    );

    expect(result.boundary.slug).toBe("boundary-pin");
  });
});

// ── Retry/evidence contract pins ──
// A cron run may hit transient failures (network blips, model rate limits,
// flaky workspace tools). `runCronWithRetries` runs the same request with a
// reusable ToolRuntime until it succeeds or exhausts its attempts, and it
// records one `ExecutionEvidence` per attempt so the retry trail is auditable.
describe("runCronWithRetries contract", () => {
  it("reuses a stateful runtime across attempts and persists per-attempt evidence", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cron-retry-"));
    const cfg = { ...defaultConfig(), jarvis_path: tmp };

    const runtime = createToolRuntime();
    let calls = 0;
    runtime.register(makeTool("flaky_ping"), async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient first-attempt failure");
      }
      return "pong";
    });

    const evidence = await runCronWithRetries(
      {
        slug: "retry-test",
        prompt: "ping until success",
        tools: [{ id: "call-1", name: "flaky_ping", arguments: {} }],
      },
      cfg,
      { maxAttempts: 3, retryDelayMs: 0, runtime },
    );

    expect(evidence).toHaveLength(2);
    expect(evidence.map((e) => e.status)).toEqual(["failed", "success"]);
    expect(calls).toBe(2);

    // Each failed evidence is persisted before the next attempt begins.
    for (const e of evidence) {
      const persisted = Bun.file(join(tmp, "cron-evidence", `${e.run_id}.json`));
      expect(await persisted.exists()).toBe(true);
    }

    rmSync(tmp, { recursive: true, force: true });
  });

  it("exhausts maxAttempts when the tool keeps failing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cron-retry-exhaust-"));
    const cfg = { ...defaultConfig(), jarvis_path: tmp };

    const runtime = createToolRuntime();
    runtime.register(makeTool("always_fails"), async () => {
      throw new Error("persistent failure");
    });

    const evidence = await runCronWithRetries(
      {
        slug: "exhaust-test",
        prompt: "doomed ping",
        tools: [{ id: "call-1", name: "always_fails", arguments: {} }],
      },
      cfg,
      { maxAttempts: 3, retryDelayMs: 0, runtime },
    );

    expect(evidence).toHaveLength(3);
    expect(evidence.every((e) => e.status === "failed")).toBe(true);
    expect(evidence[0]?.error_code).toBe("handler_error");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes cancellation to the tool execution context and stops the request", async () => {
    const controller = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let observedSignal: AbortSignal | undefined;
    const runtime = createToolRuntime();
    runtime.register(makeTool("cancellable"), async (_args, ctx) => {
      observedSignal = ctx.signal;
      startedResolve();
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 100);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          resolve();
        }, { once: true });
      });
      return "late result";
    });

    const pending = runCronRequest(
      { slug: "cancel-test", prompt: "wait", tools: [{ id: "call-1", name: "cancellable", arguments: {} }] },
      defaultConfig(),
      runtime,
      { signal: controller.signal },
    );
    await started;
    controller.abort("request aborted");

    const result = await pending;
    expect(observedSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("cancelled");
  });

  it("reports a timeout and aborts the active tool before retrying", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let observedSignal: AbortSignal | undefined;
    let calls = 0;
    const runtime = createToolRuntime();
    runtime.register(makeTool("deadline_tool"), async (_args, ctx) => {
      calls += 1;
      observedSignal = ctx.signal;
      startedResolve();
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 100);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          resolve();
        }, { once: true });
      });
      return "late result";
    });

    const evidence = await runCronWithRetries(
      { slug: "deadline-test", prompt: "wait", tools: [{ id: "call-1", name: "deadline_tool", arguments: {} }] },
      defaultConfig(),
      { maxAttempts: 2, retryDelayMs: 0, runtime, deadlineMs: 15 },
    );

    expect(calls).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.status).toBe("timeout");
  });

  it("does not start another attempt after cancellation", async () => {
    const controller = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let calls = 0;
    const runtime = createToolRuntime();
    runtime.register(makeTool("cancel_retry"), async () => {
      calls += 1;
      if (calls === 1) {
        startedResolve();
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("first attempt failed");
      }
      return "late retry";
    });

    const evidencePromise = runCronWithRetries(
      { slug: "cancel-retry-test", prompt: "fail once", tools: [{ id: "call-1", name: "cancel_retry", arguments: {} }] },
      defaultConfig(),
      { maxAttempts: 3, retryDelayMs: 0, runtime, signal: controller.signal },
    );
    await started;
    controller.abort("request aborted");

    const evidence = await evidencePromise;
    expect(calls).toBe(1);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.status).toBe("cancelled");
  });
});
