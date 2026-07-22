import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig, type JarvisConfig } from "./config";
import { chatCompletionWithFallback, clearOpenRouterCache } from "./openrouter";
import { resetModelFailureMemory } from "./model-failure-memory";
import { inferenceMetricsSnapshot } from "./inference-metrics";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetModelFailureMemory();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOpenRouterCache();
  resetModelFailureMemory();
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
  test("adapts MiniMax M3 on OpenCode Go through the Anthropic /messages protocol", async () => {
    const cfg = cfgWithPool();
    cfg.openrouter.api_key = "";
    cfg.opencode_zen.api_key = "";
    cfg.opencode_go.api_key = "sk-go-key";
    cfg.opencode_go.base_url = "https://opencode.ai/zen/go/v1";
    cfg.orchestrator.agents = [{
      id: "go-minimax-m3",
      provider: "opencode_go",
      model_id: "minimax-m3",
      capabilities: { code: 0.85, reasoning: 0.9, speed: 0.65, cost: 0.8, json_reliability: 0.8 },
      default_for: ["synthesizer"],
      enabled: true,
      cost_rank: 20,
    }];

    let attemptedUrl = "";
    let attemptedBody: Record<string, any> | undefined;
    let attemptedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      attemptedUrl = url;
      attemptedBody = JSON.parse(String(init?.body ?? "{}"));
      attemptedHeaders = init?.headers as Record<string, string>;
      return new Response([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_1","model":"minimax-m3","usage":{"input_tokens":12}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"checking"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from M3"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    const result = await chatCompletionWithFallback(cfg, {
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Say hello." },
      ],
      max_tokens: 64,
      stream: true,
    }, undefined, { stage: "synthesizer", taskType: "general" });
    const normalized = await result.response.text();

    expect(attemptedUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(attemptedHeaders?.["x-api-key"]).toBe("sk-go-key");
    expect(attemptedHeaders?.["anthropic-version"]).toBe("2023-06-01");
    expect(attemptedBody?.system).toBe("Be concise.");
    expect(attemptedBody?.messages).toEqual([{ role: "user", content: "Say hello." }]);
    expect(attemptedBody?.max_tokens).toBe(64);
    expect(normalized).toContain('"reasoning":"checking"');
    expect(normalized).toContain('"content":"Hello from M3"');
    expect(normalized).toContain('"prompt_tokens":12');
    expect(normalized).toContain("data: [DONE]");
    expect(result.provider_used).toBe("opencode_go");
    expect(result.model_used).toBe("minimax-m3");
  });

  test("sanitizes native tool history before an OpenCode attempt", async () => {
    const cfg = cfgWithPool();
    cfg.opencode_zen.base_url = "https://opencode.ai/zen/v1";
    cfg.opencode_zen.api_key = "sk-zen-key";
    cfg.orchestrator.agents = [{
      id: "zen-executor",
      provider: "opencode_zen",
      model_id: "zen-code",
      capabilities: { code: 0.95, reasoning: 0.8, speed: 0.8, cost: 1, json_reliability: 0.8 },
      default_for: ["executor"],
      enabled: true,
    }];

    let attemptedBody: Record<string, any> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      attemptedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    await chatCompletionWithFallback(cfg, {
      model: "zen-code",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", name: "read_file", tool_call_id: "c1", content: "file contents" },
      ],
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      tool_choice: "auto",
      stream: true,
    }, undefined, { stage: "executor", taskType: "general" });

    expect(attemptedBody?.tools).toBeUndefined();
    expect(attemptedBody?.tool_choice).toBeUndefined();
    expect(attemptedBody?.messages[0].tool_calls).toBeUndefined();
    expect(attemptedBody?.messages[1]).toEqual({
      role: "user",
      content: "[Tool result from read_file]: file contents",
    });
  });

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
        model_id: "deepseek/deepseek-v4-flash:free",
        capabilities: { code: 0.95, reasoning: 0.88, speed: 0.62, cost: 1, json_reliability: 0.85 },
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
            { id: "deepseek/deepseek-v4-flash:free", name: "DeepSeek", context_length: 128000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
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
    expect(strong.model_used).toBe("deepseek/deepseek-v4-flash:free");
    expect(seenChatModels.slice(0, 2)).toEqual([
      "openrouter/free",
      "deepseek/deepseek-v4-flash:free",
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
    expect(result.retries).toBe(2);
    expect(result.fallback_depth).toBe(1);
    expect(result.fallback_reason).toBe("rate_limited");

    // The two 429s represent an endpoint quota window, so a later stage must
    // skip every model on that provider instead of paying the same tax again.
    const primaryCallsBeforeSecondStage = primaryCalls.length;
    const secondStage = await chatCompletionWithFallback(
      cfg,
      { model: "cohere/north-mini-code:free", messages: [{ role: "user", content: "next stage" }], stream: true },
      undefined,
      { stage: "synthesizer", taskType: "debug" },
    );
    const primaryCallsAfterSecondStage = calls.filter(
      (c) => c.url.includes("/chat/completions") && c.model === "cohere/north-mini-code:free",
    ).length;
    expect(primaryCallsAfterSecondStage).toBe(primaryCallsBeforeSecondStage);
    expect(secondStage.provider_used).toBe("opencode_zen");
    expect(secondStage.retries).toBe(0);
  });

  test("caps the fallback chain at 3 distinct models even when the pool is larger", async () => {
    // Sub-fix C: resolveFallbackCascade can build a very long cascade (it
    // appends the entire free OpenRouter catalog as a tail), producing "model
    // roulette" — long tail latency from sequentially grinding through many
    // bad picks. chatCompletionWithFallback must attempt AT MOST 3 distinct
    // models per invocation, then fail honestly, rather than exhausting a
    // dozen-plus candidates.
    const cfg = cfgWithPool();
    cfg.openrouter.api_key = "sk-or-key";
    cfg.openrouter.max_retries = 0; // one attempt per model → deterministic advance
    // Keep the cascade to exactly the pool: a non-free `model` id + empty
    // catalog contributes no OpenRouter free tail.
    cfg.openrouter.model = "unused-primary";
    cfg.openrouter.fallbacks = [];
    cfg.orchestrator.agents = [
      { id: "m1", provider: "openrouter", model_id: "model-1", capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 }, default_for: ["executor"], enabled: true },
      { id: "m2", provider: "openrouter", model_id: "model-2", capabilities: { code: 0.9, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 }, default_for: [], enabled: true },
      { id: "m3", provider: "openrouter", model_id: "model-3", capabilities: { code: 0.85, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 }, default_for: [], enabled: true },
      { id: "m4", provider: "openrouter", model_id: "model-4", capabilities: { code: 0.8, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 }, default_for: [], enabled: true },
      { id: "m5", provider: "openrouter", model_id: "model-5", capabilities: { code: 0.75, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 }, default_for: [], enabled: true },
      { id: "m6", provider: "openrouter", model_id: "model-6", capabilities: { code: 0.7, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 }, default_for: [], enabled: true },
    ];

    const seenChatModels: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      // Every model hard-fails (400, non-retryable → immediate advance).
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;

    await expect(chatCompletionWithFallback(
      cfg,
      { model: "unused-primary", messages: [{ role: "user", content: "go" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    )).rejects.toThrow(/fallback cap 3/);

    // At most 3 DISTINCT models attempted, and exactly 3 total attempts here
    // (one per model since max_retries=0) — never the full 6-agent pool.
    const distinct = new Set(seenChatModels);
    expect(distinct.size).toBe(3);
    expect(seenChatModels.length).toBe(3);
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

  test("headers leash advances to the next cascade model when fetch never returns HTTP headers", async () => {
    // Live incident 2026-07-16 PM (session f458849c): a provider accepted the
    // connection and never returned response headers. The body-bytes watchdog
    // above only arms AFTER headers arrive, so the hung attempt was bounded
    // only by the caller's whole-request budget — 47-74s stalls that consumed
    // the stage window (planner), the turn deadline (executor, synthesizer),
    // or ended as an opaque provider error. The pre-header phase must be
    // leashed by the same first-token window and advance the cascade.
    const cfg = cfgWithPool();
    cfg.openrouter.model = "openrouter/free";
    (cfg.openrouter as any).first_token_timeout_ms = 200;
    cfg.orchestrator.agents = [
      {
        id: "hung-headers-primary",
        provider: "openrouter",
        model_id: "openrouter/free",
        capabilities: { code: 0.5, reasoning: 0.5, speed: 0.9, cost: 1, json_reliability: 0.6 },
        default_for: ["synthesizer"],
        enabled: true,
      },
      {
        id: "healthy-headers-secondary",
        provider: "openrouter",
        model_id: "cohere/north-mini-code:free",
        capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["synthesizer"],
        enabled: true,
      },
    ];

    const seenChatModels: string[] = [];
    let hungFetchStarted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free", context_length: 200000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "cohere/north-mini-code:free", name: "North", context_length: 256000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      if (body.model === "openrouter/free") {
        // Simulate a fetch that never returns headers: pending forever, and —
        // like the real fetch — rejecting with AbortError once the attempt
        // controller aborts. The post-race rejection must not crash the
        // cascade (unhandled rejection) and must not be misread as a
        // user-cancel.
        hungFetchStarted = true;
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          }, { once: true });
        });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const startedAt = Date.now();
    const result = await chatCompletionWithFallback(
      cfg,
      { model: "openrouter/free", messages: [{ role: "user", content: "synthesize" }], stream: true },
      undefined,
      { stage: "synthesizer", taskType: "general" },
    );

    expect(hungFetchStarted).toBe(true);
    expect(seenChatModels[0]).toBe("openrouter/free");
    expect(seenChatModels.length).toBeGreaterThanOrEqual(2);
    expect(result.model_used).toBe("cohere/north-mini-code:free");
    // The hung attempt must cost ~first_token_timeout_ms, not the whole
    // request budget (2s is generous headroom over the 200ms leash).
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("uses the configured OpenCode Go first-token budget before falling back", async () => {
    const cfg = cfgWithPool();
    cfg.opencode_go.api_key = "go-test-key";
    cfg.opencode_go.first_token_timeout_ms = 1_000;
    cfg.orchestrator.agents = [
      {
        id: "hung-go-primary",
        provider: "opencode_go",
        model_id: "deepseek-v4-pro",
        capabilities: { code: 0.95, reasoning: 0.9, speed: 0.7, cost: 0.5, json_reliability: 0.9 },
        default_for: ["executor"],
        enabled: true,
      },
      {
        id: "healthy-openrouter-secondary",
        provider: "openrouter",
        model_id: "cohere/north-mini-code",
        capabilities: { code: 0.8, reasoning: 0.7, speed: 0.9, cost: 0.5, json_reliability: 0.8 },
        default_for: ["executor"],
        enabled: true,
      },
    ];

    const seenChatModels: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "cohere/north-mini-code", name: "North", context_length: 256000, pricing: { prompt: "0.000001", completion: "0.000001" }, architecture: {}, supported_parameters: [], description: "" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      if (body.model === "deepseek-v4-pro") {
        const { readable } = new TransformStream();
        return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const result = await chatCompletionWithFallback(
      cfg,
      { model: "deepseek-v4-pro", messages: [{ role: "user", content: "continue" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    );

    expect(seenChatModels.slice(0, 2)).toEqual(["deepseek-v4-pro", "cohere/north-mini-code"]);
    expect(result.model_used).toBe("cohere/north-mini-code");
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

  test("cross-turn hard-failure memory: a model that 400s twice is skipped by the NEXT call's cascade", async () => {
    // Regression for Task 6 (2026-07-03 live incident): north-mini-code-free
    // (opencode_zen) returned HTTP 400 on every turn, and the in-call cascade
    // correctly advanced past it — but nothing remembered the failure, so the
    // very next turn's cascade re-picked it and burned the first attempt
    // again. model-failure-memory.ts persists strikes across separate
    // chatCompletionWithFallback calls (i.e. across turns) so a model that
    // hard-fails twice is skipped by subsequent calls until its cooldown
    // lapses.
    const cfg = cfgWithPool();
    cfg.orchestrator.agents = [
      {
        id: "flaky-a",
        provider: "openrouter",
        model_id: "flaky-model-a",
        capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["executor"],
        enabled: true,
      },
      {
        id: "healthy-b",
        provider: "openrouter",
        model_id: "healthy-model-b",
        capabilities: { code: 0.7, reasoning: 0.7, speed: 0.7, cost: 1, json_reliability: 0.7 },
        default_for: [],
        enabled: true,
      },
    ];

    const seenChatModels: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      if (body.model === "flaky-model-a") {
        return new Response("bad request", { status: 400 });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    // Call 1: flaky-model-a 400s (strike 1), cascade advances to healthy-model-b within the same call.
    const call1 = await chatCompletionWithFallback(
      cfg,
      { model: "flaky-model-a", messages: [{ role: "user", content: "turn 1" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    );
    expect(call1.model_used).toBe("healthy-model-b");

    // Call 2: flaky-model-a is still the pool default, still 400s (strike 2 — crosses the threshold).
    const call2 = await chatCompletionWithFallback(
      cfg,
      { model: "flaky-model-a", messages: [{ role: "user", content: "turn 2" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    );
    expect(call2.model_used).toBe("healthy-model-b");

    seenChatModels.length = 0;

    // Call 3: flaky-model-a now has 2 strikes and must be skipped entirely —
    // the cascade should go straight to healthy-model-b.
    const call3 = await chatCompletionWithFallback(
      cfg,
      { model: "flaky-model-a", messages: [{ role: "user", content: "turn 3" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    );
    expect(seenChatModels).not.toContain("flaky-model-a");
    expect(seenChatModels[0]).toBe("healthy-model-b");
    expect(call3.model_used).toBe("healthy-model-b");
  });

  test("cross-turn stall memory: a model that stalls pre-headers twice is skipped by the NEXT call's cascade", async () => {
    // 2026-07-16 evening (session 10cf071d): deepseek-v4-flash stalled at
    // first-token on the synthesizer in four consecutive turns. The headers
    // leash advanced the cascade *within* each call, but nothing survived
    // across turns, so every turn's answer stage burned 20-40s re-probing the
    // same sick model — exactly the hard-failure pattern, different registry.
    const cfg = cfgWithPool();
    (cfg.openrouter as any).first_token_timeout_ms = 150;
    cfg.orchestrator.agents = [
      {
        id: "stalling-a",
        provider: "openrouter",
        model_id: "stalling-model-a",
        capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["synthesizer"],
        enabled: true,
      },
      {
        id: "healthy-c",
        provider: "openrouter",
        model_id: "healthy-model-c",
        capabilities: { code: 0.7, reasoning: 0.7, speed: 0.7, cost: 1, json_reliability: 0.7 },
        default_for: [],
        enabled: true,
      },
    ];

    const seenChatModels: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      if (body.model === "stalling-model-a") {
        // Pre-headers hang; rejects with AbortError when the leash aborts.
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          }, { once: true });
        });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    // Calls 1+2: stalls (strikes 1 and 2), cascade advances within each call.
    for (const turn of ["turn 1", "turn 2"]) {
      const result = await chatCompletionWithFallback(
        cfg,
        { model: "stalling-model-a", messages: [{ role: "user", content: turn }], stream: true },
        undefined,
        { stage: "synthesizer", taskType: "general" },
      );
      expect(result.model_used).toBe("healthy-model-c");
    }

    seenChatModels.length = 0;

    // Call 3: two stall strikes → skipped entirely, no leash wait paid.
    const startedAt = Date.now();
    const call3 = await chatCompletionWithFallback(
      cfg,
      { model: "stalling-model-a", messages: [{ role: "user", content: "turn 3" }], stream: true },
      undefined,
      { stage: "synthesizer", taskType: "general" },
    );
    expect(seenChatModels).not.toContain("stalling-model-a");
    expect(call3.model_used).toBe("healthy-model-c");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("cross-turn hard-failure memory: exclusions are ignored if they would leave zero attemptable cascade entries", async () => {
    // If every remaining cascade entry is in cooldown, excluding all of them
    // would leave nothing to attempt. In that case the original (unfiltered)
    // cascade must be used anyway rather than throwing "all models exhausted"
    // prematurely.
    const cfg = cfgWithPool();
    cfg.orchestrator.agents = [
      {
        id: "only-agent",
        provider: "openrouter",
        model_id: "only-model",
        capabilities: { code: 0.9, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["executor"],
        enabled: true,
      },
    ];
    // Disable the generic OpenRouter catalog tail so "only-model" is the
    // entire cascade (no other entries to fall through to). The catalog-aware
    // tail always pushes `cfg.openrouter.model` when it equals the
    // "openrouter/free" sentinel, so point it at a non-free id instead — the
    // (empty) test catalog then contributes nothing.
    cfg.openrouter.model = "only-model";
    cfg.openrouter.fallbacks = [];

    const seenChatModels: string[] = [];
    let attempt = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      seenChatModels.push(body.model);
      attempt++;
      if (attempt <= 2) {
        return new Response("bad request", { status: 400 });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    // Call 1 and 2: only-model 400s twice, crossing the strike threshold.
    // Since only-model is the ONLY cascade entry, each of these calls has
    // nothing to fall back to and throws — that's expected and orthogonal to
    // what this test verifies (the strike recording happens in the
    // non-retryable-HTTP branch regardless of whether the cascade has more
    // entries after it).
    await expect(chatCompletionWithFallback(
      cfg,
      { model: "only-model", messages: [{ role: "user", content: "turn 1" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    )).rejects.toThrow();
    await expect(chatCompletionWithFallback(
      cfg,
      { model: "only-model", messages: [{ role: "user", content: "turn 2" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    )).rejects.toThrow();

    // Call 3: only-model is excluded, but it's the ONLY cascade entry — the
    // exclusion must be ignored (not throw), and only-model gets attempted
    // again (this attempt succeeds per the fetch stub's `attempt` counter).
    const call3 = await chatCompletionWithFallback(
      cfg,
      { model: "only-model", messages: [{ role: "user", content: "turn 3" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    );
    expect(call3.model_used).toBe("only-model");
  });


  // --- F10 telemetry contract pin (regression for dcd8a74) ---
  // The 2026-07-16 supervision-starvation remediation Phase 8 added
  // `recordInferenceAttempt` calls inside the headers-leash and body-leash
  // branches of `chatCompletionWithFallback`. The cascade-advance behavior
  // is already pinned (the "headers leash" + "first-token watchdog" tests
  // above); this block pins the OBSERVABILITY side: the failed model must
  // surface in `inferenceMetricsSnapshot().recent_attempts` with
  // `outcome: "first_token_timeout"` so the F10 / Phase 8 / Phase 9
  // live-fire SQL queries can find stalls after a real incident.

  test("hung-headers cascade advance records a first_token_timeout attempt with the failed model and stage", async () => {
    // Mirror the "headers leash" scenario above but assert the telemetry
    // side, not the cascade-advance side. The same fetch-stub (a fetch
    // that never returns HTTP headers) is used; the contract being pinned
    // is that the cascade stalled-model entry must appear in
    // `recent_attempts` with the right outcome / stage / model /
    // fallback_attempt fields so a future forensic SQL query can answer
    // "which model hung on which stage at what time".
    const cfg = cfgWithPool();
    cfg.openrouter.model = "openrouter/free";
    (cfg.openrouter as any).first_token_timeout_ms = 200;
    cfg.orchestrator.agents = [
      {
        id: "hung-headers-primary-telem",
        provider: "openrouter",
        model_id: "openrouter/free",
        capabilities: { code: 0.5, reasoning: 0.5, speed: 0.9, cost: 1, json_reliability: 0.6 },
        default_for: ["synthesizer"],
        enabled: true,
      },
      {
        id: "healthy-headers-secondary-telem",
        provider: "openrouter",
        model_id: "cohere/north-mini-code:free",
        capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["synthesizer"],
        enabled: true,
      },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free", context_length: 200000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "cohere/north-mini-code:free", name: "North", context_length: 256000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.model === "openrouter/free") {
        // Simulate a fetch that never returns headers; reject on abort.
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            (err as Error & { name: string }).name = "AbortError";
            reject(err);
          }, { once: true });
        });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const attemptsBefore = inferenceMetricsSnapshot().recent_attempts.length;
    const result = await chatCompletionWithFallback(
      cfg,
      { model: "openrouter/free", messages: [{ role: "user", content: "stuck" }], stream: true },
      undefined,
      { stage: "synthesizer", taskType: "general" },
    );
    expect(result.model_used).toBe("cohere/north-mini-code:free");

    const attemptsAfter = inferenceMetricsSnapshot().recent_attempts;
    expect(attemptsAfter.length).toBeGreaterThan(attemptsBefore);
    const newAttempts = attemptsAfter.slice(attemptsBefore);
    const hung = newAttempts.find(
      (a) => a.outcome === "first_token_timeout" && a.model === "openrouter/free",
    );
    expect(hung).toBeDefined();
    expect(hung!.stage).toBe("synthesizer");
    expect(hung!.fallback_attempt).toBe(0);
    expect(hung!.provider).toBe("openrouter");
    const json = JSON.stringify(hung);
    expect(json).not.toContain("prompt");
    expect(json).not.toContain("stuck");
  });

  test("hung-body cascade advance records a first_token_timeout attempt with the failed model and stage", async () => {
    // Mirror the "first-token watchdog" scenario above; same observability
    // contract, different timeout cause (body never produces bytes after
    // 200 OK headers arrive - the original 12+ minute stall class).
    const cfg = cfgWithPool();
    cfg.openrouter.model = "openrouter/free";
    (cfg.openrouter as any).first_token_timeout_ms = 200;
    cfg.orchestrator.agents = [
      {
        id: "hung-body-primary-telem",
        provider: "openrouter",
        model_id: "openrouter/free",
        capabilities: { code: 0.5, reasoning: 0.5, speed: 0.9, cost: 1, json_reliability: 0.6 },
        default_for: ["executor"],
        enabled: true,
      },
      {
        id: "healthy-body-secondary-telem",
        provider: "openrouter",
        model_id: "cohere/north-mini-code:free",
        capabilities: { code: 0.95, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.8 },
        default_for: ["executor"],
        enabled: true,
      },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "openrouter/free", name: "Free", context_length: 200000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
            { id: "cohere/north-mini-code:free", name: "North", context_length: 256000, pricing: { prompt: "0", completion: "0" }, architecture: {}, supported_parameters: [], description: "" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.model === "openrouter/free") {
        // Headers arrive (200 OK) but the body never yields any bytes -
        // the same shape that produced 12+ minute stalls in the wild.
        const { readable } = new TransformStream();
        return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const attemptsBefore = inferenceMetricsSnapshot().recent_attempts.length;
    const result = await chatCompletionWithFallback(
      cfg,
      { model: "openrouter/free", messages: [{ role: "user", content: "stall" }], stream: true },
      undefined,
      { stage: "executor", taskType: "general" },
    );
    expect(result.model_used).toBe("cohere/north-mini-code:free");

    const newAttempts = inferenceMetricsSnapshot().recent_attempts.slice(attemptsBefore);
    const hung = newAttempts.find(
      (a) => a.outcome === "first_token_timeout" && a.model === "openrouter/free",
    );
    expect(hung).toBeDefined();
    expect(hung!.stage).toBe("executor");
    expect(hung!.fallback_attempt).toBe(0);
    expect(hung!.provider).toBe("openrouter");
    const json = JSON.stringify(hung);
    expect(json).not.toContain("prompt");
    expect(json).not.toContain("stall");
  });
});
