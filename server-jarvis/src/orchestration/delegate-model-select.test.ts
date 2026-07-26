import { describe, expect, test } from "bun:test";
import {
  __resetDelegateThrashForTests,
  clearDelegateThrash,
  enumerateDelegateModelCandidates,
  getDelegateThrashCount,
  isDelegateThrashOutcome,
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
