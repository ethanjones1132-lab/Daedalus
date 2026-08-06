import { describe, expect, test } from "bun:test";
import { BASELINE_THETA } from "../../orchestration/orchestration-policy";
import type { CallModelFn } from "../../orchestration/coordinator";
import { TRAINING_TASKS } from "./fixture-tasks";
import { runOneRollout } from "./rollout-runner";

/**
 * These use a scripted CallModelFn rather than a live model: the point is to
 * prove the rollout PLUMBING (θ scoping, workspace seeding, write-effect
 * capture, reward computation, cleanup), which must hold regardless of which
 * model runs. A live-Ollama smoke test is a separate, slower check.
 */

const task = TRAINING_TASKS.find((t) => t.name === "merge_intervals")!;

/** Model that edits the entry file with a correct fix. */
const fixingModel: CallModelFn = async (_messages, options) => {
  if (options?.stageLabel === "executor") {
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
              content:
                "def merge_intervals(intervals):\n" +
                "    if not intervals:\n" +
                "        return []\n" +
                "    ordered = sorted(intervals)\n" +
                "    merged = [ordered[0]]\n" +
                "    for start, end in ordered[1:]:\n" +
                "        last_start, last_end = merged[-1]\n" +
                "        if start <= last_end:\n" +
                "            merged[-1] = (last_start, max(last_end, end))\n" +
                "        else:\n" +
                "            merged.append((start, end))\n" +
                "    return merged\n",
            }),
          },
        } as never,
      ],
    };
  }
  return { content: "done" };
};

/** Model that never calls a tool — the no-write case. */
const inertModel: CallModelFn = async () => ({ content: "I have considered it." });

describe("runOneRollout", () => {
  test("refuses to run without the NODE_ENV=test DB guard", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        runOneRollout({ theta: BASELINE_THETA, task, seed: 1 }, inertModel),
      ).rejects.toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  test("a no-write rollout scores zero rather than crashing", async () => {
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 1 },
      inertModel,
    );
    expect(outcome.task).toBe(task.name);
    expect(outcome.reward).toBeLessThanOrEqual(0);
    expect(outcome.breakdown.creditedWritePaths).toEqual([]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a rollout that lands a real write credits the entry path", async () => {
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 2 },
      fixingModel,
    );
    // The write must be credited via real before/after content fingerprints,
    // not tool-call success — a no-op edit would earn nothing here.
    expect(
      outcome.breakdown.creditedWritePaths.some((p) => p.includes(task.entry)),
      `expected ${task.entry} in credited paths, got ${JSON.stringify(outcome.breakdown.creditedWritePaths)}`,
    ).toBe(true);
    expect(outcome.breakdown.terms.writes).toBeGreaterThan(0);
  });

  test("a model that throws yields a scored non-positive outcome, not a crash", async () => {
    // The pipeline absorbs model transport failures itself and returns a
    // `failed` result, so this lands on the normal reward path (B2 hard-zero:
    // write-required turn, nothing written, no passing check) rather than the
    // runner's own catch. Either way the campaign must keep running and the
    // candidate must not be rewarded — that is what this asserts.
    const explodingModel: CallModelFn = async () => {
      throw new Error("simulated model transport failure");
    };
    const outcome = await runOneRollout(
      { theta: BASELINE_THETA, task, seed: 3 },
      explodingModel,
    );
    expect(outcome.reward).toBeLessThanOrEqual(0);
    expect(outcome.breakdown.creditedWritePaths).toEqual([]);
    expect(outcome.task).toBe(task.name);
  });
});
