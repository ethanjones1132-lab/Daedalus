import { describe, expect, test } from "bun:test";
import { mapCheckToReward } from "./verification-reward";
import type { CheckResult } from "./check-runner";

function r(over: Partial<CheckResult>): CheckResult {
  return { tier: "existing", ran: true, passed: true, detail: "", command: "run", durationMs: 1, ...over };
}
const weights = { existing: 1, builtin: 1, synth: 0.5, none: 0 };

describe("mapCheckToReward", () => {
  test("existing pass → verified success, full weight", () => {
    expect(mapCheckToReward(r({}), weights, false)).toEqual({
      outcomeFloor: "success", verifiedVia: "runtime_check", checkTier: "existing", rewardWeight: 1,
    });
  });
  test("builtin pass → verified success", () => {
    expect(mapCheckToReward(r({ tier: "builtin" }), weights, false).verifiedVia).toBe("runtime_check");
  });
  test("synth pass unconfirmed → partial, not full success", () => {
    const m = mapCheckToReward(r({ tier: "synth" }), weights, false);
    expect(m.verifiedVia).toBe("synth");
    expect(m.rewardWeight).toBe(0.5);
    expect(m.outcomeFloor).toBe("degraded");
  });
  test("synth pass reviewer-confirmed → success", () => {
    expect(mapCheckToReward(r({ tier: "synth" }), weights, true).outcomeFloor).toBe("success");
  });
  test("failed check → failed floor with detail", () => {
    const m = mapCheckToReward(r({ passed: false, detail: "AssertionError" }), weights, false);
    expect(m.outcomeFloor).toBe("failed");
    expect(m.rewardWeight).toBe(0);
  });
  test("none → heuristic passthrough", () => {
    expect(mapCheckToReward(r({ tier: "none", ran: false, passed: null }), weights, false)).toMatchObject({
      verifiedVia: "heuristic", outcomeFloor: null,
    });
  });
});
