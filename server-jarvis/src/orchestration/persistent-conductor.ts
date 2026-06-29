import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { estimateTokens, recordConductorCache } from "./conductor-metrics";
import { loadPrompt } from "./prompt-loader";
import type { ChatMessage, SharedContextHints } from "./coordinator";
import type { ConductorConfig, JarvisConfig } from "../config";
import { SESSIONS_DIR } from "../config";
import { checkOllamaHealth, ollamaBaseUrlCandidates } from "../ollama";
import {
  COORDINATOR_ROUTE_JSON_SCHEMA,
  COORDINATOR_ROUTE_TOOL,
  extractConductorRoutingJson,
  type OllamaChatMessage,
} from "./conductor-routing";

export interface ConductorMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ConductorSessionState {
  sessionId: string;
  turns: number;
  lastOutcome?: string;
  messages: ConductorMessage[];
  lastActiveAt: number;
  /** Increments each routing turn — KV generation counter (Track A). */
  kvGeneration?: number;
  /** Stable hash of the system prompt prefix for cache hit detection. */
  systemPromptHash?: string;
  /** Estimated tokens in the reusable prefix (system + prior turns). */
  cachedPrefixTokens?: number;
  /** Last model used for this session's conductor turns. */
  lastModel?: string;
  /** Set when API fallback was used — next local turn rebuilds prefix safely. */
  apiFallbackUsed?: boolean;
}

export interface ConductorRouteTurnInput {
  sessionId: string;
  request: string;
  turnNumber: number;
  lastOutcome?: string;
  recentHistory?: ChatMessage[];
  sessionMemoryHints?: SharedContextHints;
}

export interface ConductorRouteTurnResult {
  content: string;
  model: string;
  latencyMs: number;
  usedLocal: true;
  cacheHit: boolean;
  prefixTokensEstimated: number;
  deltaTokensEstimated: number;
  prefixTokensRecomputed: number;
  kvGeneration: number;
}

export class PersistentConductorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistentConductorError";
  }
}

interface ResolvedConductorTarget {
  baseUrl: string;
  model: string;
}

let cachedTarget: ResolvedConductorTarget | null = null;
let cachedTargetKey = "";
let cachedTargetAt = 0;
const TARGET_CACHE_TTL_MS = 10_000;

export function __resetPersistentConductorCachesForTests(): void {
  cachedTarget = null;
  cachedTargetKey = "";
  cachedTargetAt = 0;
}

function cleanOllamaBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function sessionFilePath(sessionId: string, sessionsRoot = SESSIONS_DIR): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(sessionsRoot, "conductor", `${safe}.json`);
}

function modelAvailable(models: string[], requested: string): boolean {
  if (models.includes(requested)) return true;
  const [base, tag = "latest"] = requested.split(":");
  if (tag !== "latest") {
    return models.includes(`${base}:latest`) || models.includes(base);
  }
  return models.includes(base) || models.includes(`${base}:latest`);
}

function conductorModelCandidates(conductor: ConductorConfig): string[] {
  return Array.from(new Set([conductor.model, conductor.fallback_model].filter(Boolean)));
}

function pickInstalledConductorModel(models: string[], conductor: ConductorConfig): string | null {
  for (const candidate of conductorModelCandidates(conductor)) {
    if (modelAvailable(models, candidate)) return candidate;
  }
  return null;
}

function formatRecentHistory(history: ChatMessage[] | undefined): string {
  if (!history || history.length === 0) return "Recent session history: none";
  const lines = history
    .slice(-8)
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 1200)}${m.content.length > 1200 ? "..." : ""}`)
    .join("\n");
  return `Recent session history:\n${lines}`;
}

function formatSessionMemoryHints(hints?: SharedContextHints): string {
  if (!hints) return "Session shared memory: none";
  const blocks: string[] = ["Session shared memory:"];

  if (hints.relevant_memories?.length) {
    blocks.push(
      "Relevant memories:\n" +
      hints.relevant_memories.map((m) => `- ${m}`).join("\n"),
    );
  }
  if (hints.failure_patterns?.length) {
    blocks.push(
      "Known failure patterns:\n" +
      hints.failure_patterns.map((p) => `- ${p}`).join("\n"),
    );
  }
  const cached = hints.prior_tool_results ?? {};
  const entries = Object.entries(cached);
  if (entries.length > 0) {
    blocks.push(
      "Cached tool results:\n" +
      entries.map(([key, value]) => `### ${key}\n${value}`).join("\n\n"),
    );
  }

  return blocks.length > 1 ? blocks.join("\n\n") : "Session shared memory: none";
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function estimateMessageTokens(messages: ConductorMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

function buildTurnUserContent(input: ConductorRouteTurnInput): string {
  return [
    `Session ID: ${input.sessionId}`,
    `Coordinator turn: ${input.turnNumber}`,
    `Last outcome: ${input.lastOutcome ?? "none"}`,
    formatSessionMemoryHints(input.sessionMemoryHints),
    formatRecentHistory(input.recentHistory),
    `Current request:\n${input.request}`,
  ].join("\n\n");
}

export class PersistentConductor {
  private static readonly MAX_SESSIONS = 256;
  private sessions = new Map<string, ConductorSessionState>();

  constructor(
    private getConfig: () => JarvisConfig,
    private sessionsRoot: string = SESSIONS_DIR,
  ) {}

  private config(): ConductorConfig {
    return this.getConfig().orchestrator.conductor;
  }

  private ollamaConfig() {
    const cfg = this.getConfig();
    const conductor = this.config();
    return {
      ...cfg.ollama,
      base_url: conductor.base_url?.trim() || cfg.ollama.base_url,
      model: conductor.model,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config().enabled) return false;
    const conductor = this.config();
    for (const model of conductorModelCandidates(conductor)) {
      const health = await checkOllamaHealth({ ...this.ollamaConfig(), model });
      if (health.running && health.modelAvailable) return true;
    }
    return false;
  }

  shouldFallbackToApi(): boolean {
    return this.config().fallback_to_api;
  }

  async routeTurn(input: ConductorRouteTurnInput): Promise<ConductorRouteTurnResult> {
    if (!this.config().enabled) {
      throw new PersistentConductorError("Persistent conductor is disabled");
    }

    const target = await this.resolveTarget();
    const session = this.getSession(input.sessionId);
    const userContent = buildTurnUserContent(input);
    const systemPrompt = loadPrompt("coordinator.md");
    const systemHash = hashText(systemPrompt);

    const hadSystem = session.messages.some((m) => m.role === "system");
    const rebuiltPrefix = !hadSystem || session.apiFallbackUsed;
    if (rebuiltPrefix) {
      const existingSystemIdx = session.messages.findIndex((m) => m.role === "system");
      if (existingSystemIdx >= 0) {
        session.messages[existingSystemIdx] = { role: "system", content: systemPrompt };
      } else {
        session.messages.unshift({ role: "system", content: systemPrompt });
      }
      session.systemPromptHash = systemHash;
      session.apiFallbackUsed = false;
    }

    const prefixTokensBefore = estimateMessageTokens(session.messages);
    const cacheHit = hadSystem && !rebuiltPrefix && session.kvGeneration !== undefined && session.kvGeneration > 0
      && session.systemPromptHash === systemHash;

    session.messages.push({ role: "user", content: userContent });
    const deltaTokens = estimateTokens(userContent);
    session.kvGeneration = (session.kvGeneration ?? 0) + 1;

    const start = Date.now();
    let content: string;
    let ok = true;
    try {
      content = await this.callOllamaChat(target, session.messages);
    } catch (e) {
      ok = false;
      session.messages.pop();
      throw e;
    }
    const latencyMs = Date.now() - start;

    session.messages.push({ role: "assistant", content });
    session.turns = input.turnNumber;
    session.lastOutcome = input.lastOutcome;
    session.lastActiveAt = Date.now();
    session.lastModel = target.model;
    session.cachedPrefixTokens = prefixTokensBefore;

    const prefixRecomputed = cacheHit ? 0 : prefixTokensBefore;
    recordConductorCache({
      ts: Date.now(),
      session_id: input.sessionId,
      turn_number: input.turnNumber,
      model: target.model,
      latency_ms: latencyMs,
      ok,
      conductor_cache_hit: cacheHit,
      prefix_tokens_estimated: prefixTokensBefore,
      delta_tokens_estimated: deltaTokens + estimateTokens(content),
      prefix_tokens_recomputed: prefixRecomputed,
      kv_generation: session.kvGeneration,
    });

    this.pruneSessionMessages(session);
    this.persistSession(session);
    this.touchSession(input.sessionId, session);

    return {
      content,
      model: target.model,
      latencyMs,
      usedLocal: true,
      cacheHit,
      prefixTokensEstimated: prefixTokensBefore,
      deltaTokensEstimated: deltaTokens + estimateTokens(content),
      prefixTokensRecomputed: prefixRecomputed,
      kvGeneration: session.kvGeneration,
    };
  }

  /** Mark session after API coordinator fallback so next local turn rebuilds prefix. */
  markApiFallback(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.apiFallbackUsed = true;
      this.persistSession(session);
    }
  }

  pruneExpiredDiskSessions(): number {
    if (!this.config().kv_persist && !this.config().persist_sessions) return 0;
    const dir = join(this.sessionsRoot, "conductor");
    if (!existsSync(dir)) return 0;
    const ttl = this.config().session_ttl_ms;
    const now = Date.now();
    let removed = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(dir, file);
      try {
        const mtime = statSync(path).mtimeMs;
        if (now - mtime > ttl) {
          unlinkSync(path);
          removed += 1;
        }
      } catch {
        // Best effort.
      }
    }
    return removed;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (!this.config().persist_sessions && !this.config().kv_persist) return;
    const path = sessionFilePath(sessionId, this.sessionsRoot);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  getSessionState(sessionId: string): ConductorSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  private async resolveTarget(): Promise<ResolvedConductorTarget> {
    const ollamaCfg = this.ollamaConfig();
    const conductor = this.config();
    const cacheKey = `${ollamaCfg.base_url}|${conductor.model}|${conductor.fallback_model}`;
    const now = Date.now();
    if (cachedTarget && cachedTargetKey === cacheKey && (now - cachedTargetAt) < TARGET_CACHE_TTL_MS) {
      return cachedTarget;
    }

    for (const cleanUrl of ollamaBaseUrlCandidates(ollamaCfg)) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        const tagsResp = await fetch(`${cleanUrl}/api/tags`, { signal: ctrl.signal });
        clearTimeout(timeout);
        if (!tagsResp.ok) continue;

        const tagsJson = await tagsResp.json();
        const models: string[] = (tagsJson.models || [])
          .map((m: { name?: string; model?: string }) => m.name || m.model || "")
          .filter(Boolean);

        if (models.length === 0) continue;

        const installed = pickInstalledConductorModel(models, this.config());
        if (!installed) continue;

        const target: ResolvedConductorTarget = {
          baseUrl: cleanUrl,
          model: installed,
        };

        cachedTarget = target;
        cachedTargetKey = cacheKey;
        cachedTargetAt = now;
        return target;
      } catch {
        // Try the next candidate URL.
      }
    }

    const fallbackUrl = cleanOllamaBaseUrl(ollamaCfg.base_url) || "http://localhost:11434";
    const modelsWanted = conductorModelCandidates(conductor).join(" or ");
    throw new PersistentConductorError(
      `Local conductor unreachable. Tried Ollama at ${fallbackUrl} for ${modelsWanted}`,
    );
  }

  private async callOllamaChat(target: ResolvedConductorTarget, messages: ConductorMessage[]): Promise<string> {
    const conductor = this.config();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30_000);

    const body: Record<string, unknown> = {
      model: target.model,
      messages,
      stream: false,
      keep_alive: "30m",
      think: false,
      options: {
        temperature: conductor.temperature,
        top_p: conductor.top_p,
        top_k: conductor.top_k,
        num_ctx: conductor.num_ctx,
        num_predict: conductor.max_tokens,
      },
    };

    if (conductor.output_mode === "tool_call") {
      body.tools = [COORDINATOR_ROUTE_TOOL];
    } else if (conductor.output_mode === "json_schema") {
      body.format = COORDINATOR_ROUTE_JSON_SCHEMA;
    }

    try {
      const res = await fetch(`${target.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new PersistentConductorError(`Ollama chat failed: HTTP ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`);
      }

      const json = await res.json() as { message?: OllamaChatMessage };
      return extractConductorRoutingJson(json.message);
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof PersistentConductorError) throw e;
      throw new PersistentConductorError(e instanceof Error ? e.message : String(e));
    }
  }

  private getSession(sessionId: string): ConductorSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touchSession(sessionId, existing);
      return existing;
    }

    const loaded = this.loadSessionFromDisk(sessionId);
    if (loaded) {
      this.touchSession(sessionId, loaded);
      return loaded;
    }

    const created: ConductorSessionState = {
      sessionId,
      turns: 0,
      messages: [],
      lastActiveAt: Date.now(),
      kvGeneration: 0,
    };
    this.touchSession(sessionId, created);
    return created;
  }

  private touchSession(sessionId: string, session: ConductorSessionState): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
    this.pruneInactiveSessions();
    while (this.sessions.size > PersistentConductor.MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
  }

  private pruneInactiveSessions(): void {
    const ttl = this.config().session_ttl_ms;
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActiveAt > ttl) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private pruneSessionMessages(session: ConductorSessionState): void {
    const maxTurns = Math.max(1, this.config().max_turns_in_cache);
    const system = session.messages.find((m) => m.role === "system");
    const nonSystem = session.messages.filter((m) => m.role !== "system");

    // Each turn is a user + assistant pair.
    const maxMessages = maxTurns * 2;
    if (nonSystem.length <= maxMessages) return;

    const kept = nonSystem.slice(nonSystem.length - maxMessages);
    session.messages = system ? [system, ...kept] : kept;
  }

  private persistSession(session: ConductorSessionState): void {
    if (!this.config().persist_sessions && !this.config().kv_persist) return;
    try {
      const path = sessionFilePath(session.sessionId, this.sessionsRoot);
      mkdirSync(join(this.sessionsRoot, "conductor"), { recursive: true });
      writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
    } catch (e) {
      console.warn(`[PersistentConductor] Failed to persist session ${session.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private loadSessionFromDisk(sessionId: string): ConductorSessionState | null {
    if (!this.config().persist_sessions) return null;
    const path = sessionFilePath(sessionId, this.sessionsRoot);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as ConductorSessionState;
      if (!raw || raw.sessionId !== sessionId || !Array.isArray(raw.messages)) return null;
      raw.lastActiveAt = raw.lastActiveAt ?? Date.now();
      return raw;
    } catch {
      return null;
    }
  }
}