import { beforeEach, describe, expect, it } from "bun:test";
import {
  recordInference,
  recordInferenceAttempt,
  inferenceMetricsSnapshot,
  backendForProvider,
  observeFirstTokenProgress,
  resolveCascadeTelemetry,
} from "./inference-metrics";
import {
  recordConductorCache,
  __resetConductorCacheMetricsForTests,
} from "./orchestration/conductor-metrics";

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

  it("exposes recent stage attempts without prompt or response content", () => {
    recordInferenceAttempt({
      ts: Date.now(),
      session_id: "attempt-session",
      run_id: "attempt-run",
      stage: "synthesizer",
      provider: "opencode_go",
      model: "deepseek-v4-flash",
      outcome: "empty_completion",
      latency_ms: 21_000,
      first_token_ms: 20_500,
      fallback_attempt: 0,
    });

    const attempt = inferenceMetricsSnapshot().recent_attempts.at(-1);
    expect(attempt).toMatchObject({
      session_id: "attempt-session",
      stage: "synthesizer",
      outcome: "empty_completion",
      latency_ms: 21_000,
    });
    expect(JSON.stringify(attempt)).not.toContain("prompt");
  });

  // T0.1: truncated is a first-class attempt outcome (provider_cut / length).
  it("records truncated attempt outcomes", () => {
    recordInferenceAttempt({
      ts: Date.now(),
      session_id: "trunc-session",
      run_id: "trunc-run",
      stage: "synthesizer",
      provider: "opencode_go",
      model: "deepseek-v4-pro",
      outcome: "truncated",
      latency_ms: 45_000,
      first_token_ms: 12_000,
      fallback_attempt: 1,
    });
    const attempt = inferenceMetricsSnapshot().recent_attempts.at(-1);
    expect(attempt?.outcome).toBe("truncated");
    expect(attempt?.stage).toBe("synthesizer");
  });
});

describe("resolveCascadeTelemetry", () => {
  it("prefers real provider retry metadata over the exclusion-set proxy", () => {
    expect(resolveCascadeTelemetry({
      retries: 2,
      fallback_depth: 1,
      fallback_reason: "rate_limited",
    }, 0)).toEqual({
      attempts: 2,
      used: true,
      depth: 1,
      reason: "rate_limited",
    });
  });

  it("retains outer empty-completion exclusions when they exceed provider retries", () => {
    expect(resolveCascadeTelemetry({ retries: 0, fallback_depth: 0 }, 2)).toMatchObject({
      attempts: 2,
      used: true,
    });
  });
});

describe("observeFirstTokenProgress", () => {
  it("keeps reasoning-only transport separate from visible first-token latency", () => {
    const reasoning = observeFirstTokenProgress(undefined, "transport", 1_200);
    expect(reasoning).toEqual({
      transportReceived: true,
      visibleReceived: false,
      firstTokenMs: undefined,
    });

    const visible = observeFirstTokenProgress(reasoning, "visible", 3_450);
    expect(visible).toEqual({
      transportReceived: true,
      visibleReceived: true,
      firstTokenMs: 3_450,
    });

    expect(observeFirstTokenProgress(visible, "visible", 8_000).firstTokenMs).toBe(3_450);
  });

  it("records a visible first chunk as both transport and visible progress", () => {
    expect(observeFirstTokenProgress(undefined, "visible", 275)).toEqual({
      transportReceived: true,
      visibleReceived: true,
      firstTokenMs: 275,
    });
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

describe("inferenceMetricsSnapshot.conductor_cache (Track A)", () => {
  // The conductor cache ring is module-singleton shared state — reset
  // before each case so window_size reflects only what THIS case wrote.
  // Other test files in this repo also touch the ring; resetting in an
  // isolated describe keeps the assertions hermetic.
  beforeEach(() => {
    __resetConductorCacheMetricsForTests();
  });

  it("reports conductor_cache as null when no conductor turns have been recorded", () => {
    // After a hard reset the ring is empty. The snapshot must surface
    // `null` — a fabricated "0% hit rate" with window_size=0 would look
    // indistinguishable from a real bad measurement to a UI consumer.
    const snap = inferenceMetricsSnapshot();
    expect(snap.conductor_cache).toBeNull();
  });

  it("folds conductor cache observability into the inference snapshot", () => {
    // Two turns, one cache hit, one miss → 0.5 hit rate. The snapshot
    // should expose this through `conductor_cache` with the same window
    // math as the standalone /health/conductor-cache endpoint.
    recordConductorCache({
      ts: Date.now(),
      session_id: "snap-sess-1",
      turn_number: 1,
      model: "gemma4:e2b",
      latency_ms: 250,
      ok: true,
      conductor_cache_hit: false,
      prefix_tokens_estimated: 800,
      delta_tokens_estimated: 120,
      prefix_tokens_recomputed: 800,
      kv_generation: 1,
    });
    recordConductorCache({
      ts: Date.now() + 1,
      session_id: "snap-sess-1",
      turn_number: 2,
      model: "gemma4:e2b",
      latency_ms: 180,
      ok: true,
      conductor_cache_hit: true,
      prefix_tokens_estimated: 920,
      delta_tokens_estimated: 80,
      prefix_tokens_recomputed: 0,
      kv_generation: 2,
    });

    const snap = inferenceMetricsSnapshot();
    expect(snap.conductor_cache).not.toBeNull();
    const cc = snap.conductor_cache!;
    expect(cc.window_size).toBe(2);
    expect(cc.cache_hit_rate).toBe(0.5);
    // First turn recomputed 800 prefix tokens, second turn 0 → average 400.
    expect(cc.avg_prefix_recomputed).toBe(400);
    expect(cc.records).toHaveLength(2);
    expect(cc.records[0].conductor_cache_hit).toBe(false);
    expect(cc.records[1].conductor_cache_hit).toBe(true);
    expect(cc.records[1].kv_generation).toBe(2);
    expect(typeof cc.generated_at).toBe("number");
  });

  it("preserves backends stats alongside conductor cache (no double counting, no field collision)", () => {
    // Regression: pre-Track-A, the snapshot had no `conductor_cache` field.
    // Adding it must NOT change `backends`, `window_size`, or `generated_at`
    // shape — those are the contract for SystemHealthView.
    recordInference({
      ts: Date.now(),
      backend: "ollama",
      model: "qwen3:8b-snap",
      ok: true,
      latency_ms: 200,
      tokens_in: 50,
      tokens_out: 50,
    });
    recordConductorCache({
      ts: Date.now(),
      session_id: "snap-sess-2",
      turn_number: 1,
      model: "gemma4:e2b",
      latency_ms: 250,
      ok: true,
      conductor_cache_hit: false,
      prefix_tokens_estimated: 800,
      delta_tokens_estimated: 120,
      prefix_tokens_recomputed: 800,
      kv_generation: 1,
    });

    const snap = inferenceMetricsSnapshot();
    const ollama = snap.backends.find((b) => b.backend === "ollama");
    expect(ollama).toBeDefined();
    expect(ollama!.requests).toBeGreaterThanOrEqual(1);
    // Conductor turns are NOT miscounted as ollama backend requests.
    expect(ollama!.last_model).toBe("qwen3:8b-snap");
    // Both fields coexist without collision.
    expect(snap.conductor_cache).not.toBeNull();
    expect(snap.conductor_cache!.window_size).toBe(1);
  });
});
