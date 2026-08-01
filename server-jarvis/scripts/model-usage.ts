#!/usr/bin/env bun
// Per-model usage, error rate, and new-release trial status.
//
//   bun scripts/model-usage.ts [--since ISO] [--db PATH] [--stage NAME] [--json]
//
// Read-only. Answers "which models are actually being used, how are they
// doing, and which are still proving themselves" — the question the trial
// policy (src/orchestration/model-trial-policy.ts) makes worth asking.
//
// Exists as a script rather than a one-liner because PowerShell 5.1 mangles
// inner double quotes when passing them to a native exe, so `bun -e '...'`
// with nested quotes silently arrives corrupted.

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { TRIAL_SAMPLE_TARGET } from "../src/orchestration/model-trial-policy";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("--db") ?? join(homedir(), ".openclaw", "jarvis", "self-tuning.db");
const since = arg("--since");
const stageFilter = arg("--stage");
const asJson = process.argv.includes("--json");

const db = new Database(dbPath, { readonly: true });

interface Row {
  provider: string;
  model_id: string;
  stage_id: string;
  n: number;
  errs: number;
}

const where: string[] = [];
const params: string[] = [];
if (since) { where.push("created_at >= ?"); params.push(since); }
if (stageFilter) { where.push("stage_id = ?"); params.push(stageFilter); }
const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

const rows = db
  .query(
    `SELECT provider, model_id, stage_id, COUNT(*) n, SUM(had_error) errs
     FROM model_attributions ${clause}
     GROUP BY provider, model_id, stage_id`,
  )
  .all(...params) as Row[];

interface Agg {
  key: string;
  n: number;
  errs: number;
  /** Stages where this model has fewer observations than the trial target. */
  provingStages: string[];
}

const byModel = new Map<string, Agg>();
for (const row of rows) {
  const key = `${row.provider}:${row.model_id}`;
  const agg = byModel.get(key) ?? { key, n: 0, errs: 0, provingStages: [] };
  agg.n += row.n;
  agg.errs += row.errs ?? 0;
  // Delegate attributions key stage_id to a per-run UUID rather than a stage
  // NAME, so every delegate row is its own bucket of one. Listing them is
  // noise, and they can never reach the trial target by construction — the
  // delegate uses selectDelegateModel, not pickFor, so the trial policy does
  // not apply to it either way.
  const namedStage = !/^stage_[0-9a-f-]{8,}$/i.test(row.stage_id);
  if (namedStage && row.n < TRIAL_SAMPLE_TARGET) agg.provingStages.push(`${row.stage_id}(${row.n})`);
  byModel.set(key, agg);
}

const models = [...byModel.values()].sort((a, b) => b.n - a.n);

if (asJson) {
  console.log(JSON.stringify({ trialSampleTarget: TRIAL_SAMPLE_TARGET, models }, null, 2));
  process.exit(0);
}

console.log(`\nModel usage — ${models.length} models from ${dbPath}`);
if (since) console.log(`  since: ${since}`);
if (stageFilter) console.log(`  stage: ${stageFilter}`);
console.log(`  trial target: ${TRIAL_SAMPLE_TARGET} observations per stage before a model is graded\n`);

if (models.length === 0) {
  console.log("  no attributions in range\n");
  process.exit(0);
}

const total = models.reduce((sum, m) => sum + m.n, 0);
console.log(`  ${"model".padEnd(48)} ${"uses".padStart(6)} ${"err%".padStart(6)}  share  status`);
for (const m of models) {
  const errPct = m.n > 0 ? (100 * m.errs) / m.n : 0;
  const share = (100 * m.n) / Math.max(1, total);
  // >=50% error over >=TRIAL_SAMPLE_TARGET is ModelScorecard's unfit rule;
  // pickFor already excludes those, so surface it rather than bury it.
  const unfit = m.n >= TRIAL_SAMPLE_TARGET && errPct >= 50;
  const status = unfit
    ? "UNFIT (excluded by scorecard)"
    : m.provingStages.length > 0
      ? `proving: ${m.provingStages.join(" ")}`
      : "graded";
  console.log(
    `  ${m.key.padEnd(48)} ${String(m.n).padStart(6)} ${errPct.toFixed(0).padStart(5)}% ${share.toFixed(0).padStart(5)}%  ${status}`,
  );
}
console.log();
