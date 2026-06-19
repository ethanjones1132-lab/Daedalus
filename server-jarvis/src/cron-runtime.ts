// ═══════════════════════════════════════════════════════════════
// ── P2B-01: Cron Runtime Adapter ──
// ═══════════════════════════════════════════════════════════════
// Binds cron runs to the canonical ToolRuntime via file-backed
// projection snapshots and a non-interactive ExecutionContext.
//
// Acceptance contract:
//   • Cron runs bind a projection snapshot at start via restoreBoundary().
//   • ExecutionContext is always surface:"cron", interactive:false.
//   • All tool dispatch goes through ToolRuntime.execute() — never
//     the legacy executeTool() from tools.ts.
//   • Policy evaluation is enforced by the ToolRuntime before every call.

import type { JarvisConfig } from "./config";
import {
  makeExecutionContext,
  type ToolRuntime,
  type ToolCall,
  type ToolResult,
  type ExecutionContext,
} from "./tool-runtime";
import {
  restoreBoundary,
  type ProjectionSnapshot,
  type ActivationBoundary,
} from "./activation-boundary";

// ── Request / Context Types ───────────────────────────────────────────────────

/**
 * Pa