import { describe, expect, it } from "vitest";
import { providerLabel, providerTestState } from "./provider-settings";

describe("provider settings helpers", () => {
  it("labels each stored credential independently", () => {
    expect(providerLabel("openrouter")).toBe("OpenRouter API Key");
    expect(providerLabel("opencode_zen")).toBe("OpenCode Zen API Key");
    expect(providerLabel("opencode_go")).toBe("OpenCode Go API Key");
  });

  it("does not claim success until the provider response is ok", () => {
    expect(providerTestState(undefined)).toEqual({ label: "Not tested", variant: "default" });
    expect(providerTestState({ ok: true, latency_ms: 18 })).toEqual({ label: "Connected · 18 ms", variant: "success" });
    expect(providerTestState({ ok: false, latency_ms: 0, error: "denied" })).toEqual({ label: "denied", variant: "error" });
  });
});
