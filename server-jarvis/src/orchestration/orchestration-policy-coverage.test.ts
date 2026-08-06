import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { THETA_KEYS } from "./orchestration-policy";
import { THETA_DECISION_OWNERS } from "./orchestration-policy-schema";

const SRC_ROOT = resolve(import.meta.dir, "..");
const GOVERNANCE_KEYS = new Set([
  "policy_canary_traffic_fraction",
  "policy_min_canary_success_rate",
  "policy_min_eligible_outcomes_before_shadow",
  "policy_min_canary_runs_before_promotion",
]);

describe("Phase C policy coverage", () => {
  test("every eligible theta key has a live request-scoped decision read", () => {
    expect(Object.keys(THETA_DECISION_OWNERS).sort()).toEqual([...THETA_KEYS].sort());
    for (const key of THETA_KEYS) {
      const owners = THETA_DECISION_OWNERS[key];
      expect(owners.length).toBeGreaterThan(0);
      const hasLiveRead = owners.some((relativePath) =>
        readFileSync(resolve(SRC_ROOT, relativePath), "utf8")
          .includes(`policy().${key}`),
      );
      expect(hasLiveRead, `${key} has no policy().${key} decision read`).toBe(true);
    }
  });

  test("candidate policy cannot tune rollout governance", () => {
    for (const key of GOVERNANCE_KEYS) {
      expect(THETA_KEYS).not.toContain(key as never);
    }
  });
});
