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

import { writeFileSync, existsSync, readFileSync } from "fs";
import { SelfTuningStore } from "../self-tuning/store";
import {
  exportCorpus,
  DEFAULT_REWARD_WEIGHTS,
  DEFAULT_TOKEN_BUDGET,
  type RewardWeights,
  type EvalResults,
} from "./corpus";

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

function parseArgs(): CliArgs {
  const args: CliArgs = {
    out: "./training_corpus.jsonl",
    limit: 1000,
    minReward: 0.25,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    dryRun: false,
  };
  for (const arg of process.argv.slice(2)) {
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

function loadJsonMap(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`${label} file not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read ${label} from ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object keyed by agent_run_id`);
  }
  return parsed as Record<string, unknown>;
}

function asEvalResults(map: Record<string, unknown>): EvalResults {
  const out = new Map<string, boolean>();
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "boolean") out.set(k, v);
  }
  return out;
}

function asReplanCounts(map: Record<string, unknown>): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out.set(k, Math.floor(v));
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const evalResults = args.evalResultsPath
    ? asEvalResults(loadJsonMap(args.evalResultsPath, "eval results"))
    : undefined;
  const replanCounts = args.replanCountsPath
    ? asReplanCounts(loadJsonMap(args.replanCountsPath, "replan counts"))
    : undefined;
  const weights = args.weightsOverride ?? DEFAULT_REWARD_WEIGHTS;

  const store = new SelfTuningStore();
  const { rows, stats } = exportCorpus(store, args.limit, {
    rewardWeights: weights,
    tokenBudget: args.tokenBudget,
    minReward: args.minReward,
    evalResults,
    replanCounts,
  });

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

main().catch((e) => {
  console.error("Fatal error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
