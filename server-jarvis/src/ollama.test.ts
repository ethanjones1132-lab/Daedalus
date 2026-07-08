import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetOllamaHealthCacheForTests,
  checkOllamaHealth,
  checkOllamaModelSupportsTools,
  listOllamaModels,
  selectInstalledOllamaModel,
} from "./ollama";
import type { OllamaConfig } from "./config";

const originalFetch = globalThis.fetch;

function makeConfig(base_url = "http://empty.local:11434", model = "qwen3.5-9b:latest"): OllamaConfig {
  return {
    base_url,
    model,
    auto_pull: false,
    health_check_interval_ms: 10_000,
    options: {
      num_ctx: 32768,
      num_gpu: 999,
      num_thread: 8,
    },
  };
}

function mockOllamaTags(emptyStoresForAll = false) {
  (globalThis as any).fetch = async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return Response.json({ models: emptyStoresForAll ? [] : [
        {
          name: "qwen3.5-9b:latest",
          size: 5_394_098_326,
          digest: "digest-qwen",
          modified_at: "2026-06-03T12:25:38.957251763-04:00",
          details: { parameter_size: "9.0B", quantization_level: "Q4_K_S" },
        },
      ] });
    }
    if (url.endsWith("/api/show")) {
      return Response.json({ capabilities: ["tools"] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetOllamaHealthCacheForTests();
});

describe("Ollama integration", () => {
  test("checkOllamaHealth reports an empty reachable model store", async () => {
    mockOllamaTags(true);
    const health = await checkOllamaHealth(makeConfig());
    expect(health.running).toBe(true);
    expect(health.modelAvailable).toBe(false);
    expect(health.models).toEqual([]);
  });

  test("listOllamaModels returns discovered models", async () => {
    mockOllamaTags();
    const models = await listOllamaModels(makeConfig("http://localhost:11434", "qwen3.5-9b:latest"));
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("qwen3.5-9b:latest");
    expect(models[0].parameter_size).toBe("9.0B");
  });

  test("checkOllamaModelSupportsTools reads /api/show capabilities", async () => {
    mockOllamaTags();
    const supportsTools = await checkOllamaModelSupportsTools("http://localhost:11434", "qwen3.5-9b:latest");
    expect(supportsTools).toBe(true);
  });

  test("selectInstalledOllamaModel prefers installed profile aliases over first tag order", () => {
    const cfg = {
      ...({} as any),
      ollama: { model: "qwen3.5-9b:latest" },
      active_profile: "quality",
      profiles: {
        quality: { model_id: "qwen3.5-9b" },
      },
    };

    expect(selectInstalledOllamaModel(cfg, ["gemma4:e2b", "qwen3:8b", "qwen3:4b"])).toBe("qwen3:8b");
  });
});
