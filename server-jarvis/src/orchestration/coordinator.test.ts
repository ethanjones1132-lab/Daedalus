import { afterEach, describe, expect, test } from "bun:test";
import { Coordinator, CoordinatorError, type ChatMessage } from "./coordinator";
import {
  PersistentConductor,
  __resetPersistentConductorCachesForTests,
} from "./persistent-conductor";
import { __resetOllamaHealthCacheForTests } from "../ollama";
import type { JarvisConfig } from "../config";
import { defaultConfig } from "../config";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPersistentConductorCachesForTests();
  __resetOllamaHealthCacheForTests();
});

describe("Coordinator", () => {
  test("parses skip and re-enter decisions from coordinator JSON", async () => {
    const calls: ChatMessage[][] = [];
    const coordinator = new Coordinator(async (messages) => {
      calls.push(messages);
      return {
        content: JSON.stringify({
          task_type: "debug",
          pipeline: ["planner", null, "re-enter:planner", "synthesizer"],
          topology: "linear",
          context: {
            needs_workspace_inspection: true,
            needs_memory: true,
            estimated_complexity: "high",
          },
          coordinator_rationale: "Executor failed, re-enter planning with the error context.",
        }),
      };
    });

    const result = await coordinator.route("Fix the failing chat stream", {
      sessionId: "session-1",
      history: [{ role: "assistant", content: "Previous investigation found a stream error." }],
      lastOutcome: "executor failed: API 503",
    });

    expect(result.task_type).toBe("debug");
    expect(result.pipeline).toEqual(["planner", null, "re-enter:planner", "synthesizer"]);
    expect(result.topology).toBe("linear");
    expect(result.context.estimated_complexity).toBe("high");
    expect(result.coordinator_rationale).toContain("re-enter");
    expect(calls[0][0].role).toBe("system");
    expect(calls[0][1].content).toContain("session-1");
    expect(calls[0][1].content).toContain("executor failed: API 503");
  });

  test("falls back to a safe default route when coordinator output is unparseable", async () => {
    // A coordinator model that returns no JSON (e.g. a reasoning model that
    // emits only <think> and leaves content empty) must NOT kill the turn.
    // The route falls back to a *synthesizer-only* pipeline so the turn still
    // produces a streamed answer without dragging the user through the noisy
    // planner/executor stages that the live 2026-06-26 diagnosis showed were
    // also misbehaving on the fallback path.
    const coordinator = new Coordinator(async () => ({ content: "not json" }));

    const decision = await coordinator.route("refactor the failing chat stream module", { sessionId: "session-2" });
    expect(decision.task_type).toBe("general");
    expect(decision.topology).toBe("linear");
    // Synthesizer-only fallback — no planner, no executor.
    expect(decision.pipeline).toEqual(["synthesizer"]);
    expect(decision.coordinator_rationale).toContain("unparseable");
  });

  test("reuses the prior executor route when continuation output is unparseable", async () => {
    let calls = 0;
    const coordinator = new Coordinator(async () => ({
      content: calls++ === 0
        ? JSON.stringify({
          task_type: "debug",
          pipeline: ["planner", "executor", "reviewer", "synthesizer"],
          topology: "linear",
          context: { needs_workspace_inspection: true, needs_memory: true, estimated_complexity: "high" },
          coordinator_rationale: "Execute the requested repair.",
        })
        : "not json",
    }));

    await coordinator.route("Fix the failing stream", {
      sessionId: "continuation-reuse-1",
      rawMessage: "Fix the failing stream",
    });
    const decision = await coordinator.route("History... Current request: continue", {
      sessionId: "continuation-reuse-1",
      rawMessage: "continue",
    });

    expect(decision.pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
    expect(decision.conductor_source).toBe("continuation_reuse");
    expect(decision.coordinator_rationale).toContain("reusing previous pipeline");
  });

  test("non-continuation parse failure still uses the safe default", async () => {
    let calls = 0;
    const coordinator = new Coordinator(async () => ({
      content: calls++ === 0
        ? JSON.stringify({
          task_type: "debug",
          pipeline: ["executor", "synthesizer"],
          topology: "linear",
          context: { needs_workspace_inspection: true, needs_memory: true, estimated_complexity: "medium" },
          coordinator_rationale: "Inspect and repair.",
        })
        : "not json",
    }));
    await coordinator.route("Fix it", { sessionId: "continuation-reuse-2", rawMessage: "Fix it" });
    const decision = await coordinator.route("Explain a mutex", {
      sessionId: "continuation-reuse-2",
      rawMessage: "Explain a mutex",
    });
    expect(decision.pipeline).toEqual(["synthesizer"]);
    expect(decision.conductor_source).toBe("api");
  });

  test("ok go ahead does not trivially short-circuit after an executor route", async () => {
    let calls = 0;
    const coordinator = new Coordinator(async () => ({
      content: calls++ === 0
        ? JSON.stringify({
          task_type: "debug",
          pipeline: ["executor", "synthesizer"],
          topology: "linear",
          context: { needs_workspace_inspection: true, needs_memory: true, estimated_complexity: "medium" },
          coordinator_rationale: "Executor route.",
        })
        : "not json",
    }));
    await coordinator.route("Prepare the repair", {
      sessionId: "continuation-reuse-3",
      rawMessage: "Prepare the repair",
    });
    const decision = await coordinator.route("ok go ahead", {
      sessionId: "continuation-reuse-3",
      rawMessage: "ok go ahead",
    });
    expect(calls).toBe(2);
    expect(decision.conductor_source).toBe("continuation_reuse");
    expect(decision.pipeline).toContain("executor");
  });

  test("propagates a genuine transport failure (callModel throws → caller surfaces an error)", async () => {
    // When the model call itself fails (all providers exhausted, auth, etc.)
    // the error must propagate so the turn surfaces an error banner — only
    // unparseable OUTPUT is recovered via the default route.
    const coordinator = new Coordinator(async () => {
      throw new Error("All provider models exhausted. Last error: HTTP 401");
    });

    await expect(coordinator.route("debug the failing auth module", { sessionId: "session-3" })).rejects.toThrow(/exhausted/);
  });

  test("trivial conversational turns skip the model call and route synthesizer-only", async () => {
    let modelCalls = 0;
    const coordinator = new Coordinator(async () => {
      modelCalls++;
      return { content: "{}" };
    });

    const decision = await coordinator.route("Hey buddy, how are you today?", { sessionId: "triage-1" });

    expect(modelCalls).toBe(0);
    expect(decision.pipeline).toEqual(["synthesizer"]);
    expect(decision.task_type).toBe("general");
    expect(decision.topology).toBe("linear");
  });

  test("task requests still call the coordinator model", async () => {
    let modelCalls = 0;
    const coordinator = new Coordinator(async () => {
      modelCalls++;
      return {
        content: JSON.stringify({
          task_type: "general",
          pipeline: ["planner", "executor", "synthesizer"],
          topology: "linear",
          context: { needs_workspace_inspection: true, needs_memory: true, estimated_complexity: "medium" },
          coordinator_rationale: "real task",
        }),
      };
    });

    await coordinator.route("Summarize this repo and name one improvement", { sessionId: "triage-2" });
    expect(modelCalls).toBe(1);
  });

  test("uses local persistent conductor when Ollama is available", async () => {
    let apiCalls = 0;
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: [{ name: "gemma4:e2b" }] });
      }
      if (url.endsWith("/api/chat")) {
        return Response.json({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "route_pipeline",
                arguments: {
                  task_type: "debug",
                  pipeline: ["planner", "executor", "synthesizer"],
                  topology: "linear",
                  context: {
                    needs_workspace_inspection: true,
                    needs_memory: true,
                    estimated_complexity: "high",
                  },
                  coordinator_rationale: "Local conductor route.",
                },
              },
            }],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const cfg: JarvisConfig = defaultConfig();
    cfg.orchestrator.conductor.enabled = true;
    cfg.orchestrator.conductor.persist_sessions = false;
    const conductor = new PersistentConductor(() => cfg);
    const coordinator = new Coordinator(async () => {
      apiCalls += 1;
      return { content: "{}" };
    }, conductor);

    const decision = await coordinator.route("Fix the auth module", { sessionId: "local-1" });

    expect(apiCalls).toBe(0);
    expect(decision.task_type).toBe("debug");
    expect(decision.pipeline).toEqual(["planner", "executor", "synthesizer"]);
  });

  test("falls back to API coordinator when local conductor is unavailable", async () => {
    (globalThis as any).fetch = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/tags")) {
        return Response.json({ models: [] });
      }
      if (url.includes("/api/chat")) {
        throw new Error("local chat unavailable");
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    let apiCalls = 0;
    const cfg: JarvisConfig = defaultConfig();
    cfg.orchestrator.conductor.enabled = true;
    cfg.orchestrator.conductor.fallback_to_api = true;
    const conductor = new PersistentConductor(() => cfg);
    const coordinator = new Coordinator(async () => {
      apiCalls += 1;
      return {
        content: JSON.stringify({
          task_type: "general",
          pipeline: ["synthesizer"],
          topology: "linear",
          context: {
            needs_workspace_inspection: false,
            needs_memory: true,
            estimated_complexity: "low",
          },
          coordinator_rationale: "API fallback.",
        }),
      };
    }, conductor);

    await coordinator.route("Summarize the auth module and list one fix", { sessionId: "fallback-1" });
    expect(apiCalls).toBe(1);
  });

  test("parses optional worker_instructions and shared_context", async () => {
    const coordinator = new Coordinator(async () => ({
      content: JSON.stringify({
        task_type: "debug",
        pipeline: ["planner", "executor", "synthesizer"],
        topology: "linear",
        context: {
          needs_workspace_inspection: true,
          needs_memory: true,
          estimated_complexity: "high",
        },
        coordinator_rationale: "Needs targeted debugging guidance.",
        worker_instructions: {
          planner: "  Inspect server-jarvis/src/index.ts first. ",
          executor: "Run read_file on the orchestrator path, then propose a minimal fix.",
          synthesizer: "",
        },
        shared_context: {
          relevant_memories: ["Prior turn hit empty_completion on synthesizer."],
          failure_patterns: ["Do not route file reads to synthesizer-only."],
          prior_tool_results: { "grep:coordinator": "3 matches in orchestration/" },
        },
      }),
    }));

    const decision = await coordinator.route("Debug the orchestrator routing path", { sessionId: "worker-inst-1" });

    expect(decision.worker_instructions?.planner).toContain("index.ts");
    expect(decision.worker_instructions?.executor).toContain("read_file");
    expect(decision.worker_instructions?.synthesizer).toBeUndefined();
    expect(decision.shared_context?.relevant_memories).toHaveLength(1);
    expect(decision.shared_context?.failure_patterns?.[0]).toContain("synthesizer-only");
    expect(decision.shared_context?.prior_tool_results?.["grep:coordinator"]).toContain("matches");
  });

  test("suppresses coordinator activity from the user-visible stream", async () => {
    const optionsSeen: unknown[] = [];
    const coordinator = new Coordinator(async (_messages, options) => {
      optionsSeen.push(options);
      return {
        content: JSON.stringify({
          task_type: "general",
          pipeline: ["synthesizer"],
          topology: "linear",
          context: {
            needs_workspace_inspection: false,
            needs_memory: true,
            estimated_complexity: "low",
          },
          coordinator_rationale: "Simple request.",
        }),
      };
    });

    await coordinator.route("say hi", { sessionId: "session-3" });

    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]).toMatchObject({
      stageLabel: "coordinator",
      suppressActivity: true,
    });
  });

  // ── Track B / B-01: conductor_replan decision type ────────────────────
  // B-01 acceptance: Coordinator.validate() accepts replan decisions.
  // The meta decision must round-trip through the coordinator model output
  // untouched so the conductor's recursive self-selection has a stable wire
  // contract.
  test("B-01: validates a pipeline containing a conductor_replan meta decision", async () => {
    const coordinator = new Coordinator(async () => ({
      content: JSON.stringify({
        task_type: "debug",
        pipeline: ["planner", "executor", "conductor_replan", "synthesizer"],
        topology: "linear",
        context: {
          needs_workspace_inspection: true,
          needs_memory: true,
          estimated_complexity: "high",
        },
        coordinator_rationale:
          "Executor discovered an unexpected schema — pause to replan worker instructions before continuing.",
      }),
    }));

    const result = await coordinator.route("Replan after the executor surprises", { sessionId: "b-01-validate" });

    // The meta decision survives the validate() round-trip exactly as
    // emitted by the model — the runtime never silently rewrites it.
    expect(result.pipeline).toEqual([
      "planner",
      "executor",
      "conductor_replan",
      "synthesizer",
    ]);
    expect(result.topology).toBe("linear");
    expect(result.coordinator_rationale).toContain("replan");
  });

  test("B-01: executablePipeline skips conductor_replan but runs the surrounding stages", async () => {
    const coordinator = new Coordinator(async () => ({
      content: JSON.stringify({
        task_type: "debug",
        pipeline: ["planner", "executor", "conductor_replan", "synthesizer"],
        topology: "linear",
        context: {
          needs_workspace_inspection: true,
          needs_memory: true,
          estimated_complexity: "high",
        },
        coordinator_rationale: "Replan mid-pipeline.",
      }),
    }));

    const result = await coordinator.route("execute then replan then answer", { sessionId: "b-01-exec" });

    // The meta decision is preserved in decision.pipeline (so B-02 can
    // intercept it before stage execution) but the executable pipeline
    // skips it — the surrounding stages run as usual.
    const executable = coordinator.executablePipeline(result);
    expect(executable).toEqual(["planner", "executor", "synthesizer"]);
    expect(executable).not.toContain("conductor_replan");
  });

  test("B-01: executablePipeline falls back to synthesizer if conductor_replan is the only entry", async () => {
    // Pathological but well-defined case: a model that emits ONLY the meta
    // decision. The pipeline is empty after stripping meta decisions, so the
    // executable pipeline falls back to a single synthesizer (matching the
    // existing null/empty behavior — the user always sees a final answer).
    const coordinator = new Coordinator(async () => ({
      content: JSON.stringify({
        task_type: "general",
        pipeline: ["conductor_replan"],
        topology: "linear",
        context: {
          needs_workspace_inspection: false,
          needs_memory: true,
          estimated_complexity: "low",
        },
        coordinator_rationale: "Just replan, nothing else.",
      }),
    }));

    const result = await coordinator.route("only meta decision", { sessionId: "b-01-only-meta" });
    expect(result.pipeline).toEqual(["conductor_replan"]);

    const executable = coordinator.executablePipeline(result);
    expect(executable).toEqual(["synthesizer"]);
  });

  test("B-01: validate() still rejects an unknown stage decision", async () => {
    // Regression guard: the conductor_replan addition must NOT make the
    // validator too permissive. An unknown stage name must still throw
    // CoordinatorError so the routing parse-fallback kicks in.
    const coordinator = new Coordinator(async () => ({
      content: JSON.stringify({
        task_type: "general",
        pipeline: ["planner", "executor", "totally_made_up_stage", "synthesizer"],
        topology: "linear",
        context: {
          needs_workspace_inspection: false,
          needs_memory: true,
          estimated_complexity: "low",
        },
        coordinator_rationale: "invalid stage should throw",
      }),
    }));

    // The coordinator's resilient route() catches the parse error and
    // falls back to the default synthesizer-only route. We assert the
    // decision is the safe default, not the model output.
    const result = await coordinator.route("inject bad stage", { sessionId: "b-01-bad" });
    expect(result.pipeline).toEqual(["synthesizer"]);
    expect(result.coordinator_rationale).toContain("unparseable");
  });
});
