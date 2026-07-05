#!/usr/bin/env bun
/**
 * Retro-marks self-tuning runs poisoned by the 2026-07-03 reward-signal leak
 * (session 1d4727cf, run_81091960): the synthesizer emitted tool-call JSON as
 * its "answer", the stage was recorded was_successful=1, the run
 * outcome=success, and the tuning heuristics then boosted the offending
 * model's capability score.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written unless --apply is passed.
 *
 * Usage:
 *   bun scripts/retro-mark-poisoned-runs.ts               # dry run against the real DB
 *   bun scripts/retro-mark-poisoned-runs.ts --apply        # actually write the fixes
 *   bun scripts/retro-mark-poisoned-runs.ts --db <path>    # target a different DB file
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { selfTuningDbPath } from "../src/self-tuning/store";
import { retroMarkPoisonedRuns, findPoisonedRuns } from "../src/self-tuning/retro-mark";

function parseArgs(argv: string[]): { apply: boolean; dbPath?: string } {
  let apply = false;
  let dbPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--db") {
      dbPath = argv[++i];
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    }
  }
  return { apply, dbPath };
}

function main(): void {
  const { apply, dbPath } = parseArgs(process.argv.slice(2));
  const resolvedPath = dbPath || selfTuningDbPath();

  console.log(`[retro-mark] db: ${resolvedPath}`);
  console.log(`[retro-mark] mode: ${apply ? "APPLY (writing changes)" : "DRY RUN (no changes will be written)"}`);
  console.log("");

  if (!existsSync(resolvedPath)) {
    console.error(`No database file found at ${resolvedPath}. Refusing to create a fresh, empty self-tuning DB.`);
    process.exitCode = 1;
    return;
  }

  // No options object: on this Bun/Windows build, passing { create: false }
  // (or any options object) to an existing DB file throws SQLITE_MISUSE.
  // The existsSync guard above already ensures the file is real, so the
  // no-arg form here just opens it.
  const db = new Database(resolvedPath);
  try {
    const poisoned = findPoisonedRuns(db);
    if (poisoned.length === 0) {
      console.log("No poisoned runs found. Nothing to do.");
      return;
    }

    console.log(`Found ${poisoned.length} poisoned run(s):`);
    for (const run of poisoned) {
      const preview = (run.final_output ?? "").slice(0, 80).replace(/\n/g, " ");
      console.log(`  - ${run.id}  reason=${run.reason}  outcome=${run.outcome ?? "NULL"}  final_output="${preview}${(run.final_output ?? "").length > 80 ? "..." : ""}"`);
    }
    console.log("");

    const summary = retroMarkPoisonedRuns(db, { apply });

    console.log("Summary:");
    console.log(`  runs marked failed:            ${summary.runsMarked}`);
    console.log(`  synthesizer attributions flipped: ${summary.attributionsFlipped}`);
    console.log(`  agent_performance rows adjusted:  ${summary.performanceRowsAdjusted}`);
    console.log("");
    console.log("Details:");
    for (const line of summary.details) {
      console.log(`  - ${line}`);
    }

    if (!apply) {
      console.log("");
      console.log("This was a DRY RUN — no changes were written. Re-run with --apply to persist them.");
    }
  } finally {
    db.close();
  }
}

main();
