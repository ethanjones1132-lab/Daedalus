import { describe, expect, test, beforeEach } from "bun:test";
import { defaultConfig } from "../../config";
import { __resetLocalTargetCacheForTests } from "./ollama-local-transport";
import { makeLocalCallModel, resolveLocalStageModels } from "./local-call-model";

const BASE = "http://ollama.test:11434";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(handlers: {
  chat?: (body: Record<string, unknown>) => unknown;
  showCapabilities?: string[];
}) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return jsonResponse({
        models: [{ name: "qwen3.5:4b" }, { name: "qwen3:8b" }, { name: "gemma4:e2b" }],
      });
    }
    if (url.endsWith("/api/show")) {
      return jsonResponse({
        capabilities: handlers.showCapabilities ?? ["tools", "completion"],
      });
    }
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const payload =
        handlers.chat?.(body) ??
        ({
          message: { role: "assistant", content: "done", tool_calls: [] },
          model: body.model,
          prompt_eval_count: 100,
          eval_count: 10,
        } as const);
      return jsonResponse(payload);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

beforeEach(() => {
  __resetLocalTargetCacheForTests();
});

describe("resolveLocalStageModels", () => {
  test("intersects conductor pair + defaults with installed", () => {
    const cfg = defaultConfig();
    cfg.orchestrator.conductor.model = "qwen3.5:4b";
    cfg.orchestrator.conductor.fallback_model = "qwen3:8b";
    const models = resolveLocalStageModels(cfg, ["qwen3.5:4b", "other:1b"]);
    expect(models).toContain("qwen3.5:4b");
    expect(models).not.toContain("other:1b");
  });
});

describe("makeLocalCallModel", () => {
  test("empty content with thinking increments thinkingOnlyTurns; content stays empty", async () => {
    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    const callModel = makeLocalCallModel(cfg, {
      localModelsOverride: ["qwen3.5:4b"],
      deps: {
        fetch: makeFetch({
          chat: () => ({
            message: {
              role: "assistant",
              content: "",
              thinking: "lots of reasoning tokens here",
            },
            model: "qwen3.5:4b",
            prompt_eval_count: 50,
          }),
        }) as typeof fetch,
      },
    });

    const result = await callModel(
      [{ role: "user", content: "hi" }],
      { stageLabel: "executor" },
    );

    expect(result.content).toBe("");
    expect(result._provider).toBe("ollama");
    expect(callModel.stats.emptyContentTurns).toBe(1);
    expect(callModel.stats.thinkingOnlyTurns).toBe(1);
    expect(callModel.stats.calls).toBe(1);
  });

  test("non-ollama pool pick pins local model and increments nonLocalPickFallbacks", async () => {
    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    // Empty agents + no local injection stage preference outside rollout ALS:
    // pickFor for a stage that does not prefer local with ollamaAvailable still
    // injects when preferLocalForStage is true (planner/reviewer), or when
    // runRolloutLocalOnly is active. Force a remote-only pool with a stage that
    // does not prefer local and without rollout ALS → non-ollama pick.
    cfg.orchestrator.agents = [
      {
        id: "remote-only",
        provider: "openrouter",
        model_id: "cohere/north-mini-code:free",
        enabled: true,
        default_for: ["executor", "planner", "reviewer", "synthesizer"],
        capabilities: {
          code: 0.8,
          reasoning: 0.8,
          speed: 0.8,
          cost: 0.1,
          json_reliability: 0.8,
        },
      },
    ];

    const callModel = makeLocalCallModel(cfg, {
      localModelsOverride: ["qwen3.5:4b"],
      deps: {
        fetch: makeFetch({
          chat: (body) => {
            // Must pin to local, never remote model id.
            expect(body.model).toBe("qwen3.5:4b");
            return {
              message: { role: "assistant", content: "local" },
              model: "qwen3.5:4b",
              prompt_eval_count: 10,
            };
          },
        }) as typeof fetch,
      },
    });

    // synthesizer: preferLocalForStage is false outside rollout ALS, so
    // injectLocalStageCandidates does not fire; pool returns openrouter agent
    // → nonLocalPickFallbacks.
    const result = await callModel(
      [{ role: "user", content: "hi" }],
      { stageLabel: "synthesizer" },
    );

    expect(result._provider).toBe("ollama");
    expect(result._modelUsed).toBe("qwen3.5:4b");
    expect(callModel.stats.nonLocalPickFallbacks).toBe(1);
  });

  test("per-stage selection: four stageLabels resolve through pickFor", async () => {
    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    // Prefer local stages get injected ollama; pin ollama agents for all stages.
    const caps = (partial: Partial<{ code: number; reasoning: number; speed: number }>) => ({
      code: partial.code ?? 0.7,
      reasoning: partial.reasoning ?? 0.7,
      speed: partial.speed ?? 0.7,
      cost: 0.05,
      json_reliability: 0.8,
    });
    cfg.orchestrator.agents = [
      {
        id: "local-planner",
        provider: "ollama",
        model_id: "qwen3.5:4b",
        enabled: true,
        default_for: ["planner"],
        capabilities: caps({ reasoning: 0.8, speed: 0.9 }),
      },
      {
        id: "local-executor",
        provider: "ollama",
        model_id: "qwen3:8b",
        enabled: true,
        default_for: ["executor"],
        capabilities: caps({ code: 0.9, speed: 0.7 }),
      },
      {
        id: "local-reviewer",
        provider: "ollama",
        model_id: "qwen3.5:4b",
        enabled: true,
        default_for: ["reviewer"],
        capabilities: caps({ reasoning: 0.9, speed: 0.8 }),
      },
      {
        id: "local-synth",
        provider: "ollama",
        model_id: "qwen3:8b",
        enabled: true,
        default_for: ["synthesizer"],
        capabilities: caps({ speed: 0.95 }),
      },
    ];

    const modelsUsed: string[] = [];
    const callModel = makeLocalCallModel(cfg, {
      localModelsOverride: ["qwen3.5:4b", "qwen3:8b"],
      deps: {
        fetch: makeFetch({
          chat: (body) => {
            modelsUsed.push(String(body.model));
            return {
              message: { role: "assistant", content: `ok-${body.model}` },
              model: body.model,
              prompt_eval_count: 20,
            };
          },
        }) as typeof fetch,
      },
    });

    for (const stage of ["planner", "executor", "reviewer", "synthesizer"] as const) {
      const r = await callModel([{ role: "user", content: "x" }], { stageLabel: stage });
      expect(r._provider).toBe("ollama");
      expect(r.content).toMatch(/^ok-/);
    }
    expect(modelsUsed).toHaveLength(4);
    expect(callModel.stats.calls).toBe(4);
    // All four should have resolved without non-local fallback.
    expect(callModel.stats.nonLocalPickFallbacks).toBe(0);
  });

  test("native tools path includes tools; text path does not and still returns content", async () => {
    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    const toolDef = {
      type: "function" as const,
      function: {
        name: "edit_file",
        description: "edit a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    };

    let sawTools: boolean | undefined;
    const callModel = makeLocalCallModel(cfg, {
      localModelsOverride: ["qwen3.5:4b"],
      deps: {
        fetch: makeFetch({
          showCapabilities: ["tools"],
          chat: (body) => {
            sawTools = Array.isArray(body.tools);
            return {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    function: {
                      name: "edit_file",
                      arguments: { path: "a.py" },
                    },
                  },
                ],
              },
              model: "qwen3.5:4b",
              prompt_eval_count: 30,
            };
          },
        }) as typeof fetch,
      },
    });

    const result = await callModel(
      [{ role: "user", content: "edit" }],
      { stageLabel: "executor", tools: [toolDef] },
    );
    expect(sawTools).toBe(true);
    expect(result.tool_calls?.length).toBe(1);
    expect(result.tool_calls?.[0]?.name).toBe("edit_file");
  });

  test("text-protocol when model lacks tools capability", async () => {
    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    const toolDef = {
      type: "function" as const,
      function: {
        name: "edit_file",
        description: "edit a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"] as string[],
        },
      },
    };

    let sawTools: boolean | undefined;
    let systemHasTextProtocol = false;
    const callModel = makeLocalCallModel(cfg, {
      localModelsOverride: ["qwen3.5:4b"],
      deps: {
        fetch: makeFetch({
          showCapabilities: ["completion"], // no "tools"
          chat: (body) => {
            sawTools = Array.isArray(body.tools);
            const messages = body.messages as Array<{ role: string; content: string }>;
            systemHasTextProtocol = messages.some(
              (m) => m.role === "system" && /tool/i.test(m.content),
            );
            return {
              message: {
                role: "assistant",
                content: 'I will call edit_file with path="a.py"',
              },
              model: "qwen3.5:4b",
              prompt_eval_count: 40,
            };
          },
        }) as typeof fetch,
      },
    });

    await callModel(
      [{ role: "system", content: "You are helpful." }, { role: "user", content: "edit" }],
      { stageLabel: "executor", tools: [toolDef] },
    );
    expect(sawTools).toBe(false);
    expect(systemHasTextProtocol).toBe(true);
  });

  test("stageAbort aborts through the CallModelFn", async () => {
    const cfg = defaultConfig();
    cfg.ollama.base_url = `${BASE}/v1`;
    const ctrl = new AbortController();
    // Abort before the call so combineAbortSignals sees an already-aborted
    // signal and the hanging fetch rejects without a wall-clock wait.
    ctrl.abort();
    const callModel = makeLocalCallModel(cfg, {
      localModelsOverride: ["qwen3.5:4b"],
      timeoutMs: 5_000,
      deps: {
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(_input);
          if (url.endsWith("/api/tags")) {
            return jsonResponse({ models: [{ name: "qwen3.5:4b" }] });
          }
          if (url.endsWith("/api/show")) {
            return jsonResponse({ capabilities: ["tools"] });
          }
          if (init?.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        }) as typeof fetch,
      },
    });

    await expect(
      callModel(
        [{ role: "user", content: "hi" }],
        { stageLabel: "executor", stageAbort: ctrl.signal },
      ),
    ).rejects.toThrow();
  });
});
