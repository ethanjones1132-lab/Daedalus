import { describe, test, expect } from "bun:test";
import { BUILTIN_MODES, getToolsForMode } from "./orchestration/modes";
import { PredictiveRouter } from "./orchestration/router";
import { PipelineExecutor, describePipelineError, errText } from "./orchestration/pipeline";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import { defaultConfig } from "./config";

describe("Orchestration & Routing Tests", () => {
  test("PredictiveRouter falls back safely when prompt files are absent", async () => {
    const router = new PredictiveRouter(async () => ({ content: "ignored" }));
    const route = await router.route("debug the build");

    expect(route.task_type).toBe("general");
    expect(route.pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
    expect(route.routing_rationale).toContain("Fallback routing");
  });

  test("getToolsForMode filters correctly", () => {
    const dummyTools: ToolDefinition[] = [
      {
        type: "function",
        function: { name: "read_file", description: "read", parameters: { type: "object", properties: {}, required: [] } },
        requires_approval: false,
        dangerous: false,
      },
      {
        type: "function",
        function: { name: "write_file", description: "write", parameters: { type: "object", properties: {}, required: [] } },
        requires_approval: true,
        dangerous: true,
      },
      {
        type: "function",
        function: { name: "bash", description: "shell", parameters: { type: "object", properties: {}, required: [] } },
        requires_approval: true,
        dangerous: true,
      },
    ];

    expect(getToolsForMode("reviewer", dummyTools).map((t) => t.function.name)).toEqual(["read_file"]);
    expect(getToolsForMode("rewriter", dummyTools).map((t) => t.function.name)).toEqual(["write_file"]);
    expect(getToolsForMode("executor", dummyTools)).toHaveLength(3);
    expect(getToolsForMode("missing", dummyTools)).toEqual([]);
  });

  test("PipelineExecutor skips empty pipelines without touching prompts", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const executor = new PipelineExecutor(async () => ({ content: "ok" }), runtime, ctx);
    const states: Array<{ stage: string; status: string }> = [];

    const result = await executor.execute("do nothing", [], "run-empty", (state) => states.push(state as any));

    expect(result.answer).toBe("No planning stage executed.");
    expect(result.error).toBeUndefined();
    expect(states).toEqual([]);
  });

  test("PipelineExecutor surfaces a synthesizer failure as a turn-fatal error", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    // Every model call rejects like an invalid OpenRouter key would.
    const executor = new PipelineExecutor(
      async () => { throw new Error("API 401: {\"error\":{\"message\":\"User not found.\",\"code\":401}}"); },
      runtime,
      ctx,
    );
    const states: Array<{ stage: string; status: string }> = [];

    const result = await executor.execute("hi", ["synthesizer"], "run-auth-fail", (state) => states.push(state as any));

    // The answer still carries the raw notice for logging, but `error` is set so
    // the caller emits an error frame instead of a fake "success".
    expect(result.answer).toContain("Synthesis failed");
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Authentication failed \(401\)/);
    expect(states.some((s) => s.stage === "synthesizer" && s.status === "failed")).toBe(true);
  });

  test("errText safely stringifies non-Error throws without crashing", () => {
    expect(errText(new Error("boom"))).toBe("boom");
    expect(errText("plain string")).toBe("plain string");
    expect(errText({ message: "objlike" })).toBe("objlike");
    // The case that produced "undefined is not an object (evaluating 'e.message')":
    expect(errText(undefined)).toBe("undefined");
    expect(errText(null)).toBe("null");
    expect(errText({ code: 500 })).toBe("[object Object]");
  });

  test("describePipelineError maps hard transport errors to actionable hints", () => {
    expect(describePipelineError("API 401: User not found")).toMatch(/Authentication failed \(401\)/);
    expect(describePipelineError("API 403: forbidden")).toMatch(/Access denied \(403\)/);
    expect(describePipelineError("API 429: rate limit exceeded")).toMatch(/Rate limited/);
    expect(describePipelineError("API 502: bad gateway")).toMatch(/server error/);
    // Non-transport errors pass through unchanged.
    expect(describePipelineError("boom")).toBe("boom");
  });

  test("builtin modes expose expected finality and filters", () => {
    expect(BUILTIN_MODES.synthesizer.is_final).toBe(true);
    expect(BUILTIN_MODES.planner.tools_filter).toEqual([]);
    expect(BUILTIN_MODES.executor.tools_filter).toContain("*");
  });
});
