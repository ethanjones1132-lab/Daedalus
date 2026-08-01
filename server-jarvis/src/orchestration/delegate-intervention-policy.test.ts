import { describe, expect, test } from "bun:test";
import { decideDelegateIntervention } from "./delegate-intervention-policy";

const base = {
  intervention: { kind: "force_write", note: "write now", decisionSource: "deterministic_reflex" } as const,
  successfulReads: 2,
  successfulWrites: 0,
  failedWrites: 0,
  policyDenied: false,
  elapsedMs: 20_000,
  stageRemainingMs: 100_000,
  explorationLimitMs: 45_000,
  nativeFallbackReserveMs: 30_000,
};

describe("decideDelegateIntervention", () => {
  test("defers write pressure during productive exploration", () => {
    expect(decideDelegateIntervention(base)).toBe("defer");
  });

  test("hands off after the exploration limit", () => {
    expect(decideDelegateIntervention({ ...base, elapsedMs: 45_001 })).toBe("handoff");
  });

  test("hands off after a policy denial", () => {
    expect(decideDelegateIntervention({ ...base, policyDenied: true })).toBe("handoff");
  });

  test("hands off after repeated failed writes", () => {
    expect(decideDelegateIntervention({ ...base, failedWrites: 2 })).toBe("handoff");
  });

  test("hands off when native-fallback reserve is nearly exhausted", () => {
    expect(decideDelegateIntervention({
      ...base,
      stageRemainingMs: 30_000,
    })).toBe("handoff");
  });

  test("never discards a verified write", () => {
    expect(decideDelegateIntervention({ ...base, successfulWrites: 1 })).toBe("observe");
  });

  test("explicit abort remains terminal", () => {
    expect(decideDelegateIntervention({
      ...base,
      intervention: { kind: "abort", reason: "user stop", decisionSource: "deterministic_reflex" },
    })).toBe("abort");
  });

  test("verified write outranks policy denial", () => {
    expect(decideDelegateIntervention({
      ...base,
      successfulWrites: 1,
      policyDenied: true,
    })).toBe("observe");
  });
});
