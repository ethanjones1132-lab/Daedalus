// ═══════════════════════════════════════════════════════════════
// ── P2B-01: Cron Runtime Tests ──
// ═══════════════════════════════════════════════════════════════
// Verifies that cron runs bind a projection snapshot at run start,
// create a non-interactive ExecutionContext, and execute through the
// canonical ToolRuntime contract.

import { describe, expect, it } from "bun:test";
import { createCronRuntime, runCronRequest } from "./cron-runtime";
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
