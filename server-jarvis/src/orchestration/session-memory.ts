import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { SharedContextHints } from "./coordinator";
import type { SessionMemoryConfig } from "../config";
import { SESSIONS_DIR } from "../config";
import type { ToolResult } from "../tool-types";

export interface ToolResultCacheEntry {
  key: string;
  displayKey: string;
  toolName: string;
  output: string;
  timestamp: number;
  ttlMs: number;
  isError: boolean;
}

export interface FileSnapshotEntry {
  path: string;
  content: string;
  timestamp: number;
}

export interface DiscoveredFactEntry {
  key: string;
  value: string;
  source: string;
  confidence: number;
  timestamp: number;
}

export interface FailurePatternEntry {
  pattern: string;
  count: number;
  lastSeen: number;
  source?: string;
}

export interface SessionMemoryState {
  sessionId: string;
  lastActiveAt: number;
  lastOutcome?: string;
  toolResults: Record<string, ToolResultCacheEntry>;
  fileSnapshots: Record<string, FileSnapshotEntry>;
  discoveredFacts: Record<string, DiscoveredFactEntry>;
  failureHistory: FailurePatternEntry[];
}

export interface RecordToolResultInput {
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: Pick<ToolResult, "output" | "is_error" | "error">;
  workspacePath?: string;
}

const READ_TOOLS = new Set(["read_file", "list_directory", "glob", "grep", "web_fetch"]);
const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "Write",
  "Edit",
  "MultiEdit",
]);

const MAX_SNIPPET_CHARS = 1500;

function memoryDir(sessionsRoot = SESSIONS_DIR): string {
  return join(sessionsRoot, "memory");
}

function memoryFilePath(sessionId: string, sessionsRoot = SESSIONS_DIR): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(memoryDir(sessionsRoot), `${safe}.json`);
}

function stableStringify(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of keys) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

export function toolCallCacheKey(
  toolName: string,
  args: Record<string, unknown>,
  workspacePath?: string,
): string {
  const raw = `${toolName}|${workspacePath ?? ""}|${stableStringify(args)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function toolCallDisplayKey(toolName: string, args: Record<string, unknown>): string {
  const path = extractPathArg(args);
  if (path) return `${toolName}:${path}`;
  const summary = stableStringify(args);
  return summary.length > 80 ? `${toolName}:${summary.slice(0, 77)}...` : `${toolName}:${summary}`;
}

function extractPathArg(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "file", "directory", "dir"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizePath(path: string, workspacePath?: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!workspacePath) return trimmed;
  try {
    const base = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (trimmed.startsWith(base)) return trimmed;
    if (!trimmed.startsWith("/") && !/^[a-zA-Z]:/.test(trimmed)) {
      return `${base}/${trimmed}`.replace(/\/+/g, "/");
    }
  } catch {
    // Keep the raw path when normalization fails.
  }
  return trimmed;
}

function truncateSnippet(text: string, max = MAX_SNIPPET_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

export function mergeSharedContextHints(
  conductor?: SharedContextHints,
  memory?: SharedContextHints,
): SharedContextHints | undefined {
  if (!conductor && !memory) return undefined;

  const memories = Array.from(new Set([
    ...(memory?.relevant_memories ?? []),
    ...(conductor?.relevant_memories ?? []),
  ]));
  const failures = Array.from(new Set([
    ...(memory?.failure_patterns ?? []),
    ...(conductor?.failure_patterns ?? []),
  ]));
  const prior = {
    ...(memory?.prior_tool_results ?? {}),
    ...(conductor?.prior_tool_results ?? {}),
  };

  const out: SharedContextHints = {};
  if (memories.length > 0) out.relevant_memories = memories;
  if (failures.length > 0) out.failure_patterns = failures;
  if (Object.keys(prior).length > 0) out.prior_tool_results = prior;
  return Object.keys(out).length > 0 ? out : undefined;
}

export class SessionMemory {
  private static readonly MAX_SESSIONS = 256;
  private sessions = new Map<string, SessionMemoryState>();

  constructor(
    private getConfig: () => SessionMemoryConfig,
    private sessionsRoot: string = SESSIONS_DIR,
  ) {}

  private config(): SessionMemoryConfig {
    return this.getConfig();
  }

  getLastOutcome(sessionId: string): string | undefined {
    return this.getSession(sessionId).lastOutcome;
  }

  setLastOutcome(sessionId: string, outcome: string | undefined): void {
    if (!outcome?.trim()) return;
    const session = this.getSession(sessionId);
    session.lastOutcome = outcome.trim();
    session.lastActiveAt = Date.now();
    this.persist(session);
  }

  toSharedContextHints(sessionId: string): SharedContextHints | undefined {
    if (!this.config().enabled) return undefined;
    const session = this.getSession(sessionId);
    this.pruneExpired(session);

    const prior_tool_results: Record<string, string> = {};
    for (const entry of Object.values(session.toolResults)) {
      prior_tool_results[entry.displayKey] = truncateSnippet(entry.output);
    }

    const failure_patterns = session.failureHistory
      .slice()
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, this.config().max_failure_patterns)
      .map((f) => (f.count > 1 ? `${f.pattern} (seen ${f.count}x)` : f.pattern));

    const relevant_memories = Object.values(session.discoveredFacts)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 16)
      .map((f) => f.value);

    return mergeSharedContextHints(undefined, {
      prior_tool_results: Object.keys(prior_tool_results).length > 0 ? prior_tool_results : undefined,
      failure_patterns: failure_patterns.length > 0 ? failure_patterns : undefined,
      relevant_memories: relevant_memories.length > 0 ? relevant_memories : undefined,
    });
  }

  lookupCachedToolResult(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    workspacePath?: string,
  ): string | undefined {
    if (!this.config().enabled) return undefined;
    const session = this.getSession(sessionId);
    const key = toolCallCacheKey(toolName, args, workspacePath);
    const entry = session.toolResults[key];
    if (!entry || entry.isError) return undefined;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      delete session.toolResults[key];
      return undefined;
    }
    return entry.output;
  }

  recordToolResult(input: RecordToolResultInput): void {
    if (!this.config().enabled) return;

    const session = this.getSession(input.sessionId);
    const now = Date.now();
    const cfg = this.config();
    const key = toolCallCacheKey(input.toolName, input.args, input.workspacePath);
    const displayKey = toolCallDisplayKey(input.toolName, input.args);
    const output = input.result.output ?? "";

    session.toolResults[key] = {
      key,
      displayKey,
      toolName: input.toolName,
      output: truncateSnippet(output, 4000),
      timestamp: now,
      ttlMs: cfg.tool_result_ttl_ms,
      isError: input.result.is_error,
    };

    if (input.result.is_error) {
      const pattern = `${input.toolName} failed: ${input.result.error ?? truncateSnippet(output, 200)}`;
      this.recordFailure(session, pattern, input.toolName);
    } else if (READ_TOOLS.has(input.toolName)) {
      const path = extractPathArg(input.args);
      if (path && input.toolName === "read_file") {
        const normalized = normalizePath(path, input.workspacePath);
        session.fileSnapshots[normalized] = {
          path: normalized,
          content: truncateSnippet(output, 8000),
          timestamp: now,
        };
        session.discoveredFacts[`file:${normalized}`] = {
          key: `file:${normalized}`,
          value: `File ${normalized} was read successfully (${output.length} chars).`,
          source: "read_file",
          confidence: 1,
          timestamp: now,
        };
      }
    }

    if (WRITE_TOOLS.has(input.toolName)) {
      const path = extractPathArg(input.args);
      if (path) {
        this.invalidateFile(session, normalizePath(path, input.workspacePath));
      }
    }

    this.pruneOverflow(session);
    session.lastActiveAt = now;
    this.persist(session);
  }

  recordPipelineOutcome(sessionId: string, args: {
    outcome: "success" | "degraded" | "failed";
    errorCode?: string;
    error?: string;
    answer?: string;
  }): void {
    if (!this.config().enabled) return;
    const session = this.getSession(sessionId);
    const summary = [
      `outcome=${args.outcome}`,
      args.errorCode ? `code=${args.errorCode}` : "",
      args.error ? `error=${truncateSnippet(args.error, 300)}` : "",
    ].filter(Boolean).join("; ");

    session.lastOutcome = summary;
    session.lastActiveAt = Date.now();

    if (args.outcome !== "success") {
      const pattern = args.errorCode
        ? `pipeline ${args.outcome}: ${args.errorCode}`
        : `pipeline ${args.outcome}`;
      this.recordFailure(session, pattern, "pipeline");
    }

    this.persist(session);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (!this.config().persist) return;
    const path = memoryFilePath(sessionId, this.sessionsRoot);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  getSessionState(sessionId: string): SessionMemoryState | undefined {
    return this.sessions.get(sessionId);
  }

  private recordFailure(session: SessionMemoryState, pattern: string, source?: string): void {
    const existing = session.failureHistory.find((f) => f.pattern === pattern);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = Date.now();
      if (source) existing.source = source;
      return;
    }
    session.failureHistory.push({
      pattern,
      count: 1,
      lastSeen: Date.now(),
      source,
    });
  }

  private invalidateFile(session: SessionMemoryState, path: string): void {
    delete session.fileSnapshots[path];
    delete session.discoveredFacts[`file:${path}`];

    for (const [key, entry] of Object.entries(session.toolResults)) {
      if (entry.displayKey.includes(path) || entry.output.includes(path)) {
        delete session.toolResults[key];
      }
    }
  }

  private pruneExpired(session: SessionMemoryState): void {
    const now = Date.now();
    for (const [key, entry] of Object.entries(session.toolResults)) {
      if (now - entry.timestamp > entry.ttlMs) {
        delete session.toolResults[key];
      }
    }
  }

  private pruneOverflow(session: SessionMemoryState): void {
    const cfg = this.config();
    this.pruneExpired(session);

    const trimRecord = <T extends { timestamp?: number }>(map: Record<string, T>, max: number) => {
      const entries = Object.entries(map);
      if (entries.length <= max) return;
      entries.sort((a, b) => (a[1].timestamp ?? 0) - (b[1].timestamp ?? 0));
      for (let i = 0; i < entries.length - max; i++) {
        delete map[entries[i][0]];
      }
    };

    trimRecord(session.toolResults, cfg.max_tool_results);
    trimRecord(session.fileSnapshots, cfg.max_file_snapshots);

    const factEntries = Object.entries(session.discoveredFacts);
    if (factEntries.length > cfg.max_file_snapshots) {
      factEntries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < factEntries.length - cfg.max_file_snapshots; i++) {
        delete session.discoveredFacts[factEntries[i][0]];
      }
    }

    if (session.failureHistory.length > cfg.max_failure_patterns) {
      session.failureHistory.sort((a, b) => b.lastSeen - a.lastSeen);
      session.failureHistory = session.failureHistory.slice(0, cfg.max_failure_patterns);
    }
  }

  private getSession(sessionId: string): SessionMemoryState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touch(sessionId, existing);
      return existing;
    }

    const loaded = this.loadFromDisk(sessionId);
    if (loaded) {
      this.touch(sessionId, loaded);
      return loaded;
    }

    const created: SessionMemoryState = {
      sessionId,
      lastActiveAt: Date.now(),
      toolResults: {},
      fileSnapshots: {},
      discoveredFacts: {},
      failureHistory: [],
    };
    this.touch(sessionId, created);
    return created;
  }

  private touch(sessionId: string, session: SessionMemoryState): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
    const ttl = this.config().session_ttl_ms;
    const now = Date.now();
    for (const [id, state] of this.sessions) {
      if (now - state.lastActiveAt > ttl) this.sessions.delete(id);
    }
    while (this.sessions.size > SessionMemory.MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
  }

  private persist(session: SessionMemoryState): void {
    if (!this.config().persist) return;
    try {
      mkdirSync(memoryDir(this.sessionsRoot), { recursive: true });
      writeFileSync(memoryFilePath(session.sessionId, this.sessionsRoot), JSON.stringify(session, null, 2), "utf-8");
    } catch (e) {
      console.warn(`[SessionMemory] Failed to persist ${session.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private loadFromDisk(sessionId: string): SessionMemoryState | null {
    if (!this.config().persist) return null;
    const path = memoryFilePath(sessionId, this.sessionsRoot);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as SessionMemoryState;
      if (!raw || raw.sessionId !== sessionId) return null;
      raw.toolResults ??= {};
      raw.fileSnapshots ??= {};
      raw.discoveredFacts ??= {};
      raw.failureHistory ??= [];
      raw.lastActiveAt = raw.lastActiveAt ?? Date.now();
      return raw;
    } catch {
      return null;
    }
  }
}

export function __resetSessionMemoryForTests(): void {
  // No module-level cache beyond instance state; tests use dedicated instances.
}