import { describe, expect, test } from "bun:test";
import { actualInferenceRouteTelemetry } from "./inference-route-telemetry";

describe("actualInferenceRouteTelemetry", () => {
  test("reports the provider, model, and visible TTFT that actually served the run", () => {
    expect(actualInferenceRouteTelemetry({
      provider: "opencode_zen",
      model: "deepseek-v4-flash-free",
      firstVisibleTokenMs: 3227,
    })).toEqual({
      actual_provider: "opencode_zen",
      actual_model: "deepseek-v4-flash-free",
      first_visible_token_ms: 3227,
    });
  });

  test("omits unavailable route fields instead of mislabeling the configured backend", () => {
    expect(actualInferenceRouteTelemetry({})).toEqual({});
  });
});
