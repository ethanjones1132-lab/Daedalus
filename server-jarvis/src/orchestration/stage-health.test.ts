import { describe, expect, test } from "bun:test";
import { StageHealthRegistry } from "./stage-health";

describe("StageHealthRegistry", () => {
  test("first-token timeout excludes a model for the next stage attempt", () => {
    const health = new StageHealthRegistry(() => 10_000);
    health.recordFailure({
      provider: "opencode_go",
      modelId: "deepseek-v4-pro",
      stage: "synthesizer",
      kind: "first_token_timeout",
    });

    expect(health.excludedModelKeys("synthesizer")).toEqual(
      new Set(["opencode_go:deepseek-v4-pro"]),
    );
    expect(health.excludedModelKeys("executor")).toEqual(new Set());
  });

  test("success clears a stage-specific cooldown", () => {
    const health = new StageHealthRegistry(() => 10_000);
    const model = { provider: "openrouter", modelId: "fast", stage: "synthesizer" };
    health.recordFailure({ ...model, kind: "stream_idle_timeout" });
    health.recordSuccess(model);
    expect(health.excludedModelKeys("synthesizer")).toEqual(new Set());
  });
});
