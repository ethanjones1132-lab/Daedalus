import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig, normalizeConfig } from "../config";
import { createRoutingDescriptor, routingDescriptorFingerprint } from "./routing-descriptor";

interface SharedFixture {
  config: Record<string, unknown>;
  expected_descriptor: unknown;
  expected_sha256: string;
  expected_default_sha256: string;
  expected_default_descriptor: unknown;
}

const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../docs/orchestration/fixtures/routing-descriptor.json"), "utf8")) as SharedFixture;

describe("cross-language orchestration routing descriptor", () => {
  test("matches the shared descriptor and fingerprint fixture without secrets", () => {
    const config = normalizeConfig(structuredClone(fixture.config));
    config.openrouter.api_key = "fixture-openrouter-secret";
    config.opencode_zen.api_key = "fixture-opencode-zen-secret";
    config.opencode_go.api_key = "fixture-opencode-go-secret";
    const env = {};
    const descriptor = createRoutingDescriptor(config, env);

    expect(descriptor).toEqual(fixture.expected_descriptor);
    expect(routingDescriptorFingerprint(config, env)).toBe(fixture.expected_sha256);
    expect(JSON.stringify(descriptor)).not.toContain("fixture-openrouter-secret");
    expect(JSON.stringify(descriptor)).not.toContain("fixture-opencode-zen-secret");
    expect(JSON.stringify(descriptor)).not.toContain("fixture-opencode-go-secret");
  });

  test("recursively sorts object keys but preserves ordered fallbacks", () => {
    const config = normalizeConfig(structuredClone(fixture.config));
    const reordered = normalizeConfig(structuredClone(fixture.config));
    reordered.orchestrator.fallback_chains!.planner = [
      { provider: "ollama", model: "local/model-b" },
      { provider: "opencode_zen", model: "zen/model-a" },
    ];

    expect(routingDescriptorFingerprint(config, {})).not.toBe(routingDescriptorFingerprint(reordered, {}));
  });

  test("omitted false/default routing values match explicit defaults", () => {
    const omitted = normalizeConfig(defaultConfig());
    omitted.openrouter.api_key = "";
    omitted.opencode_zen.api_key = "";
    omitted.opencode_go.api_key = "";
    const explicit = normalizeConfig({
      active_backend: "llama_cpp",
      orchestrator: {
        enabled: true,
        allow_cloud_helpers: false,
        stage_models: Object.fromEntries(["coordinator", "planner", "executor", "reviewer", "rewriter", "synthesizer"].map((stage) => [stage, "automatic"])),
        fallback_chains: Object.fromEntries(["coordinator", "planner", "executor", "reviewer", "rewriter", "synthesizer"].map((stage) => [stage, "automatic"])),
      },
    });
    explicit.openrouter.api_key = "";
    explicit.opencode_zen.api_key = "";
    explicit.opencode_go.api_key = "";

    expect(routingDescriptorFingerprint(omitted, {})).toBe(routingDescriptorFingerprint(explicit, {}));
    expect(createRoutingDescriptor(omitted, {})).toEqual(fixture.expected_default_descriptor);
    expect(routingDescriptorFingerprint(omitted, {})).toBe(fixture.expected_default_sha256);
  });
});
