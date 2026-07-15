import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { estimateTokens, recordConductorCache } from "./conductor-metrics";
import { loadPrompt } from "./prompt-loader";
import type { ChatMessage, SharedContextHints } from "./coordinator";
import type { ConductorConfig, JarvisConfig } from "../config";
import { SESSIONS_DIR } from "../config";
import { checkOllamaHealth, ollamaBaseUrlCandidates } from "../ollama";
import { resolveSkillsForConductor } from "../intelligence/skill-resolver";
import {
  CONDUCTOR_DIRECTIVE_JSON_SCHEMA,
  COORDINATOR_ROUTE_JSON_SCHEMA,
  extractConductorRoutingJson,
  stripGemmaThinkingArtifacts,
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

export interface ConductorSupervisionResult {
  content: string;
  model: string;
  latencyMs: number;
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
const TARGET_RUNTIME_FAILURE_TTL_MS = 5 * 60_000;
const runtimeFailedTargets = new Map<string, number>();

/** F7: warm routing must fail fast before API fallback takes over. */
export const ROUTING_TIMEOUT_MS = 10_000;

export function __resetPersistentConductorCachesForTests(): void {
  cachedTarget = null;
  cachedTargetKey = "";
  cachedTargetAt = 0;
  runtimeFailedTargets.clear();
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

/**
 * D4 (organism loop v1): compact hint of promoted skills relevant to this
 * turn, resolved WITHOUT knowing task_type (routing hasn't happened yet —
 * see `resolveSkillsForConductor`). Returns "" when nothing matches, which
 * `buildTurnUserContent`'s `.filter(Boolean)` drops entirely — an unmatched
 * turn is byte-identical to the pre-D4 output. Rides the per-turn user
 * delta, never the KV-cache-guarded system prompt (A-02).
 */
function formatSkillHint(request: string): string {
  const hint = resolveSkillsForConductor(request);
  if (!hint.trim()) return "";
  return `Promoted skills relevant to this turn:\n${hint}`;
}

function buildTurnUserContent(input: ConductorRouteTurnInput): string {
  return [
    `Session ID: ${input.sessionId}`,
    `Coordinator turn: ${input.turnNumber}`,
    `Last outcome: ${input.lastOutcome ?? "none"}`,
    formatSessionMemoryHints(input.sessionMemoryHints),
    formatRecentHistory(input.recentHistory),
    formatSkillHint(input.request),
    `Current request:\n${input.request}`,
  ].filter(Boolean).join("\n\n");
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

  /**
   * T1.7: structured health for logs, /health JSON, and per-turn
   * conductor_health SSE frames when config says enabled but we fell back.
   */
  async describeHealth(): Promise<{
    enabled: boolean;
    available: boolean;
    fallback_to_api: boolean;
    model: string;
    fallback_model: string;
    reason?: string;
  }> {
    const conductor = this.config();
    if (!conductor.enabled) {
      return {
        enabled: false,
        available: false,
        fallback_to_api: conductor.fallback_to_api,
        model: conductor.model,
        fallback_model: conductor.fallback_model,
        reason: "disabled",
      };
    }
    try {
      const available = await this.isAvailable();
      return {
        enabled: true,
        available,
        fallback_to_api: conductor.fallback_to_api,
        model: conductor.model,
        fallback_model: conductor.fallback_model,
        reason: available ? undefined : "ollama_unavailable_or_model_missing",
      };
    } catch (e) {
      return {
        enabled: true,
        available: false,
        fallback_to_api: conductor.fallback_to_api,
        model: conductor.model,
        fallback_model: conductor.fallback_model,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async routeTurn(input: ConductorRouteTurnInput): Promise<ConductorRouteTurnResult> {
    if (!this.config().enabled) {
      throw new PersistentConductorError("Persistent conductor is disabled");
    }

    let target = await this.resolveTarget();
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
      const routed = await this.withRuntimeFallback(target, (candidate) =>
        this.callOllamaChat(candidate, session.messages));
      target = routed.target;
      content = routed.value;
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

  /** Run a compact post-stage directive on the same local model as routing. */
  async supervise(messages: ConductorMessage[], timeoutMs = 5_000): Promise<ConductorSupervisionResult> {
    if (!this.config().enabled) {
      throw new PersistentConductorError("Persistent conductor is disabled");
    }
    let target = await this.resolveTarget();
    const startedAt = Date.now();
    const supervised = await this.withRuntimeFallback(target, (candidate) =>
      this.callOllamaMessage(candidate, messages, {
        format: CONDUCTOR_DIRECTIVE_JSON_SCHEMA,
        numPredict: 160,
        timeoutMs,
        temperature: 0.1,
      }));
    target = supervised.target;
    const message = supervised.value;
    const content = stripGemmaThinkingArtifacts(message.content ?? "");
    if (!content) throw new PersistentConductorError("Ollama conductor returned empty supervision output");
    return { content, model: target.model, latencyMs: Date.now() - startedAt };
  }

  /** Load and retain the configured conductor model before the first user turn. */
  async warmUp(timeoutMs = 30_000): Promise<{ model: string; latencyMs: number }> {
    if (!this.config().enabled) {
      throw new PersistentConductorError("Persistent conductor is disabled");
    }
    let target = await this.resolveTarget();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const res = await fetch(`${target.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: target.model,
          prompt: "",
          stream: false,
          keep_alive: "30m",
          options: {
            num_predict: 1,
            num_ctx: this.config().num_ctx,
          },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new PersistentConductorError(
          `Ollama warm-up failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        );
      }
      await res.json().catch(() => ({}));
      return { model: target.model, latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.quarantineTarget(target);
      if (error instanceof PersistentConductorError) throw error;
      throw new PersistentConductorError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
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

        const installedCandidates = conductorModelCandidates(this.config())
          .filter((candidate) => modelAvailable(models, candidate));
        const installed = installedCandidates.find((candidate) =>
          !this.targetIsQuarantined({ baseUrl: cleanUrl, model: candidate }))
          ?? installedCandidates[0];
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

  /**
   * Installed does not necessarily mean runnable: Ollama can discover a model
   * whose runner then fails during load. Quarantine that target briefly and
   * retry the configured fallback before escalating the turn to the API.
   */
  private async withRuntimeFallback<T>(
    initial: ResolvedConductorTarget,
    operation: (target: ResolvedConductorTarget) => Promise<T>,
  ): Promise<{ target: ResolvedConductorTarget; value: T }> {
    try {
      return { target: initial, value: await operation(initial) };
    } catch (primaryError) {
      this.quarantineTarget(initial);
      const alternate = await this.resolveTarget().catch(() => null);
      if (!alternate || alternate.model === initial.model) throw primaryError;

      console.warn(
        `[PersistentConductor] Model ${initial.model} failed at runtime; retrying with ${alternate.model}`,
      );
      try {
        return { target: alternate, value: await operation(alternate) };
      } catch (fallbackError) {
        this.quarantineTarget(alternate);
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new PersistentConductorError(
          `Primary conductor ${initial.model} failed (${primaryMessage}); ` +
          `fallback ${alternate.model} failed (${fallbackMessage})`,
        );
      }
    }
  }

  private targetIsQuarantined(target: ResolvedConductorTarget): boolean {
    const key = `${target.baseUrl}|${target.model}`;
    const until = runtimeFailedTargets.get(key) ?? 0;
    if (until <= Date.now()) {
      runtimeFailedTargets.delete(key);
      return false;
    }
    return true;
  }

  private quarantineTarget(target: ResolvedConductorTarget): void {
    runtimeFailedTargets.set(
      `${target.baseUrl}|${target.model}`,
      Date.now() + TARGET_RUNTIME_FAILURE_TTL_MS,
    );
    if (cachedTarget?.baseUrl === target.baseUrl && cachedTarget.model === target.model) {
      cachedTarget = null;
      cachedTargetKey = "";
      cachedTargetAt = 0;
    }
  }

  private async callOllamaMessage(
    target: ResolvedConductorTarget,
    messages: ConductorMessage[],
    options: {
      format: Record<string, unknown>;
      numPredict: number;
      timeoutMs: number;
      temperature?: number;
    },
  ): Promise<OllamaChatMessage> {
    const conductor = this.config();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), options.timeoutMs);

    const body: Record<string, unknown> = {
      model: target.model,
      messages,
      stream: false,
      keep_alive: "30m",
      think: false,
      options: {
        temperature: options.temperature ?? conductor.temperature,
        top_p: conductor.top_p,
        top_k: conductor.top_k,
        num_ctx: conductor.num_ctx,
        num_predict: Math.min(options.numPredict, Math.max(64, conductor.max_tokens)),
      },
      format: options.format,
    };

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
      if (!json.message) throw new PersistentConductorError("Ollama conductor returned no message");
      return json.message;
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof PersistentConductorError) throw e;
      throw new PersistentConductorError(e instanceof Error ? e.message : String(e));
    }
  }

  private async callOllamaChat(target: ResolvedConductorTarget, messages: ConductorMessage[]): Promise<string> {
    // Route selection is deliberately schema-only. The conductor should emit
    // a compact decision, not author worker prompts or replay session memory;
    // those details are assembled by Jarvis-owned code after routing.
    const message = await this.callOllamaMessage(target, messages, {
      format: COORDINATOR_ROUTE_JSON_SCHEMA,
      numPredict: 320,
      timeoutMs: ROUTING_TIMEOUT_MS,
    });
    return extractConductorRoutingJson(message);
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
    const config = this.config();
    const maxTurns = Math.max(1, config.max_turns_in_cache);
    const system = session.messages.find((m) => m.role === "system");
    const nonSystem = session.messages.filter((m) => m.role !== "system");

    // Each turn is a user + assistant pair.
    const maxMessages = maxTurns * 2;
    let kept = nonSystem.length > maxMessages
      ? nonSystem.slice(nonSystem.length - maxMessages)
      : nonSystem;

    // Keep the reusable non-system prefix within half of the conductor context
    // window. Drop whole oldest turn pairs so role ordering stays valid.
    const tokenBudget = Math.floor(config.num_ctx * 0.5);
    while (kept.length > 0 && estimateMessageTokens(kept) > tokenBudget) {
      kept = kept.slice(Math.min(2, kept.length));
    }

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
