// ═══════════════════════════════════════════════════════════════
// Priority 3 Phase 2 CLI — paired learning-transfer evaluator
// ═══════════════════════════════════════════════════════════════
//
//   bun run scripts/benchmark-learning-transfer.ts --freeze --out <manifest> \
//       --campaign-id <id> --training-fixture <name> [--seeds 1,2,3]
//   bun run scripts/benchmark-learning-transfer.ts --preflight --manifest <path>
//   bun run scripts/benchmark-learning-transfer.ts --campaign --manifest <path> --outcome <jsonl>
//
// `--freeze` runs ONLY the declared training fixture and writes a canonical,
// hashed manifest before any held-out fixture can be read. `--preflight`
// validates readiness with no completion. `--campaign` is a separate, explicit
// Phase 4 activity and is never run by the Phase 2 source phase.
//
// NODE_ENV=test is set before any rollout-dependent module is imported. The
// application modules are loaded with dynamic `import()` so lazily-constructed
// SelfTuningStore singletons resolve to in-memory DBs. Static ESM imports would
// be evaluated before the assignment and defeat that guard.
//
// This CLI performs no promotion and writes no production store.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type {
  FrozenLearningEvalManifest,
  LearningEvalModelIdentity,
  LearningEvalRolloutSettings,
} from "../src/self-tuning/rollout/learning-eval-types";

process.env.NODE_ENV = "test";

const configMod = await import("../src/config");
const localMod = await import("../src/self-tuning/rollout/local-call-model");
const evaluator = await import("../src/self-tuning/rollout/paired-learning-evaluator");
const types = await import("../src/self-tuning/rollout/learning-eval-types");

interface CliArgs {
  freeze: boolean;
  preflight: boolean;
  campaign: boolean;
  manifestPath?: string;
  outcomePath?: string;
  reportPath?: string;
  outPath?: string;
  campaignId?: string;
  trainingFixture?: string;
  trainingSeed?: number;
  seeds?: number[];
  model?: string;
  taskType?: string;
  baseSha?: string;
  help: boolean;
}

function parseSeeds(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const seeds = value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isSafeInteger(n) && n >= 0);
  return seeds;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    freeze: false,
    preflight: false,
    campaign: false,
    manifestPath: undefined,
    outcomePath: undefined,
    reportPath: undefined,
    outPath: undefined,
    campaignId: undefined,
    trainingFixture: undefined,
    trainingSeed: undefined,
    seeds: undefined,
    model: undefined,
    taskType: undefined,
    baseSha: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--freeze") args.freeze = true;
    else if (arg === "--preflight") args.preflight = true;
    else if (arg === "--campaign") args.campaign = true;
    else if (arg === "--manifest") args.manifestPath = argv[++i];
    else if (arg === "--outcome") args.outcomePath = argv[++i];
    else if (arg === "--report") args.reportPath = argv[++i];
    else if (arg === "--out") args.outPath = argv[++i];
    else if (arg === "--campaign-id") args.campaignId = argv[++i];
    else if (arg === "--training-fixture") args.trainingFixture = argv[++i];
    else if (arg === "--training-seed") args.trainingSeed = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--seeds") args.seeds = parseSeeds(argv[++i]);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--task-type") args.taskType = argv[++i];
    else if (arg === "--base-sha") args.baseSha = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp(): void {
  console.log(`Priority 3 paired learning-transfer evaluator

Usage:
  bun run scripts/benchmark-learning-transfer.ts --freeze --out <manifest> \\
      --campaign-id <id> --training-fixture <name> [--seeds 1,2,3] \\
      [--training-seed 0] [--model <name>] [--task-type debug] [--base-sha <sha>]
  bun run scripts/benchmark-learning-transfer.ts --preflight --manifest <path>
  bun run scripts/benchmark-learning-transfer.ts --campaign --manifest <path> --outcome <jsonl> [--report <md>]

Modes:
  --freeze      Run ONLY the declared training fixture, derive the candidate at
                persist:false, and write a canonical, hashed manifest. No
                held-out fixture is read. Makes a local model call.
  --preflight   Validate the frozen manifest against source bindings, the frozen
                split/permutations, and one loopback-pinned installed Ollama
                model artifact digest. Makes no chat completion and writes no
                artifact.
  --campaign    Explicitly authorized Phase 4 execution. Requires a frozen
                manifest and an append-only outcome JSONL path. Loads and
                verifies the frozen candidate/evidence artifact, then executes
                only held-out arms. It never retrains or issues a training
                fixture model call.

The model identity is pinned by immutable /api/tags artifact digest on a
loopback-only endpoint; the Ollama server version is tracked separately.
`);
}

function currentHeadSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

interface PreflightOutcome {
  ok: boolean;
  manifest: FrozenLearningEvalManifest;
  messages: string[];
}

async function preflight(manifestPath: string): Promise<PreflightOutcome> {
  const messages: string[] = [];
  const manifest = evaluator.loadFrozenManifestFile(manifestPath);

  const structural = types.validateLearningEvalManifest(manifest, evaluator.expectedHeldOutFixtures());
  if (!structural.ok) {
    return { ok: false, manifest, messages: [`manifest preflight failed (${structural.code}): ${structural.detail}`] };
  }
  messages.push(
    `planned ${structural.plan.plannedOutcomeCount} outcomes across ` +
      `${structural.plan.pairedBlockCount} task-seed blocks ` +
      `(${manifest.heldOutTasks.length} held-out × ${manifest.pairedSeeds.length} seeds × 3 arms)`,
  );
  messages.push(`frozen per-block arm permutations: ${structural.plan.blocks.length}`);

  const bindings = evaluator.validateSourceBindings(manifest);
  if (!bindings.ok) {
    return { ok: false, manifest, messages: [`source binding mismatch: ${bindings.mismatches.join(", ")}`] };
  }
  messages.push("source bindings (fixture/rubric/acceptance incl. oracle runner + scoring) match");

  const head = currentHeadSha();
  if (head !== manifest.baseSourceSha) {
    return { ok: false, manifest, messages: [`baseSourceSha mismatch: manifest=${manifest.baseSourceSha} head=${head}`] };
  }
  messages.push(`base source SHA matches head ${head}`);

  const pinned = await evaluator.resolvePinnedModelIdentity(manifest, configMod.loadConfig());
  if (!pinned.ok) {
    return { ok: false, manifest, messages: [`model identity failed (${pinned.code}): ${pinned.detail}`] };
  }
  messages.push(
    `pinned loopback model ${pinned.identity.name} digest=${pinned.identity.digest} ` +
      `ollamaServerVersion=${pinned.identity.serverVersion ?? "(unknown)"} ` +
      `nativeTools=${pinned.identity.supportsNativeTools}`,
  );

  if (
    manifest.candidate.artifactDigest !==
    types.computeCandidateArtifactDigest(manifest.candidate.candidate)
  ) {
    return { ok: false, manifest, messages: ["candidate artifact digest mismatch"] };
  }
  if (
    manifest.neutral.artifactDigest !==
    types.computeCandidateArtifactDigest(manifest.neutral.candidate)
  ) {
    return { ok: false, manifest, messages: ["neutral artifact digest mismatch"] };
  }
  messages.push("frozen full candidate/neutral artifacts and digests verified");

  return { ok: true, manifest, messages };
}

async function runPreflight(args: CliArgs): Promise<number> {
  if (!args.manifestPath) {
    console.error("--preflight requires --manifest <path>");
    return 1;
  }
  const result = await preflight(args.manifestPath);
  for (const message of result.messages) console.log(message);
  if (!result.ok) {
    console.error("Preflight FAILED.");
    return 1;
  }
  console.log(`Preflight complete for campaign ${result.manifest.campaignId}. No model completion was issued.`);
  return 0;
}

const ALLOWED_TASK_TYPES = new Set<string>([
  "code_review",
  "debug",
  "refactor",
  "general",
  "plan",
  "research",
  "test",
  "docs",
]);

async function runFreeze(args: CliArgs): Promise<number> {
  if (!args.outPath || !args.campaignId || !args.trainingFixture) {
    console.error("--freeze requires --out <manifest> --campaign-id <id> --training-fixture <name>");
    return 1;
  }
  const taskType = args.taskType ?? "debug";
  if (!ALLOWED_TASK_TYPES.has(taskType)) {
    console.error(`--task-type must be one of ${[...ALLOWED_TASK_TYPES].join(", ")}`);
    return 1;
  }
  const seeds = args.seeds ?? [1, 2, 3];
  if (seeds.length !== types.LEARNING_EVAL_REQUIRED_PAIRED_SEEDS) {
    console.error(`--seeds requires exactly ${types.LEARNING_EVAL_REQUIRED_PAIRED_SEEDS} seeds`);
    return 1;
  }
  const trainingSeed = args.trainingSeed ?? 0;
  if (!Number.isSafeInteger(trainingSeed) || trainingSeed < 0) {
    console.error("--training-seed must be a non-negative integer");
    return 1;
  }
  const cfg = configMod.loadConfig();
  const desiredModel = args.model ?? cfg.ollama.model;

  // Pin the immutable installed artifact digest on a loopback endpoint before
  // freezing; a non-loopback or digest-less model refuses to freeze.
  const installed = await evaluator.resolveInstalledLoopbackModel(cfg, desiredModel);
  if (!installed.ok) {
    console.error(`Freeze refused: model identity failed (${installed.code}): ${installed.detail}`);
    return 1;
  }
  const model: LearningEvalModelIdentity = {
    name: installed.model.name,
    digest: installed.model.digest,
    baseUrl: installed.model.baseUrl,
    supportsNativeTools: installed.model.supportsNativeTools,
    ...(installed.model.serverVersion !== null ? { version: installed.model.serverVersion } : {}),
  };

  // Only the training fixture runs here; the held-out split is never read. The
  // training call model is pinned to the exact loopback base url + installed
  // artifact digest resolved above, with no fallback to another endpoint/model.
  const callModel = localMod.makeLocalCallModel(
    {
      ...cfg,
      temperature: types.LEARNING_EVAL_REQUIRED_SAMPLER.temperature,
      top_p: types.LEARNING_EVAL_REQUIRED_SAMPLER.top_p,
      max_tokens: types.LEARNING_EVAL_REQUIRED_SAMPLER.num_predict,
    },
    {
      num_ctx: types.LEARNING_EVAL_REQUIRED_SAMPLER.num_ctx,
      timeoutMs: types.LEARNING_EVAL_REQUIRED_MODEL_CALL_TIMEOUT_MS,
      fixedTarget: {
        baseUrl: installed.model.baseUrl,
        model: installed.model.name,
        digest: installed.model.digest,
        supportsNativeTools: installed.model.supportsNativeTools,
      },
    },
  );

  let manifest: FrozenLearningEvalManifest;
  try {
    manifest = await evaluator.freezeLearningEvalManifest(
      {
        campaignId: args.campaignId,
        baseSourceSha: args.baseSha ?? currentHeadSha(),
        trainingFixtureName: args.trainingFixture,
        trainingSeed,
        pairedSeeds: seeds,
        taskType: taskType as LearningEvalRolloutSettings["skillMatchTaskType"],
        model,
      },
      callModel,
    );
  } catch (error) {
    console.error(`Freeze failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  evaluator.writeFrozenManifest(args.outPath, manifest);
  console.log(
    `Froze manifest ${args.outPath} for campaign ${manifest.campaignId} ` +
      `(hash ${manifest.manifestHash}, ${manifest.plannedOutcomeCount} planned outcomes). ` +
      `Candidate ${manifest.candidate.candidate.id} and the held-out split are now immutable.`,
  );
  return 0;
}

async function runCampaign(args: CliArgs): Promise<number> {
  if (!args.manifestPath || !args.outcomePath) {
    console.error("--campaign requires --manifest <path> and --outcome <jsonl>");
    return 1;
  }
  const pre = await preflight(args.manifestPath);
  if (!pre.ok) {
    for (const message of pre.messages) console.error(message);
    console.error("Campaign refused: preflight failed.");
    return 1;
  }
  const manifest = pre.manifest;

  const cfg = configMod.loadConfig();
  // All arm model calls are pinned to the exact frozen loopback base url + model
  // artifact digest carried by the manifest.
  const callModel = evaluator.makeFrozenArmCallModel(manifest, cfg);
  const storeRoot = evaluator.makeIsolatedSkillStoreRoot();
  try {
    // No acquisition, no retraining, and no training-fixture model call: the
    // campaign reconstructs and validates the full frozen candidate/neutral
    // artifacts from the manifest and executes only held-out arms.
    const result = await evaluator.runPairedLearningCampaign({
      manifest,
      callModel,
      outcomePath: args.outcomePath,
      authorizeCampaign: true,
      skillStoreRoot: storeRoot,
    });

    if (args.reportPath) {
      writeFileSync(args.reportPath, evaluator.renderDescriptiveReportMarkdown(result.report), "utf8");
    }
    console.log(evaluator.renderDescriptiveReportMarkdown(result.report));
    console.log("Campaign produced descriptive evidence only. No promotion and no benefit claim.");
    return result.missingOutcomeKeys.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`Campaign refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    evaluator.removeIsolatedSkillStoreRoot(storeRoot);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modes = [args.freeze, args.preflight, args.campaign].filter(Boolean).length;
  if (args.help || modes === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (modes !== 1) {
    console.error("choose exactly one mode: --freeze, --preflight, or --campaign");
    process.exit(1);
  }
  const code = args.freeze
    ? await runFreeze(args)
    : args.preflight
      ? await runPreflight(args)
      : await runCampaign(args);
  process.exit(code);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
