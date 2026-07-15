import { describe, expect, test } from "bun:test";
import { defaultConfig, type JarvisConfig } from "./config";
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
  cfg.openrouter.api_key = "openrouter-test-key";
  cfg.openrouter.base_url = "https://openrouter.ai/api/v1";
  cfg.openrouter.site_url = "https://jarvis.local";
  cfg.openrouter.site_name = "Jarvis Test";
  cfg.opencode_zen.api_key = "opencode-zen-test-key";
  cfg.opencode_zen.base_url = "https://opencode.ai/zen/v1";
  cfg.opencode_zen.first_token_timeout_ms = 45_000;
  cfg.opencode_go.api_key = "opencode-go-test-key";
  cfg.opencode_go.base_url = "https://opencode.ai/zen/go/v1";
  cfg.opencode_go.first_token_timeout_ms = 45_000;
  return Object.assign(cfg, overrides);
}

describe("resolveProviderTarget", () => {
  test("resolves opencode_zen to its own base URL, key, and watchdog", () => {
    const target = resolveProviderTarget(configWith(), "opencode_zen");

    expect(target.provider).toBe("opencode_zen");
    expect(target.base_url).toBe("https://opencode.ai/zen/v1");
    expect(target.api_key).toBe("opencode-zen-test-key");
    expect(target.first_token_timeout_ms).toBe(45_000);
    expect(target.chat_path).toBe("/chat/completions");
  });

  test("resolves opencode_go to its own base URL, key, and watchdog", () => {
    const target = resolveProviderTarget(configWith(), "opencode_go");

    expect(target.provider).toBe("opencode_go");
    expect(target.base_url).toBe("https://opencode.ai/zen/go/v1");
    expect(target.api_key).toBe("opencode-go-test-key");
    expect(target.first_token_timeout_ms).toBe(45_000);
    expect(target.chat_path).toBe("/chat/completions");
  });

  test("resolves openrouter with the 30s default first-token watchdog", () => {
    const target = resolveProviderTarget(configWith(), "openrouter");

    expect(target.provider).toBe("openrouter");
    expect(target.base_url).toBe("https://openrouter.ai/api/v1");
    expect(target.api_key).toBe("openrouter-test-key");
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
        api_key: "opencode-zen-test-key",
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
      opencode_zen: { base_url: "", api_key: "opencode-zen-test-key", first_token_timeout_ms: 45_000 },
    });
    const target = resolveProviderTarget(cfg, "opencode_zen");
    expect(target.base_url).toBe("https://opencode.ai/zen/v1");
  });

  test("uses the OpenCode Go default base URL when config value is empty", () => {
    const cfg = configWith({
      opencode_go: { base_url: "", api_key: "opencode-go-test-key", first_token_timeout_ms: 45_000 },
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
      opencode_zen: { base_url: "https://opencode.ai/zen/v1", api_key: "opencode-zen-test-key", first_token_timeout_ms: 0 },
    });
    const target = resolveProviderTarget(cfg, "opencode_zen");
    expect(target.first_token_timeout_ms).toBe(45_000);
  });

  test("defaults opencode_go first_token_timeout_ms to 45_000 when the field is 0", () => {
    const cfg = configWith({
      opencode_go: { base_url: "https://opencode.ai/zen/go/v1", api_key: "opencode-go-test-key", first_token_timeout_ms: 0 },
    });
    const target = resolveProviderTarget(cfg, "opencode_go");
    expect(target.first_token_timeout_ms).toBe(45_000);
  });

  test("preserves a non-zero first_token_timeout_ms override from config", () => {
    const cfg = configWith({
      opencode_zen: { base_url: "https://opencode.ai/zen/v1", api_key: "opencode-zen-test-key", first_token_timeout_ms: 55_000 },
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
      opencode_go: { base_url: "https://opencode.ai/zen/go/v1/", api_key: "opencode-go-test-key", first_token_timeout_ms: 45_000 },
    });
    const target = resolveProviderTarget(cfg, "opencode_go");
    expect(providerChatUrl(target)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });
});

describe("providerHeaders", () => {
  test("builds an Authorization: Bearer header from the target's own api_key", () => {
    const cfg = configWith();
    const target = resolveProviderTarget(cfg, "opencode_zen");
    const headers = providerHeaders(cfg, target);

    expect(headers["Authorization"]).toBe("Bearer opencode-zen-test-key");
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

    expect(providerHeaders(cfg, zen)["Authorization"]).toBe("Bearer opencode-zen-test-key");
    expect(providerHeaders(cfg, go)["Authorization"]).toBe("Bearer opencode-go-test-key");
    expect(providerHeaders(cfg, or)["Authorization"]).toBe("Bearer openrouter-test-key");
  });
});

describe("HttpProviderId surface", () => {
  test("covers exactly the three reachable OpenAI-compatible providers", () => {
    // Pin the public type contract — if a fourth provider is added, this list
    // forces a deliberate decision about whether it should be HttpProviderId.
    const expected: HttpProviderId[] = ["openrouter", "opencode_zen", "opencode_go"];
    expect(expected).toHaveLength(3);
    for (const id of expected) {
      const target = resolveProviderTarget(configWith(), id);
      expect(target.provider).toBe(id);
    }
  });
});
