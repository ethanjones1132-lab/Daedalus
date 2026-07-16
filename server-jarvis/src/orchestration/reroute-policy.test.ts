import { describe, expect, test } from "bun:test";
import { canApplyConductorReroute, DEFAULT_MAX_REROUTES_PER_SEGMENT } from "./reroute-policy";

describe("conductor reroute policy", () => {
  test("allows bounded successive evidence-driven reroutes instead of dropping the second directive", () => {
    expect(DEFAULT_MAX_REROUTES_PER_SEGMENT).toBeGreaterThan(1);
    expect(canApplyConductorReroute(0)).toBe(true);
    expect(canApplyConductorReroute(1)).toBe(true);
    expect(canApplyConductorReroute(DEFAULT_MAX_REROUTES_PER_SEGMENT)).toBe(false);
  });
});
