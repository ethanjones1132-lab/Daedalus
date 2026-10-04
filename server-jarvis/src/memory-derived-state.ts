// ─── Memory-derived prompt state invalidation (Phase 3.2) ───────────────────
// Capability-only scoped cleanup for derived prompt state. It rides the
// existing private `/internal/memory/invalidate` route (one authenticated
// round trip): the route first drops unconsumed preparations, then synchronously
// evicts derived prompt state for the affected Sessions, and only then ACKs.
//
// Native namespaces the wire `operation_id` as
// `session/<session_id>/operation/<operation_id>`. Cleanup replay is guarded by
// a persisted per-Session activity epoch: a namespaced operation is only an
// idempotent no-op when no new memory-derived activity and no expanded
// consumer/source coverage has appeared since it completed. If the native side
// committed nothing (Bun ACKed, native commit failed), the retried operation
// re-runs cleanup for the newly derived activity before ACKing again.
//
// Every cleanup MUST synchronously finish its required durable persistence
// before returning. The private route withholds its ACK when this throws, so a
// live owned Bun that cannot persist cleanup blocks the native mutation. It
// evicts only memory-derived prompt state: independent tool results, file
// snapshots, check evidence, permissions, and unrelated TaskRuns keep their own
// lifecycle.

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

import { writeJsonAtomic } from "./orchestration/session-runtime-persistence";
import type { MemoryDerivedInvalidation } from "./memory-contract";

/**
 * Host hooks the derived-state module drives during invalidation. Each hook
 * must synchronously complete its own durable cleanup and throw on failure.
 */
export interface MemoryDerivedStateHost {
  /** Evict memory-derived Session caches while preserving independent evidence. */
  evictSessionDerivedState(sessionId: string, invalidation: MemoryDerivedInvalidation): void;
  /** Drop conductor conversation/compaction/prompt-cache carriers. */
  evictConductorSession(sessionId: string): void;
}

/**
 * Typed "we cannot prove safe derived state" failure. A corrupt/unreadable or
 * mismatched persisted watermark raises this so the caller fails closed instead
 * of silently treating a bad marker as fresh.
 */
export class MemoryDerivedStateUnavailableError extends Error {
  readonly code = "memory_derived_unavailable";
  constructor(reason: string) {
    super(`memory_derived_unavailable:${reason}`);
    this.name = "MemoryDerivedStateUnavailableError";
  }
}

const MAX_DERIVED_ID_LENGTH = 1024;
const MAX_DERIVED_OPERATION_LENGTH = 2048;
const MAX_DERIVED_ARRAY_ENTRIES = 8192;

/** The wire operation key is always native-namespaced exactly once. */
const NAMESPACED_OPERATION = /^session\/(.+)\/operation\/(.+)$/;

/**
 * Coverage for one completed namespaced operation. `activity` is the Session
 * activity epoch at completion; `memoryIds`/`sourceMessageIds` are the union of
 * ids the operation has already cleaned. A later retry with the same key is a
 * no-op only when the epoch has not advanced and the requested ids are already
 * covered.
 */
interface AppliedOperationCoverage {
  key: string;
  activity: number;
  memoryIds: string[];
  sourceMessageIds: string[];
}

interface SessionInvalidationRecord {
  sessionId: string;
  /** Monotonic invalidation generation for late-write guards. */
  watermark: number;
  /** Monotonic memory-derived activity epoch for cleanup replay. */
  activity: number;
  /** Completed namespaced operations and the coverage they achieved. */
  applied: AppliedOperationCoverage[];
}

let configuredRoot = "";
let host: MemoryDerivedStateHost | null = null;
/** In-memory mirror of the persisted records. Single-threaded Bun runtime. */
const recordCache = new Map<string, SessionInvalidationRecord>();

/**
 * Injective filename encoding. A reversible base64url of the UTF-8 session id
 * avoids the collision that a lossy character replacement would create between
 * distinct Session ids.
 */
function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf-8").toString("base64url");
}

function invalidationDir(): string {
  return join(configuredRoot, "memory-invalidation");
}

function watermarkPath(sessionId: string): string {
  return join(invalidationDir(), `${encodeSessionId(sessionId)}.json`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A required, bounded, non-empty string id. */
function requireBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`memory_derived_invalid:${field}_missing`);
  }
  if (value.length > max) {
    throw new Error(`memory_derived_invalid:${field}_too_long`);
  }
  return value;
}

/**
 * A strict array of bounded, non-empty strings. A non-array, an oversized
 * array, or a malformed entry is rejected (never filtered to success). An empty
 * array is a legitimate value.
 */
function requireBoundedStringArray(
  value: unknown,
  field: string,
  maxEntries = MAX_DERIVED_ARRAY_ENTRIES,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`memory_derived_invalid:${field}_not_array`);
  }
  if (value.length > maxEntries) {
    throw new Error(`memory_derived_invalid:${field}_too_many`);
  }
  const out: string[] = [];
  for (const entry of value) {
    out.push(requireBoundedString(entry, field, MAX_DERIVED_ID_LENGTH));
  }
  return out;
}

/** The operation key must be non-empty and native-namespaced exactly once. */
function requireNamespacedOperation(value: unknown): string {
  const key = requireBoundedString(value, "operation_id", MAX_DERIVED_OPERATION_LENGTH);
  const match = NAMESPACED_OPERATION.exec(key);
  if (!match || match[1].length === 0 || match[2].length === 0) {
    throw new Error("memory_derived_invalid:operation_not_namespaced");
  }
  return key;
}

function persistedStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new MemoryDerivedStateUnavailableError(`${field}_invalid`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new MemoryDerivedStateUnavailableError(`${field}_entry_invalid`);
    }
  }
  return value as string[];
}

/**
 * Read one Session's record strictly. A corrupt/unreadable record, a mismatched
 * stored session id, or a malformed generation marker is a hard failure (never
 * silently zero): a bad record must block the ACK rather than allow a stale
 * derived context to serve.
 */
function readRecord(sessionId: string): SessionInvalidationRecord {
  const path = watermarkPath(sessionId);
  if (!existsSync(path)) {
    return { sessionId, watermark: 0, activity: 0, applied: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new MemoryDerivedStateUnavailableError("corrupt_watermark");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MemoryDerivedStateUnavailableError("corrupt_watermark");
  }
  const record = raw as Record<string, unknown>;
  if (record.sessionId !== sessionId) {
    throw new MemoryDerivedStateUnavailableError("watermark_session_mismatch");
  }
  if (!isNonNegativeInteger(record.watermark)) {
    throw new MemoryDerivedStateUnavailableError("watermark_not_integer");
  }
  if (!isNonNegativeInteger(record.activity)) {
    throw new MemoryDerivedStateUnavailableError("watermark_activity_invalid");
  }
  if (!Array.isArray(record.applied)) {
    throw new MemoryDerivedStateUnavailableError("watermark_applied_invalid");
  }
  const applied: AppliedOperationCoverage[] = [];
  for (const entry of record.applied) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new MemoryDerivedStateUnavailableError("watermark_applied_entry_invalid");
    }
    const coverage = entry as Record<string, unknown>;
    if (typeof coverage.key !== "string" || coverage.key.length === 0) {
      throw new MemoryDerivedStateUnavailableError("watermark_applied_key_invalid");
    }
    if (!isNonNegativeInteger(coverage.activity)) {
      throw new MemoryDerivedStateUnavailableError("watermark_applied_activity_invalid");
    }
    applied.push({
      key: coverage.key,
      activity: coverage.activity,
      memoryIds: persistedStringArray(coverage.memoryIds, "watermark_applied_memory_ids"),
      sourceMessageIds: persistedStringArray(
        coverage.sourceMessageIds,
        "watermark_applied_source_ids",
      ),
    });
  }
  return { sessionId, watermark: record.watermark, activity: record.activity, applied };
}

function loadRecord(sessionId: string): SessionInvalidationRecord {
  const cached = recordCache.get(sessionId);
  if (cached) return cached;
  const record = readRecord(sessionId);
  recordCache.set(sessionId, record);
  return record;
}

/** Strict durable write. Throws on failure so the ACK is withheld. */
function storeRecord(record: SessionInvalidationRecord): void {
  mkdirSync(invalidationDir(), { recursive: true });
  writeJsonAtomic(watermarkPath(record.sessionId), record);
  recordCache.set(record.sessionId, record);
}

function containsAll(have: string[], need: string[]): boolean {
  if (need.length === 0) return true;
  const set = new Set(have);
  return need.every((id) => set.has(id));
}

/** True when the operation already cleaned this activity epoch and coverage. */
function operationCovered(
  record: SessionInvalidationRecord,
  key: string,
  memoryIds: string[],
  sourceMessageIds: string[],
): boolean {
  const entry = record.applied.find((candidate) => candidate.key === key);
  if (!entry) return false;
  if (entry.activity < record.activity) return false;
  return containsAll(entry.memoryIds, memoryIds) && containsAll(entry.sourceMessageIds, sourceMessageIds);
}

function mergeCoverage(
  applied: AppliedOperationCoverage[],
  key: string,
  activity: number,
  memoryIds: string[],
  sourceMessageIds: string[],
): AppliedOperationCoverage[] {
  const index = applied.findIndex((candidate) => candidate.key === key);
  if (index < 0) {
    return [
      ...applied,
      {
        key,
        activity,
        memoryIds: Array.from(new Set(memoryIds)),
        sourceMessageIds: Array.from(new Set(sourceMessageIds)),
      },
    ];
  }
  const existing = applied[index];
  const merged: AppliedOperationCoverage = {
    key,
    activity,
    memoryIds: Array.from(new Set([...existing.memoryIds, ...memoryIds])),
    sourceMessageIds: Array.from(new Set([...existing.sourceMessageIds, ...sourceMessageIds])),
  };
  const copy = applied.slice();
  copy[index] = merged;
  return copy;
}

/**
 * Configure the module for one owned Bun generation. `sessionsRoot` is the
 * instance-specific root used to load preexisting record state across a Bun
 * restart.
 */
export function configureMemoryDerivedState(options: {
  sessionsRoot: string;
  host: MemoryDerivedStateHost;
}): void {
  configuredRoot = options.sessionsRoot;
  host = options.host;
  recordCache.clear();
}

/**
 * Advance the persisted per-Session memory-derived activity epoch. Called
 * BEFORE a native-validated registration/consume side effect or any fresh
 * derived-context creation for a Session (native and ordinary turns alike), so
 * a retried invalidation can tell that new derived context appeared after a
 * prior ACK and must be cleaned again.
 *
 * Fail-closed: a corrupt record or a marker that cannot be durably written
 * throws `MemoryDerivedStateUnavailableError`. The caller must not create or
 * persist derived state when this throws. There is no silent catch.
 */
export function noteMemoryDerivedActivity(sessionId: string): void {
  if (!configuredRoot || sessionId.length === 0) {
    throw new MemoryDerivedStateUnavailableError("activity_tracking_unconfigured");
  }
  const current = loadRecord(sessionId);
  storeRecord({
    sessionId,
    watermark: current.watermark,
    activity: current.activity + 1,
    applied: current.applied,
  });
}

/**
 * Invalidate derived prompt state for every affected Session.
 *
 * Ordering is strict: the pending generation barrier (advanced watermark) is
 * persisted FIRST, then each affected Session is cleaned synchronously, and the
 * operation coverage is stamped ONLY after every host write finishes. A retry
 * of a pending (barrier written, not completed) operation, or one whose activity
 * epoch or coverage expanded, reruns cleanup. The whole ACK is withheld unless
 * every affected Session completes. Throws on any validation, persistence, or
 * eviction failure. An empty affected-Session set is a legitimate no-op (the
 * registry still invalidates unconsumed preparations and ACKs).
 */
export function invalidateMemoryDerivedState(input: MemoryDerivedInvalidation): void {
  if (!host) throw new Error("memory_derived_state_unconfigured");
  const operationId = requireNamespacedOperation(input.operation_id);
  const affected = requireBoundedStringArray(input.affected_session_ids, "affected_session_ids");
  const memoryIds = requireBoundedStringArray(input.memory_ids, "memory_ids");
  const sourceMessageIds = requireBoundedStringArray(input.source_message_ids, "source_message_ids");

  const uniqueAffected = Array.from(new Set(affected));
  if (uniqueAffected.length === 0) {
    // No affected consumers: nothing to clean. The route still ACKs the
    // registry invalidation; we never invent a Session for an empty payload.
    return;
  }

  for (const sessionId of uniqueAffected) {
    const record = loadRecord(sessionId);
    if (operationCovered(record, operationId, memoryIds, sourceMessageIds)) {
      continue; // Completed at this epoch with this coverage: idempotent no-op.
    }
    const pending: SessionInvalidationRecord = {
      sessionId,
      watermark: record.watermark + 1,
      activity: record.activity,
      applied: record.applied,
    };
    // Persist the pending generation barrier BEFORE cleanup so a crash mid-clean
    // leaves a detectable pending marker; a later retry reruns cleanup.
    storeRecord(pending);

    // Strict synchronous cleanup. Any failure throws and withholds the ACK.
    host.evictConductorSession(sessionId);
    host.evictSessionDerivedState(sessionId, input);

    // Stamp coverage only after every host write finished. Completed operations
    // retain their coverage so an unchanged replay stays idempotent across a
    // Bun restart; coverage is merged (never permanently conflicted) when a
    // legitimate retry expands consumer/source ids.
    storeRecord({
      sessionId,
      watermark: pending.watermark,
      activity: pending.activity,
      applied: mergeCoverage(pending.applied, operationId, pending.activity, memoryIds, sourceMessageIds),
    });
  }
}

/**
 * The persisted per-Session invalidation watermark. A corrupt/unreadable or
 * mismatched record throws `MemoryDerivedStateUnavailableError` so callers fail
 * closed; it is never silently reported as zero.
 */
export function sessionInvalidationWatermark(sessionId: string): number {
  return loadRecord(sessionId).watermark;
}

/**
 * Fail-safe watermark read for hot paths (late-write guards). Returns `null`
 * when the persisted marker cannot be trusted. Callers must treat `null` as
 * "always stale" and never stamp it as a fresh generation.
 */
export function trySessionInvalidationWatermark(sessionId: string): number | null {
  try {
    return sessionInvalidationWatermark(sessionId);
  } catch {
    return null;
  }
}
