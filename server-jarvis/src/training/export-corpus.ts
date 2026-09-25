#!/usr/bin/env bun
/**
 * D-01: Trajectory corpus export CLI.
 *
 * Usage:
 *   bun run src/training/export-corpus.ts [options]
 *
 * Options:
 *   --out=<path>            Output JSONL path (default: ./training_corpus.jsonl)
 *   --limit=<n>             Max snapshots to scan (default: 1000)
 *   --min-reward=<float>    Drop rows with reward < this (default: 0.25)
 *   --token-budget=<n>      Token cap for efficiency term (default: 16000)
 *   --eval-results=<path>   Optional JSON map {agent_run_id: passed_bool}
 *   --replan-counts=<path>  Optional JSON map {agent_run_id: number}
 *   --weights=<w1,w2,w3,w4,w5>
 *                           Comma-separated overrides summing to ≥0
 *                           (outcome,user,eval,tokens,errors)
 *   --dry-run               Print stats + first 3 rows, do not write
 *   --help, -h              Show this help
 *
 * Examples:
 *   bun run src/training/export-corpus.ts --out=./grpo_corpus.jsonl
 *   bun run src/training/export-corpus.ts --min-reward=0.5 --token-budget=8000
 *   bun run src/training/export-corpus.ts \
 *     --eval-results=./eval_results.json --out=./grpo_corpus_v2.jsonl
 *
 * See ./corpus.ts for the JSONL schema and composite-reward formula.
 */

import { writeFileSync } from "fs";
import { SelfTuningStore } from "../self-tuning/store";
import {
  exportCorpus,
  DEFAULT_REWARD_WEIGHTS,
  DEFAULT_TOKEN_BUDGET,
  type RewardWeights,
} from "./corpus";
import {
  CorpusSidecarError,
  loadEvalSidecar,
  loadReplanSidecar,
  type DecodedEvalSidecar,
  type DecodedReplanSidecar,
  type SidecarCoverage,
} from "./corpus-sidecars";

interface CliArgs {
  out: string;
  limit: number;
  minReward: number;
  tokenBudget: number;
  evalResultsPath?: string;
  replanCountsPath?: string;
  weightsOverride?: RewardWeights;
  dryRun: boolean;
}

function printUsage(): void {
  console.log(`
D-01 Trajectory corpus export — composite-reward JSONL for GRPO training.

Usage:
  bun run src/training/export-corpus.ts [options]

Options:
  --out=<path>            Output JSONL path (default: ./training_corpus.jsonl)
  --limit=<n>             Max snapshots to scan (default: 1000)
  --min-reward=<float>    Drop rows with reward < this (default: 0.25)
  --token-budget=<n>      Token cap for efficiency term (default: 16000)
  --eval-results=<path>   Optional JSON map {agent_run_id: passed_bool}
  --replan-counts=<path>  Optional JSON map {agent_run_id: number}
  --weights=<w1,w2,w3,w4,w5>
                          outcome,user,eval,tokens,errors weights (≥0)
  --dry-run               Print stats + first 3 rows, do not write
  --help, -h              Show this help

JSONL schema and reward formula: see ./corpus.ts header.
`);
}

function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const args: CliArgs = {
    out: "./training_corpus.jsonl",
    limit: 1000,
    minReward: 0.25,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length);
    } else if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --limit: must be a positive integer`);
      }
      args.limit = n;
    } else if (arg.startsWith("--min-reward=")) {
      const n = Number(arg.slice("--min-reward=".length));
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(`Invalid --min-reward: must be in [0, 1]`);
      }
      args.minReward = n;
    } else if (arg.startsWith("--token-budget=")) {
      const n = parseInt(arg.slice("--token-budget=".length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --token-budget: must be a positive integer`);
      }
      args.tokenBudget = n;
    } else if (arg.startsWith("--eval-results=")) {
      args.evalResultsPath = arg.slice("--eval-results=".length);
    } else if (arg.startsWith("--replan-counts=")) {
      args.replanCountsPath = arg.slice("--replan-counts=".length);
    } else if (arg.startsWith("--weights=")) {
      const parts = arg.slice("--weights=".length).split(",").map((s) => s.trim());
      if (parts.length !== 5) {
        throw new Error(
          `--weights expects 5 comma-separated values (outcome,user,eval,tokens,errors), got ${parts.length}`,
        );
      }
      const nums = parts.map((p) => Number(p));
      if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
        throw new Error(
          `--weights values must be non-negative finite numbers, got: ${parts.join(",")}`,
        );
      }
      const [outcome, user, evalW, tokens, errors] = nums;
      args.weightsOverride = { outcome, user, eval: evalW, tokens, errors };
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function printSidecarCoverage(
  label: string,
  sidecar: DecodedEvalSidecar | DecodedReplanSidecar | undefined,
  coverage: SidecarCoverage | null,
): void {
  if (!sidecar || !coverage) return;
  const format = sidecar.format === "legacy"
    ? "legacy bare map (versioned envelope preferred)"
    : `versioned evaluator=${JSON.stringify(sidecar.metadata?.evaluator)} eval_suite=${JSON.stringify(sidecar.metadata?.evalSuite)} generated_at=${JSON.stringify(sidecar.metadata?.generatedAt)}`;
  const truncated = coverage.truncated ? " truncated=true" : "";
  console.log(
    `${label} sidecar: ${format}; provided=${coverage.providedCount}, matched=${coverage.matchedCount}, unmatched=${coverage.unmatchedCount}, missing=${coverage.missingCount}; ` +
      `provided_run_ids=${JSON.stringify(coverage.providedRunIds)} matched_run_ids=${JSON.stringify(coverage.matchedRunIds)} ` +
      `unmatched_run_ids=${JSON.stringify(coverage.unmatchedRunIds)} missing_run_ids=${JSON.stringify(coverage.missingRunIds)}${truncated}`,
  );
}

function loadEvalForExport(path: string): DecodedEvalSidecar {
  try {
    return loadEvalSidecar(path);
  } catch (error) {
    if (error instanceof CorpusSidecarError) {
      throw new Error(`eval results sidecar: ${error.message}`);
    }
    throw error;
  }
}

function loadReplanForExport(path: string): DecodedReplanSidecar {
  try {
    return loadReplanSidecar(path);
  } catch (error) {
    if (error instanceof CorpusSidecarError) {
      throw new Error(`replan counts sidecar: ${error.message}`);
    }
    throw error;
  }
}

export async function main(argv: string[] = process.argv.slice(2), store: SelfTuningStore = new SelfTuningStore()): Promise<void> {
  const args = parseArgs(argv);
  const evalSidecar = args.evalResultsPath ? loadEvalForExport(args.evalResultsPath) : undefined;
  const replanSidecar = args.replanCountsPath ? loadReplanForExport(args.replanCountsPath) : undefined;
  const weights = args.weightsOverride ?? DEFAULT_REWARD_WEIGHTS;

  const { rows, stats, sidecarCoverage } = exportCorpus(store, args.limit, {
    rewardWeights: weights,
    tokenBudget: args.tokenBudget,
    minReward: args.minReward,
    evalResults: evalSidecar?.values,
    replanCounts: replanSidecar?.values,
  });

  printSidecarCoverage("eval", evalSidecar, sidecarCoverage.eval);
  printSidecarCoverage("replan", replanSidecar, sidecarCoverage.replan);
  console.log(
    `Scanned ${stats.scanned} snapshot(s); kept ${stats.kept}, ` +
      `dropped (below min-reward ${args.minReward}): ${stats.droppedBelowThreshold}, ` +
      `dropped (malformed): ${stats.droppedMalformed}.`,
  );

  if (args.dryRun) {
    console.log("\n[dry-run] First 3 kept rows:");
    for (const r of rows.slice(0, 3)) {
      console.log(JSON.stringify(r, null, 2));
    }
    return;
  }

  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  writeFileSync(args.out, lines, "utf-8");
  console.log(`Wrote ${rows.length} row(s) to ${args.out}.`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
