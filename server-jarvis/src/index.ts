// ═══════════════════════════════════════════════════════════════
// ── Jarvis Bun Server v2.0 ──
// ═══════════════════════════════════════════════════════════════
// WSL-side HTTP server on port 19877.
// Uses OpenAI-compatible API for both OpenRouter and Ollama.
// Hosts Qwen 3.5 9B locally via Ollama with OpenRouter fallback.
import { NFL_2025_PLAYERS, NFL_2025_DEFENSES } from "./football";
import { PRIZEPICKS_SYSTEM_PROMPT, buildPrizePicksContext, buildFullDatabaseContext, normalizeStatType, findPlayerName, generateWeeklyPicks } from "./prizepicks";

import { serve } from "bun";
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn, execSync } from "child_process";
import { loadConfig, normalizeConfig, CONFIG_DIR, COMPANION_FILE, surfaceTemperature } from "./config";
import type { JarvisConfig, OllamaConfig, SurfaceType } from "./config";
import { Database } from "bun:sqlite";
import { buildLearningPrompt, buildReviewPrompt, buildCodebaseAuditPrompt, buildFootballAuditPrompt } from "./cron-prompts";
import {
  handleListAgents,
  handleGetAgent,
  handleActivateAgent,
  handleDeactivateAgent,
  handleScanAgents,
} from "./agent-routes";
import { effectiveOllamaUrl, checkOllamaHealth, checkOllamaModelSupportsTools, resolveWindowsHostIP } from "./ollama";
import { streamClaudeCli, isClaudeCliAvailable } from "./claude-cli";
import { ReasoningParser, stripReasoningFromText, type ReasoningEvent } from "./reasoning";
import {
  listOpenRouterModels,
  checkOpenRouterHealth,
  chatCompletionWithFallback,
  isOpenRouterModelSupportsTools,
  logOpenRouterCost,
  resolveOpenRouterMaxTokens,
  resolveEffectiveOpenRouterRequestConfig,
  applyOpenRouterRequestConfig,
} from "./openrouter";
import type { OpenRouterCostInfo } from "./openrouter";
import { recordInference, inferenceMetricsSnapshot, type Backend } from "./inference-metrics";
import { createApprovalRegistry } from "./approval-registry";

// One process-level approval registry: the chat surface emits
// `tool_approval_request` SSE events and awaits decisions here.
// The UI resolves them via POST /tool/decision.
const approvalRegistry = createApprovalRegistry();
import type { ToolCall } from "./tool-types";
import {
  buildTextToolInstructions,
  extractTextToolCalls,
  hasExplicitWebSearchIntent,
  hasLocalWorkspaceToolIntent,
  isNativeToolProtocolUnsupportedError,
  TextToolCallStreamSanitizer,
  textToolResultsPrompt,
  webSearchQueryFromPrompt,
} from "./text-tools";
import {
  createToolRuntime,
  makeExecutionContext,
  toApiTools,
} from "./tool-runtime";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import { registerFilesystemBundle } from "./filesystem-bundle";
import { registerShellBundle } from "./shell-bundle";
import { registerWebBundle, searchWeb } from "./web-bundle";
import { registerMetaBundle } from "./meta-bundle";
import { registerTaskBundle } from "./task-bundle";
import { registerMcpClientBundle } from "./mcp-client-bundle";
import { registerInteractiveBundle, getSessionState, clearSessionState } from "./interactive-bundle";
import { PredictiveRouter } from "./orchestration/router";
import { PipelineExecutor } from "./orchestration/pipeline";
import { outcomeCollector, selfTuningProposer, SelfTuningStore } from "./self-tuning/mod";

// ── Structured Logging Override ──────────────────────────────────────────────
const originalLog = console.log;
const originalError = console.error;

function formatLogLine(level: string, ...args: any[]): string {
  const ts = new Date().toISOString();
  let target = "Jarvis";
  let message = "";

  if (args.length > 0 && typeof args[0] === "string" && args[0].startsWith("[")) {
    const endBracket = args[0].indexOf("]");
    if (endBracket > 0) {
      target = args[0].slice(1, endBracket).trim().replace(/\s+/g, "_");
      const rest = args[0].slice(endBracket + 1).trim();
      const otherArgs = args.slice(1).map(x => {
        if (x instanceof Error) return x.stack || x.message;
        return typeof x === "object" ? JSON.stringify(x) : String(x);
      }).join(" ");
      message = rest + (otherArgs ? " " + otherArgs : "");
    }
  }

  if (!message) {
    message = args.map(x => {
      if (x instanceof Error) return x.stack || x.message;
      return typeof x === "object" ? JSON.stringify(x) : String(x);
    }).join(" ");
  }

  // Escape newlines to prevent breaking line-based log parsing
  const escapedMessage = message.replace(/\r?\n/g, " ↵ ");

  return `${ts} ${level} ${target}: ${escapedMessage}`;
}

console.log = (...args: any[]) => {
  originalLog(formatLogLine("INFO", ...args));
};

console.error = (...args: any[]) => {
  originalError(formatLogLine("ERROR", ...args));
};

console.warn = (...args: any[]) => {
  originalLog(formatLogLine("WARN", ...args));
};

const MODEL_REQUEST_TIMEOUT_MS = 300_000;
const MODEL_STREAM_STALL_TIMEOUT_MS = 120_000;
const MODEL_STREAM_STALL_CHECK_MS = 125_000;
const MAX_TOOL_RESULT_CHARS = 2000;  // Truncate tool results going back to model context
const MAX_TOOL_EXECUTION_TURNS = 10;
const activeStreamControllers = new Map<string, AbortController>();

function visibleTextFromReasoningEvent(event: ReasoningEvent): string {
  switch (event.type) {
    case "content":
      return event.text;
    case "reasoning_chunk":
      return event.text;
    default:
      return "";
  }
}

function ensureActiveToolCall(activeToolCalls: Array<{ id?: string; name?: string; arguments?: string }>, idx: number) {
  if (!activeToolCalls[idx]) {
    activeToolCalls[idx] = { id: "", name: "", arguments: "" };
  }
  return activeToolCalls[idx];
}

async function resolveOutputMaxTokens(
  cfg: JarvisConfig,
  isOllama: boolean,
  modelName: string,
  messages: Array<any>,
  requested?: unknown,
): Promise<number | undefined> {
  if (!isOllama) {
    return resolveOpenRouterMaxTokens(cfg, modelName, messages, requested);
  }

  const raw = requested ?? cfg.max_tokens;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;

  return Math.floor(parsed);
}

async function applyOutputMaxTokens(
  requestBody: Record<string, any>,
  cfg: JarvisConfig,
  isOllama: boolean,
  modelName: string,
  messages: Array<any>,
  requested?: unknown,
): Promise<void> {
  const maxTokens = await resolveOutputMaxTokens(cfg, isOllama, modelName, messages, requested);
  if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;
}

/** Truncate a tool result for model context. Keeps the beginning and end, with a marker. */
function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2) - 40;
  return text.slice(0, half) + "\n\n[...truncated — " + (text.length - MAX_TOOL_RESULT_CHARS) + " chars removed. Use read_file for full content...]\n\n" + text.slice(-half);
}

/**
 * Build a ToolRuntime for the chat loop by registering the canonical tool
 * bundles. Every surface (chat, cron, agent, mcp) now executes through this
 * same ToolRuntime contract; the chat surface composes the full bundle set.
 */
function buildChatRuntime(cfg: JarvisConfig): {
  runtime: ToolRuntime;
  ctx: ExecutionContext;
} {
  const runtime = createToolRuntime();
  registerFilesystemBundle(runtime);
  registerShellBundle(runtime);
  registerWebBundle(runtime);
  registerMetaBundle(runtime);
  registerTaskBundle(runtime);
  registerMcpClientBundle(runtime);
  registerInteractiveBundle(runtime);

  const ctx = makeExecutionContext("chat", cfg, {
    workspace_path: cfg.jarvis_path,
  });

  return { runtime, ctx };
}

export interface JarvisSession {
  id: string;
  name: string;
  created_at: string;
  model: string;
  message_count: number;
  last_active?: string;
  total_tokens?: number;
}

export interface JarvisMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  tool_name?: string;
  isStreaming?: boolean;
}

export interface BridgeRequest {
  from: string;
  message: string;
  session: string;
  timeout_secs?: number;
}

export interface BridgeResponse {
  response: string;
  session_id: string;
  tokens_used?: number;
  error?: string;
}

interface ChatHistoryMessage {
  role: "user" | "assistant" | "system" | "tool" | string;
  content: string;
}

interface StreamJarvisOptions {
  config?: Partial<JarvisConfig>;
  history?: ChatHistoryMessage[];
  systemPromptOverride?: string;
  surface?: SurfaceType;
}

// OpenClaw interfaces removed — Jarvis is now self-contained

export interface CompanionState {
  enabled: boolean;
  name: string;
  species: string;
  rarity: string;
  mood: string;
  happiness: number;
  energy: number;
  level?: number;
  xp?: number;
  xp_to_next?: number;
  interactions_total: number;
  last_interaction?: string;
}

export function loadCompanionState(cfg: JarvisConfig): CompanionState {
  const comp = cfg.companion || { enabled: true, name: "Nyx", species: "cat", rarity: "rare" };
  const baseState: CompanionState = {
    enabled: comp.enabled,
    name: comp.name,
    species: comp.species,
    rarity: comp.rarity,
    mood: "idle",
    happiness: 85,
    energy: 92,
    level: 1,
    xp: 0,
    xp_to_next: 100,
    interactions_total: 0,
    last_interaction: undefined,
  };

  try {
    if (existsSync(COMPANION_FILE)) {
      const saved = JSON.parse(readFileSync(COMPANION_FILE, "utf-8"));
      return {
        ...baseState,
        ...saved,
        enabled: comp.enabled,
        name: comp.name || saved.name || baseState.name,
        species: comp.species || saved.species || baseState.species,
        rarity: comp.rarity || saved.rarity || baseState.rarity,
      };
    }
  } catch (e) {
    console.error("[Companion] Failed to load companion state:", e);
  }
  return baseState;
}

export function saveCompanionState(state: CompanionState): void {
  try {
    writeFileSync(COMPANION_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[Companion] Failed to save companion state:", e);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── Constants ──
// ═══════════════════════════════════════════════════════════════
const PORT = Number(process.env.JARVIS_SERVER_PORT ?? 19877);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`JARVIS_SERVER_PORT must be an integer between 1 and 65535, got ${process.env.JARVIS_SERVER_PORT}`);
}
const BRIDGE_PORT = 19876;
const JARVIS_VERSION = "3.0.0";

let totalRequests = 0;
const startTime = Date.now();

interface CompactionCacheEntry {
  originalLength: number;
  prefixHash: string;
  summary: any;
}
const compactionCache = new Map<string, CompactionCacheEntry>();

function getMessagesHash(messages: Array<any>): string {
  return messages.map(m => `${m.role}:${m.content || ""}`).join("|");
}

function normalizeMessagesForLLM(msgs: Array<any>): Array<any> {
  if (!msgs || msgs.length === 0) return [];
  
  const normalized: Array<any> = [];
  const systemContents: string[] = [];
  
  // Collect all system messages at the very beginning
  let i = 0;
  while (i < msgs.length && msgs[i] && msgs[i].role === "system") {
    if (msgs[i].content) {
      systemContents.push(msgs[i].content);
    }
    i++;
  }
  
  if (systemContents.length > 0) {
    normalized.push({
      role: "system",
      content: systemContents.join("\n\n---\n\n"),
    });
  }
  
  // Process the rest of the messages
  for (let j = i; j < msgs.length; j++) {
    const msg = msgs[j];
    if (!msg) continue;
    if (msg.role === "system") {
      // Convert middle/end system messages to user messages to prevent template compilation errors in llama.cpp (e.g. Qwen)
      normalized.push({
        ...msg,
        role: "user",
        content: msg.content?.startsWith("[") ? msg.content : `[System: ${msg.content}]`,
      });
    } else {
      normalized.push(msg);
    }
  }
  
  return normalized;
}

function agentsDbPath(): string {
  return join(CONFIG_DIR, "agent_projections.db");
}

function agentsRootPath(): string {
  const cfg = loadConfig();
  return cfg.agents_root;
}

const cliSessionMap = new Map<string, string>(); // appSessionId → Claude CLI session ID for --resume

function resolveConfig(configOverride?: Partial<JarvisConfig> | null): JarvisConfig {
  return configOverride ? normalizeConfig(configOverride) : loadConfig();
}






// ═══════════════════════════════════════════════════════════════
// ── Skills ──
// ═══════════════════════════════════════════════════════════════
interface SkillDef {
  name: string; description: string; category: string; enabled: boolean;
  source: string; usage_count: number; last_used: string | null;
}

const BUNDLED_SKILLS: SkillDef[] = [
  { name: "code-review", description: "Review code for quality and best practices", category: "development", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "debug", description: "Debug issues in your codebase", category: "development", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "test-gen", description: "Generate unit tests for your code", category: "development", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "docs", description: "Generate documentation for your code", category: "documentation", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "refactor", description: "Suggest refactoring improvements", category: "development", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "security-audit", description: "Scan for security vulnerabilities", category: "security", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "git-helper", description: "Git workflow assistance", category: "workflow", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "explain", description: "Explain complex code or concepts", category: "learning", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "sql", description: "Write and optimize SQL queries", category: "data", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "api-design", description: "Design REST and GraphQL APIs", category: "development", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "batch", description: "Run batch operations on multiple files", category: "workflow", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "remember", description: "Save and recall memories across sessions", category: "memory", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "verify", description: "Verify changes work correctly", category: "development", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "simplify", description: "Simplify complex code or text", category: "development", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "loop", description: "Run a prompt in a loop with conditions", category: "workflow", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "performance-profile", description: "Analyze performance bottlenecks and resource utilization", category: "performance", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "architecture-review", description: "Analyze system structure, boundaries, and dependencies for scalability, modularity, and alignment with clean architecture", category: "architecture", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "enterprise-observability", description: "Audit and implement production-grade telemetry, logging, tracing, and alerting for large scale enterprise services", category: "observability", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "enterprise-resilience", description: "Audit and implement robust distributed systems patterns including circuit breakers, retry policy, backoff, fallback, rate limiting, and bulkhead isolation", category: "resilience", enabled: true, source: "bundled", usage_count: 0, last_used: null },
  { name: "inference-optimization", description: "Audit, design, and optimize LLM inference pathways, prompt formatting, context compaction, and response streaming", category: "performance", enabled: true, source: "bundled", usage_count: 0, last_used: null },
];

function loadSkills(): SkillDef[] {
  const cfg = loadConfig();
  const skillsDir = join(cfg.jarvis_path, "skills", "bundled");
  const skills = [...BUNDLED_SKILLS];
  try {
    if (existsSync(skillsDir)) {
      for (const f of readdirSync(skillsDir)) {
        if (f.endsWith(".ts") && !skills.some(s => s.name === f.replace(".ts", ""))) {
          skills.push({ name: f.replace(".ts", ""), description: "Loaded from Jarvis source", category: "custom", enabled: true, source: "jarvis", usage_count: 0, last_used: null });
        }
      }
    }
  } catch {}
  return skills;
}

// ═══════════════════════════════════════════════════════════════
// ── Tools ──
// ═══════════════════════════════════════════════════════════════
interface ToolDef {
  name: string; description: string;
  parameters: { name: string; param_type: string; description: string; required: boolean }[];
}

const BUILTIN_TOOLS: ToolDef[] = [
  { name: "Bash", description: "Execute shell commands", parameters: [{ name: "command", param_type: "string", description: "Shell command to execute", required: true }, { name: "timeout", param_type: "number", description: "Timeout in ms", required: false }] },
  { name: "Read", description: "Read file contents", parameters: [{ name: "file_path", param_type: "string", description: "Absolute path to file", required: true }, { name: "offset", param_type: "number", description: "Line offset", required: false }] },
  { name: "Edit", description: "Edit files with string replacements", parameters: [{ name: "file_path", param_type: "string", description: "Path to file", required: true }, { name: "old_string", param_type: "string", description: "Text to replace", required: true }, { name: "new_string", param_type: "string", description: "Replacement text", required: true }] },
  { name: "Write", description: "Write content to files", parameters: [{ name: "file_path", param_type: "string", description: "Path to file", required: true }, { name: "content", param_type: "string", description: "File content", required: true }] },
  { name: "Glob", description: "Find files by glob pattern", parameters: [{ name: "pattern", param_type: "string", description: "Glob pattern", required: true }, { name: "path", param_type: "string", description: "Search directory", required: false }] },
  { name: "Grep", description: "Search file contents with regex", parameters: [{ name: "pattern", param_type: "string", description: "Regex pattern", required: true }, { name: "path", param_type: "string", description: "Search directory", required: false }] },
  { name: "WebFetch", description: "Fetch and extract web content", parameters: [{ name: "url", param_type: "string", description: "URL to fetch", required: true }, { name: "prompt", param_type: "string", description: "Extraction prompt", required: true }] },
  { name: "WebSearch", description: "Search the web", parameters: [{ name: "query", param_type: "string", description: "Search query", required: true }] },
  { name: "TodoWrite", description: "Manage task list", parameters: [{ name: "todos", param_type: "array", description: "Todo items", required: true }] },
  { name: "Task", description: "Launch sub-agents", parameters: [{ name: "description", param_type: "string", description: "Task description", required: true }, { name: "prompt", param_type: "string", description: "Sub-agent prompt", required: true }] },
  { name: "MultiEdit", description: "Apply multiple edits to a file", parameters: [{ name: "file_path", param_type: "string", description: "Path to file", required: true }, { name: "edits", param_type: "array", description: "Edit operations", required: true }] },
  { name: "NotebookEdit", description: "Edit Jupyter notebook cells", parameters: [{ name: "notebook_path", param_type: "string", description: "Path to notebook", required: true }, { name: "cell_id", param_type: "string", description: "Cell identifier", required: true }] },
  { name: "AskUserQuestion", description: "Ask the user a question and WAIT for their response. Use when you need clarification, confirmation, or a decision before proceeding. The conversation pauses until the user answers. Pass an array of question objects with 'question' text and optional 'header', 'options', and 'multiSelect' fields.", parameters: [{ name: "questions", param_type: "array", description: "Array of question objects, each with a 'question' string and optional fields", required: true }] },
  { name: "EnterPlanMode", description: "Enter planning mode for complex multi-step tasks. Before writing any code or making changes, analyze the task and create a detailed step-by-step plan. The plan is presented to the user for approval before execution begins. Use this when: the task has 3+ steps, involves risk or side effects, or the user explicitly asks for planning.", parameters: [] },
  { name: "ExitPlanMode", description: "Exit planning mode with the completed plan. Call this after you have analyzed the task and written your step-by-step plan. Pass the full plan text so the user can review and approve it before you begin executing.", parameters: [{ name: "plan", param_type: "string", description: "The complete step-by-step plan text for user review", required: true }] },
];

function loadTools(): ToolDef[] { return BUILTIN_TOOLS; }

// ═══════════════════════════════════════════════════════════════
// ── Model Discovery ──
// ═══════════════════════════════════════════════════════════════
async function discoverModels(configOverride?: Partial<JarvisConfig>): Promise<any[]> {
  const cfg = resolveConfig(configOverride);
  if (cfg.active_backend === "ollama") {
    let emptyReachableModels: any[] | null = null;
    for (const cleanUrl of ollamaBaseUrlCandidates(cfg.ollama)) {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const resp = await fetch(`${cleanUrl}/api/tags`, { signal: ctrl.signal });
        if (!resp.ok) continue;
        const json = await resp.json();
        const models = json.models || [];
        const discovered = models.map((m: any) => ({
          id: m.name, name: m.name,
          context_length: m.context_length || m.details?.context_length || 32768,
          pricing: "free",
          description: `Size: ${((m.size || 0) / 1e9).toFixed(1)}B params`,
          source: "ollama", digest: m.digest || "", size_bytes: m.size || 0, modified_at: m.modified_at || "",
        }));
        if (discovered.length === 0) {
          emptyReachableModels = discovered;
          continue;
        }
        return discovered;
      } catch (e) { console.error(`[Jarvis] Ollama model discovery failed at ${cleanUrl}:`, e); }
    }
    return emptyReachableModels ?? [];
  } else {
    try {
      const models = await listOpenRouterModels(cfg);
      return models.map(m => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        max_completion_tokens: m.max_completion_tokens ?? m.top_provider?.max_completion_tokens ?? null,
        pricing: m.pricing,
        pricing_prompt: m.pricing?.prompt ?? "",
        pricing_completion: m.pricing?.completion ?? "",
        is_free: m.is_free,
        is_router: m.is_router,
        modality: m.modality,
        supported_parameters: m.supported_parameters,
        default_parameters: m.default_parameters,
        description: m.description.slice(0, 80),
        source: "openrouter",
      }));
    } catch (e) { console.error("[Jarvis] OpenRouter model discovery failed:", e); return []; }
  }
}

// ═══════════════════════════════════════════════════════════════
// ── Connection Test ──
// ═══════════════════════════════════════════════════════════════
async function testConnection(configOverride?: Partial<JarvisConfig>): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const cfg = resolveConfig(configOverride);
  if (cfg.active_backend === "ollama") {
    const health = await checkOllamaHealth(cfg.ollama);
    return { ok: health.running && health.modelAvailable, latency_ms: health.latencyMs, error: health.error };
  }
  if (cfg.active_backend === "claude_cli") {
    const path = cfg.claude_cli.path || "claude";
    const available = await isClaudeCliAvailable(path);
    return { ok: available, latency_ms: 0, error: available ? undefined : `Claude CLI not found at '${path}'. Make sure 'claude' is on PATH.` };
  }
  // OpenRouter
  if (!cfg.openrouter.api_key || cfg.openrouter.api_key.length <= 5 || cfg.openrouter.api_key === "ollama") {
    return { ok: false, latency_ms: 0, error: "No OpenRouter API key configured. Add your key in the Config tab." };
  }
  const health = await checkOpenRouterHealth(cfg, true);
  return { ok: health.ok, latency_ms: health.latencyMs, error: health.error };
}

function cleanOllamaBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function ollamaBaseUrlCandidates(cfg: OllamaConfig): string[] {
  return uniqueStrings([
    cleanOllamaBaseUrl(cfg.base_url),
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    cleanOllamaBaseUrl(effectiveOllamaUrl(cfg)),
  ]);
}

function equivalentOllamaModelName(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/:latest$/, "");
  return a === b || a === `${b}:latest` || `${a}:latest` === b || normalize(a) === normalize(b);
}

function selectInstalledOllamaModel(cfg: JarvisConfig, installedModels: string[]): string {
  const requested = cfg.ollama.model;
  const activeProfile = (cfg as any).profiles?.[(cfg as any).active_profile]?.model_id;
  const profileModelIds: string[] = [];
  if ((cfg as any).profiles) {
    for (const key of Object.keys((cfg as any).profiles)) {
      const p = (cfg as any).profiles[key];
      if (p?.model_id) {
        profileModelIds.push(p.model_id);
      }
    }
  }

  const candidates = uniqueStrings([
    requested,
    activeProfile,
    ...profileModelIds,
    "qwen3.5-9b:latest",
    "qwen3.5-9b",
  ]);

  const firstUsefulModel = installedModels.find((name) => !name.includes("embed"))
    ?? installedModels[0]
    ?? requested;
  if (firstUsefulModel !== requested) {
    console.warn(`[Jarvis] Ollama model "${requested}" is not installed; using "${firstUsefulModel}" instead.`);
  }
  return firstUsefulModel;
}

interface CachedOllamaTarget {
  chatUrl: string;
  modelName: string;
  tried: string[];
  supportsNativeTools: boolean;
  timestamp: number;
}
const ollamaTargetCache = new Map<string, CachedOllamaTarget>();
const OLLAMA_TARGET_CACHE_TTL = 10000; // 10 seconds

async function resolveOllamaChatTarget(cfg: JarvisConfig): Promise<{ chatUrl: string; modelName: string; tried: string[]; supportsNativeTools: boolean }> {
  const cacheKey = cfg.ollama.model;
  const now = Date.now();
  const cached = ollamaTargetCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < OLLAMA_TARGET_CACHE_TTL) {
    return cached;
  }

  const tried: string[] = [];
  let bestReachable: { chatUrl: string; modelName: string; tried: string[]; supportsNativeTools: boolean } | null = null;

  for (const cleanUrl of ollamaBaseUrlCandidates(cfg.ollama)) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3000);
      const tagsResp = await fetch(`${cleanUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timeout);

      if (!tagsResp.ok) {
        tried.push(`${cleanUrl} -> HTTP ${tagsResp.status}`);
        continue;
      }

      const tagsJson = await tagsResp.json();
      const models = (tagsJson.models || [])
        .map((model: any) => model.name || model.model || "")
        .filter(Boolean);

      if (models.length === 0) {
        tried.push(`${cleanUrl} -> no models`);
        continue;
      }

      const modelName = selectInstalledOllamaModel(cfg, models);

      // /api/tags doesn't report capabilities — query /api/show for the
      // resolved model to find out whether it supports native tool calls.
      const supportsNativeTools = await checkOllamaModelSupportsTools(cleanUrl, modelName);

      const target = {
        chatUrl: `${cleanUrl}/v1/chat/completions`,
        modelName,
        tried: [...tried],
        supportsNativeTools,
      };

      if (equivalentOllamaModelName(modelName, cfg.ollama.model)) {
        const result = { ...target, tried: [...tried] };
        ollamaTargetCache.set(cacheKey, { ...result, timestamp: now });
        return result;
      }

      bestReachable ??= target;
    } catch (error: any) {
      tried.push(`${cleanUrl} -> ${error?.message || String(error)}`);
    }
  }

  if (bestReachable) {
    const result = { ...bestReachable, tried };
    ollamaTargetCache.set(cacheKey, { ...result, timestamp: now });
    return result;
  }

  const fallbackUrl = ollamaBaseUrlCandidates(cfg.ollama)[0] ?? "http://localhost:11434";
  const fallback = {
    chatUrl: `${fallbackUrl}/v1/chat/completions`,
    modelName: cfg.ollama.model,
    tried,
    supportsNativeTools: false,
  };
  ollamaTargetCache.set(cacheKey, { ...fallback, timestamp: now });
  return fallback;
}

async function resolveOpenRouterModel(cfg: JarvisConfig): Promise<string> {
  const requested = cfg.openrouter.model;
  const candidates = uniqueStrings([
    requested,
    "openrouter/free",
    "openrouter/owl-alpha",
    ...cfg.openrouter.fallbacks,
  ]);

  try {
    const models = await listOpenRouterModels(cfg);
    const ids = new Set(models.map(model => model.id).filter(Boolean));
    for (const candidate of candidates) {
      if (ids.has(candidate)) {
        if (candidate !== requested) {
          console.warn(`[Jarvis] OpenRouter model "${requested}" was not found; using "${candidate}" instead.`);
        }
        return candidate;
      }
    }
  } catch (error) {
    console.warn("[Jarvis] OpenRouter model validation failed:", error);
  }

  return requested;
}

// ═══════════════════════════════════════════════════════════════
// ── Jarvis chat (SSE stream via OpenAI-compatible API) ──
// ── Jarvis chat (SSE stream via OpenAI-compatible API) ──
// ═══════════════════════════════════════════════════════════════
// ── Auto-compaction helper ─────────────────────────────────
/**
 * Summarize older messages when context window is getting full.
 * Keeps the most recent `keepRecent` messages, summarizes the rest.
 * Returns the compacted message array.
 */
async function compactHistory(
  messages: Array<any>,
  cfg: JarvisConfig,
  isOllama: boolean,
  ollamaTarget: { chatUrl: string; modelName: string } | null,
  resolvedOpenRouterModel: string | null,
  keepRecent: number = 20,
): Promise<Array<any>> {
  if (messages.length <= keepRecent + 10) return messages;

  const oldMessages = messages.slice(0, messages.length - keepRecent);
  const recentMessages = messages.slice(-keepRecent);

  // Format old messages as conversation text for summarization
  const conversationText = oldMessages
    .map((m) => `${m.role}: ${m.content || ""}`.slice(0, 2000))
    .join("\n\n");

  const modelName = isOllama
    ? (cfg.compaction?.enabled && cfg.compaction?.model ? cfg.compaction.model : (ollamaTarget?.modelName ?? cfg.ollama.model))
    : resolvedOpenRouterModel ?? cfg.openrouter.model;
  const chatUrl = isOllama
    ? (cfg.compaction?.enabled && cfg.compaction?.ollama_url ? `${cfg.compaction.ollama_url.replace(/\/+$/, "")}/v1/chat/completions` : (ollamaTarget?.chatUrl ?? `${cfg.ollama.base_url}/v1/chat/completions`))
    : `${cfg.openrouter.base_url}/chat/completions`;

  const requestBody: Record<string, any> = {
    model: modelName,
    messages: [
      { role: "system", content: "Summarize the conversation history concisely. Preserve key facts, decisions, tasks, and unresolved issues." },
      ...oldMessages,
    ],
    stream: false,
    temperature: surfaceTemperature(cfg, "compaction"),
    ...(isOllama ? { options: { temperature: surfaceTemperature(cfg, "compaction"), num_ctx: 4096 } } : {}),
  };
  if (isOllama) {
    requestBody.max_tokens = cfg.compaction?.max_tokens ?? 2048;
  } else {
    await applyOpenRouterRequestConfig(requestBody, cfg, modelName, requestBody.messages, {
      requestedTemperature: surfaceTemperature(cfg, "compaction"),
      requestedTopP: cfg.top_p,
      surface: "compaction",
    });
  }

  const headers: Record<string, string> = {
    "Authorization": isOllama ? "Bearer ollama" : `Bearer ${cfg.openrouter.api_key}`,
    "Content-Type": "application/json",
  };
  if (!isOllama) {
    headers["HTTP-Referer"] = cfg.openrouter.site_url || "http://localhost:19877";
    headers["X-Title"] = cfg.openrouter.site_name || "Jarvis";
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60_000);

  const resp = await fetch(chatUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: ctrl.signal,
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    throw new Error(`Compaction API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const data = await resp.json();
  const summary: string =
    data?.choices?.[0]?.message?.content?.trim() ||
    data?.message?.content?.trim() ||
    "";

  if (!summary) {
    throw new Error("Compaction returned empty summary");
  }

  return [
    { role: "system", content: `[Previous conversation summary]\n${summary}` },
    ...recentMessages,
  ];
}

function optimizeContextWindow(
  history: Array<{ role: string; content?: string | null; [key: string]: any }>,
  effectiveSystemPrompt: string,
  currentPrompt: string,
  numCtx: number
): Array<{ role: string; content?: string | null; [key: string]: any }> {
  const estimateTokens = (text: string) => Math.ceil((text || "").length / 4);
  const generationReserve = Math.min(2048, Math.floor(numCtx * 0.2));

  // Find all leading system messages to pin them
  let startIndex = 0;
  const pinnedSystemMessages: typeof history = [];
  while (startIndex < history.length && history[startIndex]?.role === "system") {
    pinnedSystemMessages.push(history[startIndex]);
    startIndex++;
  }

  let pinnedTokens = 0;
  for (const msg of pinnedSystemMessages) {
    pinnedTokens += estimateTokens(msg.content || "");
  }

  const baseTokens = estimateTokens(effectiveSystemPrompt) + estimateTokens(currentPrompt) + pinnedTokens;
  const budget = numCtx - generationReserve - baseTokens;

  if (budget <= 500) {
    console.warn(`[ContextOpt] Context budget exhausted or extremely small. Clearing active history.`);
    return pinnedSystemMessages;
  }

  // Group history messages to avoid splitting tool calls and their responses
  const groups: Array<Array<any>> = [];
  let currentGroup: Array<any> = [];

  for (let i = startIndex; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "tool") {
      // Tool responses belong to the previous assistant tool call group
      currentGroup.push(msg);
    } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      // Start a new group for assistant tool call
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [msg];
    } else {
      // Standard message starts a new group
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [msg];
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  let usedTokens = 0;
  const retainedGroups: Array<Array<any>> = [];

  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    let groupTokens = 0;
    for (const msg of group) {
      let msgStr = msg.content || "";
      if (msg.tool_calls) msgStr += JSON.stringify(msg.tool_calls);
      if (msg.tool_call_id) msgStr += msg.tool_call_id;
      groupTokens += estimateTokens(msgStr);
    }

    if (usedTokens + groupTokens > budget) {
      break;
    }
    usedTokens += groupTokens;
    retainedGroups.unshift(group);
  }

  const retained = retainedGroups.flat();
  return [...pinnedSystemMessages, ...retained];
}

async function streamJarvis(message: string, sessionId: string, options: StreamJarvisOptions = {}): Promise<Response> {
  const cfg = resolveConfig(options.config);
  const surface: SurfaceType = options.surface ?? "chat";
  const effectiveTemp = surfaceTemperature(cfg, surface);
  const turnHistory = (options.history ?? [])
    .filter((m) => ["user", "assistant", "system", "tool"].includes(m.role))
    .map((m) => {
      const msg: any = { role: m.role, content: m.content || "" };
      if ((m as any).tool_calls) msg.tool_calls = (m as any).tool_calls;
      if ((m as any).tool_call_id) msg.tool_call_id = (m as any).tool_call_id;
      return msg;
    });
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  totalRequests++;
  const _turnStart = Date.now();

  (async () => {
    const streamAbort = new AbortController();
    activeStreamControllers.set(sessionId, streamAbort);
    try {
      const systemPrompt = options.systemPromptOverride ?? cfg.system_prompt;
      const isOllama = cfg.active_backend === "ollama";
      const ollamaTarget = isOllama ? await resolveOllamaChatTarget(cfg) : null;
      const resolvedOpenRouterModel = cfg.active_backend === "openrouter"
        ? await resolveOpenRouterModel(cfg)
        : null;
      const modelLabel = cfg.active_backend === "claude_cli"
        ? `claude-cli:${cfg.ollama.model}`
        : cfg.active_backend === "openrouter"
          ? resolvedOpenRouterModel
          : ollamaTarget?.modelName ?? cfg.ollama.model;

      console.log(`[Jarvis] Stream start session=${sessionId} backend=${cfg.active_backend} model=${modelLabel}`);
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "init", session_id: sessionId, model: modelLabel })}\n\n`));

      // ── Claude CLI path ──────────────────────────────────────────
      if (cfg.active_backend === "claude_cli") {
        const reasoningParser = cfg.reasoning.enabled ? new ReasoningParser(sessionId) : null;
        const resumedSessionId = cliSessionMap.get(sessionId);
        const historyPrompt = !resumedSessionId && turnHistory.length > 0
          ? `${turnHistory.map(m => {
              if (m.role === "tool") {
                return `tool response:\n${m.content}`;
              }
              return `${m.role}: ${m.content}`;
            }).join("\n\n")}\n\n`
          : "";
        const promptBody = `${historyPrompt}user: ${message}`;

        // Build CLI args: system prompt via --append-system-prompt, model, prompt as positional
        const cliArgs = [...(cfg.claude_cli.args || ["--print", "--verbose", "--output-format", "stream-json"])];
        // When using Claude CLI with Ollama, pass the model via --model
        const ollamaModel = cfg.ollama?.model || "qwen3:8b";
        cliArgs.push("--model", ollamaModel);
        if (systemPrompt) {
          cliArgs.push("--append-system-prompt", systemPrompt);
        }

        for await (const evt of streamClaudeCli(cfg, {
          prompt: promptBody,
          session_id: resumedSessionId,
          cwd: cfg.claude_cli.cwd,
          max_turns: 1,
          cliArgs,
        })) {
          if (evt.type === "stream_event" && evt.delta?.text) {
            const text: string = evt.delta.text;
            if (reasoningParser) {
              for (const re of reasoningParser.processChunk(text)) {
                const visibleText = visibleTextFromReasoningEvent(re);
                if (!visibleText) continue;
                if (re.type === "reasoning_step") {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
                } else if (re.type === "reasoning_chunk") {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
                } else {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text: visibleText }, session_id: sessionId })}\n\n`));
                }
              }
            }
            await writer.write(encoder.encode(`data: ${JSON.stringify({ ...evt, session_id: sessionId })}\n\n`));
          } else if (evt.type === "error") {
            if (resumedSessionId) {
              cliSessionMap.delete(sessionId);
            }
            await writer.write(encoder.encode(`data: ${JSON.stringify({ ...evt, session_id: sessionId })}\n\n`));
          } else if (evt.type === "result") {
            if (evt.session_id) {
              cliSessionMap.set(sessionId, evt.session_id);
            }
            if (reasoningParser) {
              for (const re of reasoningParser.flush()) {
                const visibleText = visibleTextFromReasoningEvent(re);
                if (!visibleText) continue;
                if (re.type === "reasoning_step") {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
                } else if (re.type === "reasoning_chunk") {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
                } else {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text: visibleText }, session_id: sessionId })}\n\n`));
                }
              }
              const trace = reasoningParser.finalize();
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_complete", trace, session_id: sessionId })}\n\n`));
            }
            await writer.write(encoder.encode(`data: ${JSON.stringify({ ...evt, session_id: sessionId })}\n\n`));
          }
        }
        return;
      }

      // ── Build canonical tool runtime for this request ───────────
      const { runtime, ctx } = buildChatRuntime(cfg);
      // Patch the execution context with the active session ID so
      // interactive tools (ask_user_question) can scope state per-session.
      ctx.session_id = sessionId;
      // Wire the approval hook: emit a `tool_approval_request` SSE event so
      // the Tauri runner relays it to the UI (ToolApprovalModal), then await
      // the user's decision from the process-level registry. Auto-denies after
      // 5 minutes so a disconnected client can never wedge the stream.
      ctx.requestApproval = async (req) => {
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "tool_approval_request",
              call_id: req.call_id,
              name: req.name,
              arguments: req.arguments,
              session_id: sessionId,
            })}\n\n`,
          ),
        );
        return approvalRegistry.request(req.call_id);
      };

      // ── Orchestrator path (PAMO-SET Phase 2) ─────────────────────
      if (cfg.orchestrator?.enabled) {
        console.log(`[Jarvis Orchestrator] Starting session=${sessionId}`);

        // Setup context message using turn history if present
        let contextMessage = message;
        if (turnHistory.length > 0) {
          const formattedHistory = turnHistory
            .map((m: any) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 1000)}${m.content.length > 1000 ? "..." : ""}`)
            .join("\n");
          contextMessage = `Conversation History:\n${formattedHistory}\n\nLatest User Request: ${message}`;
        }

        // Custom CallModelFn for pipeline execution
        const callModel = async (messages: any[], callOptions?: any) => {
          const isOllama = cfg.active_backend === "ollama";
          const ollamaTarget = isOllama ? await resolveOllamaChatTarget(cfg) : null;
          const resolvedOpenRouterModel = cfg.active_backend === "openrouter"
            ? await resolveOpenRouterModel(cfg)
            : null;

          const modelName = isOllama
            ? (ollamaTarget?.modelName ?? cfg.ollama.model)
            : resolvedOpenRouterModel ?? cfg.openrouter.model;
          const openRouterEffective = !isOllama
            ? await resolveEffectiveOpenRouterRequestConfig(cfg, modelName, messages, { surface })
            : null;
          const baseUrl = isOllama
            ? ollamaTarget!.chatUrl
            : `${cfg.openrouter.base_url}/chat/completions`;

          const modelSupportsNativeTools = isOllama
            ? (ollamaTarget?.supportsNativeTools ?? false)
            : (openRouterEffective?.supports_tools ?? isOpenRouterModelSupportsTools(modelName));
          // Use text tool protocol if native tools are disabled/unsupported and tools are requested
          const useTextTools = !modelSupportsNativeTools && callOptions?.tools && callOptions.tools.length > 0;

          let effectiveMessages = [...messages];
          if (useTextTools) {
            const textInstructions = buildTextToolInstructions(callOptions.tools);
            const sysIdx = effectiveMessages.findIndex((m) => m.role === "system");
            if (sysIdx >= 0) {
              effectiveMessages[sysIdx] = {
                role: "system",
                content: `${effectiveMessages[sysIdx].content}\n\n${textInstructions}`,
              };
            } else {
              effectiveMessages.unshift({ role: "system", content: textInstructions });
            }
          }

          const normalizedMessages = normalizeMessagesForLLM(effectiveMessages);
          const requestBody: Record<string, any> = {
            model: modelName,
            messages: normalizedMessages,
            stream: true,
          };

          if (isOllama) {
            await applyOutputMaxTokens(requestBody, cfg, isOllama, modelName, normalizedMessages, callOptions?.max_tokens);
            if (callOptions?.temperature !== undefined) {
              requestBody.temperature = callOptions.temperature;
            } else if (cfg.temperature !== undefined) {
              requestBody.temperature = cfg.temperature;
            }
            if (cfg.top_p !== undefined) requestBody.top_p = cfg.top_p;
            const activeProfile = cfg.profiles?.[cfg.active_profile];
            requestBody.options = {
              temperature: requestBody.temperature ?? 0.7,
              top_p: cfg.top_p ?? 0.95,
              num_ctx: activeProfile?.context_window ?? cfg.ollama.options?.num_ctx ?? 8192,
              num_gpu: activeProfile?.gpu_layers ?? cfg.ollama.options?.num_gpu ?? 31,
              num_thread: activeProfile?.num_threads ?? cfg.ollama.options?.num_thread ?? 8,
              num_batch: activeProfile?.batch_size ?? cfg.ollama.options?.num_batch ?? 256,
            };
          } else {
            await applyOpenRouterRequestConfig(requestBody, cfg, modelName, normalizedMessages, {
              requestedMaxTokens: callOptions?.max_tokens,
              requestedTemperature: callOptions?.temperature,
              requestedTopP: cfg.top_p,
              surface,
            });
          }

          if (cfg.tools.enabled && !useTextTools && callOptions?.tools && callOptions.tools.length > 0) {
            requestBody.tools = toApiTools(callOptions.tools);
            if (!isOllama) {
              await applyOpenRouterRequestConfig(requestBody, cfg, modelName, normalizedMessages, {
                requestedMaxTokens: callOptions?.max_tokens,
                requestedTemperature: callOptions?.temperature,
                requestedTopP: cfg.top_p,
                surface,
              });
            }
          }

          const headers: Record<string, string> = {
            "Authorization": isOllama ? "Bearer ollama" : `Bearer ${cfg.openrouter.api_key}`,
            "Content-Type": "application/json",
          };
          if (!isOllama) {
            headers["HTTP-Referer"] = cfg.openrouter.site_url || "http://localhost:19877";
            headers["X-Title"] = cfg.openrouter.site_name || "Jarvis";
          }

          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), MODEL_REQUEST_TIMEOUT_MS);
          const onStreamAbort = () => ctrl.abort();
          streamAbort.signal.addEventListener("abort", onStreamAbort);

          let fetchRes: Response;
          try {
            fetchRes = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(requestBody), signal: ctrl.signal });
          } catch (fetchErr: any) {
            clearTimeout(timeout);
            streamAbort.signal.removeEventListener("abort", onStreamAbort);
            if (fetchErr.name === "AbortError") {
              if (streamAbort.signal.aborted) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "cancelled", session_id: sessionId })}\n\n`));
                return { content: "", tool_calls: undefined };
              }
              throw new Error(`Request timed out after ${MODEL_REQUEST_TIMEOUT_MS / 1000}s. The model may be loading or overloaded.`);
            }
            if (isOllama && (fetchErr.message?.includes("ECONNREFUSED") || fetchErr.message?.includes("fetch failed"))) {
              throw new Error(`Cannot connect to Ollama. Tried: ${ollamaTarget?.tried.join("; ") || baseUrl}. Make sure Ollama is running and the model is pulled (ollama pull ${modelName}).`);
            }
            throw fetchErr;
          }

          if (!fetchRes.ok) {
            const errText = await fetchRes.text();
            clearTimeout(timeout);
            throw new Error(`API ${fetchRes.status}: ${errText.slice(0, 300)}`);
          }
          clearTimeout(timeout);
          streamAbort.signal.removeEventListener("abort", onStreamAbort);

          const reader = fetchRes.body?.getReader();
          if (!reader) throw new Error("No response body from API");

          const reasoningParser = cfg.reasoning.enabled ? new ReasoningParser(sessionId) : null;
          const decoder = new TextDecoder();
          let buffer = "";
          let fullTurnText = "";
          let activeToolCalls: any[] = [];
          const textStreamSanitizer = new TextToolCallStreamSanitizer();
          const emitTextToken = async (text: string) => {
            if (callOptions?.surfaceAsAnswer) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text }, session_id: sessionId })}\n\n`));
            } else {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "agent_activity", stage: callOptions?.stageLabel ?? "agent", text, session_id: sessionId })}\n\n`));
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const payload = trimmed.slice(6);
              if (payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload);
                const choice = parsed.choices?.[0];
                if (!choice) continue;

                if (choice.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const active = ensureActiveToolCall(activeToolCalls, idx);
                    if (tc.id) active.id = tc.id;
                    if (tc.function?.name) active.name += tc.function.name;
                    if (tc.function?.arguments) active.arguments += tc.function.arguments;
                  }
                }

                let chunkText = choice.delta?.content || "";
                if (chunkText) {
                  chunkText = chunkText.replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|<\|im_sep\|>/g, "");
                  if (chunkText) {
                    fullTurnText += chunkText;
                    if (callOptions?.onChunk) {
                      callOptions.onChunk(chunkText);
                    }

                    if (reasoningParser) {
                      for (const re of reasoningParser.processChunk(chunkText)) {
                        const visibleText = visibleTextFromReasoningEvent(re);
                        if (!visibleText) continue;
                        if (re.type === "reasoning_step") {
                          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
                        } else if (re.type === "reasoning_chunk") {
                          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
                        } else {
                          const sanitized = textStreamSanitizer.push(visibleText);
                          if (sanitized) {
                            await emitTextToken(sanitized);
                          }
                        }
                      }
                    } else {
                      const sanitized = textStreamSanitizer.push(chunkText);
                      if (sanitized) {
                        await emitTextToken(sanitized);
                      }
                    }
                  }
                }
              } catch {
                // Ignore incomplete chunks JSON parse errors
              }
            }
          }

          if (reasoningParser) {
            for (const re of reasoningParser.flush()) {
              const visibleText = visibleTextFromReasoningEvent(re);
              if (!visibleText) continue;
              if (re.type === "reasoning_step") {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
              } else if (re.type === "reasoning_chunk") {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
              } else {
                const sanitized = textStreamSanitizer.push(visibleText);
                if (sanitized) {
                  await emitTextToken(sanitized);
                }
              }
            }
            const trace = reasoningParser.finalize();
            await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_complete", trace, session_id: sessionId })}\n\n`));
          }

          const remaining = textStreamSanitizer.flush();
          if (remaining) {
            await emitTextToken(remaining);
          }

          let parsedToolCalls = activeToolCalls.filter(Boolean).map((tc) => {
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.arguments);
            } catch {
              parsedArgs = {};
            }
            return {
              id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
              name: tc.name,
              arguments: parsedArgs
            };
          });

          if (useTextTools) {
            const extracted = extractTextToolCalls(fullTurnText, callOptions.tools);
            if (extracted.calls.length > 0) {
              parsedToolCalls = extracted.calls.map((c) => ({
                id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                name: c.name,
                arguments: c.arguments,
              }));
            }
          }

          const cleanContent = cfg.reasoning.enabled ? stripReasoningFromText(fullTurnText) : fullTurnText;
          return {
            content: cleanContent,
            tool_calls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
          };
        };

        // Route the user request using the predictive router
        const router = new PredictiveRouter(callModel);
        const route = await router.route(contextMessage);
        console.log(`[Jarvis Orchestrator] Router decided task_type=${route.task_type}, pipeline=${route.pipeline.join(" -> ")}`);

        // Initialize tuned configurations and start run in collector
        const agentRunId = `run_${crypto.randomUUID()}`;
        selfTuningProposer.initializeTunedConfigs();
        outcomeCollector.startAgentRun(agentRunId, sessionId, contextMessage, route.task_type, route.pipeline);
        const runStartTime = Date.now();

        // Execute the pipeline
        const executor = new PipelineExecutor(callModel, runtime, ctx);
        const result = await executor.execute(contextMessage, route.pipeline, agentRunId, async (state) => {
          // Stream stage progress back to client
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "orchestrator_stage",
            stage: state.stage,
            status: state.status,
            session_id: sessionId
          })}\n\n`));
        });

        // Record metrics and propose tuning options
        const duration = Date.now() - runStartTime;
        let totalTokens = 0;
        let totalToolCalls = 0;
        try {
          const stages = outcomeCollector["store"].getStageRuns(agentRunId);
          for (const s of stages) {
            totalTokens += (s.input_tokens || 0) + (s.output_tokens || 0);
            if (s.tool_calls_json) {
              const parsed = JSON.parse(s.tool_calls_json);
              totalToolCalls += parsed.length;
            }
          }
        } catch {}

        outcomeCollector.completeAgentRun(agentRunId, result, duration, totalToolCalls, totalTokens);
        await selfTuningProposer.proposeAndApply(agentRunId, route.task_type);

        // Write final done messages
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "agent_run_id", agent_run_id: agentRunId, session_id: sessionId })}\n\n`));
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "message_stop", session_id: sessionId })}\n\n`));
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: result, session_id: sessionId })}\n\n`));
        return;
      }

      // ── Ollama / OpenRouter path ─────────────────────────────────
      const originalHistory = [...turnHistory];
      let activeHistory = [...turnHistory];
      let currentPrompt = message;
      const mainModelName = isOllama ? ollamaTarget!.modelName : resolvedOpenRouterModel ?? cfg.openrouter.model;
      const openRouterEffective = !isOllama
        ? await resolveEffectiveOpenRouterRequestConfig(cfg, mainModelName, [], { surface })
        : null;
      let turnCount = 0;
      let loopDone = false;
      let fullText = "";
      const modelSupportsNativeTools = isOllama
        ? (ollamaTarget?.supportsNativeTools ?? false)
        : openRouterEffective?.supports_tools ?? isOpenRouterModelSupportsTools(mainModelName);
      let useTextToolProtocol = !modelSupportsNativeTools;
      let forcedWebSearchDone = false;
      let forcedLocalInspectionDone = false;
      let emptyFinalAnswerRetryDone = false;
      let forceFinalAnswerOnly = false;
      let verifiedWebSearchDone = false;
      let toolExecutionCount = 0;
      let sessionCostInfo: OpenRouterCostInfo | null = null;
      let prevToolCallCount = 0;  // Track tools called in previous turn for nudge logic
      const requiresVerifiedWebSearch = cfg.tools.enabled && hasExplicitWebSearchIntent(message);
      const requiresLocalToolUse = cfg.tools.enabled && hasLocalWorkspaceToolIntent(message);

       const cachedTextToolInstructions = cfg.tools.enabled && useTextToolProtocol
        ? buildTextToolInstructions(runtime.listTools())
        : "";

      while (!loopDone && turnCount < MAX_TOOL_EXECUTION_TURNS) {
        turnCount++;
        const baseUrl = isOllama
          ? ollamaTarget!.chatUrl
          : `${cfg.openrouter.base_url}/chat/completions`;
        const modelName = mainModelName;

        const textToolInstructions = !forceFinalAnswerOnly ? cachedTextToolInstructions : "";
        const effectiveSystemPrompt = [systemPrompt, textToolInstructions].filter(Boolean).join("\n\n");
        const messages: Array<any> = [];
        const compactProfile = cfg.profiles?.[cfg.active_profile];
        // ── Auto-compaction: summarize when context is filling up ──
        try {
          const compactCtx = compactProfile?.context_window ?? cfg.ollama?.options?.num_ctx ?? 16384;
          // First, check if we can apply cached compaction on originalHistory
          const cached = compactionCache.get(sessionId);
          if (cached && originalHistory.length >= cached.originalLength) {
            const prefix = originalHistory.slice(0, cached.originalLength);
            if (getMessagesHash(prefix) === cached.prefixHash) {
              activeHistory = [
                cached.summary,
                ...originalHistory.slice(cached.originalLength),
              ];
              console.log(`[Jarvis] Applied cached compaction for session ${sessionId}, history reduced to ${activeHistory.length} messages`);
            }
          }

          const totalChars = activeHistory.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
          const estimatedTokens = Math.ceil(totalChars / 4);
          if (estimatedTokens > compactCtx * 0.8) {
            console.warn(`[Jarvis] Context at ~${estimatedTokens}/${compactCtx} tokens, compacting history (${activeHistory.length} messages)`);
            const keepRecent = 20;

            let uncompactedCountToCompact = activeHistory.length - keepRecent;
            if (cached && originalHistory.length >= cached.originalLength && getMessagesHash(originalHistory.slice(0, cached.originalLength)) === cached.prefixHash) {
              uncompactedCountToCompact = cached.originalLength + (activeHistory.length - keepRecent - 1);
            }

            const prefixToCompact = originalHistory.slice(0, uncompactedCountToCompact);
            const prefixHash = getMessagesHash(prefixToCompact);

            activeHistory = await compactHistory(
              activeHistory, cfg, isOllama, ollamaTarget, resolvedOpenRouterModel,
              keepRecent
            );

            // Store the new compaction result in the cache
            if (activeHistory[0]?.role === "system" && activeHistory[0]?.content?.startsWith("[Previous conversation summary]")) {
              compactionCache.set(sessionId, {
                originalLength: uncompactedCountToCompact,
                prefixHash,
                summary: activeHistory[0],
              });
            }

            console.log(`[Jarvis] Compacted to ${activeHistory.length} messages`);
          }
        } catch (compactionErr: any) {
          console.warn(`[Jarvis] Compaction failed, continuing without: ${compactionErr.message}`);
        }

        const num_ctx = isOllama
          ? (compactProfile?.context_window ?? cfg.ollama?.options?.num_ctx ?? 16384)
          : (openRouterEffective?.context_length ?? 16384);
        const previousLength = activeHistory.length;
        activeHistory = optimizeContextWindow(activeHistory, effectiveSystemPrompt, message, num_ctx);
        if (activeHistory.length < previousLength) {
          console.warn(`[Jarvis] Optimizing context: truncated history from ${previousLength} to ${activeHistory.length} messages (context window: ${num_ctx})`);
        }
        // ~250 tokens per message, capped at 100
        // Merge system prompt + memory context into a single system message
        const firstSystemIdx = activeHistory.findIndex((m: any) => m.role === "system");
        if (firstSystemIdx >= 0 && effectiveSystemPrompt) {
          const existing = activeHistory[firstSystemIdx];
          const merged = {
            role: "system" as const,
            content: `${effectiveSystemPrompt}\n\n---\n\n${existing.content}`,
          };
          const historyWithoutSystem = [...activeHistory];
          historyWithoutSystem.splice(firstSystemIdx, 1);
          messages.push(merged);
          messages.push(...historyWithoutSystem);
        } else if (effectiveSystemPrompt) {
          messages.push({ role: "system", content: effectiveSystemPrompt });
          messages.push(...activeHistory);
        } else {
          messages.push(...activeHistory);
        }
        if (currentPrompt) {
          messages.push({ role: "user", content: currentPrompt });
        }

        // ── Silent tool nudge: if previous turn called tools but stopped
        // without completing the task, inject a reminder to continue.
        if (!forceFinalAnswerOnly && turnCount > 1 && prevToolCallCount > 0 && !loopDone) {
          // Check if the most recent assistant message had tool calls
          const lastAssistant = [...activeHistory].reverse().find((m: any) => m.role === "assistant");
          const lastHadTools = lastAssistant && (lastAssistant as any).tool_calls && (lastAssistant as any).tool_calls.length > 0;
          // Check if that assistant message also had text (incomplete response)
          const lastHadText = lastAssistant && (lastAssistant as any).content && (lastAssistant as any).content.trim().length > 0;
          if (lastHadTools && lastHadText) {
            messages.push({
              role: "system",
              content: "[Reminder: You started calling tools but the task is not complete. Continue with the next required tool call. Do not summarize — just execute the remaining tools.]",
            });
            console.log(`[Jarvis] Injected tool continuation nudge session=${sessionId} turn=${turnCount}`);
          }
        }

        const normalizedMessages = normalizeMessagesForLLM(messages);
        const requestBody: Record<string, any> = { model: modelName, messages: normalizedMessages, stream: true };
        if (isOllama) {
          await applyOutputMaxTokens(requestBody, cfg, isOllama, modelName, normalizedMessages);
          requestBody.temperature = effectiveTemp;
          if (cfg.top_p !== undefined) requestBody.top_p = cfg.top_p;
          const activeProfile = cfg.profiles?.[cfg.active_profile];
          requestBody.options = {
            temperature: effectiveTemp,
            top_p: cfg.top_p ?? 0.95,
            num_ctx: activeProfile?.context_window ?? cfg.ollama.options?.num_ctx ?? 8192,
          };
        } else {
          await applyOpenRouterRequestConfig(requestBody, cfg, modelName, normalizedMessages, {
            requestedTemperature: effectiveTemp,
            requestedTopP: cfg.top_p,
            surface,
          });
        }

        // Pass API-safe native schemas until a backend proves it needs text fallback.
        if (cfg.tools.enabled && !useTextToolProtocol && !forceFinalAnswerOnly) {
          requestBody.tools = toApiTools(runtime.listTools());
          if (!isOllama) {
            await applyOpenRouterRequestConfig(requestBody, cfg, modelName, normalizedMessages, {
              requestedTemperature: effectiveTemp,
              requestedTopP: cfg.top_p,
              surface,
            });
          }
        }

        const headers: Record<string, string> = {
          "Authorization": isOllama ? "Bearer ollama" : `Bearer ${cfg.openrouter.api_key}`,
          "Content-Type": "application/json",
        };
        if (!isOllama) {
          headers["HTTP-Referer"] = cfg.openrouter.site_url || "http://localhost:19877";
          headers["X-Title"] = cfg.openrouter.site_name || "Jarvis";
        }

        const useFallback = !isOllama && cfg.openrouter.enable_fallbacks;
        const requestTimeout = isOllama ? MODEL_REQUEST_TIMEOUT_MS : (cfg.openrouter.timeout_ms || MODEL_REQUEST_TIMEOUT_MS);
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), requestTimeout);
        const onStreamAbortMain = () => ctrl.abort();
        streamAbort.signal.addEventListener("abort", onStreamAbortMain);

        let fetchRes: Response;
        let actualModelUsed = modelName;

        try {
          if (useFallback) {
            const result = await chatCompletionWithFallback(cfg, requestBody, ctrl.signal);
            fetchRes = result.response;
            actualModelUsed = result.model_used;
            if (result.retries > 0) {
              console.log(`[OpenRouter] Used model ${result.model_used} after ${result.retries} retry attempt(s)`);
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "fallback_notice", model: result.model_used, retries: result.retries, session_id: sessionId })}\n\n`));
            }
          } else {
            fetchRes = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(requestBody), signal: ctrl.signal });
          }
        } catch (fetchErr: any) {
          clearTimeout(timeout);
          streamAbort.signal.removeEventListener("abort", onStreamAbortMain);
          if (fetchErr.name === "AbortError") {
            if (streamAbort.signal.aborted) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "cancelled", session_id: sessionId })}\n\n`));
              return;
            }
            throw new Error(`Request timed out after ${requestTimeout / 1000}s. The model may be loading or overloaded.`);
          }
          if (isOllama && (fetchErr.message?.includes("ECONNREFUSED") || fetchErr.message?.includes("fetch failed"))) {
            throw new Error(`Cannot connect to Ollama. Tried: ${ollamaTarget?.tried.join("; ") || baseUrl}. Make sure Ollama is running and the model is pulled (ollama pull ${modelName}).`);
          }
          throw fetchErr;
        }

        if (!fetchRes.ok) {
          const errText = await fetchRes.text();
          clearTimeout(timeout);
          
          if (isNativeToolProtocolUnsupportedError(fetchRes.status, errText) && requestBody.tools) {
            console.warn(`[Jarvis] Model ${actualModelUsed} does not support native tools. Retrying without tools...`);
            delete requestBody.tools;
            useTextToolProtocol = true;
            const instructions = buildTextToolInstructions(runtime.listTools());
            const systemMessage = requestBody.messages.find((item: any) => item.role === "system");
            if (systemMessage) {
              systemMessage.content = [systemMessage.content, instructions].filter(Boolean).join("\n\n");
            } else {
              requestBody.messages.unshift({ role: "system", content: instructions });
            }
            const retryCtrl = new AbortController();
            const retryTimeout = setTimeout(() => retryCtrl.abort(), requestTimeout);
            try {
              fetchRes = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(requestBody), signal: retryCtrl.signal });
              if (!fetchRes.ok) {
                const retryErrText = await fetchRes.text();
                clearTimeout(retryTimeout);
                throw new Error(`API ${fetchRes.status}: ${retryErrText.slice(0, 300)}`);
              }
              clearTimeout(retryTimeout);
            } catch (retryErr: any) {
              clearTimeout(retryTimeout);
              throw retryErr;
            }
          } else {
            if (fetchRes.status === 404 && isOllama) throw new Error(`Model "${modelName}" not found in Ollama. Run: ollama pull ${modelName}`);
            if (fetchRes.status === 401) throw new Error(`Authentication failed. ${isOllama ? "Ollama accepts any key." : "Check your OpenRouter API key."}`);
            if (fetchRes.status === 429) throw new Error(`Rate limited by ${isOllama ? "Ollama" : "OpenRouter"}. ${useFallback ? "All fallback models also exhausted." : "Enable fallback models in settings."}`);
            if (fetchRes.status === 503) throw new Error(`${isOllama ? "Ollama" : "OpenRouter"} is overloaded. ${useFallback ? "All fallback models also unavailable." : "Try again shortly."}`);
            throw new Error(`API ${fetchRes.status}: ${errText.slice(0, 300)}`);
          }
        }

        const reader = fetchRes.body?.getReader();
        if (!reader) throw new Error("No response body from API");
        streamAbort.signal.removeEventListener("abort", onStreamAbortMain);

        const reasoningParser = cfg.reasoning.enabled ? new ReasoningParser(sessionId) : null;
        const decoder = new TextDecoder();
        let buffer = "";
        let turnText = "";
        let lastActivity = Date.now();
        let activeToolCalls: any[] = [];
        const textStreamSanitizer = new TextToolCallStreamSanitizer();
        const holdVisibleText = !forceFinalAnswerOnly
          && ((requiresVerifiedWebSearch && !verifiedWebSearchDone)
            || (requiresLocalToolUse && toolExecutionCount === 0));
        const emitVisibleText = async (text: string) => {
          if (!text) return;
          if (reasoningParser) {
            for (const re of reasoningParser.processChunk(text)) {
              const visibleText = visibleTextFromReasoningEvent(re);
              if (!visibleText) continue;
              if (re.type === "reasoning_step") {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
              } else if (re.type === "reasoning_chunk") {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
              } else {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text: visibleText }, session_id: sessionId })}\n\n`));
              }
            }
          } else {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text }, session_id: sessionId })}\n\n`));
          }
        };
        const completeReasoning = async () => {
          if (!reasoningParser) return;
          for (const re of reasoningParser.flush()) {
            const visibleText = visibleTextFromReasoningEvent(re);
            if (!visibleText) continue;
            if (re.type === "reasoning_step") {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
            } else if (re.type === "reasoning_chunk") {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
            } else {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text: visibleText }, session_id: sessionId })}\n\n`));
            }
          }
          const trace = reasoningParser.finalize();
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_complete", trace, session_id: sessionId })}\n\n`));
        };

        try {
          while (true) {
            const chunkTimeout = setTimeout(() => {
              if (Date.now() - lastActivity > MODEL_STREAM_STALL_TIMEOUT_MS) reader.cancel("Stream stalled");
            }, MODEL_STREAM_STALL_CHECK_MS);
            let readResult: ReadableStreamReadResult<Uint8Array>;
            try {
              readResult = await reader.read();
            } finally {
              clearTimeout(chunkTimeout);
            }
            const { done, value } = readResult;
            if (done) break;
            lastActivity = Date.now();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const payload = trimmed.slice(6);
              if (payload === "[DONE]") continue;
              try {
                const json = JSON.parse(payload);

                // Parse streaming tool calls
                const toolCalls = json.choices?.[0]?.delta?.tool_calls;
                if (toolCalls && toolCalls.length > 0) {
                  for (const tc of toolCalls) {
                    const idx = tc.index ?? 0;
                    if (!activeToolCalls[idx]) {
                      activeToolCalls[idx] = { id: tc.id || "", name: "", arguments: "" };
                    }
                    const active = activeToolCalls[idx];
                    if (tc.id) active.id = tc.id;
                    if (tc.function?.name) active.name += tc.function.name;
                    if (tc.function?.arguments) active.arguments += tc.function.arguments;
                  }
                }

                let content: string | undefined = json.choices?.[0]?.delta?.content;
                if (content) {
                  // Strip ChatML leakage tokens
                  content = content.replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|<\|im_sep\|>/g, "");
                  if (content) {
                    turnText += content;
                    fullText += content;
                    const visibleText = textStreamSanitizer.push(content);
                    if (!holdVisibleText) await emitVisibleText(visibleText);
                  }
                }

                if (json.usage && !isOllama) {
                  sessionCostInfo = {
                    prompt_tokens: json.usage.prompt_tokens || 0,
                    completion_tokens: json.usage.completion_tokens || 0,
                    total_tokens: json.usage.total_tokens || 0,
                    total_cost_usd: json.or_cost ?? 0,
                    generation_id: json.or_id ?? json.id ?? "",
                    model: json.model ?? actualModelUsed,
                  };
                }
              } catch { /* skip bad JSON */ }
            }
          }
        } finally {
          clearTimeout(timeout);
        }

        // Filter activeToolCalls to only contain valid tool calls
        const validCalls = activeToolCalls.filter(call => call && call.name);
        const textExtraction = validCalls.length === 0 && cfg.tools.enabled
          ? extractTextToolCalls(turnText, runtime.listTools())
          : { cleanedText: turnText, calls: [] };
        const runnableTextCalls = forceFinalAnswerOnly ? [] : textExtraction.calls;
        const fullTextBeforeTurn = fullText.slice(0, Math.max(0, fullText.length - turnText.length));
        fullText = `${fullTextBeforeTurn}${textExtraction.cleanedText}`;
        const shouldForceWebSearch = validCalls.length === 0
          && runnableTextCalls.length === 0
          && !forceFinalAnswerOnly
          && requiresVerifiedWebSearch
          && !verifiedWebSearchDone
          && !forcedWebSearchDone;
        const shouldForceLocalInspection = validCalls.length === 0
          && runnableTextCalls.length === 0
          && !forceFinalAnswerOnly
          && requiresLocalToolUse
          && toolExecutionCount === 0
          && !forcedLocalInspectionDone;
        const safeTail = textStreamSanitizer.flush();

        if (!holdVisibleText) {
          await emitVisibleText(safeTail);
        } else if (validCalls.length === 0 && runnableTextCalls.length === 0 && !shouldForceWebSearch && !shouldForceLocalInspection) {
          await emitVisibleText(textExtraction.cleanedText);
        }
        await completeReasoning();

        if (shouldForceWebSearch) {
          fullText = fullTextBeforeTurn;
          if (currentPrompt) {
            activeHistory.push({ role: "user", content: currentPrompt });
            currentPrompt = "";
          }

          const call = {
            id: `forced_web_${crypto.randomUUID().slice(0, 8)}`,
            name: "web_search",
            arguments: { query: webSearchQueryFromPrompt(message) },
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
            session_id: sessionId
          })}\n\n`));

          console.warn(`[Jarvis] Enforcing explicit web search for session=${sessionId} model=${modelName}`);
          const toolResult = await runtime.execute(call, ctx);
          const toolOutput = toolResult.is_error ? (toolResult.error || toolResult.output) : toolResult.output;
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "tool_result",
            call_id: call.id,
            name: call.name,
            output: toolOutput,
            is_error: toolResult.is_error,
            session_id: sessionId
          })}\n\n`));

          forcedWebSearchDone = true;
          verifiedWebSearchDone = true;
          toolExecutionCount++;
          currentPrompt = textToolResultsPrompt([toolResult]);
          useTextToolProtocol = true;
          continue;
        }

        if (shouldForceLocalInspection) {
          fullText = fullTextBeforeTurn;
          if (currentPrompt) {
            activeHistory.push({ role: "user", content: currentPrompt });
            currentPrompt = "";
          }

          const call = {
            id: `forced_local_${crypto.randomUUID().slice(0, 8)}`,
            name: "list_directory",
            arguments: { path: "." },
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
            session_id: sessionId
          })}\n\n`));

          console.warn(`[Jarvis] Enforcing local workspace inspection for session=${sessionId} model=${modelName}`);
          const toolResult = await runtime.execute(call, ctx);
          const toolOutput = toolResult.is_error ? (toolResult.error || toolResult.output) : toolResult.output;
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "tool_result",
            call_id: call.id,
            name: call.name,
            output: toolOutput,
            is_error: toolResult.is_error,
            session_id: sessionId
          })}\n\n`));

          forcedLocalInspectionDone = true;
          toolExecutionCount++;
          currentPrompt = `${textToolResultsPrompt([toolResult])}\n\nContinue the user's task using the tool result above. If more inspection is needed, emit another <tool_call>{...}</tool_call> block. Otherwise provide the final answer.`;
          useTextToolProtocol = true;
          continue;
        }

        if (runnableTextCalls.length > 0) {
          if (currentPrompt) {
            activeHistory.push({ role: "user", content: currentPrompt });
          }
          if (turnText) {
            activeHistory.push({ role: "assistant", content: turnText });
          }

          const toolResults = [];
          for (const call of runnableTextCalls) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.arguments,
              session_id: sessionId
            })}\n\n`));

            console.log(`[Jarvis] Executing text-fallback tool ${call.name} with args:`, call.arguments);
            const toolResult = await runtime.execute(
              { id: call.id, name: call.name, arguments: call.arguments },
              ctx,
            );
            const toolOutput = toolResult.is_error ? (toolResult.error || toolResult.output) : toolResult.output;
            toolResults.push(toolResult);
            toolExecutionCount++;
            if (call.name === "web_search") verifiedWebSearchDone = true;

            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "tool_result",
              call_id: call.id,
              name: call.name,
              output: toolOutput,
              is_error: toolResult.is_error,
              session_id: sessionId
            })}\n\n`));

            // If the user was asked a question, stop the loop and wait for their response.
            if (call.name === "ask_user_question") {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "message_stop", session_id: sessionId })}\n\n`));
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: toolOutput, session_id: sessionId })}\n\n`));
              loopDone = true;
              break;
            }
          }

          if (loopDone) break;
          currentPrompt = textToolResultsPrompt(toolResults);
          useTextToolProtocol = true;
          continue;
        }

        if (validCalls.length === 0) {
          // No tools called — this turn is complete!
          const finalTurnResultText = cfg.reasoning.enabled
            ? stripReasoningFromText(textExtraction.cleanedText)
            : textExtraction.cleanedText;
          let resultText = toolExecutionCount > 0
            ? finalTurnResultText
            : (cfg.reasoning.enabled ? stripReasoningFromText(fullText) : fullText);
          if (toolExecutionCount > 0 && finalTurnResultText.trim().length === 0) {
            if (!emptyFinalAnswerRetryDone) {
              fullText = fullTextBeforeTurn;
              currentPrompt = [
                currentPrompt,
                "Tool use is complete. Do not call tools or emit <tool_call> blocks. Write the final visible answer now using the tool results already provided. If the requested app or file is not present, say that plainly. Do not emit hidden reasoning tags.",
              ].filter(Boolean).join("\n\n");
              emptyFinalAnswerRetryDone = true;
              forceFinalAnswerOnly = true;
              useTextToolProtocol = false;
              prevToolCallCount = 0;
              console.warn(`[Jarvis] Forcing final-answer-only retry session=${sessionId} after ${toolExecutionCount} tool result(s)`);
              continue;
            }
            resultText = "I completed tool inspection, but the model returned no visible final answer after a final-answer-only retry. The streamed tool results above are preserved for review.";
          }
          if (sessionCostInfo) {
            logOpenRouterCost(sessionCostInfo);
            await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "cost_info", ...sessionCostInfo, session_id: sessionId })}\n\n`));
          }
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "message_stop", session_id: sessionId })}\n\n`));
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText, session_id: sessionId })}\n\n`));
          loopDone = true;
        } else {
          // Model called tools!
          // 1. Add user prompt to history if it was passed as a separate string
          if (currentPrompt) {
            activeHistory.push({ role: "user", content: currentPrompt });
            currentPrompt = ""; // Clear so we don't repeat it
          }

          // 2. Add assistant message containing the tool calls to history
          const formattedToolCalls = validCalls.map(c => ({
            id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments }
          }));

          activeHistory.push({
            role: "assistant",
            content: turnText || null,
            tool_calls: formattedToolCalls
          });

          // 3. Execute each tool call and stream events + append results to history
          for (const tc of formattedToolCalls) {
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || "{}");
            } catch {
              console.warn(`[Jarvis] Failed to parse tool arguments: ${tc.function.arguments}`);
            }

            // Stream tool call event to client
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: parsedArgs,
              session_id: sessionId
            })}\n\n`));

            // Execute the tool in Bun server through the canonical ToolRuntime
            console.log(`[Jarvis] Executing tool ${tc.function.name} with args:`, parsedArgs);
            const toolResult = await runtime.execute(
              { id: tc.id, name: tc.function.name, arguments: parsedArgs },
              ctx,
            );
            const toolOutput = toolResult.is_error ? (toolResult.error || toolResult.output) : toolResult.output;
            toolExecutionCount++;
            if (tc.function.name === "web_search") verifiedWebSearchDone = true;

            // Stream tool result event to client
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "tool_result",
              call_id: tc.id,
              name: tc.function.name,
              output: toolOutput,
              is_error: toolResult.is_error,
              session_id: sessionId
            })}\n\n`));

            // Add tool response to history (truncated to protect context)
            activeHistory.push({
              role: "tool",
              tool_call_id: tc.id,
              content: truncateToolResult(toolOutput)
            });

            // If the user was asked a question, stop the loop and wait for their response.
            if (tc.function.name === "ask_user_question") {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "message_stop", session_id: sessionId })}\n\n`));
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Waiting for user response to question.", session_id: sessionId })}\n\n`));
              loopDone = true;
              break;
            }
          }

          // Track tool calls this turn for nudge logic
          prevToolCallCount = formattedToolCalls.length;

          // Continue the loop to get assistant's next turn with tool results!
        }
      }

      if (turnCount >= MAX_TOOL_EXECUTION_TURNS && !loopDone) {
        throw new Error(`Maximum tool execution turns (${MAX_TOOL_EXECUTION_TURNS}) exceeded to prevent infinite looping.`);
      }

      console.log(`[Jarvis] Stream complete session=${sessionId} turns=${turnCount} verified_web_search=${verifiedWebSearchDone}`);
      const _cfg2 = resolveConfig(options.config);
      recordInference({
        ts: Date.now(),
        backend: _cfg2.active_backend as Backend,
        model: _cfg2.active_backend === "openrouter"
          ? (_cfg2.openrouter.model ?? "openrouter/free")
          : _cfg2.active_backend === "claude_cli"
          ? (_cfg2.claude_cli.model ?? "claude_cli")
          : _cfg2.ollama.model,
        ok: true,
        latency_ms: Date.now() - _turnStart,
        tokens_in: 0,
        tokens_out: 0,
      });

    } catch (error: any) {
      const errMsg = error?.message || String(error);
      console.error(`[Jarvis] Stream error session=${sessionId}:`, errMsg);
      const _cfg3 = resolveConfig(options.config);
      recordInference({
        ts: Date.now(),
        backend: _cfg3.active_backend as Backend,
        model: _cfg3.active_backend === "openrouter"
          ? (_cfg3.openrouter.model ?? "openrouter/free")
          : _cfg3.active_backend === "claude_cli"
          ? (_cfg3.claude_cli.model ?? "claude_cli")
          : _cfg3.ollama.model,
        ok: false,
        latency_ms: Date.now() - _turnStart,
        tokens_in: 0,
        tokens_out: 0,
        error: errMsg.slice(0, 200),
      });
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "error", error: errMsg, session_id: sessionId })}\n\n`));
      } catch {}
    } finally {
      activeStreamControllers.delete(sessionId);
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

// ═══════════════════════════════════════════════════════════════
// ── TCP Bridge (port 19876) ──
// ═══════════════════════════════════════════════════════════════
let bridgeProcess: ReturnType<typeof spawn> | null = null;

async function isBridgeListening(): Promise<boolean> {
  try {
    const { connect } = await import("net");
    return await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: BRIDGE_PORT, timeout: 1000 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
}

async function waitForBridgeState(expected: boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isBridgeListening()) === expected) return true;
    await Bun.sleep(150);
  }
  return (await isBridgeListening()) === expected;
}

function bindBridgeLifecycle(child: ReturnType<typeof spawn>): void {
  child.once("exit", (code, signal) => {
    if (bridgeProcess === child) bridgeProcess = null;
    console.warn(`[Bridge] Process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (signal ${signal})` : ""}`);
  });
  child.once("error", (error) => {
    if (bridgeProcess === child) bridgeProcess = null;
    console.error("[Bridge] Process error:", error);
  });
}

async function startBridge(): Promise<boolean> {
  if (bridgeProcess) {
    const running = await isBridgeListening();
    if (running && bridgeProcess.exitCode == null && !bridgeProcess.killed) {
      return true;
    }
    try { bridgeProcess.kill(); } catch {}
    bridgeProcess = null;
    await waitForBridgeState(false, 1500);
  }
  try {
    const bunPath = process.execPath || "bun";
    const child = spawn(bunPath, ["run", join(__dirname, "bridge.ts")], { detached: true, stdio: "ignore" });
    bindBridgeLifecycle(child);
    bridgeProcess = child;
    child.unref();
    return await waitForBridgeState(true, 5000);
  } catch (e) { console.error("[Bridge] Failed:", e); return false; }
}

async function stopBridge(): Promise<boolean> {
  const child = bridgeProcess;
  if (!child) {
    return !(await isBridgeListening());
  }

  try {
    child.kill();
  } catch (e) {
    console.error("[Bridge] Failed to stop:", e);
  }

  const stopped = await waitForBridgeState(false, 5000);
  if (bridgeProcess === child) bridgeProcess = null;
  return stopped;
}



async function checkStatus(configOverride?: Partial<JarvisConfig> | null) {
  const cfg = resolveConfig(configOverride);

  const ollamaHealth = await checkOllamaHealth(cfg.ollama);

  let openrouterOk = false;
  let openrouterLatencyMs = 0;
  const hasApiKey = cfg.openrouter.api_key && cfg.openrouter.api_key.length > 5 && cfg.openrouter.api_key !== "ollama";
  if (hasApiKey) {
    try {
      const health = await checkOpenRouterHealth(cfg);
      openrouterOk = health.ok;
      openrouterLatencyMs = health.latencyMs;
    } catch (e: any) {
      console.warn("[Jarvis] OpenRouter health check failed:", e.message);
    }
  }

  let claudeCliAvailable = false;
  try {
    claudeCliAvailable = await isClaudeCliAvailable(cfg.claude_cli.path || "claude");
  } catch { /* false */ }

  const bridgeActive = await isBridgeListening();

  let bunAvailable = false;
  try {
    bunAvailable = existsSync(process.execPath) || process.execPath.includes("bun");
    if (!bunAvailable) {
      const paths = ["/root/.bun/bin/bun", `${process.env.HOME}/.bun/bin/bun`, "/usr/local/bin/bun"];
      bunAvailable = paths.some((p) => existsSync(p));
    }
  } catch {
    bunAvailable = true;
  }

  const configWarnings: string[] = [];
  if (cfg.active_backend === "ollama" && !ollamaHealth.running) {
    configWarnings.push("Ollama is not running. Start Ollama on Windows (ollama serve).");
  } else if (cfg.active_backend === "ollama" && !ollamaHealth.modelAvailable) {
    configWarnings.push(`Model "${cfg.ollama.model}" not found in Ollama. Run: ollama pull ${cfg.ollama.model}`);
  }
  if (cfg.active_backend === "openrouter" && !hasApiKey) {
    configWarnings.push("OpenRouter API key not configured. Add your key in the Config tab.");
  } else if (cfg.active_backend === "openrouter" && !openrouterOk) {
    configWarnings.push("Cannot reach OpenRouter API. Check your API key.");
  }
  if (cfg.active_backend === "claude_cli" && !claudeCliAvailable) {
    configWarnings.push(`Claude CLI not found at '${cfg.claude_cli.path || "claude"}'. Make sure 'claude' is on PATH.`);
  }

  return {
    ollama_running: ollamaHealth.running,
    ollama_model_available: ollamaHealth.modelAvailable,
    ollama_latency_ms: ollamaHealth.latencyMs,
    ollama_models: ollamaHealth.models,
    openrouter_ok: openrouterOk,
    openrouter_latency_ms: openrouterLatencyMs,
    claude_cli_available: claudeCliAvailable,
    bridge_active: bridgeActive,
    bridge_port: BRIDGE_PORT,
    bun_available: bunAvailable,
    jarvis_version: JARVIS_VERSION,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    total_requests: totalRequests,
    active_sessions: activeStreamControllers.size,
    active_backend: cfg.active_backend,
    backend: cfg.active_backend,
    model: cfg.active_backend === "openrouter" ? cfg.openrouter.model : cfg.ollama.model,
    config_valid: configWarnings.length === 0,
    config_errors: [] as string[],
    config_warnings: configWarnings,
  };
}

async function searchDuckDuckGo(query: string): Promise<Record<string, any>> {
  try {
    return await searchWeb(query);
  } catch (e: any) {
    return { error: e.message || String(e), query };
  }
}

async function baseFetch(req: Request): Promise<Response> {
  const requestStart = performance.now();
  const path = new URL(req.url).pathname;
  const isNoisy = path === "/status" || path === "/health";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    if (path === "/" && req.method === "GET") {
      return Response.json({ ok: true, name: "Jarvis", version: JARVIS_VERSION });
    }
    if (path === "/health") {
      const hcfg = loadConfig();
      return Response.json({ ok: true, uptime: process.uptime(), version: JARVIS_VERSION, backend: hcfg.active_backend, model: hcfg.active_backend === "openrouter" ? hcfg.openrouter.model : hcfg.ollama.model });
    }
    if (path === "/health/inference") {
      return Response.json(inferenceMetricsSnapshot());
    }
    if (path === "/tool/decision" && req.method === "POST") {
      const { call_id, approved } = await req.json() as { call_id: string; approved: boolean };
      const resolved = approvalRegistry.resolve(call_id, Boolean(approved));
      return Response.json({ ok: resolved, call_id });
    }
    if (path === "/config" && req.method === "GET") return Response.json(loadConfig());
    if (path === "/config" && req.method === "POST") {
      return Response.json({ ok: true });
    }
    if (path === "/chat/stream" && req.method === "POST") {
      const body = await req.json();
      return streamJarvis(body.message, body.session_id || crypto.randomUUID(), {
        config: body.config,
        history: Array.isArray(body.history) ? body.history : [],
        systemPromptOverride: body.system_prompt_override,
        surface: body.surface,
      });
    }
    if (path === "/chat/cancel" && req.method === "POST") {
      const body = await req.json();
      const sid = body.session_id;
      if (!sid) return Response.json({ ok: false, error: "session_id required" }, { status: 400 });
      const ctrl = activeStreamControllers.get(sid);
      if (ctrl) {
        ctrl.abort();
        activeStreamControllers.delete(sid);
        console.log(`[Jarvis] Stream cancelled for session=${sid}`);
        return Response.json({ ok: true, cancelled: true });
      }
      return Response.json({ ok: true, cancelled: false });
    }
    if (path === "/sessions" && req.method === "GET") return Response.json([]);
    if (path === "/sessions" && req.method === "POST") return Response.json({ id: crypto.randomUUID(), name: (await req.json()).name || "New Session" });
    if (path === "/sessions/delete" && req.method === "POST") return Response.json({ ok: true });
    if (path === "/bridge/start" && req.method === "GET") return Response.json({ ok: await startBridge() });
    if (path === "/bridge/stop" && req.method === "GET") return Response.json({ ok: await stopBridge() });
    if (path === "/status" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return Response.json(await checkStatus(body.config));
    }
    if (path === "/skills" && req.method === "GET") return Response.json(loadSkills());
    if (path === "/tools" && req.method === "GET") return Response.json(loadTools());
    if (path === "/models" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return Response.json(await discoverModels(body.config));
    }
    if (path === "/test" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return Response.json(await testConnection(body.config));
    }
    if (path === "/companion" && req.method === "GET") {
      const cfg = loadConfig();
      const comp = loadCompanionState(cfg);
      if (!comp || !comp.enabled) return Response.json({ enabled: false });
      const now = Date.now();
      const lastInteraction = comp.last_interaction ? new Date(comp.last_interaction).getTime() : now;
      const minutesSinceInteraction = Math.floor((now - lastInteraction) / 60000);
      const happinessDecay = Math.min(minutesSinceInteraction / 30, 20);
      const energyDecay = Math.min(minutesSinceInteraction / 60, 15);
      const currentHappiness = Math.max(0, (comp.happiness || 85) - happinessDecay);
      const currentEnergy = Math.max(0, (comp.energy || 92) - energyDecay);
      let mood = "idle";
      if (currentEnergy < 20) mood = "sleeping";
      else if (currentHappiness > 80) mood = "happy";
      else if (currentHappiness > 50) mood = "content";
      else if (currentHappiness > 25) mood = "sad";
      else mood = "distressed";
      return Response.json({
        ...comp,
        happiness: Math.round(currentHappiness),
        energy: Math.round(currentEnergy),
        mood,
        minutes_since_interaction: minutesSinceInteraction,
      });
    }
    if (path === "/companion" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const cfg = loadConfig();
      const comp = loadCompanionState(cfg);
      if (!comp || !comp.enabled) return Response.json({ error: "Companion not configured or disabled" }, { status: 400 });
      const action = body.action || body.type || "talk";
      switch (action) {
        case "feed":
          comp.energy = Math.min(100, (comp.energy || 92) + 15);
          comp.happiness = Math.min(100, (comp.happiness || 85) + 5);
          comp.mood = "happy";
          break;
        case "sleep":
          comp.energy = Math.min(100, (comp.energy || 92) + 30);
          comp.happiness = Math.min(100, (comp.happiness || 85) + 2);
          comp.mood = "sleeping";
          break;
        case "train":
          comp.energy = Math.max(0, (comp.energy || 92) - 10);
          comp.happiness = Math.min(100, (comp.happiness || 85) + 8);
          comp.mood = "excited";
          break;
        case "evolve":
          if ((comp.level || 1) < 10) {
            comp.level = (comp.level || 1) + 1;
            comp.xp = 0;
            comp.xp_to_next = ((comp.xp_to_next || 100) + 50);
            comp.mood = "excited";
          }
          break;
        case "talk":
        default:
          comp.happiness = Math.min(100, (comp.happiness || 85) + 3);
          comp.energy = Math.max(0, (comp.energy || 92) - 2);
          comp.mood = "excited";
          break;
      }
      comp.interactions_total = (comp.interactions_total || 0) + 1;
      comp.last_interaction = new Date().toISOString();
      saveCompanionState(comp);
      return Response.json({ ok: true, companion: comp });
    }
    if (path === "/skills/invoke" && req.method === "POST") {
      const body = await req.json();
      const sks = loadSkills();
      const skill = sks.find((s) => s.name === body.name);
      if (!skill) return Response.json({ error: "Skill not found" }, { status: 404 });
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const sid = crypto.randomUUID();
      (async () => {
        try {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "init", session_id: sid, skill: skill.name })}\n\n`));
          const text = `Skill "${skill.name}" invoked.\n${skill.description}\n\nArgs: ${JSON.stringify(body.args || {}, null, 2)}`;
          for (const char of text) {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text: char }, session_id: sid })}\n\n`));
            await new Promise((r) => setTimeout(r, 10));
          }
          await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "message_stop", session_id: sid })}\n\n`));
        } catch (e: any) {
          try { await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "error", error: e.message, session_id: sid })}\n\n`)); } catch {}
        } finally {
          try { await writer.close(); } catch {}
        }
      })();
      return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }

    const interactionMatch = path.match(/^\/sessions\/([^/]+)\/interaction$/);
    if (interactionMatch && req.method === "GET") {
      const sid = interactionMatch[1];
      const st = getSessionState(sid);
      return Response.json({ session_id: sid, state: st });
    }
    if (interactionMatch && req.method === "POST") {
      const body = await req.json();
      const sid = interactionMatch[1];
      clearSessionState(sid);
      return Response.json({ ok: true, session_id: sid, state: body.state || null });
    }

    if (path === "/tuning/proposals" && req.method === "GET") {
      const store = new SelfTuningStore();
      return Response.json({ pending: store.getPendingProposals(), applied: store.getAppliedProposals() });
    }
    if (path === "/tuning/proposals/apply" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.id) return Response.json({ error: "Missing proposal id" }, { status: 400 });
      const store = new SelfTuningStore();
      store.applyTuningProposal(body.id);
      return Response.json({ ok: true });
    }

    return Response.json({ error: `Not found: ${req.method} ${path}` }, { status: 404 });
  } catch (err: any) {
    const elapsed = (performance.now() - requestStart).toFixed(2);
    if (!isNoisy) console.error(`[Jarvis API] ${req.method} ${path} -> Error: ${err.message || err} (${elapsed}ms)`);
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════
// ── HTTP Server ──
// ═══════════════════════════════════════════════════════════════
serve({
  port: PORT,
  fetch: baseFetch,
});

console.log(`[Jarvis API] Listening on http://localhost:${PORT}`);
