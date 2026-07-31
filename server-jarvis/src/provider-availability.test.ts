import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { configuredInferenceFacts, isProviderAvailable, routableOrchestratorAgents } from "./provider-availability";

describe("provider availability", () => {
  test("does not route an OpenRouter session through an unconfigured OpenCode provider", () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";
    cfg.openrouter.api_key = "openrouter-key";
    cfg.opencode_go.api_key = "";

    expect(isProviderAvailable(cfg, "openrouter")).toBe(true);
    expect(isProviderAvailable(cfg, "opencode_go")).toBe(false);
  });

  test("states the configured runtime identity without inventing a model provider", () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";
    cfg.openrouter.model = "openrouter/free";

    expect(configuredInferenceFacts(cfg)).toEqual({
      backend: "openrouter",
      selectedModel: "openrouter/free",
    });
  });

  // 2026-07-31: a pool-selected "ollama" agent (e.g. a local reviewer lane)
  // resolves its own reachability per-request via resolveOllamaChatTarget
  // (with graceful fallback), the same way remote providers resolve via a
  // credential check. Gating availability on the unrelated `active_backend`
  // toggle meant a local agent pinned to a stage could never be selected
  // while the backend-wide default was openrouter (the live incident:
  // local-qwythos-reviewer never resolved even after the tier fix and the
  // dispatch-wiring fix landed, because routableOrchestratorAgents dropped
  // it before either fix's code ever ran).
  test("ollama is available regardless of the backend-wide active_backend setting", () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";

    expect(isProviderAvailable(cfg, "ollama")).toBe(true);
  });

  test("routableOrchestratorAgents keeps an enabled ollama pool agent even when active_backend is openrouter", () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";
    cfg.openrouter.api_key = "openrouter-key";
    cfg.orchestrator.agents = [
      {
        id: "local-ollama-reviewer",
        provider: "ollama",
        model_id: "some-local-model:latest",
        capabilities: { code: 0.65, reasoning: 0.7, speed: 0.9, cost: 1, json_reliability: 0.75 },
        default_for: ["reviewer"],
        enabled: true,
      },
    ];

    const routable = routableOrchestratorAgents(cfg);
    expect(routable.map((agent) => agent.id)).toContain("local-ollama-reviewer");
  });

  test("routableOrchestratorAgents still drops claude_cli pool agents (unrelated to this fix, not wired for stage dispatch)", () => {
    const cfg = defaultConfig();
    cfg.active_backend = "openrouter";
    cfg.orchestrator.agents = [
      {
        id: "claude-cli-agent",
        provider: "claude_cli",
        model_id: "some-model",
        capabilities: { code: 0.65, reasoning: 0.7, speed: 0.9, cost: 1, json_reliability: 0.75 },
        default_for: [],
        enabled: true,
      },
    ];

    expect(routableOrchestratorAgents(cfg)).toEqual([]);
  });
});
