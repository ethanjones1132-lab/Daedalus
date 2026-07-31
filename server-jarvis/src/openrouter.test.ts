import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defaultConfig, type JarvisConfig } from "./config";
import {
  clearOpenRouterCache,
  estimateOpenRouterMessageTokens,
  isOpenRouterFreeModel,
  isOpenRouterModelSupportsTools,
  isOpenRouterRouterModel,
  logOpenRouterCost,
  openRouterHeaders,
  openRouterModelContextLength,
  openRouterModelMaxCompletionTokens,
  resolveEffectiveOpenRouterRequestConfig,
  type OpenRouterCostInfo,
  type OpenRouterModel,
} from "./openrouter";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Each test starts with a clean cache so listOpenRouterModels hits fetch.
  clearOpenRouterCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOpenRouterCache();
  mock.restore();
});

function cfgWithOpenRouterKey(): JarvisConfig {
  const cfg = defaultConfig();
  cfg.openrouter.api_key = "test-key";
  cfg.openrouter.model = "cohere/north-mini-code:free";
  return cfg;
}

function modelFixture(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: "vendor/example-model:free",
    name: "Example Free",
    context_length: 32768,
    max_completion_tokens: 4096,
    top_provider: { context_length: 32768, max_completion_tokens: 4096 },
    pricing: { prompt: "0", completion: "0" },
    description: "",
    source: "openrouter",
    architecture: { modality: "text" },
    modality: "text",
    supported_parameters: [],
    default_parameters: {},
    is_free: false,
    is_router: false,
    created: 0,
    ...overrides,
  };
}

describe("isOpenRouterFreeModel", () => {
  test("treats the openrouter/free sentinel as free regardless of pricing", () => {
    expect(isOpenRouterFreeModel("openrouter/free")).toBe(true);
  });

  test("treats any id ending in :free as free", () => {
    expect(isOpenRouterFreeModel("cohere/north-mini-code:free")).toBe(true);
    expect(isOpenRouterFreeModel("vendor/example:free", { prompt: "0.5", completion: "0.5" })).toBe(true);
  });

  test("accepts a model object with both prices at zero", () => {
    const model = modelFixture({ id: "vendor/zero", pricing: { prompt: "0", completion: "0" } });
    expect(isOpenRouterFreeModel(model)).toBe(true);
  });

  test("rejects a model with non-zero pricing", () => {
    const model = modelFixture({ id: "vendor/paid", pricing: { prompt: "0.0001", completion: "0.0001" } });
    expect(isOpenRouterFreeModel(model)).toBe(false);
  });

  test("rejects a model with only one zero price (must be BOTH zero)", () => {
    const model = modelFixture({ id: "vendor/half-free", pricing: { prompt: "0", completion: "0.0001" } });
    expect(isOpenRouterFreeModel(model)).toBe(false);
  });

  test("uses explicit pricing override when a string id is passed", () => {
    // String id without :free suffix and without the openrouter/free sentinel
    // needs both prices at zero to count as free. Override enforces that.
    expect(isOpenRouterFreeModel("vendor/listed", { prompt: "0", completion: "0" })).toBe(true);
    expect(isOpenRouterFreeModel("vendor/listed", { prompt: "0.5", completion: "0" })).toBe(false);
  });
});

describe("isOpenRouterRouterModel", () => {
  test("matches the openrouter/free sentinel as a router", () => {
    expect(isOpenRouterRouterModel("openrouter/free")).toBe(true);
  });

  test("matches the openrouter/fusion sentinel as a router", () => {
    expect(isOpenRouterRouterModel("openrouter/fusion")).toBe(true);
  });

  test("matches a model with Router tokenizer architecture", () => {
    const model = modelFixture({
      id: "openrouter/free",
      architecture: { modality: "text", tokenizer: "Router" },
    });
    expect(isOpenRouterRouterModel(model)).toBe(true);
  });

  test("rejects plain model ids without router hints", () => {
    expect(isOpenRouterRouterModel("cohere/north-mini-code:free")).toBe(false);
    expect(isOpenRouterRouterModel("anthropic/claude-3.5-sonnet")).toBe(false);
  });

  test("rejects a model object without Router tokenizer", () => {
    const model = modelFixture({ id: "vendor/regular", architecture: { modality: "text" } });
    expect(isOpenRouterRouterModel(model)).toBe(false);
  });
});

describe("estimateOpenRouterMessageTokens", () => {
  test("returns the base overhead (64 + 4 per message) for empty messages array", () => {
    expect(estimateOpenRouterMessageTokens([])).toBe(64);
  });

  test("includes the role string length and the content length in the char total", () => {
    // role="user" (4) + content="hi" (2) + no tool_calls => ceil(6/4)=2, plus 4 per msg + 64
    // = 2 + 4 + 64 = 70
    const tokens = estimateOpenRouterMessageTokens([{ role: "user", content: "hi" }]);
    expect(tokens).toBe(70);
  });

  test("stringifies non-string content (object, number, null)", () => {
    // content object JSON length, role "assistant" length, no tool_calls
    const tokens = estimateOpenRouterMessageTokens([
      { role: "assistant", content: { parts: ["a", "b"] } },
      { role: "tool", content: null },
    ]);
    expect(typeof tokens).toBe("number");
    expect(tokens).toBeGreaterThan(0);
  });

  test("JSON-stringifies tool_calls when present", () => {
    const withTool = estimateOpenRouterMessageTokens([
      { role: "assistant", content: "", tool_calls: [{ id: "x", function: { name: "f", arguments: "{}" } }] },
    ]);
    const withoutTool = estimateOpenRouterMessageTokens([
      { role: "assistant", content: "" },
    ]);
    expect(withTool).toBeGreaterThan(withoutTool);
  });

  test("scales with message count: 3 messages > 1 message", () => {
    const one = estimateOpenRouterMessageTokens([{ role: "user", content: "x" }]);
    const three = estimateOpenRouterMessageTokens([
      { role: "user", content: "x" },
      { role: "assistant", content: "y" },
      { role: "user", content: "z" },
    ]);
    expect(three).toBeGreaterThan(one);
  });
});

describe("openRouterModelContextLength", () => {
  test("prefers top_provider.context_length when present and positive", () => {
    const model = modelFixture({ context_length: 8192, top_provider: { context_length: 131072 } });
    expect(openRouterModelContextLength(model)).toBe(131072);
  });

  test("falls back to model.context_length when top_provider absent", () => {
    const model = modelFixture({ context_length: 16384, top_provider: undefined });
    expect(openRouterModelContextLength(model)).toBe(16384);
  });

  test("returns undefined when neither source has a positive value", () => {
    const model = modelFixture({ context_length: 0, top_provider: { context_length: 0 } });
    expect(openRouterModelContextLength(model)).toBeUndefined();
  });

  test("returns undefined for missing model", () => {
    expect(openRouterModelContextLength(undefined)).toBeUndefined();
  });

  test("ignores non-positive top_provider.context_length and falls back to model", () => {
    const model = modelFixture({ context_length: 32768, top_provider: { context_length: -1 } });
    expect(openRouterModelContextLength(model)).toBe(32768);
  });
});

describe("openRouterModelMaxCompletionTokens", () => {
  test("prefers top_provider.max_completion_tokens when present and positive", () => {
    const model = modelFixture({ max_completion_tokens: 4096, top_provider: { max_completion_tokens: 8192 } });
    expect(openRouterModelMaxCompletionTokens(model)).toBe(8192);
  });

  test("falls back to model.max_completion_tokens when top_provider absent", () => {
    const model = modelFixture({ max_completion_tokens: 2048, top_provider: undefined });
    expect(openRouterModelMaxCompletionTokens(model)).toBe(2048);
  });

  test("returns undefined when the model declares no max completion tokens", () => {
    // positiveInteger(null) -> undefined (Number(null) is 0, which fails the >0 guard)
    const model = modelFixture({ max_completion_tokens: null, top_provider: { max_completion_tokens: null } });
    expect(openRouterModelMaxCompletionTokens(model)).toBeUndefined();
  });

  test("returns undefined for missing model", () => {
    expect(openRouterModelMaxCompletionTokens(undefined)).toBeUndefined();
  });
});

describe("isOpenRouterModelSupportsTools", () => {
  test("rejects empty / falsy model ids", () => {
    expect(isOpenRouterModelSupportsTools("")).toBe(false);
  });

  test("rejects the openrouter/free sentinel (router, no native tools)", () => {
    expect(isOpenRouterModelSupportsTools("openrouter/free")).toBe(false);
  });

  test("uses explicit supported_parameters when the model object declares 'tools'", () => {
    const model = modelFixture({
      id: "vendor/explicit",
      supported_parameters: ["tools", "temperature"],
    });
    expect(isOpenRouterModelSupportsTools(model)).toBe(true);
  });

  test("rejects model objects whose supported_parameters do NOT include 'tools'", () => {
    const model = modelFixture({
      id: "vendor/explicit-no-tools",
      supported_parameters: ["temperature", "top_p"],
    });
    expect(isOpenRouterModelSupportsTools(model)).toBe(false);
  });

  test("treats empty supported_parameters on a model as the legacy gate (vendor prefix decides)", () => {
    // Empty supported_parameters is the OpenRouter "no info, use the prefix matrix" signal.
    const openai = modelFixture({ id: "openai/gpt-4o-mini", supported_parameters: [] });
    expect(isOpenRouterModelSupportsTools(openai)).toBe(true);
    const qwen = modelFixture({ id: "qwen/qwen-2.5-coder-32b", supported_parameters: [] });
    expect(isOpenRouterModelSupportsTools(qwen)).toBe(false);
  });

  test("vendor prefix matrix: OpenAI / Anthropic / Google / DeepSeek / Mistral-Large => true", () => {
    expect(isOpenRouterModelSupportsTools("openai/gpt-4o-mini")).toBe(true);
    expect(isOpenRouterModelSupportsTools("anthropic/claude-3.5-sonnet")).toBe(true);
    expect(isOpenRouterModelSupportsTools("google/gemini-2.0-flash")).toBe(true);
    expect(isOpenRouterModelSupportsTools("deepseek/deepseek-chat")).toBe(true);
    expect(isOpenRouterModelSupportsTools("mistral/mistral-large-latest")).toBe(true);
  });

  test("vendor prefix matrix: qwen / meta-llama / nousresearch => false (text fallback)", () => {
    expect(isOpenRouterModelSupportsTools("qwen/qwen3-coder:free")).toBe(false);
    expect(isOpenRouterModelSupportsTools("meta-llama/llama-3.1-70b-instruct")).toBe(false);
    expect(isOpenRouterModelSupportsTools("nousresearch/hermes-3-llama-3.1-405b")).toBe(false);
  });

  test("unknown vendor prefix defaults to false (conservative: text protocol)", () => {
    expect(isOpenRouterModelSupportsTools("vendor-unknown/whatever-7b")).toBe(false);
  });
});

describe("openRouterHeaders", () => {
  test("emits Bearer Authorization, Content-Type, HTTP-Referer, and X-Title", () => {
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "sk-abc";
    cfg.openrouter.site_url = "https://example.com";
    cfg.openrouter.site_name = "My App";

    const headers = openRouterHeaders(cfg);
    expect(headers["Authorization"]).toBe("Bearer sk-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-Title"]).toBe("My App");
  });

  test("does NOT include the API key in any other field (no accidental leak in URL refs)", () => {
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "sk-secret";
    const headers = openRouterHeaders(cfg);
    expect(Object.values(headers).every((value) => !value.includes("sk-secret") || value === "Bearer sk-secret")).toBe(true);
  });
});

describe("logOpenRouterCost", () => {
  test("does not throw and does not log when cost is null", () => {
    // Capture stdout, then assert no [OpenRouter Cost] line is emitted.
    const original = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.join(" "));
    };
    try {
      logOpenRouterCost(null);
    } finally {
      console.log = original;
    }
    expect(captured.find((line) => line.includes("[OpenRouter Cost]"))).toBeUndefined();
  });

  test("logs a [OpenRouter Cost] line with total_tokens, cost to 6 decimals, model, and generation_id", () => {
    const original = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.join(" "));
    };
    const cost: OpenRouterCostInfo = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      total_cost_usd: 0.0001234567,
      generation_id: "gen-abc-123",
      model: "anthropic/claude-3.5-sonnet",
    };
    try {
      logOpenRouterCost(cost);
    } finally {
      console.log = original;
    }
    const line = captured.find((entry) => entry.includes("[OpenRouter Cost]"));
    expect(line).toBeDefined();
    expect(line).toContain("150 tokens");
    // toFixed(6) of 0.0001234567 = "0.000123"
    expect(line).toContain("$0.000123");
    expect(line).toContain("anthropic/claude-3.5-sonnet");
    expect(line).toContain("gen-abc-123");
  });
});

describe("resolveEffectiveOpenRouterRequestConfig (catalog integration)", () => {
  function fakeFetch(modelsPayload: unknown): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      // listOpenRouterModels hits `${cfg.openrouter.base_url}/models`
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: modelsPayload }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Anything else (provider probes, etc.) — return empty success
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  test("resolves a free model from the catalog: is_free=true, is_router=false, supports_tools follows model", async () => {
    const cfg = cfgWithOpenRouterKey();
    cfg.max_tokens = 4096;
    cfg.temperature = 0.7;
    const models = [
      modelFixture({
        id: "vendor/example-free:free",
        pricing: { prompt: "0", completion: "0" },
        is_free: true,
        is_router: false,
        supported_parameters: ["tools", "temperature"],
        top_provider: { context_length: 32768, max_completion_tokens: 4096 },
      }),
    ];
    globalThis.fetch = fakeFetch(models);

    const eff = await resolveEffectiveOpenRouterRequestConfig(cfg, "vendor/example-free:free", [
      { role: "user", content: "hi" },
    ]);

    expect(eff.model_id).toBe("vendor/example-free:free");
    expect(eff.is_free).toBe(true);
    expect(eff.is_router).toBe(false);
    expect(eff.supports_tools).toBe(true);
    expect(eff.supported_parameters).toEqual(["tools", "temperature"]);
    // max_tokens was 4096, the model cap is 4096, context is 32768, so we get 4096
    expect(eff.max_tokens).toBe(4096);
  });

  test("resolves a router model: is_router=true, conservativeRouterCap=8192 caps max_tokens", async () => {
    const cfg = cfgWithOpenRouterKey();
    cfg.max_tokens = 32000;
    const models = [
      modelFixture({
        id: "openrouter/fusion",
        pricing: { prompt: "0", completion: "0" },
        context_length: 200000,
        max_completion_tokens: 32000,
        top_provider: { context_length: 200000, max_completion_tokens: 32000 },
        is_free: true,
        is_router: true,
        supported_parameters: [],
      }),
    ];
    globalThis.fetch = fakeFetch(models);

    const eff = await resolveEffectiveOpenRouterRequestConfig(cfg, "openrouter/fusion", [
      { role: "user", content: "hi" },
    ]);

    expect(eff.is_router).toBe(true);
    expect(eff.is_free).toBe(true);
    // router conservative cap is 8192 — even though cfg.max_tokens is 32000,
    // the router 8192 cap is the binding upper bound.
    expect(eff.max_tokens).toBe(8192);
  });

  test("clamps temperature to <= 0.2 for router models regardless of cfg.temperature", async () => {
    const cfg = cfgWithOpenRouterKey();
    cfg.temperature = 0.95;
    const models = [
      modelFixture({
        id: "openrouter/fusion",
        is_router: true,
        is_free: true,
        supported_parameters: [],
        top_provider: { context_length: 200000, max_completion_tokens: 32000 },
      }),
    ];
    globalThis.fetch = fakeFetch(models);

    const eff = await resolveEffectiveOpenRouterRequestConfig(cfg, "openrouter/fusion", []);
    expect(eff.temperature).toBeLessThanOrEqual(0.2);
  });

  test("falls back to modelId-only path when the catalog fetch fails", async () => {
    const cfg = cfgWithOpenRouterKey();
    cfg.openrouter.api_key = "test-key";
    cfg.max_tokens = 2048;

    // Force the fetch to throw so listOpenRouterModels returns cachedModels||[] (empty).
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const eff = await resolveEffectiveOpenRouterRequestConfig(
      cfg,
      "anthropic/claude-3.5-sonnet",
      [{ role: "user", content: "ping" }],
    );

    expect(eff.model_id).toBe("anthropic/claude-3.5-sonnet");
    // No catalog hit => is_free and is_router fall back to modelId-only checks.
    expect(eff.is_free).toBe(false);
    expect(eff.is_router).toBe(false);
    // No catalog => no model metadata, so max_tokens should be undefined or the cfg's 2048.
    expect(eff.max_tokens).toBe(2048);
  });

  test("explicit requestedMaxTokens overrides the model cap when lower", async () => {
    const cfg = cfgWithOpenRouterKey();
    cfg.max_tokens = 32000;
    const models = [
      modelFixture({
        id: "vendor/cap-2k:free",
        context_length: 32768,
        max_completion_tokens: 2000,
        is_free: true,
        is_router: false,
        supported_parameters: [],
      }),
    ];
    globalThis.fetch = fakeFetch(models);

    const eff = await resolveEffectiveOpenRouterRequestConfig(
      cfg,
      "vendor/cap-2k:free",
      [{ role: "user", content: "x" }],
      { requestedMaxTokens: 500 },
    );
    expect(eff.max_tokens).toBe(500);
  });

  test("model cap wins over explicit requestedMaxTokens when model cap is lower", async () => {
    const cfg = cfgWithOpenRouterKey();
    cfg.max_tokens = 32000;
    const models = [
      modelFixture({
        id: "vendor/tiny-cap:free",
        context_length: 32768,
        max_completion_tokens: 512,
        top_provider: { context_length: 32768, max_completion_tokens: 512 },
        is_free: true,
        is_router: false,
        supported_parameters: [],
      }),
    ];
    globalThis.fetch = fakeFetch(models);

    const eff = await resolveEffectiveOpenRouterRequestConfig(
      cfg,
      "vendor/tiny-cap:free",
      [{ role: "user", content: "x" }],
      { requestedMaxTokens: 8000 },
    );
    // model cap (512) < requested (8000), so we cap at 512
    expect(eff.max_tokens).toBe(512);
  });

  test("explicit requestedTemperature overrides the cfg.temperature", async () => {
    const cfg = cfgWithOpenRouterKey();
    cfg.temperature = 0.7;
    const models = [
      modelFixture({
        id: "vendor/free:free",
        is_free: true,
        supported_parameters: [],
        default_parameters: { temperature: 0.1 },
      }),
    ];
    globalThis.fetch = fakeFetch(models);

    const eff = await resolveEffectiveOpenRouterRequestConfig(
      cfg,
      "vendor/free:free",
      [],
      { requestedTemperature: 0.42 },
    );
    expect(eff.temperature).toBeCloseTo(0.42);
  });
});
