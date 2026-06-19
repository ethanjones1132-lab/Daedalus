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
 * Parameters for a single cron run.
 *
 * `projection_snapshot` is captured by the Rust native surface from its
 * SQLite `agent_projections` table and sent inline so the Bun server never
 * needs to open the Tauri DB file directly.
 */
export interface CronRunRequest {
  /** Cron job identifier (matches SQLite cron_jobs.id). */
  job_id: string;
      /** The prompt to execute against the LLM. */
  prompt: string;
  /** Optional agent slug identifying which agent owns this run. */
  agent_id?: string;
  /**
   * Projection snapshot captured by the Rust native surface.
   * When present, an activation boundary is established before the run begins,
   * binding this run to the captured projection version.
   */
  projection_snapshot?: ProjectionSnapshot;
      session_id?: string;
  workspace_path?: string;
}

/**
 * The bound state established once at cron run start.
 * Immutable for the lifetime of the run — tool dispatch always uses this ctx.
 */
export interface CronRunContext {
  /** Non-interactive execution context (surface: "cron", interactive: false). */
      ctx: ExecutionContext;
  /**
   * Activation boundary bound at run start.
   * Absent when no projection snapshot was provided.
   */
  boundary?: ActivationBoundary;
  /**
   * Snapshot captured from the boundary at bind time.
   * Absent when no projection snapshot was provided.
   */
      boundary_snapshot?: ProjectionSnapshot;
}

// ── Runtime Interface ─────────────────────────────────────────────────────────

export interface CronRuntime {
  /**
   * Prepare the activation boundary and execution context for a cron run.
   *
   * Must be called exactly once at run start before any tool dispatch.
       * The returned `CronRunContext` is the canonical state for this run's
   * lifetime — all `executeToolViaRuntime()` calls must use it.
   */
  prepare(req: CronRunRequest): CronRunContext;

  /**
   * Execute a tool call through the canonical ToolRuntime using the
   * cron non-interactive execution context.
   *
   * This is the ONLY approved dispatch path for cron tool calls.
       * Never calls legacy `executeTool()` — policy is always evaluated.
   */
  executeToolViaRuntime(
    call: ToolCall,
    cronCtx: CronRunContext,
  ): Promise<ToolResult>;
}

// ── Failure Classification (P2B-02) ──────────────────────────────────────────

   /**
 * Classification of a cron run outcome.
 * Determines retry eligibility and UI-visible diagnostic labels.
 */
export type CronFailureClass =
  | "success"          // No failure — run completed normally.
  | "transient_error"  // Retriable: network error, HTTP 429/503.
  | "permanent_error"  // Non-retriable: auth, invalid args, unexpected.
  | "timeout"          // Run exceeded configured timeout or was aborted.
  | "policy_denied"    // Tool call denied by runtime permission policy.
     | "tool_not_found";  // Tool name not registered in canonical runtime.

/**
 * Structured result of a complete cron run.
 * Captures outcome, tool dispatch history, and retry eligibility.
 * Intended to be persisted in run history and surfaced in the UI.
 */
export interface CronRunResult {
  job_id: string;
  status: "success" | "failed";
     /** Populated on failure; absent when status is "success". */
  failure_class?: CronFailureClass;
  failure_message?: string;
  /** Final accumulated output from the inference loop, if any. */
  output?: string;
  /** All tool dispatch attempts with their policy outcomes. */
  tool_dispatches: Array<{
    tool: string;
    policy: "allow" | "deny";
    denial_reason?: string;
     }>;
  /** Wall-clock milliseconds from prepare() to completion. */
  duration_ms: number;
  /** How many times this job has been retried (0 = first attempt). */
  retry_count: number;
  /** Maximum retries configured for this job (0 = no retries). */
  max_retries: number;
  /** Whether the failure class supports retry. Always false for "success". */
  retry_allowed: boolean;
}
   
// ── Signal tables (used by classifyFailure) ───────────────────────────────────

const TRANSIENT_SIGNALS = [
  "econnrefused",
  "fetch failed",
  "network",
  "etimedout",
  "socket hang up",
  "connection reset",
     " 429",
... 133 lines not shown ...