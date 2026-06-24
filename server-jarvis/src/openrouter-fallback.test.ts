import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig, type JarvisConfig } from "./config";
import { chatCompletionWithFallback, clearOpenRouterCache } from "./openrouter";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOpenRouterCache();
});

function cfgWithPool(): JarvisConfig {
  const cfg = defaultConfig();
  cfg.active_backend = "openrouter";
  cfg.openrouter.api_key = "sk-or-v1-test";
  cfg.openrouter.base_url = "https://openrouter.ai/api/v1";
  cfg.openrouter.model = "openrouter/free";
  cfg.openrouter.max_retries = 0;
  cfg.orchestrator.agents = [
    {
      id: "code-primary",
      provider: "openrouter",
      model_id: "cohere/north-mini-code:free",
      capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
      default_for: ["executor"],
      enabled: true,
    },
    {
      id: "zen-skip",
      provider: "opencode_zen",
      model_id: "opencode/big-pickle",
      capabilities: { code: 0.9, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.75 },
      default_for: ["executor"],
      enabled: true,
    },
    {
      id: "reasoning-fallback",
      provider: "openrouter",
      model_id: "nvidia/nemotron-3-ultra-550b-a55b:free",
      capabilities: { code: 0.75, reasoning: 0.95, speed: 0.45, cost: 1, json_reliability: 0.88 },
      default_for: ["reviewer"],
      enabled: true,
    },
  ];
  return cfg;
}

describe("chatCompletionWithFallback AgentPool integration", () => {
  test("uses the stage-specific OpenRouter agent chain before generic fallbacks", async () => {
    const seenChatModels: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free", context_length: 200000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "cohere/north-mini-code:free", name: "North", context_length: 256000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron", context_length: 1000000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      if (body.model === "cohere/north-mini-code:free") {
        return new Response("busy", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await chatCompletionWithFallback(
      cfgWithPool(),
      { model: "openrouter/free", messages: [{ role: "user", content: "fix the bug" }], stream: true },
      undefined,
      { stage: "executor", taskType: "debug" },
    );

    expect(result.model_used).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(seenChatModels.slice(0, 2)).toEqual([
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]);
    expect(seenChatModels).not.toContain("opencode/big-pickle");
  });

  test("uses cascade tier to put cheap and strong pool agents first", async () => {
    const cfg = cfgWithPool();
    cfg.orchestrator.agents = [
      {
        id: "cheap-fast",
        provider: "openrouter",
        model_id: "openrouter/free",
        capabilities: { code: 0.62, reasoning: 0.55, speed: 0.96, cost: 1, json_reliability: 0.7 },
        default_for: ["executor"],
        enabled: true,
      },
      {
        id: "strong-worker",
        provider: "openrouter",
        model_id: "deepseek/deepseek-v4-flash",
        capabilities: { code: 0.95, reasoning: 0.88, speed: 0.62, cost: 0.45, json_reliability: 0.85 },
        default_for: ["executor"],
        enabled: true,
      },
    ];

    const seenChatModels: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free", context_length: 200000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "deepseek/deepseek-v4-flash", name: "DeepSeek", context_length: 128000, pricing: { prompt: "0.0000002", completion: "0.0000002" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const cheap = await chatCompletionWithFallback(
      cfg,
      { model: "openrouter/free", messages: [{ role: "user", content: "try cheaply" }], stream: true },
      undefined,
      { stage: "executor", taskType: "debug", cascadeTier: "cheap" },
    );
    const strong = await chatCompletionWithFallback(
      cfg,
      { model: "openrouter/free", messages: [{ role: "user", content: "escalate" }], stream: true },
      undefined,
      { stage: "executor", taskType: "debug", cascadeTier: "strong" },
    );

    expect(cheap.model_used).toBe("openrouter/free");
    expect(strong.model_used).toBe("deepseek/deepseek-v4-flash");
    expect(seenChatModels.slice(0, 2)).toEqual([
      "openrouter/free",
      "deepseek/deepseek-v4-flash",
    ]);
  });

  test("first-token watchdog advances to the next cascade model on a hung response body", async () => {
    // Regression: openrouter/free opened the response stream then never
    // sent any body bytes (12+ minute stalls, post-hang diagnosis
    // 2026-06-24). The first-token watchdog in chatCompletionWithFallback
    // must abort the hung attempt and advance to the next model rather
    // than returning the hung stream to the caller.
    const cfg = cfgWithPool();
    cfg.openrouter.model = "openrouter/free";
    // Tight timeout so the test runs in <2s.
    (cfg.openrouter as any).first_token_timeout_ms = 200;
    // Force the pool so openrouter/free IS the primary for the executor
    // stage and there's a deterministic secondary to fall back to.
    cfg.orchestrator.agents = [
      {
        id: "hung-primary",
        provider: "openrouter",
        model_id: "openrouter/free",
        capabilities: { code: 0.5, reasoning: 0.5, speed: 0.9, cost: 1, json_reliability: 0.6 },
        default_for: ["executor"],
        enabled: true,
      },
      {
        id: "healthy-secondary",
        provider: "openrouter",
        model_id: "cohere/north-mini-code:free",
        capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["executor"],
        enabled: true,
      },
    ];

    const seenChatModels: string[] = [];
    let hungFetchReturned = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free", context_length: 200000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "cohere/north-mini-code:free", name: "North", context_length: 256000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron", context_length: 1000000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      if (body.model === "openrouter/free") {
        // Simulate a hung openrouter/free: HTTP 200 with a body that
        // never produces any bytes. The Response body is a stream
        // that never yields.
        hungFetchReturned = true;
        const { readable, writable } = new TransformStream();
        // Intentionally do not close the writable side — body hangs.
        return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const result = await chatCompletionWithFallback(
      cfg,
      { model: "openrouter/free", messages: [{ role: "user", content: "do the thing" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    );

    expect(hungFetchReturned).toBe(true);
    expect(seenChatModels[0]).toBe("openrouter/free");
    // The first-token watchdog should have aborted openrouter/free and
    // advanced to the next cascade model.
    expect(seenChatModels.length).toBeGreaterThanOrEqual(2);
    expect(result.model_used).toBe("cohere/north-mini-code:free");
  });
});
