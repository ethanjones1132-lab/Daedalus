import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { registerFilesystemBundle } from "../../filesystem-bundle";
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
import { runPythonTarget } from "../../orchestration/run-gate";
import type { CheckResult } from "../../orchestration/check-runner";

/**
 * Graded-test name seeded by `seedFixtureWorkspace`. Kept in sync there.
 */
const GRADED_TEST_FILE = "_t.py";

/**
 * Bounded because the fixture suite's entire purpose is handing models buggy
 * code to fix, so non-terminating submissions are expected output rather than
 * an edge case — one unbounded child stalled a full campaign for 65 minutes.
 */
export const GRADED_CHECK_TIMEOUT_MS = 15_000;

export interface GradedFixtureCheckOptions {
  timeoutMs?: number;
  /**
   * Canonical graded-test source from the fixture definition. When provided,
   * overwrites `_t.py` immediately before execution so agent edits or deletes
   * cannot game the oracle. Phase-D production rollouts must always supply
   * this — CMA-ES optimizes the graded-check scalar and would otherwise farm
   * reward by neutering the test (empty fix → 0.5, wrong fix → 1.0).
   */
  authenticTest?: string;
}

/**
 * Run the fixture's graded test directly and report it as an independent check.
 *
 * Scoring must not depend on whether the PIPELINE happened to verify. The
 * pipeline only runs verification on its executor-completion path, so a run
 * that ended via a repair-cap or degraded route produced no CheckResult at
 * all — and B2 then forced a hard zero on a write-required turn even when the
 * fix was correct. That conflated "the code is wrong" with "nobody looked",
 * which is both a large chunk of held-out variance and a false signal to the
 * optimizer.
 *
 * When `authenticTest` is supplied, any on-disk tampering of `_t.py` is
 * erased first — the fixture definition is the sole ground truth, not whatever
 * the model left in the workspace.
 *
 * Tier is `existing`: the graded test ships with the fixture and is not
 * authored by the runtime, so it is a genuinely independent oracle.
 * Returns null when no graded test is available (no authentic source and no
 * on-disk file), leaving the caller to fall back to the pipeline result.
 */
export async function runGradedFixtureCheck(
  workspace: string,
  options: GradedFixtureCheckOptions = {},
): Promise<CheckResult | null> {
  const timeoutMs = options.timeoutMs ?? GRADED_CHECK_TIMEOUT_MS;
  const target = join(workspace, GRADED_TEST_FILE);

  // Re-seed from the fixture definition before every check. Models can edit or
  // delete `_t.py` during the rollout; without this, scoring trusts whatever
  // is on disk and CMA-ES can reward oracle sabotage.
  if (options.authenticTest !== undefined) {
    writeFileSync(target, options.authenticTest, "utf8");
  }

  if (!existsSync(target)) return null;

  const startedAt = Date.now();
  const run = await runPythonTarget(target, workspace, timeoutMs);
  const durationMs = Date.now() - startedAt;

  if (run.status === "skipped") {
    // Interpreter missing or an ambiguous exit — report honestly as "did not
    // run" rather than inventing a pass or a failure.
    return {
      tier: "none",
      ran: false,
      passed: null,
      detail: "",
      command: `run:${target}`,
      durationMs,
      declinedReason: run.reason ?? "graded test could not be run",
    };
  }

  const passed = run.status === "passed";
  return {
    tier: "existing",
    ran: true,
    passed,
    detail: passed ? "" : run.issues.map((i) => i.error).join("\n").slice(0, 400),
    command: `run:${target}`,
    durationMs,
  };
}
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

/**
 * Build the user-facing request for a fixture rollout.
 *
 * The graded oracle is always seeded at `_t.py`. Naming it here is load-bearing:
 * the multi-model sweep found that ~25/30 non-passing outcomes never closed an
 * execution feedback loop (silent quit or confident lie). Executor stage text
 * already says "run the relevant test named in the request" — without naming
 * it, that instruction is inert. This deliberately shifts the harness from
 * blind-fix toward test-driven-fix for Phase-D scoring.
 */
export function buildFixtureRolloutRequest(task: FixtureTask): string {
  return (
    `${task.spec}\n\n` +
    `Edit ${task.entry} in the workspace to fix this.\n\n` +
    `A graded test is already present at \`${GRADED_TEST_FILE}\` in the workspace root. ` +
    `After editing, run it (for example: \`python ${GRADED_TEST_FILE}\`) and read its real output ` +
    `before declaring success. Do not edit or delete \`${GRADED_TEST_FILE}\` — it is the scoring oracle.`
  );
}

export interface RolloutSpec {
  theta: Partial<OrchestrationTheta>;
  task: FixtureTask;
  /**
   * Sampler seed injected into every model call for this rollout (Ollama
   * `options.seed`). Same (θ, task, seed) should yield a deterministic sample
   * path when the daemon honors seed — foundation for CRN fitness and paired
   * held-out verdicts.
   */
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
export function buildRolloutRuntime() {
  const runtime = createToolRuntime();
  // Narrower than registerStandardBundles ON PURPOSE: no shell, task, meta,
  // web, MCP, or interactive bundles. A fixture rollout must not make outbound
  // network calls or open side channels — it is a hermetic code-edit task, and
  // anything reaching the network would make scores irreproducible.
  registerFilesystemBundle(runtime);
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

    // Pin sampler seed on every model call for this rollout (CRN / paired held-out).
    const seededCallModel: CallModelFn = (messages, opts) =>
      callModel(messages, { ...opts, seed: spec.seed });

    const executor = new PipelineExecutor(
      seededCallModel,
      buildRolloutRuntime(),
      ctx,
      noopRecorder,
    );

    const request = buildFixtureRolloutRequest(spec.task);

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
            workspaceRoot: workspace,
          },
        ),
      ),
    );

    // Category B fixtures seed the bug in hiddenFile behind a thin entry
    // wrapper (the realistic, often-correct fix lands there, not in entry) —
    // targetPaths must include it or a genuine fix scores zero on writes and
    // CMA-ES learns to avoid touching hidden files.
    const targetPaths = spec.task.hiddenFile
      ? [spec.task.entry, spec.task.hiddenFile]
      : [spec.task.entry];

    // The fixture's own graded test is the ground truth and is consulted
    // unconditionally; the pipeline's opportunistic check is only a fallback
    // for a fixture that seeded no test. Scoring on `result.checkResult`
    // alone made the reward depend on which internal route the run happened
    // to terminate through, so a correct fix could score a hard zero purely
    // because nothing ran the test.
    //
    // authenticTest re-seeds `_t.py` from the fixture definition so a model
    // cannot game the oracle by neutering or deleting the graded test.
    const gradedCheck = await runGradedFixtureCheck(workspace, {
      authenticTest: spec.task.test,
    });
    const breakdown = computeRunRewardFromEffects({
      effects: result.writeEffects ?? [],
      check: gradedCheck ?? result.checkResult ?? null,
      targetPaths,
      workspaceRoot: workspace,
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
