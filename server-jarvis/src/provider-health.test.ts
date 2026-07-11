import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { checkHttpProviderHealth } from "./provider-health";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("checkHttpProviderHealth", () => {
  test("tests OpenCode Go with its own endpoint and key", async () => {
    const cfg = defaultConfig();
    cfg.opencode_go.api_key = "go-key";
    cfg.opencode_go.base_url = "https://go.example/v1";
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = (async (url, init) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    await expect(checkHttpProviderHealth(cfg, "opencode_go")).resolves.toMatchObject({ ok: true });
    expect(seenUrl).toBe("https://go.example/v1/models");
    expect(seenAuth).toBe("Bearer go-key");
  });

  test("does not leak a rejected key", async () => {
    const cfg = defaultConfig();
    cfg.opencode_zen.api_key = "zen-key-never-display";
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;

    const result = await checkHttpProviderHealth(cfg, "opencode_zen");
    expect(result).toMatchObject({ ok: false, error: "OpenCode Zen rejected this API key (401)." });
    expect(JSON.stringify(result)).not.toContain("zen-key-never-display");
  });

  test("rejects an unknown provider before attempting an OpenRouter fetch", async () => {
    const cfg = defaultConfig();
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;

    const result = await checkHttpProviderHealth(cfg, "bogus" as "openrouter");
    expect(result).toEqual({ ok: false, latency_ms: 0, error: "Unknown HTTP provider." });
    expect(fetchCalls).toBe(0);
  });
});
