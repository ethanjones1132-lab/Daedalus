// ─── Native memory registry (owned Bun authority, ephemeral) ─────────────────
// Phase 2.2. The owned Bun process receives a private capability and app
// instance id from its native parent, captures and deletes both from
// `process.env` at module evaluation (before any child subprocess can clone
// the environment), and keeps them in module-private state.
//
// This registry is memory-only, bounded, single-consumption, and never reads
// or writes the native App memory database. It carries no recalled text into
// any durable field or receipt.

import { realpathSync } from "node:fs";

import type {
  MemoryRecallStatus,
  MemoryRuntimeEvidence,
  PreparedMemoryTurn,
} from "./memory-contract";
import { resolveWorkspacePathIdentity } from "./orchestration/path-identity";

const CAPABILITY_ENV = "JARVIS_NATIVE_MEMORY_CAPABILITY";
const APP_INSTANCE_ENV = "JARVIS_NATIVE_APP_INSTANCE_ID";

export const NATIVE_MEMORY_UNCONSUMED_CAP = 256;
export const NATIVE_MEMORY_RECEIPT_CAP = 256;
/**
 * Combined live-identity cap. Each unconsumed preparation becomes a receipt
 * (consume) and then a tombstone (ack/expiry/invalidation), so the total
 * number of tracked identities never exceeds the number of registrations
 * within the retention window. Registering under combined pressure is refused
 * so an unexpired replay tombstone is never evicted to make room.
 */
export const NATIVE_MEMORY_IDENTITY_CAP =
  NATIVE_MEMORY_UNCONSUMED_CAP + NATIVE_MEMORY_RECEIPT_CAP;
export const NATIVE_MEMORY_BODY_CAP_BYTES = 128 * 1024;
export const NATIVE_MEMORY_EVIDENCE_REF_CAP = 100;
export const NATIVE_MEMORY_EVIDENCE_BYTES_CAP = 64 * 1024;
export const NATIVE_MEMORY_TTL_MS = 120_000;

const MAX_ITEMS = 5;
const MAX_ITEM_SCALARS = 600;
const MAX_BLOCK_SCALARS = 4_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface NativeMemoryBootstrap {
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

export interface ResolveTurnMemoryIdentity {
  preparationId: string;
  turnId: string;
  sessionId: string;
  /** Exact current user message; hashed by the registry against the envelope. */
  message: string;
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
  selectedIds: string[];
  expiresAtMonotonic: number;
}

interface ReceiptRecord {
  receipt: NativeMemoryRuntimeReceipt;
  selectedIds: string[];
}

interface Tombstone {
  expiresAtMonotonic: number;
}

interface RegistryMeta {
  bunInstanceId: string;
  capability: string | null;
  appInstanceId: string | null;
  onInvalidate?: (reason: string) => void;
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

function captureBootstrap(
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

// Module-private. Never exported: the production capability must not leak.
const CAPTURED_BOOTSTRAP = captureBootstrap(process.env);

export function nativeMemoryConfigured(): boolean {
  return CAPTURED_BOOTSTRAP !== null;
}

function nowMonotonic(): number {
  return performance.now();
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function scalarLength(value: string): number {
  return [...value].length;
}

/**
 * Canonical workspace identity. An unresolved/realpath-failing root returns
 * null (fails closed); there is no `resolve` fallback that would let a
 * nonexistent path match by string shape. Platform/UNC/WSL normalization is
 * delegated to the shared workspace path-identity helper.
 */
function canonicalWorkspace(value: string | null): string | null {
  if (value == null) return null;
  let real: string;
  try {
    real = realpathSync(value);
  } catch {
    return null;
  }
  return resolveWorkspacePathIdentity(real) ?? null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneReceipt(receipt: NativeMemoryRuntimeReceipt): NativeMemoryRuntimeReceipt {
  return JSON.parse(JSON.stringify(receipt)) as NativeMemoryRuntimeReceipt;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      freezeDeep((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Deep clone and freeze the accepted envelope. The registered snapshot must
 * never alias caller state: a later request mutation cannot change what this
 * registry holds.
 */
function cloneEnvelope(envelope: PreparedMemoryTurn): PreparedMemoryTurn {
  return freezeDeep(JSON.parse(JSON.stringify(envelope)) as PreparedMemoryTurn);
}

function validateEnvelope(envelope: PreparedMemoryTurn): void {
  if (envelope.schema_version !== 1) {
    throw new RegistryError("invalid_envelope", 400, "unsupported envelope schema version");
  }
  if (
    typeof envelope.preparation_id !== "string" ||
    envelope.preparation_id.length === 0 ||
    typeof envelope.turn_id !== "string" ||
    envelope.turn_id.length === 0 ||
    typeof envelope.session_id !== "string" ||
    envelope.session_id.length === 0
  ) {
    throw new RegistryError("invalid_envelope", 400, "envelope is missing identity fields");
  }
  if (typeof envelope.message_hash !== "string" || !SHA256_HEX.test(envelope.message_hash)) {
    throw new RegistryError("invalid_envelope", 400, "envelope message hash is not a valid digest");
  }
  if (!Array.isArray(envelope.selected) || envelope.selected.length > MAX_ITEMS) {
    throw new RegistryError("invalid_envelope", 400, "envelope selection exceeds the item bound");
  }
  if (typeof envelope.block !== "string" || scalarLength(envelope.block) > MAX_BLOCK_SCALARS) {
    throw new RegistryError("invalid_envelope", 400, "envelope block exceeds the scalar bound");
  }
  for (const item of envelope.selected) {
    if (typeof item.text !== "string" || scalarLength(item.text) > MAX_ITEM_SCALARS) {
      throw new RegistryError("invalid_envelope", 400, "envelope item exceeds the scalar bound");
    }
  }
}

export function createNativeMemoryRegistry(
  bootstrap: NativeMemoryBootstrap | null = CAPTURED_BOOTSTRAP,
  onInvalidate?: (reason: string) => void,
): NativeMemoryRegistry {
  const bunInstanceId = crypto.randomUUID();
  const unconsumed = new Map<string, UnconsumedEntry>();
  const receipts = new Map<string, ReceiptRecord>();
  const tombstones = new Map<string, Tombstone>();

  function tombstone(id: string, remainingMs: number, finished: boolean): void {
    const duration = Math.max(remainingMs, finished ? NATIVE_MEMORY_TTL_MS : 0);
    tombstones.set(id, { expiresAtMonotonic: nowMonotonic() + duration });
  }

  function prune(): void {
    for (const [id, entry] of unconsumed) {
      if (nowMonotonic() >= entry.expiresAtMonotonic) {
        tombstone(id, 0, false);
        unconsumed.delete(id);
      }
    }
    const now = nowMonotonic();
    for (const [id, marker] of tombstones) {
      if (now >= marker.expiresAtMonotonic) tombstones.delete(id);
    }
  }

  function makeEntry(envelope: PreparedMemoryTurn): UnconsumedEntry {
    const snapshot = cloneEnvelope(envelope);
    const wallExpiry = Date.parse(snapshot.expires_at);
    if (!Number.isFinite(wallExpiry)) {
      throw new RegistryError("invalid_envelope", 400, "envelope expiry is not a valid timestamp");
    }
    const remaining = Math.min(NATIVE_MEMORY_TTL_MS, wallExpiry - Date.now());
    if (remaining <= 0) {
      throw new RegistryError("expired", 409, "envelope is already expired");
    }
    return {
      envelope: snapshot,
      turnId: snapshot.turn_id,
      sessionId: snapshot.session_id,
      messageHash: snapshot.message_hash,
      appInstanceId: snapshot.app_instance_id,
      effectiveWorkspace: snapshot.effective_workspace,
      projectRoot: snapshot.scope?.project_root ?? null,
      scopeKind: snapshot.scope?.kind ?? "agent",
      selectedIds: snapshot.selected.map((item) => item.selection.id),
      expiresAtMonotonic: nowMonotonic() + remaining,
    };
  }

  function emptyReceipt(
    source: UnconsumedEntry,
    status: MemoryRecallStatus,
    errorCode: string | null,
  ): ReceiptRecord {
    return {
      receipt: {
        preparation_id: source.envelope.preparation_id,
        turn_id: source.turnId,
        session_id: source.sessionId,
        message_hash: source.messageHash,
        app_instance_id: source.appInstanceId,
        bun_instance_id: bunInstanceId,
        started_at: null,
        finished_at: null,
        terminal_status: null,
        run_id: null,
        recall_status: status,
        error_code: errorCode,
        applied_selected_ids: [],
        runtime_evidence: [],
      },
      selectedIds: source.selectedIds,
    };
  }

  function recordFailure(
    source: UnconsumedEntry,
    status: MemoryRecallStatus,
    code: string,
  ): ConsumeMemoryResult {
    unconsumed.delete(source.envelope.preparation_id);
    tombstone(source.envelope.preparation_id, 0, false);
    receipts.set(source.envelope.preparation_id, emptyReceipt(source, status, code));
    return { envelope: null, status, code };
  }

  const registry: NativeMemoryRegistry = {
    register(envelope: PreparedMemoryTurn): RegistrationResult {
      prune();
      if (!bootstrap) {
        throw new RegistryError("memory_unavailable", 503, "native memory capability is not configured");
      }
      validateEnvelope(envelope);
      if (envelope.app_instance_id !== bootstrap.appInstanceId) {
        throw new RegistryError("app_instance_mismatch", 409, "envelope app instance does not match this server");
      }
      const id = envelope.preparation_id;
      if (tombstones.has(id)) {
        throw new RegistryError("already_exists", 409, "preparation id was consumed, invalidated, or expired");
      }
      if (receipts.has(id)) {
        throw new RegistryError("already_consumed", 409, "preparation was already consumed");
      }
      const existing = unconsumed.get(id);
      if (existing) {
        if (deepEqual(existing.envelope, envelope)) {
          return { preparation_id: id, bun_instance_id: bunInstanceId };
        }
        throw new RegistryError("registration_conflict", 409, "preparation id is bound to a different envelope");
      }
      if (
        unconsumed.size >= NATIVE_MEMORY_UNCONSUMED_CAP ||
        receipts.size >= NATIVE_MEMORY_RECEIPT_CAP ||
        unconsumed.size + receipts.size + tombstones.size >= NATIVE_MEMORY_IDENTITY_CAP
      ) {
        // Never evict an active identity or an unexpired replay tombstone;
        // refuse the new registration instead.
        throw new RegistryError("registry_full", 507, "preparation registry cannot reserve capacity");
      }
      unconsumed.set(id, makeEntry(envelope));
      return { preparation_id: id, bun_instance_id: bunInstanceId };
    },

    consume(input: ConsumeMemoryRequest): ConsumeMemoryResult {
      prune();
      const entry = unconsumed.get(input.preparation_id);
      if (!entry) {
        if (receipts.has(input.preparation_id) || tombstones.has(input.preparation_id)) {
          return { envelope: null, status: "already_consumed", code: "already_consumed" };
        }
        return { envelope: null, status: "unavailable", code: "memory_unavailable" };
      }
      if (receipts.size >= NATIVE_MEMORY_RECEIPT_CAP) {
        // Keep the entry consumable later rather than evict an active receipt.
        return { envelope: null, status: "unavailable", code: "receipt_capacity" };
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
      const record = emptyReceipt(entry, status, null);
      record.receipt.started_at = new Date().toISOString();
      receipts.set(entry.envelope.preparation_id, record);
      return { envelope: entry.envelope, status };
    },

    invalidate(reason: string): number {
      prune();
      const count = unconsumed.size;
      for (const [id, entry] of unconsumed) {
        const remaining = Math.max(0, entry.expiresAtMonotonic - nowMonotonic());
        tombstone(id, remaining, false);
      }
      unconsumed.clear();
      onInvalidate?.(reason);
      return count;
    },

    observeApplied(preparationId: string, observation: MemoryAppliedObservation): void {
      const record = receipts.get(preparationId);
      if (!record || record.receipt.started_at == null) return;
      // Applied IDs describe what a live turn actually used; a finished
      // terminal receipt is immutable.
      if (record.receipt.terminal_status != null) return;
      if (observation.status) record.receipt.recall_status = observation.status;
      const allowed = new Set(record.selectedIds);
      for (const id of observation.selected_ids) {
        if (allowed.has(id) && !record.receipt.applied_selected_ids.includes(id)) {
          record.receipt.applied_selected_ids.push(id);
        }
      }
    },

    observeTerminal(preparationId: string, event: MemoryTerminalObservation): void {
      const record = receipts.get(preparationId);
      if (!record) return;
      // Preserve the first terminal outcome; duplicate terminal frames are no-ops.
      if (record.receipt.terminal_status != null) return;
      record.receipt.terminal_status = event.terminal_status;
      record.receipt.finished_at = event.finished_at;
      record.receipt.run_id = event.run_id;
      // A terminal frame with no error must not erase an earlier diagnostic
      // such as `evidence_unavailable`.
      if (event.error_code != null) record.receipt.error_code = event.error_code;
    },

    observeToolEvidence(preparationId: string, ref: MemoryRuntimeEvidence): void {
      const record = receipts.get(preparationId);
      if (!record || record.receipt.started_at == null) return;
      if (record.receipt.terminal_status != null) return;
      if (record.receipt.runtime_evidence.length >= NATIVE_MEMORY_EVIDENCE_REF_CAP) {
        record.receipt.error_code = "evidence_unavailable";
        return;
      }
      const projected = JSON.stringify([...record.receipt.runtime_evidence, ref]);
      if (Buffer.byteLength(projected, "utf8") > NATIVE_MEMORY_EVIDENCE_BYTES_CAP) {
        record.receipt.error_code = "evidence_unavailable";
        return;
      }
      record.receipt.runtime_evidence.push(ref);
    },

    receipt(id: string): NativeMemoryRuntimeReceipt | null {
      const record = receipts.get(id);
      return record ? cloneReceipt(record.receipt) : null;
    },

    ack(id: string, turnId: string): void {
      const record = receipts.get(id);
      if (record && record.receipt.turn_id === turnId) {
        receipts.delete(id);
        tombstone(id, 0, true);
      }
    },
  };

  registryMeta.set(registry, {
    bunInstanceId,
    capability: bootstrap?.capability ?? null,
    appInstanceId: bootstrap?.appInstanceId ?? null,
    onInvalidate,
  });
  return registry;
}

/**
 * Resolve one public reference into the frozen one-shot consume contract.
 * This is the only supported entry point for inference integration: it takes
 * references (never memory text/scope/authority) and lets the registry perform
 * Session/turn/hash/app-instance/TTL/actual-workspace validation atomically.
 * Any missing/invalid reference fails closed with a null envelope.
 */
export function resolveTurnMemory(
  registry: NativeMemoryRegistry,
  identity: ResolveTurnMemoryIdentity,
  activeWorkspace: string | null,
): ConsumeMemoryResult {
  if (
    typeof identity.preparationId !== "string" || identity.preparationId.length === 0 ||
    typeof identity.turnId !== "string" || identity.turnId.length === 0 ||
    typeof identity.sessionId !== "string" || identity.sessionId.length === 0
  ) {
    return { envelope: null, status: "unavailable", code: "memory_unavailable" };
  }
  return registry.consume({
    preparation_id: identity.preparationId,
    turn_id: identity.turnId,
    session_id: identity.sessionId,
    message: identity.message,
    active_workspace: activeWorkspace,
  });
}

const registryMeta = new WeakMap<NativeMemoryRegistry, RegistryMeta>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Read the request body without buffering more than the internal cap. The
 * stream is cancelled as soon as it overflows.
 */
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
      if (total > NATIVE_MEMORY_BODY_CAP_BYTES) {
        await reader.cancel("body_too_large").catch(() => {});
        throw new RegistryError("body_too_large", 413, "request body exceeds the internal limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : {};
}

function bearerAuthorized(req: Request, capability: string | null): boolean {
  if (!capability) return false;
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === capability;
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
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/internal/memory")) return null;

  const meta = registryMeta.get(registry);
  if (!meta || !meta.capability) {
    return json({ code: "memory_unavailable" }, 503);
  }
  if (!bearerAuthorized(req, meta.capability)) {
    return json({ code: "unauthorized" }, 401);
  }

  try {
    if (path === "/internal/memory/preparations" && req.method === "POST") {
      const body = (await readBoundedBody(req)) as PreparedMemoryTurn;
      return json(registry.register(body));
    }
    if (path === "/internal/memory/invalidate" && req.method === "POST") {
      const body = (await readBoundedBody(req)) as { app_instance_id?: string; reason?: string };
      if (typeof body.app_instance_id !== "string" || body.app_instance_id !== meta.appInstanceId) {
        return json({ code: "app_instance_mismatch" }, 409);
      }
      const invalidated = registry.invalidate(body.reason ?? "native_mutation");
      return json({ invalidated_count: invalidated, bun_instance_id: meta.bunInstanceId });
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
      return json({ ok: true, bun_instance_id: meta.bunInstanceId });
    }

    return json({ code: "not_found" }, 404);
  } catch (error) {
    if (error instanceof RegistryError) {
      return json({ code: error.code }, error.status);
    }
    return json({ code: "memory_unavailable" }, 503);
  }
}
