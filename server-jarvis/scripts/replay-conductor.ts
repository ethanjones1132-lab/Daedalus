#!/usr/bin/env bun
// Layer-1 conductor replay: assert invariants over stored production traces.
//
//   bun scripts/replay-conductor.ts [--limit N] [--db PATH] [--json]
//
// Read-only. No network, no model calls, no deploy. See
// src/eval/conductor-replay.ts for why this exists and what it can/cannot do.

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import {
  DEFAULT_REPLAY_THRESHOLDS,
  checkReplayInvariants,
  summarizeViolations,
  type ReplayRun,
  type ReplayViolation,
} from "../src/eval/conductor-replay";
import type { ConductorDirectiveRow, StageRun } from "../src/self-tuning/store";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("--db") ?? join(homedir(), ".openclaw", "jarvis", "self-tuning.db");
const limit = Number(arg("--limit") ?? 500);
// ISO timestamp. The point of a regression gate is comparing before/after a
// fix, so scope the scan to runs recorded since one shipped:
//   --since 2026-07-31T18:00:00Z
const since = arg("--since");
const asJson = process.argv.includes("--json");

const db = new Database(dbPath, { readonly: true });

const agentRuns = (since
  ? db
    .query(
      "SELECT id, task_type, outcome FROM agent_runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(since, limit)
  : db
    .query("SELECT id, task_type, outcome FROM agent_runs ORDER BY created_at DESC LIMIT ?")
    .all(limit)) as Array<{ id: string; task_type?: string; outcome?: string | null }>;

const stageStmt = db.query(
  "SELECT * FROM stage_runs WHERE agent_run_id = ? ORDER BY created_at",
);
const directiveStmt = db.query(
  "SELECT * FROM conductor_directives WHERE agent_run_id = ? ORDER BY created_at",
);

const runs: ReplayRun[] = agentRuns.map((row) => ({
  agentRunId: row.id,
  taskType: row.task_type,
  outcome: row.outcome,
  stageRuns: stageStmt.all(row.id) as StageRun[],
  directives: directiveStmt.all(row.id) as ConductorDirectiveRow[],
}));

const violations: ReplayViolation[] = runs.flatMap((run) =>
  checkReplayInvariants(run, DEFAULT_REPLAY_THRESHOLDS),
);
const summary = summarizeViolations(violations);
const dirtyRuns = new Set(violations.map((v) => v.agentRunId));

if (asJson) {
  console.log(JSON.stringify({ scanned: runs.length, summary, violations }, null, 2));
  process.exit(violations.length > 0 ? 1 : 0);
}

console.log(`\nConductor replay — ${runs.length} stored runs from ${dbPath}\n`);

if (violations.length === 0) {
  console.log("  no invariant violations\n");
  process.exit(0);
}

console.log(
  `  ${summary.totalViolations} violations across ${dirtyRuns.size} runs ` +
    `(${Math.round((dirtyRuns.size / Math.max(1, runs.length)) * 100)}% of scanned)\n`,
);

for (const rule of summary.byRule) {
  const tag = rule.severity === "high" ? "HIGH" : "MED ";
  console.log(`  [${tag}] ${rule.rule}`);
  console.log(`         ${rule.violations} violations · ${rule.affectedRuns} runs`);
  console.log(`         worst: ${rule.worstDetail}\n`);
}

// Worst offenders, so a regression points straight at a reproducible run id.
const byRun = new Map<string, ReplayViolation[]>();
for (const v of violations) {
  byRun.set(v.agentRunId, [...(byRun.get(v.agentRunId) ?? []), v]);
}
const worst = [...byRun.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
console.log("  worst runs:");
for (const [runId, items] of worst) {
  console.log(`    ${runId}  ${items.length} violations  [${items.map((i) => i.rule).join(", ")}]`);
}
console.log();

process.exit(1);
