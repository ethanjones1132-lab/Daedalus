import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../config";
import {
  resetRoutableAgentPoolHealthCache,
  routableAgentsWithProviderHealth,
} from "./routable-agent-pool";

afterEach(() => resetRoutableAgentPoolHealthCache());

function configuredVllmConfig() {
  const cfg = defaultConfig();
  cfg.vllm.enabled = true;
  cfg.vllm.base_url = "http://127.0.0.1:8000/v1";
  cfg.vllm.model = "Qwen/Qwen3-32B-AWQ";
  return cfg;
}

describe("routable pool provider health", () => {
  test("removes vLLM when its health probe fails", async () => {
    const cfg = configuredVllmConfig();
    const agents = await routableAgentsWithProviderHealth(cfg, {
      env: {},
      probe: async () => ({ enabled: true, reachable: false, models: [], latency_ms: 1, error: "offline" }),
    });

    expect(agents.some((agent) => agent.provider === "vllm")).toBe(false);
    // defaultConfig has no other keyed provider, so removing the dead vLLM
    // endpoint leaves an empty roster rather than a stand-in agent.
  });

  test("keeps the configured vLLM model when its health probe succeeds", async () => {
    const agents = await routableAgentsWithProviderHealth(configuredVllmConfig(), {
      env: {},
      probe: async () => ({ enabled: true, reachable: true, models: [], latency_ms: 1 }),
    });

    expect(agents.filter((agent) => agent.provider === "vllm").map((agent) => agent.model_id))
      .toEqual(["Qwen/Qwen3-32B-AWQ"]);
  });

  test("reuses a recent health probe while pools are constructed", async () => {
    const cfg = configuredVllmConfig();
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return { enabled: true, reachable: true, models: [], latency_ms: 1 };
    };

    await routableAgentsWithProviderHealth(cfg, { env: {}, probe });
    await routableAgentsWithProviderHealth(cfg, { env: {}, probe });

    expect(probes).toBe(1);
  });
});
