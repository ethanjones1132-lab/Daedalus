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
import { loadConfig, saveConfig, saveConfigWithValidation, normalizeConfig, InvalidConfigError, CONFIG_DIR, COMPANION_FILE, surfaceTemperature } from "./config";
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
import { effectiveOllamaUrl, checkOllamaHealth, checkOllamaModelSupportsTools, resolveWindowsHostIP, selectInstalledOllamaModel } from "./ollama";
import { streamClaudeCli, isClaudeCliAvailable, compactTurnHistoryForCli } from "./claude-cli";
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
import { resolveProviderTarget, providerChatUrl, providerHeaders } from "./providers";
import { recordInference, inferenceMetricsSnapshot, backendForProvider, type Backend } from "./inference-metrics";
import { createApprovalRegistry } from "./approval-registry";

// One process-level approval registry: the chat surface emits
// `tool_approval_request` SSE events and awaits decisions here.
// The UI resolves them via POST /tool/decision.
const approvalRegistry = createApprovalRegistry();
import type { ToolCall } from "./tool-types";
import {
  buildTextToolInstructions,
  createStageStreamSanitizer,
  extractTextToolCalls,
  hasExplicitWebSearchIntent,
  hasLocalWorkspaceToolIntent,
  isNativeToolProtocolUnsupportedError,
  textToolResultsPrompt,
  webSearchQueryFromPrompt,
} from "./text-tools";
import {
  createToolRuntime,
  makeExecutionContext,
  toApiTools,
} from "./tool-runtime";
import type { ToolRuntime, ExecutionContext } from "./tool-runtime";
import { registerStandardBundles } from "./bundles-registry";
import { searchWeb } from "./web-bundle";
import { getSessionState, clearSessionState } from "./interactive-bundle";
import { StreamSession, VisibleTextPipe } from "./stream-emitter";
import {
  createStreamLivenessTracker,
  createDisconnectAwareWrite,
  ResettableWatchdog,
  StreamIdleTimeoutError,
  startSseHeartbeat,
  TurnDeadlineExceededError,
  VisibleProgressTimeoutError,
} from "./stream-liveness";
import {
  ActiveStreamRegistry,
  createIdempotentReaderCancel,
  registerAbortHandler,
  resolveReadStopReason,
} from "./stream-control";
import { prepareToolResultForContext } from "./tool-result-truncation";
import { Coordinator } from "./orchestration/coordinator";
import { PersistentConductor } from "./orchestration/persistent-conductor";
import { SessionMemory, mergeSharedContextHints } from "./orchestration/session-memory";
import { AgentPool, firstTokenTimeoutFor, formatPoolDiversity } from "./orchestration/agent-pool";
import { excludedModelKeys } from "./model-failure-memory";
import { PipelineExecutor } from "./orchestration/pipeline";
import type { PipelineProgressState, PipelineRecursionEvent } from "./orchestration/pipeline";
import {
  classifyTurnRequirements,
  inheritRequirementForContinuation,
  shouldShortCircuitCoordinator,
  type TurnRequirement,
} from "./orchestration/turn-requirements";
import { isContinuationTurn } from "./orchestration/turn-triage";
import {
  buildShortCircuitRoute,
  normalizeRoute,
  type ExecutionProfile,
} from "./orchestration/route-normalization";
import { runPipelineWithReplanning } from "./orchestration/replan-loop";
import { buildBoundedHistoryBlock } from "./orchestration/context-budget";
import { SessionReplanCounter } from "./orchestration/replan-telemetry";
import { conductorLearning, outcomeCollector, selfTuningProposer, SelfTuningStore } from "./self-tuning/mod";
import { conductorCacheSnapshot } from "./orchestration/conductor-metrics";
import {
  computeCandidatePerformance,
  distillSkillCandidate,
  evaluateSkillPromotion,
  listSkillCandidates,
  loadSkillCandidate,
  promoteSkillCandidate,
  resolveSkillsForTurn,
  runGroundingJudge,
  runSkillPromotionPass,
  updateSkillCandidateEval,
  updateSkillCandidateStatus,
} from "./intelligence/mod";
import { makeCallModel } from "./eval/call-model";
import { normalizeStreamedToolCalls } from "./streaming-tool-calls";
import { countTokens } from "./tokens";
import { WorkspaceAffinityStore } from "./orchestration/workspace-affinity";
import { createRuntimeMonitor } from "./performance/runtime-monitor";
import { loadInferenceFeedback } from "./self-tuning/inference-feedback";
import {
  INFERENCE_FEEDBACK_CRON_JOB_ID,
  refreshInferenceFeedback,
} from "./self-tuning/inference-feedback-refresh";

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
const MODEL_INTER_TOKEN_TIMEOUT_MS = 60_000;
const MODEL_VISIBLE_PROGRESS_TIMEOUT_MS = Math.min(
  600_000,
  Math.max(
    MODEL_INTER_TOKEN_TIMEOUT_MS,
    Number(process.env.JARVIS_VISIBLE_PROGRESS_TIMEOUT_MS ?? 180_000) || 180_000,
  ),
);
const TOTAL_TURN_TIMEOUT_MS = Math.min(
  3_600_000,
  Math.max(60_000, Number(process.env.JARVIS_TOTAL_TURN_TIMEOUT_MS ?? 480_000) || 480_000),
);
// First-token watchdog. See chatCompletionWithFallback for the upstream
// implementation. This constant governs the orchestrator-level defense
// in depth that aborts the read loop if the response body is open but
// no semantic content or tool delta has arrived in the configured window.
// Once the first delta arrives, the separate inter-token watchdog takes over.
const MODEL_FIRST_TOKEN_TIMEOUT_MS = 30_000;
const SSE_HEARTBEAT_ENABLED = process.env.JARVIS_SSE_HEARTBEAT_ENABLED !== "0";
const SSE_HEARTBEAT_INTERVAL_MS = Math.min(
  60_000,
  Math.max(5_000, Number(process.env.JARVIS_SSE_HEARTBEAT_INTERVAL_MS ?? 15_000) || 15_000),
);
const MAX_TOOL_RESULT_CHARS = 2000;  // Truncate tool results going back to model context
const MAX_TOOL_EXECUTION_TURNS = 10;
const activeStreams = new ActiveStreamRegistry();

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

/**
 * Build a ToolRuntime for the chat loop by registering the canonical tool
 * bundles. Every surface (chat, cron, agent, mcp) now executes through this
 * same ToolRuntime contract; the chat surface composes the full bundle set.
 */
function buildChatRuntime(cfg: JarvisConfig, workspacePath = cfg.jarvis_path): {
  runtime: ToolRuntime;
  ctx: ExecutionContext;
} {
  const runtime = createToolRuntime();
  registerStandardBundles(runtime);

  const ctx = makeExecutionContext("chat", cfg, {
    workspace_path: workspacePath,
  });

  return { runtime, ctx };
}

/**
 * Build a sandbox permissions block describing tool constraints to the model.
 * Rendered as a stable system-prompt prefix that never changes between turns,
 * enabling prompt caching for the static portion of the context.
 */
function buildSandboxPermissions(cfg: JarvisConfig, activeWorkspacePath = cfg.jarvis_path): string {
  const mode = cfg.tools?.sandbox_mode ?? "strict";
  const workspacePath = activeWorkspacePath || "configured workspace";
  const lines: string[] = [
    "## Sandbox & Permissions",
    "",
    "You are running within Jarvis's tool runtime. The following constraints apply to every tool call:",
    "",
    `- **Workspace scope**: File access is bounded to \`${workspacePath}\`. Paths outside this scope are rejected.`,
    `- **Shell sandbox**: Shell commands execute under sandbox mode \`${mode}\`.`,
    "  - `strict`: Dangerous tools (write, edit, bash) are blocked on non-interactive surfaces and require approval on interactive surfaces.",
    "  - `permissive`: Warnings are shown but tools are allowed.",
    "  - `off`: No sandbox enforcement (full access).",
    "- **Network access**: Web searches and HTTP requests may be restricted to approved domains.",
    "- **Non-interactive surfaces**: Cron and agent runs default to read-only. Write operations are blocked unless explicitly configured.",
    "- **Prohibited**: Do not attempt to bypass sandbox restrictions, escape the workspace, or execute shell commands that modify system state outside the workspace.",
  ];
  return lines.join("\n");
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

/** Process-wide local conductor — maintains per-session Ollama prefix state. */
const persistentConductor = new PersistentConductor(loadConfig);

/** Inter-workflow shared memory — tool results, file snapshots, failure patterns. */
const sessionMemory = new SessionMemory(() => loadConfig().orchestrator.session_memory);

/** Last effective authority per session, retained for terse continuation turns. */
const MAX_CONTINUATION_REQUIREMENTS = 256;
const continuationRequirements = new Map<string, TurnRequirement>();
const workspaceAffinity = new WorkspaceAffinityStore();
const inferenceFeedbackLoad = loadInferenceFeedback();
console.log(
  `[Jarvis Orchestrator] Inference feedback startup load: applied=${inferenceFeedbackLoad.applied} ` +
  `ignored=${inferenceFeedbackLoad.ignored} status=${inferenceFeedbackLoad.reason ?? "active"}`,
);

function rememberContinuationRequirement(sessionId: string, requirement: TurnRequirement): void {
  continuationRequirements.delete(sessionId);
  continuationRequirements.set(sessionId, requirement);
  while (continuationRequirements.size > MAX_CONTINUATION_REQUIREMENTS) {
    const oldest = continuationRequirements.keys().next().value;
    if (!oldest) break;
    continuationRequirements.delete(oldest);
  }
}

/** B-04: per-session cumulative counter for `conductor_replan` re-invocations.
 *  Backs both the per-session replan cap and the persistent `replan_events`
 *  telemetry table. The store is the same self-tuning DB the rest of the
 *  orchestrator writes to; a fresh instance is created per process because
 *  the store has no meaningful in-process state. */
const replanCounter = new SessionReplanCounter({
  maxPerSession: loadConfig().orchestrator.max_conductor_replans_per_session,
  store: new SelfTuningStore(),
});
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`JARVIS_SERVER_PORT must be an integer between 1 and 65535, got ${process.env.JARVIS_SERVER_PORT}`);
}
const BRIDGE_PORT = 19876;
const JARVIS_VERSION = "3.0.0";

// Build identity for /health — lets us tell which build is actually serving
// a request (2026-07 incident: a stale deployed bundle silently served
// leaked-JSON bugs for days because /health only reported the static
// version string "3.0.0", identical across every build). build-and-deploy.ps1
// injects these via `bun build --define` from `git rev-parse HEAD`; running
// from source (bun run / bunx bun test) never gets --define, so these fall
// back to reading the real env var and finally to the "dev" sentinel.
const JARVIS_GIT_SHA = process.env.JARVIS_GIT_SHA ?? "dev";
const JARVIS_BUILT_AT = process.env.JARVIS_BUILT_AT ?? null;

let totalRequests = 0;
const startTime = Date.now();
const runtimePerformanceMonitor = process.env.JARVIS_PERF_MONITOR === "1"
  ? createRuntimeMonitor()
  : undefined;
runtimePerformanceMonitor?.start();
const runtimePerformanceLogIntervalMs = Math.max(
  1_000,
  Number(process.env.JARVIS_PERF_LOG_INTERVAL_MS ?? 10_000) || 10_000,
);
const runtimePerformanceLogTimer = runtimePerformanceMonitor
  ? setInterval(() => {
      console.log(`[Jarvis Perf] ${JSON.stringify(runtimePerformanceMonitor.snapshot({ reset: true }))}`);
    }, runtimePerformanceLogIntervalMs)
  : undefined;
(runtimePerformanceLogTimer as any)?.unref?.();

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

/** Thrown when the client aborts an in-flight stream — not a user-visible error. */
class StreamCancelledError extends Error {
  constructor() {
    super("stream cancelled");
    this.name = "StreamCancelledError";
  }
}

/**
 * Thrown when a model's first-token watchdog fires (per-model window expired
 * with no `choice.delta.content` chunk arriving). Distinct from
 * `StreamCancelledError`: a slow/hung model is NOT a user cancellation, and
 * must surface to the client as a real `error` frame (with
 * `code: "first_token_timeout"`) — never as a `cancelled` frame.
 *
 * Background: the 2026-07-02 P0-B live incident. The previous build's
 * watchdogs called `streamAbort.abort("First-token timeout")` from inside the
 * timer callback, which is the SAME `streamAbort` that the user Stop button
 * / `/chat/cancel` trigger. The shared abort domain conflated "the user
 * stopped the turn" with "the model is hung" — so a hung model emitted a
 * `cancelled` SSE frame, the UI had no `cancelled` handler, the frame was
 * dropped, the assistant bubble was finalized empty, and the user saw a
 * silent blank bubble with no error message. Per the 2026-07-02 live-issues
 * plan, first-token timeout now lives in its own abort domain (per-read-loop
 * `reader.cancel()` only) and surfaces as an explicit `error` frame so the
 * caller can retry / switch backend without losing the user-visible signal.
 */
class FirstTokenTimeoutError extends Error {
  readonly model: string;
  readonly stage: string;
  readonly windowMs: number;
  constructor(model: string, stage: string, windowMs: number) {
    super(`First-token timeout (${windowMs}ms) on model=${model} stage=${stage}`);
    this.name = "FirstTokenTimeoutError";
    this.model = model;
    this.stage = stage;
    this.windowMs = windowMs;
  }
}

/** Collect aggregate answer from a streamJarvis Response (cron scheduler contract). */
async function drainStreamJarvisResponse(resp: Response): Promise<{ output: string; error?: string }> {
  const reader = resp.body?.getReader();
  if (!reader) return { output: "", error: "No response body" };
  const decoder = new TextDecoder();
  let buffer = "";
  let streamed = "";
  let aggregate = "";
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
        const evt = JSON.parse(payload);
        if (evt.type === "stream_event" && evt.delta?.text) streamed += evt.delta.text;
        if (evt.type === "result" && typeof evt.result === "string") aggregate = evt.result;
        if (evt.type === "error" && evt.error) return { output: streamed, error: String(evt.error) };
        if (evt.type === "cancelled") return { output: streamed, error: "cancelled" };
      } catch {
        // skip malformed frames
      }
    }
  }
  return { output: aggregate || streamed };
}

/** Non-streaming cron dispatch — matches cron_scheduler.rs JSON contract. */
async function runCronInference(body: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
  if (String(body.job_id ?? "") === INFERENCE_FEEDBACK_CRON_JOB_ID) {
    const refreshed = await refreshInferenceFeedback();
    return {
      success: refreshed.success,
      output: refreshed.output || (refreshed.success
        ? `Applied ${refreshed.applied ?? 0} inference feedback adjustment(s).`
        : ""),
      error: refreshed.error,
    };
  }
  const prompt = String(body.prompt ?? "");
  if (!prompt.trim()) return { success: false, output: "", error: "prompt required" };
  const sessionId = String(body.session_id ?? `cron_${crypto.randomUUID()}`);
  try {
    const resp = await streamJarvis(prompt, sessionId, { surface: "cron" });
    const { output, error } = await drainStreamJarvisResponse(resp);
    if (error) return { success: false, output, error };
    return { success: true, output };
  } catch (e: any) {
    return { success: false, output: "", error: e?.message ?? String(e) };
  }
}

async function streamJarvis(message: string, sessionId: string, options: StreamJarvisOptions = {}): Promise<Response> {
  const turnDeadlineAt = Date.now() + TOTAL_TURN_TIMEOUT_MS;
  const ensureTurnBudget = (stage: string): void => {
    if (Date.now() >= turnDeadlineAt) {
      throw new TurnDeadlineExceededError(stage, TOTAL_TURN_TIMEOUT_MS);
    }
  };
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
  const activeWorkspacePath = workspaceAffinity.resolve(
    sessionId,
    message,
    turnHistory,
    cfg.jarvis_path,
  );
  console.log(`[Jarvis] Active workspace session=${sessionId} path=${activeWorkspacePath}`);
  const { readable, writable } = new TransformStream();
  const rawWriter = writable.getWriter();
  const encoder = new TextEncoder();
  totalRequests++;
  let _turnStart = Date.now();

  (async () => {
    // One turn-wide domain is reserved for user Stop, client disconnect, and
    // supersession by a newer turn in the same Session. Model attempt timeouts
    // stay stage-local and must never abort this controller.
    const streamLease = activeStreams.begin(sessionId);
    const streamAbort = streamLease.controller;
    let clientDisconnected = false;
    const writeBytes = createDisconnectAwareWrite(
      (chunk) => rawWriter.write(chunk),
      () => {
        clientDisconnected = true;
        if (!streamAbort.signal.aborted) streamAbort.abort("Client disconnected");
      },
    );
    const writer = {
      write: writeBytes,
      close: () => rawWriter.close(),
    };
    const streamWrite = async (frame: string): Promise<boolean> => {
      try {
        await writer.write(encoder.encode(frame));
        return true;
      } catch {
        return false;
      }
    };
    const session = new StreamSession({
      sessionId,
      write: streamWrite,
      isAborted: () => streamAbort.signal.aborted,
    });
    const emitCancelled = async (): Promise<never> => {
      if (clientDisconnected) throw new StreamCancelledError();
      if (session.noteOutcome()) {
        session.noteTerminal();
        await streamWrite(`data: ${JSON.stringify({ type: "cancelled", session_id: sessionId })}\n\n`);
      }
      throw new StreamCancelledError();
    };
    const stopHeartbeat = SSE_HEARTBEAT_ENABLED
      ? startSseHeartbeat(sessionId, SSE_HEARTBEAT_INTERVAL_MS, streamWrite)
      : () => {};
    // Hoisted so the catch block can include them in error-path recordInference calls.
    // let-in-try is block-scoped and invisible to catch; declare here then reinitialize in the Ollama/OpenRouter path.
    let sessionCostInfo: OpenRouterCostInfo | null = null;
    let lastFallbackRetries = 0;
    let lastFallbackModel: string | undefined;
    // Track the actual provider the fallback cascade engaged for THIS turn so
    // the per-turn `recordInference` call can attribute the request to the
    // real backend. The cascade can hop from openrouter → opencode_zen →
    // opencode_go (the 2026-06-24 cross-provider fallback) and `cfg.active_backend`
    // alone would mis-bucket every non-openrouter turn as "openrouter".
    let lastProviderUsed: string | undefined;
    // Hoisted to the outer try scope so the catch block's recordInference call
    // can read them — the per-turn `actualModelUsed`/`fetchRes` are declared
    // inside the `while` loop body, which is invisible to a sibling catch.
    let lastActualModelUsed: string | undefined;
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
      await session.init(modelLabel);

      // ── Claude CLI path ──────────────────────────────────────────
      if (cfg.active_backend === "claude_cli") {
        const reasoningParser = new ReasoningParser(sessionId);
        const resumedSessionId = cliSessionMap.get(sessionId);
        const historyForCli = !resumedSessionId
          ? compactTurnHistoryForCli(
              turnHistory,
              process.platform === "win32" ? 16_000 : 200_000,
            )
          : [];
        const historyPrompt = historyForCli.length > 0
          ? `${historyForCli.map(m => {
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
        }, streamAbort.signal)) {
          if (streamAbort.signal.aborted) {
            await emitCancelled();
          }
          if (evt.type === "stream_event" && evt.delta?.text) {
            const text: string = evt.delta.text;
            for (const re of reasoningParser.processChunk(text)) {
              const visibleText = visibleTextFromReasoningEvent(re);
              if (!visibleText) continue;
              if (re.type === "reasoning_step") {
                if (cfg.reasoning.enabled) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
                }
              } else if (re.type === "reasoning_chunk") {
                if (cfg.reasoning.enabled) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
                }
              } else {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text: visibleText }, session_id: sessionId })}\n\n`));
              }
            }
          } else if (evt.type === "tool_use") {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "tool_use",
              id: (evt as any).id,
              name: evt.tool_name,
              input: evt.tool_input,
              session_id: sessionId,
            })}\n\n`));
          } else if (evt.type === "tool_result") {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "tool_result",
              name: evt.tool_name,
              output: evt.tool_output,
              session_id: sessionId,
            })}\n\n`));
          } else if (evt.type === "message_stop") {
            session.noteTerminal();
            await streamWrite(`data: ${JSON.stringify({ type: "message_stop", session_id: sessionId })}\n\n`);
          } else if (evt.type === "error") {
            if (resumedSessionId) {
              cliSessionMap.delete(sessionId);
            }
            if (session.noteOutcome()) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ ...evt, session_id: sessionId })}\n\n`));
            }
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
            if (session.noteOutcome()) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ ...evt, session_id: sessionId })}\n\n`));
            }
          }
        }
        return;
      }

      // ── Build canonical tool runtime for this request ───────────
      const { runtime, ctx } = buildChatRuntime(cfg, activeWorkspacePath);
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
        conductorLearning.setConfig(cfg.orchestrator.conductor_learning);
        const pruned = persistentConductor.pruneExpiredDiskSessions();
        if (pruned > 0) {
          console.log(`[Jarvis Orchestrator] Pruned ${pruned} expired conductor session file(s)`);
        }
        // AgentPool applies learned + cron feedback exactly once at selection.
        const agentPool = new AgentPool(cfg.orchestrator.agents ?? []);
        const poolCoverage = agentPool.coverage();
        console.log(`[Jarvis Orchestrator] Agent pool coverage: ${formatPoolDiversity(poolCoverage)}${poolCoverage.stage_gaps.length > 0 ? `; gaps=${poolCoverage.stage_gaps.join(",")}` : ""}`);

        // Setup context message using turn history if present
        let contextMessage = message;
        if (turnHistory.length > 0) {
          contextMessage = `Conversation History:\n${buildBoundedHistoryBlock(turnHistory)}\n\nLatest User Request: ${message}`;
        }

        let orchestratorTaskType = "general";

        // Custom CallModelFn for pipeline execution. `callModelAttempt` performs a
        // single model call; the `callModel` wrapper below adds a bounded
        // empty-completion retry that ADVANCES the provider cascade (the
        // synthesizer must never silently return nothing).
        // Track the actual model + provider used by the last `callModelAttempt`
        // invocation so the orchestrator's `recordInference` error/empty paths
        // (lines 1734/1754) can attribute the turn to the real provider, not
        // the user's selected `cfg.active_backend`. The pool routes through
        // opencode_zen/opencode_go for planner/executor/synthesizer defaults,
        // and those paths are otherwise invisible to `/health/inference`.
        let orchLastModel: string | undefined;
        let orchLastProvider: string | undefined;
        let orchLastFirstTokenMs: number | undefined;
        let orchestratorAgentRunId: string | undefined;
        const callModelAttempt = async (messages: any[], callOptions?: any, excludeModels?: Set<string>) => {
          ensureTurnBudget(callOptions?.stageLabel ?? "orchestrator_model_attempt");
          const stageAttemptStart = Date.now();
          const activeBackendIsOllama = cfg.active_backend === "ollama";

          // Resolve model from agent pool when a stage label is provided.
          // Each orchestrator stage gets its designated model directly,
          // bypassing the generic cfg.openrouter.model default.
          // When cascadeTier is "cheap" the cascade's first (fastest/cheapest) agent
          // is used; when "strong" the last (highest-capability) is used. Without a
          // tier the pool's default_for agent for the stage is used (pickFor).
          // opencode_zen agents are routed through the same OpenRouter API endpoint
          // as native openrouter agents — same base_url and api_key apply.
          let poolModel: string | null = null;
          // Provider of the pool-selected agent. Drives endpoint + key routing
          // for the primary request (the fallback cascade routes per-attempt).
          let poolProvider: "openrouter" | "opencode_zen" | "opencode_go" | null = null;
          let poolResolvedAgent: import("./orchestration/agent-pool").OrchestratorAgent | undefined;
          const stageLabel = callOptions?.stageLabel as string | undefined;
          const cascadeTier = callOptions?.cascadeTier as "cheap" | "strong" | undefined;
          if (stageLabel && cfg.orchestrator?.enabled) {
            try {
              const pool = new AgentPool(cfg.orchestrator?.agents ?? []);
              let agent: import("./orchestration/agent-pool").OrchestratorAgent | undefined;
              // Honor the empty-completion cascade-advance exclude set: a model
              // that just returned an empty 200 (or hit a 2-strike rate limit)
              // should never be re-selected by the pool — it would just repeat
              // the failure. The exclude set is built by the `callModel`
              // wrapper above when a user-visible stage returns no content.
              //
              // Also union in the cross-turn hard-failure memory (see
              // model-failure-memory.ts): a model that hard-failed (e.g. HTTP
              // 400) twice in a prior turn's cascade must not be re-picked as
              // THIS turn's pool default either — that was the live incident
              // (north-mini-code-free 400s every single turn because nothing
              // remembered the previous failure). Build a fresh union set so
              // the caller's `excludeModels` is never mutated.
              const poolExcludeModels = new Set<string>(excludeModels ?? []);
              for (const key of excludedModelKeys()) poolExcludeModels.add(key);
              if (cascadeTier) {
                const chain = pool.cascadeChain(stageLabel, orchestratorTaskType, poolExcludeModels);
                agent = cascadeTier === "cheap" ? chain[0] : chain[chain.length - 1];
              } else {
                agent = pool.pickFor(stageLabel, orchestratorTaskType, poolExcludeModels);
              }
              if (agent && (agent.provider === "openrouter" || agent.provider === "opencode_zen" || agent.provider === "opencode_go")) {
                poolModel = agent.model_id;
                poolProvider = agent.provider;
                poolResolvedAgent = agent;
                console.log(`[Jarvis Orchestrator] Pool resolved model ${agent.model_id} for stage=${stageLabel} cascadeTier=${cascadeTier ?? "none"} task=${orchestratorTaskType} agent=${agent.id} (provider=${agent.provider})`);
              }
            } catch (e: any) {
              console.warn(`[Jarvis Orchestrator] Pool resolution failed for stage=${stageLabel}: ${e.message}`);
            }
          }

          const resolvedOpenRouterModel = cfg.active_backend === "openrouter"
            ? await resolveOpenRouterModel(cfg)
            : null;
          const isOllama = activeBackendIsOllama && !poolProvider;
          const ollamaTarget = isOllama ? await resolveOllamaChatTarget(cfg) : null;

          const modelName = isOllama
            ? (ollamaTarget?.modelName ?? cfg.ollama.model)
            : poolModel ?? resolvedOpenRouterModel ?? cfg.openrouter.model;
          // The effective provider for the PRIMARY request. OpenCode providers
          // speak OpenAI-compatible /chat/completions but live on their own
          // base_url + key (resolveProviderTarget). OpenRouter is the default.
          const effectiveProvider = poolProvider ?? "openrouter";
          const isOpenCodeProvider = effectiveProvider === "opencode_zen" || effectiveProvider === "opencode_go";
          const providerTarget = !isOllama ? resolveProviderTarget(cfg, effectiveProvider) : null;
          // Only the OpenRouter catalog can describe OpenRouter models; skip it
          // for OpenCode (its models aren't in that catalog).
          const openRouterEffective = (!isOllama && !isOpenCodeProvider)
            ? await resolveEffectiveOpenRouterRequestConfig(cfg, modelName, messages, { surface })
            : null;
          const baseUrl = isOllama
            ? ollamaTarget!.chatUrl
            : providerChatUrl(providerTarget!);

          const modelSupportsNativeTools = isOllama
            ? (ollamaTarget?.supportsNativeTools ?? false)
            : isOpenCodeProvider
              ? false // OpenCode agents use the text tool protocol
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
          } else if (isOpenCodeProvider) {
            // OpenCode (Zen/Go): OpenAI-compatible but not in the OpenRouter
            // catalog. Apply a lean config from callOptions/cfg directly.
            if (callOptions?.max_tokens !== undefined) requestBody.max_tokens = callOptions.max_tokens;
            else if (typeof cfg.max_tokens === "number" && cfg.max_tokens > 0) requestBody.max_tokens = cfg.max_tokens;
            if (callOptions?.temperature !== undefined) requestBody.temperature = callOptions.temperature;
            else if (cfg.temperature !== undefined) requestBody.temperature = cfg.temperature;
            if (cfg.top_p !== undefined) requestBody.top_p = cfg.top_p;
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
            if (!isOllama && !isOpenCodeProvider) {
              await applyOpenRouterRequestConfig(requestBody, cfg, modelName, normalizedMessages, {
                requestedMaxTokens: callOptions?.max_tokens,
                requestedTemperature: callOptions?.temperature,
                requestedTopP: cfg.top_p,
                surface,
              });
            }
          }

          const headers: Record<string, string> = isOllama
            ? { "Authorization": "Bearer ollama", "Content-Type": "application/json" }
            : providerHeaders(cfg, providerTarget!);

          // Use the same fallback/retry pipeline as the main Agent Loop so the
          // orchestrator is not single-shot on the OpenRouter free tier (which
          // 429s frequently and 503s during provider outages). Without this
          // every orchestrator stage dies on the first transient error and the
          // user sees a silent stall.
          const useFallback = !isOllama && cfg.openrouter.enable_fallbacks;
          const requestTimeout = isOllama ? MODEL_REQUEST_TIMEOUT_MS : (cfg.openrouter.timeout_ms || MODEL_REQUEST_TIMEOUT_MS);
          const ctrl = new AbortController();
          const requestBudgetMs = Math.max(1, Math.min(requestTimeout, turnDeadlineAt - Date.now()));
          let turnDeadlineAbortedRequest = false;
          const timeout = setTimeout(() => {
            turnDeadlineAbortedRequest = Date.now() >= turnDeadlineAt;
            ctrl.abort();
          }, requestBudgetMs);
          const cleanupRequestAbort = registerAbortHandler(streamAbort.signal, () => ctrl.abort());

          let fetchRes: Response;
          let actualModelUsed = modelName;
          let actualProviderUsed: string = isOllama ? "ollama" : effectiveProvider;
          try {
            if (useFallback) {
              const result = await chatCompletionWithFallback(cfg, requestBody, ctrl.signal, {
                stage: callOptions?.stageLabel,
                taskType: orchestratorTaskType,
                cascadeTier: callOptions?.cascadeTier,
                excludeModels,
                deadlineAt: turnDeadlineAt,
                turnBudgetMs: TOTAL_TURN_TIMEOUT_MS,
              });
              fetchRes = result.response;
              actualModelUsed = result.model_used;
              actualProviderUsed = result.provider_used;
              if (result.retries > 0) {
                console.log(`[Jarvis Orchestrator] callModel used model ${result.model_used} after ${result.retries} retry attempt(s)`);
                await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "fallback_notice", model: result.model_used, retries: result.retries, session_id: sessionId })}\n\n`));
              }
            } else {
              fetchRes = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(requestBody), signal: ctrl.signal });
            }
          } catch (fetchErr: any) {
            clearTimeout(timeout);
            cleanupRequestAbort();
            if (fetchErr.name === "AbortError" && streamAbort.signal.aborted) {
              await emitCancelled();
            }
            if (turnDeadlineAbortedRequest || Date.now() >= turnDeadlineAt) {
              throw new TurnDeadlineExceededError(callOptions?.stageLabel ?? "orchestrator_request", TOTAL_TURN_TIMEOUT_MS);
            }
            if (fetchErr.name === "AbortError") {
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
            cleanupRequestAbort();
            throw new Error(`API ${fetchRes.status}: ${errText.slice(0, 300)}`);
          }
          clearTimeout(timeout);

          const reader = fetchRes.body?.getReader();
          if (!reader) {
            cleanupRequestAbort();
            throw new Error("No response body from API");
          }
          cleanupRequestAbort();
          const cancelReader = createIdempotentReaderCancel(reader);
          const cleanupReaderAbort = registerAbortHandler(streamAbort.signal, () => {
            void cancelReader("Session turn cancelled");
          });

          const reasoningParser = new ReasoningParser(sessionId);
          const decoder = new TextDecoder();
          let buffer = "";
          let fullTurnText = "";
          let activeToolCalls: any[] = [];
          let firstTokenReceived = false;
          let firstTokenLatencyMs: number | undefined;
          // Defense-in-depth: in case the request bypassed the
          // First-token watchdog (orchestrator). If the response body is open
          // but no `choice.delta.content` chunk has arrived before the per-model
          // window expires, abort the stream. Default is 30s; agents with a
          // `first_token_timeout_ms` override (e.g. Nemotron planner/synthesizer
          // at 55s) widen the window accordingly. CRITICAL: the override MUST
          // be applied to the `setTimeout` delay itself — a previous revision
          // only used the resolved value in the log message, so slow cold-starts
          // were still aborted at 30s despite the override being "in effect".
          // `firstTokenTimeoutFor` clamps to [1_000, 60_000] so this watchdog
          // can never fire after the outer 60s stream-stall watchdog would have.
          const firstTokenMs = firstTokenTimeoutFor(
            agentPool,
            actualModelUsed,
            MODEL_FIRST_TOKEN_TIMEOUT_MS,
            60_000,
            actualProviderUsed,
          );
          // First-token timeout flag. P0-B (2026-07-02): the previous
          // build called `streamAbort.abort("First-token timeout")` from
          // inside this timer, which is the SAME abort domain as the user
          // Stop button / `/chat/cancel`. A hung model was therefore
          // indistinguishable from a user cancellation — it emitted a
          // `cancelled` SSE frame, the UI had no `cancelled` handler, the
          // assistant bubble was finalized empty, and the user saw a silent
          // blank bubble.
          //
          // The watchdog now lives in its own abort domain: per-read-loop
          // `reader.cancel()` only, plus a flag that the read loop checks
          // after the next `read()` returns. The error is raised as
          // `FirstTokenTimeoutError` and surfaced to the client as a
          // structured `error` frame with `code: "first_token_timeout"`
          // (handled in the outer `streamJarvis` catch block).
          let firstTokenTimeoutFired = false;
          const firstTokenTimer = setTimeout(() => {
            if (!firstTokenReceived && !streamAbort.signal.aborted) {
              firstTokenTimeoutFired = true;
              console.warn(`[Jarvis Orchestrator] First-token timeout (${firstTokenMs / 1000}s) on stage=${callOptions?.stageLabel ?? "agent"} model=${actualModelUsed} — aborting stream`);
              cancelReader("First-token timeout").catch(() => {});
            }
          }, firstTokenMs);
          let streamIdleTimeoutFired = false;
          let visibleProgressTimeoutFired = false;
          let turnDeadlineExceeded = false;
          const stageName = callOptions?.stageLabel ?? "agent";
          const streamLiveness = createStreamLivenessTracker({
            interTokenMs: MODEL_INTER_TOKEN_TIMEOUT_MS,
            visibleMs: MODEL_VISIBLE_PROGRESS_TIMEOUT_MS,
            onTransportStall: () => {
              streamIdleTimeoutFired = true;
              console.warn(`[Jarvis Orchestrator] Inter-token timeout (${MODEL_INTER_TOKEN_TIMEOUT_MS / 1000}s) on stage=${stageName} model=${actualModelUsed} — cancelling reader`);
              cancelReader("Inter-token timeout").catch(() => {});
            },
            onVisibleStall: () => {
              visibleProgressTimeoutFired = true;
              console.warn(`[Jarvis Orchestrator] Visible-progress timeout (${MODEL_VISIBLE_PROGRESS_TIMEOUT_MS / 1000}s) on stage=${stageName} model=${actualModelUsed} — cancelling reader`);
              cancelReader("Visible-progress timeout").catch(() => {});
            },
          });
          const markFirstProgress = () => {
            if (!firstTokenReceived) {
              firstTokenReceived = true;
              firstTokenLatencyMs = Date.now() - stageAttemptStart;
              clearTimeout(firstTokenTimer);
            }
          };
          const markTransportProgress = () => {
            markFirstProgress();
            streamLiveness.onTransportProgress();
          };
          const markVisibleProgress = () => {
            markFirstProgress();
            streamLiveness.onVisibleProgress();
          };
          const turnDeadlineTimer = setTimeout(() => {
            if (!streamAbort.signal.aborted) {
              turnDeadlineExceeded = true;
              cancelReader("Turn deadline exceeded").catch(() => {});
            }
          }, Math.max(0, turnDeadlineAt - Date.now()));
          const textStreamSanitizer = createStageStreamSanitizer(Boolean(useTextTools));
          const emitTextToken = async (text: string) => {
            if (callOptions?.surfaceAsAnswer) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "stream_event", delta: { text }, session_id: sessionId })}\n\n`));
            } else if (!callOptions?.suppressActivity) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "agent_activity", stage: callOptions?.stageLabel ?? "agent", text, session_id: sessionId })}\n\n`));
            }
          };

          try {
          while (true) {
            if (streamAbort.signal.aborted) {
              await emitCancelled();
            }
            const readResult = await reader.read();
            const { done, value } = readResult;
            // P0-B (2026-07-02): the first-token watchdog sets this flag
            // (and calls `reader.cancel()`) without touching `streamAbort`,
            // so a hung model is no longer conflated with user cancellation.
            // The flag is checked here, after the `reader.read()` that
            // follows `reader.cancel()` has resolved, and surfaces the
            // timeout as a structured error instead of silently dropping
            // the turn. The outer `streamJarvis` catch block converts
            // this into an `error` SSE frame with
            // `code: "first_token_timeout"`.
            const stopReason = resolveReadStopReason({
              firstTokenTimedOut: firstTokenTimeoutFired,
              streamIdleTimedOut: streamIdleTimeoutFired,
              visibleProgressTimedOut: visibleProgressTimeoutFired,
              turnDeadlineExceeded,
              signal: streamAbort.signal,
            });
            if (stopReason === "first_token_timeout") {
              throw new FirstTokenTimeoutError(actualModelUsed, callOptions?.stageLabel ?? "agent", firstTokenMs);
            }
            if (stopReason === "stream_idle_timeout") {
              throw new StreamIdleTimeoutError(actualModelUsed, stageName, MODEL_INTER_TOKEN_TIMEOUT_MS);
            }
            if (stopReason === "turn_cancelled") await emitCancelled();
            if (stopReason === "turn_deadline_exceeded") {
              throw new TurnDeadlineExceededError(stageName, TOTAL_TURN_TIMEOUT_MS);
            }
            if (stopReason === "visible_progress_timeout") {
              throw new VisibleProgressTimeoutError(actualModelUsed, stageName, MODEL_VISIBLE_PROGRESS_TIMEOUT_MS);
            }
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

                if (choice.delta?.tool_calls?.length) {
                  markVisibleProgress();
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
                    markTransportProgress();
                    fullTurnText += chunkText;
                    if (callOptions?.onChunk) {
                      callOptions.onChunk(chunkText);
                    }

                    if (reasoningParser) {
                      for (const re of reasoningParser.processChunk(chunkText)) {
                        const visibleText = visibleTextFromReasoningEvent(re);
                        if (!visibleText) continue;
                        if (re.type === "reasoning_step") {
                          if (cfg.reasoning.enabled) {
                            await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
                          }
                        } else if (re.type === "reasoning_chunk") {
                          if (cfg.reasoning.enabled) {
                            await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
                          }
                        } else {
                          markVisibleProgress();
                          const sanitized = textStreamSanitizer.push(visibleText);
                          if (sanitized) {
                            await emitTextToken(sanitized);
                          }
                        }
                      }
                    } else {
                      markVisibleProgress();
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

          // Always clear the first-token timer when the read loop exits,
          // whether normally (done), via abort, or via the watchdog.
          clearTimeout(firstTokenTimer);

          if (reasoningParser) {
            for (const re of reasoningParser.flush()) {
              const visibleText = visibleTextFromReasoningEvent(re);
              if (!visibleText) continue;
              if (re.type === "reasoning_step") {
                if (cfg.reasoning.enabled) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_step", step: re.step, session_id: sessionId })}\n\n`));
                }
              } else if (re.type === "reasoning_chunk") {
                if (cfg.reasoning.enabled) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_chunk", text: visibleText, session_id: sessionId })}\n\n`));
                }
              } else {
                const sanitized = textStreamSanitizer.push(visibleText);
                if (sanitized) {
                  await emitTextToken(sanitized);
                }
              }
            }
            if (cfg.reasoning.enabled) {
              const trace = reasoningParser.finalize();
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "reasoning_complete", trace, session_id: sessionId })}\n\n`));
            }
          }

          const remaining = textStreamSanitizer.flush();
          if (remaining) {
            await emitTextToken(remaining);
          }

          // Normalize the stream-assembled tool-call slots into a dispatchable
          // list. The old code here silently coerced non-JSON `arguments` to
          // `{}` and emitted a tool call with an undefined `name` whenever the
          // model streamed arguments chunks but no function.name delta — both
          // failure modes are real per the 2026-06-26 live diagnosis (Priority
          // 3: "executor/provider compatibility is unstable and produces
          // malformed-tool-message failures during fallback"). The
          // agent-loop path at line 2041 already filters name-less slots; the
          // orchestrator path now does the same and additionally surfaces a
          // one-line `[Jarvis]` warning per malformed entry so the operator
          // can attribute the failure to a specific model output.
          const normalizeCtx = `model=${poolModel ?? "<unknown>"} provider=${poolProvider ?? "<unknown>"} stage=${stageLabel ?? "<none>"}`;
          const normalized = normalizeStreamedToolCalls(activeToolCalls);
          for (const w of normalized.warnings) {
            console.warn(`[Jarvis] malformed streamed tool_call (${w.kind}) ${normalizeCtx}: ${w.message}`);
          }
          let parsedToolCalls = normalized.calls;

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

          const reasoningStripped = cfg.reasoning.enabled ? stripReasoningFromText(fullTurnText) : fullTurnText;
          // Defense-in-depth: a stage that was never offered `tools` (e.g.
          // synthesizer, planner, reviewer, coordinator) has no legitimate
          // reason to emit <tool_call> syntax — but a free-tier model can
          // still hallucinate it from prior context (e.g. the synthesizer
          // echoing the executor's tool-heavy activity summary verbatim,
          // 2026-07-01 live incident: synthesizer answer was literally just
          // `<tool_call>{"name":"list_directory",...}</tool_call>`). Stages
          // that DO use the text-tool protocol already run
          // extractTextToolCalls above to parse+execute genuine calls; a
          // stage with no tools never does, so any such tag it emits would
          // otherwise leak straight into the user-visible answer verbatim.
          // extractTextToolCalls with an empty tools list can never
          // match/execute anything (normalizeToolName requires the name to
          // be in the offered tools), it only performs the cleanup — so this
          // is safe even when nothing was actually a real tool call.
          // Text-tool stages first remove genuine call blocks (real tools
          // list), then EVERY stage gets the empty-list cosmetic pass. The
          // previous `useTextTools ? reasoningStripped : …` ternary returned
          // the raw text for text-tool stages, so bare hallucinated tool JSON
          // in executor visible activity was never stripped.
          const toolAwareCleaned = useTextTools
            ? extractTextToolCalls(reasoningStripped, callOptions.tools).cleanedText
            : reasoningStripped;
          const cleanContent = extractTextToolCalls(toolAwareCleaned, []).cleanedText;
          // Capture the actual provider/model used by this attempt so the
          // orchestrator's `recordInference` error/empty paths can attribute
          // the turn to the real backend (not the user's selected
          // `cfg.active_backend`). The orchestrator's pool routinely routes
          // through opencode_zen / opencode_go for planner/executor/synthesizer
          // defaults — without this, all of those turns would be misattributed
          // to "openrouter" in `/health/inference`.
          orchLastModel = actualModelUsed;
          orchLastProvider = actualProviderUsed;
          orchLastFirstTokenMs = firstTokenLatencyMs;
          if (
            orchestratorAgentRunId &&
            stageLabel &&
            cfg.orchestrator?.conductor_learning?.enabled &&
            actualModelUsed &&
            actualProviderUsed
          ) {
            // Phase 6 (tool normalization warning): if the model emitted a tool
            // call whose name is not in the offered tools list, log a one-line
            // warning so operators can attribute the failure to a specific model
            // output. The native path already filters unknown names via
            // `normalizeToolName` (returns null for unknown names); the text-tool
            // path already filters via `normalizeToolName` in `callsFromValue`.
            // This warning is purely diagnostic — it does not change behavior.
            if (parsedToolCalls.length > 0 && callOptions?.tools) {
              const offeredNames = new Set(
                (callOptions.tools as Array<{ function?: { name?: string }; name?: string }>).map(
                  (t) => t.function?.name ?? t.name,
                ),
              );
              for (const call of parsedToolCalls) {
                if (call.name && !offeredNames.has(call.name)) {
                  console.warn(
                    `[Jarvis Orchestrator] Stage ${stageLabel ?? "<none>"} emitted tool call "${call.name}" not in offered tools list — possible model hallucination. model=${actualModelUsed ?? "<unknown>"} provider=${actualProviderUsed ?? "<unknown>"}`,
                  );
                }
              }
            }

            const hasContent = typeof cleanContent === "string" && cleanContent.trim().length > 0;
            const hasToolCalls = parsedToolCalls.length > 0;
            // A user-visible stage (surfaceAsAnswer, i.e. the synthesizer) must
            // produce actual prose to count as a success — 2026-07-03 session
            // 1d4727cf / run_81091960: the synthesizer emitted tool-call JSON as
            // its "answer", cleanContent stripped it to empty, but the reward
            // signal here still counted `hasToolCalls` as success, so the tuning
            // loop BOOSTED the capability score of the model that leaked the
            // JSON. Non-answer stages (executor, etc.) legitimately succeed via
            // tool calls with no prose, so they keep the original OR logic.
            const isAnswerStage = callOptions?.surfaceAsAnswer === true;
            conductorLearning.recordStageModel({
              agentRunId: orchestratorAgentRunId,
              stageId: stageLabel,
              agentId: poolResolvedAgent?.id,
              provider: actualProviderUsed,
              modelId: actualModelUsed,
              durationMs: Date.now() - stageAttemptStart,
              firstTokenMs: firstTokenLatencyMs,
              fallbackUsed: (excludeModels?.size ?? 0) > 0,
              wasSuccessful: isAnswerStage ? hasContent : (hasContent || hasToolCalls),
              hadError: isAnswerStage ? !hasContent : (!hasContent && !hasToolCalls),
            });
          }
          return {
            content: cleanContent,
            tool_calls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
            // Wrapper-only metadata so callModel can exclude this model on an
            // empty-completion retry. Not part of the CallModelFn contract.
            _modelUsed: actualModelUsed,
            _provider: actualProviderUsed,
          };
          } finally {
            clearTimeout(firstTokenTimer);
            clearTimeout(turnDeadlineTimer);
            streamLiveness.stop();
            cleanupReaderAbort();
            cleanupRequestAbort();
          }
        };

        // CallModelFn seen by the coordinator + pipeline. Adds a bounded
        // empty-completion retry: if a USER-VISIBLE stage (synthesizer) returns a
        // semantically-empty 200 (no content + no tool calls) and we have a
        // fallback cascade, advance PAST that model and try the next one. A model
        // that just returned empty will almost always return empty again, so
        // retrying the same model is pointless — we exclude it. Bounded to one
        // extra advance to cap latency; if both come back empty the pipeline
        // records `empty_completion` and the user gets the friendly retry notice.
        const callModel = async (messages: any[], callOptions?: any) => {
          const canAdvance = callOptions?.surfaceAsAnswer === true && cfg.active_backend !== "ollama" && cfg.openrouter.enable_fallbacks;
          const exclude = new Set<string>();
          let last: any = await callModelAttempt(messages, callOptions);
          if (!canAdvance) return last;
          // Bounded empty-completion cascade-advance. If a user-visible stage
          // returns a semantically-empty 200 (no content + no tool calls) and
          // we have a fallback cascade, advance PAST that model and try the
          // next one. A model that just returned empty will almost always
          // return empty again, so retrying the same model is pointless — we
          // exclude it via the `exclude` set (now honored by both the pool
          // selection and `chatCompletionWithFallback`).
          //
          // Bound to 2 extra attempts. Stop early if:
          //   - the new attempt produced content/tool_calls (success)
          //   - the stream was aborted (user gave up)
          //   - the pool returned the same model we just excluded (no other
          //     candidate available) — this prevents a silent infinite loop
          //     that the previous build hit on the live smoke test.
          for (let advance = 0; advance < 2; advance++) {
            const hasContent = typeof last?.content === "string" && last.content.trim().length > 0;
            // A user-visible stage is only "done" when it produced clean prose.
            // Tool calls do NOT count: a synthesizer that emits a tool call has
            // no tools to run it with, and before 2026-07-04 the leaked call
            // text itself was accepted as the answer (session 1d4727cf) — and
            // then reinforced by the tuning loop as a success.
            if (hasContent || streamAbort.signal.aborted) break;
            if (last?._provider && last?._modelUsed) {
              const key = `${last._provider}:${last._modelUsed}`;
              if (exclude.has(key)) {
                console.warn(`[Jarvis Orchestrator] empty-completion cascade-advance has no different model left in pool (only ${key} available) — stopping`);
                break;
              }
              exclude.add(key);
            }
            if (exclude.size === 0) break; // no exclusion built → nothing to advance past
            console.warn(`[Jarvis Orchestrator] empty completion from ${last?._provider}:${last?._modelUsed} stage=${callOptions?.stageLabel ?? "?"} — advancing cascade (excluding it)`);
            // Nudge the retry model toward plain prose. `normalizeMessagesForLLM`
            // (above) only merges LEADING system messages into one; a system
            // message appended at the end would land mid-array and get
            // demoted to a `[System: ...]`-wrapped user message instead of
            // staying in the actual system prompt. So we splice the nudge
            // into the existing leading system message's content (or add one
            // if the stage somehow has none) rather than pushing a new
            // trailing message — and we copy the array/message objects so the
            // original `messages` passed to this closure is never mutated.
            const nudge = "You have no tools available. Answer the user in plain prose now — do not emit tool_call syntax, tool JSON, or any function-call markup.";
            const nudgedMessages = [...messages];
            const leadingSystemIdx = nudgedMessages.findIndex((m) => m?.role === "system");
            if (leadingSystemIdx >= 0) {
              nudgedMessages[leadingSystemIdx] = {
                ...nudgedMessages[leadingSystemIdx],
                content: `${nudgedMessages[leadingSystemIdx].content ?? ""}\n\n${nudge}`,
              };
            } else {
              nudgedMessages.unshift({ role: "system", content: nudge });
            }
            last = await callModelAttempt(nudgedMessages, callOptions, exclude);
          }
          return last;
        };

        // Route the user request through the Fugu-style coordinator. The
        // current executor still consumes a concrete stage list, so null skips
        // and re-entry directives are materialized at the activation boundary.
        // Deterministic capability classification of the RAW current message —
        // NOT `contextMessage` (which prepends history and would let a prior
        // file-read contaminate a follow-up greeting). This is the authoritative
        // signal; the coordinator model's route is advisory.
        const continuation = isContinuationTurn(message);
        const turnReq = inheritRequirementForContinuation(
          classifyTurnRequirements(message),
          continuationRequirements.get(sessionId),
          continuation,
        );
        const shortCircuit = shouldShortCircuitCoordinator(message, turnReq, continuation);
        const coordinator = new Coordinator(callModel, persistentConductor);
        const workspaceRootHint = `Active filesystem workspace root: ${activeWorkspacePath}. Resolve relative filesystem paths against this root.`;
        const memoryHints = mergeSharedContextHints(
          sessionMemory.toSharedContextHints(sessionId, activeWorkspacePath),
          { relevant_memories: [workspaceRootHint] },
        );
        const coordinatorStartedAt = Date.now();
        const route = shortCircuit
          ? buildShortCircuitRoute(
              turnReq.requirement === "conversational" ? "conversational" : "answer_only",
            )
          : await coordinator.route(contextMessage, {
              sessionId,
              rawMessage: message,
              history: turnHistory,
              lastOutcome: sessionMemory.getLastOutcome(sessionId),
              sessionMemoryHints: memoryHints,
            });
        const coordinatorDurationMs = shortCircuit ? 0 : Date.now() - coordinatorStartedAt;
        orchestratorTaskType = route.task_type;

        const routeSource = shortCircuit
          ? "trivial_short_circuit"
          : route.routing_parse_fallback
            ? "parse_fallback"
            : "model";
        const normalized = normalizeRoute(
          route,
          turnReq.requirement,
          routeSource,
        );
        const executablePipeline = normalized.pipeline;
        const executionProfile: ExecutionProfile = normalized.profile;
        rememberContinuationRequirement(sessionId, turnReq.requirement);
        console.log(
          `[Jarvis Orchestrator] task_type=${route.task_type} model_route=${route.pipeline.map((s) => s ?? "skip").join("->")}/${route.topology}; ` +
          `requirement=${turnReq.requirement} [${turnReq.signals.join(",")}]; ` +
          `normalized=${executablePipeline.join("->")}/${normalized.topology} profile=${executionProfile} source=${normalized.route_source}`,
        );
        if (normalized.override_reason) {
          console.warn(`[Jarvis Orchestrator] route override: ${normalized.override_reason}`);
        }

        // Initialize tuned configurations and start run in collector
        const agentRunId = `run_${crypto.randomUUID()}`;
        orchestratorAgentRunId = agentRunId;
        selfTuningProposer.initializeTunedConfigs();
        outcomeCollector.startAgentRun(agentRunId, sessionId, contextMessage, route.task_type, executablePipeline);
        const conductorRunId = conductorLearning.recordRouting({
          agentRunId,
          sessionId,
          route,
          normalizedPipeline: executablePipeline,
          routeSource: normalized.route_source,
          conductorSource: route.conductor_source ?? "api",
          conductorModel: route.conductor_model,
        });
        if (!shortCircuit) {
          const coordinatorSucceeded = !route.routing_parse_fallback;
          outcomeCollector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "coordinator",
            turn_number: 1,
            input_tokens: countTokens(contextMessage),
            tool_calls_json: "[]",
            duration_ms: coordinatorDurationMs,
            was_successful: coordinatorSucceeded ? 1 : 0,
            had_error: coordinatorSucceeded ? 0 : 1,
            error_message: coordinatorSucceeded ? undefined : "routing_parse_fallback",
          });
          if (orchLastModel && orchLastProvider) {
            conductorLearning.recordStageModel({
              agentRunId,
              stageId: "coordinator",
              provider: orchLastProvider,
              modelId: orchLastModel,
              durationMs: coordinatorDurationMs,
              firstTokenMs: orchLastFirstTokenMs,
              wasSuccessful: coordinatorSucceeded,
              hadError: !coordinatorSucceeded,
            });
          }
        }
        const instructionSelection = conductorLearning.selectInstructionVariants(
          route.worker_instructions,
          route.task_type,
        );
        const resolvedSkills = resolveSkillsForTurn(message, route.task_type);
        // The canonical run duration must include model-backed routing now that
        // coordinator time is a first-class stage. Starting this clock after
        // route selection would make child stage totals exceed their parent
        // run and corrupt latency/reward feedback.
        const runStartTime = coordinatorStartedAt;

        // Execute the pipeline
        const mergedSharedContext = mergeSharedContextHints(
          mergeSharedContextHints(route.shared_context, memoryHints),
          {
            relevant_memories: [
              `Active filesystem workspace root: ${activeWorkspacePath}. Resolve relative filesystem paths against this root.`,
            ],
          },
        );
        const executor = new PipelineExecutor(callModel, runtime, ctx);
        const onOrchestratorStateChange = async (state: PipelineProgressState) => {
          // Stream stage progress back to client — "conductor_replan" (B-02)
          // rides the same event type as an internal, non-user-facing status.
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: "orchestrator_stage",
            stage: state.stage,
            status: state.status,
            session_id: sessionId
          })}\n\n`));
        };
        const pipelineOptions = {
          topology: normalized.topology,
          executionProfile,
          turnRequirement: turnReq.requirement,
          workerInstructions: instructionSelection.instructions,
          sharedContext: mergedSharedContext,
          sessionMemory: sessionMemory,
          distilledSkillsBlock: resolvedSkills.promptBlock,
          maxRecursionDepth: cfg.orchestrator.max_recursion_depth,
          onRecursion: async (event: PipelineRecursionEvent) => {
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "orchestrator_recursion",
              depth: event.depth,
              status: event.status,
              reenter_stage: event.reenter_stage,
              critique: event.critique,
              session_id: sessionId
            })}\n\n`));
          },
        };
        // Check the RAW route, not `executablePipeline` — normalizeRoute strips
        // conductor_replan markers before building the executable stage list,
        // so executablePipeline never contains it and checking that instead
        // would make this branch permanently unreachable.
        const result = route.pipeline.includes("conductor_replan")
          ? await runPipelineWithReplanning({
              contextMessage,
              initialDecision: route,
              turnRequirement: turnReq.requirement,
              coordinator,
              routeOptions: {
                sessionId,
                rawMessage: message,
                history: turnHistory,
                lastOutcome: sessionMemory.getLastOutcome(sessionId),
                sessionMemoryHints: memoryHints,
              },
              executor,
              agentRunId,
              onStateChange: onOrchestratorStateChange,
              baseOptions: pipelineOptions,
              maxReplans: cfg.orchestrator.max_conductor_replans,
              // B-04: hand the per-session counter the session id so the
              // loop can enforce the per-session cap and persist a
              // `replan_events` row per re-invocation.
              sessionCounter: replanCounter,
              sessionId,
            })
          : await executor.execute(contextMessage, executablePipeline, agentRunId, onOrchestratorStateChange, pipelineOptions);

        // Record metrics and propose tuning options
        const duration = Date.now() - runStartTime;
        let totalTokens = 0;
        let totalTokensIn = 0;
        let totalTokensOut = 0;
        let totalToolCalls = 0;
        try {
          const stages = outcomeCollector["store"].getStageRuns(agentRunId);
          for (const s of stages) {
            totalTokensIn += s.input_tokens || 0;
            totalTokensOut += s.output_tokens || 0;
            totalTokens += totalTokensIn + totalTokensOut;
            if (s.tool_calls_json) {
              const parsed = JSON.parse(s.tool_calls_json);
              totalToolCalls += parsed.length;
            }
          }
        } catch {}

        // Truthful run outcome. An empty/degraded run must NOT be recorded as a
        // success — that poisons the self-tuning signal. `completed:1` only means
        // the run finished; `outcome` records whether it actually succeeded.
        const trimmedAnswer = result.answer?.trim() || "";
        const runOutcome: "success" | "degraded" | "failed" =
          result.outcome ?? (result.error || !trimmedAnswer ? "failed" : "success");
        const finalOutputForLog = trimmedAnswer || result.error || `(no output: ${result.error_code ?? "empty_completion"})`;
        sessionMemory.recordPipelineOutcome(sessionId, {
          outcome: runOutcome,
          errorCode: result.error_code,
          error: result.error,
          answer: trimmedAnswer,
        });
        outcomeCollector.completeAgentRun(agentRunId, finalOutputForLog, duration, totalToolCalls, totalTokens, runOutcome);
        if (conductorRunId) {
          const stageRuns = outcomeCollector["store"].getStageRuns(agentRunId);
          const modelAttributions = outcomeCollector["store"].getModelAttributions(agentRunId);
          conductorLearning.completeRun({
            conductorRunId,
            agentRunId,
            sessionId,
            taskType: route.task_type,
            route,
            runOutcome,
            workerInstructions: route.worker_instructions,
            instructionVariants: instructionSelection,
            stageRuns,
            modelAttributions,
            durationMs: duration,
            userRequest: contextMessage,
          });
          const heuristic = await conductorLearning.optimizeAndApply(
            agentRunId,
            route.task_type,
            cfg.orchestrator.agents ?? [],
          );
          if (heuristic.proposals.length > 0) {
            console.log(
              `[Jarvis Orchestrator] Phase 4 heuristics applied: ${heuristic.proposals.length} proposals, ` +
              `${heuristic.agentsAdjusted} agent adjustments, ${heuristic.fallbackBoostsApplied} fallback boosts`,
            );
          }
        }
        const distillCfg = cfg.orchestrator.skill_distillation;
        if (distillCfg?.enabled && runOutcome === "success") {
          const stageRunsForDistill = outcomeCollector["store"].getStageRuns(agentRunId);
          const candidate = distillSkillCandidate({
            agentRunId,
            sessionId,
            taskType: route.task_type,
            userRequest: contextMessage,
            workerInstructions: route.worker_instructions,
            stageRuns: stageRunsForDistill,
            runOutcome,
          }, distillCfg);
          if (candidate) {
            if (distillCfg.auto_promote) {
              // Judge-gated promotion for THIS candidate only — not the whole
              // pending queue. The old unconditional `runSkillPromotionPass`
              // bulk call auto-promoted on heuristics alone with zero
              // semantic review; that safety gap is why `auto_promote`
              // defaults to false below.
              const promotion = await promoteSkillCandidate(candidate.id, callModel, distillCfg);
              console.log(
                `[Jarvis Orchestrator] Distilled skill candidate ${candidate.id} (confidence=${candidate.confidence.toFixed(2)}); ` +
                `auto_promote result: ${promotion.ok ? promotion.candidate?.status : `error=${promotion.error}`}`,
              );
            } else {
              // Default (organism loop v1 safety fix): heuristic screen only.
              // Junk is rejected immediately via the same 6 gates as before;
              // candidates that clear them stay in "candidate" status and
              // wait for an explicit operator Promote action
              // (POST /skills/candidates/:id/promote), which adds the
              // semantic judge gate before anything can inject into prompts.
              const heuristic = evaluateSkillPromotion(candidate, distillCfg);
              if (!heuristic.promote) {
                updateSkillCandidateStatus(candidate.id, "rejected", heuristic.score, heuristic.reason, heuristic.detail);
              }
              console.log(
                `[Jarvis Orchestrator] Distilled skill candidate ${candidate.id} (confidence=${candidate.confidence.toFixed(2)}); ` +
                `heuristic screen: ${heuristic.promote ? "passed, awaiting operator promote" : `rejected (${heuristic.reason})`}`,
              );
            }
          }
        }
        await selfTuningProposer.proposeAndApply(agentRunId, route.task_type);

        // Write final done messages
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "agent_run_id", agent_run_id: agentRunId, session_id: sessionId })}\n\n`));
        if (result.error) {
          // Turn-fatal failure (e.g. auth rejected on every stage): surface a
          // real error frame so the UI shows a banner instead of dropping the
          // failure text into the chat bubble as if it were an answer.
          console.error(`[Jarvis Orchestrator] session=${sessionId} failed: ${result.error}`);
          recordInference({
            ts: Date.now(),
            // Attribute the failure to the actual provider the orchestrator
            // routed through, not the user's `cfg.active_backend`. The pool
            // can route planner/executor/synthesizer defaults through
            // opencode_zen / opencode_go, and those backends are otherwise
            // invisible to `/health/inference` (Backend type previously only
            // listed ollama / openrouter / claude_cli).
            backend: backendForProvider(orchLastProvider, cfg.active_backend),
            model: orchLastModel ?? (cfg.active_backend === "openrouter"
              ? (cfg.openrouter.model ?? "openrouter/free")
              : cfg.ollama.model),
            ok: false,
            latency_ms: duration,
            tokens_in: 0,
            tokens_out: 0,
            error: result.error.slice(0, 200),
          });
          await session.finish(result.error, { isError: true });
        } else if (!trimmedAnswer) {
          // Empty (non-fatal) completion: show the friendly retry notice, but
          // record the inference as a FAILURE so telemetry is truthful (the run
          // outcome above is already `failed`/`empty_completion`).
          console.warn(`[Jarvis Orchestrator] Pipeline returned empty answer session=${sessionId} (outcome=${runOutcome}, code=${result.error_code ?? "empty_completion"}) — surfacing fallback`);
          recordInference({
            ts: Date.now(),
            // See note above: attribute to the actual provider so the
            // empty-completion failure is correctly bucketed.
            backend: backendForProvider(orchLastProvider, cfg.active_backend),
            model: orchLastModel ?? (cfg.active_backend === "openrouter"
              ? (cfg.openrouter.model ?? "openrouter/free")
              : cfg.ollama.model),
            ok: false,
            latency_ms: duration,
            tokens_in: 0,
            tokens_out: 0,
            error: result.error_code ?? "empty_completion",
          });
          await session.finish("The orchestrator completed but produced no output. This may be a transient model issue. Try your request again.");
        } else {
          // Success path. The orchestrator runs many model calls per user
          // turn (planner, executor, reviewer, synthesizer, recursion_critique,
          // etc.); the per-stage tokens are already tracked in the
          // self-tuning collector (`stage_runs` table). The record below
          // is a per-TURN summary for `/health/inference` — it tells the
          // operator that "yes, the orchestrator answered a question, and
          // the final answer came from this provider." Without it the
          // success path was invisible to the inference observability layer,
          // so a healthy turn left the metrics window at the previous
          // failure's stale data.
          recordInference({
            ts: Date.now(),
            // Same mapping as the error/empty paths — attribute to the
            // actual provider the orchestrator routed through, not the
            // user's `cfg.active_backend`.
            backend: backendForProvider(orchLastProvider, cfg.active_backend),
            model: orchLastModel ?? (cfg.active_backend === "openrouter"
              ? (cfg.openrouter.model ?? "openrouter/free")
              : cfg.ollama.model),
            ok: true,
            latency_ms: duration,
            tokens_in: 0,
            tokens_out: 0,
          });
          await session.finish(trimmedAnswer || result.answer);
        }
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
      sessionCostInfo = null;
      let prevToolCallCount = 0;  // Track tools called in previous turn for nudge logic
      lastFallbackRetries = 0;
      lastFallbackModel = undefined;
      const requiresVerifiedWebSearch = cfg.tools.enabled && hasExplicitWebSearchIntent(message);
      const requiresLocalToolUse = cfg.tools.enabled && hasLocalWorkspaceToolIntent(message);

       const cachedTextToolInstructions = cfg.tools.enabled && useTextToolProtocol
        ? buildTextToolInstructions(runtime.listTools())
        : "";

      while (!loopDone && turnCount < MAX_TOOL_EXECUTION_TURNS) {
        ensureTurnBudget("agent_loop");
        turnCount++;
        _turnStart = Date.now();
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
        // Cache-friendly prompt assembly:
        //   [0] static prefix (identity + sandbox + tools) — NEVER changes between turns
        //   [1..N] compaction summaries / memory context from history (infrequent changes)
        //   [N+1..] conversation history (changes every turn)
        //   [last] current user prompt (changes every turn)
        // Only the tail changes between turns → prompt cache stays warm for the prefix.
        {
          const effectiveTextTools = !forceFinalAnswerOnly ? cachedTextToolInstructions : "";
          const sandboxBlock = buildSandboxPermissions(cfg, activeWorkspacePath);
          const staticPrefix = [cfg.system_prompt, sandboxBlock, effectiveTextTools].filter(Boolean).join("\n\n");
          messages.push({ role: "system", content: staticPrefix });
          // Preserve compaction summaries and memory system messages from history unchanged
          for (const msg of activeHistory) {
            if (msg.role === "system") {
              messages.push(msg);
            }
          }
          // Non-system history
          messages.push(...activeHistory.filter(m => m.role !== "system"));
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
        const requestBudgetMs = Math.max(1, Math.min(requestTimeout, turnDeadlineAt - Date.now()));
        let turnDeadlineAbortedRequest = false;
        const timeout = setTimeout(() => {
          turnDeadlineAbortedRequest = Date.now() >= turnDeadlineAt;
          ctrl.abort();
        }, requestBudgetMs);
        const cleanupRequestAbort = registerAbortHandler(streamAbort.signal, () => ctrl.abort());

        let fetchRes: Response;
        let actualModelUsed = modelName;
        // Mirror to the outer-scope hoisted variable so the catch block can
        // read the actual model used when the turn errored. The `let` above
        // is block-scoped to the `while` body and invisible to the catch.
        lastActualModelUsed = actualModelUsed;

        try {
          if (useFallback) {
            ensureTurnBudget("agent_loop_fallback");
            const result = await chatCompletionWithFallback(cfg, requestBody, ctrl.signal, {
              stage: "agent_loop",
              deadlineAt: turnDeadlineAt,
              turnBudgetMs: TOTAL_TURN_TIMEOUT_MS,
            });
            fetchRes = result.response;
            actualModelUsed = result.model_used;
            lastActualModelUsed = result.model_used;
            // Track the actual provider the cascade engaged so the per-turn
            // `recordInference` call can attribute the request correctly. The
            // cascade can hop providers (openrouter → opencode_zen → opencode_go
            // via the 2026-06-24 cross-provider fallback), and `cfg.active_backend`
            // alone would mis-bucket every non-openrouter turn.
            lastProviderUsed = result.provider_used;
            lastFallbackRetries = result.retries;
            if (result.retries > 0) {
              lastFallbackModel = result.model_used;
              console.log(`[OpenRouter] Used model ${result.model_used} (provider=${result.provider_used}) after ${result.retries} retry attempt(s)`);
              await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "fallback_notice", model: result.model_used, provider: result.provider_used, retries: result.retries, session_id: sessionId })}\n\n`));
            }
          } else {
            // Non-fallback path: still record the provider we targeted. For
            // ollama that's "ollama"; for openrouter it's "openrouter". This
            // covers the case where fallbacks are disabled in config but the
            // request still happens (recordInference needs SOMETHING to bucket
            // the turn under).
            lastProviderUsed = isOllama ? "ollama" : "openrouter";
            fetchRes = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(requestBody), signal: ctrl.signal });
          }
        } catch (fetchErr: any) {
          clearTimeout(timeout);
          cleanupRequestAbort();
          if (fetchErr.name === "AbortError" && streamAbort.signal.aborted) {
            await emitCancelled();
          }
          if (turnDeadlineAbortedRequest || Date.now() >= turnDeadlineAt) {
            throw new TurnDeadlineExceededError("agent_loop_request", TOTAL_TURN_TIMEOUT_MS);
          }
          if (fetchErr.name === "AbortError") {
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
            cleanupRequestAbort();
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
            const cleanupRetryAbort = registerAbortHandler(streamAbort.signal, () => retryCtrl.abort());
            try {
              fetchRes = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(requestBody), signal: retryCtrl.signal });
              if (!fetchRes.ok) {
                const retryErrText = await fetchRes.text();
                clearTimeout(retryTimeout);
                cleanupRetryAbort();
                throw new Error(`API ${fetchRes.status}: ${retryErrText.slice(0, 300)}`);
              }
              clearTimeout(retryTimeout);
              cleanupRetryAbort();
            } catch (retryErr: any) {
              clearTimeout(retryTimeout);
              cleanupRetryAbort();
              if (retryErr.name === "AbortError" && streamAbort.signal.aborted) {
                await emitCancelled();
              }
              throw retryErr;
            }
          } else {
            cleanupRequestAbort();
            if (fetchRes.status === 404 && isOllama) throw new Error(`Model "${modelName}" not found in Ollama. Run: ollama pull ${modelName}`);
            if (fetchRes.status === 401) throw new Error(`Authentication failed. ${isOllama ? "Ollama accepts any key." : "Check your OpenRouter API key."}`);
            if (fetchRes.status === 429) throw new Error(`Rate limited by ${isOllama ? "Ollama" : "OpenRouter"}. ${useFallback ? "All fallback models also exhausted." : "Enable fallback models in settings."}`);
            if (fetchRes.status === 503) throw new Error(`${isOllama ? "Ollama" : "OpenRouter"} is overloaded. ${useFallback ? "All fallback models also unavailable." : "Try again shortly."}`);
            throw new Error(`API ${fetchRes.status}: ${errText.slice(0, 300)}`);
          }
        }

        const reader = fetchRes.body?.getReader();
        if (!reader) {
          cleanupRequestAbort();
          throw new Error("No response body from API");
        }
        cleanupRequestAbort();
        const cancelReader = createIdempotentReaderCancel(reader);
        const cleanupReaderAbort = registerAbortHandler(streamAbort.signal, () => {
          void cancelReader("Session turn cancelled");
        });

        const textPipe = session.newTextPipe(cfg.reasoning.enabled);
        const decoder = new TextDecoder();
        let buffer = "";
        let turnText = "";
        let firstTokenReceived = false;
        // Agent Loop first-token watchdog. The Agent Loop fetches
        // directly (bypassing chatCompletionWithFallback), so the
        // cascade-advance logic in openrouter.ts does not cover this
        // path. Aborting on the per-model first-token window of
        // silence from the response body surfaces a clear error to
        // the caller instead of the pre-fix silent 5-min stall.
        //
        // Apply the per-model first-token override (planner/synthesizer
        // defaults get 55s; the rest stay on the global 30s). The
        // override MUST be applied to the `setTimeout` delay itself —
        // a previous revision only used the resolved value in the log
        // message, so slow cold-starts were still aborted at 30s
        // despite the override being "in effect". `firstTokenTimeoutFor`
        // clamps to [1_000, 60_000] so this watchdog can never fire
        // after the outer 60s stream-stall watchdog would have.
        const agentLoopPool = new AgentPool(cfg.orchestrator?.agents ?? []);
        const firstTokenMs = firstTokenTimeoutFor(
          agentLoopPool,
          modelName,
          MODEL_FIRST_TOKEN_TIMEOUT_MS,
          60_000,
          lastProviderUsed,
        );
        // P0-B (2026-07-02): see FirstTokenTimeoutError in this file.
        // The previous build called `streamAbort.abort("First-token timeout")`
        // from inside this timer — same abort domain as the user Stop
        // button. A hung model therefore emitted `cancelled`, the UI
        // dropped it (no handler), and the user saw a silent blank bubble.
        // The watchdog now lives in its own abort domain
        // (per-read-loop `reader.cancel()` only); the read loop checks the
        // flag below and throws FirstTokenTimeoutError, which the outer
        // `streamJarvis` catch block surfaces as a structured
        // `error` frame with `code: "first_token_timeout"`.
        let firstTokenTimeoutFired = false;
        const firstTokenTimer = setTimeout(() => {
          if (!firstTokenReceived && !streamAbort.signal.aborted) {
            firstTokenTimeoutFired = true;
            console.warn(`[Jarvis Agent Loop] First-token timeout (${firstTokenMs / 1000}s) on model=${modelName} — aborting stream`);
            cancelReader("First-token timeout").catch(() => {});
          }
        }, firstTokenMs);
        let streamIdleTimeoutFired = false;
        let turnDeadlineExceeded = false;
        const streamIdleWatchdog = new ResettableWatchdog(
          MODEL_INTER_TOKEN_TIMEOUT_MS,
          () => {
            streamIdleTimeoutFired = true;
            console.warn(`[Jarvis Agent Loop] Inter-token timeout (${MODEL_INTER_TOKEN_TIMEOUT_MS / 1000}s) on model=${actualModelUsed} — cancelling reader`);
            cancelReader("Inter-token timeout").catch(() => {});
          },
        );
        const markSemanticProgress = () => {
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            clearTimeout(firstTokenTimer);
            streamIdleWatchdog.start();
          } else {
            streamIdleWatchdog.touch();
          }
        };
        const turnDeadlineTimer = setTimeout(() => {
          if (!streamAbort.signal.aborted) {
            turnDeadlineExceeded = true;
            cancelReader("Turn deadline exceeded").catch(() => {});
          }
        }, Math.max(0, turnDeadlineAt - Date.now()));
        let activeToolCalls: any[] = [];
        const holdVisibleText = !forceFinalAnswerOnly
          && ((requiresVerifiedWebSearch && !verifiedWebSearchDone)
            || (requiresLocalToolUse && toolExecutionCount === 0));
        const emitVisibleText = async (text: string) => {
          if (!text) return;
          await textPipe.push(text);
        };
        const completeReasoning = async () => {
          await textPipe.finish();
        };

        try {
          while (true) {
            if (streamAbort.signal.aborted) {
              await emitCancelled();
            }
            const readResult = await reader.read();
            const { done, value } = readResult;
            // P0-B (2026-07-02): the first-token watchdog sets the flag
            // (and calls `reader.cancel()`) without touching `streamAbort`.
            // Check it here, after the cancelled `reader.read()` has
            // resolved, and surface the timeout as a structured error
            // instead of silently dropping the turn.
            const stopReason = resolveReadStopReason({
              firstTokenTimedOut: firstTokenTimeoutFired,
              streamIdleTimedOut: streamIdleTimeoutFired,
              turnDeadlineExceeded,
              signal: streamAbort.signal,
            });
            if (stopReason === "first_token_timeout") {
              throw new FirstTokenTimeoutError(modelName, "agent_loop", firstTokenMs);
            }
            if (stopReason === "stream_idle_timeout") {
              throw new StreamIdleTimeoutError(actualModelUsed, "agent_loop", MODEL_INTER_TOKEN_TIMEOUT_MS);
            }
            if (stopReason === "turn_cancelled") await emitCancelled();
            if (stopReason === "turn_deadline_exceeded") {
              throw new TurnDeadlineExceededError("agent_loop", TOTAL_TURN_TIMEOUT_MS);
            }
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
                const json = JSON.parse(payload);

                // Parse streaming tool calls
                const toolCalls = json.choices?.[0]?.delta?.tool_calls;
                if (toolCalls && toolCalls.length > 0) {
                  markSemanticProgress();
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
                    markSemanticProgress();
                    turnText += content;
                    fullText += content;
                    if (!holdVisibleText) await emitVisibleText(content);
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
          clearTimeout(firstTokenTimer);
          clearTimeout(turnDeadlineTimer);
          streamIdleWatchdog.stop();
          cleanupReaderAbort();
          cleanupRequestAbort();
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
        if (holdVisibleText && validCalls.length === 0 && runnableTextCalls.length === 0 && !shouldForceWebSearch && !shouldForceLocalInspection) {
          await emitVisibleText(textExtraction.cleanedText);
        }
        await completeReasoning();

        // Record per-turn inference for resilience observability (per-backend retry/fallback telemetry)
        const _cfgTurn = resolveConfig(options.config);
        recordInference({
          ts: Date.now(),
          // Attribute the turn to the actual provider the cascade engaged, not
          // the user's `cfg.active_backend`. The cascade can route through
          // opencode_zen / opencode_go (cross-provider fallback) and without
          // this all non-openrouter turns would be silently bucketed as
          // "openrouter" in `/health/inference`.
          backend: backendForProvider(lastProviderUsed, _cfgTurn.active_backend),
          model: lastFallbackModel ?? (lastActualModelUsed !== undefined ? lastActualModelUsed : (_cfgTurn.active_backend === "openrouter"
            ? (_cfgTurn.openrouter.model ?? "openrouter/free")
            : _cfgTurn.active_backend === "claude_cli"
              ? (_cfgTurn.claude_cli.model ?? "claude_cli")
              : _cfgTurn.ollama.model)),
          ok: true,
          latency_ms: Date.now() - _turnStart,
          tokens_in: sessionCostInfo?.prompt_tokens ?? 0,
          tokens_out: sessionCostInfo?.completion_tokens ?? 0,
          fallback_used: lastFallbackRetries > 0,
          retry_count: lastFallbackRetries,
          fallback_model: lastFallbackModel,
        });

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
              await session.finish(toolOutput);
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

          // Retry once if the model returned empty content — covers both
          // the tool-execution case (tools ran but no final answer) and
          // the no-tool case (model returned nothing at all). Some
          // providers/models transiently return empty on the first attempt
          // due to rate-limiting, timing, or model-specific edge cases.
          if (resultText.trim().length === 0 && !emptyFinalAnswerRetryDone) {
            fullText = fullTextBeforeTurn;
            const retryPrompt = toolExecutionCount > 0
              ? "Tool use is complete. Do not call tools or emit <tool_call> blocks. Write the final visible answer now using the tool results already provided. If the requested app or file is not present, say that plainly. Do not emit hidden reasoning tags."
              : "Your previous response was empty. Write a final answer now. Do not call tools or emit <tool_call> blocks. If you have no specific result to report, tell the user what you found or why you couldn't complete the request.";
            currentPrompt = [currentPrompt, retryPrompt].filter(Boolean).join("\n\n");
            emptyFinalAnswerRetryDone = true;
            forceFinalAnswerOnly = true;
            useTextToolProtocol = false;
            prevToolCallCount = 0;
            console.warn(`[Jarvis] Empty response retry session=${sessionId} after ${toolExecutionCount} tool execution(s)`);
            continue;
          }

          if (resultText.trim().length === 0) {
            // Both the initial attempt and the retry returned empty — surface
            // a fallback so the user sees something instead of a blank bubble.
            resultText = toolExecutionCount > 0
              ? "I completed tool inspection, but the model returned no visible final answer after a final-answer-only retry. The streamed tool results above are preserved for review."
              : "The model returned no content. This can happen due to transient model issues, provider timeouts, or empty completions on the free tier. Please try sending your message again.";
          }

          if (sessionCostInfo) {
            logOpenRouterCost(sessionCostInfo);
            await writer.write(encoder.encode(`data: ${JSON.stringify({ type: "cost_info", ...sessionCostInfo, session_id: sessionId })}\n\n`));
          }
          await session.finish(resultText);
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
            const preparedToolResult = prepareToolResultForContext(toolOutput, MAX_TOOL_RESULT_CHARS);
            toolExecutionCount++;
            if (tc.function.name === "web_search") verifiedWebSearchDone = true;

            // Stream tool result event to client
            await writer.write(encoder.encode(`data: ${JSON.stringify({
              type: "tool_result",
              call_id: tc.id,
              name: tc.function.name,
              output: toolOutput,
              is_error: toolResult.is_error,
              context_truncation: preparedToolResult.metadata.truncated
                ? preparedToolResult.metadata
                : undefined,
              session_id: sessionId
            })}\n\n`));

            // Add tool response to history (truncated to protect context)
            activeHistory.push({
              role: "tool",
              tool_call_id: tc.id,
              content: preparedToolResult.context
            });

            // If the user was asked a question, stop the loop and wait for their response.
            if (tc.function.name === "ask_user_question") {
              await session.finish("Waiting for user response to question.");
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

    } catch (error: any) {
      if (error?.name === "StreamCancelledError") {
        return;
      }
      const errMsg = error?.message || String(error);
      // P0-B (2026-07-02): a first-token timeout is a HUNG MODEL, not a
      // user cancellation. The watchdog (orchestrator + Agent Loop) no
      // longer touches `streamAbort`, so we are guaranteed to land here
      // for a timeout — surface it as a structured `error` frame with
      // `code: "first_token_timeout"` so the UI can show a real "model
      // timed out" message (or attempt a retry / switch backend) instead
      // of dropping the frame and finalizing an empty assistant bubble.
      // `cancelled` is reserved for genuine user / `/chat/cancel` aborts
      // (handled by `StreamCancelledError` above).
      const isFirstTokenTimeout = error?.name === "FirstTokenTimeoutError";
      const isStreamIdleTimeout = error?.name === "StreamIdleTimeoutError";
      const isVisibleProgressTimeout = error?.name === "VisibleProgressTimeoutError";
      const isTurnDeadlineExceeded = error?.name === "TurnDeadlineExceededError";
      const errorCode = isFirstTokenTimeout
        ? "first_token_timeout"
        : isStreamIdleTimeout
          ? "stream_idle_timeout"
          : isVisibleProgressTimeout
            ? "visible_progress_timeout"
            : isTurnDeadlineExceeded
              ? "turn_deadline_exceeded"
          : undefined;
      const userFacingMsg = isFirstTokenTimeout
        ? `The model did not produce any output within the per-model first-token window. ` +
          `This usually means the model is loading, overloaded, or the configured backend is unreachable. ` +
          `Try again, or switch backend in Settings. (${error?.model ?? "unknown model"}, stage=${error?.stage ?? "unknown"}, window=${error?.windowMs ?? "?"}ms)`
        : isStreamIdleTimeout
          ? `The model stopped producing semantic output during the stream. ` +
            `Jarvis ended the stalled attempt instead of waiting indefinitely. ` +
            `Try again, or switch backend in Settings. (${error?.model ?? "unknown model"}, stage=${error?.stage ?? "unknown"}, window=${error?.windowMs ?? "?"}ms)`
        : isVisibleProgressTimeout
          ? `The model kept producing hidden reasoning but made no visible answer or tool-call progress. ` +
            `Jarvis stopped the stalled stage instead of waiting indefinitely. ` +
            `Try again, or switch backend in Settings. (${error?.model ?? "unknown model"}, stage=${error?.stage ?? "unknown"}, window=${error?.windowMs ?? "?"}ms)`
        : isTurnDeadlineExceeded
          ? `The total server turn deadline expired before Jarvis finished. ` +
            `The turn was stopped cleanly instead of stalling indefinitely. ` +
            `(stage=${error?.stage ?? "unknown"}, budget=${error?.budgetMs ?? TOTAL_TURN_TIMEOUT_MS}ms)`
        : errMsg;
      console.error(`[Jarvis] Stream error session=${sessionId} code=${errorCode ?? "<generic>"}:`, userFacingMsg);
      const _cfg3 = resolveConfig(options.config);
      recordInference({
        ts: Date.now(),
        // Attribute the error to the actual provider the cascade engaged, not
        // the user's `cfg.active_backend`. The cascade can route through
        // opencode_zen / opencode_go and without this every cross-provider
        // failure would be silently mis-bucketed as "openrouter".
        backend: backendForProvider(lastProviderUsed, _cfg3.active_backend),
        model: lastFallbackModel ?? (lastActualModelUsed !== undefined ? lastActualModelUsed : _cfg3.active_backend === "openrouter"
          ? (_cfg3.openrouter.model ?? "openrouter/free")
          : _cfg3.active_backend === "claude_cli"
            ? (_cfg3.claude_cli.model ?? "claude_cli")
            : _cfg3.ollama.model),
        ok: false,
        latency_ms: Date.now() - _turnStart,
        tokens_in: sessionCostInfo?.prompt_tokens ?? 0,
        tokens_out: sessionCostInfo?.completion_tokens ?? 0,
        error: userFacingMsg.slice(0, 200),
        fallback_used: lastFallbackRetries > 0,
        retry_count: lastFallbackRetries,
        fallback_model: lastFallbackModel,
      });
      try {
        await session.error(userFacingMsg, errorCode);
      } catch {}
    } finally {
      stopHeartbeat();
      streamLease.release();
      try {
        await session.ensureTerminal();
      } catch {}
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
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
    active_sessions: activeStreams.size,
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
      let model = hcfg.active_backend === "openrouter" ? hcfg.openrouter.model : hcfg.ollama.model;
      let configured_model: string | undefined;
      if (hcfg.active_backend === "ollama") {
        configured_model = hcfg.ollama.model;
        try {
          model = (await resolveOllamaChatTarget(hcfg)).modelName;
        } catch {
          model = hcfg.ollama.model;
        }
      }
      return Response.json({
        ok: true,
        uptime: process.uptime(),
        version: JARVIS_VERSION,
        backend: hcfg.active_backend,
        model,
        configured_model,
        model_resolved: configured_model ? equivalentOllamaModelName(model, configured_model) : true,
        git_sha: JARVIS_GIT_SHA,
        built_at: JARVIS_BUILT_AT,
      });
    }
    if (path === "/health/inference") {
      return Response.json(inferenceMetricsSnapshot());
    }
    if (path === "/performance/runtime" && req.method === "GET") {
      return Response.json(runtimePerformanceMonitor
        ? { enabled: true, snapshot: runtimePerformanceMonitor.snapshot({ reset: false }) }
        : { enabled: false });
    }
    if (path === "/health/conductor-cache") {
      return Response.json(conductorCacheSnapshot());
    }
    if (path === "/skills/candidates" && req.method === "GET") {
      const status = new URL(req.url).searchParams.get("status") as "candidate" | "promoted" | "rejected" | null;
      return Response.json({ candidates: listSkillCandidates(status ?? undefined) });
    }
    if (path === "/skills/promote" && req.method === "POST") {
      const cfg = loadConfig();
      const result = runSkillPromotionPass(cfg.orchestrator.skill_distillation);
      return Response.json({
        ok: true,
        promoted: result.promoted,
        rejected: result.rejected,
        total_evaluated: result.total_evaluated,
      });
    }

    // Per-candidate lifecycle (D5a): judge-gated promote/reject/demote/eval
    // for a single distilled skill candidate, plus its performance-since-
    // promotion panel data. Distinct from the bulk /skills/promote above,
    // which stays heuristic-only.
    const candidateEvalMatch = path.match(/^\/skills\/candidates\/([^/]+)\/eval$/);
    if (candidateEvalMatch && req.method === "POST") {
      const id = decodeURIComponent(candidateEvalMatch[1]);
      const candidate = loadSkillCandidate(id);
      if (!candidate) return Response.json({ error: "candidate_not_found" }, { status: 404 });
      const cfg = loadConfig();
      const grounding = await runGroundingJudge(candidate, makeCallModel(cfg, "orchestrator"));
      if (!grounding.ok) {
        if (grounding.error === "no_grounding_source") {
          return Response.json({ error: "judge_unavailable", detail: "no grounding source available" }, { status: 503 });
        }
        return Response.json({ error: "judge_unavailable", detail: grounding.detail }, { status: 503 });
      }
      const updated = updateSkillCandidateEval(id, grounding.verdict.score, grounding.verdict.missed);
      return Response.json({ id, status: updated?.status ?? candidate.status, verdict: grounding.verdict });
    }

    const candidatePromoteMatch = path.match(/^\/skills\/candidates\/([^/]+)\/promote$/);
    if (candidatePromoteMatch && req.method === "POST") {
      const id = decodeURIComponent(candidatePromoteMatch[1]);
      const cfg = loadConfig();
      const result = await promoteSkillCandidate(id, makeCallModel(cfg, "orchestrator"), cfg.orchestrator.skill_distillation);
      if (!result.ok) {
        const status = result.error === "candidate_not_found" ? 404 : result.error === "wrong_status" ? 409 : 503;
        return Response.json({ error: result.error, detail: result.detail }, { status });
      }
      return Response.json({
        id,
        status: result.candidate?.status,
        eval_score: result.candidate?.eval_score,
        promoted_at: result.candidate?.promoted_at,
        rejection_reason: result.candidate?.rejection_reason,
        rejection_detail: result.candidate?.rejection_detail,
      });
    }

    const candidateRejectMatch = path.match(/^\/skills\/candidates\/([^/]+)\/reject$/);
    if (candidateRejectMatch && req.method === "POST") {
      const id = decodeURIComponent(candidateRejectMatch[1]);
      const candidate = loadSkillCandidate(id);
      if (!candidate) return Response.json({ error: "candidate_not_found" }, { status: 404 });
      if (candidate.status !== "candidate") {
        return Response.json({ error: "wrong_status", detail: `status is ${candidate.status}` }, { status: 409 });
      }
      const body = await req.json().catch(() => ({}));
      const updated = updateSkillCandidateStatus(id, "rejected", undefined, "manual", body?.reason);
      return Response.json({ id, status: updated?.status ?? "rejected", rejection_reason: "manual" });
    }

    const candidateDemoteMatch = path.match(/^\/skills\/candidates\/([^/]+)\/demote$/);
    if (candidateDemoteMatch && req.method === "POST") {
      const id = decodeURIComponent(candidateDemoteMatch[1]);
      const candidate = loadSkillCandidate(id);
      if (!candidate) return Response.json({ error: "candidate_not_found" }, { status: 404 });
      if (candidate.status !== "promoted") {
        return Response.json({ error: "wrong_status", detail: `status is ${candidate.status}` }, { status: 409 });
      }
      const updated = updateSkillCandidateStatus(id, "candidate");
      return Response.json({ id, status: updated?.status ?? "candidate" });
    }

    const candidatePerformanceMatch = path.match(/^\/skills\/candidates\/([^/]+)\/performance$/);
    if (candidatePerformanceMatch && req.method === "GET") {
      const id = decodeURIComponent(candidatePerformanceMatch[1]);
      const candidate = loadSkillCandidate(id);
      if (!candidate) return Response.json({ error: "candidate_not_found" }, { status: 404 });
      if (candidate.status !== "promoted") {
        return Response.json({ error: "wrong_status", detail: `status is ${candidate.status}` }, { status: 409 });
      }
      const store = new SelfTuningStore();
      const perf = computeCandidatePerformance(candidate, (taskTypes, start, end) =>
        store.getAgentRunsForTaskTypesInWindow(taskTypes, start, end),
      );
      return Response.json(perf);
    }
    if (path === "/agents/pool" && req.method === "GET") {
      const poolCfg = loadConfig();
      const pool = new AgentPool(poolCfg.orchestrator?.agents ?? []);
      return Response.json({ pool: pool.list(), coverage: pool.coverage(), max_recursion_depth: poolCfg.orchestrator?.max_recursion_depth ?? 2 });
    }
    if (path === "/tool/decision" && req.method === "POST") {
      const { call_id, approved } = await req.json() as { call_id: string; approved: boolean };
      const resolved = approvalRegistry.resolve(call_id, Boolean(approved));
      return Response.json({ ok: resolved, call_id });
    }
    if (path === "/config" && req.method === "GET") return Response.json(loadConfig());
    if (path === "/config" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      // P1-N: validate before write. A partial config that omits the
      // active backend's required fields (e.g. a blanked openrouter.api_key)
      // is rejected with a structured 400 so the Control Center can surface
      // the error rather than silently persisting a config that breaks
      // chat on the next turn.
      try {
        const { config, validation } = saveConfigWithValidation(body);
        return Response.json({ ok: true, config, validation });
      } catch (err) {
        if (err instanceof InvalidConfigError) {
          console.warn(`[Jarvis] Rejected invalid config save: ${err.validation.errors.join("; ")}`);
          return Response.json(
            { ok: false, error: err.message, validation: err.validation },
            { status: 400 },
          );
        }
        throw err;
      }
    }
    if (path === "/cron/run" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const result = await runCronInference(body as Record<string, unknown>);
      return Response.json(result);
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
      if (activeStreams.cancel(sid)) {
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
      persistentConductor.clearSession(sid);
      sessionMemory.clearSession(sid);
      continuationRequirements.delete(sid);
      workspaceAffinity.clear(sid);
      // B-04: reset the per-session replan counter so a user-initiated
      // "new session" frees up the replan budget. Without this, a fresh
      // session inheriting the same id would inherit a depleted counter.
      replanCounter.clearSession(sid);
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
  // Disable Bun's idle-connection timeout (default 10s). Chat is a long-lived
  // SSE stream: during a single model call the server sends no frames, and a
  // slow local/free model can idle well past 10s — Bun would close the socket
  // mid-turn and the user would see a silent stall. Bun's max finite idleTimeout
  // is 255s, which is still under MODEL_REQUEST_TIMEOUT_MS (300s), so the only
  // safe choice is to disable it here and rely on the per-request abort timeout
  // (300s) and the Rust relay's own 900s ceiling to bound a genuinely hung turn.
  idleTimeout: 0,
  fetch: baseFetch,
});

console.log(`[Jarvis API] Listening on http://localhost:${PORT}`);
