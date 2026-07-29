import { describe, expect, test } from "bun:test";
import {
  __resetDelegateThrashForTests,
  clearDelegateThrash,
  enumerateDelegateModelCandidates,
  getDelegateThrashCount,
  isDelegateThrashOutcome,
  isProxyResolvable,
  DELEGATE_FREE_FIRST_MODELS,
  DELEGATE_GO_OPENAI_MODELS,
  recordDelegateThrash,
  selectDelegateModel,
} from "./delegate-model-select";

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

  test("thrash outcomes match no-write / stream failures", () => {
    expect(isDelegateThrashOutcome({ ok: true, hasVerifiedWrite: true })).toBe(false);
    expect(isDelegateThrashOutcome({ ok: true, hasVerifiedWrite: false })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_no_write",
    })).toBe(true);
    expect(isDelegateThrashOutcome({
      ok: false, hasVerifiedWrite: false, errorCode: "delegate_stream_error",
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
