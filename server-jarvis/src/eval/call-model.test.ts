import { describe, expect, test } from "bun:test";
import { resolveModelSupportsNativeTools } from "./call-model";
import type { JarvisConfig } from "../config";

function cfgWithAgent(provider: "opencode_zen" | "opencode_go" | "openrouter", modelId: string, stage: string): JarvisConfig {
  return {
    orchestrator: {
      agents: [
        {
          id: "test-agent",
          provider,
          model_id: modelId,
          capabilities: { code: 0.8, reasoning: 0.8, speed: 0.8, cost: 1, json_reliability: 0.8 },
          default_for: [stage],
          enabled: true,
        },
      ],
    },
  } as unknown as JarvisConfig;
}

describe("resolveModelSupportsNativeTools", () => {
  test("opencode_zen agents never support native tool calling", () => {
    const cfg = cfgWithAgent("opencode_zen", "deepseek-v4-flash-free", "planner");
    expect(resolveModelSupportsNativeTools(cfg, "planner")).toBe(false);
  });

  test("opencode_go agents never support native tool calling", () => {
    const cfg = cfgWithAgent("opencode_go", "minimax-m3", "executor");
    expect(resolveModelSupportsNativeTools(cfg, "executor")).toBe(false);
  });

  test("openrouter anthropic models support native tool calling", () => {
    const cfg = cfgWithAgent("openrouter", "anthropic/claude-3.5-sonnet", "executor");
    expect(resolveModelSupportsNativeTools(cfg, "executor")).toBe(true);
  });

  test("falls back to true when the pool has no agent for the stage", () => {
    const cfg = { orchestrator: { agents: [] } } as unknown as JarvisConfig;
    expect(resolveModelSupportsNativeTools(cfg, "planner")).toBe(true);
  });
});
