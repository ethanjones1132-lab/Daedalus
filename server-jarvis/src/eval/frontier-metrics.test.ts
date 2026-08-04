import { describe, expect, test } from "bun:test";
import {
  summarizeFrontierMetrics,
  type FrontierMetricsRun,
} from "./frontier-metrics";

function run(over: Partial<FrontierMetricsRun> = {}): FrontierMetricsRun {
  return {
    duration_ms: 10_000,
    created_at: "2026-08-01T12:00:00.000Z",
    stageRuns: [
      { mode_id: "coordinator", duration_ms: 1_000, created_at: "2026-08-01T12:00:01.000Z" },
      { mode_id: "executor", duration_ms: 4_000, created_at: "2026-08-01T12:00:05.000Z" },
      { mode_id: "synthesizer", duration_ms: 2_000, created_at: "2026-08-01T12:00:12.000Z" },
    ],
    ...over,
  };
}

describe("summarizeFrontierMetrics", () => {
  test("empty window yields nulls and cache_hit_rate 0", () => {
    const summary = summarizeFrontierMetrics([]);
    expect(summary.avg_run_wall_clock).toBeNull();
    expect(summary.round_trips_per_run).toBeNull();
    expect(summary.time_to_first_visible_token).toBeNull();
    expect(summary.cache_hit_rate).toBe(0);
  });

  test("avg_run_wall_clock uses agent_runs.duration_ms when present", () => {
    const summary = summarizeFrontierMetrics([
      run({ duration_ms: 12_000 }),
      run({ duration_ms: 8_000 }),
    ]);
    expect(summary.avg_run_wall_clock).toBe(10_000);
  });

  test("avg_run_wall_clock falls back to sum of stage durations", () => {
    const summary = summarizeFrontierMetrics([
      run({
        duration_ms: null,
        stageRuns: [
          { mode_id: "executor", duration_ms: 3_000 },
          { mode_id: "reviewer", duration_ms: 2_000 },
        ],
      }),
    ]);
    expect(summary.avg_run_wall_clock).toBe(5_000);
  });

  test("avg_run_wall_clock is null when no duration signal exists", () => {
    const summary = summarizeFrontierMetrics([
      run({
        duration_ms: undefined,
        stageRuns: [{ mode_id: "executor" }],
      }),
    ]);
    expect(summary.avg_run_wall_clock).toBeNull();
  });

  test("round_trips_per_run is stage_runs / runs", () => {
    const summary = summarizeFrontierMetrics([
      run({
        stageRuns: [
          { mode_id: "coordinator" },
          { mode_id: "executor" },
          { mode_id: "synthesizer" },
        ],
      }),
      run({
        stageRuns: [{ mode_id: "executor" }, { mode_id: "executor" }],
      }),
    ]);
    // (3 + 2) / 2 = 2.5
    expect(summary.round_trips_per_run).toBe(2.5);
  });

  test("time_to_first_visible_token is run.created_at → first synthesizer created_at", () => {
    const summary = summarizeFrontierMetrics([
      run({
        created_at: "2026-08-01T12:00:00.000Z",
        stageRuns: [
          { mode_id: "executor", created_at: "2026-08-01T12:00:05.000Z" },
          { mode_id: "synthesizer", created_at: "2026-08-01T12:00:15.000Z" },
        ],
      }),
    ]);
    expect(summary.time_to_first_visible_token).toBe(15_000);
  });

  test("time_to_first_visible_token is null without synthesizer timestamps", () => {
    const summary = summarizeFrontierMetrics([
      run({
        created_at: "2026-08-01T12:00:00.000Z",
        stageRuns: [{ mode_id: "executor", created_at: "2026-08-01T12:00:05.000Z" }],
      }),
    ]);
    expect(summary.time_to_first_visible_token).toBeNull();
  });

  test("time_to_first_visible_token averages across runs with data", () => {
    const summary = summarizeFrontierMetrics([
      run({
        created_at: "2026-08-01T12:00:00.000Z",
        stageRuns: [
          { mode_id: "synthesizer", created_at: "2026-08-01T12:00:10.000Z" },
        ],
      }),
      run({
        created_at: "2026-08-01T13:00:00.000Z",
        stageRuns: [
          { mode_id: "synthesizer", created_at: "2026-08-01T13:00:20.000Z" },
        ],
      }),
      // No synthesizer → excluded from mean
      run({
        created_at: "2026-08-01T14:00:00.000Z",
        stageRuns: [{ mode_id: "executor", created_at: "2026-08-01T14:00:01.000Z" }],
      }),
    ]);
    expect(summary.time_to_first_visible_token).toBe(15_000);
  });

  test("cache_hit_rate stays 0 until durable per-run cache signals exist", () => {
    const summary = summarizeFrontierMetrics([run(), run()]);
    expect(summary.cache_hit_rate).toBe(0);
  });
});
