// ═══════════════════════════════════════════════════════════════
// ── P2B-01: Cron Runtime Adapter ──
// ═══════════════════════════════════════════════════════════════
// Binds cron runs to the canonical ToolRuntime via file-backed
// projection snapshots and a non-interactive ExecutionContext.

import { mkdirSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
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

export interface RetryOptions {
  /** Maximum execution attempts for this cron run. Defaults to 3. */
  maxAttempts?: number;
  /** Milliseconds to wait between attempts. Defaults to 1000. */
  retryDelayMs?: number;
  /**
   * Optional runtime to reuse across attempts. When provided, the retry runner
   * does not re-register the standard bundles, allowing stateful tools to
   * retain state between attempts.
   */
  runtime?: ToolRuntime;
}

export interface CronRunResult {
  ok: boolean;
  slug: string;
  boundary: ActivationBoundary;
  results: ToolResult[];
  error?: string;
}

/** Durable execution evidence shared by cron and action-registry runs. */
export interface ExecutionEvidence {
  run_id: string;
  status: "success" | "failed" | "cancelled" | "timeout";
  started_at: string;
  finished_at: string;
  acceptance_result?: string;
  error_code?: string;
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

function evidenceDir(cfg: JarvisConfig): string {
  const base = cfg.jarvis_path?.trim() || join(homedir(), ".openclaw", "jarvis");
  return join(base, "cron-evidence");
}

function persistEvidence(evidence: ExecutionEvidence, cfg: JarvisConfig): void {
  try {
    const dir = evidenceDir(cfg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${evidence.run_id}.json`),
      JSON.stringify(evidence, null, 2),
    );
  } catch (e) {
    // Evidence persistence is best-effort audit; it must not break execution.
    console.error("[CronRuntime] failed to persist execution evidence:", e);
  }
}

function classifyStatus(result: CronRunResult): ExecutionEvidence["status"] {
  if (result.ok) return "success";
  const timedOut = result.results.some(
    (r) =>
      r.is_error &&
      (r.error_code === "handler_error" || !r.error_code) &&
      /timed out/i.test(r.error || ""),
  );
  return timedOut ? "timeout" : "failed";
}

function buildEvidence(result: CronRunResult, run_id: string): ExecutionEvidence {
  const status = classifyStatus(result);
  const failed = result.results.find((r) => r.is_error);
  const evidence: ExecutionEvidence = {
    run_id,
    status,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  };

  if (status === "success") {
    evidence.acceptance_result = result.results
      .map((r) => r.output)
      .join("\n")
      .slice(0, 500);
  } else {
    evidence.error_code = failed?.error_code || status;
    evidence.acceptance_result = failed?.error || result.error || status;
  }

  return evidence;
}

export async function runCronRequest(
  req: CronRunRequest,
  cfg: JarvisConfig,
  runtime?: ToolRuntime,
): Promise<CronRunResult> {
  const boundary = restoreBoundary(req.slug);
  const rt: ToolRuntime = runtime ?? createToolRuntime();
  if (!runtime) registerStandardBundles(rt);
  const ctx = makeExecutionContext("cron", cfg, {
    interactive: false,
    workspace_path: cfg.jarvis_path,
  });

  const results: ToolResult[] = [];
  for (const call of req.tools) {
    try {
      const result = await executeWithTimeout(rt, call, ctx);
      results.push(result);
    } catch (e: any) {
      results.push({
        call_id: call.id,
        name: call.name,
        output: "",
        is_error: true,
        error: e?.message ?? String(e),
        error_code: "handler_error",
        duration_ms: 0,
      });
    }
  }

  return {
    ok: results.every((result) => !result.is_error),
    slug: req.slug,
    boundary,
    results,
  };
}

/**
 * Run a cron request with bounded retries, producing durable `ExecutionEvidence`
 * for every attempt. Failed evidence is persisted to disk before the next attempt
 * so operators can reconstruct the retry trail even if the process restarts.
 *
 * The runner stops as soon as an attempt succeeds or the maximum number of
 * attempts is exhausted.
 */
export async function runCronWithRetries(
  req: CronRunRequest,
  cfg: JarvisConfig,
  opts: RetryOptions = {},
): Promise<ExecutionEvidence[]> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 1000);
  const runtime = opts.runtime ?? createToolRuntime();
  if (!opts.runtime) registerStandardBundles(runtime);

  const evidenceList: ExecutionEvidence[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const run_id = randomUUID();
    const startedAt = new Date().toISOString();
    const result = await runCronRequest(req, cfg, runtime);
    const evidence: ExecutionEvidence = {
      ...buildEvidence(result, run_id),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };

    persistEvidence(evidence, cfg);
    evidenceList.push(evidence);

    if (result.ok || attempt === maxAttempts) break;
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return evidenceList;
}
