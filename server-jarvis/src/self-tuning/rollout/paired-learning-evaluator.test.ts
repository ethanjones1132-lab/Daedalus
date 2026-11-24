import { describe, expect, test } from "bun:test";
import type { CallModelFn } from "../../orchestration/coordinator";
import { BASELINE_THETA } from "../../orchestration/orchestration-policy";
import type { FixtureTask } from "./fixture-tasks";
import type {
  FrozenLearningEvalManifest,
  LearningEvalHeldOutTask,
} from "./learning-eval-types";
import { outcomeRowFromRollout } from "./paired-learning-evaluator";
import { phase3PrimaryAccepted } from "./learning-eval-report";
import { runOneRollout, type RolloutOutcome } from "./rollout-runner";

/**
 * DD-016: a write-required rollout can land a target-path write whose real
 * before/after fingerprints credit it in `creditedWritePaths`, while B2 forces
 * the score to zero because the independent check was declined. That hard zero
 * is a check-policy verdict, not missing write evidence, so the evaluator must
 * still report the target write as verified. An honest zero-write turn keeps
 * reporting false because `creditedWritePaths` stays empty.
 *
 * Fixtures + a scripted model only: no live model, no network.
 */

const task: FixtureTask = {
  name: "dd016_write_credit",
  category: "A",
  entry: "solution.py",
  files: {
    "solution.py": "def double(x):\n    return x\n",
  },
  spec: "Return twice the input.",
  test: "from solution import double\nassert double(2) == 4\nprint('OK')\n",
};

const manifest = {
  campaignId: "dd016-write-credit",
  manifestHash: "sha256:dd016",
} as unknown as FrozenLearningEvalManifest;

const fixture: LearningEvalHeldOutTask = {
  name: task.name,
  fixtureDigest: "sha256:dd016-fixture",
};

/** Scripted executor that writes a real, content-changing target fix. */
function fixingModel(): CallModelFn {
  let wrote = false;
  return async (_messages, options) => {
    if (options?.stageLabel === "executor" && !wrote) {
      wrote = true;
      return {
        content: "applying the fix",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: task.entry,
                content: "def double(x):\n    return x * 2\n",
              }),
            },
          } as never,
        ],
      };
    }
    return { content: "done" };
  };
}

function declinedCheck(outcome: RolloutOutcome): RolloutOutcome {
  // Same measured breakdown, but the smoke's separate condition: a
  // write-required turn whose independent check is declined (B2 hard zero).
  return {
    ...outcome,
    reward: 0,
    gradedCheck: undefined,
    breakdown: {
      ...outcome.breakdown,
      score: 0,
      baseScore: 0,
      // The write remains measured; only the independent check is absent.
      terms: { ...outcome.breakdown.terms, check: 0 },
      hardZero: true,
      hardZeroReason:
        "B2: write-required turn with declined/missing check — score forced to 0 (check_tier none must not be profitable)",
    },
  };
}

describe("outcomeRowFromRollout write credit", () => {
  test("keeps a fingerprint-verified target write credited through a B2 hard zero", async () => {
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 0 },
      fixingModel(),
    );

    // The write is credited from real before/after content fingerprints.
    expect(outcome.breakdown.terms.writes).toBe(1);
    expect(outcome.breakdown.creditedWritePaths.length).toBe(1);
    expect(outcome.breakdown.creditedWritePaths[0]).toContain(task.entry);

    const row = outcomeRowFromRollout(manifest, fixture, 0, "baseline", declinedCheck(outcome));

    expect(row.reward).toBe(0);
    expect(row.rewardHardZero).toBe(true);
    expect(row.creditedWritePaths).toEqual(outcome.breakdown.creditedWritePaths);
    // Regression: master cleared this because hardZero was true.
    expect(row.verifiedTargetWrite).toBe(true);
    // Acceptance impact: missing oracle + verified write is inconclusive, not
    // a measured failure. This keeps the honest zero in the denominator
    // without counting the row as a rejected run.
    expect(phase3PrimaryAccepted(row)).toBeNull();
  });

  test("an honest zero-write hard zero stays uncredited", async () => {
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 1 },
      async () => ({ content: "I have considered it." }),
    );

    expect(outcome.breakdown.creditedWritePaths).toEqual([]);

    const row = outcomeRowFromRollout(manifest, fixture, 1, "baseline", declinedCheck(outcome));

    expect(row.reward).toBe(0);
    expect(row.rewardHardZero).toBe(true);
    expect(row.creditedWritePaths).toEqual([]);
    expect(row.verifiedTargetWrite).toBe(false);
  });
});
