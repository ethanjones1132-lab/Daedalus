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

import { loadConfig, SESSIONS_DIR, type JarvisConfig } from "../../config";
import { AgentPool, DEFAULT_LOCAL_STAGE_MODELS } from "../../orchestration/agent-pool";
import { BASELINE_THETA, mulberry32 } from "../../orchestration/orchestration-policy";
import { routableOrchestratorAgents } from "../../provider-availability";
import { makeLocalCallModel, resolveLocalStageModels } from "../rollout/local-call-model";
import {
  LOCAL_CONTEXT_LENGTH_FLOOR,
  readOllamaLoadedContextLength,
  readOllamaVersion,
  resolveLocalTarget,
} from "../rollout/ollama-local-transport";
import { loadHeldOutTasks, loadTrainingTasks } from "../rollout/fixture-tasks";
import { runOneRollout } from "../rollout/rollout-runner";
import { DEFAULT_ROLLOUT_CONCURRENCY } from "../rollout/rollout-pool";
import {
  campaignFixtureSummary,
  heldOutSeedsFromCampaignSeed,
  pairedTTestImproved,
  persistCampaignWinner,
  runCmaEsCampaign,
  selectTrainingTasks,
  thetaDiff,
} from "./run-cma-es";
import { checkOllamaHealth } from "../../ollama";
import type { OrchestrationTheta } from "../../orchestration/orchestration-policy";
import { readFileSync } from "node:fs";

/** Default paired held-out repeats (8 fixtures × 3 seeds × 2 θs = 48 rollouts). */
const DEFAULT_HELDOUT_REPEATS = 3;

function parseArgs(argv: string[]): {
  preflight: boolean;
  smoke: boolean;
  explain: boolean;
  thetaFile?: string;
  generations?: number;
  concurrency: number;
  tasks?: number;
  model?: string;
  seed?: number;
  heldoutRepeats: number;
  taskNames?: string[];
} {
  const out = {
    preflight: false,
    smoke: false,
    explain: false,
    thetaFile: undefined as string | undefined,
    generations: undefined as number | undefined,
    concurrency: DEFAULT_ROLLOUT_CONCURRENCY,
    tasks: undefined as number | undefined,
    model: undefined as string | undefined,
    seed: undefined as number | undefined,
    heldoutRepeats: DEFAULT_HELDOUT_REPEATS,
    taskNames: undefined as string[] | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--preflight") out.preflight = true;
    else if (a === "--smoke") out.smoke = true;
    else if (a === "--explain") out.explain = true;
    else if (a === "--theta-file") {
      out.thetaFile = argv[++i];
    } else if (a === "--generations" || a === "-g") {
      out.generations = Number(argv[++i]);
    } else if (a === "--concurrency" || a === "-c") {
      out.concurrency = Math.max(1, Number(argv[++i]) || 1);
    } else if (a === "--tasks" || a === "-t") {
      out.tasks = Math.max(1, Number(argv[++i]) || 1);
    } else if (a === "--model" || a === "-m") {
      out.model = argv[++i];
    } else if (a === "--seed") {
      out.seed = Number(argv[++i]) >>> 0;
    } else if (a === "--heldout-repeats") {
      out.heldoutRepeats = Math.max(1, Number(argv[++i]) || DEFAULT_HELDOUT_REPEATS);
    } else if (a === "--task-names") {
      out.taskNames = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
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
  --tasks N       Subset first N training fixtures (early-run budget control).
                  NOTE: a prefix slice takes the EASY fixtures. Measured 2026-08-09:
                  2 of 3 models scored a population mean of exactly 1.0000 on the
                  prefix — a 15-way tie, so CMA-ES had no gradient and the whole
                  campaign was noise. Prefer --task-names for a real campaign.
  --task-names A,B,C  Train on exactly these fixtures, in this order (wins over --tasks).
                  Pick fixtures the model neither aces nor floors: one pinned at the
                  ceiling adds a constant to every candidate's fitness and buys nothing.
  --model ID      Pin every rollout stage to one local model (e.g. qwen3.5-9b-heretic)
  --seed N        Deterministic mulberry32 seed for the optimizer's RNG (reproducible runs).
                  Omitted: Math.random() — this run's winner cannot be regenerated later.
                  Also bases held-out sampler seeds (100000+N …) and training CRN seeds.
  --heldout-repeats N  Paired held-out repeats per fixture (default ${DEFAULT_HELDOUT_REPEATS}).
                  Budget: fixtures × N × 2 θs rollouts. Use 1 for a cheap smoke of the verdict path.
  --explain       Per-task held-out breakdown for BASELINE vs θ (requires --theta-file)
  --theta-file P  JSON θ diff (same shape as campaign θDiff output) for --explain
`);
}

/**
 * Load a θ patch JSON (thetaDiff shape: partial dimension map) and merge onto
 * BASELINE_THETA. Rejects unknown keys so typos don't silently become no-ops.
 */
function loadThetaFromDiffFile(path: string): OrchestrationTheta {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`--theta-file must be a JSON object of θ keys → numbers: ${path}`);
  }
  const patch: Partial<OrchestrationTheta> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in BASELINE_THETA)) {
      throw new Error(`--theta-file unknown θ key: ${k}`);
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`--theta-file ${k} must be a finite number, got ${typeof v}`);
    }
    patch[k as keyof OrchestrationTheta] = v;
  }
  return { ...BASELINE_THETA, ...patch };
}

/**
 * Deterministic per-task diagnostic: BASELINE vs candidate θ over held-out
 * fixtures with the Phase-2 seeded harness. Prints reward/hardZero/overclaim/notes
 * per (label, task, seed) plus the paired CI summary — single pass, no double spend.
 */
async function runExplain(
  thetaFile: string,
  concurrency: number,
  model?: string,
  seed?: number,
  heldoutRepeats: number = DEFAULT_HELDOUT_REPEATS,
): Promise<number> {
  void concurrency; // reserved for future batched explain
  const cfg = loadConfig();
  const callModel = callModelFor(cfg, model);
  const winner = loadThetaFromDiffFile(thetaFile);
  const heldOutSeeds = heldOutSeedsFromCampaignSeed(seed, heldoutRepeats);

  console.log(
    `=== Phase-D --explain model=${model ?? "(pool default)"} ` +
      `seed=${seed ?? 0} heldoutRepeats=${heldoutRepeats} ` +
      `heldOutSeeds=[${heldOutSeeds.join(",")}] thetaFile=${thetaFile} ===`,
  );
  console.log(`θ diff keys: ${Object.keys(thetaDiff(winner)).join(", ") || "(none)"}`);

  const deltas: number[] = [];
  let winnerSum = 0;
  let baselineSum = 0;

  for (const s of heldOutSeeds) {
    for (let t = 0; t < loadHeldOutTasks().length; t++) {
      const task = loadHeldOutTasks()[t]!;
      const taskSeed = s * 1000 + t;

      const baselineOutcome = await runOneRollout(
        { theta: BASELINE_THETA, task, seed: taskSeed },
        callModel,
      );
      console.log(`\n--- BASELINE / ${task.name} / seed=${taskSeed} ---`);
      console.log(`reward=${baselineOutcome.reward}  durationMs=${baselineOutcome.durationMs}`);
      console.log(`terms=${JSON.stringify(baselineOutcome.breakdown.terms)}`);
      console.log(
        `hardZero=${baselineOutcome.breakdown.hardZero} reason=${baselineOutcome.breakdown.hardZeroReason ?? "-"}`,
      );
      console.log(`overclaim=${baselineOutcome.breakdown.overclaim}`);
      console.log(
        `creditedWritePaths=${JSON.stringify(baselineOutcome.breakdown.creditedWritePaths)}`,
      );
      console.log(`notes: ${baselineOutcome.breakdown.notes.join(" | ")}`);
      if (baselineOutcome.error) console.log(`ERROR: ${baselineOutcome.error}`);

      const candidateOutcome = await runOneRollout(
        { theta: winner, task, seed: taskSeed },
        callModel,
      );
      console.log(`\n--- CANDIDATE / ${task.name} / seed=${taskSeed} ---`);
      console.log(`reward=${candidateOutcome.reward}  durationMs=${candidateOutcome.durationMs}`);
      console.log(`terms=${JSON.stringify(candidateOutcome.breakdown.terms)}`);
      console.log(
        `hardZero=${candidateOutcome.breakdown.hardZero} reason=${candidateOutcome.breakdown.hardZeroReason ?? "-"}`,
      );
      console.log(`overclaim=${candidateOutcome.breakdown.overclaim}`);
      console.log(
        `creditedWritePaths=${JSON.stringify(candidateOutcome.breakdown.creditedWritePaths)}`,
      );
      console.log(`notes: ${candidateOutcome.breakdown.notes.join(" | ")}`);
      if (candidateOutcome.error) console.log(`ERROR: ${candidateOutcome.error}`);

      deltas.push(candidateOutcome.reward - baselineOutcome.reward);
      winnerSum += candidateOutcome.reward;
      baselineSum += baselineOutcome.reward;
    }
  }

  const test = pairedTTestImproved(deltas);
  const n = deltas.length;
  const cmp = {
    winnerMean: n === 0 ? 0 : winnerSum / n,
    baselineMean: n === 0 ? 0 : baselineSum / n,
    meanDelta: test.meanDelta,
    ciHalfWidth: test.ciHalfWidth,
    pairCount: test.pairCount,
    improved: test.improved,
  };

  console.log("\n\n========== paired comparison ==========");
  console.log(JSON.stringify(cmp, null, 2));
  console.log(
    `meanDelta=${cmp.meanDelta.toFixed(4)} ± ${cmp.ciHalfWidth.toFixed(4)} ` +
      `over ${cmp.pairCount} pairs; improved=${cmp.improved}`,
  );
  console.log("\n--- stats ---");
  console.log(JSON.stringify(callModel.stats, null, 2));
  return 0;
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
  if (loadTrainingTasks().length === 0) {
    console.error("FAIL: no training fixtures");
    return 1;
  }
  const task = loadTrainingTasks()[0]!;
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
    // emptyContentTurns excludes tool-only turns (see LocalCallModelStats).
    console.warn(
      `WARN: emptyContentTurns=${stats.emptyContentTurns} ` +
        `thinkingOnlyTurns=${stats.thinkingOnlyTurns} toolOnlyTurns=${stats.toolOnlyTurns}`,
    );
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
  seed?: number,
  heldoutRepeats: number = DEFAULT_HELDOUT_REPEATS,
  taskNames?: readonly string[],
): Promise<number> {
  const cfg = loadConfig();
  const callModel = callModelFor(cfg, model);
  const trainingTasks = selectTrainingTasks({ names: taskNames, limit: taskLimit });
  const heldOutSeeds = heldOutSeedsFromCampaignSeed(seed, heldoutRepeats);

  console.log(
    `=== Phase-D campaign generations=${generations} concurrency=${concurrency} ` +
      `trainingTasks=${trainingTasks.length}` +
      `${taskNames ? `[${trainingTasks.map((t) => t.name).join(",")}]` : ""} ` +
      `model=${model ?? "(pool default)"} ` +
      `seed=${seed ?? "(none — not reproducible, Math.random())"} ` +
      `heldoutRepeats=${heldoutRepeats} heldOutSeeds=[${heldOutSeeds.join(",")}] ===`,
  );
  const campaignStarted = Date.now();
  const result = await runCmaEsCampaign({
    callModel,
    generations,
    concurrency,
    trainingTasks,
    heldOutSeeds,
    campaignSeedBase: seed ?? 0,
    rng: seed !== undefined ? mulberry32(seed) : undefined,
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
        heldOutComparison: result.heldOutComparison,
        generations: result.generations,
        history: result.history,
      },
      null,
      2,
    ),
  );

  if (result.heldOutComparison) {
    const c = result.heldOutComparison;
    console.log("\n--- paired held-out comparison ---");
    console.log(
      `meanDelta=${c.meanDelta.toFixed(4)} ± ${c.ciHalfWidth.toFixed(4)} ` +
        `(95% t-CI half-width) over ${c.pairCount} pairs; ` +
        `improved=${c.improved} (lower bound ${ (c.meanDelta - c.ciHalfWidth).toFixed(4) } > 0?)`,
    );
  }

  // Always printed, regardless of `improved` — this is the exact gap flagged
  // after the first Heretic campaign: proposeCampaignWinner short-circuits on
  // improved=false before it ever computes the diff, so a non-improving run
  // left no record of which dimensions the optimizer actually moved. Visibility
  // here is diagnostic only; it does not change whether anything gets proposed.
  console.log("\n--- winner θ (bounds-projected optimizer mean) ---");
  console.log(JSON.stringify(result.winner, null, 2));
  const diff = thetaDiff(result.winner);
  console.log(`\n--- diff from BASELINE_THETA (${Object.keys(diff).length} of ${Object.keys(result.winner).length} dimensions changed) ---`);
  console.log(JSON.stringify(diff, null, 2));

  console.log("\n--- stats ---");
  console.log(JSON.stringify(callModel.stats, null, 2));

  const handoff = persistCampaignWinner(result, { root: SESSIONS_DIR });
  if (handoff.status === "load_failed") {
    console.error("Policy handoff failed: the existing policy state could not be loaded.");
    return handoff.exitCode;
  }
  if (handoff.status === "persistence_failed") {
    console.error("Policy handoff failed: the candidate was not persisted.");
    return handoff.exitCode;
  }
  if (handoff.transition) {
    console.log("\n--- policy-staging proposal ---");
    console.log(JSON.stringify(handoff.transition, null, 2));
  } else {
    console.log("\nNo policy proposal (winner did not beat baseline held-out, or θ unchanged).");
  }
  return handoff.exitCode;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (
    !args.preflight &&
    !args.smoke &&
    !args.explain &&
    args.generations === undefined
  ) {
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
  if (args.explain) {
    if (!args.thetaFile) {
      console.error("--explain requires --theta-file <path.json>");
      process.exit(1);
    }
    code = await runExplain(
      args.thetaFile,
      args.concurrency,
      args.model,
      args.seed,
      args.heldoutRepeats,
    );
    if (code !== 0) process.exit(code);
  }
  if (args.generations !== undefined) {
    if (!Number.isFinite(args.generations) || args.generations < 1) {
      console.error("--generations must be a positive integer");
      process.exit(1);
    }
    code = await runCampaign(
      args.generations,
      args.concurrency,
      args.tasks,
      args.model,
      args.seed,
      args.heldoutRepeats,
      args.taskNames,
    );
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
