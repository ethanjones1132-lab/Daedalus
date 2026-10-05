// ═══════════════════════════════════════════════════════════════
// ── Trusted Action Execution (Roadmap Priority #2, Part 4) ──
// ═══════════════════════════════════════════════════════════════
// Executes the exact native-selected calls of one registered trusted manifest
// through the canonical ToolRuntime. Reached only over the private
// capability-authenticated `/internal/trusted/*` routes; the caller
// (native-memory route handler) has already verified the app bearer capability.
//
// This module never:
//   * accepts tool calls/arguments/checks from UI, Goal, model, or Action
//     Registry text — only the native request's manifest calls are executed;
//   * sets `skip_approval_gate`, invents a grant, or requests approval;
//   * calls shell or a direct command executor.
// A tool the current Permission policy denies, or that needs interactive
// approval in this unattended context, is reported as blocked/waiting WITHOUT
// being invoked. A successful tool run never verifies the Action Registry and
// never completes a Goal.

import { createHash, randomUUID } from "node:crypto";
import type { JarvisConfig } from "./config";
import {
  createToolRuntime,
  evaluatePolicy,
  makeExecutionContext,
  type ExecutionContext,
} from "./tool-runtime";
import { registerStandardBundles } from "./bundles-registry";

export interface TrustedExecutionCall {
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface TrustedExecutionRequest {
  execution_id: string;
  action_id: string;
  manifest_id: string;
  manifest_registry_version: number;
  manifest_content_hash: string;
  manifest_schema_version: number;
  agent_id: string;
  project_root: string;
  projection_slug: string;
  projection_source_hash: string;
  projection_active_source_hash: string;
  projection_version: number;
  calls: TrustedExecutionCall[];
  timeout_ms: number;
  max_calls: number;
}

export interface TrustedExecutionCallEvidence {
  index: number;
  tool: string;
  status: "ok" | "error" | "denied" | "waiting";
  output_sha256?: string;
  output_bytes?: number;
  error_code?: string;
  reason?: string;
}

export interface TrustedExecutionResponse {
  execution_id: string;
  bun_instance_id: string;
  run_id: string;
  outcome: "executed" | "blocked" | "waiting_for_user" | "failed" | "cancelled" | "partial";
  reason?: string;
  calls: TrustedExecutionCallEvidence[];
  started_at: string;
  finished_at: string;
}

export interface TrustedAcceptanceCheck {
  criterion_id: string;
  index: number;
  tool: string;
  arguments?: Record<string, unknown>;
  expect_sha256: string;
}

export interface TrustedAcceptanceRequest {
  acceptance_id: string;
  execution_id: string;
  action_id: string;
  manifest_id: string;
  manifest_registry_version: number;
  manifest_content_hash: string;
  manifest_schema_version: number;
  agent_id: string;
  project_root: string;
  timeout_ms: number;
  max_checks: number;
  checks: TrustedAcceptanceCheck[];
}

export interface TrustedAcceptanceCheckEvidence {
  criterion_id: string;
  index: number;
  tool: string;
  status: "ok" | "error" | "denied" | "waiting";
  output_sha256?: string;
  output_bytes?: number;
  matched: boolean;
  error_code?: string;
  reason?: string;
}

export interface TrustedAcceptanceResponse {
  acceptance_id: string;
  bun_instance_id: string;
  run_id: string;
  outcome:
    | "accepted"
    | "rejected"
    | "blocked"
    | "waiting_for_user"
    | "failed"
    | "cancelled"
    | "partial";
  reason?: string;
  calls: TrustedAcceptanceCheckEvidence[];
  started_at: string;
  finished_at: string;
}

/** Deterministic execution allowlist. Writers are execution-only by design. */
const EXECUTION_TOOLS = new Set([
  "read_file",
  "list_directory",
  "glob",
  "grep",
  "write_file",
  "edit_file",
]);

/** Acceptance checks are strictly read-only and deterministic. */
const ACCEPTANCE_TOOLS = new Set(["read_file", "list_directory", "glob", "grep"]);

const MAX_CALLS = 50;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES_PER_CALL = 4 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 16 * 1024;
const PER_CALL_TIMEOUT_MS = 120_000;
const WHOLE_RUN_TIMEOUT_MS = 600_000;
const TRUSTED_BODY_CAP_BYTES = 256 * 1024;

/** execution_id → real AbortController for the in-flight run. */
const inFlight = new Map<string, AbortController>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBoundedBody(req: Request): Promise<unknown> {
  const body = req.body;
  if (!body) return {};
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > TRUSTED_BODY_CAP_BYTES) {
        await reader.cancel("body_too_large").catch(() => {});
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : {};
}

function isControlFree(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0 || code < 0x20) return false;
  }
  return true;
}

function isRelativePath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  if (value.startsWith("/") || value.startsWith("\\") || value.startsWith("//")) return false;
  if (value.length >= 2 && value[1] === ":") return false;
  if (!isControlFree(value)) return false;
  for (const segment of value.split(/[\\/]+/)) {
    if (segment === "..") return false;
  }
  return true;
}

function payloadOk(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_PAYLOAD_BYTES && !value.includes("\0");
}

/**
 * Defense-in-depth re-validation of the bounded per-tool argument shape. The
 * native side already validated the manifest; this refuses to execute anything
 * that does not match the exact allowlisted shape.
 */
function validateCallArguments(tool: string, args: Record<string, unknown>): string | null {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(args, key);
  const path = typeof args.path === "string" ? args.path : undefined;
  switch (tool) {
    case "read_file":
      if (!path || !isRelativePath(path)) return "read_file requires a workspace-relative 'path'";
      return null;
    case "list_directory":
      if (!path || !isRelativePath(path)) return "list_directory requires a workspace-relative 'path'";
      return null;
    case "glob":
      if (typeof args.pattern !== "string" || args.pattern.trim().length === 0) return "glob requires 'pattern'";
      if (has("path") && (!path || !isRelativePath(path))) return "glob 'path' must be workspace-relative";
      return null;
    case "grep":
      if (typeof args.pattern !== "string" || args.pattern.trim().length === 0) return "grep requires 'pattern'";
      if (has("path") && (!path || !isRelativePath(path))) return "grep 'path' must be workspace-relative";
      return null;
    case "write_file":
      if (!path || !isRelativePath(path)) return "write_file requires a workspace-relative 'path'";
      if (!payloadOk(args.content)) return "write_file 'content' exceeds the bounded payload";
      return null;
    case "edit_file":
      if (!path || !isRelativePath(path)) return "edit_file requires a workspace-relative 'path'";
      if (!payloadOk(args.old_string) || (args.old_string as string).length === 0) return "edit_file 'old_string' is invalid";
      if (!payloadOk(args.new_string)) return "edit_file 'new_string' exceeds the bounded payload";
      return null;
    default:
      return `tool '${tool}' is not in the execution allowlist`;
  }
}

function bounded(value: string | undefined, limit = MAX_EVIDENCE_BYTES_PER_CALL): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}

async function executeTrusted(
  request: TrustedExecutionRequest,
  cfg: JarvisConfig,
  bunInstanceId: string,
): Promise<TrustedExecutionResponse> {
  const startedAt = new Date().toISOString();
  const runId = `trusted_${randomUUID()}`;
  const calls = Array.isArray(request.calls) ? request.calls : [];
  const respond = (
    outcome: TrustedExecutionResponse["outcome"],
    reason: string | undefined,
    evidence: TrustedExecutionCallEvidence[],
  ): TrustedExecutionResponse => ({
    execution_id: request.execution_id,
    bun_instance_id: bunInstanceId,
    run_id: runId,
    outcome,
    reason,
    calls: evidence,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  if (calls.length === 0 || calls.length > MAX_CALLS) {
    return respond("blocked", "execution call list is empty or exceeds the bound", []);
  }
  if (inFlight.has(request.execution_id)) {
    return respond("blocked", "an execution with this identity is already in progress", []);
  }

  const controller = new AbortController();
  inFlight.set(request.execution_id, controller);
  const requestedTimeout = Number(request.timeout_ms);
  const wholeRunTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, WHOLE_RUN_TIMEOUT_MS)
    : WHOLE_RUN_TIMEOUT_MS;
  const deadlineAt = Date.now() + wholeRunTimeout;
  const deadlineTimer = setTimeout(() => controller.abort("trusted_timeout"), wholeRunTimeout);

  const runtime = createToolRuntime();
  registerStandardBundles(runtime);

  const evidence: TrustedExecutionCallEvidence[] = [];
  let outcome: TrustedExecutionResponse["outcome"] = "executed";
  let reason: string | undefined;
  let evidenceBytes = 0;

  try {
    for (let index = 0; index < calls.length; index += 1) {
      if (controller.signal.aborted) {
        outcome = "cancelled";
        reason = "execution cancelled";
        break;
      }
      const call = calls[index];
      const tool = call && typeof call.tool === "string" ? call.tool : "";
      if (!EXECUTION_TOOLS.has(tool)) {
        evidence.push({ index, tool, status: "denied", error_code: "tool_not_allowed", reason: "tool is not in the execution allowlist" });
        outcome = "blocked";
        reason = "a call requested a non-allowlisted tool";
        break;
      }
      const args =
        call && call.arguments && typeof call.arguments === "object"
          ? (call.arguments as Record<string, unknown>)
          : {};
      const argError = validateCallArguments(tool, args);
      if (argError) {
        evidence.push({ index, tool, status: "denied", error_code: "invalid_arguments", reason: argError });
        outcome = "blocked";
        reason = argError;
        break;
      }
      const def = runtime.listTools().find((d) => d.function.name === tool);
      if (!def) {
        evidence.push({ index, tool, status: "denied", error_code: "unknown_tool", reason: "tool is not registered" });
        outcome = "blocked";
        reason = "a call requested an unregistered tool";
        break;
      }

      const remaining = Math.max(1, deadlineAt - Date.now());
      const ctx: ExecutionContext = makeExecutionContext("agent", cfg, {
        interactive: false,
        workspace_path: request.project_root,
        timeout_ms: Math.min(remaining, PER_CALL_TIMEOUT_MS),
        signal: controller.signal,
      });

      // Evaluate policy BEFORE invoking so a denial or unattended approval
      // requirement is persisted without running the tool. `skip_approval_gate`
      // is never set and no approval hook is wired.
      const policy = evaluatePolicy(def, ctx);
      if (policy.decision !== "allow") {
        const needsUser =
          policy.decision === "ask" ||
          policy.source === "approval_non_interactive" ||
          policy.source === "tool_requires_approval" ||
          policy.source === "config_requires_approval";
        evidence.push({
          index,
          tool,
          status: needsUser ? "waiting" : "denied",
          error_code: policy.decision === "ask" ? "approval_required" : "policy_denied",
          reason: bounded(policy.reason || policy.source),
        });
        outcome = needsUser ? "waiting_for_user" : "blocked";
        reason = policy.reason || policy.source;
        break;
      }

      const result = await runtime.execute({ id: `trusted-${index}`, name: tool, arguments: args }, ctx);
      if (result.is_error) {
        evidence.push({
          index,
          tool,
          status: "error",
          error_code: result.error_code,
          reason: bounded(result.error || result.output || "tool execution failed"),
        });
        if (result.error_code === "cancelled") {
          outcome = "cancelled";
          reason = "execution cancelled";
        } else if (result.error_code === "timeout") {
          outcome = "failed";
          reason = "execution deadline exceeded";
        } else {
          outcome = "failed";
          reason = result.error || result.output || "tool execution failed";
        }
        break;
      }

      const output = typeof result.output === "string" ? result.output : String(result.output ?? "");
      const outputBytes = Buffer.byteLength(output, "utf8");
      const outputSha256 = createHash("sha256").update(output, "utf8").digest("hex");
      evidenceBytes += Math.min(outputBytes, MAX_EVIDENCE_BYTES_PER_CALL);
      evidence.push({ index, tool, status: "ok", output_sha256: outputSha256, output_bytes: outputBytes });
      if (evidenceBytes >= MAX_TOTAL_EVIDENCE_BYTES && index < calls.length - 1) {
        // Some declared calls were skipped: never report full success, so this
        // can never be persisted as `pending_acceptance`.
        outcome = "partial";
        reason = "execution evidence budget reached; remaining calls were not run";
        break;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    inFlight.delete(request.execution_id);
  }

  if (
    controller.signal.aborted &&
    outcome !== "waiting_for_user" &&
    outcome !== "blocked" &&
    outcome !== "cancelled"
  ) {
    if (controller.signal.reason === "trusted_timeout") {
      outcome = "failed";
      reason = "execution deadline exceeded";
    } else {
      outcome = "cancelled";
      reason = "execution cancelled";
    }
  }

  return respond(outcome, reason, evidence);
}

/**
 * Route one already-capability-authenticated `/internal/trusted/*` request.
 * `bunInstanceId` is included in every response so native can detect a replaced
 * child. Returns null for unrelated paths.
 */
async function executeTrustedAcceptance(
  request: TrustedAcceptanceRequest,
  cfg: JarvisConfig,
  bunInstanceId: string,
): Promise<TrustedAcceptanceResponse> {
  const startedAt = new Date().toISOString();
  const runId = `acceptance_${randomUUID()}`;
  const checks = Array.isArray(request.checks) ? request.checks : [];
  const respond = (
    outcome: TrustedAcceptanceResponse["outcome"],
    reason: string | undefined,
    evidence: TrustedAcceptanceCheckEvidence[],
  ): TrustedAcceptanceResponse => ({
    acceptance_id: request.acceptance_id,
    bun_instance_id: bunInstanceId,
    run_id: runId,
    outcome,
    reason,
    calls: evidence,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  if (checks.length === 0 || checks.length > 500) {
    return respond("blocked", "acceptance check list is empty or exceeds the bound", []);
  }
  const inflightKey = `accept:${request.acceptance_id}`;
  if (inFlight.has(inflightKey)) {
    return respond("blocked", "an acceptance attempt with this identity is already in progress", []);
  }
  const controller = new AbortController();
  inFlight.set(inflightKey, controller);
  const requestedTimeout = Number(request.timeout_ms);
  const wholeRunTimeout =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, WHOLE_RUN_TIMEOUT_MS)
      : WHOLE_RUN_TIMEOUT_MS;
  const deadlineAt = Date.now() + wholeRunTimeout;
  const deadlineTimer = setTimeout(() => controller.abort("trusted_timeout"), wholeRunTimeout);

  const runtime = createToolRuntime();
  registerStandardBundles(runtime);

  const evidence: TrustedAcceptanceCheckEvidence[] = [];
  let outcome: TrustedAcceptanceResponse["outcome"] = "accepted";
  let reason: string | undefined;
  let evidenceBytes = 0;

  try {
    for (let index = 0; index < checks.length; index += 1) {
      if (controller.signal.aborted) {
        outcome = "cancelled";
        reason = "acceptance cancelled";
        break;
      }
      const check = checks[index];
      const tool = check && typeof check.tool === "string" ? check.tool : "";
      const criterionId = check && typeof check.criterion_id === "string" ? check.criterion_id : "";
      const checkIndex = check && typeof check.index === "number" ? check.index : index;
      const deny = (error_code: string, why: string, waiting = false): void => {
        evidence.push({
          criterion_id: criterionId,
          index: checkIndex,
          tool,
          status: waiting ? "waiting" : "denied",
          matched: false,
          error_code,
          reason: bounded(why),
        });
        outcome = waiting ? "waiting_for_user" : "blocked";
        reason = why;
      };

      if (!ACCEPTANCE_TOOLS.has(tool)) {
        deny("tool_not_allowed", "tool is not in the read-only acceptance allowlist");
        break;
      }
      const args =
        check && check.arguments && typeof check.arguments === "object"
          ? (check.arguments as Record<string, unknown>)
          : {};
      const argError = validateCallArguments(tool, args);
      if (argError) {
        deny("invalid_arguments", argError);
        break;
      }
      const def = runtime.listTools().find((d) => d.function.name === tool);
      if (!def) {
        deny("unknown_tool", "tool is not registered");
        break;
      }
      const remaining = Math.max(1, deadlineAt - Date.now());
      const ctx: ExecutionContext = makeExecutionContext("agent", cfg, {
        interactive: false,
        workspace_path: request.project_root,
        timeout_ms: Math.min(remaining, PER_CALL_TIMEOUT_MS),
        signal: controller.signal,
      });
      const policy = evaluatePolicy(def, ctx);
      if (policy.decision !== "allow") {
        const needsUser =
          policy.decision === "ask" ||
          policy.source === "approval_non_interactive" ||
          policy.source === "tool_requires_approval" ||
          policy.source === "config_requires_approval";
        deny(
          policy.decision === "ask" ? "approval_required" : "policy_denied",
          policy.reason || policy.source,
          needsUser,
        );
        break;
      }

      const result = await runtime.execute({ id: `acceptance-${index}`, name: tool, arguments: args }, ctx);
      if (result.is_error) {
        evidence.push({
          criterion_id: criterionId,
          index: checkIndex,
          tool,
          status: "error",
          matched: false,
          error_code: result.error_code,
          reason: bounded(result.error || result.output || "acceptance check failed"),
        });
        if (result.error_code === "cancelled") {
          outcome = "cancelled";
          reason = "acceptance cancelled";
        } else if (result.error_code === "timeout") {
          outcome = "failed";
          reason = "acceptance deadline exceeded";
        } else {
          outcome = "rejected";
          reason = result.error || result.output || "acceptance check failed";
        }
        break;
      }

      const output = typeof result.output === "string" ? result.output : String(result.output ?? "");
      const outputBytes = Buffer.byteLength(output, "utf8");
      const outputSha256 = createHash("sha256").update(output, "utf8").digest("hex");
      const matched =
        typeof check.expect_sha256 === "string" && outputSha256 === check.expect_sha256;
      evidence.push({
        criterion_id: criterionId,
        index: checkIndex,
        tool,
        status: "ok",
        output_sha256: outputSha256,
        output_bytes: outputBytes,
        matched,
      });
      evidenceBytes += Math.min(outputBytes, MAX_EVIDENCE_BYTES_PER_CALL);
      if (!matched) {
        outcome = "rejected";
        reason = "acceptance check output did not match the trusted expectation";
        break;
      }
      if (evidenceBytes >= MAX_TOTAL_EVIDENCE_BYTES && index < checks.length - 1) {
        outcome = "partial";
        reason = "acceptance evidence budget reached; remaining checks were not run";
        break;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    inFlight.delete(inflightKey);
  }

  if (
    controller.signal.aborted &&
    outcome !== "waiting_for_user" &&
    outcome !== "blocked" &&
    outcome !== "cancelled" &&
    outcome !== "rejected" &&
    outcome !== "partial"
  ) {
    if (controller.signal.reason === "trusted_timeout") {
      outcome = "failed";
      reason = "acceptance deadline exceeded";
    } else {
      outcome = "cancelled";
      reason = "acceptance cancelled";
    }
  }

  return respond(outcome, reason, evidence);
}

export async function handleTrustedExecutionRequest(
  req: Request,
  cfg: JarvisConfig,
  bunInstanceId: string,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;

  if (path === "/internal/trusted/cancel" && req.method === "POST") {
    let executionId = "";
    try {
      const body = (await readBoundedBody(req)) as { execution_id?: unknown };
      if (typeof body.execution_id === "string") executionId = body.execution_id;
    } catch {
      return json({ cancelled: false, bun_instance_id: bunInstanceId }, 400);
    }
    const controller = executionId ? inFlight.get(executionId) : undefined;
    if (controller) {
      controller.abort("trusted_cancel");
      return json({ cancelled: true, bun_instance_id: bunInstanceId });
    }
    return json({ cancelled: false, bun_instance_id: bunInstanceId });
  }

  if (path === "/internal/trusted/execute" && req.method === "POST") {
    let request: TrustedExecutionRequest;
    try {
      request = (await readBoundedBody(req)) as TrustedExecutionRequest;
    } catch {
      return json({ code: "invalid_request" }, 400);
    }
    if (!request || typeof request.execution_id !== "string" || request.execution_id.length === 0) {
      return json({ code: "invalid_request" }, 400);
    }
    const response = await executeTrusted(request, cfg, bunInstanceId);
    return json(response);
  }

  if (path === "/internal/trusted/acceptance" && req.method === "POST") {
    let request: TrustedAcceptanceRequest;
    try {
      request = (await readBoundedBody(req)) as TrustedAcceptanceRequest;
    } catch {
      return json({ code: "invalid_request" }, 400);
    }
    if (
      !request ||
      typeof request.acceptance_id !== "string" ||
      request.acceptance_id.length === 0
    ) {
      return json({ code: "invalid_request" }, 400);
    }
    const response = await executeTrustedAcceptance(request, cfg, bunInstanceId);
    return json(response);
  }

  return null;
}
