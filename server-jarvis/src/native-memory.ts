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
  ActiveObjective,
  ContinuityMode,
  ContinuityPreview,
  MemoryDerivedInvalidation,
  MemoryRecallStatus,
  MemoryRevalidationResult,
  MemoryRuntimeEvidence,
  MemoryScope,
  PreparedMemoryTurn,
  SessionContinuity,
} from "./memory-contract";
import { MEMORY_REVALIDATION_NOT_REQUIRED, MEMORY_REVALIDATION_REASON_CODES } from "./memory-contract";
import { noteMemoryDerivedActivity } from "./memory-derived-state";
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
/** Phase 4.3 revalidation reason bound (native `MAX_REVALIDATION_REASON_CHARS`). */
const MAX_REVALIDATION_REASON_LENGTH = 128;

const MAX_ITEMS = 5;
const MAX_ITEM_SCALARS = 600;
const MAX_BLOCK_SCALARS = 4_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Content-safety boundary for a replacement objective (native `MAX_OBJECTIVE_BYTES`). */
const MAX_OBJECTIVE_BYTES = 4_096;
const CONTINUITY_MODES = new Set<ContinuityMode>([
  "preserve",
  "resume",
  "replace",
  "clear",
]);
/** Phase 4 conservative statement classifications accepted from native. */
const STATEMENT_KINDS = new Set<string>([
  "normative_constraint",
  "descriptive_fact",
  "unknown",
]);

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

/**
 * Phase 4.2 non-consuming scope probe. References only: the caller supplies
 * the opaque preparation reference plus the immutable Session/turn/message
 * tuple and receives only the authenticated scope. The registered envelope is
 * never consumed, returned, or made mutable by this call.
 */
export interface ScopeCandidateIdentity {
  preparation_id: string;
  turn_id: string;
  session_id: string;
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
  /** Phase 4.3 current-source evidence availability; metadata only. */
  revalidation: MemoryRevalidationResult;
}

export interface NativeMemoryRegistry {
  register(envelope: PreparedMemoryTurn): RegistrationResult;
  consume(input: ConsumeMemoryRequest): ConsumeMemoryResult;
  invalidate(reason: string): number;
  observeApplied(preparationId: string, observation: MemoryAppliedObservation): void;
  observeTerminal(preparationId: string, event: MemoryTerminalObservation): void;
  observeToolEvidence(preparationId: string, ref: MemoryRuntimeEvidence): void;
  /** Attach Phase 4.3 current-source evidence availability before terminal. */
  observeRevalidation(preparationId: string, result: MemoryRevalidationResult): void;
  receipt(id: string): NativeMemoryRuntimeReceipt | null;
  ack(id: string, turnId: string): void;
  /**
   * Authenticated, non-consuming scope probe. Returns the registered
   * envelope's scope only when the immutable tuple (Session, turn, exact UTF-8
   * message hash), process generation, expiry, and invalidation state all
   * validate; otherwise null. Never consumes or exposes recalled text.
   */
  inspectScopeCandidate(identity: ScopeCandidateIdentity): MemoryScope | null;
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

const REVALIDATION_STATES = new Set<string>([
  "not_required",
  "required",
  "fresh_evidence",
  "unavailable",
]);

function malformedRevalidation(): MemoryRevalidationResult {
  return {
    state: "unavailable",
    memory_ids: [],
    evidence_tool_call_ids: [],
    reason_code: "malformed_receipt",
  };
}

/**
 * Defensive bound of one revalidation result before it can be attached to a
 * receipt. The native side re-validates against the immutable turn tuple; this
 * only prevents a malformed Bun computation from being persisted verbatim.
 * Ids are checked against the turn's prepared selection and this turn's
 * recorded evidence refs.
 */
function sanitizeRevalidation(
  result: MemoryRevalidationResult,
  record: ReceiptRecord,
): MemoryRevalidationResult {
  if (typeof result !== "object" || result === null || !REVALIDATION_STATES.has(result.state)) {
    return malformedRevalidation();
  }
  const allowedIds = new Set(record.selectedIds);
  const allowedEvidence = new Set(record.receipt.runtime_evidence.map((ref) => ref.tool_call_id));
  const ids = (value: unknown, allowed: Set<string>): string[] | null => {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const id of value) {
      if (typeof id !== "string" || id.length === 0 || id.length > MAX_DERIVED_ID_LENGTH) return null;
      if (!allowed.has(id)) return null;
      out.push(id);
    }
    return out;
  };
  const memoryIds = ids(result.memory_ids, allowedIds);
  const evidenceIds = ids(result.evidence_tool_call_ids, allowedEvidence);
  if (!memoryIds || !evidenceIds) return malformedRevalidation();
  let reason: string | null = null;
  if (result.reason_code !== null && result.reason_code !== undefined) {
    if (
      typeof result.reason_code !== "string" ||
      result.reason_code.length === 0 ||
      result.reason_code.length > MAX_REVALIDATION_REASON_LENGTH ||
      !MEMORY_REVALIDATION_REASON_CODES.has(result.reason_code)
    ) {
      return malformedRevalidation();
    }
    reason = result.reason_code;
  }
  if (result.state === "fresh_evidence" && evidenceIds.length === 0) return malformedRevalidation();
  if (
    result.state === "not_required" &&
    (memoryIds.length > 0 || evidenceIds.length > 0 || reason !== null)
  ) {
    return malformedRevalidation();
  }
  return {
    state: result.state,
    memory_ids: memoryIds,
    evidence_tool_call_ids: evidenceIds,
    reason_code: reason,
  };
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
    // Phase 4: a registered native envelope must carry a valid conservative
    // statement classification on every selection. Inference and arbitrary
    // /chat/stream fields can never supply this value.
    const selection = item.selection as unknown;
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
      throw new RegistryError("invalid_envelope", 400, "envelope selection is not an object");
    }
    const statementKind = (selection as Record<string, unknown>).statement_kind;
    if (typeof statementKind !== "string" || !STATEMENT_KINDS.has(statementKind)) {
      throw new RegistryError(
        "invalid_envelope",
        400,
        "envelope selection statement kind is invalid",
      );
    }
  }
  // Optional private continuity preview. An HTTP-only caller must not be able to
  // smuggle one in, and an explicit `null` is rejected (native `None` OMITS the
  // field). It is validated here (session identity, revisions, ids, text bound,
  // dependency ids, mode-specific shape, unknown fields) and rejected outright
  // on any mismatch.
  if (envelope.continuity === null) {
    throw new RegistryError("invalid_envelope", 400, "continuity must be omitted, not null");
  }
  if (envelope.continuity !== undefined) {
    validateContinuityPreview(envelope, envelope.continuity);
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoundedId(value: unknown): value is string {
  return isNonemptyString(value) && value.length <= MAX_DERIVED_ID_LENGTH;
}

/**
 * Strictly validate the native-created continuity preview carried in a
 * registered envelope. The snapshot Session must match the envelope Session,
 * the revision must be a safe integer >= 1, ids must be bounded and nonempty,
 * dependency entries must be bounded nonempty strings, arrays must be bounded,
 * unknown fields are rejected, and the mode-specific objective shape is
 * enforced. Any violation fails registration rather than trusting a partial
 * payload.
 */
function validateContinuityPreview(
  envelope: PreparedMemoryTurn,
  preview: ContinuityPreview,
): void {
  if (typeof preview !== "object" || preview === null || Array.isArray(preview)) {
    throw new RegistryError("invalid_envelope", 400, "continuity payload is not an object");
  }
  const previewRecord = preview as unknown as Record<string, unknown>;
  for (const key of Object.keys(previewRecord)) {
    if (key !== "snapshot" && key !== "mode") {
      throw new RegistryError("invalid_envelope", 400, "continuity payload has an unknown field");
    }
  }
  if (typeof preview.mode !== "string" || !CONTINUITY_MODES.has(preview.mode as ContinuityMode)) {
    throw new RegistryError("invalid_envelope", 400, "continuity mode is not recognized");
  }
  const mode = preview.mode as ContinuityMode;
  const snapshot = preview.snapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new RegistryError("invalid_envelope", 400, "continuity snapshot is not an object");
  }
  const snapshotRecord = snapshot as unknown as Record<string, unknown>;
  for (const key of Object.keys(snapshotRecord)) {
    if (
      key !== "session_id" &&
      key !== "active_objective" &&
      key !== "latest_turn_id" &&
      key !== "revision"
    ) {
      throw new RegistryError("invalid_envelope", 400, "continuity snapshot has an unknown field");
    }
  }
  const typed = snapshot as SessionContinuity;
  if (!isNonemptyString(typed.session_id) || typed.session_id !== envelope.session_id) {
    throw new RegistryError("invalid_envelope", 400, "continuity session does not match envelope");
  }
  if (!Number.isSafeInteger(typed.revision) || typed.revision < 1) {
    throw new RegistryError("invalid_envelope", 400, "continuity revision is not a positive integer");
  }
  if (typed.latest_turn_id !== null && !isBoundedId(typed.latest_turn_id)) {
    throw new RegistryError("invalid_envelope", 400, "continuity latest turn id is invalid");
  }
  // Mode-specific objective shape. `clear` requires a null active objective;
  // preserve/resume/replace require a valid one.
  const objective = typed.active_objective;
  if (mode === "clear") {
    if (objective !== null) {
      throw new RegistryError("invalid_envelope", 400, "clear continuity requires a null objective");
    }
    return;
  }
  if (objective === null || objective === undefined) {
    throw new RegistryError("invalid_envelope", 400, "continuity mode requires an active objective");
  }
  validateActiveObjective(envelope, objective, mode, typed.latest_turn_id);
}

function validateActiveObjective(
  envelope: PreparedMemoryTurn,
  objective: ActiveObjective,
  mode: ContinuityMode,
  latestTurnId: string | null | undefined,
): void {
  if (typeof objective !== "object" || objective === null || Array.isArray(objective)) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective is not an object");
  }
  const objectiveRecord = objective as unknown as Record<string, unknown>;
  for (const key of Object.keys(objectiveRecord)) {
    if (
      key !== "text" &&
      key !== "source_message_id" &&
      key !== "source_turn_id" &&
      key !== "depends_on_memory_ids"
    ) {
      throw new RegistryError("invalid_envelope", 400, "continuity objective has an unknown field");
    }
  }
  if (!isNonemptyString(objective.text) || objective.text.trim().length === 0) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective text is required");
  }
  if (Buffer.byteLength(objective.text, "utf8") > MAX_OBJECTIVE_BYTES) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective text exceeds the bound");
  }
  if (!isBoundedId(objective.source_message_id)) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective source id is required");
  }
  if (objective.source_turn_id !== null && !isBoundedId(objective.source_turn_id)) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective turn id is invalid");
  }
  if (!Array.isArray(objective.depends_on_memory_ids)) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective dependencies are invalid");
  }
  if (objective.depends_on_memory_ids.length > MAX_DERIVED_ARRAY_ENTRIES) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective dependencies exceed the bound");
  }
  if (objective.depends_on_memory_ids.some((id) => !isBoundedId(id))) {
    throw new RegistryError("invalid_envelope", 400, "continuity objective dependencies are invalid");
  }
  // A `replace` preview must refer to THIS turn: its source turn and the
  // snapshot's latest turn must both name the envelope turn. Preserve/resume
  // may legitimately carry an earlier accepted source.
  if (mode === "replace") {
    if (objective.source_turn_id !== envelope.turn_id || latestTurnId !== envelope.turn_id) {
      throw new RegistryError("invalid_envelope", 400, "replace continuity is not bound to this turn");
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
        revalidation: { ...MEMORY_REVALIDATION_NOT_REQUIRED },
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
      const entry = makeEntry(envelope);
      // Track activity BEFORE the registry side effect. If the epoch cannot be
      // persisted the registration is withheld, so no derived context can be
      // created whose invalidation would be untracked.
      noteMemoryDerivedActivity(envelope.session_id);
      unconsumed.set(id, entry);
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

      // Track activity BEFORE consuming (the registry side effect). A failure
      // withholds the consume; the entry stays registered and the caller fails
      // closed rather than building derived prompt state with no epoch.
      noteMemoryDerivedActivity(entry.sessionId);
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

    observeRevalidation(preparationId: string, result: MemoryRevalidationResult): void {
      const record = receipts.get(preparationId);
      if (!record || record.receipt.started_at == null) return;
      // Availability metadata is only meaningful before the terminal outcome;
      // a finished receipt is immutable.
      if (record.receipt.terminal_status != null) return;
      record.receipt.revalidation = sanitizeRevalidation(result, record);
    },

    receipt(id: string): NativeMemoryRuntimeReceipt | null {
      const record = receipts.get(id);
      return record ? cloneReceipt(record.receipt) : null;
    },

    inspectScopeCandidate(identity: ScopeCandidateIdentity): MemoryScope | null {
      prune();
      if (!bootstrap) return null;
      if (
        typeof identity.preparation_id !== "string" || identity.preparation_id.length === 0 ||
        typeof identity.turn_id !== "string" || identity.turn_id.length === 0 ||
        typeof identity.session_id !== "string" || identity.session_id.length === 0
      ) {
        return null;
      }
      const entry = unconsumed.get(identity.preparation_id);
      // A consumed/invalidated/expired preparation is absent here (or already
      // tombstoned), so a replay of an old reference cannot select a root.
      if (!entry) return null;
      if (nowMonotonic() >= entry.expiresAtMonotonic) return null;
      if (entry.turnId !== identity.turn_id || entry.sessionId !== identity.session_id) return null;
      if (entry.messageHash !== sha256Hex(identity.message)) return null;
      // Process generation: the envelope must belong to THIS Bun instance.
      if (entry.appInstanceId !== bootstrap.appInstanceId) return null;
      const scope = entry.envelope.scope;
      if (typeof scope !== "object" || scope === null) return null;
      return { kind: scope.kind, agent_id: scope.agent_id, project_root: scope.project_root };
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

function bearerAuthorized(req: Request, capability: string | null): boolean {  if (!capability) return false;
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === capability;
}

/**
 * Strictly validate the capability-only `derived` payload. EXACTLY the four
 * frozen fields; a malformed array, oversized array, malformed entry, empty
 * operation id, non-namespaced operation key, or unknown field is rejected
 * (never filtered to success) so the native gate cannot receive an ACK for an
 * ill-formed cleanup request. An EMPTY `affected_session_ids` array is a
 * legitimate no-op accepted by the cleanup module.
 */
const MAX_DERIVED_ID_LENGTH = 1024;
const MAX_DERIVED_OPERATION_LENGTH = 2048;
const MAX_DERIVED_ARRAY_ENTRIES = 8192;
const DERIVED_FIELDS = new Set([
  "operation_id",
  "affected_session_ids",
  "memory_ids",
  "source_message_ids",
]);
const NAMESPACED_DERIVED_OPERATION = /^session\/(.+)\/operation\/(.+)$/;

function parseDerivedInvalidation(value: unknown): MemoryDerivedInvalidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RegistryError("invalid_derived", 400, "derived payload is not an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!DERIVED_FIELDS.has(key)) {
      throw new RegistryError("invalid_derived", 400, "derived payload has an unknown field");
    }
  }
  const operationId = record.operation_id;
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new RegistryError("invalid_derived", 400, "derived operation id is required");
  }
  if (operationId.length > MAX_DERIVED_OPERATION_LENGTH) {
    throw new RegistryError("invalid_derived", 400, "derived operation id exceeds the bound");
  }
  if (!NAMESPACED_DERIVED_OPERATION.test(operationId)) {
    throw new RegistryError("invalid_derived", 400, "derived operation id is not native-namespaced");
  }
  const arrayField = (field: string): string[] => {
    const raw = record[field];
    if (!Array.isArray(raw)) {
      throw new RegistryError("invalid_derived", 400, `derived ${field} is not an array`);
    }
    if (raw.length > MAX_DERIVED_ARRAY_ENTRIES) {
      throw new RegistryError("invalid_derived", 400, `derived ${field} exceeds the bound`);
    }
    for (const entry of raw) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new RegistryError("invalid_derived", 400, `derived ${field} has an invalid entry`);
      }
      if (entry.length > MAX_DERIVED_ID_LENGTH) {
        throw new RegistryError("invalid_derived", 400, `derived ${field} entry exceeds the bound`);
      }
    }
    return raw as string[];
  };
  return {
    operation_id: operationId,
    affected_session_ids: arrayField("affected_session_ids"),
    memory_ids: arrayField("memory_ids"),
    source_message_ids: arrayField("source_message_ids"),
  };
}

/**
 * Handle one internal native-memory route. Returns `null` for every path that
 * is not an internal route so the caller can fall through to ordinary CORS
 * handling. Runs before any general OPTIONS/CORS response.
 */
export async function handleNativeMemoryRequest(
  req: Request,
  registry: NativeMemoryRegistry,
  onDerivedInvalidate?: (input: MemoryDerivedInvalidation) => void,
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
      const body = (await readBoundedBody(req)) as {
        app_instance_id?: string;
        reason?: string;
        derived?: unknown;
      };
      if (typeof body.app_instance_id !== "string" || body.app_instance_id !== meta.appInstanceId) {
        return json({ code: "app_instance_mismatch" }, 409);
      }
      // Synchronous derived cleanup runs BEFORE the ACK. A thrown cleanup
      // failure is caught below and answers 503, so the native gate never
      // receives an ACK for incomplete cleanup. The `derived` payload, when
      // present, is validated strictly inside the callback.
      if (body.derived !== undefined && body.derived !== null) {
        if (!onDerivedInvalidate) {
          return json({ code: "memory_unavailable" }, 503);
        }
        onDerivedInvalidate(parseDerivedInvalidation(body.derived));
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
