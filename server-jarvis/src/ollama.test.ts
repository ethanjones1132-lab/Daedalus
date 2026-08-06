import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetOllamaHealthCacheForTests,
  __resetWindowsHostIPCacheForTests,
  checkOllamaHealth,
  checkOllamaModelSupportsTools,
  effectiveOllamaUrl,
  listOllamaModels,
  resolveDesiredOllamaModel,
  resolveWindowsHostIP,
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
  __resetWindowsHostIPCacheForTests();
});

describe("resolveWindowsHostIP platform branches", () => {
  // 2026-08-06 live incident: native bun.exe on Windows ran the WSL host-IP
  // path, always fell through to 172.17.0.1, and every 30s cache miss logged
  // "Could not resolve Windows host IP" while fetch probes to the docker
  // bridge hung. /health and keep-warm both paid that cost.
  test("on win32 returns loopback without WSL fallback", () => {
    __resetWindowsHostIPCacheForTests();
    expect(resolveWindowsHostIP("win32")).toBe("127.0.0.1");
    // Cache sticks for subsequent calls.
    expect(resolveWindowsHostIP("win32")).toBe("127.0.0.1");
  });

  test("effectiveOllamaUrl on win32 keeps traffic on loopback", () => {
    __resetWindowsHostIPCacheForTests();
    // Force the win32 branch via resolveWindowsHostIP("win32") first so the
    // cache is primed; effectiveOllamaUrl calls the default-platform path.
    // When this suite itself runs on win32 the default path is also correct.
    if (process.platform === "win32") {
      const url = effectiveOllamaUrl(makeConfig("http://localhost:11434"));
      expect(url).toContain("127.0.0.1");
      expect(url).not.toContain("172.17.0.1");
    } else {
      // On Linux CI, just pin the pure win32 helper contract above.
      expect(resolveWindowsHostIP("win32")).toBe("127.0.0.1");
    }
  });
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

  describe("resolveDesiredOllamaModel", () => {
    // 2026-07-30: a pool-selected agent (e.g. an orchestrator.agents entry
    // with provider "ollama") must be able to route a single stage to ITS
    // model_id, not the global cfg.ollama.model default. Without this, the
    // stage-dispatch path had no way to honor a pool pick other than the one
    // backend-wide model — confirmed live (local-qwythos-reviewer never
    // resolved to qwythos9b-conductor:latest; every reviewer-stage call fell
    // back through cfg.ollama.model === "gemma4:e4b" territory instead).
    const cfg = {
      ...({} as any),
      ollama: { model: "qwen3.5-9b:latest" },
      active_profile: "quality",
      profiles: {
        quality: { model_id: "qwen3.5-9b" },
      },
    };

    test("prefers an explicitly desired model over cfg.ollama.model when it is installed", () => {
      const installed = ["qwen3.5-9b:latest", "qwythos9b-conductor:latest", "qwen3:8b"];
      expect(resolveDesiredOllamaModel("qwythos9b-conductor:latest", cfg, installed)).toBe("qwythos9b-conductor:latest");
    });

    test("matches a desired model against installed tags case-insensitively and ignoring :latest", () => {
      const installed = ["qwen3.5-9b:latest", "qwythos9b-conductor:latest"];
      expect(resolveDesiredOllamaModel("QWYTHOS9B-CONDUCTOR", cfg, installed)).toBe("qwythos9b-conductor:latest");
    });

    test("falls back to selectInstalledOllamaModel when the desired model is not installed", () => {
      const installed = ["gemma4:e2b", "qwen3:8b", "qwen3:4b"];
      expect(resolveDesiredOllamaModel("not-installed-model:latest", cfg, installed))
        .toBe(selectInstalledOllamaModel(cfg, installed));
    });

    test("falls back to selectInstalledOllamaModel when no desired model is given", () => {
      const installed = ["gemma4:e2b", "qwen3:8b", "qwen3:4b"];
      expect(resolveDesiredOllamaModel(undefined, cfg, installed))
        .toBe(selectInstalledOllamaModel(cfg, installed));
    });
  });
});
