// ═══════════════════════════════════════════════════════════════
// Phase-D campaign CLI: local Ollama rollouts + sep-CMA-ES
// ═══════════════════════════════════════════════════════════════
//
//   bun run campaign:preflight
//   bun run campaign:smoke
//   bun run campaign -- --generations 1 --tasks 3 --concurrency 1
//
// NODE_ENV=test is required before any rollout import path so
// SelfTuningStore singletons resolve to in-memory DBs (assertRolloutDbSafety).

// Guard must run before heavy imports that construct stores.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
if (process.env.NODE_ENV !== "test") {
  process.env.NODE_ENV = "test";
}

import { loadConfig, type JarvisConfig } from "../../config";
import { AgentPool, DEFAULT_LOCAL_STAGE_MODELS } from "../../orchestration/agent-pool";
import { BASELINE_THETA } from "../../orchestration/orchestration-policy";
import { routableOrchestratorAgents } from "../../provider-availability";
import { makeLocalCallModel, resolveLocalStageModels } from "../rollout/local-call-model";
import {
  LOCAL_CONTEXT_LENGTH_FLOOR,
  readOllamaLoadedContextLength,
  readOllamaVersion,
  resolveLocalTarget,
} from "../rollout/ollama-local-transport";
import { TRAINING_TASKS } from "../rollout/fixture-tasks";
import { runOneRollout } from "../rollout/rollout-runner";
import { DEFAULT_ROLLOUT_CONCURRENCY } from "../rollout/rollout-pool";
import {
  campaignFixtureSummary,
  proposeCampaignWinner,
  runCmaEsCampaign,
} from "./run-cma-es";
import { checkOllamaHealth } from "../../ollama";

function parseArgs(argv: string[]): {
  preflight: boolean;
  smoke: boolean;
  generations?: number;
  concurrency: number;
  tasks?: number;
  model?: string;
} {
  const out = {
    preflight: false,
    smoke: false,
    generations: undefined as number | undefined,
    concurrency: DEFAULT_ROLLOUT_CONCURRENCY,
    tasks: undefined as number | undefined,
    model: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--preflight") out.preflight = true;
    else if (a === "--smoke") out.smoke = true;
    else if (a === "--generations" || a === "-g") {
      out.generations = Number(argv[++i]);
    } else if (a === "--concurrency" || a === "-c") {
      out.concurrency = Math.max(1, Number(argv[++i]) || 1);
    } else if (a === "--tasks" || a === "-t") {
      out.tasks = Math.max(1, Number(argv[++i]) || 1);
    } else if (a === "--model" || a === "-m") {
      out.model = argv[++i];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

/**
 * Pin every rollout stage to one local model.
 *
 * Without this the pool resolves through `resolveLocalStageModels` (conductor
 * primary/fallback ∩ installed), which is the production routing choice — not
 * necessarily the model whose policy you want to optimize. A campaign's whole
 * output is θ tuned against ONE worker's behaviour, so the worker has to be an
 * explicit input, not an ambient config default.
 */
function callModelFor(cfg: JarvisConfig, model?: string) {
  return makeLocalCallModel(cfg, model ? { localModelsOverride: [model] } : {});
}

function printHelp(): void {
  console.log(`Phase-D local campaign CLI

Usage:
  bun run src/self-tuning/cma-es/campaign-cli.ts --preflight
  bun run src/self-tuning/cma-es/campaign-cli.ts --smoke
  bun run src/self-tuning/cma-es/campaign-cli.ts --generations N [--concurrency C] [--tasks N]

Options:
  --preflight     Ollama reachability, stage models, fixtures, context floor
  --smoke         One BASELINE_THETA × one training fixture, concurrency 1
  --generations N Run sep-CMA-ES for N generations (real campaign)
  --concurrency C Parallel rollouts (default ${DEFAULT_ROLLOUT_CONCURRENCY})
  --tasks N       Subset first N training fixtures (early-run budget control)
  --model ID      Pin every rollout stage to one local model (e.g. qwen3.5-9b-heretic)
`);
}

async function runPreflight(): Promise<number> {
  const cfg = loadConfig();
  console.log("=== Phase-D campaign preflight ===");
  console.log(`NODE_ENV=${process.env.NODE_ENV}`);

  let target;
  try {
    target = await resolveLocalTarget(cfg);
  } catch (e) {
    console.error("FAIL: Ollama unreachable:", e instanceof Error ? e.message : e);
    return 1;
  }

  const version = await readOllamaVersion(target.baseUrl);
  const health = await checkOllamaHealth(cfg.ollama);
  const contextLength = await readOllamaLoadedContextLength(target.baseUrl);
  const localModels = resolveLocalStageModels(cfg, health.models);

  console.log(`Ollama version: ${version ?? "(unknown)"}`);
  console.log(`Base URL:       ${target.baseUrl}`);
  console.log(`Installed:      ${health.models.join(", ") || "(none)"}`);
  console.log(`Local stage set:${localModels.join(", ")}`);
  console.log(
    `Context length: ${contextLength ?? "(no model loaded in /api/ps — start a chat or smoke run first)"}`,
  );

  if (contextLength !== null && contextLength < LOCAL_CONTEXT_LENGTH_FLOOR) {
    console.warn(
      `WARN: effective /api/ps context_length=${contextLength} < floor ${LOCAL_CONTEXT_LENGTH_FLOOR}. ` +
        `Set OLLAMA_CONTEXT_LENGTH=${LOCAL_CONTEXT_LENGTH_FLOOR} on the Ollama Windows service and restart. ` +
        `(/v1 discards per-request options.num_ctx; production stages need the daemon default raised.)`,
    );
  } else if (contextLength !== null) {
    console.log(`Context floor:  OK (>= ${LOCAL_CONTEXT_LENGTH_FLOOR})`);
  }

  // Per-stage resolved model + native tools
  const pool = new AgentPool(routableOrchestratorAgents(cfg));
  const stages = ["planner", "executor", "reviewer", "synthesizer"] as const;
  console.log("\nPer-stage pool pick (ollamaAvailable=true):");
  let allLocal = true;
  for (const stage of stages) {
    const pick = pool.pickFor(stage, "general", undefined, {
      ollamaAvailable: true,
      localModels,
    });
    const isOllama = pick?.provider === "ollama";
    if (!isOllama) allLocal = false;
    let toolsCapable = "?";
    if (isOllama && pick) {
      try {
        const t = await resolveLocalTarget(cfg, pick.model_id);
        toolsCapable = t.supportsNativeTools ? "native-tools" : "text-tools";
      } catch {
        toolsCapable = "unresolved";
      }
    }
    console.log(
      `  ${stage.padEnd(12)} → ${pick ? `${pick.provider}:${pick.model_id}` : "(none)"}` +
        (isOllama ? ` [${toolsCapable}]` : " ⚠ NOT ollama"),
    );
  }
  if (!allLocal) {
    console.warn(
      "WARN: one or more stages did not resolve to ollama. Campaign will pin local " +
        "via nonLocalPickFallbacks, but pool config may be wrong.",
    );
  }

  // Preferred models present?
  for (const m of DEFAULT_LOCAL_STAGE_MODELS) {
    const present = health.models.some(
      (installed) =>
        installed === m ||
        installed.startsWith(m) ||
        installed.replace(/:latest$/, "") === m.replace(/:latest$/, ""),
    );
    if (!present) {
      console.warn(`WARN: preferred local model "${m}" not in installed list`);
    }
  }

  const fixtures = campaignFixtureSummary();
  console.log(`\nFixtures: ${fixtures.training} training / ${fixtures.heldOut} held-out`);
  console.log(`  training: ${fixtures.trainingNames.slice(0, 5).join(", ")}${fixtures.trainingNames.length > 5 ? ", ..." : ""}`);
  console.log(`  held-out: ${fixtures.heldOutNames.join(", ")}`);

  if (fixtures.training === 0 || fixtures.heldOut === 0) {
    console.error("FAIL: empty training or held-out fixture set");
    return 1;
  }

  console.log("\nPreflight complete.");
  return 0;
}

async function runSmoke(model?: string): Promise<number> {
  const cfg = loadConfig();
  if (TRAINING_TASKS.length === 0) {
    console.error("FAIL: no training fixtures");
    return 1;
  }
  const task = TRAINING_TASKS[0]!;
  console.log(`=== Phase-D campaign smoke ===`);
  console.log(`task=${task.name} category=${task.category} entry=${task.entry}`);
  console.log(`model=${model ?? "(pool default)"}`);

  const callModel = callModelFor(cfg, model);
  const started = Date.now();
  const outcome = await runOneRollout(
    { theta: BASELINE_THETA, task, seed: 0 },
    callModel,
  );
  const wallMs = Date.now() - started;

  console.log(`\n--- RunRewardBreakdown ---`);
  console.log(JSON.stringify(outcome.breakdown, null, 2));
  console.log(`\nreward=${outcome.reward} durationMs=${outcome.durationMs} wallMs=${wallMs}`);
  if (outcome.error) console.log(`error=${outcome.error}`);

  console.log(`\n--- stats ---`);
  console.log(JSON.stringify(callModel.stats, null, 2));

  const stats = callModel.stats;
  let exit = 0;
  if (stats.nonLocalPickFallbacks !== 0) {
    console.warn(`WARN: nonLocalPickFallbacks=${stats.nonLocalPickFallbacks} (local-only did not hold for every pick)`);
  }
  if (stats.truncationSuspected !== 0) {
    console.warn(`WARN: truncationSuspected=${stats.truncationSuspected}`);
  }
  if (stats.emptyContentTurns !== 0) {
    console.warn(`WARN: emptyContentTurns=${stats.emptyContentTurns} thinkingOnlyTurns=${stats.thinkingOnlyTurns}`);
  }
  if (!(outcome.reward > 0)) {
    console.warn(
      `WARN: reward=${outcome.reward} (pass criteria want reward > 0 with a credited write path). ` +
        `Smoke still completed; treat as exploratory if the fixture is hard for the local model.`,
    );
    // Soft: do not hard-fail smoke solely on reward — model quality varies.
    // Operator uses the printed breakdown. exit stays 0 unless transport failed.
  }
  if (outcome.error && /Ollama unreachable|NODE_ENV/.test(outcome.error)) {
    exit = 1;
  }

  console.log("\nSmoke complete.");
  return exit;
}

async function runCampaign(
  generations: number,
  concurrency: number,
  taskLimit?: number,
  model?: string,
): Promise<number> {
  const cfg = loadConfig();
  const callModel = callModelFor(cfg, model);
  const trainingTasks =
    taskLimit !== undefined ? TRAINING_TASKS.slice(0, taskLimit) : TRAINING_TASKS;

  console.log(
    `=== Phase-D campaign generations=${generations} concurrency=${concurrency} ` +
      `trainingTasks=${trainingTasks.length} model=${model ?? "(pool default)"} ===`,
  );
  const campaignStarted = Date.now();
  const result = await runCmaEsCampaign({
    callModel,
    generations,
    concurrency,
    trainingTasks,
    onGeneration: (info) => {
      console.log(
        `gen ${info.generation}: best=${info.bestFitness.toFixed(4)} mean=${info.meanFitness.toFixed(4)} sigma=${info.sigma.toFixed(4)}`,
      );
    },
  });
  const wallMs = Date.now() - campaignStarted;
  console.log(`campaign wallMs=${wallMs}`);

  console.log("\n--- result ---");
  console.log(
    JSON.stringify(
      {
        improved: result.improved,
        winnerHeldOut: result.winnerHeldOut,
        baselineHeldOut: result.baselineHeldOut,
        generations: result.generations,
        history: result.history,
      },
      null,
      2,
    ),
  );
  console.log("\n--- stats ---");
  console.log(JSON.stringify(callModel.stats, null, 2));

  const transition = proposeCampaignWinner(result);
  if (transition) {
    console.log("\n--- policy-staging proposal ---");
    console.log(JSON.stringify(transition, null, 2));
  } else {
    console.log("\nNo policy proposal (winner did not beat baseline held-out, or θ unchanged).");
  }
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.preflight && !args.smoke && args.generations === undefined) {
    printHelp();
    process.exit(1);
  }

  let code = 0;
  if (args.preflight) {
    code = await runPreflight();
    if (code !== 0) process.exit(code);
  }
  if (args.smoke) {
    code = await runSmoke(args.model);
    if (code !== 0) process.exit(code);
  }
  if (args.generations !== undefined) {
    if (!Number.isFinite(args.generations) || args.generations < 1) {
      console.error("--generations must be a positive integer");
      process.exit(1);
    }
    code = await runCampaign(args.generations, args.concurrency, args.tasks, args.model);
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
