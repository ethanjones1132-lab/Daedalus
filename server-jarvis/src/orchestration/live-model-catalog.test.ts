import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { AgentPool } from "./agent-pool";
import {
  discoverLiveOrchestratorAgents,
  isOpenRouterFreeTextModel,
  resetLiveModelCatalogCache,
} from "./live-model-catalog";

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("isOpenRouterFreeTextModel output-modality filter", () => {
  // OpenRouter's `architecture.modality` is an "<input>-><output>" pair. Only
  // the OUTPUT side (after the arrow) disqualifies a model from this text/code
  // orchestration pool. The old check tested `!modality.includes("text")`
  // against the WHOLE string, so "text->audio" (Lyria's real shape) slipped
  // through because "text" appears on the INPUT side.
  const freeAudio = (modality: string) => ({
    id: "vendor/model:free",
    name: "Some Model",
    pricing: { prompt: "0", completion: "0" },
    architecture: { modality },
  });

  test("excludes a text-input audio-output model (Lyria's shape)", () => {
    expect(isOpenRouterFreeTextModel(freeAudio("text->audio"))).toBe(false);
  });

  test("excludes an explicit image-output model", () => {
    expect(isOpenRouterFreeTextModel(freeAudio("text->image"))).toBe(false);
    expect(isOpenRouterFreeTextModel(freeAudio("->image"))).toBe(false);
  });

  test("admits a text-output model", () => {
    expect(isOpenRouterFreeTextModel(freeAudio("text->text"))).toBe(true);
  });

  test("admits a bare text modality with no arrow", () => {
    expect(isOpenRouterFreeTextModel(freeAudio("text"))).toBe(true);
  });

  test("admits a vision-input text-output multimodal model", () => {
    // Input side may contain image/audio; only the output side disqualifies.
    expect(isOpenRouterFreeTextModel(freeAudio("text+image->text"))).toBe(true);
  });

  test("output_modalities array still takes precedence over the modality string", () => {
    // First check (array) is authoritative: an audio-only array excludes even
    // if the modality string looks text-capable, and a text array admits.
    expect(isOpenRouterFreeTextModel({
      id: "vendor/model:free",
      name: "Some Model",
      pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["audio"], modality: "text->text" },
    })).toBe(false);
    expect(isOpenRouterFreeTextModel({
      id: "vendor/model:free",
      name: "Some Model",
      pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["text"], modality: "text+image->text" },
    })).toBe(true);
  });
});

describe("live orchestration model catalog", () => {
  test("enables every live free text model, drops stale ids, and includes the live Go plan", async () => {
    resetLiveModelCatalogCache();
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "openrouter-test-key";
    cfg.opencode_zen.api_key = "zen-test-key";
    cfg.opencode_go.api_key = "go-test-key";
    cfg.orchestrator.agents = [
      {
        id: "stale-laguna",
        provider: "openrouter",
        model_id: "poolside/laguna-xs.2:free",
        capabilities: { code: 0.8, reasoning: 0.7, speed: 0.8, cost: 1, json_reliability: 0.75 },
        default_for: [],
        enabled: true,
      },
      {
        id: "disabled-live-zen",
        provider: "opencode_zen",
        model_id: "deepseek-v4-flash-free",
        capabilities: { code: 0.9, reasoning: 0.85, speed: 0.85, cost: 1, json_reliability: 0.9 },
        default_for: [],
        enabled: false,
      },
    ];

    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        return json([
          {
            id: "poolside/laguna-xs-2.1:free",
            name: "Laguna XS 2.1",
            pricing: { prompt: "0", completion: "0" },
            architecture: { output_modalities: ["text"] },
          },
          {
            id: "vendor/zero-cost-without-suffix",
            name: "Zero Cost Text Model",
            pricing: { prompt: "0", completion: "0" },
            architecture: { output_modalities: ["text"] },
          },
          {
            id: "google/lyria-3-pro-preview",
            name: "Lyria",
            pricing: { prompt: "0", completion: "0" },
            architecture: { output_modalities: ["audio"] },
          },
          {
            id: "nvidia/nemotron-3.5-content-safety:free",
            name: "Content Safety",
            pricing: { prompt: "0", completion: "0" },
            architecture: { output_modalities: ["text"] },
          },
        ]);
      }
      if (url.includes("/zen/go/")) {
        return json([
          { id: "deepseek-v4-flash" },
          { id: "minimax-m3" },
          { id: "glm-5.2" },
        ]);
      }
      return json([
        { id: "big-pickle" },
        { id: "deepseek-v4-flash-free" },
        { id: "mimo-v2.5-free" },
        { id: "paid-zen-model" },
      ]);
    };

    const snapshot = await discoverLiveOrchestratorAgents(cfg, { fetcher, forceRefresh: true });
    const keys = new Set(snapshot.agents.map((agent) => `${agent.provider}:${agent.model_id}`));

    expect(keys).toContain("openrouter:poolside/laguna-xs-2.1:free");
    expect(keys).toContain("openrouter:vendor/zero-cost-without-suffix");
    expect(keys).not.toContain("openrouter:poolside/laguna-xs.2:free");
    expect(keys).not.toContain("openrouter:google/lyria-3-pro-preview");
    expect(keys).not.toContain("openrouter:nvidia/nemotron-3.5-content-safety:free");
    expect(keys).toContain("opencode_zen:big-pickle");
    expect(keys).toContain("opencode_zen:deepseek-v4-flash-free");
    expect(keys).toContain("opencode_zen:mimo-v2.5-free");
    expect(keys).not.toContain("opencode_zen:paid-zen-model");
    expect(keys).toContain("opencode_go:deepseek-v4-flash");
    expect(keys).toContain("opencode_go:minimax-m3");
    expect(keys).toContain("opencode_go:glm-5.2");
    // A configured agent explicitly disabled in static config (`disabled-live-zen`,
    // enabled:false) must STAY disabled even though the live catalog confirms
    // `deepseek-v4-flash-free` is free-tier-eligible. The old behavior force-
    // re-enabled it; DEFAULT_ORCHESTRATOR_AGENTS deliberately disables these
    // Zen `*-free` ids (they 400 / stall on current keys), so their explicit
    // enabled:false is authoritative. It remains a documented pool member
    // (present in `keys`) but never an automatic fallback pick.
    expect(snapshot.agents.find((agent) => agent.model_id === "deepseek-v4-flash-free")?.enabled).toBe(false);
    expect(snapshot.agents.find((agent) => agent.model_id === "vendor/zero-cost-without-suffix")?.billing_tier).toBe("free");
    expect(snapshot.catalogs.openrouter.status).toBe("live");
    expect(snapshot.catalogs.opencode_zen.status).toBe("live");
    expect(snapshot.catalogs.opencode_go.status).toBe("live");
  });

  test("respects an explicitly disabled configured agent even when the live catalog confirms it is free", async () => {
    // Sub-fix B: a configured Zen `*-free` id with enabled:false in static
    // config (DEFAULT_ORCHESTRATOR_AGENTS deliberately disables these — they
    // 400 / require billing / stall on current keys) must STAY disabled after
    // merge, while a newly-discovered free model the catalog surfaces on its
    // own is still enabled via the separate dynamicAgent() path.
    resetLiveModelCatalogCache();
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "openrouter-test-key";
    cfg.opencode_zen.api_key = "zen-test-key";
    cfg.opencode_go.api_key = "go-test-key";
    cfg.orchestrator.agents = [
      {
        id: "zen-nemotron-ultra-free",
        provider: "opencode_zen",
        model_id: "nemotron-3-ultra-free",
        capabilities: { code: 0.8, reasoning: 0.95, speed: 0.55, cost: 1, json_reliability: 0.88 },
        default_for: [],
        enabled: false,
      },
      {
        id: "zen-enabled-free",
        provider: "opencode_zen",
        model_id: "mimo-v2.5-free",
        capabilities: { code: 0.72, reasoning: 0.8, speed: 0.7, cost: 1, json_reliability: 0.7 },
        default_for: [],
        enabled: true,
      },
    ];

    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) return json([]);
      if (url.includes("/zen/go/")) return json([]);
      return json([
        { id: "nemotron-3-ultra-free" }, // configured + disabled, catalog-free
        { id: "mimo-v2.5-free" },        // configured + enabled, catalog-free
        { id: "big-pickle" },            // brand-new free model → dynamicAgent
      ]);
    };

    const snapshot = await discoverLiveOrchestratorAgents(cfg, { fetcher, forceRefresh: true });
    const byModel = (id: string) => snapshot.agents.find((agent) => agent.model_id === id);

    // Explicit enabled:false is authoritative — NOT force-flipped to true.
    expect(byModel("nemotron-3-ultra-free")?.enabled).toBe(false);
    // Its free billing tier is still recorded, only its enabled flag is honored.
    expect(byModel("nemotron-3-ultra-free")?.billing_tier).toBe("free");
    // A configured agent left enabled stays enabled.
    expect(byModel("mimo-v2.5-free")?.enabled).toBe(true);
    // A brand-new free model discovered by the catalog is enabled independently.
    expect(byModel("big-pickle")?.enabled).toBe(true);
  });

  test("uses free capacity first and sorts the discovered Go tail by official cost rank", async () => {
    resetLiveModelCatalogCache();
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "openrouter-test-key";
    cfg.opencode_zen.api_key = "zen-test-key";
    cfg.opencode_go.api_key = "go-test-key";
    cfg.orchestrator.agents = [];

    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) {
        return json([{
          id: "qwen/qwen3-coder:free",
          pricing: { prompt: "0", completion: "0" },
          architecture: { output_modalities: ["text"] },
        }]);
      }
      if (url.includes("/zen/go/")) {
        return json([
          { id: "glm-5.2" },
          { id: "minimax-m3" },
          { id: "deepseek-v4-flash" },
        ]);
      }
      return json([{ id: "big-pickle" }]);
    };

    const snapshot = await discoverLiveOrchestratorAgents(cfg, { fetcher, forceRefresh: true });
    const pool = new AgentPool(snapshot.agents);
    const selected = pool.pickFor("executor", "debug")!;
    const chain = pool.fallbackChain(selected, "executor", "debug");
    const goModels = chain.filter((agent) => agent.provider === "opencode_go").map((agent) => agent.model_id);

    expect(selected.provider).not.toBe("opencode_go");
    expect(goModels).toEqual(["deepseek-v4-flash", "minimax-m3", "glm-5.2"]);
  });

  test("keeps configured fallbacks when a catalog is temporarily unavailable", async () => {
    resetLiveModelCatalogCache();
    const cfg = defaultConfig();
    cfg.openrouter.api_key = "openrouter-test-key";
    cfg.opencode_zen.api_key = "zen-test-key";
    cfg.opencode_go.api_key = "go-test-key";
    const configuredGo = cfg.orchestrator.agents.find((agent) => agent.model_id === "deepseek-v4-flash")!;
    cfg.orchestrator.agents = [configuredGo];

    const fetcher: typeof fetch = async () => new Response("unavailable", { status: 503 });
    const snapshot = await discoverLiveOrchestratorAgents(cfg, { fetcher, forceRefresh: true });

    expect(snapshot.agents.map((agent) => agent.model_id)).toContain("deepseek-v4-flash");
    expect(snapshot.catalogs.opencode_go.status).toBe("unavailable");
  });
});
