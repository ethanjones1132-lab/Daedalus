import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  BASELINE_THETA,
  ThetaValidationError,
  THETA_DIM,
  THETA_KEYS,
  applyThetaPatchGlobally,
  mergeTheta,
  mulberry32,
  parseTheta,
  policy,
  resetGlobalThetaToBaseline,
  rolloutId,
  rolloutNow,
  rolloutRandom,
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
    expect(BASELINE_THETA.deep_read_min_content_reads).toBe(3);
  });

  test("reward-objective keys are not optimizable theta dimensions", () => {
    expect(THETA_KEYS).not.toContain("reward_weight_writes" as never);
    expect(THETA_KEYS).not.toContain("reward_weight_check" as never);
    expect(THETA_KEYS).not.toContain("reward_weight_plan" as never);
    expect(THETA_KEYS).not.toContain("overclaim_penalty" as never);
  });

  test("rollout-governance keys are not optimizable theta dimensions", () => {
    expect(THETA_KEYS).not.toContain("policy_canary_traffic_fraction" as never);
    expect(THETA_KEYS).not.toContain("policy_min_canary_success_rate" as never);
    expect(THETA_KEYS).not.toContain("policy_min_eligible_outcomes_before_shadow" as never);
    expect(THETA_KEYS).not.toContain("policy_min_canary_runs_before_promotion" as never);
  });

  test("manual serialized theta rejects removed reward keys", () => {
    expect(() => parseTheta(JSON.stringify({
      force_write_nudge_cap: 4,
      reward_weight_writes: 100,
      reward_weight_check: 0,
      reward_weight_plan: 0,
      overclaim_penalty: 0,
    }))).toThrow(ThetaValidationError);
  });

  test("policy() defaults to baseline", () => {
    expect(thetaEquals(policy(), BASELINE_THETA)).toBe(true);
  });

  test("runWithTheta overlays without mutating global", () => {
    runWithTheta({ force_write_nudge_cap: 8 }, () => {
      expect(policy().force_write_nudge_cap).toBe(8);
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

  test("manual theta patches reject unsafe domains", () => {
    expect(() => mergeTheta(BASELINE_THETA, { routing_timeout_ms: -1 }))
      .toThrow(ThetaValidationError);
    expect(() => mergeTheta(BASELINE_THETA, { no_tool_ratio_ceiling: 1.1 }))
      .toThrow(ThetaValidationError);
    expect(() => mergeTheta(BASELINE_THETA, { max_directives_per_turn: 1.5 }))
      .toThrow(ThetaValidationError);
  });

  test("cross-field invariants reject contradictory theta", () => {
    expect(() => mergeTheta(BASELINE_THETA, {
      max_mid_loop_escalations: 1,
      reserved_mid_loop_escalations: 2,
    })).toThrow(/reserved_mid_loop_escalations/);
    expect(() => mergeTheta(BASELINE_THETA, {
      absolute_turn_cap_ms: 60_000,
      stage_extension_ceiling_ms: 90_000,
    })).toThrow(/stage_extension_ceiling_ms/);
  });

  test("optimizer vectors are deterministically projected", () => {
    const vector = thetaToVector(BASELINE_THETA);
    vector[THETA_KEYS.indexOf("routing_timeout_ms")] = -1;
    vector[THETA_KEYS.indexOf("no_tool_ratio_ceiling")] = 2;
    vector[THETA_KEYS.indexOf("max_directives_per_turn")] = 3.8;
    const projected = vectorToTheta(vector);
    expect(projected.routing_timeout_ms).toBe(1_000);
    expect(projected.no_tool_ratio_ceiling).toBe(1);
    expect(projected.max_directives_per_turn).toBe(4);
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

  test("withRollout controls random, time, and ids", () => {
    const spec = { theta: BASELINE_THETA, seed: 42, fixtureId: "runtime" };
    const first = withRollout(spec, () => ({
      draws: [rolloutRandom(), rolloutRandom()],
      times: [rolloutNow(), rolloutNow()],
      ids: [rolloutId("evt"), rolloutId("evt")],
    }));
    const second = withRollout(spec, () => ({
      draws: [rolloutRandom(), rolloutRandom()],
      times: [rolloutNow(), rolloutNow()],
      ids: [rolloutId("evt"), rolloutId("evt")],
    }));
    expect(second.result).toEqual(first.result);
  });
});
