import { rmSync } from "fs";
import { registerFilesystemBundle } from "../../filesystem-bundle";
import { registerMetaBundle } from "../../meta-bundle";
import { registerShellBundle } from "../../shell-bundle";
import { registerTaskBundle } from "../../task-bundle";
import { createToolRuntime, makeExecutionContext } from "../../tool-runtime";
import { defaultConfig } from "../../config";
import { runRolloutLocalOnly } from "../../orchestration/agent-pool";
import { runWithTheta } from "../../orchestration/orchestration-policy";
import { PipelineExecutor } from "../../orchestration/pipeline";
import { computeRunRewardFromEffects } from "../../orchestration/run-reward";
import type { OrchestrationTheta } from "../../orchestration/orchestration-policy";
import type { CallModelFn } from "../../orchestration/coordinator";
import type { RunRewardBreakdown } from "../../orchestration/run-reward";
import { noopRecorder } from "./noop-recorder";
import { seedFixtureWorkspace, type FixtureTask } from "./fixture-tasks";

/**
 * One (θ candidate, fixture) evaluation, in-process.
 *
 * Deliberately does NOT go through the tier-2B HTTP harness. A CMA-ES campaign
 * needs thousands of these, and driving them through a live `/chat/stream`
 * server means either serializing on one process or racing many servers for
 * one port — the exact failure class (EADDRINUSE, ghost sockets, mid-turn
 * kills) this codebase spent 2026-08-05/06 fixing. In-process invocation has
 * no port, no supervisor, and no shared HTTP state.
 */

export interface RolloutSpec {
  theta: Partial<OrchestrationTheta>;
  task: FixtureTask;
  /** Reserved for future seeded sampling; recorded on the outcome. */
  seed: number;
}

export interface RolloutOutcome {
  task: string;
  /** RunRewardBreakdown.score — the scalar CMA-ES optimizes. */
  reward: number;
  breakdown: RunRewardBreakdown;
  /** Wall-clock for the whole rollout; fitness tie-break input, not a term. */
  durationMs: number;
  /** Set when the pipeline threw rather than returning a scored result. */
  error?: string;
}

/**
 * Guard 2 of 2 against polluting the production evidence store.
 *
 * `noopRecorder` covers the collector a rollout wires explicitly. It cannot
 * cover module-singleton stores constructed lazily deep in the call graph —
 * e.g. `delegate-model-select.ts`'s `scoreboardStore = new SelfTuningStore()`,
 * built the first time the delegate path fires. `SelfTuningStore.getDb()`
 * routes any store with no explicit path override to an in-memory DB when
 * NODE_ENV === "test". That guard exists because of a real 2026-07-13 incident
 * where test runs wrote sentinel rows into the production self-tuning.db and
 * skewed every aggregate built on it; rollouts are the same hazard at far
 * higher volume.
 */
function assertRolloutDbSafety(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Phase-D rollouts require NODE_ENV=test so lazily-constructed " +
        "SelfTuningStore singletons resolve to an in-memory DB instead of the " +
        "production self-tuning.db. Refusing to run.",
    );
  }
}

/** Tool surface a rollout is allowed. */
function buildRolloutRuntime() {
  const runtime = createToolRuntime();
  // Narrower than registerStandardBundles ON PURPOSE: no web bundle, no MCP
  // client, no interactive bundle. A fixture rollout must not make outbound
  // network calls or open side channels — it is a hermetic code-edit task, and
  // anything reaching the network would make scores irreproducible.
  registerFilesystemBundle(runtime);
  registerShellBundle(runtime);
  registerTaskBundle(runtime);
  registerMetaBundle(runtime);
  return runtime;
}

export async function runOneRollout(
  spec: RolloutSpec,
  callModel: CallModelFn,
): Promise<RolloutOutcome> {
  assertRolloutDbSafety();
  const startedAt = Date.now();
  const workspace = seedFixtureWorkspace(spec.task);

  try {
    const config = defaultConfig();
    config.jarvis_path = workspace;
    config.tools.enabled = true;
    // Strict sandbox: writes are confined to allowed roots, which resolve from
    // workspace_path (the throwaway temp dir). A rollout must not be able to
    // touch anything outside its own fixture workspace.
    config.tools.sandbox_mode = "strict";
    // The delegate spawns a real Claude CLI subprocess — never inside a rollout.
    config.claude_cli.delegate.enabled = false;
    config.orchestrator.verification.enabled = true;

    const ctx = makeExecutionContext("chat", config, {
      workspace_path: workspace,
      requestApproval: async () => true,
    });

    const executor = new PipelineExecutor(
      callModel,
      buildRolloutRuntime(),
      ctx,
      noopRecorder,
    );

    const request = `${spec.task.spec}\n\nEdit ${spec.task.entry} in the workspace to fix this.`;

    // Both ALS scopes wrap the whole execution: θ selects the candidate policy,
    // local-only pins every stage to Ollama. Nested rather than combined
    // because they are independent concerns owned by different modules.
    const result = await runWithTheta(spec.theta, () =>
      runRolloutLocalOnly(() =>
        executor.execute(
          request,
          ["planner", "executor", "reviewer", "synthesizer"],
          `rollout-${spec.task.name}-${spec.seed}`,
          () => {},
          {
            executionProfile: "full",
            rawMessage: request,
            taskRunWriteIntent: true,
            turnRequirement: "full_execution",
          },
        ),
      ),
    );

    const breakdown = computeRunRewardFromEffects({
      effects: result.writeEffects ?? [],
      check: result.checkResult ?? null,
      targetPaths: [spec.task.entry],
      // Every fixture is a code-fix task, so a rollout that lands no verified
      // content change must score zero rather than coast on a clean check.
      writeRequired: true,
      declaredOutcome: result.outcome ?? null,
    });

    return {
      task: spec.task.name,
      reward: breakdown.score,
      breakdown,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // A crashed rollout is a real signal about the candidate (e.g. a θ that
    // starves a stage budget), not an error to propagate — surface it as the
    // worst possible score so CMA-ES selects away from it, and keep the
    // campaign running.
    const message = error instanceof Error ? error.message : String(error);
    return {
      task: spec.task.name,
      reward: -1,
      breakdown: {
        score: -1,
        baseScore: 0,
        terms: { writes: 0, check: 0, plan: 0 },
        weights: { writes: 0, check: 0, plan: 0 },
        creditedWritePaths: [],
        notes: [`rollout threw: ${message}`],
        hardZero: true,
        hardZeroReason: "rollout_error",
        overclaim: false,
        overclaimPenalty: 0,
      },
      durationMs: Date.now() - startedAt,
      error: message,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
