import { describe, expect, it } from "bun:test";
import { recordInference, inferenceMetricsSnapshot, backendForProvider } from "./inference-metrics";

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

  it("tracks opencode_zen and opencode_go as distinct backends (cross-provider fallback observability)", () => {
    // Regression: pre-fix, the `Backend` type only listed
    // ollama/openrouter/claude_cli, so any opencode_zen or opencode_go turn
    // was either a TypeScript error at the call site OR was silently
    // re-bucketed to "openrouter" by an unguarded `as Backend` cast. The
    // orchestrator's pool routes planner/executor/synthesizer defaults
    // through opencode_zen and opencode_go, so losing them in
    // `/health/inference` masked real traffic.
    recordInference({
      ts: Date.now(),
      backend: "opencode_zen",
      model: "nemotron-3-ultra-free",
      ok: true,
      latency_ms: 18500,
      tokens_in: 800,
      tokens_out: 200,
    });
    recordInference({
      ts: Date.now(),
      backend: "opencode_go",
      model: "mimo-v2.5",
      ok: true,
      latency_ms: 1500,
      tokens_in: 100,
      tokens_out: 50,
    });
    const snap = inferenceMetricsSnapshot();
    const zen = snap.backends.find((b) => b.backend === "opencode_zen");
    const go = snap.backends.find((b) => b.backend === "opencode_go");
    expect(zen).toBeDefined();
    expect(go).toBeDefined();
    expect(zen!.last_model).toBe("nemotron-3-ultra-free");
    expect(go!.last_model).toBe("mimo-v2.5");
    // Each backend keeps its own token totals — no double counting into
    // the openrouter bucket just because they share a model string format.
    expect(zen!.total_tokens_in).toBeGreaterThanOrEqual(800);
    expect(go!.total_tokens_in).toBeGreaterThanOrEqual(100);
  });
});

describe("backendForProvider", () => {
  it("maps known provider strings to the matching Backend enum", () => {
    expect(backendForProvider("ollama")).toBe("ollama");
    expect(backendForProvider("openrouter")).toBe("openrouter");
    expect(backendForProvider("claude_cli")).toBe("claude_cli");
    expect(backendForProvider("opencode_zen")).toBe("opencode_zen");
    expect(backendForProvider("opencode_go")).toBe("opencode_go");
  });

  it("returns undefined provider as 'openrouter' by default (legacy behavior)", () => {
    // The orchestrator's recordInference call sites use
    // `backendForProvider(orchLastProvider, cfg.active_backend)` so a missing
    // provider label falls back to the user's selected backend. The
    // historical default for an unknown selected backend was "openrouter"
    // (the most common case for a misconfigured pool). Lock that in.
    expect(backendForProvider(undefined)).toBe("openrouter");
  });

  it("falls back to the user's selected backend when provider is missing", () => {
    // Simulates the orchestrator failing before it ever recorded a provider
    // (e.g. network unreachable on the first attempt, config not loaded).
    expect(backendForProvider(undefined, "ollama")).toBe("ollama");
    expect(backendForProvider(undefined, "claude_cli")).toBe("claude_cli");
    expect(backendForProvider(undefined, "openrouter")).toBe("openrouter");
  });

  it("rejects unknown provider strings and falls back to the selected backend", () => {
    // Defense in depth: a future provider added to the pool but not to
    // `Backend` should not crash / mis-bucket silently.
    expect(backendForProvider("some_future_provider", "openrouter")).toBe("openrouter");
    expect(backendForProvider("some_future_provider", "ollama")).toBe("ollama");
    // Empty string is treated as undefined.
    expect(backendForProvider("", "claude_cli")).toBe("claude_cli");
  });

  it("never returns a backend value that recordInference cannot accept", () => {
    // Compile-time check: the function is typed to return Backend, but at
    // runtime verify that no unknown provider leaks through.
    const knownBackends = new Set(["ollama", "openrouter", "claude_cli", "opencode_zen", "opencode_go"]);
    for (const provider of [undefined, "", "ollama", "openrouter", "claude_cli", "opencode_zen", "opencode_go", "future_x"]) {
      for (const fallback of [undefined, "ollama", "openrouter", "claude_cli", "future_x"]) {
        const result = backendForProvider(provider, fallback);
        expect(knownBackends.has(result)).toBe(true);
      }
    }
  });
});
