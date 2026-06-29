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
});
