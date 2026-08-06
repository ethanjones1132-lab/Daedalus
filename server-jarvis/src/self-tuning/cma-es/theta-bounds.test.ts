import { describe, expect, test } from "bun:test";
import {
  BASELINE_THETA,
  THETA_KEYS,
  thetaToVector,
  vectorToTheta,
} from "../../orchestration/orchestration-policy";
import { projectToBounds, THETA_BOUNDS, vectorInBounds } from "./theta-bounds";

describe("THETA_BOUNDS coverage", () => {
  test("has exactly one entry per THETA_KEYS member, no extras", () => {
    expect(Object.keys(THETA_BOUNDS).sort()).toEqual([...THETA_KEYS].sort());
  });

  test("BASELINE_THETA is already inside its own box", () => {
    expect(vectorInBounds(thetaToVector(BASELINE_THETA))).toBe(true);
  });
});

describe("projectToBounds", () => {
  const idx = (key: string) => THETA_KEYS.indexOf(key as keyof typeof BASELINE_THETA);

  test("clamps a negative timeout to a real minimum instead of crashing a rollout", () => {
    const v = thetaToVector(BASELINE_THETA);
    v[idx("routing_timeout_ms")] = -500;
    const out = projectToBounds(v);
    expect(out[idx("routing_timeout_ms")]).toBe(THETA_BOUNDS.routing_timeout_ms.min);
    expect(out[idx("routing_timeout_ms")]).toBeGreaterThanOrEqual(1_000);
  });

  test("clamps a ratio of 2 into [0,1]", () => {
    const v = thetaToVector(BASELINE_THETA);
    v[idx("no_tool_ratio_ceiling")] = 2;
    expect(projectToBounds(v)[idx("no_tool_ratio_ceiling")]).toBe(1);
  });

  test("rounds a non-integer count and floors caps at their minimum", () => {
    const v = thetaToVector(BASELINE_THETA);
    v[idx("max_quality_pushes")] = 2.7;
    v[idx("max_failed_write_attempts_without_effect")] = 0.2;
    const out = projectToBounds(v);
    expect(out[idx("max_quality_pushes")]).toBe(3);
    expect(out[idx("max_failed_write_attempts_without_effect")]).toBe(1);
  });

  test("enforces reserved_mid_loop_escalations <= max_mid_loop_escalations", () => {
    const v = thetaToVector(BASELINE_THETA);
    v[idx("max_mid_loop_escalations")] = 1;
    v[idx("reserved_mid_loop_escalations")] = 4;
    const out = projectToBounds(v);
    expect(out[idx("reserved_mid_loop_escalations")]).toBe(1);
  });

  test("replaces non-finite entries with the dimension minimum", () => {
    const v = thetaToVector(BASELINE_THETA);
    v[idx("synthesis_runway_ms")] = Number.NaN;
    const out = projectToBounds(v);
    expect(out[idx("synthesis_runway_ms")]).toBe(THETA_BOUNDS.synthesis_runway_ms.min);
  });

  test("vectorToTheta of a projected vector yields a theta mergeTheta cannot reject", () => {
    const v = thetaToVector(BASELINE_THETA);
    v[idx("routing_timeout_ms")] = -10_000;
    v[idx("repetition_similarity_threshold")] = 7.5;
    v[idx("max_directives_per_turn")] = 3.3;
    const theta = vectorToTheta(projectToBounds(v), BASELINE_THETA);
    for (const key of THETA_KEYS) {
      expect(Number.isFinite(theta[key])).toBe(true);
    }
    // Round-trip: projected vector is a fixed point of projection.
    expect(vectorInBounds(thetaToVector(theta))).toBe(true);
  });
});
