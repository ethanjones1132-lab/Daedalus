import { describe, expect, test } from "bun:test";
import {
  __resetDelegateThrashForTests,
  clearDelegateThrash,
  DEFAULT_THRASH_TTL_MS,
  delegateThrashKey,
  enumerateDelegateModelCandidates,
  getDelegateThrashCount,
  isDelegateThrashOutcome,
  isProxyResolvable,
  isToolCallCapableDelegate,
  DELEGATE_FREE_FIRST_MODELS,
  DELEGATE_GO_OPENAI_MODELS,
  DELEGATE_TOOL_INCAPABLE_MODELS,
  recordDelegateThrash,
  selectDelegateModel,
} from "./delegate-model-select";

// 2026-08-01, live runs run_d84a937f / run_275068a5: the delegate is the
// PRIMARY write path, and `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
// sat second in DELEGATE_FREE_FIRST_MODELS. Reasoning models emit <think> and
// leave `content` empty, so there is nothing to parse as a tool call — the
// same trap already recorded for MiniMax M3. Observed: one executor turn
// produced 7825 output tokens with ZERO tool calls, the delegate's only edit
// was a no-op (`old_string` === `new_string`), and both delegate stages
// recorded ok=0 err=1.
//
// Exclusion is by EXPLICIT id, never a substring heuristic on "reasoning":
// a wrong exclusion silently costs a free lane, and re-enabling a model when
// it gains tool support must be a one-line edit. Free-first ordering is
// untouched — capable free models are still tried before any paid tier.
describe("delegate tool-call capability filter", () => {
  test("the known reasoning model is excluded", () => {
    expect(isToolCallCapableDelegate("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free")).toBe(false);
  });

  test("north-mini-code stays capable and remains the free-first primary", () => {
    expect(isToolCallCapableDelegate("cohere/north-mini-code:free")).toBe(true);
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("free");
    expect(s.model).toBe("cohere/north-mini-code:free");
  });

  test("a model is not excluded merely for having 'reasoning' in its id", () => {
    // Guards against the substring heuristic this deliberately avoids.
    expect(isToolCallCapableDelegate("vendor/some-reasoning-capable-coder:free")).toBe(true);
  });

  test("the exclusion set is injectable so a model can be toggled back", () => {
    expect(isToolCallCapableDelegate("cohere/north-mini-code:free", ["cohere/north-mini-code:free"]))
      .toBe(false);
    expect(isToolCallCapableDelegate("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", []))
      .toBe(true);
  });

  test("selection never returns an incapable model from the free pool", () => {
    // Rotate through every thrash count that still selects from free.
    for (let thrash = 0; thrash < DELEGATE_FREE_FIRST_MODELS.length; thrash++) {
      const s = selectDelegateModel({
        configuredModel: "auto",
        thrashCount: thrash,
        proxyAvailable: true,
        hasOpenCodeGoKey: true,
      });
      if (s.pool !== "free") continue;
      expect(DELEGATE_TOOL_INCAPABLE_MODELS).not.toContain(s.model);
    }
  });

  test("free-first is preserved: a capable free model still beats the paid tier", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("free");
  });
});

describe("selectDelegateModel (Slice B free-first)", () => {
  test("auto starts on free-first pool when proxy is up", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("free");
    expect(s.reason).toBe("free_first");
    expect(s.model).toContain("free");
  });

  test("auto rotates free models with thrash before Go", () => {
    const s0 = selectDelegateModel({ configuredModel: "auto", thrashCount: 0, proxyAvailable: true });
    const s1 = selectDelegateModel({ configuredModel: "auto", thrashCount: 1, proxyAvailable: true });
    expect(s0.pool).toBe("free");
    expect(s1.pool).toBe("free");
    expect(s1.model).not.toBe(s0.model);
  });

  test("thrash at threshold promotes to cheapest Go capable", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 2,
      thrashThreshold: 2,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("go_capable");
    expect(s.model).toBe("deepseek-v4-flash");
    expect(s.reason).toContain("thrash_promoted");
  });

  test("no proxy promotes to Anthropic-native Go (minimax) instead of free", () => {
    const s = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      proxyAvailable: false,
      hasOpenCodeGoKey: true,
    });
    expect(s.pool).toBe("go_capable");
    expect(s.model).toBe("minimax-m3");
    expect(s.reason).toContain("no_proxy");
  });

  test("operator pin is honored until thrash threshold", () => {
    const s = selectDelegateModel({
      configuredModel: "minimax-m3",
      thrashCount: 0,
      proxyAvailable: true,
    });
    expect(s).toMatchObject({ model: "minimax-m3", reason: "operator_pin", pool: "go_capable" });
    const promoted = selectDelegateModel({
      configuredModel: "minimax-m3",
      thrashCount: 2,
      thrashThreshold: 2,
      proxyAvailable: true,
    });
    expect(promoted.pool).toBe("go_capable");
    expect(promoted.model).toBe("deepseek-v4-flash");
  });

  test("enumerate includes free then go then anthropic fallback", () => {
    const list = enumerateDelegateModelCandidates({
      configuredModel: "auto",
      thrashCount: 0,
      thrashThreshold: 2,
      proxyAvailable: true,
      hasOpenCodeGoKey: true,
    });
    expect(list.some((s) => s.pool === "free")).toBe(true);
    expect(list.some((s) => s.model === "deepseek-v4-flash")).toBe(true);
    expect(list.some((s) => s.model === "minimax-m3")).toBe(true);
  });
});

describe("delegate thrash accounting", () => {
  test("records and clears thrash per key", () => {
    __resetDelegateThrashForTests();
    expect(getDelegateThrashCount("run-a")).toBe(0);
    expect(recordDelegateThrash("run-a")).toBe(1);
    expect(recordDelegateThrash("run-a")).toBe(2);
    clearDelegateThrash("run-a");
    expect(getDelegateThrashCount("run-a")).toBe(0);
  });

  test("session thrash key trims and falls back", () => {
    expect(delegateThrashKey("  session-abc  ")).toBe("session-abc");
    expect(delegateThrashKey("")).toBe("unknown-session");
    expect(delegateThrashKey("   ")).toBe("unknown-session");
  });

  test("expires thrash after thrash_ttl_ms", () => {
    __resetDelegateThrashForTests();
    const t0 = 1_000_000;
    const ttl = 60_000;
    expect(recordDelegateThrash("session-ttl", ttl, t0)).toBe(1);
    expect(getDelegateThrashCount("session-ttl", ttl, t0 + 30_000)).toBe(1);
    expect(getDelegateThrashCount("session-ttl", ttl, t0 + ttl + 1)).toBe(0);
    // Re-record after expiry starts a fresh counter.
    expect(recordDelegateThrash("session-ttl", ttl, t0 + ttl + 2)).toBe(1);
    expect(DEFAULT_THRASH_TTL_MS).toBe(30 * 60_000);
  });

  test("thrash outcomes match no-write / stream failures / handoff", () => {
    expect(isDelegateThrashOutcome({ ok: true, hasVerifiedWrite: true })).toBe(false);
    expect(isDelegateThrashOutcome({ ok: true, hasVerifiedWrite: false })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_no_write",
    })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_stream_error",
    })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "mid_loop_handoff",
    })).toBe(true);
    // Named CLI stream failures used to surface as delegate_exit_nonzero
    // (matched via "exit"). Preferring delegate_cli_error must stay thrash-
    // eligible so free→Go promotion still advances on repeated CLI failures.
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_cli_error",
    })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_exit_nonzero",
    })).toBe(true);
  });
});

describe("delegate only selects models the claude_cli proxy can resolve", () => {
  const installed = ["qwythos9b-conductor:latest", "qwen3.5:4b", "qwen3:8b"];
  const goOpenaiModels = ["deepseek-v4-flash", "mimo-v2.5"];

  test("a namespaced id routes to OpenRouter and is resolvable", () => {
    expect(isProxyResolvable("cohere/north-mini-code:free", installed, goOpenaiModels)).toBe(true);
    expect(isProxyResolvable("deepseek/deepseek-v4-flash", installed, goOpenaiModels)).toBe(true);
  });

  test("a bare OpenCode Go OpenAI-format id resolves via rule 1, not Ollama", () => {
    for (const model of DELEGATE_GO_OPENAI_MODELS) {
      expect(isProxyResolvable(model, [], goOpenaiModels)).toBe(true);
    }
  });

  test("a bare id NOT in the Go OpenAI list is only resolvable when installed in Ollama", () => {
    expect(isProxyResolvable("qwen3:8b", installed, goOpenaiModels)).toBe(true);
    expect(isProxyResolvable("deepseek-v4-flash-free", installed, goOpenaiModels)).toBe(false);
  });

  test("claude-* placeholders fall back to the proxy default model", () => {
    expect(isProxyResolvable("claude-sonnet-4", installed, goOpenaiModels)).toBe(true);
  });

  test("every default free-first model is namespaced", () => {
    for (const model of DELEGATE_FREE_FIRST_MODELS) {
      expect({ model, namespaced: model.includes("/") })
        .toEqual({ model, namespaced: true });
    }
  });

  test("a custom goOpenaiModels list is honored by free-pool resolvability, not the module default", () => {
    // "custom-bare-model" is NOT namespaced, NOT installed in Ollama, and NOT
    // in the module-level DELEGATE_GO_OPENAI_MODELS default -- it only
    // resolves if selectDelegateModel's OWN resolved `goOpenai` (from
    // input.goOpenaiModels) is what gets passed into isProxyResolvable for
    // the free-pool filter, rather than isProxyResolvable falling back to
    // its own default parameter.
    const result = selectDelegateModel({
      configuredModel: "auto",
      thrashCount: 0,
      freeModels: ["custom-bare-model"],
      goOpenaiModels: ["custom-bare-model"], // NOT in DELEGATE_GO_OPENAI_MODELS
      installedOllamaModels: [],
    });
    expect(result.model).toBe("custom-bare-model");
    expect(result.pool).toBe("free");
    expect(result.reason).toBe("free_first");
  });
});
