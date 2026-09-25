import { randomUUID } from "crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import type { ConductorMessage, ConductorSessionState } from "./persistent-conductor";
import type {
  DiscoveredFactEntry,
  FailurePatternEntry,
  FileSnapshotEntry,
  SessionMemoryState,
  ToolResultCacheEntry,
} from "./session-memory";
import { normalizeTaskRunOnRead, type TaskRunContract } from "./task-run";

export interface AtomicJsonWriteOptions {
  beforeRename?: (temporaryPath: string, destinationPath: string) => void;
}

export type SessionRuntimeParseResult<T> =
  | { ok: true; state: T }
  | { ok: false; reason: "invalid_state" };

const CONDUCTOR_ROLES = new Set(["system", "user", "assistant"]);
const TASK_RUN_STATUSES = new Set(["active", "paused", "completed", "failed", "cancelled"]);
const TASK_RUN_DEPTHS = new Set(["standard", "deep"]);
const TASK_RUN_COMPLEXITIES = new Set(["low", "medium", "high"]);
const TASK_RUN_RECONSTRUCTIONS = new Set(["none", "reconstruction_required"]);
const TURN_REQUIREMENTS = new Set([
  "conversational",
  "answer_only",
  "workspace_read",
  "full_execution",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNonNegative(value) && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseEntryMap<T>(
  value: unknown,
  parseEntry: (entry: Record<string, unknown>, key: string) => T | undefined,
): Record<string, T> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const entries: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const parsed = parseEntry(entry, key);
    if (parsed !== undefined) entries[key] = parsed;
  }
  return entries;
}

function parseToolResultEntry(
  value: Record<string, unknown>,
  key: string,
): ToolResultCacheEntry | undefined {
  if (value.key !== key) return undefined;
  if (typeof value.displayKey !== "string" || typeof value.toolName !== "string" || typeof value.output !== "string") {
    return undefined;
  }
  if (!isFiniteNonNegative(value.timestamp) || !isFiniteNonNegative(value.ttlMs) || typeof value.isError !== "boolean") {
    return undefined;
  }
  if (!isOptionalString(value.workspacePath)) return undefined;
  return { ...value, key, displayKey: value.displayKey, toolName: value.toolName, output: value.output, timestamp: value.timestamp, ttlMs: value.ttlMs, isError: value.isError } as ToolResultCacheEntry;
}

function parseFileSnapshotEntry(
  value: Record<string, unknown>,
  key: string,
): FileSnapshotEntry | undefined {
  if (value.path !== key || typeof value.content !== "string" || !isFiniteNonNegative(value.timestamp)) {
    return undefined;
  }
  return { ...value, path: key, content: value.content, timestamp: value.timestamp } as FileSnapshotEntry;
}

function parseDiscoveredFactEntry(
  value: Record<string, unknown>,
  key: string,
): DiscoveredFactEntry | undefined {
  if (value.key !== key || typeof value.value !== "string" || typeof value.source !== "string") {
    return undefined;
  }
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    return undefined;
  }
  if (!isFiniteNonNegative(value.timestamp) || !isOptionalString(value.workspacePath)) return undefined;
  return {
    ...value,
    key,
    value: value.value,
    source: value.source,
    confidence: value.confidence,
    timestamp: value.timestamp,
  } as DiscoveredFactEntry;
}

function parseFailureEntry(value: Record<string, unknown>): FailurePatternEntry | undefined {
  if (typeof value.pattern !== "string" || !isPositiveInteger(value.count) || !isFiniteNonNegative(value.lastSeen)) {
    return undefined;
  }
  if (!isOptionalString(value.source)) return undefined;
  return { ...value, pattern: value.pattern, count: value.count, lastSeen: value.lastSeen } as FailurePatternEntry;
}

function parseTaskRun(value: unknown, sessionId: string): TaskRunContract | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return undefined;
  if (!isNonEmptyString(value.taskRunId) || value.sessionId !== sessionId || typeof value.objective !== "string") {
    return undefined;
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    return undefined;
  }
  if (!isOptionalString(value.workspacePath)) return undefined;
  if (value.sessionGrants !== undefined && !isStringArray(value.sessionGrants)) return undefined;
  if (value.requirement !== undefined && (typeof value.requirement !== "string" || !TURN_REQUIREMENTS.has(value.requirement))) {
    return undefined;
  }
  if (value.depth !== undefined && (typeof value.depth !== "string" || !TASK_RUN_DEPTHS.has(value.depth))) {
    return undefined;
  }
  if (value.estimatedComplexity !== undefined && (typeof value.estimatedComplexity !== "string" || !TASK_RUN_COMPLEXITIES.has(value.estimatedComplexity))) {
    return undefined;
  }
  if (value.turnCount !== undefined && !isNonNegativeInteger(value.turnCount)) return undefined;
  if (value.evidenceCount !== undefined && !isNonNegativeInteger(value.evidenceCount)) return undefined;
  if (value.status !== undefined && (typeof value.status !== "string" || !TASK_RUN_STATUSES.has(value.status))) {
    return undefined;
  }
  if (value.remainingWork !== undefined && !isStringArray(value.remainingWork)) return undefined;
  if (value.writeIntent !== undefined && typeof value.writeIntent !== "boolean") return undefined;
  if (value.lastWriteTargets !== undefined && !isStringArray(value.lastWriteTargets)) return undefined;
  if (!isOptionalString(value.lastOutcome) || !isOptionalString(value.lastTurnId)) return undefined;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return undefined;
  if (value.reconstruction !== undefined && (typeof value.reconstruction !== "string" || !TASK_RUN_RECONSTRUCTIONS.has(value.reconstruction))) {
    return undefined;
  }
  if (value.plan !== undefined) {
    if (!isRecord(value.plan) || !Array.isArray(value.plan.items)) return undefined;
    if (value.plan.activeItemId !== undefined && value.plan.activeItemId !== null && typeof value.plan.activeItemId !== "string") {
      return undefined;
    }
  }
  const normalized = normalizeTaskRunOnRead(value);
  if (!normalized || normalized.sessionId !== sessionId) return undefined;
  return normalized;
}

export function parseSessionMemoryState(
  value: unknown,
  sessionId: string,
  now = Date.now(),
): SessionRuntimeParseResult<SessionMemoryState> {
  if (!isRecord(value) || value.sessionId !== sessionId) return { ok: false, reason: "invalid_state" };
  if (value.lastActiveAt !== undefined && !isFiniteNonNegative(value.lastActiveAt)) {
    return { ok: false, reason: "invalid_state" };
  }
  if (!isOptionalString(value.lastOutcome)) return { ok: false, reason: "invalid_state" };
  const toolResults = parseEntryMap(value.toolResults, parseToolResultEntry);
  const fileSnapshots = parseEntryMap(value.fileSnapshots, parseFileSnapshotEntry);
  const discoveredFacts = parseEntryMap(value.discoveredFacts, parseDiscoveredFactEntry);
  if (!toolResults || !fileSnapshots || !discoveredFacts) return { ok: false, reason: "invalid_state" };
  if (value.failureHistory !== undefined && !Array.isArray(value.failureHistory)) {
    return { ok: false, reason: "invalid_state" };
  }
  const failureHistory = (Array.isArray(value.failureHistory) ? value.failureHistory : [])
    .filter(isRecord)
    .map(parseFailureEntry)
    .filter((entry): entry is FailurePatternEntry => entry !== undefined);
  return {
    ok: true,
    state: {
      ...value,
      sessionId,
      lastActiveAt: value.lastActiveAt ?? now,
      toolResults,
      fileSnapshots,
      discoveredFacts,
      failureHistory,
      taskRun: parseTaskRun(value.taskRun, sessionId),
    },
  };
}

function parseConductorMessage(value: unknown): ConductorMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.role !== "string" || !CONDUCTOR_ROLES.has(value.role) || typeof value.content !== "string") {
    return undefined;
  }
  return { ...value, role: value.role, content: value.content } as ConductorMessage;
}

export function parseConductorSessionState(
  value: unknown,
  sessionId: string,
  now = Date.now(),
): SessionRuntimeParseResult<ConductorSessionState> {
  if (!isRecord(value) || value.sessionId !== sessionId || !Array.isArray(value.messages)) {
    return { ok: false, reason: "invalid_state" };
  }
  if (value.lastActiveAt !== undefined && !isFiniteNonNegative(value.lastActiveAt)) {
    return { ok: false, reason: "invalid_state" };
  }
  if (value.turns !== undefined && !isNonNegativeInteger(value.turns)) return { ok: false, reason: "invalid_state" };
  if (!isOptionalString(value.lastOutcome) || !isOptionalString(value.systemPromptHash) || !isOptionalString(value.lastModel)) {
    return { ok: false, reason: "invalid_state" };
  }
  if (value.kvGeneration !== undefined && !isNonNegativeInteger(value.kvGeneration)) {
    return { ok: false, reason: "invalid_state" };
  }
  if (value.cachedPrefixTokens !== undefined && !isNonNegativeInteger(value.cachedPrefixTokens)) {
    return { ok: false, reason: "invalid_state" };
  }
  if (!isOptionalBoolean(value.apiFallbackUsed)) return { ok: false, reason: "invalid_state" };
  const messages: ConductorMessage[] = [];
  for (const entry of value.messages) {
    const message = parseConductorMessage(entry);
    if (!message) return { ok: false, reason: "invalid_state" };
    messages.push(message);
  }
  return {
    ok: true,
    state: {
      ...value,
      sessionId,
      turns: value.turns ?? 0,
      messages,
      lastActiveAt: value.lastActiveAt ?? now,
    },
  };
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): void {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") throw new TypeError("Atomic JSON value must be serializable");
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporaryPath, `${serialized}\n`, { encoding: "utf-8", mode: 0o600 });
    options.beforeRename?.(temporaryPath, path);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}
