import { describe, expect, test } from "bun:test";
import { BASELINE_THETA } from "../../orchestration/orchestration-policy";
import type { CallModelFn } from "../../orchestration/coordinator";
import { TRAINING_TASKS } from "./fixture-tasks";
import { meanReward, runRolloutBatch } from "./rollout-pool";
import type { RolloutOutcome } from "./rollout-runner";

const inertModel: CallModelFn = async () => ({ content: "no tools." });

describe("runRolloutBatch", () => {
  const tasks = TRAINING_TASKS.slice(0, 2);
  const candidates = [
    { theta: BASELINE_THETA, seed: 1 },
    { theta: { ...BASELINE_THETA, max_directives_per_turn: 12 }, seed: 2 },
  ];

  test("returns a candidate-major matrix with positions preserved", async () => {
    const results = await runRolloutBatch(candidates, tasks, inertModel, {
      concurrency: 2,
    });
    expect(results.length).toBe(candidates.length);
    for (const row of results) {
      expect(row.length).toBe(tasks.length);
      // Position must match the task order, not completion order.
      row.forEach((outcome, j) => expect(outcome.task).toBe(tasks[j]!.name));
    }
  });

  test("reports progress for every job exactly once", async () => {
    const seen: number[] = [];
    await runRolloutBatch(candidates, tasks, inertModel, {
      concurrency: 3,
      onProgress: (done, total) => {
        expect(total).toBe(candidates.length * tasks.length);
        seen.push(done);
      },
    });
    expect(seen.length).toBe(candidates.length * tasks.length);
    // Monotonic and complete regardless of interleaving.
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: candidates.length * tasks.length }, (_, i) => i + 1),
    );
  });

  test("concurrency of 1 still evaluates everything", async () => {
    const results = await runRolloutBatch(candidates, tasks, inertModel, {
      concurrency: 1,
    });
    expect(results.flat().length).toBe(candidates.length * tasks.length);
  });

  test("handles an empty candidate list without hanging", async () => {
    expect(await runRolloutBatch([], tasks, inertModel)).toEqual([]);
  });

  test("derives distinct deterministic per-task seeds from candidate.seed", async () => {
    const seedsByTask: Record<string, number | undefined> = {};
    const spy: CallModelFn = async (_messages, options) => {
      // First model call of each rollout is enough to capture the injected seed.
      // We key by a stable id derived from... we don't have task name on options,
      // so collect all seeds seen and assert the expected multiset.
      const s = options?.seed;
      if (s !== undefined) {
        seedsByTask[String(s)] = (seedsByTask[String(s)] ?? 0) + 1;
      }
      return { content: "no tools." };
    };

    const base = 5;
    await runRolloutBatch(
      [{ theta: BASELINE_THETA, seed: base }],
      tasks,
      spy,
      { concurrency: 1 },
    );

    // taskIndex 0 → 5*1000+0 = 5000; taskIndex 1 → 5001
    const expected = tasks.map((_, t) => base * 1000 + t);
    for (const e of expected) {
      expect(seedsByTask[String(e)], `expected seed ${e}`).toBeGreaterThan(0);
    }
    // No bare candidate.seed (without per-task derivation).
    expect(seedsByTask[String(base)]).toBeUndefined();
  });
});

describe("meanReward", () => {
  const outcome = (reward: number): RolloutOutcome => ({
    task: "t",
    reward,
    breakdown: {
      score: reward,
      baseScore: 0,
      terms: { writes: 0, check: 0, plan: 0 },
      weights: { writes: 0, check: 0, plan: 0 },
      creditedWritePaths: [],
      notes: [],
      hardZero: false,
      overclaim: false,
      overclaimPenalty: 0,
    },
    durationMs: 0,
  });

  test("averages rewards", () => {
    expect(meanReward([outcome(1), outcome(0)])).toBe(0.5);
    expect(meanReward([outcome(-1), outcome(1)])).toBe(0);
  });

  test("empty input is zero, not NaN", () => {
    expect(meanReward([])).toBe(0);
  });
});
