import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  BASELINE_THETA,
  THETA_DIM,
  THETA_KEYS,
  applyThetaPatchGlobally,
  mergeTheta,
  mulberry32,
  parseTheta,
  policy,
  resetGlobalThetaToBaseline,
  rolloutFingerprint,
  runWithTheta,
  serializeTheta,
  setGlobalTheta,
  thetaEquals,
  thetaFingerprint,
  thetaToVector,
  vectorToTheta,
  withRollout,
} from "./orchestration-policy";

describe("OrchestrationTheta (Phase C)", () => {
  beforeEach(() => {
    resetGlobalThetaToBaseline();
  });
  afterEach(() => {
    resetGlobalThetaToBaseline();
  });

  test("baseline has every THETA_KEYS dimension and THETA_DIM matches", () => {
    expect(THETA_KEYS.length).toBe(THETA_DIM);
    expect(THETA_DIM).toBeGreaterThanOrEqual(40);
    expect(THETA_DIM).toBeLessThanOrEqual(60);
    for (const key of THETA_KEYS) {
      expect(typeof BASELINE_THETA[key]).toBe("number");
      expect(Number.isFinite(BASELINE_THETA[key])).toBe(true);
    }
  });

  test("baseline matches shipped hand-tuned values for key dimensions", () => {
    // Pins the "reproduce today's behaviour" exit criterion.
    expect(BASELINE_THETA.force_write_nudge_cap).toBe(2);
    expect(BASELINE_THETA.max_directives_per_turn).toBe(24);
    expect(BASELINE_THETA.local_stage_min_window_ms).toBe(75_000);
    expect(BASELINE_THETA.no_tool_demotion_threshold).toBe(0.6);
    expect(BASELINE_THETA.error_rate_bench_threshold).toBe(0.7);
    expect(BASELINE_THETA.max_delegate_launches_per_run).toBe(4);
    expect(BASELINE_THETA.default_free_thrash_threshold).toBe(2);
    expect(BASELINE_THETA.max_grounding_symbols).toBe(8);
    expect(BASELINE_THETA.overclaim_penalty).toBe(0.5);
    expect(BASELINE_THETA.deep_read_min_content_reads).toBe(3);
  });

  test("policy() defaults to baseline", () => {
    expect(thetaEquals(policy(), BASELINE_THETA)).toBe(true);
  });

  test("runWithTheta overlays without mutating global", () => {
    runWithTheta({ force_write_nudge_cap: 9 }, () => {
      expect(policy().force_write_nudge_cap).toBe(9);
      expect(policy().max_directives_per_turn).toBe(24);
    });
    expect(policy().force_write_nudge_cap).toBe(2);
  });

  test("setGlobalTheta / applyThetaPatchGlobally", () => {
    applyThetaPatchGlobally({ no_tool_demotion_threshold: 0.9 });
    expect(policy().no_tool_demotion_threshold).toBe(0.9);
    expect(policy().force_write_nudge_cap).toBe(2);
    setGlobalTheta(BASELINE_THETA);
    expect(policy().no_tool_demotion_threshold).toBe(0.6);
  });

  test("vector round-trip preserves baseline", () => {
    const v = thetaToVector(BASELINE_THETA);
    expect(v.length).toBe(THETA_DIM);
    const back = vectorToTheta(v);
    expect(thetaEquals(back, BASELINE_THETA)).toBe(true);
  });

  test("serialize / parse round-trip", () => {
    const s = serializeTheta(BASELINE_THETA);
    expect(thetaEquals(parseTheta(s), BASELINE_THETA)).toBe(true);
    expect(thetaFingerprint(BASELINE_THETA)).toBe(thetaFingerprint(parseTheta(s)));
  });

  test("mergeTheta ignores non-finite patch values", () => {
    const m = mergeTheta(BASELINE_THETA, {
      force_write_nudge_cap: Number.NaN,
      max_directives_per_turn: 10,
    } as any);
    expect(m.force_write_nudge_cap).toBe(2);
    expect(m.max_directives_per_turn).toBe(10);
  });
});

describe("C3 reproducible rollouts", () => {
  test("same (θ, seed, fixture) → identical fingerprint", () => {
    const a = rolloutFingerprint({
      theta: { force_write_nudge_cap: 3 },
      seed: 42,
      fixtureId: "clamp_with_lib",
    });
    const b = rolloutFingerprint({
      theta: { force_write_nudge_cap: 3 },
      seed: 42,
      fixtureId: "clamp_with_lib",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("different seed or fixture changes fingerprint", () => {
    const base = { theta: BASELINE_THETA, seed: 1, fixtureId: "t1" };
    expect(rolloutFingerprint(base)).not.toBe(
      rolloutFingerprint({ ...base, seed: 2 }),
    );
    expect(rolloutFingerprint(base)).not.toBe(
      rolloutFingerprint({ ...base, fixtureId: "t2" }),
    );
  });

  test("mulberry32 is deterministic", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  test("withRollout binds θ and yields stable fingerprint + policy", () => {
    const { fingerprint, result, theta } = withRollout(
      { theta: { force_write_nudge_cap: 5 }, seed: 99, fixtureId: "x" },
      (rng) => ({
        cap: policy().force_write_nudge_cap,
        r: rng(),
      }),
    );
    expect(theta.force_write_nudge_cap).toBe(5);
    expect(result.cap).toBe(5);
    const again = withRollout(
      { theta: { force_write_nudge_cap: 5 }, seed: 99, fixtureId: "x" },
      (rng) => ({
        cap: policy().force_write_nudge_cap,
        r: rng(),
      }),
    );
    expect(again.fingerprint).toBe(fingerprint);
    expect(again.result).toEqual(result);
  });
});
