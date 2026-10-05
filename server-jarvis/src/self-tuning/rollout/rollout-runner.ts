import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { registerFilesystemBundle } from "../../filesystem-bundle";
import { createToolRuntime, makeExecutionContext } from "../../tool-runtime";
import { defaultConfig } from "../../config";
import { runRolloutLocalOnly } from "../../orchestration/agent-pool";
import { runWithTheta } from "../../orchestration/orchestration-policy";
import { PipelineExecutor } from "../../orchestration/pipeline";
import type { PipelineOutcome, StageRunRecorder } from "../../orchestration/pipeline";
import { computeRunRewardFromEffects } from "../../orchestration/run-reward";
import type { OrchestrationTheta } from "../../orchestration/orchestration-policy";
import type { CallModelFn, TaskType } from "../../orchestration/coordinator";
import type { RunRewardBreakdown } from "../../orchestration/run-reward";
import type { SkillCandidate } from "../../intelligence/skill-types";
import { resolveSkillsForTurn } from "../../intelligence/skill-resolver";
import type { StageRun } from "../store";
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

/**
 * Stable identity for one rollout. Exported so the paired learning evaluator
 * can bind a frozen training trajectory / arm identity to the exact run id the
 * pipeline records, without re-deriving the string in two places.
 */
export function rolloutRunId(taskName: string, seed: number): string {
  return `rollout-${taskName}-${seed}`;
}

/**
 * Evaluation-only, non-persistent skill override.
 *
 * Supplied by the paired learning evaluator from a frozen manifest. It is
 * routed through the production resolver (`resolveSkillsForTurn`) so trigger
 * matching, ordering, rendering, and the 1,200-token cap are identical to a
 * promoted skill. It is never written to the user Skill store and never
 * promoted. `bodyDigest` is the frozen `sha256:<hex>` of `skill.body`; a
 * mismatch is a hard failure raised before any model call.
 */
export interface RolloutSkillOverride {
  arm: "candidate" | "neutral";
  skill: SkillCandidate;
  bodyDigest: string;
  taskType: TaskType;
}

/** What the executor actually applied, recorded for arm attribution. */
export interface AppliedRolloutSkill {
  arm: "candidate" | "neutral";
  id: string;
  bodyDigest: string;
  /** False when the frozen trigger did not match this task's turn. */
  matched: boolean;
  promptTokens: number;
}

/**
 * Frozen sampler values forced onto every model call in a rollout. `temperature`
 * and `num_predict` overwrite whatever the pipeline stage requested; `top_p` and
 * `num_ctx` are pinned by the caller's local call model (which must be built
 * from the same frozen manifest).
 */
export interface RolloutSamplerSpec {
  temperature: number;
  top_p: number;
  num_ctx: number;
  num_predict: number;
}

/**
 * Frozen deadlines for a rollout. Both are enforced with real `AbortController`
 * aborts — never a detached `Promise.race` — so in-flight HTTP/model work is
 * cancelled when either deadline fires.
 */
export interface RolloutBudgetSpec {
  modelCallTimeoutMs: number;
  rolloutTimeoutMs: number;
}

function combineAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return { signal: controller.signal, dispose: () => {} };
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

/**
 * Bounded runtime observations for one rollout. Every unmeasurable value is
 * explicit: numbers are `null` with a reason rather than inferred.
 */
export interface RolloutTelemetry {
  /** Model calls issued during this rollout. */
  modelCalls: number;
  /** Executor tool calls whose record was an error. */
  toolErrors: number;
  tokenInput: number | null;
  tokenOutput: number | null;
  tokenMissingReason: string | null;
  timeout: boolean;
  cancelled: boolean;
  /** Sum of captured stage durations, when stage capture was requested. */
  stageDurationMs: number | null;
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
  /** Optional evaluation-only skill override. Omitted for the baseline arm. */
  skillOverride?: RolloutSkillOverride;
  /**
   * When true, capture stage_runs in-memory and return them on the outcome for
   * training-evidence distillation. Never persisted. Default false keeps the
   * high-volume CMA-ES path allocation-free.
   */
  captureStageRuns?: boolean;
  /** When set, force these sampler values onto every model call. */
  sampler?: RolloutSamplerSpec;
  /** When set, enforce a per-model-call deadline and a total rollout cap. */
  budgets?: RolloutBudgetSpec;
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
  /** Terminal truthful pipeline outcome, when the executor returned one. */
  runOutcome?: PipelineOutcome;
  /** Exact authentic graded-fixture oracle result, when one was available. */
  gradedCheck?: {
    tier: string;
    ran: boolean;
    passed: boolean | null;
    detail: string;
    durationMs: number;
    declinedReason?: string;
  };
  /** Bounded runtime observations; absent only for pre-run failures. */
  telemetry?: RolloutTelemetry;
  /** Which frozen evaluation skill was applied, when an override was given. */
  appliedSkill?: AppliedRolloutSkill;
  /** Captured stage evidence, only when `captureStageRuns` was true. */
  stageRuns?: StageRun[];
}

function skillBodyDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

/**
 * Defense-in-depth digest guard. The evaluator checks this too, but a mismatch
 * must never reach a model call even if a caller forgets. Throws — deliberately
 * outside `runOneRollout`'s catch, so a mutated manifest cannot be silently
 * recorded as a failed arm.
 */
export function assertRolloutSkillOverride(override: RolloutSkillOverride): void {
  const actual = skillBodyDigest(override.skill.body);
  if (actual !== override.bodyDigest) {
    throw new Error(
      `rollout skill override digest mismatch for arm=${override.arm} ` +
        `id=${override.skill.id}: expected ${override.bodyDigest}, got ${actual}`,
    );
  }
}

class CapturingStageRunRecorder implements StageRunRecorder {
  readonly stageRuns: StageRun[] = [];
  recordStageRun(stage: StageRun): void {
    this.stageRuns.push(stage);
  }
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
  // Validate the injected override before any workspace/model work so a mutated
  // manifest can never turn into a model call. Throws outside the try below.
  if (spec.skillOverride) assertRolloutSkillOverride(spec.skillOverride);
  const startedAt = Date.now();
  const workspace = seedFixtureWorkspace(spec.task);
  const recorder: StageRunRecorder = spec.captureStageRuns
    ? new CapturingStageRunRecorder()
    : noopRecorder;
  let modelCalls = 0;
  // Total rollout cap. A real abort (not a detached race) so an in-flight model
  // call is cancelled and the pipeline observes `turnAbort`.
  const rolloutController = spec.budgets ? new AbortController() : undefined;
  const rolloutTimer =
    spec.budgets && rolloutController
      ? setTimeout(
          () => rolloutController.abort(new Error(`rollout deadline exceeded (${spec.budgets!.rolloutTimeoutMs}ms)`)),
          spec.budgets.rolloutTimeoutMs,
        )
      : undefined;

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

    // Pin sampler seed (CRN / paired held-out), force the frozen sampler, and
    // enforce both deadlines with real aborts. Every arm goes through this same
    // wrapper, so temperature/top_p/num_ctx/num_predict and timeouts are
    // identical across baseline/candidate/neutral.
    const seededCallModel: CallModelFn = (messages, opts) => {
      modelCalls += 1;
      const signals: Array<AbortSignal | undefined> = [opts?.stageAbort, rolloutController?.signal];
      let callTimer: ReturnType<typeof setTimeout> | undefined;
      if (spec.budgets) {
        const callController = new AbortController();
        callTimer = setTimeout(
          () => callController.abort(new Error(`model-call deadline exceeded (${spec.budgets!.modelCallTimeoutMs}ms)`)),
          spec.budgets.modelCallTimeoutMs,
        );
        signals.push(callController.signal);
      }
      const hasSignal = signals.some((signal) => signal !== undefined);
      const combined = hasSignal ? combineAbortSignals(signals) : undefined;
      const forced = spec.sampler
        ? { temperature: spec.sampler.temperature, max_tokens: spec.sampler.num_predict }
        : {};
      return callModel(messages, {
        ...opts,
        seed: spec.seed,
        ...forced,
        ...(combined ? { stageAbort: combined.signal } : {}),
      }).finally(() => {
        if (callTimer !== undefined) clearTimeout(callTimer);
        combined?.dispose();
      });
    };

    const executor = new PipelineExecutor(
      seededCallModel,
      buildRolloutRuntime(),
      ctx,
      recorder,
    );

    const request = buildFixtureRolloutRequest(spec.task);

    // Evaluation-only skill injection flows through the production resolver so
    // trigger matching, ordering, rendering, and the token cap match promoted
    // skills exactly. The task text and oracle are never touched.
    let distilledSkillsBlock: string | undefined;
    let appliedSkill: AppliedRolloutSkill | undefined;
    if (spec.skillOverride) {
      const resolved = resolveSkillsForTurn(request, spec.skillOverride.taskType, {
        injectedSkill: spec.skillOverride.skill,
      });
      distilledSkillsBlock = resolved.promptBlock || undefined;
      appliedSkill = {
        arm: spec.skillOverride.arm,
        id: spec.skillOverride.skill.id,
        bodyDigest: spec.skillOverride.bodyDigest,
        matched: resolved.matched.some((c) => c.id === spec.skillOverride!.skill.id),
        promptTokens: resolved.promptTokens,
      };
    }

    // Both ALS scopes wrap the whole execution: θ selects the candidate policy,
    // local-only pins every stage to Ollama. Nested rather than combined
    // because they are independent concerns owned by different modules.
    const result = await runWithTheta(spec.theta, () =>
      runRolloutLocalOnly(() =>
        executor.execute(
          request,
          ["planner", "executor", "reviewer", "synthesizer"],
          rolloutRunId(spec.task.name, spec.seed),
          () => {},
          {
            executionProfile: "full",
            rawMessage: request,
            taskRunWriteIntent: true,
            turnRequirement: "full_execution",
            workspaceRoot: workspace,
            distilledSkillsBlock,
            ...(rolloutController ? { turnAbort: rolloutController.signal } : {}),
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

    const capturedStages = spec.captureStageRuns
      ? (recorder as CapturingStageRunRecorder).stageRuns
      : undefined;
    const toolErrors = (result.toolCalls ?? []).filter((call) => call.is_error).length;
    const cancelled =
      result.cancelled === true ||
      (capturedStages?.some((stage) => stage.stop_reason === "cancelled") ?? false);
    const timeout =
      (capturedStages?.some(
        (stage) => typeof stage.stop_reason === "string" && /deadline|timeout|watchdog/.test(stage.stop_reason),
      ) ?? false) ||
      /timeout|deadline|stalled/i.test(result.error ?? "");
    const stageDurationMs = capturedStages
      ? capturedStages.reduce(
          (sum, stage) => sum + (typeof stage.duration_ms === "number" ? stage.duration_ms : 0),
          0,
        )
      : null;

    return {
      task: spec.task.name,
      reward: breakdown.score,
      breakdown,
      durationMs: Date.now() - startedAt,
      runOutcome: result.outcome,
      gradedCheck: gradedCheck
        ? {
            tier: gradedCheck.tier,
            ran: gradedCheck.ran,
            passed: gradedCheck.passed,
            detail: gradedCheck.detail,
            durationMs: gradedCheck.durationMs,
            ...(gradedCheck.declinedReason ? { declinedReason: gradedCheck.declinedReason } : {}),
          }
        : undefined,
      telemetry: {
        modelCalls,
        toolErrors,
        tokenInput: null,
        tokenOutput: null,
        tokenMissingReason:
          "CallModelFn does not expose per-call token counts; Ollama prompt_eval_count/eval_count are not surfaced to the rollout runner",
        timeout,
        cancelled,
        stageDurationMs,
      },
      appliedSkill,
      ...(capturedStages ? { stageRuns: capturedStages } : {}),
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
    if (rolloutTimer !== undefined) clearTimeout(rolloutTimer);
    rmSync(workspace, { recursive: true, force: true });
  }
}
