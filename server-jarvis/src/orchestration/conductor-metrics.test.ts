import { describe, expect, test, beforeEach } from "bun:test";
import {
  __resetConductorCacheMetricsForTests,
  conductorCacheSnapshot,
  estimateTokens,
  recordConductorCache,
} from "./conductor-metrics";

describe("conductor-metrics", () => {
  beforeEach(() => {
    __resetConductorCacheMetricsForTests();
  });

  test("records cache hits and computes hit rate", () => {
    recordConductorCache({
      ts: Date.now(),
      session_id: "s1",
      turn_number: 1,
      model: "gemma4:e2b",
      latency_ms: 120,
      ok: true,
      conductor_cache_hit: false,
      prefix_tokens_estimated: 500,
      delta_tokens_estimated: 200,
      prefix_tokens_recomputed: 500,
      kv_generation: 1,
    });
    recordConductorCache({
      ts: Date.now(),
      session_id: "s1",
      turn_number: 2,
      model: "gemma4:e2b",
      latency_ms: 80,
      ok: true,
      conductor_cache_hit: true,
      prefix_tokens_estimated: 900,
      delta_tokens_estimated: 150,
      prefix_tokens_recomputed: 0,
      kv_generation: 2,
    });

    const snap = conductorCacheSnapshot();
    expect(snap.window_size).toBe(2);
    expect(snap.cache_hit_rate).toBe(0.5);
    expect(snap.avg_prefix_recomputed).toBe(250);
  });

  test("estimateTokens is stable for equal strings", () => {
    expect(estimateTokens("abcd")).toBe(estimateTokens("abcd"));
  });
});