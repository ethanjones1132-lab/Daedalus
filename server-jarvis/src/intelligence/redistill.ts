#!/usr/bin/env bun
/**
 * Redistill skill candidates from stored trajectory snapshots.
 * 
 * Usage: bun run src/intelligence/redistill.ts --agent-run-id=<id> [--status=success|degraded|failed]
 *        bun run src/intelligence/redistill.ts --session-id=<id>
 *        bun run src/intelligence/redistill.ts --all [--status=...]
 * 
 * Reads trajectory_snapshots from the self-tuning DB, runs the distiller,
 * and writes/updates skill candidates in ~/.openclaw/jarvis/skills/candidates/
 */

import { distillFromTrajectorySnapshot } from "./skill-distiller";
import type { SkillDistillationConfig } from "../config";
import { loadConfig } from "../config";
import { SelfTuningStore, type TrajectorySnapshot } from "../self-tuning/store";

interface CliArgs {
  agentRunId?: string;
  sessionId?: string;
  all?: boolean;
  status?: "success" | "degraded" | "failed";
  dryRun?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--agent-run-id=")) {
      args.agentRunId = arg.slice("--agent-run-id=".length);
    } else if (arg.startsWith("--session-id=")) {
      args.sessionId = arg.slice("--session-id=".length);
    } else if (arg.startsWith("--status=")) {
      args.status = arg.slice("--status=".length) as "success" | "degraded" | "failed";
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
Redistill skill candidates from trajectory snapshots.

Usage:
  bun run src/intelligence/redistill.ts --agent-run-id=<id> [--status=success|degraded|failed] [--dry-run]
  bun run src/intelligence/redistill.ts --session-id=<id> [--status=...] [--dry-run]
  bun run src/intelligence/redistill.ts --all [--status=...] [--dry-run]

Options:
  --agent-run-id=<id>    Redistill from a specific agent run ID
  --session-id=<id>      Redistill all trajectories from a session
  --all                  Redistill all stored trajectories
  --status=success|degraded|failed  Filter by run_outcome (default: success)
  --dry-run              Show what would be distilled without writing
  --help, -h             Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  const distillCfg: SkillDistillationConfig = cfg.orchestrator.skill_distillation ?? {
    enabled: true,
    min_confidence: 0.55,
    promotion_eval_delta: 0.02,
    max_candidates: 200,
    distill_on: ["success"],
  };

  const store = new SelfTuningStore();
  const snapshots: TrajectorySnapshot[] = [];

  if (args.agentRunId) {
    // Get trajectories for a specific agent run
    const all = store.getTrajectorySnapshots(1000);
    snapshots.push(...all.filter((s) => s.agent_run_id === args.agentRunId));
  } else if (args.sessionId) {
    // Get trajectories for a specific session
    const all = store.getTrajectorySnapshots(1000);
    snapshots.push(...all.filter((s) => s.session_id === args.sessionId));
  } else if (args.all) {
    snapshots.push(...store.getTrajectorySnapshots(1000));
  } else {
    printUsage();
    process.exit(1);
  }

  if (snapshots.length === 0) {
    console.log("No matching trajectory snapshots found.");
    return;
  }

  // Filter by status if specified
  const filtered = args.status
    ? snapshots.filter((s) => {
        try {
          const traj = JSON.parse(s.snapshot_json);
          return traj.run_outcome === args.status;
        } catch {
          return false;
        }
      })
    : snapshots;

  console.log(`Found ${filtered.length} trajectory snapshot(s) to process.`);

  let distilled = 0;
  let skipped = 0;
  let errors = 0;

  for (const snapshot of filtered) {
    try {
      const candidate = distillFromTrajectorySnapshot({ snapshot, config: distillCfg });
      if (candidate) {
        distilled++;
        if (args.dryRun) {
          console.log(`  [DRY-RUN] Would create candidate: ${candidate.name} (confidence: ${candidate.confidence.toFixed(2)})`);
        } else {
          console.log(`  ✓ Created candidate: ${candidate.name} (confidence: ${candidate.confidence.toFixed(2)})`);
        }
      } else {
        skipped++;
        if (args.dryRun) {
          console.log(`  [DRY-RUN] Skipped: no candidate produced (outcome filter or confidence threshold)`);
        }
      }
    } catch (e) {
      errors++;
      console.error(`  ✗ Error processing snapshot ${snapshot.id}:`, e);
    }
  }

  console.log(`\nDone. Distilled: ${distilled}, Skipped: ${skipped}, Errors: ${errors}`);
  
  if (!args.dryRun && distilled > 0) {
    console.log("\nRun promotion pass to evaluate candidates:");
    console.log("  bun run src/intelligence/promote.ts");
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});