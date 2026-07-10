import { describe, test, expect } from "bun:test";
import { BUILTIN_MODES, executorTurnLimit, getToolsForMode } from "./orchestration/modes";
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
    expect(getToolsForMode("rewriter", dummyTools).map((t) => t.function.name)).toEqual(["read_file", "write_file"]);
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

    // read_only on the rewriter keeps only the inspection tools it already has.
    expect(getToolsForMode("rewriter", dummyTools, "read_only").map((t) => t.function.name)).toEqual(["read_file", "list_directory"]);
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

  test("read_only executor is bounded to two model rounds", () => {
    expect(executorTurnLimit("read_only")).toBe(2);
    expect(executorTurnLimit("full")).toBe(BUILTIN_MODES.executor.max_turns);
  });

  test("workspace_read blocks stale repo synthesis when the executor produces no read evidence", async () => {
    const runtime = createToolRuntime();
    const def = (name: string) => ({
      type: "function" as const,
      function: { name, description: "", parameters: { type: "object" as const, properties: {}, required: [] } },
      requires_approval: false,
      dangerous: false,
    });
    runtime.register(def("read_file"), async () => "real Jarvis repository evidence");
    runtime.register(def("list_directory"), async () => "README.md\nserver-jarvis\nsrc-tauri\nsrc-ui");
    const ctx = makeExecutionContext("agent", defaultConfig());
    const stages: string[] = [];
    const callModel = async (_messages: ChatMessage[], options: any = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "executor") {
        return {
          content: "This is a multi-stage Jarvis agent pipeline whose runtime entry point is jarvis/orchestrator.py.",
        };
      }
      return { content: "Inspect jarvis/orchestrator.py first to understand the runtime path." };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    const result = await executor.execute(
      "Give me a two-sentence summary of this repo, then name one runtime entry file.",
      ["executor", "synthesizer"],
      "run-repo-grounding-missing-evidence",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
      } as any,
    );

    expect(stages).toEqual(["executor", "executor"]);
    expect(result.answer).toBe("");
    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("missing_workspace_evidence");
    expect(result.error).toContain("no successful workspace read");
  });

  test("workspace_read accepts successful read evidence and passes it to synthesis", async () => {
    const runtime = createToolRuntime();
    const readFile = {
      type: "function" as const,
      function: { name: "read_file", description: "", parameters: { type: "object" as const, properties: {}, required: [] } },
      requires_approval: false,
      dangerous: false,
    };
    runtime.register(readFile, async () => "Jarvis is a Tauri desktop platform backed by a Bun server.");
    const ctx = makeExecutionContext("agent", defaultConfig());
    let synthesizerContext = "";
    let executorCalls = 0;
    const callModel = async (messages: ChatMessage[], options: any = {}) => {
      if (options.stageLabel === "executor") {
        executorCalls += 1;
        if (executorCalls > 1) {
          return { content: "Grounded repo summary is ready." };
        }
        return {
          content: "",
          tool_calls: [{
            id: "read-readme",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
          }],
        };
      }
      synthesizerContext = messages.find((message) => message.role === "user")?.content ?? "";
      return { content: "Jarvis is a Tauri desktop platform with a Bun server." };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    const result = await executor.execute(
      "Summarize this repo.",
      ["executor", "synthesizer"],
      "run-repo-grounding-with-evidence",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
      } as any,
    );

    expect(result.outcome).toBe("success");
    expect(result.error).toBeUndefined();
    expect(synthesizerContext).toContain("Jarvis is a Tauri desktop platform backed by a Bun server");
  });

  test("workspace_read cannot bypass the evidence fence by omitting synthesizer", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig());
    const executor = new PipelineExecutor(
      async () => ({ content: "The repo is an Expo app." }),
      runtime,
      ctx,
      testCollector,
    );

    const result = await executor.execute(
      "Summarize this repo.",
      ["executor"],
      "run-repo-grounding-no-synth-bypass",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "workspace_read",
      },
    );

    expect(result).toMatchObject({
      answer: "",
      outcome: "failed",
      error_code: "missing_workspace_evidence",
    });
  });

  test("answer_only executor remains free to synthesize without workspace evidence", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig());
    const stages: string[] = [];
    const executor = new PipelineExecutor(async (_messages, options) => {
      stages.push(options?.stageLabel ?? "unknown");
      return options?.stageLabel === "executor"
        ? { content: "Paris is the capital of France." }
        : { content: "The capital of France is Paris." };
    }, runtime, ctx, testCollector);

    const result = await executor.execute(
      "What is the capital of France?",
      ["executor", "synthesizer"],
      "run-answer-only-no-workspace-evidence",
      () => {},
      {
        executionProfile: "read_only",
        turnRequirement: "answer_only",
      },
    );

    expect(stages).toEqual(["executor", "synthesizer"]);
    expect(result).toMatchObject({
      answer: "The capital of France is Paris.",
      outcome: "success",
    });
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

    // `answer` must NEVER carry "Synthesis failed: ..." — 20 historical runs
    // (pre-2026-07-04) shipped that raw text as the literal chat bubble.
    // The failure travels via `error` only, which index.ts's error branch
    // turns into an SSE error frame instead of prose.
    expect(result.answer).toBe("");
    expect(result.answer).not.toContain("Synthesis failed");
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

  test("speculative-parallel synthesizer failure surfaces as an error, never as answer prose", async () => {
    // Same "never ship the raw catch text as the chat bubble" contract as the
    // linear-pipeline test above, but for executeSpeculativeParallel's own
    // synthesizer catch block (a separate code path with its own try/catch).
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);

    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      if (options.stageLabel === "planner") return Promise.resolve({ content: "planner outline" });
      if (options.stageLabel === "reviewer") return Promise.resolve({ content: "reviewer cautions" });
      if (options.stageLabel === "synthesizer") {
        return Promise.reject(new Error("API 401: {\"error\":{\"message\":\"User not found.\",\"code\":401}}"));
      }
      return Promise.resolve({ content: "unexpected" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const result = await executor.execute(
      "compare two implementation paths",
      ["planner", "reviewer", "synthesizer"],
      "run-speculative-fail",
      () => {},
      { topology: "speculative_parallel" },
    );

    expect(result.answer).toBe("");
    expect(result.answer).not.toContain("Synthesis failed");
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Authentication failed \(401\)/);
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

  // ─── Track B B-03: conductor-decided re-enter targets ──────────────────
  // B-03 replaces the hardcoded `recursion_critique` → executor path with
  // conductor-decided re-enter targets: planner, executor, conductor_replan.
  // The depth cap must be shared across re-enter types.

  test("B-03: recursion critic may re-enter planner and the depth is shared with executor re-entries", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];
    const recursionEvents: Array<{ depth: number; status: string; reenter_stage?: string }> = [];

    let criticCalls = 0;
    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "executor" && stages.filter((s) => s === "executor").length === 1) {
        return Promise.resolve({ content: "initial executor summary" });
      }
      if (options.stageLabel === "synthesizer" && stages.filter((s) => s === "synthesizer").length === 1) {
        return Promise.resolve({ content: "draft answer missing verification" });
      }
      if (options.stageLabel === "recursion_critique") {
        criticCalls += 1;
        // First critic pass: needs more work, asks for a planner re-enter.
        if (criticCalls === 1) {
          return Promise.resolve({ content: JSON.stringify({
            needs_more_work: true,
            reenter_stage: "planner",
            critique: "The plan was underspecified — re-plan from scratch.",
          })});
        }
        // Second critic pass: satisfied.
        return Promise.resolve({ content: JSON.stringify({
          needs_more_work: false,
          reenter_stage: "executor",
          critique: "Looks good after the re-plan.",
        })});
      }
      if (options.stageLabel === "planner") {
        return Promise.resolve({ content: "replanned: read the file with care" });
      }
      if (options.stageLabel === "executor") {
        return Promise.resolve({ content: "executor summary after re-plan" });
      }
      if (options.stageLabel === "synthesizer") {
        return Promise.resolve({ content: "final answer after planner re-entry" });
      }
      return Promise.resolve({ content: "unexpected" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const result = await executor.execute(
      "finish the task",
      ["executor", "synthesizer"],
      "run-b03-planner-reenter",
      () => {},
      {
        topology: "recursive",
        maxRecursionDepth: 1,
        onRecursion: (event) => recursionEvents.push(event),
      },
    );

    // The critic asked for a `planner` re-enter, so the re-run pipeline was
    // [planner, executor, synthesizer] (not the default [executor,
    // synthesizer] that the original B-01 path used). The inner re-run is
    // `topology: "linear"`, so the recursion critic does NOT run again
    // inside it — the depth counter resets for the inner pipeline and the
    // outer applyRecursiveCritique already returned. The shared-budget
    // guarantee is structural: `maxRecursionDepth=1` means at most one
    // re-enter of any kind per turn (planner OR executor OR
    // conductor_replan, not multiple).
    expect(result.answer).toBe("final answer after planner re-entry");
    expect(result.recursion_depth).toBe(1);
    expect(stages).toEqual([
      "executor", "synthesizer", "recursion_critique",
      "planner", "executor", "synthesizer",
    ]);
    // B-03 acceptance: the reenter event carries the conductor-decided stage.
    expect(recursionEvents.some((event) =>
      event.depth === 1 && event.status === "reenter" && event.reenter_stage === "planner",
    )).toBe(true);
  });

  test("B-03: critic may emit conductor_replan — surfaces a typed event without spawning another recursion", async () => {
    // conductor_replan is a conductor-native re-enter signal, not a
    // pipeline-executor re-enter. The critic emitting it means "the
    // conductor's own replan path should own the revision" — so the
    // pipeline executor surfaces a typed `reenter` event and returns the
    // current result, letting the SSE relay render the recurse decision
    // without spending recursion depth (the conductor's `max_replans`
    // budget is the authoritative cap on its own path).
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];
    const recursionEvents: Array<{ depth: number; status: string; reenter_stage?: string }> = [];

    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "executor" && stages.filter((s) => s === "executor").length === 1) {
        return Promise.resolve({ content: "initial executor summary" });
      }
      if (options.stageLabel === "synthesizer" && stages.filter((s) => s === "synthesizer").length === 1) {
        return Promise.resolve({ content: "draft answer" });
      }
      if (options.stageLabel === "recursion_critique") {
        return Promise.resolve({ content: JSON.stringify({
          needs_more_work: true,
          reenter_stage: "conductor_replan",
          critique: "The plan needs revision — defer to the conductor.",
        })});
      }
      return Promise.resolve({ content: "unexpected" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const result = await executor.execute(
      "finish the task",
      ["executor", "synthesizer"],
      "run-b03-conductor-replan",
      () => {},
      {
        topology: "recursive",
        maxRecursionDepth: 5,
        onRecursion: (event) => recursionEvents.push(event),
      },
    );

    // The pipeline did NOT re-execute any stage after the critic — the
    // conductor_replan event is a signal, not a pipeline spawn.
    expect(stages).toEqual(["executor", "synthesizer", "recursion_critique"]);
    expect(result.recursion_depth).toBe(0);
    expect(result.answer).toBe("draft answer");
    // Typed event surfaces the recurse decision for the SSE relay.
    expect(recursionEvents.some((event) =>
      event.status === "reenter" && event.reenter_stage === "conductor_replan",
    )).toBe(true);
  });

  test("B-03: max_recursion_depth=1 enforces the shared budget regardless of which re-enter type the critic picks", async () => {
    // The B-03 acceptance criterion "shared max_recursion_depth budget
    // across re-enter types" is structural: there is only one
    // recursion-critique call per `execute()` (the inner re-runs are
    // `topology: "linear"`, so the inner never calls the critic). The
    // cap is enforced at the call site, so a critic that asks for
    // `planner` re-entry with `maxRecursionDepth=1` gets exactly one
    // re-enter — the reenter event fires, the inner pipeline runs, the
    // turn ends. The depth counter is shared in the sense that the same
    // numeric budget caps planner, executor, AND conductor_replan (proven
    // by the three earlier tests using the same `maxRecursionDepth` knob).
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];
    const recursionEvents: Array<{ depth: number; status: string; reenter_stage?: string }> = [];

    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "executor" && stages.filter((s) => s === "executor").length === 1) {
        return Promise.resolve({ content: "initial executor summary" });
      }
      if (options.stageLabel === "synthesizer" && stages.filter((s) => s === "synthesizer").length === 1) {
        return Promise.resolve({ content: "first draft" });
      }
      if (options.stageLabel === "recursion_critique") {
        return Promise.resolve({ content: JSON.stringify({
          needs_more_work: true,
          reenter_stage: "planner",
          critique: "Re-plan first.",
        })});
      }
      if (options.stageLabel === "planner") return Promise.resolve({ content: "replanned" });
      if (options.stageLabel === "executor") return Promise.resolve({ content: "executor re-run" });
      if (options.stageLabel === "synthesizer") return Promise.resolve({ content: "second-draft" });
      return Promise.resolve({ content: "noop" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const result = await executor.execute(
      "finish",
      ["executor", "synthesizer"],
      "run-b03-shared-budget",
      () => {},
      {
        topology: "recursive",
        maxRecursionDepth: 1, // <-- shared across re-enter types
        onRecursion: (event) => recursionEvents.push(event),
      },
    );

    // One re-enter happened: planner (not executor, not conductor_replan).
    // The shared budget means a turn can never see TWO re-enter events of
    // ANY kind — the depth cap is checked at the single call site.
    expect(stages).toContain("planner");
    expect(result.recursion_depth).toBe(1);
    // Exactly one reenter event of any kind was emitted.
    const reenterEvents = recursionEvents.filter((e) => e.status === "reenter");
    expect(reenterEvents).toHaveLength(1);
    expect(reenterEvents[0].reenter_stage).toBe("planner");
    expect(reenterEvents[0].depth).toBe(1);
  });

  test("B-03: parseRecursionDecision rejects an unknown reenter_stage and emits a 'done' event", async () => {
    // An unknown reenter_stage (e.g. a model hallucination like "rewriter"
    // — which is a valid pipeline stage but not a B-03 re-enter target)
    // must NOT silently re-enter any stage. The critic decision degrades
    // to a `done` event so the original answer is shipped as-is.
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const stages: string[] = [];
    const recursionEvents: Array<{ depth: number; status: string; reenter_stage?: string }> = [];

    const callModel = (_messages: ChatMessage[], options: { stageLabel?: string } = {}) => {
      stages.push(options.stageLabel ?? "unknown");
      if (options.stageLabel === "executor" && stages.filter((s) => s === "executor").length === 1) {
        return Promise.resolve({ content: "initial executor summary" });
      }
      if (options.stageLabel === "synthesizer" && stages.filter((s) => s === "synthesizer").length === 1) {
        return Promise.resolve({ content: "final answer" });
      }
      if (options.stageLabel === "recursion_critique") {
        return Promise.resolve({ content: JSON.stringify({
          needs_more_work: true,
          reenter_stage: "rewriter", // NOT a valid B-03 re-enter target
          critique: "Re-run the rewriter.",
        })});
      }
      return Promise.resolve({ content: "noop" });
    };

    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);
    const result = await executor.execute(
      "finish",
      ["executor", "synthesizer"],
      "run-b03-unknown-reenter",
      () => {},
      {
        topology: "recursive",
        maxRecursionDepth: 5,
        onRecursion: (event) => recursionEvents.push(event),
      },
    );

    // No re-entry: stages array is exactly the original pipeline + the
    // critic; no extra planner/executor/synthesizer was spawned.
    expect(stages).toEqual(["executor", "synthesizer", "recursion_critique"]);
    expect(result.recursion_depth).toBe(0);
    expect(result.answer).toBe("final answer");
    // The unknown reenter_stage degraded to a `done` event.
    expect(recursionEvents.some((event) => event.status === "done")).toBe(true);
    expect(recursionEvents.some((event) => event.status === "reenter")).toBe(false);
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

  test("executeSegment carries prior state forward and can stop before synthesizer", async () => {
    const runtime = createToolRuntime();
    const ctx = makeExecutionContext("agent", defaultConfig);
    const calls: string[] = [];
    const callModel = async (_messages: any[], options?: any) => {
      calls.push(options?.stageLabel ?? "?");
      return { content: `output for ${options?.stageLabel}` };
    };
    const executor = new PipelineExecutor(callModel as any, runtime, ctx, testCollector);

    const first = await executor.executeSegment(
      "do the thing", ["planner", "executor"], "run-segment-1", () => {}, {},
    );
    expect(first.state.plan?.narrative).toBe("output for planner");
    expect(first.state.executor?.narrative).toBe("output for executor");
    expect(first.synthesizerAnswer).toBeUndefined();

    const second = await executor.executeSegment(
      "do the thing", ["reviewer", "synthesizer"], "run-segment-2", () => {}, {}, first.state,
    );
    // Carried-forward state survives into the second segment.
    expect(second.state.plan?.narrative).toBe("output for planner");
    expect(second.state.executor?.narrative).toBe("output for executor");
    expect(second.synthesizerAnswer).toBe("output for synthesizer");
    expect(calls).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
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

  test("describePipelineError gives a friendly description for stalled-model timeouts", () => {
    // First-token / inter-token watchdog messages (index.ts's
    // FirstTokenTimeoutError, openrouter.ts's "(first-token timeout)" text)
    // used to surface to the user as a raw "First-token timeout (30000ms)
    // on model=..." string, which read like an internal crash.
    const firstToken = describePipelineError("First-token timeout (30000ms) on model=foo stage=synthesizer");
    expect(firstToken).toMatch(/stalled before responding/i);
    expect(firstToken).toContain("(First-token timeout (30000ms) on model=foo stage=synthesizer)");

    const streamIdle = describePipelineError("stream idle timeout after 45000ms");
    expect(streamIdle).toMatch(/stalled before responding/i);
    expect(streamIdle).toContain("(stream idle timeout after 45000ms)");

    const visible = describePipelineError(
      "No visible output or tool-call progress for 180000ms on model=foo stage=executor (hidden reasoning does not count)",
    );
    expect(visible).toMatch(/hidden reasoning/i);

    const deadline = describePipelineError("Total turn deadline (480000ms) exceeded at stage=reviewer");
    expect(deadline).toMatch(/server-authoritative turn deadline/i);

    // Existing auth mapping must still take priority for unrelated errors.
    expect(describePipelineError("API 401: invalid api key")).toMatch(/Authentication failed \(401\)/);
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
