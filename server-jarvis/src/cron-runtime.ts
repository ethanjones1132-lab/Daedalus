// ═══════════════════════════════════════════════════════════════
// ── P2B-01: Cron Runtime Adapter ──
// ═══════════════════════════════════════════════════════════════
// Binds cron runs to the canonical ToolRuntime via file-backed
// projection snapshots and a non-interactive ExecutionContext.

import type { JarvisConfig } from "./config";
import {
  createToolRuntime,
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
import { registerStandardBundles } from "./bundles-registry";

export interface CronRunRequest {
  slug: string;
  prompt: string;
  tools: ToolCall[];
  config?: Partial<JarvisConfig>;
}

export interface CronRunResult {
  ok: boolean;
  slug: string;
  boundary: ActivationBoundary;
  results: ToolResult[];
  error?: string;
}

export function createCronRuntime(
  cfg: JarvisConfig,
  snapshot?: ProjectionSnapshot,
): { runtime: ToolRuntime; ctx: ExecutionContext; boundary: ActivationBoundary } {
  const boundary = snapshot
    ? { slug: snapshot.slug || "cron", snapshot }
    : restoreBoundary("cron");
  const runtime: ToolRuntime = createToolRuntime();
  registerStandardBundles(runtime);
  const ctx = makeExecutionContext("cron", cfg, {
    interactive: false,
    workspace_path: cfg.jarvis_path,
  });
  return { runtime, ctx, boundary };
}

/**
 * Per-tool execution timeout for cron runs (ms). Default 900_000 = 15 min
 * to accommodate OpenRouter free-tier variance. Override via
 * JARVIS_CRON_TOOL_TIMEOUT_MS env var.
 * NOTE: Hermes cron infra has a 600s (600_000ms) idle watchdog that can
 * kill the job before this timeout fires. Set env var accordingly.
 */
const CRON_TOOL_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.JARVIS_CRON_TOOL_TIMEOUT_MS ?? 900_000) || 900_000,
);

/**
 * Execute a single tool call with a timeout.
 * If the tool hangs beyond CRON_TOOL_TIMEOUT_MS, we return an error result
 * rather than leaving the cron job idle until the Hermes watchdog kills it.
 */
async function executeWithTimeout(
  runtime: ToolRuntime,
  call: ToolCall,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  const result = await Promise.race([
    runtime.execute(call, ctx),
    new Promise<ToolResult>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Cron tool execution timed out after ${CRON_TOOL_TIMEOUT_MS}ms`)),
        CRON_TOOL_TIMEOUT_MS,
      ),
    ),
  ]);
  return result;
}

export async function runCronRequest(req: CronRunRequest, cfg: JarvisConfig): Promise<CronRunResult> {
  const boundary = restoreBoundary(req.slug);
  const runtime: ToolRuntime = createToolRuntime();
  registerStandardBundles(runtime);
  const ctx = makeExecutionContext("cron", cfg, {
    interactive: false,
    workspace_path: cfg.jarvis_path,
  });

  const results: ToolResult[] = [];
  for (const call of req.tools) {
    try {
      const result = await executeWithTimeout(runtime, call, ctx);
      results.push(result);
    } catch (e: any) {
      results.push({
        is_error: true,
        content: [{ type: "text", text: e?.message ?? String(e) }],
      } as ToolResult);
    }
  }

  return {
    ok: results.every((result) => !result.is_error),
    slug: req.slug,
    boundary,
    results,
  };
}
