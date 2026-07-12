import { describe, expect, test } from "bun:test";
import type { ModelAttribution, StageRun } from "../self-tuning/store";
import { summarizeTurnMetrics } from "./turn-metrics";

function stage(overrides: Partial<StageRun>): StageRun {
  return {
    id: crypto.randomUUID(),
    agent_run_id: "run-1",
    mode_id: "synthesizer",
    turn_number: 1,
    was_successful: 1,
    had_error: 0,
    tool_calls_json: "[]",
    ...overrides,
  };
}

function attribution(overrides: Partial<ModelAttribution>): ModelAttribution {
  return {
    id: crypto.randomUUID(),
    agent_run_id: "run-1",
    stage_id: "synthesizer",
    provider: "opencode_go",
    model_id: "deepseek-v4-flash",
    was_successful: 1,
    had_error: 0,
    fallback_used: 0,
    ...overrides,
  };
}

describe("summarizeTurnMetrics", () => {
  test("sums stage tokens exactly once", () => {
    const summary = summarizeTurnMetrics({
      stages: [
        stage({ input_tokens: 1_000, output_tokens: 100, duration_ms: 2_000 }),
        stage({ input_tokens: 2_000, output_tokens: 200, duration_ms: 3_000 }),
        stage({ input_tokens: 3_000, output_tokens: 300, duration_ms: 4_000 }),
      ],
      attributions: [],
    });

    expect(summary.tokens_in).toBe(6_000);
    expect(summary.tokens_out).toBe(600);
    expect(summary.tokens_total).toBe(6_600);
    expect(summary.stage_duration_ms).toBe(9_000);
  });

  test("counts failed attempts and successful fallbacks independently", () => {
    const summary = summarizeTurnMetrics({
      stages: [stage({ tool_calls_json: '[{"name":"write_file"}]' })],
      attributions: [
        attribution({ had_error: 1, was_successful: 0 }),
        attribution({ fallback_used: 1 }),
      ],
    });

    expect(summary.failed_attempts).toBe(1);
    expect(summary.fallback_successes).toBe(1);
    expect(summary.tool_calls).toBe(1);
  });
});
