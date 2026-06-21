// ═══════════════════════════════════════════════════════════════
// ── P2B-01: Cron Runtime Tests ──
// ═══════════════════════════════════════════════════════════════
// Verifies that cron runs bind a projection snapshot at run start,
// create a non-interactive ExecutionContext, and execute through the
// canonical ToolRuntime contract.

import { describe, expect, it } from "bun:test";
import { createCronRuntime } from "./cron-runtime";
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
