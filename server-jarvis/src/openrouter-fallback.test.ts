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

  test("advances to the next pool model after 2 consecutive rate-limit (429) errors, routing OpenCode to its own endpoint+key", async () => {
    // Core orchestrator fallback rule: two consecutive 429s on a model → next
    // optimal pool model. The secondary here is an OpenCode Zen agent, which
    // must be called at its own base_url with its own key (NOT OpenRouter's).
    const cfg = cfgWithPool();
    cfg.openrouter.api_key = "sk-or-key";
    cfg.openrouter.max_retries = 3; // allow the 2-strike rate-limit rule to apply
    cfg.opencode_zen.base_url = "https://opencode.ai/zen/v1";
    cfg.opencode_zen.api_key = "sk-zen-key";
    cfg.orchestrator.agents = [
      {
        id: "or-primary",
        provider: "openrouter",
        model_id: "cohere/north-mini-code:free",
        capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["executor"],
        enabled: true,
      },
      {
        id: "zen-secondary",
        provider: "opencode_zen",
        model_id: "nemotron-3-ultra-free",
        capabilities: { code: 0.8, reasoning: 0.95, speed: 0.6, cost: 1, json_reliability: 0.88 },
        default_for: ["executor"],
        enabled: true,
      },
    ];

    const calls: Array<{ url: string; model: string; auth: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "cohere/north-mini-code:free", name: "North", context_length: 256000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      const auth = String((init?.headers as Record<string, string>)?.["Authorization"] ?? "");
      calls.push({ url, model: body.model, auth });
      if (body.model === "cohere/north-mini-code:free") {
        return new Response("rate limited", { status: 429 });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const result = await chatCompletionWithFallback(
      cfg,
      { model: "cohere/north-mini-code:free", messages: [{ role: "user", content: "go" }], stream: true },
      undefined,
      { stage: "executor", taskType: "debug" },
    );

    const chatCalls = calls.filter((c) => c.url.includes("/chat/completions"));
    const primaryCalls = chatCalls.filter((c) => c.model === "cohere/north-mini-code:free");
    const zenCalls = chatCalls.filter((c) => c.model === "nemotron-3-ultra-free");

    // 2 consecutive 429s on the primary, then advance.
    expect(primaryCalls.length).toBe(2);
    expect(primaryCalls.every((c) => c.url.startsWith("https://openrouter.ai/api/v1"))).toBe(true);
    expect(primaryCalls.every((c) => c.auth === "Bearer sk-or-key")).toBe(true);

    // The OpenCode Zen secondary is hit at its own endpoint with its own key.
    expect(zenCalls.length).toBe(1);
    expect(zenCalls[0].url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(zenCalls[0].auth).toBe("Bearer sk-zen-key");
    expect(result.model_used).toBe("nemotron-3-ultra-free");
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

  test("honors excludeModels when resolving its own internal cascade, preferring the stage-aware next-best over a generically-higher-scored model", async () => {
    // Regression for the 2026-07-01 live incident: the orchestrator's
    // empty-completion cascade-advance (index.ts) excludes a model that just
    // returned empty content and retries with a *different*, stage-optimal
    // candidate. But chatCompletionWithFallback re-derives its OWN cascade
    // internally via resolvePoolAgents(), which called pool.pickFor()/
    // pool.cascadeChain() WITHOUT passing excludeModels through — so the
    // caller's exclusion was silently dropped, and the excluded model's
    // fallback chain (sorted by the STAGE-AGNOSTIC overallScore(), not the
    // stage+taskType-aware score() that pickFor uses when given the same
    // exclude set) put a merely well-rounded model ahead of the model that
    // pickFor(stage, taskType, exclude) would directly and correctly select.
    //
    // Capabilities below are the REAL production numbers (agent-pool.ts) for
    // zen-nemotron-ultra-free / zen-deepseek-v4-flash-free / or-nemotron-ultra-free,
    // task_type="docs" — computed by hand:
    //   score("synthesizer","docs"): excluded-primary=1.0725, secondary(nemotron/or)=1.064, fast-balanced(deepseek)=1.056
    //   overallScore(): fast-balanced(deepseek)=0.893, secondary(nemotron/or)=0.824
    // i.e. the stage-aware ranking (secondary > fast-balanced) is the OPPOSITE
    // of the generic overallScore ranking (fast-balanced > secondary) — the
    // exact inversion that caused the live bug.
    const cfg = cfgWithPool();
    cfg.openrouter.api_key = "sk-or-key";
    cfg.opencode_zen.base_url = "https://opencode.ai/zen/v1";
    cfg.opencode_zen.api_key = "sk-zen-key";
    cfg.orchestrator.agents = [
      {
        id: "reasoning-primary",
        provider: "opencode_zen",
        model_id: "reasoning-primary",
        capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
        default_for: ["synthesizer"],
        enabled: true,
      },
      {
        id: "fast-balanced",
        provider: "opencode_zen",
        model_id: "fast-balanced",
        capabilities: { code: 0.9, reasoning: 0.86, speed: 0.82, cost: 1, json_reliability: 0.9 },
        default_for: [],
        enabled: true,
      },
      {
        id: "reasoning-secondary",
        provider: "openrouter",
        model_id: "reasoning-secondary",
        capabilities: { code: 0.78, reasoning: 0.96, speed: 0.42, cost: 1, json_reliability: 0.88 },
        default_for: [],
        enabled: true,
      },
    ];

    const seenChatModels: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "reasoning-secondary", name: "Secondary", context_length: 1000000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await chatCompletionWithFallback(
      cfg,
      { model: "reasoning-secondary", messages: [{ role: "user", content: "summarize this" }], stream: true },
      undefined,
      {
        stage: "synthesizer",
        taskType: "docs",
        excludeModels: new Set(["opencode_zen:reasoning-primary"]),
      },
    );

    // The excluded model must never be attempted.
    expect(seenChatModels).not.toContain("reasoning-primary");
    // The FIRST attempt must be the stage-aware next-best (reasoning-secondary),
    // not the generically-higher-overallScore-but-stage-inferior fast-balanced.
    expect(seenChatModels[0]).toBe("reasoning-secondary");
    expect(result.model_used).toBe("reasoning-secondary");
  });
});
