import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { BASELINE_THETA } from "../orchestration/orchestration-policy";
import { POLICY_ROLLOUT_FIXTURES } from "./policy-rollout-fixtures";
import { runPolicyRollout } from "./policy-rollout";

describe("deterministic policy rollout", () => {
  test("same theta + seed + fixture produces the same trajectory", () => {
    const fixture = POLICY_ROLLOUT_FIXTURES[0]!;
    const spec = { theta: BASELINE_THETA, seed: 17, fixtureId: fixture.id };
    const first = runPolicyRollout(spec, fixture);
    const second = runPolicyRollout(spec, fixture);

    expect(second.events).toEqual(first.events);
    expect(second.trajectoryDigest).toBe(first.trajectoryDigest);
    expect(second.events.length).toBe(fixture.steps.length);
  });

  test("seed and theta changes affect the trajectory for the intended reason", () => {
    const fixture = POLICY_ROLLOUT_FIXTURES[0]!;
    const baseline = runPolicyRollout(
      { theta: BASELINE_THETA, seed: 17, fixtureId: fixture.id }, fixture,
    );
    const otherSeed = runPolicyRollout(
      { theta: BASELINE_THETA, seed: 18, fixtureId: fixture.id }, fixture,
    );
    const otherTheta = runPolicyRollout(
      { theta: { no_tool_ratio_ceiling: 0.2 }, seed: 17, fixtureId: fixture.id }, fixture,
    );

    expect(otherSeed.trajectoryDigest).not.toBe(baseline.trajectoryDigest);
    expect(otherTheta.events).not.toEqual(baseline.events);
  });

  test("standalone runner emits canonical JSON for a selected fixture and seed", () => {
    const sub = Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        resolve(import.meta.dir, "policy-rollout.ts"),
        "--fixture",
        "completion_integrity_mixed",
        "--seed",
        "17",
        "--json",
      ],
      cwd: resolve(import.meta.dir, "../.."),
    });

    expect(sub.exitCode).toBe(0);
    expect(JSON.parse(sub.stdout.toString())).toMatchObject({
      rolloutFingerprint: expect.any(String),
      trajectoryDigest: expect.any(String),
      events: expect.any(Array),
    });
  });
});
