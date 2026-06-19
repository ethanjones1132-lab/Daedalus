// ═══════════════════════════════════════════════════════════════
// ── P2B-01: Cron Runtime Tests ──
// ═══════════════════════════════════════════════════════════════
// Verifies that cron runs:
//   1. Bind a projection snapshot at run start (via restoreBoundary)
//   2. Always create a non-interactive ExecutionContext (surface: "cron")
//   3. Route all tool calls through the canonical ToolRuntime
//   4. Never bypass policy evaluation (approval/dangerous rules enforced)

import { describe, expect, it } from "bun:test";
import { createCronRuntime } from "./cron-runtime";
import type { CronRunRequest } from "./cron-runtime";
import { createToolRuntime } from "./tool-runtime";
import type { ToolDefinition } from "./tool-runtime";
import { defaultConfig } from "./config";
import type { ProjectionSnapshot } from "./activation-boundary";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(overrides?: Partial<ProjectionSnapshot>): ProjectionSnapshot {
  return {
    slug: "test-agent",
    so