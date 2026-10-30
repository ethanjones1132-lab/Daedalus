import { describe, expect, test } from "bun:test";
import {
  actualInferenceRouteTelemetry,
  observedStageRouteSseFrame,
} from "./inference-route-telemetry";

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

  test("includes a known stage on live route telemetry", () => {
    expect(actualInferenceRouteTelemetry({
      provider: "opencode_go",
      model: "deepseek-v4-flash",
      stage: "planner",
    })).toEqual({
      stage: "planner",
      actual_provider: "opencode_go",
      actual_model: "deepseek-v4-flash",
    });
  });

  test("builds the live SSE route frame only from an observed response and known route", () => {
    const response = new Response("upstream unavailable", { status: 503 });

    expect(observedStageRouteSseFrame({
      response,
      sessionId: "session-1",
      stage: "reviewer",
      provider: "openrouter",
      model: "review-model",
    })).toBe(`data: ${JSON.stringify({
      type: "stage_route",
      stage: "reviewer",
      actual_provider: "openrouter",
      actual_model: "review-model",
      session_id: "session-1",
    })}\n\n`);
    expect(observedStageRouteSseFrame({ response, sessionId: "session-1" })).toBeNull();
  });
});
