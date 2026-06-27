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
    results.push(await runtime.execute(call, ctx));
  }

  return {
    ok: results.every((result) => !result.is_error),
    slug: req.slug,
    boundary,
    results,
  };
}
