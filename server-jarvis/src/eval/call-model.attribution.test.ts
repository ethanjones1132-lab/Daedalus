import { beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { clearOpenRouterCache } from "../openrouter";
import { __resetModelHealthForTests } from "../orchestration/model-health";
import { makeCallModel } from "./call-model";

/**
 * `makeCallModel` must report who answered, not who was asked. The harness
 * checker reads these fields to put the real reviewer's model in its verdict
 * event, so a pinned model that fails over must not be reported as the author.
 */
describe("makeCallModel attribution", () => {
  beforeEach(() => {
    // No earlier test's failure memory may remove an entry from the cascade.
    __resetModelHealthForTests();
    clearOpenRouterCache();
  });

  test("reports the cascade entry that answered after the pinned model failed", async () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";
    cfg.openrouter.api_key = "test-or-key";
    cfg.openrouter.base_url = "https://openrouter.ai/api/v1";
    cfg.openrouter.model = "cohere/north-mini-code:free";
    cfg.openrouter.max_retries = 0;
    cfg.orchestrator.agents = [{
      id: "independent-fallback", provider: "openrouter", model_id: "qwen/qwen3-coder:free",
      capabilities: { code: 0.7, reasoning: 0.7, speed: 0.7, cost: 1, json_reliability: 0.7 },
      default_for: [], enabled: true,
    }];

    const requestedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    clearOpenRouterCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [] });
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      if (typeof body.model === "string") requestedModels.push(body.model);
      if (body.model === "google/gemma-4-31b-it:free") {
        return new Response("checker unavailable", { status: 400 });
      }
      return Response.json({ choices: [{ message: { content: "ACCEPT\nIndependent review." } }] });
    }) as typeof fetch;

    try {
      const call = makeCallModel(cfg, "reviewer", {
        agent: { provider: "openrouter", model_id: "google/gemma-4-31b-it:free" },
      });
      const answer = await call([{ role: "user", content: "Review the diff." }]);

      expect(answer.content).toContain("ACCEPT");
      expect(requestedModels[0]).toBe("google/gemma-4-31b-it:free");
      expect(answer._modelUsed).toBe("qwen/qwen3-coder:free");
      expect(answer._provider).toBe("openrouter");
      expect(answer._fallbackUsed).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      clearOpenRouterCache();
    }
  });

  test("reports the pinned model itself when no fallback was needed", async () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";
    cfg.openrouter.api_key = "test-or-key";
    cfg.openrouter.base_url = "https://openrouter.ai/api/v1";
    cfg.openrouter.max_retries = 0;

    const originalFetch = globalThis.fetch;
    clearOpenRouterCache();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [] });
      return Response.json({ choices: [{ message: { content: "ACCEPT" } }] });
    }) as typeof fetch;

    try {
      const call = makeCallModel(cfg, "reviewer", {
        agent: { provider: "openrouter", model_id: "google/gemma-4-31b-it:free" },
      });
      const answer = await call([{ role: "user", content: "Review the diff." }]);

      expect(answer._modelUsed).toBe("google/gemma-4-31b-it:free");
      expect(answer._provider).toBe("openrouter");
      expect(answer._fallbackUsed).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      clearOpenRouterCache();
    }
  });
});
