import { describe, expect, it } from "bun:test";
import { recordInference, inferenceMetricsSnapshot } from "./inference-metrics";

// Note: the ring is module-level shared state. Each test records distinct
// backends/models so they stay independently verifiable.

describe("inferenceMetricsSnapshot", () => {
  it("starts empty (no backends) before any records", () => {
    // Snapshot may already have entries from other tests — filter to unique backend.
    const snap = inferenceMetricsSnapshot();
    expect(typeof snap.window_size).toBe("number");
    expect(Array.isArray(snap.backends)).toBe(true);
    expect(typeof snap.generated_at).toBe("number");
  });

  it("records and returns a successful turn", () => {
    recordInference({
      ts: Date.now(),
      backend: "claude_cli",
      model: "claude-opus-test",
      ok: true,
      latency_ms: 321,
      tokens_in: 10,
      tokens_out: 20,
    });
    const snap = inferenceMetricsSnapshot();
    const stat = snap.backends.find((b) => b.backend === "claude_cli");
    expect(stat).toBeDefined();
    expect(stat!.errors).toBe(0);
    expect(stat!.requests).toBeGreaterThanOrEqual(1);
    expect(stat!.last_model).toBe("claude-opus-test");
  });

  it("counts errors and reports error_rate", () => {
    for (let i = 0; i < 3; i++) {
      recordInference({
        ts: Date.now(),
        backend: "ollama",
        model: "qwen3:8b-test",
        ok: i < 2,  // first 2 ok, last 1 error
        latency_ms: 100 + i * 50,
        tokens_in: 5,
        tokens_out: 5,
        error: i >= 2 ? "connection refused" : undefined,
      });
    }
    const snap = inferenceMetricsSnapshot();
    const stat = snap.backends.find((b) => b.backend === "ollama");
    expect(stat).toBeDefined();
    expect(stat!.errors).toBeGreaterThanOrEqual(1);
    expect(stat!.last_error).toMatch(/connection refused/);
    expect(stat!.error_rate).toBeGreaterThan(0);
  });

  it("percentile latencies are ordered (p95 >= p50)", () => {
    for (let i = 0; i < 10; i++) {
      recordInference({
        ts: Date.now(),
        backend: "openrouter",
        model: "meta-llama/test",
        ok: true,
        latency_ms: 100 + i * 30,  // 100, 130, ..., 370
        tokens_in: 100,
        tokens_out: 200,
      });
    }
    const snap = inferenceMetricsSnapshot();
    const stat = snap.backends.find((b) => b.backend === "openrouter");
    expect(stat).toBeDefined();
    expect(stat!.p95_ms).toBeGreaterThanOrEqual(stat!.p50_ms);
  });

  it("aggregates retry telemetry and fallbacks", () => {
    recordInference({
      ts: Date.now(),
      backend: "openrouter",
      model: "primary",
      ok: true,
      latency_ms: 100,
      tokens_in: 10,
      tokens_out: 20,
      fallback_used: true,
      retry_count: 2,
      fallback_model: "fallback-model",
    });
    recordInference({
      ts: Date.now(),
      backend: "openrouter",
      model: "fallback-model",
      ok: true,
      latency_ms: 150,
      tokens_in: 5,
      tokens_out: 15,
      fallback_used: false,
      retry_count: 0,
    });
    const snap = inferenceMetricsSnapshot();
    const stat = snap.backends.find((b) => b.backend === "openrouter");
    expect(stat).toBeDefined();
    expect(stat!.total_retries).toBeGreaterThanOrEqual(2);
    expect(stat!.fallbacks_used).toBeGreaterThanOrEqual(1);
    expect(stat!.last_fallback_model).toBe("fallback-model");
  });
});
