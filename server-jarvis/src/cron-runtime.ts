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
import { OrchestrationAdmissionController, type AdmissionLease } from "./orchestration/admission-controller";

export interface CronRunRequest {
  slug: string;
  prompt: string;
  tools: ToolCall[];
  config?: Partial<JarvisConfig>;
}

export interface CronRunOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
}

export interface RetryOptions extends CronRunOptions {
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
  status?: "cancelled" | "timeout";
  queue_wait_ms?: number;
}

/** Durable execution evidence shared by cron and action-registry runs. */
export interface ExecutionEvidence {
  run_id: string;
  status: "success" | "failed" | "cancelled" | "timeout" | "background_deferred";
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
const CRON_TIMEOUT_REASON = "cron_timeout";
const CRON_CANCEL_REASON = "cron_cancelled";
const cronAdmission = new OrchestrationAdmissionController({ interactive: 2, background: 1 });

function statusForSignal(signal: AbortSignal | undefined): "cancelled" | "timeout" | undefined {
  if (!signal?.aborted) return undefined;
  return signal.reason === CRON_TIMEOUT_REASON ? "timeout" : "cancelled";
}

async function executeWithTimeout(
  runtime: ToolRuntime,
  call: ToolCall,
  ctx: ExecutionContext,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  controller: AbortController | undefined,
): Promise<{ result: ToolResult; status?: "cancelled" | "timeout" }> {
  const initialStatus = statusForSignal(signal);
  if (initialStatus) {
    return {
      result: {
        call_id: call.id,
        name: call.name,
        output: "",
        is_error: true,
        error: initialStatus === "timeout" ? "Cron execution deadline exceeded" : "Cron execution cancelled",
        error_code: initialStatus === "timeout" ? "timeout" : "cancelled",
        duration_ms: 0,
      },
      status: initialStatus,
    };
  }

  const execution = runtime.execute(call, ctx);
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let stopResolve: ((status: "cancelled" | "timeout") => void) | undefined;
  const stopPromise = new Promise<"cancelled" | "timeout">((resolve) => {
    stopResolve = resolve;
  });
  const onAbort = (): void => stopResolve?.(statusForSignal(signal) ?? "cancelled");
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  const effectiveDeadline = Math.min(
    Date.now() + CRON_TOOL_TIMEOUT_MS,
    deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  stopTimer = setTimeout(() => {
    controller?.abort(CRON_TIMEOUT_REASON);
    stopResolve?.("timeout");
  }, Math.max(0, effectiveDeadline - Date.now()));

  const outcome = await Promise.race([
    execution.then((result) => ({ kind: "result" as const, result })),
    stopPromise.then((status) => ({ kind: "stop" as const, status })),
  ]);
  if (signal) signal.removeEventListener("abort", onAbort);
  if (stopTimer) clearTimeout(stopTimer);

  const stoppedResult = (stoppedStatus: "cancelled" | "timeout"): {
    result: ToolResult;
    status: "cancelled" | "timeout";
  } => ({
    result: {
      call_id: call.id,
      name: call.name,
      output: "",
      is_error: true,
      error: stoppedStatus === "timeout"
        ? `Cron tool execution timed out after ${CRON_TOOL_TIMEOUT_MS}ms`
        : "Cron execution cancelled",
      error_code: stoppedStatus === "timeout" ? "timeout" : "cancelled",
      duration_ms: 0,
    },
    status: stoppedStatus,
  });
  if (outcome.kind === "result") {
    const resultStatus = statusForSignal(signal);
    if (!resultStatus) return { result: outcome.result };
    controller?.abort(resultStatus === "timeout" ? CRON_TIMEOUT_REASON : CRON_CANCEL_REASON);
    await execution.catch(() => undefined);
    return stoppedResult(resultStatus);
  }
  controller?.abort(outcome.status === "timeout" ? CRON_TIMEOUT_REASON : CRON_CANCEL_REASON);
  await execution.catch(() => undefined);
  return stoppedResult(outcome.status);
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
  if (result.error === "background_deferred") return "background_deferred";
  if (result.status) return result.status;
  const timedOut = result.results.some(
    (r) =>
      r.is_error &&
      (r.error_code === "timeout" || r.error_code === "handler_error" || !r.error_code) &&
      (r.error_code === "timeout" || /timed out|timeout/i.test(r.error || "")),
  );
  if (timedOut) return "timeout";
  const cancelled = result.results.some((r) => r.is_error && r.error_code === "cancelled");
  return cancelled ? "cancelled" : "failed";
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
    evidence.error_code = result.status || failed?.error_code || status;
    evidence.acceptance_result = result.error || failed?.error || status;
  }

  return evidence;
}

export async function runCronRequest(
  req: CronRunRequest,
  cfg: JarvisConfig,
  runtime?: ToolRuntime,
  options: CronRunOptions = {},
): Promise<CronRunResult> {
  const boundary = restoreBoundary(req.slug);
  const rt: ToolRuntime = runtime ?? createToolRuntime();
  if (!runtime) registerStandardBundles(rt);
  const deadlineAt = options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs)
    ? Date.now() + Math.max(0, options.deadlineMs)
    : undefined;
  const controller = new AbortController();
  let requestedStatus: "cancelled" | "timeout" | undefined;
  const abort = (status: "cancelled" | "timeout"): void => {
    requestedStatus ??= status;
    if (!controller.signal.aborted) {
      controller.abort(status === "timeout" ? CRON_TIMEOUT_REASON : CRON_CANCEL_REASON);
    }
  };
  const onExternalAbort = (): void => abort("cancelled");
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const deadlineTimer = deadlineAt !== undefined
    ? setTimeout(() => abort("timeout"), Math.max(0, deadlineAt - Date.now()))
    : undefined;
  const signal = controller.signal;
  const cleanup = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  };
  const stopped = (): "cancelled" | "timeout" | undefined => {
    return requestedStatus
      ?? statusForSignal(signal)
      ?? (deadlineAt !== undefined && Date.now() >= deadlineAt ? "timeout" : undefined);
  };
  const stopResult = (status: "cancelled" | "timeout"): CronRunResult => ({
    ok: false,
    slug: req.slug,
    boundary,
    results: [],
    status,
    error: status === "timeout" ? "Cron execution deadline exceeded" : "Cron execution cancelled",
  });

  const initialStop = stopped();
  if (initialStop) {
    cleanup();
    return stopResult(initialStop);
  }

  const ctx = makeExecutionContext("cron", cfg, {
    interactive: false,
    workspace_path: cfg.jarvis_path,
    signal,
  });

  let lease: AdmissionLease;
  try {
    lease = await cronAdmission.acquire({
      workClass: "background",
      signal,
      deadlineAt: deadlineAt ?? Date.now() + CRON_TOOL_TIMEOUT_MS,
    });
  } catch {
    const status = stopped() ?? "failed";
    cleanup();
    if (status === "cancelled" || status === "timeout") return stopResult(status);
    return {
      ok: false,
      slug: req.slug,
      boundary,
      results: [],
      error: "background_deferred",
    };
  }

  const results: ToolResult[] = [];
  let status: "cancelled" | "timeout" | undefined;
  try {
    for (const call of req.tools) {
      status = stopped();
      if (status) break;
      try {
        const execution = await executeWithTimeout(rt, call, ctx, signal, deadlineAt, controller);
        results.push(execution.result);
        if (execution.status) {
          status = execution.status;
          break;
        }
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
  } finally {
    lease.release();
  }
  cleanup();

  return {
    ok: !status && results.every((result) => !result.is_error),
    slug: req.slug,
    boundary,
    results,
    status,
    error: status === "timeout"
      ? "Cron execution deadline exceeded"
      : status === "cancelled"
        ? "Cron execution cancelled"
        : undefined,
    queue_wait_ms: lease.queue_wait_ms,
  };
}

function waitForRetryDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<boolean> {
  if (signal?.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt)) {
    return Promise.resolve(false);
  }
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(false);
    const remaining = deadlineAt === undefined ? delayMs : Math.min(delayMs, deadlineAt - Date.now());
    timer = setTimeout(() => finish(deadlineAt === undefined || Date.now() < deadlineAt), Math.max(0, remaining));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function runCronWithRetries(
  req: CronRunRequest,
  cfg: JarvisConfig,
  opts: RetryOptions = {},
): Promise<ExecutionEvidence[]> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 1000);
  const runtime = opts.runtime ?? createToolRuntime();
  if (!opts.runtime) registerStandardBundles(runtime);
  const signal = opts.signal;
  const deadlineAt = opts.deadlineMs !== undefined && Number.isFinite(opts.deadlineMs)
    ? Date.now() + Math.max(0, opts.deadlineMs)
    : undefined;

  const evidenceList: ExecutionEvidence[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt)) break;
    const run_id = randomUUID();
    const startedAt = new Date().toISOString();
    const remaining = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
    const result = await runCronRequest(req, cfg, runtime, {
      signal,
      deadlineMs: remaining,
    });
    const evidence: ExecutionEvidence = {
      ...buildEvidence(result, run_id),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };

    persistEvidence(evidence, cfg);
    evidenceList.push(evidence);

    if (result.ok || result.status || attempt === maxAttempts || signal?.aborted) break;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) break;
    if (retryDelayMs > 0 && !(await waitForRetryDelay(retryDelayMs, signal, deadlineAt))) break;
  }

  return evidenceList;
}
