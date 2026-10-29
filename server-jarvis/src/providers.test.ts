import { describe, expect, test } from "bun:test";
import { defaultConfig, type JarvisConfig } from "./config";
import * as configModule from "./config";
import * as providerModule from "./providers";
import { chatCompletionWithFallback } from "./openrouter";
import { isProviderAvailable, routableOrchestratorAgents } from "./provider-availability";
import {
  providerChatUrl,
  providerHeaders,
  resolveProviderTarget,
  UnroutableProviderError,
  type HttpProviderId,
} from "./providers";

/** Tiny helper — produces a base JarvisConfig with known keys for every reachable provider. */
function configWith(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  const cfg = defaultConfig();
  cfg.openrouter.api_key = "or-key";
  cfg.openrouter.base_url = "https://openrouter.ai/api/v1";
  cfg.openrouter.site_url = "https://jarvis.local";
  cfg.openrouter.site_name = "Jarvis Test";
  cfg.opencode_zen.api_key = "zen-key";
  cfg.opencode_zen.base_url = "https://opencode.ai/zen/v1";
  cfg.opencode_zen.first_token_timeout_ms = 45_000;
  cfg.opencode_go.api_key = "go-key";
  cfg.opencode_go.base_url = "https://opencode.ai/zen/go/v1";
  cfg.opencode_go.first_token_timeout_ms = 45_000;
  return Object.assign(cfg, overrides);
}

function configWithVllm(overrides: Record<string, unknown> = {}): JarvisConfig {
  return Object.assign(defaultConfig(), {
    vllm: {
      enabled: true,
      base_url: "http://127.0.0.1:8000/v1",
      model: "Qwen/Qwen3-32B-AWQ",
      api_key_env: "VLLM_TEST_API_KEY",
      first_token_timeout_ms: 120_000,
      ...overrides,
    },
  }) as unknown as JarvisConfig;
}

function chatConfig(): JarvisConfig {
  const cfg = configWithVllm();
  cfg.openrouter.api_key = "";
  cfg.openrouter.base_url = "http://openrouter.invalid/v1";
  cfg.openrouter.max_retries = 0;
  cfg.orchestrator.agents = [];
  return cfg;
}

async function withNetworkDisabled<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("unexpected global fetch; provider tests must inject a fetcher");
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function fakeProviderFetch(
  onChat: (url: string, init: RequestInit) => Response | Promise<Response>,
  calls: Array<{ url: string; init: RequestInit }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "http://openrouter.invalid/v1/models") {
      return Response.json({ data: [] });
    }
    return onChat(url, init);
  }) as typeof fetch;
}

describe("vLLM provider target", () => {
  test("resolves the configured endpoint and environment-backed key", () => {
    const target = resolveProviderTarget(
      configWithVllm(),
      "vllm",
      { VLLM_TEST_API_KEY: "vllm-key" },
    );

    expect(target.provider).toBe("vllm");
    expect(target.base_url).toBe("http://127.0.0.1:8000/v1");
    expect(target.api_key).toBe("vllm-key");
    expect(target.chat_path).toBe("/chat/completions");
  });

  test("strips trailing slashes and defaults an invalid first-token timeout", () => {
    const target = resolveProviderTarget(
      configWithVllm({
        base_url: "http://gpu.local:8000/v1//",
        api_key_env: "",
        first_token_timeout_ms: 0,
      }),
      "vllm",
      {},
    );

    expect(target.base_url).toBe("http://gpu.local:8000/v1");
    expect(providerChatUrl(target)).toBe("http://gpu.local:8000/v1/chat/completions");
    expect(target.first_token_timeout_ms).toBe(120_000);
  });

  test("returns a typed configuration error when the provider is disabled", () => {
    let error: unknown;
    try {
      resolveProviderTarget(configWithVllm({ enabled: false }), "vllm", {});
    } catch (caught) {
      error = caught;
    }

    expect((error as Error)?.name).toBe("VllmProviderConfigurationError");
    expect((error as { code?: string })?.code).toBe("VLLM_NOT_CONFIGURED");
  });

  test("returns a typed configuration error when a referenced key is unset", () => {
    let error: unknown;
    try {
      resolveProviderTarget(configWithVllm(), "vllm", {});
    } catch (caught) {
      error = caught;
    }

    expect((error as Error)?.name).toBe("VllmProviderConfigurationError");
    expect((error as { code?: string })?.code).toBe("VLLM_NOT_CONFIGURED");
  });

  test("rejects base URLs with a query or fragment", () => {
    for (const base_url of [
      "http://gpu.local:8000/v1?access=private",
      "http://gpu.local:8000/v1?",
      "http://gpu.local:8000/v1#fragment",
      "http://gpu.local:8000/v1#",
    ]) {
      expect(() => resolveProviderTarget(
        configWithVllm({ base_url, api_key_env: "" }),
        "vllm",
        {},
      )).toThrow(providerModule.VllmProviderConfigurationError);
    }
  });
});

describe("vLLM config", () => {
  test("ships disabled with blank endpoint, model, and key reference", () => {
    const cfg = defaultConfig() as JarvisConfig & { vllm?: Record<string, unknown> };

    expect(cfg.vllm).toEqual({
      enabled: false,
      base_url: "",
      model: "",
      api_key_env: "",
      first_token_timeout_ms: 120_000,
    });
    expect(Object.keys(cfg.vllm ?? {})).not.toContain("api_key");
  });

  test("normalizes the explicit vLLM fields without retaining a literal key", () => {
    const parse = (configModule as any).normalizeVllmConfig;
    const parsed = parse({
      enabled: true,
      base_url: " http://gpu.local:8000/v1/ ",
      model: " Qwen/Qwen3-32B-AWQ ",
      api_key_env: " VLLM_API_KEY ",
      first_token_timeout_ms: 0,
      api_key: "bad-key",
    });

    expect(parsed).toEqual({
      enabled: true,
      base_url: "http://gpu.local:8000/v1/",
      model: "Qwen/Qwen3-32B-AWQ",
      api_key_env: "VLLM_API_KEY",
      first_token_timeout_ms: 120_000,
    });
  });

  test("rejects enabled configs with an invalid endpoint, missing model, or literal key", () => {
    const cfg = Object.assign(defaultConfig(), {
      vllm: {
        enabled: true,
        base_url: "file:///private/endpoint",
        model: "",
        api_key_env: "bad-key",
        first_token_timeout_ms: 120_000,
        api_key: "bad-key",
      },
    }) as unknown as JarvisConfig;

    const validation = (configModule as any).validateConfig(cfg);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("vllm.base_url");
    expect(validation.errors.join(" ")).toContain("vllm.model");
    expect(validation.errors.join(" ")).toContain("vllm.api_key_env");
  });

  test("rejects enabled endpoints with query strings and fragments", () => {
    for (const base_url of [
      "http://gpu.local:8000/v1?access=private",
      "http://gpu.local:8000/v1?",
      "http://gpu.local:8000/v1#fragment",
      "http://gpu.local:8000/v1#",
    ]) {
      const cfg = configWithVllm({ base_url, api_key_env: "" });
      const validation = (configModule as any).validateConfig(cfg);
      expect(validation.valid).toBe(false);
      expect(validation.errors.join(" ")).toContain("vllm.base_url");
    }
  });

  test("rejects literal keys submitted through the raw vLLM setting surface", () => {
    expect(() => (configModule as any).normalizeSettingMutation({
      key: "vllm",
      value: {
        enabled: true,
        base_url: "http://gpu.local:8000/v1",
        model: "Qwen/Qwen3-32B-AWQ",
        api_key_env: "",
        api_key: "bad-key",
      },
    })).toThrow(/vllm\.api_key/);
  });
});

describe("vLLM chat requests", () => {
  test("keeps native OpenAI tools and posts the configured model to chat completions", async () => {
    const cfg = chatConfig();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = fakeProviderFetch(
      () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
      calls,
    );
    const result = await withNetworkDisabled(() => chatCompletionWithFallback(
      cfg,
      {
        messages: [{ role: "user", content: "Find the record" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
        tool_choice: "auto",
        stream: true,
      },
      undefined,
      { stage: "executor", fetcher, env: { VLLM_TEST_API_KEY: "vllm-key" } } as any,
    ));

    const request = calls.find((call) => call.url.endsWith("/chat/completions"));
    expect(result.provider_used).toBe("vllm");
    expect(request?.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(request?.init.method).toBe("POST");
    expect((request?.init.headers as Record<string, string>).Authorization).toBe("Bearer vllm-key");
    expect(JSON.parse(String(request?.init.body))).toMatchObject({
      model: "Qwen/Qwen3-32B-AWQ",
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "lookup" } }],
    });
  });

  test("returns a typed HTTP failure and never logs an echoed key", async () => {
    const cfg = chatConfig();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const secret = "vllm-key";
    const fetcher = fakeProviderFetch(
      () => new Response(`invalid credential ${secret}`, { status: 401 }),
      calls,
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    let error: unknown;
    try {
      await withNetworkDisabled(() => chatCompletionWithFallback(
        cfg,
        { messages: [{ role: "user", content: "hello" }], stream: true },
        undefined,
        { stage: "executor", fetcher, env: { VLLM_TEST_API_KEY: secret } } as any,
      ));
    } catch (caught) {
      error = caught;
    } finally {
      console.warn = originalWarn;
    }

    expect((error as Error)?.name).toBe("VllmProviderRequestError");
    expect((error as { code?: string })?.code).toBe("VLLM_UNAVAILABLE");
    expect(`${(error as Error)?.message}\n${warnings.join("\n")}`).not.toContain(secret);
  });

  test("returns a typed network failure without leaking endpoint error text", async () => {
    const cfg = chatConfig();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const secret = "vllm-key";
    const fetcher = fakeProviderFetch(
      () => { throw new Error(`connection refused while handling ${secret}`); },
      calls,
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    let error: unknown;
    try {
      await withNetworkDisabled(() => chatCompletionWithFallback(
        cfg,
        { messages: [{ role: "user", content: "hello" }], stream: true },
        undefined,
        { stage: "executor", fetcher, env: { VLLM_TEST_API_KEY: secret } } as any,
      ));
    } catch (caught) {
      error = caught;
    } finally {
      console.warn = originalWarn;
    }

    expect((error as Error)?.name).toBe("VllmProviderRequestError");
    expect(`${(error as Error)?.message}\n${warnings.join("\n")}`).not.toContain(secret);
  });

  test("keeps vLLM failure typed when the remaining provider cascade also fails", async () => {
    const cfg = chatConfig();
    cfg.openrouter.api_key = "or-key2";
    cfg.openrouter.model = "openrouter/free";
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: "openrouter/free", pricing: { prompt: "0", completion: "0" } }] });
      }
      return new Response("provider unavailable", { status: 503 });
    }) as typeof fetch;
    let error: unknown;
    try {
      await withNetworkDisabled(() => chatCompletionWithFallback(
        cfg,
        { messages: [{ role: "user", content: "hello" }], stream: true },
        undefined,
        { stage: "executor", fetcher, env: { VLLM_TEST_API_KEY: "vllm-key" } } as any,
      ));
    } catch (caught) {
      error = caught;
    }

    expect((error as Error)?.name).toBe("VllmProviderRequestError");
    expect((error as { code?: string })?.code).toBe("VLLM_UNAVAILABLE");
  });

  test("marks vLLM as a provider with native tool support", () => {
    expect((providerModule as any).providerSupportsNativeTools("vllm")).toBe(true);
    expect((providerModule as any).providerSupportsNativeTools("openrouter")).toBe(true);
    expect((providerModule as any).providerSupportsNativeTools("opencode_zen")).toBe(false);
    expect((providerModule as any).providerSupportsNativeTools("opencode_go")).toBe(false);
  });
});

describe("vLLM routing helpers", () => {
  test("classifies vLLM as a routable HTTP provider", () => {
    expect((providerModule as any).isHttpProviderId("vllm")).toBe(true);
    expect((providerModule as any).isHttpProviderId("openrouter")).toBe(true);
    expect((providerModule as any).isHttpProviderId("ollama")).toBe(false);
  });

  test("sends direct requests to the configured chat endpoint with the expected OpenAI body", async () => {
    const cfg = chatConfig();
    const target = resolveProviderTarget(cfg, "vllm", { VLLM_TEST_API_KEY: "vllm-key" });
    let request: { url: string; init: RequestInit } | undefined;
    await providerModule.fetchVllmChat(
      cfg,
      target,
      "Qwen/Qwen3-32B-AWQ",
      { model: "Qwen/Qwen3-32B-AWQ", messages: [{ role: "user", content: "hello" }], stream: true },
      {},
      (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        request = { url: String(input), init };
        return new Response("data: [DONE]\\n\\n", { headers: { "Content-Type": "text/event-stream" } });
      }) as typeof fetch,
    );

    expect(request?.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(request?.init.method).toBe("POST");
    expect((request?.init.headers as Record<string, string>).Authorization).toBe("Bearer vllm-key");
    expect(JSON.parse(String(request?.init.body))).toEqual({
      model: "Qwen/Qwen3-32B-AWQ",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
  });

  test("wraps non-2xx responses in a typed error and redacts the environment key", async () => {
    const cfg = chatConfig();
    const target = resolveProviderTarget(cfg, "vllm", { VLLM_TEST_API_KEY: "vllm-key" });
    let error: unknown;
    try {
      await providerModule.fetchVllmChat(
        cfg,
        target,
        "Qwen/Qwen3-32B-AWQ",
        { model: "Qwen/Qwen3-32B-AWQ", messages: [], stream: true },
        {},
        (async () => new Response(`provider echoed vllm-key`, { status: 503 })) as typeof fetch,
      );
    } catch (caught) {
      error = caught;
    }

    expect((error as Error)?.name).toBe("VllmProviderRequestError");
    expect((error as Error)?.message).toContain("[redacted]");
    expect((error as Error)?.message).not.toContain("vllm-key");
  });

  test("wraps network failures in a typed error and redacts the environment key", async () => {
    const cfg = chatConfig();
    const target = resolveProviderTarget(cfg, "vllm", { VLLM_TEST_API_KEY: "vllm-key" });
    let error: unknown;
    try {
      await providerModule.fetchVllmChat(
        cfg,
        target,
        "Qwen/Qwen3-32B-AWQ",
        { model: "Qwen/Qwen3-32B-AWQ", messages: [], stream: true },
        {},
        (async () => { throw new Error("socket echoed vllm-key"); }) as typeof fetch,
      );
    } catch (caught) {
      error = caught;
    }

    expect((error as Error)?.name).toBe("VllmProviderRequestError");
    expect((error as Error)?.message).toContain("[redacted]");
    expect((error as Error)?.message).not.toContain("vllm-key");
  });
});

describe("resolveProviderTarget", () => {
  test("resolves opencode_zen to its own base URL, key, and watchdog", () => {
    const target = resolveProviderTarget(configWith(), "opencode_zen");

    expect(target.provider).toBe("opencode_zen");
    expect(target.base_url).toBe("https://opencode.ai/zen/v1");
    expect(target.api_key).toBe("zen-key");
    expect(target.first_token_timeout_ms).toBe(45_000);
    expect(target.chat_path).toBe("/chat/completions");
  });

  test("resolves opencode_go to its own base URL, key, and watchdog", () => {
    const target = resolveProviderTarget(configWith(), "opencode_go");

    expect(target.provider).toBe("opencode_go");
    expect(target.base_url).toBe("https://opencode.ai/zen/go/v1");
    expect(target.api_key).toBe("go-key");
    expect(target.first_token_timeout_ms).toBe(45_000);
    expect(target.chat_path).toBe("/chat/completions");
  });

  test("resolves openrouter with the 30s default first-token watchdog", () => {
    const target = resolveProviderTarget(configWith(), "openrouter");

    expect(target.provider).toBe("openrouter");
    expect(target.base_url).toBe("https://openrouter.ai/api/v1");
    expect(target.api_key).toBe("or-key");
    expect(target.first_token_timeout_ms).toBe(30_000);
    expect(target.chat_path).toBe("/chat/completions");
  });

  test("T3.4: throws UnroutableProviderError for ollama/claude_cli/unknown (no silent retarget)", () => {
    for (const provider of ["ollama", "claude_cli", "unknown-pool-entry", ""]) {
      expect(() => resolveProviderTarget(configWith(), provider)).toThrow(UnroutableProviderError);
    }
  });

  test("strips trailing slashes from a custom base_url so the chat path is not doubled", () => {
    const cfg = configWith({
      opencode_zen: {
        base_url: "https://opencode.ai/zen/v1///",
        api_key: "zen-key",
        first_token_timeout_ms: 45_000,
      },
    });
    const target = resolveProviderTarget(cfg, "opencode_zen");
    expect(target.base_url).toBe("https://opencode.ai/zen/v1");
    // Critical: providerChatUrl() must not produce /v1//chat/completions
    expect(providerChatUrl(target)).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("uses the OpenCode Zen default base URL when config value is empty", () => {
    const cfg = configWith({
      opencode_zen: { base_url: "", api_key: "zen-key", first_token_timeout_ms: 45_000 },
    });
    const target = resolveProviderTarget(cfg, "opencode_zen");
    expect(target.base_url).toBe("https://opencode.ai/zen/v1");
  });

  test("uses the OpenCode Go default base URL when config value is empty", () => {
    const cfg = configWith({
      opencode_go: { base_url: "", api_key: "go-key", first_token_timeout_ms: 45_000 },
    });
    const target = resolveProviderTarget(cfg, "opencode_go");
    expect(target.base_url).toBe("https://opencode.ai/zen/go/v1");
  });

  test("uses the openrouter default base URL when config value is empty", () => {
    const cfg = configWith();
    cfg.openrouter.base_url = "";
    const target = resolveProviderTarget(cfg, "openrouter");
    expect(target.base_url).toBe("https://openrouter.ai/api/v1");
  });

  test("defaults opencode_zen first_token_timeout_ms to 45_000 when the field is 0", () => {
    const cfg = configWith({
      opencode_zen: { base_url: "https://opencode.ai/zen/v1", api_key: "zen-key", first_token_timeout_ms: 0 },
    });
    const target = resolveProviderTarget(cfg, "opencode_zen");
    expect(target.first_token_timeout_ms).toBe(45_000);
  });

  test("defaults opencode_go first_token_timeout_ms to 45_000 when the field is 0", () => {
    const cfg = configWith({
      opencode_go: { base_url: "https://opencode.ai/zen/go/v1", api_key: "go-key", first_token_timeout_ms: 0 },
    });
    const target = resolveProviderTarget(cfg, "opencode_go");
    expect(target.first_token_timeout_ms).toBe(45_000);
  });

  test("preserves a non-zero first_token_timeout_ms override from config", () => {
    const cfg = configWith({
      opencode_zen: { base_url: "https://opencode.ai/zen/v1", api_key: "zen-key", first_token_timeout_ms: 55_000 },
    });
    const target = resolveProviderTarget(cfg, "opencode_zen");
    expect(target.first_token_timeout_ms).toBe(55_000);
  });
});

describe("providerChatUrl", () => {
  test("joins base_url and chat_path with exactly one slash", () => {
    const target = {
      provider: "opencode_zen" as const,
      base_url: "https://opencode.ai/zen/v1",
      api_key: "x",
      first_token_timeout_ms: 45_000,
      chat_path: "/chat/completions",
    };
    expect(providerChatUrl(target)).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("composed through resolveProviderTarget, a trailing-slash base_url yields a single-slash chat URL", () => {
    // providerChatUrl is a pure function and is allowed to emit the double-slash
    // form if a caller hands it a malformed base_url. The trailing-slash
    // guarantee is a property of the COMPOSITION (always go through
    // resolveProviderTarget first), not of providerChatUrl alone. This test
    // pins the composed contract so a future refactor of providerChatUrl that
    // adds internal slash-stripping doesn't silently change the external
    // behavior observed by resolveProviderTarget's callers.
    const cfg = configWith({
      opencode_go: { base_url: "https://opencode.ai/zen/go/v1/", api_key: "go-key", first_token_timeout_ms: 45_000 },
    });
    const target = resolveProviderTarget(cfg, "opencode_go");
    expect(providerChatUrl(target)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  test("routes OpenCode Go Anthropic-protocol models to /messages", () => {
    const target = resolveProviderTarget(configWith(), "opencode_go");
    expect(providerChatUrl(target, "minimax-m3")).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(providerChatUrl(target, "qwen3.7-plus")).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(providerChatUrl(target, "deepseek-v4-flash")).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });
});

describe("providerHeaders", () => {
  test("builds an Authorization: Bearer header from the target's own api_key", () => {
    const cfg = configWith();
    const target = resolveProviderTarget(cfg, "opencode_zen");
    const headers = providerHeaders(cfg, target);

    expect(headers["Authorization"]).toBe("Bearer zen-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends OpenRouter-specific HTTP-Referer and X-Title headers on every provider (ignored elsewhere)", () => {
    const cfg = configWith();
    for (const provider of ["openrouter", "opencode_zen", "opencode_go"] as const) {
      const target = resolveProviderTarget(cfg, provider);
      const headers = providerHeaders(cfg, target);
      expect(headers["HTTP-Referer"]).toBe("https://jarvis.local");
      expect(headers["X-Title"]).toBe("Jarvis Test");
    }
  });

  test("falls back to localhost + Jarvis defaults when site_url / site_name are blank", () => {
    const cfg = configWith();
    cfg.openrouter.site_url = "";
    cfg.openrouter.site_name = "";
    const target = resolveProviderTarget(cfg, "opencode_go");
    const headers = providerHeaders(cfg, target);

    expect(headers["HTTP-Referer"]).toBe("http://localhost:19877");
    expect(headers["X-Title"]).toBe("Jarvis");
  });

  test("does not leak a different provider's api_key into another provider's headers", () => {
    const cfg = configWith();
    const zen = resolveProviderTarget(cfg, "opencode_zen");
    const go = resolveProviderTarget(cfg, "opencode_go");
    const or = resolveProviderTarget(cfg, "openrouter");

    expect(providerHeaders(cfg, zen)["Authorization"]).toBe("Bearer zen-key");
    expect(providerHeaders(cfg, go)["Authorization"]).toBe("Bearer go-key");
    expect(providerHeaders(cfg, or)["Authorization"]).toBe("Bearer or-key");
  });

  test("adds Anthropic-compatible authentication only for Go /messages models", () => {
    const cfg = configWith();
    const target = resolveProviderTarget(cfg, "opencode_go");
    const headers = providerHeaders(cfg, target, "minimax-m3");

    expect(headers["x-api-key"]).toBe("go-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(providerHeaders(cfg, target, "deepseek-v4-flash")["x-api-key"]).toBeUndefined();
  });

  test("omits Authorization for a keyless vLLM endpoint", () => {
    const cfg = configWithVllm({ api_key_env: "" });
    const target = resolveProviderTarget(cfg, "vllm", {});

    expect(providerHeaders(cfg, target).Authorization).toBeUndefined();
  });
});

describe("HttpProviderId surface", () => {
  test("covers all four reachable OpenAI-compatible providers", () => {
    const expected: HttpProviderId[] = ["openrouter", "opencode_zen", "opencode_go", "vllm"];
    expect(expected).toHaveLength(4);
    for (const id of expected) {
      const cfg = id === "vllm" ? configWithVllm({ api_key_env: "" }) : configWith();
      const target = resolveProviderTarget(cfg, id, {});
      expect(target.provider).toBe(id);
    }
  });
});

describe("vLLM availability", () => {
  test("vLLM is disabled by default", () => {
    const cfg = defaultConfig();

    expect(cfg.vllm.enabled).toBe(false);
    expect(isProviderAvailable(cfg, "vllm", {})).toBe(false);
  });

  test("vLLM is available only when enabled with an endpoint and model", () => {
    const cfg = defaultConfig();
    cfg.vllm.enabled = true;
    cfg.vllm.base_url = "http://127.0.0.1:8000/v1";
    cfg.vllm.model = "Qwen/Qwen3-32B-AWQ";

    expect(isProviderAvailable(cfg, "vllm", {})).toBe(true);
    cfg.vllm.model = "";
    expect(isProviderAvailable(cfg, "vllm", {})).toBe(false);
  });

  test("a missing referenced key keeps vLLM out of the routable pool", () => {
    const cfg = defaultConfig();
    cfg.vllm.enabled = true;
    cfg.vllm.base_url = "http://127.0.0.1:8000/v1";
    cfg.vllm.model = "Qwen/Qwen3-32B-AWQ";
    cfg.vllm.api_key_env = "VLLM_TEST_API_KEY";

    expect(isProviderAvailable(cfg, "vllm", {})).toBe(false);
    expect(routableOrchestratorAgents(cfg, {})).toEqual([]);
  });

  test("an enabled vLLM config adds its configured model to the routable pool", () => {
    const cfg = defaultConfig();
    cfg.vllm.enabled = true;
    cfg.vllm.base_url = "http://127.0.0.1:8000/v1";
    cfg.vllm.model = "Qwen/Qwen3-32B-AWQ";

    const agents = routableOrchestratorAgents(cfg, {});
    expect(agents.filter((agent) => agent.provider === "vllm")).toMatchObject([
      {
        provider: "vllm",
        model_id: "Qwen/Qwen3-32B-AWQ",
        enabled: true,
        first_token_timeout_ms: 120_000,
      },
    ]);
  });

  test("applies the provider timeout to a configured vLLM agent without one", () => {
    const cfg = defaultConfig();
    cfg.vllm.enabled = true;
    cfg.vllm.base_url = "http://127.0.0.1:8000/v1";
    cfg.vllm.model = "Qwen/Qwen3-32B-AWQ";
    cfg.orchestrator.agents = [{
      id: "vllm-custom",
      provider: "vllm",
      model_id: cfg.vllm.model,
      capabilities: { code: 0.7, reasoning: 0.7, speed: 0.65, cost: 0.5, json_reliability: 0.7 },
      default_for: ["planner"],
      enabled: true,
    }];

    const agent = routableOrchestratorAgents(cfg, {}).find((candidate) => candidate.provider === "vllm");
    expect(agent?.id).toBe("vllm-custom");
    expect(agent?.first_token_timeout_ms).toBe(120_000);
  });
});

describe("checkVllmHealth", () => {
  function configuredVllm() {
    const cfg = defaultConfig().vllm;
    return {
      ...cfg,
      enabled: true,
      base_url: "http://gpu.local:8000/v1",
      model: "Qwen/Qwen3-32B-AWQ",
      api_key_env: "VLLM_TEST_API_KEY",
    };
  }

  test("reports reachable and returns served model ids", async () => {
    let requestedUrl = "";
    let authorization = "";
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = (init?.headers as Record<string, string>).Authorization ?? "";
      return Response.json({ data: [{ id: "Qwen/Qwen3-32B-AWQ" }, { id: "" }, { name: "ignored" }] });
    };

    const health = await providerModule.checkVllmHealth(configuredVllm(), {
      fetcher: fetcher as typeof fetch,
      env: { VLLM_TEST_API_KEY: "vllm-key" },
    });

    expect(requestedUrl).toBe("http://gpu.local:8000/v1/models");
    expect(authorization).toBe("Bearer vllm-key");
    expect(health.enabled).toBe(true);
    expect(health.reachable).toBe(true);
    expect(health.models).toEqual(["Qwen/Qwen3-32B-AWQ"]);
  });

  test("reports non-success HTTP responses as unreachable", async () => {
    const health = await providerModule.checkVllmHealth(configuredVllm(), {
      fetcher: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
      env: { VLLM_TEST_API_KEY: "vllm-key" },
    });

    expect(health.reachable).toBe(false);
    expect(health.models).toEqual([]);
    expect(health.error).toBe("HTTP 503");
  });

  test("reports transport failures without returning a secret echoed by the endpoint", async () => {
    const secret = "vllm-key";
    const health = await providerModule.checkVllmHealth(configuredVllm(), {
      fetcher: (async () => { throw new Error(`ECONNREFUSED ${secret}`); }) as typeof fetch,
      env: { VLLM_TEST_API_KEY: secret },
    });

    expect(health.reachable).toBe(false);
    expect(health.error).toContain("ECONNREFUSED");
    expect(health.error).not.toContain(secret);
  });

  test("does not make a request when vLLM is disabled", async () => {
    let called = false;
    const health = await providerModule.checkVllmHealth(defaultConfig().vllm, {
      fetcher: (async () => {
        called = true;
        return Response.json({ data: [] });
      }) as typeof fetch,
      env: {},
    });

    expect(called).toBe(false);
    expect(health.enabled).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.error).toBe("disabled");
  });

  test("does not make a request when a referenced key is absent", async () => {
    let called = false;
    const health = await providerModule.checkVllmHealth(configuredVllm(), {
      fetcher: (async () => {
        called = true;
        return Response.json({ data: [] });
      }) as typeof fetch,
      env: {},
    });

    expect(called).toBe(false);
    expect(health.reachable).toBe(false);
    expect(health.error).toContain("VLLM_TEST_API_KEY is not set");
  });
});
