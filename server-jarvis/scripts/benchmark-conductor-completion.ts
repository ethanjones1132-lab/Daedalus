#!/usr/bin/env bun
// Release-gate benchmark over stored conductor runs.
//
//   bun scripts/benchmark-conductor-completion.ts [--db PATH] [--since ISO] [--limit N] [--json]
//
// Read-only. No network, no model calls, no deploy. See
// src/eval/conductor-performance.ts for the metric definitions.

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import {
  RELEASE_THRESHOLDS,
  summarizeConductorPerformance,
  type ConductorPerformanceFixture,
} from "../src/eval/conductor-performance";
import type { ConductorDirectiveRow, ModelAttribution, StageRun } from "../src/self-tuning/store";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("--db") ?? join(homedir(), ".openclaw", "jarvis", "self-tuning.db");
const limit = Number(arg("--limit") ?? 500);
const since = arg("--since");
const asJson = process.argv.includes("--json");

const db = new Database(dbPath, { readonly: true });

const agentRuns = (since
  ? db
    .query(
      "SELECT id, task_type, outcome, final_output, verified_via, check_tier FROM agent_runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(since, limit)
  : db
    .query(
      "SELECT id, task_type, outcome, final_output, verified_via, check_tier FROM agent_runs ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit)) as Array<{
  id: string;
  task_type?: string;
  outcome?: string | null;
  final_output?: string | null;
  verified_via?: string | null;
  check_tier?: string | null;
}>;

const stageStmt = db.query(
  "SELECT * FROM stage_runs WHERE agent_run_id = ? ORDER BY created_at",
);
const directiveStmt = db.query(
  "SELECT * FROM conductor_directives WHERE agent_run_id = ? ORDER BY created_at",
);
// W2.1: claude_cli attributions are the primary delegate-run signal.
const attributionStmt = db.query(
  "SELECT * FROM model_attributions WHERE agent_run_id = ? ORDER BY created_at",
);

const fixtures: ConductorPerformanceFixture[] = agentRuns.map((row) => ({
  agentRunId: row.id,
  taskType: row.task_type,
  outcome: row.outcome,
  finalOutput: row.final_output,
  verifiedVia: row.verified_via,
  checkTier: row.check_tier,
  stageRuns: stageStmt.all(row.id) as StageRun[],
  directives: directiveStmt.all(row.id) as ConductorDirectiveRow[],
  modelAttributions: attributionStmt.all(row.id) as ModelAttribution[],
}));

const summary = summarizeConductorPerformance(fixtures, RELEASE_THRESHOLDS);

// Exit non-zero when any hard threshold fails. The delegate-rate axis only
// contributes a failure when delegateGate === "fail" (sample ≥5 and rate low);
// insufficient_sample is reported but does not force exit by itself.
const hardFail = summary.gateFailures.length > 0;
const exitCode = hardFail ? 1 : 0;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        scanned: fixtures.length,
        db: dbPath,
        since: since ?? null,
        limit,
        thresholds: RELEASE_THRESHOLDS,
        summary,
        delegate_gate: summary.delegateGate,
        gate_failures: summary.gateFailures,
        meets_release_gate: summary.meetsReleaseGate,
      },
      null,
      2,
    ),
  );
  process.exit(exitCode);
}

console.log(`\nConductor performance benchmark — ${fixtures.length} runs from ${dbPath}`);
if (since) console.log(`  since: ${since}`);
console.log();
console.log(`  runs:                         ${summary.runs}`);
console.log(
  `  executor no-tool:             ${summary.executorNoToolTurns}/${summary.executorTurns}` +
    ` (${(summary.executorNoToolRatio * 100).toFixed(1)}%)` +
    `  [max ${(RELEASE_THRESHOLDS.maxExecutorNoToolRatio * 100).toFixed(0)}%]`,
);
console.log(
  `  delegate write-land rate:     ${summary.delegateRuns > 0 ? (summary.delegateWriteLandRate * 100).toFixed(1) : "0.0"}%` +
    ` (${summary.delegateRuns} delegate runs)` +
    `  gate=${summary.delegateGate}` +
    (summary.delegateGate === "insufficient_sample"
      ? " (need ≥5 delegate fixtures)"
      : `  [min ${(RELEASE_THRESHOLDS.minDelegateVerifiedWriteRate * 100).toFixed(0)}%]`),
);
console.log(
  `  delegate verified (diagnostic): ${summary.delegateVerifiedWrites}/${summary.delegateRuns}` +
    ` (${(summary.delegateVerifiedWriteRate * 100).toFixed(1)}%)` +
    `  — not a hard gate (Stage 0a.2)`,
);
console.log(
  `  unverified successes:         ${summary.unverifiedSuccesses}` +
    `  [max ${RELEASE_THRESHOLDS.maxUnverifiedSuccesses}]`,
);
console.log(
  `  false-complete runs:          ${summary.falseCompleteRuns}` +
    `  [max ${RELEASE_THRESHOLDS.maxFalseCompleteRuns}]`,
);
console.log(
  `  duplicate write-pressure:     ${summary.duplicateWritePressureRuns}` +
    `  [max ${RELEASE_THRESHOLDS.maxDuplicateWritePressureRuns}]`,
);
console.log(
  `  writes landed per run:        ${summary.writesLandedPerRun.toFixed(2)}` +
    `  [min ${RELEASE_THRESHOLDS.minWritesLandedPerRun}]`,
);
console.log(
  `  task-target writes:           ${summary.taskTargetWrites}` +
    `  (non-status paths; targets when known)`,
);
console.log();
if (summary.meetsReleaseGate) {
  console.log("  RELEASE GATE: PASS\n");
} else {
  console.log(`  RELEASE GATE: FAIL  [${summary.gateFailures.join(", ")}]\n`);
}

process.exit(exitCode);
