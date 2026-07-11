import { describe, expect, test } from "bun:test";
import { defaultConfig } from "./config";
import { configuredInferenceFacts, isProviderAvailable } from "./provider-availability";

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
});
