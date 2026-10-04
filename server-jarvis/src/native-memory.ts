// ─── Native memory registry (owned Bun authority, ephemeral) ─────────────────
// Phase 2.2. The owned Bun process receives a private capability and app
// instance id from its native parent, captures and deletes both from
// `process.env` at module evaluation (before any child subprocess can clone
// the environment), and keeps them in module-private state.
//
// This registry is memory-only, bounded, and single-consumption. It never
// reads or writes the native App memory database and never carries recalled
// text into any durable field.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import type {
  MemoryRecallStatus,
  MemoryRuntimeEvidence,
  PreparedMemoryTurn,
} from "./memory-contract";

const CAPABILITY_ENV = "JARVIS_NATIVE_MEMORY_CAPABILITY";
const APP_INSTANCE_ENV = "JARVIS_NATIVE_APP_INSTANCE_ID";

export const NATIVE_MEMORY_UNCONSUMED_CAP = 256;
export const NATIVE_MEMORY_RECEIPT_CAP = 256;
export const NATIVE_MEMORY_BODY_CAP_BYTES = 128 * 1024;
export const NATIVE_MEMORY_EVIDENCE_REF_CAP = 100;
export const NATIVE_MEMORY_EVIDENCE_BYTES_CAP = 64 * 1024;
export const NATIVE_MEMORY_TTL_MS = 120_000;

export interface NativeMemoryBootstrap {
  capability: string;
  appInstanceId: string;
}

export interface RegistrationResult {
  preparation_id: string;
  bun_instance_id: string;
}

export interface ConsumeMemoryRequest {
  preparation_id: string;
  turn_id: string;
  session_id: string;
  message: string;
  active_workspace: string | null;
}

export interface ConsumeMemoryResult {
  envelope: PreparedMemoryTurn | null;
  status: MemoryRecallStatus;
  code?: string;
}

export interface MemoryAppliedObservation {
  stage: string;
  selected_ids: string[];
  status: MemoryRecallStatus;
}

export type MemoryTurnTerminalStatus =
  | "completed"
  | "partial"
  | "cancelled"
  | "failed"
  | "unterminated";

export interface MemoryTerminalObservation {
  terminal_status: MemoryTurnTerminalStatus;
  finished_at: string;
  run_id: string | null;
  error_code: string | null;
}

export interface NativeMemoryRuntimeReceipt {
  preparation_id: string;
  turn_id: string;
  session_id: string;
  message_hash: string;
  app_instance_id: string;
  bun_instance_id: string;
  started_at: string | null;
  finished_at: string | null;
  terminal_status: MemoryTurnTerminalStatus | null;
  run_id: string | null;
  recall_status: MemoryRecallStatus | null;
  error_code: string | null;
  applied_selected_ids: string[];
  runtime_evidence: MemoryRuntimeEvidence[];
}

export interface NativeMemoryRegistry {
  register(envelope: PreparedMemoryTurn): RegistrationResult;
  consume(input: ConsumeMemoryRequest): ConsumeMemoryResult;
  invalidate(reason: string): number;
  observeApplied(preparationId: string, observation: MemoryAppliedObservation): void;
  observeTerminal(preparationId: string, event: MemoryTerminalObservation): void;
  observeToolEvidence(preparationId: string, ref: MemoryRuntimeEvidence): void;
  receipt(id: string): NativeMemoryRuntimeReceipt | null;
  ack(id: string, turnId: string): void;
}

interface UnconsumedEntry {
  envelope: PreparedMemoryTurn;
  turnId: string;
  sessionId: string;
  messageHash: string;
  appInstanceId: string;
  effectiveWorkspace: string | null;
  projectRoot: string | null;
  scopeKind: string;
  expiresAtMonotonic: number;
}

class RegistryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function captureNativeMemoryBootstrap(
  env: Record<string, string | undefined>,
): NativeMemoryBootstrap | null {
  const capability = env[CAPABILITY_ENV];
  const appInstanceId = env[APP_INSTANCE_ENV];
  // Delete before anything else can clone the environment into a child.
  delete env[CAPABILITY_ENV];
  delete env[APP_INSTANCE_ENV];
  if (!capability || !appInstanceId) return null;
  return { capability, appInstanceId };
}

/**
 * Captured at module evaluation, before any tool runtime or child launch.
 * Independent HTTP-only servers have no capability and report unavailable.
 */
export const nativeMemoryBootstrap = captureNativeMemoryBootstrap(process.env);

function nowMonotonic(): number {
  return performance.now();
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function canonicalWorkspace(value: string | null): string | null {
  if (value == null) return null;
  let out = value;
  try {
    out = realpathSync(out);
  } catch {
    // A missing path fails closed in the comparison below.
  }
  out = resolve(out);
  while (out.length > 1 && (out.endsWith(sep) || out.endsWith("/"))) {
    out = out.slice(0, -1);
  }
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyReceipt(
  entry: UnconsumedEntry,
  bunInstanceId: string,
  recallStatus: MemoryRecallStatus,
  errorCode: string | null,
): NativeMemoryRuntimeReceipt {
  return {
    preparation_id: entry.envelope.preparation_id,
    turn_id: entry.turnId,
    session_id: entry.sessionId,
    message_hash: entry.messageHash,
    app_instance_id: entry.appInstanceId,
    bun_instance_id: bunInstanceId,
    started_at: null,
    finished_at: null,
    terminal_status: null,
    run_id: null,
    recall_status: recallStatus,
    error_code: errorCode,
    applied_selected_ids: [],
    runtime_evidence: [],
  };
}

export function createNativeMemoryRegistry(
  bootstrap: NativeMemoryBootstrap | null,
): NativeMemoryRegistry {
  const bunInstanceId = crypto.randomUUID();
  const unconsumed = new Map<string, UnconsumedEntry>();
  const receipts = new Map<string, NativeMemoryRuntimeReceipt>();

  function configured(): boolean {
    return bootstrap !== null;
  }

  function recordFailure(entry: UnconsumedEntry, status: MemoryRecallStatus, code: string): ConsumeMemoryResult {
    unconsumed.delete(entry.envelope.preparation_id);
    receipts.set(entry.envelope.preparation_id, emptyReceipt(entry, bunInstanceId, status, code));
    return { envelope: null, status, code };
  }

  const registry: NativeMemoryRegistry = {
    register(envelope: PreparedMemoryTurn): RegistrationResult {
      if (!configured() || !bootstrap) {
        throw new RegistryError("memory_unavailable", 503, "native memory capability is not configured");
      }
      if (envelope.app_instance_id !== bootstrap.appInstanceId) {
        throw new RegistryError("app_instance_mismatch", 409, "envelope app instance does not match this server");
      }
      if (!envelope.preparation_id || !envelope.turn_id || !envelope.session_id || !envelope.message_hash) {
        throw new RegistryError("invalid_envelope", 400, "envelope is missing required identity fields");
      }
      if (receipts.has(envelope.preparation_id)) {
        throw new RegistryError("already_consumed", 409, "preparation was already consumed");
      }
      const existing = unconsumed.get(envelope.preparation_id);
      if (existing) {
        if (deepEqual(existing.envelope, envelope)) {
          return { preparation_id: envelope.preparation_id, bun_instance_id: bunInstanceId };
        }
        throw new RegistryError("registration_conflict", 409, "preparation id is bound to a different envelope");
      }
      if (unconsumed.size >= NATIVE_MEMORY_UNCONSUMED_CAP) {
        // Never evict an active identity; refuse the new registration.
        throw new RegistryError("registry_full", 507, "unconsumed preparation registry is full");
      }

      const entry: UnconsumedEntry = {
        envelope,
        turnId: envelope.turn_id,
        sessionId: envelope.session_id,
        messageHash: envelope.message_hash,
        appInstanceId: envelope.app_instance_id,
        effectiveWorkspace: envelope.effective_workspace,
        projectRoot: envelope.scope?.project_root ?? null,
        scopeKind: envelope.scope?.kind ?? "agent",
        expiresAtMonotonic: nowMonotonic() + NATIVE_MEMORY_TTL_MS,
      };
      unconsumed.set(envelope.preparation_id, entry);
      return { preparation_id: envelope.preparation_id, bun_instance_id: bunInstanceId };
    },

    consume(input: ConsumeMemoryRequest): ConsumeMemoryResult {
      const entry = unconsumed.get(input.preparation_id);
      if (!entry) {
        if (receipts.has(input.preparation_id)) {
          return { envelope: null, status: "already_consumed", code: "already_consumed" };
        }
        return { envelope: null, status: "unavailable", code: "memory_unavailable" };
      }

      if (nowMonotonic() >= entry.expiresAtMonotonic) {
        return recordFailure(entry, "expired", "expired");
      }

      if (
        entry.turnId !== input.turn_id ||
        entry.sessionId !== input.session_id ||
        entry.messageHash !== sha256Hex(input.message)
      ) {
        return recordFailure(entry, "scope_mismatch", "turn_mismatch");
      }

      if (entry.scopeKind === "project") {
        const active = canonicalWorkspace(input.active_workspace);
        const bound = canonicalWorkspace(entry.projectRoot);
        const effective = canonicalWorkspace(entry.effectiveWorkspace);
        if (
          active == null ||
          bound == null ||
          effective == null ||
          active !== bound ||
          active !== effective
        ) {
          return recordFailure(entry, "scope_mismatch", "scope_mismatch");
        }
      }

      unconsumed.delete(entry.envelope.preparation_id);
      const status: MemoryRecallStatus = entry.envelope.block.length > 0 ? "ready" : "empty";
      const receipt = emptyReceipt(entry, bunInstanceId, status, null);
      receipt.started_at = new Date().toISOString();
      receipts.set(entry.envelope.preparation_id, receipt);
      while (receipts.size > NATIVE_MEMORY_RECEIPT_CAP) {
        const oldest = receipts.keys().next().value;
        if (oldest == null) break;
        receipts.delete(oldest);
      }
      return { envelope: entry.envelope, status };
    },

    invalidate(_reason: string): number {
      const count = unconsumed.size;
      unconsumed.clear();
      return count;
    },

    observeApplied(preparationId: string, observation: MemoryAppliedObservation): void {
      const receipt = receipts.get(preparationId);
      if (!receipt) return;
      if (observation.status) receipt.recall_status = observation.status;
      for (const id of observation.selected_ids) {
        if (!receipt.applied_selected_ids.includes(id)) receipt.applied_selected_ids.push(id);
      }
    },

    observeTerminal(preparationId: string, event: MemoryTerminalObservation): void {
      const receipt = receipts.get(preparationId);
      if (!receipt) return;
      // Preserve the first terminal outcome; duplicate terminal frames are no-ops.
      if (receipt.terminal_status != null) return;
      receipt.terminal_status = event.terminal_status;
      receipt.finished_at = event.finished_at;
      receipt.run_id = event.run_id;
      receipt.error_code = event.error_code;
    },

    observeToolEvidence(preparationId: string, ref: MemoryRuntimeEvidence): void {
      const receipt = receipts.get(preparationId);
      if (!receipt) return;
      if (receipt.runtime_evidence.length >= NATIVE_MEMORY_EVIDENCE_REF_CAP) return;
      const projected = JSON.stringify([...receipt.runtime_evidence, ref]);
      if (Buffer.byteLength(projected, "utf8") > NATIVE_MEMORY_EVIDENCE_BYTES_CAP) return;
      receipt.runtime_evidence.push(ref);
    },

    receipt(id: string): NativeMemoryRuntimeReceipt | null {
      return receipts.get(id) ?? null;
    },

    ack(id: string, turnId: string): void {
      const receipt = receipts.get(id);
      if (receipt && receipt.turn_id === turnId) {
        receipts.delete(id);
      }
    },
  };
  registryById.set(registry, bunInstanceId);
  return registry;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authorized(req: Request, bootstrap: NativeMemoryBootstrap | null): boolean {
  if (!bootstrap) return false;
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === bootstrap.capability;
}

async function readBoundedBody(req: Request): Promise<unknown> {
  const raw = await req.arrayBuffer();
  if (raw.byteLength > NATIVE_MEMORY_BODY_CAP_BYTES) {
    throw new RegistryError("body_too_large", 413, "request body exceeds the internal limit");
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

/**
 * Handle one internal native-memory route. Returns `null` for every path that
 * is not an internal route so the caller can fall through to ordinary CORS
 * handling. Runs before any general OPTIONS/CORS response.
 */
export async function handleNativeMemoryRequest(
  req: Request,
  registry: NativeMemoryRegistry,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/internal/memory")) return null;

  const bootstrap = nativeMemoryBootstrap;
  if (!bootstrap) {
    return json({ code: "memory_unavailable" }, 503);
  }
  if (!authorized(req, bootstrap)) {
    return json({ code: "unauthorized" }, 401);
  }

  try {
    if (path === "/internal/memory/preparations" && req.method === "POST") {
      const body = (await readBoundedBody(req)) as PreparedMemoryTurn;
      const result = registry.register(body);
      return json(result);
    }
    if (path === "/internal/memory/invalidate" && req.method === "POST") {
      const body = (await readBoundedBody(req)) as { app_instance_id?: string; reason?: string };
      const invalidated = registry.invalidate(body.reason ?? "native_mutation");
      return json({ invalidated_count: invalidated, bun_instance_id: registryBunId(registry) });
    }

    const receiptMatch = path.match(/^\/internal\/memory\/turns\/([^/]+)$/);
    if (receiptMatch && req.method === "GET") {
      const receipt = registry.receipt(decodeURIComponent(receiptMatch[1]));
      if (!receipt) return json({ code: "receipt_unavailable" }, 404);
      return json(receipt);
    }
    const ackMatch = path.match(/^\/internal\/memory\/turns\/([^/]+)\/ack$/);
    if (ackMatch && req.method === "POST") {
      const body = (await readBoundedBody(req)) as { turn_id?: string };
      if (typeof body.turn_id !== "string" || body.turn_id.length === 0) {
        return json({ code: "invalid_request" }, 400);
      }
      registry.ack(decodeURIComponent(ackMatch[1]), body.turn_id);
      return json({ ok: true, bun_instance_id: registryBunId(registry) });
    }

    return json({ code: "not_found" }, 404);
  } catch (error) {
    if (error instanceof RegistryError) {
      return json({ code: error.code }, error.status);
    }
    return json({ code: "memory_unavailable" }, 503);
  }
}

// The bun instance id is intentionally private to the registry interface; the
// route handler reads it through this module-private map for invalidation/ack
// responses. It never appears in a durable native field other than the
// registration generation recorded by the native side.
const registryById = new WeakMap<NativeMemoryRegistry, string>();
function registryBunId(registry: NativeMemoryRegistry): string {
  return registryById.get(registry) ?? "";
}
