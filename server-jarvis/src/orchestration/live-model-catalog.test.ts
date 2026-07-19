import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import { AgentPool } from "./agent-pool";
import {
  discoverLiveOrchestratorAgents,
  resetLiveModelCatalogCache,
} from "./live-model-catalog";

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
    expect(snapshot.agents.find((agent) => agent.model_id === "deepseek-v4-flash-free")?.enabled).toBe(true);
    expect(snapshot.agents.find((agent) => agent.model_id === "vendor/zero-cost-without-suffix")?.billing_tier).toBe("free");
    expect(snapshot.catalogs.openrouter.status).toBe("live");
    expect(snapshot.catalogs.opencode_zen.status).toBe("live");
    expect(snapshot.catalogs.opencode_go.status).toBe("live");
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
