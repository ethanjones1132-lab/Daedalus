import type { CallModelFn } from "../../orchestration/coordinator";
import type { OrchestrationTheta } from "../../orchestration/orchestration-policy";
import type { FixtureTask } from "./fixture-tasks";
import { runOneRollout, type RolloutOutcome } from "./rollout-runner";

/**
 * Bounded-concurrency fan-out over (candidate θ, fixture) pairs.
 *
 * Bounded, not `Promise.all` over everything: a local Ollama daemon serializes
 * on the GPU regardless of how many callers queue up, so unbounded fan-out
 * converts into queueing latency and memory pressure without buying real
 * parallelism. `AsyncLocalStorage` isolates each rollout's θ and local-only
 * scope per async context, so concurrency is safe — the cap is purely about
 * not overwhelming the daemon.
 *
 * The right cap is empirical (GPU, model size, VRAM), not derivable from
 * source. DEFAULT_ROLLOUT_CONCURRENCY is a conservative starting point to be
 * measured and adjusted, not a tuned constant.
 */
export const DEFAULT_ROLLOUT_CONCURRENCY = 4;

export interface RolloutCandidate {
  theta: Partial<OrchestrationTheta>;
  seed: number;
}

export interface RolloutBatchOptions {
  concurrency?: number;
  /** Invoked as each rollout settles — for progress reporting on long campaigns. */
  onProgress?: (done: number, total: number) => void;
}

interface Job {
  candidateIndex: number;
  taskIndex: number;
}

/**
 * Evaluate every candidate against every task.
 *
 * Returns a candidate-major matrix: `result[i][j]` is candidate `i`'s outcome
 * on `tasks[j]`, with positions preserved so a caller can average per
 * candidate without tracking completion order.
 */
export async function runRolloutBatch(
  candidates: readonly RolloutCandidate[],
  tasks: readonly FixtureTask[],
  callModel: CallModelFn,
  options: RolloutBatchOptions = {},
): Promise<RolloutOutcome[][]> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_ROLLOUT_CONCURRENCY);
  const results: RolloutOutcome[][] = candidates.map(() => new Array(tasks.length));

  const jobs: Job[] = [];
  for (let c = 0; c < candidates.length; c++) {
    for (let t = 0; t < tasks.length; t++) jobs.push({ candidateIndex: c, taskIndex: t });
  }

  let nextJob = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextJob++;
      if (index >= jobs.length) return;
      const job = jobs[index]!;
      const candidate = candidates[job.candidateIndex]!;
      const task = tasks[job.taskIndex]!;
      // Per-task seed: candidate.seed is the CRN generation (or held-out) base;
      // taskIndex differentiates tasks so the same base does not collapse every
      // fixture onto one sampler path. Formula is load-bearing for
      // reproducibility — do not change without regenerating seed documentation.
      const taskSeed = candidate.seed * 1000 + job.taskIndex;
      // runOneRollout never rejects — it scores failures instead — so one bad
      // candidate cannot abort a whole generation's evaluation.
      results[job.candidateIndex]![job.taskIndex] = await runOneRollout(
        { theta: candidate.theta, task, seed: taskSeed },
        callModel,
      );
      options.onProgress?.(++completed, jobs.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  return results;
}

/** Mean reward across one candidate's task outcomes — the CMA-ES fitness scalar. */
export function meanReward(outcomes: readonly RolloutOutcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.reduce((sum, o) => sum + o.reward, 0) / outcomes.length;
}
