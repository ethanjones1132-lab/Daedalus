import { describe, test, expect } from "bun:test";
import { BUILTIN_MODES, getToolsForMode } from "./orchestration/modes";
import { PredictiveRouter } from "./orchestration/router";
import { PipelineExecutor, describePipelineError, errText } from "./orchestration/pipeline";
import { createToolRuntime, makeExecutionContext } from "./tool-runtime";
import type { ToolDefinition } from "./tool-types";
import { defaultConfig } from "./config";
import type { ChatMessage } from "./orchestration/router";
import { SessionOutcomeCollector, SelfTuningStore } from "./self-tuning/mod";

// In-memory collector so PipelineExecutor runs in tests can NEVER write to the
// production self-tuning DB (~/.openclaw/jarvis/self-tuning.db). Passed as the
// 4th constructor arg to every executor below.
const testCollector = new SessionOutcomeCollector(new SelfTuningStore(":memory:"));

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

  test("getToolsForMode respects least-authority execution profiles", () => {
    const dummyTools: ToolDefinition[] = [
      { type: "function", function: { name: "read_file", description: "", parameters: { type: "object", properties: {}, required: [] } }, requires_approval: false, dangerous: false },
      { type: "function", function: { name: "list_directory", description: "", parameters: { type: "object", properties: {}, required: [] } }, requires_approval: false, dangerous: false },
      { type: "function", function: { name: "write_file", description: "", parameters: { type: "object", properties: {}, required: [] } }, requires_approval: true, dangerous: true },
      { type: "function", function: { name: "bash", description: "", parameters: { type: "object", properties: {}, required: [] } }, requires_approval: true, dangerous: true },
      { type: "function", function: { name: "apply_patch", description: "", parameters: { type: "object", properties: {}, required: [] } }, requires_approval: true, dangerous: true },
    ];

    // read_only caps the executor to read-only tools — NO write/bash/patch.
    const readOnly = getToolsForMode("executor", dummyTools, "read_only").map((t) => t.function.name);
    expect(readOnly).toEqual(["read_file", "list_directory"]);
    expect(readOnly).not.toContain("write_file");
    expect(readOnly).not.toContain("bash");
    expect(readOnly).not.toContain("apply_patch");

    // none removes everything.
    expect(getToolsForMode("executor", dummyTools, "none")).toEqual([]);

    // full (default) keeps the executor's whole filtered set.
    expect(getToolsForMode("executor", dummyTools, "full").map((t) => t.function.name))
      .toEqual(["read_file", "list_directory", "write_file", "bash", "apply_patch"]);

    // read_only on the rewriter (a mutation-only mode) yields no tools.
    expect(getToolsForMode("rewriter", dummyTools, "read_only")).toEqual([]);
  });

  test("PipelineExecutor skips empty pipelines without touching prompts", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const executor = new PipelineExecutor(async () => ({ content: "ok" }), runtime, ctx, testCollector);
    const states: Array<{ stage: string; status: string }> = [];

    const result = await executor.execute("do nothing", [], "run-empty", (state) => states.push(state as any));

    expect(result.answer).toBe("No planning stage executed.");
    expect(result.error).toBeUndefined();
    expect(states).toEqual([]);
  });

  test("empty synthesizer completion is recorded as a FAILED outcome, not success", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const recorded: any[] = [];
    const collector = { recordStageRun: (s: any) => recorded.push(s) };
    // Synthesizer returns a 200 with whitespace-only content (the free-tier
    // empty-completion case that used to record was_successful:1 / 0 tokens).
    const executor = new PipelineExecutor(async () => ({ content: "   " }), runtime, ctx, collector);

    const result = await executor.execute("read this", ["synthesizer"], "run-empty-synth", () => {});

    expect(result.answer).toBe("");
    expect(result.error).toBeUndefined(); // not a hard error → friendly notice path
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("empty_completion");
    const synth = recorded.find((s) => s.mode_id === "synthesizer");
    expect(synth.was_successful).toBe(0);
    expect(synth.had_error).toBe(1);
    expect(synth.error_message).toBe("empty_completion");
  });

  test("read_only profile prevents the executor from receiving mutating tools", async () => {
    const runtime = createToolRuntime();
    const def = (name: string, dangerous: boolean) => ({
      type: "function" as const,
      function: { name, description: "", parameters: { type: "object" as const, properties: {}, required: [] } },
      requires_approval: dangerous,
      dangerous,
    });
    runtime.register(def("read_file", false), async () => "ok");
    runtime.register(def("list_directory", false), async () => "ok");
    runtime.register(def("write_file", true), async () => "ok");
    runtime.register(def("bash", true), async () => "ok");
    const ctx = makeExecutionContext("agent", defaultConfig);

    const executorToolNames: string[] = [];
    const callModel = async (_messages: any[], options: any = {}) => {
      if (options.stageLabel === "executor") {
        for (const t of options.tools ?? []) executorToolNames.push(t.function.name);
        return { content: "done, no tools needed" }; // no tool_calls → executor turn ends
      }
      return { content: "final answer" };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    await executor.execute("read the repo", ["executor", "synthesizer"], "run-readonly-profile", () => {}, {
      executionProfile: "read_only",
    });

    expect(executorToolNames.sort()).toEqual(["list_directory", "read_file"]);
    expect(executorToolNames).not.toContain("write_file");
    expect(executorToolNames).not.toContain("bash");
  });

  test("PipelineExecutor surfaces a synthesizer failure as a turn-fatal error", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    // Every model call rejects like an invalid OpenRouter key would.
    const executor = new PipelineExecutor(
      async () => { throw new Error("API 401: {\"error\":{\"message\":\"User not found.\",\"code\":401}}"); },
      runtime,
      ctx,
      testCollector,
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

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
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

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
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

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
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

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
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

  test("executeSegment runs only the requested stages and returns typed state", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];

    // Returns predictable content per stageLabel so we can verify the segment
    // called the right stage helpers and skipped the rest.
    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "planner") return Promise.resolve({ content: "PLAN: read the file" });
      if (options.stageLabel === "executor") return Promise.resolve({ content: "executor narrative", tool_calls: [] });
      if (options.stageLabel === "reviewer") return Promise.resolve({ content: "Reviewer: looks complete." });
      if (options.stageLabel === "synthesizer") return Promise.resolve({ content: "synthesized answer" });
      return Promise.resolve({ content: "unexpected" });
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    // A non-terminal segment: planner + executor + reviewer (no synthesizer)
    // — exactly what the B-02 replan loop runs between `conductor_replan`
    // markers. The result should have a populated typed state but no
    // synthesizer fields.
    const partial = await executor.executeSegment(
      "do the thing",
      ["planner", "executor", "reviewer"],
      "run-segment-partial",
      () => {},
      {},
    );

    expect(partial.synthesizerAnswer).toBeUndefined();
    expect(partial.synthesizerFatalError).toBeUndefined();
    expect(partial.synthesizerEmptyCompletion).toBeUndefined();
    expect(partial.state.plan?.ok).toBe(true);
    expect(partial.state.plan?.narrative).toBe("PLAN: read the file");
    expect(partial.state.executor?.ok).toBe(true);
    expect(partial.state.executor?.narrative).toBe("executor narrative");
    expect(partial.state.reviewer?.ok).toBe(true);
    expect(partial.state.reviewer?.feedback).toBe("Reviewer: looks complete.");
    // Planner and executor stages ran; reviewer ran once; synthesizer did NOT.
    expect(stages).toEqual(["planner", "executor", "reviewer"]);

    // A full segment that includes the synthesizer populates the answer fields.
    const stages2: string[] = [];
    const callModel2 = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages2.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "planner") return Promise.resolve({ content: "plan" });
      if (options.stageLabel === "synthesizer") return Promise.resolve({ content: "final answer" });
      return Promise.resolve({ content: "noop" });
    };
    const executor2 = new PipelineExecutor(callModel2 as any, runtime, ctx, testCollector);
    const full = await executor2.executeSegment(
      "skip executor",
      ["planner", "synthesizer"],
      "run-segment-full",
      () => {},
      {},
    );

    expect(full.synthesizerAnswer).toBe("final answer");
    expect(full.synthesizerEmptyCompletion).toBe(false);
    expect(stages2).toEqual(["planner", "synthesizer"]);
  });

  test("executeSegment threads carry-forward state into the next segment", async () => {
    // The B-02 replan loop hands the conductor a summarized carry state from
    // segment N, and segment N+1 should be able to read those typed values
    // (not re-derive them from strings). This pins the carry contract.
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "synthesizer") return Promise.resolve({ content: "synthesized with carry" });
      return Promise.resolve({ content: "noop" });
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    const carry = {
      plan: { ok: true, narrative: "carry plan" },
      executor: { ok: true, narrative: "carry exec", toolCalls: [] },
      reviewer: { ok: true, feedback: "carry review", hasIssues: false },
    } as const;

    const result = await executor.executeSegment(
      "continue",
      ["synthesizer"],
      "run-segment-carry",
      () => {},
      {},
      { ...carry },
    );

    // The carry state is passed through unchanged; the synthesizer only runs
    // because the segment asked for it.
    expect(result.state.plan).toEqual(carry.plan);
    expect(result.state.executor).toEqual(carry.executor);
    expect(result.state.reviewer).toEqual(carry.reviewer);
    expect(result.synthesizerAnswer).toBe("synthesized with carry");
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
