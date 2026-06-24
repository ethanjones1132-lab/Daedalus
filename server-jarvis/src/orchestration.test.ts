import { describe, test, expect } from "bun:test";
import { BUILTIN_MODES, getToolsForMode } from "./orchestration/modes";
import { PredictiveRouter } from "./orchestration/router";
import { PipelineExecutor, describePipelineError, errText } from "./orchestration/pipeline";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import { defaultConfig } from "./config";
import type { ChatMessage } from "./orchestration/router";

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

  test("PipelineExecutor can run planner and reviewer speculatively before synthesis", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const starts: string[] = [];
    const synthesizerInputs: string[] = [];
    const pending = new Map<string, (value: { content: string }) => void>();

    const callModel = (messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      const stage = options.stageLabel ?? "unknown";
      starts.push(stage);
      if (stage === "synthesizer") {
        synthesizerInputs.push(messages.map((m) => m.content).join("\n"));
        return Promise.resolve({ content: "final answer" });
      }
      return new Promise<{ content: string }>((resolve) => {
        pending.set(stage, resolve);
      });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx);
    const run = executor.execute(
      "compare two implementation paths",
      ["planner", "reviewer", "synthesizer"],
      "run-speculative",
      () => {},
      { topology: "speculative_parallel" },
    );

    await Promise.resolve();
    expect(starts).toEqual(["planner", "reviewer"]);

    pending.get("reviewer")?.({ content: "reviewer cautions" });
    await Promise.resolve();
    expect(starts).toEqual(["planner", "reviewer"]);

    pending.get("planner")?.({ content: "planner outline" });
    const result = await run;

    expect(result.answer).toBe("final answer");
    expect(starts).toEqual(["planner", "reviewer", "synthesizer"]);
    expect(synthesizerInputs[0]).toContain("planner outline");
    expect(synthesizerInputs[0]).toContain("reviewer cautions");
  });

  test("PipelineExecutor escalates speculative cascade when cheap confidence is low", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];
    const synthesizerInputs: string[] = [];

    const callModel = (messages: ChatMessage[], options: { stageLabel?: string; cascadeTier?: string } = {}) => {
      stages.push(`${options.stageLabel}:${options.cascadeTier ?? "none"}`);
      if (options.stageLabel === "executor" && options.cascadeTier === "cheap") {
        return Promise.resolve({ content: "cheap draft\nCONFIDENCE: 0.42" });
      }
      if (options.stageLabel === "executor" && options.cascadeTier === "strong") {
        return Promise.resolve({ content: "strong corrected result\nCONFIDENCE: 0.91" });
      }
      if (options.stageLabel === "synthesizer") {
        synthesizerInputs.push(messages.map((m) => m.content).join("\n"));
        return Promise.resolve({ content: "final cascade answer" });
      }
      return Promise.resolve({ content: "unexpected" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx);
    const result = await executor.execute(
      "answer cheaply unless uncertain",
      ["executor", "synthesizer"],
      "run-cascade",
      () => {},
      { topology: "speculative_cascade" },
    );

    expect(result.answer).toBe("final cascade answer");
    expect(stages).toEqual(["executor:cheap", "executor:strong", "synthesizer:none"]);
    expect(synthesizerInputs[0]).toContain("cheap draft");
    expect(synthesizerInputs[0]).toContain("strong corrected result");
  });

  test("PipelineExecutor recursively re-enters executor after critique requests more work", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];
    const recursionEvents: Array<{ depth: number; status: string; reenter_stage?: string }> = [];

    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "executor" && stages.filter((stage) => stage === "executor").length === 1) {
        return Promise.resolve({ content: "initial executor summary" });
      }
      if (options.stageLabel === "synthesizer" && stages.filter((stage) => stage === "synthesizer").length === 1) {
        return Promise.resolve({ content: "draft answer missing verification" });
      }
      if (options.stageLabel === "recursion_critique") {
        return Promise.resolve({ content: JSON.stringify({ needs_more_work: true, reenter_stage: "executor", critique: "Verify the answer before finalizing." }) });
      }
      if (options.stageLabel === "executor") {
        return Promise.resolve({ content: "recursive executor verified the work" });
      }
      if (options.stageLabel === "synthesizer") {
        return Promise.resolve({ content: "final improved answer" });
      }
      return Promise.resolve({ content: "unexpected" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx);
    const result = await executor.execute(
      "finish the task",
      ["executor", "synthesizer"],
      "run-recursive",
      () => {},
      {
        topology: "recursive",
        maxRecursionDepth: 1,
        onRecursion: (event) => recursionEvents.push(event),
      },
    );

    expect(result.answer).toBe("final improved answer");
    expect(result.recursion_depth).toBe(1);
    expect(stages).toEqual(["executor", "synthesizer", "recursion_critique", "executor", "synthesizer"]);
    expect(recursionEvents.some((event) => event.depth === 1 && event.status === "reenter" && event.reenter_stage === "executor")).toBe(true);
  });

  test("PipelineExecutor stops recursive re-entry at the configured depth cap", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];
    const recursionEvents: Array<{ depth: number; status: string; reenter_stage?: string }> = [];

    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "recursion_critique") {
        return Promise.resolve({ content: JSON.stringify({ needs_more_work: true, reenter_stage: "executor", critique: "Run another executor pass." }) });
      }
      if (options.stageLabel === "executor") return Promise.resolve({ content: "executor output" });
      if (options.stageLabel === "synthesizer") return Promise.resolve({ content: "capped answer" });
      return Promise.resolve({ content: "unexpected" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx);
    const result = await executor.execute(
      "finish the task",
      ["executor", "synthesizer"],
      "run-recursive-cap",
      () => {},
      {
        topology: "recursive",
        maxRecursionDepth: 0,
        onRecursion: (event) => recursionEvents.push(event),
      },
    );

    expect(result.answer).toBe("capped answer");
    expect(result.recursion_depth).toBe(0);
    expect(stages).toEqual(["executor", "synthesizer", "recursion_critique"]);
    expect(recursionEvents.some((event) => event.depth === 0 && event.status === "max_depth" && event.reenter_stage === "executor")).toBe(true);
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
    expect(BUILTIN_MODES.executor.tools_filter).toEqual([
      "read_file", "write_file", "edit_file", "multi_edit", "apply_patch",
      "glob", "grep", "list_directory",
      "bash",
      "web_search", "web_fetch",
      "agent", "run_background_command",
    ]);
  });
});
