import { describe, expect, test } from "bun:test";
import { normalizeConfig, validateConfig } from "../config";
import {
  hasStageRouteOverride,
  resolveStageRoute,
  stageTargetKey,
  type StageTarget,
} from "./stage-route-policy";

const target = (provider: StageTarget["provider"], model: string): StageTarget => ({ provider, model });

function routeConfig(stageModels?: unknown, fallbackChains?: unknown) {
  return normalizeConfig({
    llama_cpp: { model: "serving-alias" },
    orchestrator: {
      ...(stageModels === undefined ? {} : { stage_models: stageModels }),
      ...(fallbackChains === undefined ? {} : { fallback_chains: fallbackChains }),
    },
  });
}

const tooManyFallbacks = Array.from({ length: 9 }, (_, index) => target("ollama", `model-${index}`));
const invalidRouteConfigs: Array<[string, unknown]> = [
  ["unknown stage", { orchestrator: { stage_models: { unknown: target("ollama", "model") } } }],
  ["unknown provider", { orchestrator: { stage_models: { executor: { provider: "unknown", model: "model" } } } }],
  ["blank model", { orchestrator: { stage_models: { executor: target("ollama", "  ") } } }],
  ["long model ID", { orchestrator: { stage_models: { executor: target("ollama", "x".repeat(513)) } } }],
  ["more than eight fallbacks", { orchestrator: { fallback_chains: { executor: tooManyFallbacks } } }],
  ["different llama.cpp alias", {
    llama_cpp: { model: "serving-alias" },
    orchestrator: { fallback_chains: { executor: [target("llama_cpp", "other-alias")] } },
  }],
];

describe("stage route policy", () => {
  test("puts an explicit primary before its ordered custom fallbacks", () => {
    const primary = target("ollama", "primary");
    const fallbackB = target("openrouter", "org/model:b");
    const fallbackC = target("vllm", "model-c");

    const resolved = resolveStageRoute(
      routeConfig({ executor: primary }, { executor: [fallbackB, fallbackC] }),
      "executor",
      { primary: target("ollama", "automatic-primary"), fallbacks: [target("ollama", "automatic-fallback")] },
      new Set(),
    );

    expect(resolved).toEqual([primary, fallbackB, fallbackC]);
  });

  test("an explicitly empty fallback chain adds no automatic tail", () => {
    const primary = target("ollama", "primary");

    expect(resolveStageRoute(
      routeConfig({ executor: primary }, { executor: [] }),
      "executor",
      { primary: target("ollama", "automatic-primary"), fallbacks: [target("openrouter", "paid-tail")] },
      new Set(),
    )).toEqual([primary]);
  });

  test("absent and automatic settings preserve the automatic route", () => {
    const automatic = {
      primary: target("ollama", "automatic-primary"),
      fallbacks: [target("vllm", "automatic-fallback")],
    };

    expect(resolveStageRoute(routeConfig(), "planner", automatic, new Set())).toEqual([
      automatic.primary,
      ...automatic.fallbacks,
    ]);
    expect(resolveStageRoute(
      routeConfig({ planner: "automatic" }, { planner: "automatic" }),
      "planner",
      automatic,
      new Set(),
    )).toEqual([automatic.primary, ...automatic.fallbacks]);
    expect(hasStageRouteOverride(routeConfig({ planner: "automatic" }, { planner: "automatic" }), "planner")).toBe(false);
  });

  test("deduplicates the primary and fallbacks and omits excluded targets", () => {
    const primary = target("ollama", "primary");
    const excluded = target("openrouter", "org/model:blocked");
    const kept = target("vllm", "kept");
    const config = routeConfig({ reviewer: primary }, { reviewer: [primary, excluded, excluded, kept] });

    expect(resolveStageRoute(config, "reviewer", { fallbacks: [target("ollama", "automatic-tail")] }, new Set([
      stageTargetKey(excluded),
    ]))).toEqual([primary, kept]);

    expect(resolveStageRoute(config, "reviewer", { fallbacks: [] }, new Set([
      stageTargetKey(primary),
      stageTargetKey(excluded),
    ]))).toEqual([kept]);
  });

  test("round-trips model IDs containing slashes and colons", () => {
    const unusualId = target("openrouter", "org/model:tag");

    expect(resolveStageRoute(
      routeConfig({ synthesizer: unusualId }),
      "synthesizer",
      { fallbacks: [] },
      new Set(),
    )).toEqual([unusualId]);
  });

  for (const [name, raw] of invalidRouteConfigs) {
    test(`rejects ${name}`, () => {
      const validation = validateConfig(normalizeConfig(raw, { healInvalidTrajectorySnapshots: false }));
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  }
});
