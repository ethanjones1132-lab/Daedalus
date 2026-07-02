// ═══════════════════════════════════════════════════════════════
// ── Jarvis Unified Configuration ──
// ═══════════════════════════════════════════════════════════════
// Single source of truth for all Jarvis settings.
// Loaded by both the Bun HTTP server and the Rust backend.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { DEFAULT_ORCHESTRATOR_AGENTS, type OrchestratorAgent } from "./orchestration/agent-pool";

// ── Types ──

export type BackendType = 'ollama' | 'openrouter' | 'claude_cli';

export type SurfaceType = 'chat' | 'tool' | 'cron' | 'agent' | 'compaction';

export interface SurfaceTemperatures {
  chat: number;
  tool: number;
  cron: number;
  agent: number;
  compaction: number;
}

export interface ModelProfile {
  name: string;
  model_id: string;
  context_window: number;
  batch_size: number;
  gpu_layers: number;
  num_threads: number;
  temperature: number;
  top_p: number;
  description: string;
}

export interface CompactionConfigV2 {
  model: string;
  ollama_url: string;
  max_tokens: number;
  auto_compact_threshold: number;
  enabled: boolean;
}

export interface OllamaConfig {
  base_url: string;
  /** Model identifier, e.g. "qwen3.5-9b:latest" */
  model: string;
  /** Automatically pull the model if not present */
  auto_pull: boolean;
  /** Health check interval in ms */
  health_check_interval_ms: number;
  /** Extra Ollama-specific options */
  options: {
    num_ctx: number;
    num_gpu: number;
    num_thread: number;
    num_batch?: number;
  };
}

export interface OpenRouterConfig {
  base_url: string;
  api_key: string;
  model: string;
  site_url: string;
  site_name: string;
  /** Preferred fallback models in order */
  fallbacks: string[];
  /** Whether to auto-retry with fallback models on 429/503 */
  enable_fallbacks: boolean;
  /** Whether free-tier OpenRouter requests may fall back to paid models */
  enable_paid_fallbacks: boolean;
  /** Max retry attempts per model before falling back */
  max_retries: number;
  /** Request timeout in milliseconds */
  timeout_ms: number;
}

/**
 * OpenAI-compatible secondary provider (OpenCode Zen / OpenCode Go).
 * These route through their own base_url + api_key — NOT OpenRouter's — but
 * speak the same `/chat/completions` SSE protocol, so the existing stream
 * parser and request builder work unchanged. The orchestrator agent pool
 * references them by `provider: "opencode_zen" | "opencode_go"`; the fallback
 * cascade resolves the right endpoint per attempt via `resolveProviderTarget`.
 */
export interface OpenCodeProviderConfig {
  base_url: string;
  api_key: string;
}

export interface ClaudeCliConfig {
  enabled: boolean;
  /** Path to the `claude` binary */
  path: string;
  args: string[];
  timeout_ms: number;
  /** Working directory for Claude CLI sessions */
  cwd: string;
  /** Model id the Claude-CLI engine drives the proxy with (set per active profile). */
  model?: string;
}

export interface ToolConfig {
  enabled: boolean;
  /** Tools that require user approval before execution */
  require_approval: string[];
  /** Sandbox mode: 'strict' | 'permissive' | 'off' */
  sandbox_mode: 'strict' | 'permissive' | 'off';
  /**
   * When true, tools whose policy resolves to "ask" in the interactive chat
   * surface block on a real user approve/reject round-trip (a `tool_approval`
   * event + `/tool/decision` response). When false (default), "ask" falls
   * through to legacy passthrough so chat writes are not gated.
   */
  interactive_approval: boolean;
}

export interface ReasoningConfig {
  enabled: boolean;
  /** Show reasoning traces by default */
  show_trace_by_default: boolean;
  /** Max tokens for reasoning */
  max_tokens: number;
}

export interface CompanionConfig {
  enabled: boolean;
  name: string;
  species: string;
  rarity: string;
}

/**
 * Local persistent Conductor (Phase 1) — Fugu-style coordinator that runs as a
 * warm Ollama process with per-session message/KV state instead of a cold API
 * call each turn.
 */
export type ConductorOutputMode = "tool_call" | "json_schema" | "prompt";

export interface ConductorConfig {
  /** When true, coordinator routing uses the local Ollama conductor model. */
  enabled: boolean;
  /** Primary local conductor model (Gemma 4 E2B recommended). */
  model: string;
  /** Secondary local model when the primary is not installed (Gemma 4 E4B). */
  fallback_model: string;
  /** Override Ollama base URL; blank inherits `ollama.base_url`. */
  base_url: string;
  /**
   * How routing JSON is emitted. Gemma 4 supports native `tool_call` and
   * `json_schema`; `prompt` is the legacy prompt-only path.
   */
  output_mode: ConductorOutputMode;
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens: number;
  /** Context window budget for the warm conductor prefix (Gemma 4 supports 128K). */
  num_ctx: number;
  /** Fall back to the API coordinator pool when local inference fails. */
  fallback_to_api: boolean;
  /** Prune in-memory sessions inactive longer than this (ms). */
  session_ttl_ms: number;
  /** Max coordinator turn pairs kept in the hot prefix before pruning oldest. */
  max_turns_in_cache: number;
  /** Persist session message state to disk for restart recovery. */
  persist_sessions: boolean;
  /**
   * Persist conductor KV/session metadata alongside message history.
   *
   * When true, `PersistentConductor` writes one JSON file per session to disk
   * so the warm Ollama conductor can resume on Bun restart. The on-disk layout
   * is:
   *
   *     <SESSIONS_DIR>/conductor/<sanitized-sessionId>.json
   *
   * where `SESSIONS_DIR` is the `sessions_dir` config (default
   * `~/.openclaw/jarvis/sessions/`). The filename sanitization replaces any
   * non-`[a-zA-Z0-9._-]` characters with `_` (see `sessionFilePath` in
   * `persistent-conductor.ts`).
   *
   * Each file is the full `ConductorSessionState` serialized via `JSON.stringify`
   * (no envelope):
   *
   *   {
   *     "sessionId":          string,
   *     "turns":              number,
   *     "lastOutcome?":       string,
   *     "messages":           ConductorMessage[],   // system + user/assistant pairs
   *     "lastActiveAt":       number,              // unix ms
   *     "kvGeneration?":      number,              // Track A — prefix-reuse counter
   *     "systemPromptHash?":  string,              // hex, for cache-hit detection
   *     "cachedPrefixTokens?":number,              // last turn's reusable prefix estimate
   *     "lastModel?":         string,              // last model that answered for this session
   *     "apiFallbackUsed?":   boolean              // next local turn rebuilds prefix
   *   }
   *
   * Pruning is governed by `session_ttl_ms`: disk files older than the TTL are
   * removed on `pruneExpiredDiskSessions()` (called on each `routeTurn` when
   * the flag is on). The in-memory cache size is bounded by
   * `PersistentConductor.MAX_SESSIONS = 256` (oldest first, see
   * `touchSession`).
   */
  kv_persist: boolean;
  /** KV backend implementation (Ollama message-prefix reuse today). */
  kv_backend: "ollama";
}

/** Skill distillation from successful orchestrator trajectories (Track C). */
export interface SkillDistillationConfig {
  enabled: boolean;
  /** Minimum extractor confidence before writing a candidate. */
  min_confidence: number;
  /** Eval score delta required for auto-promotion (0–1). */
  promotion_eval_delta: number;
  /** Max distilled skill candidates retained on disk. */
  max_candidates: number;
  /** Which run outcomes trigger distillation. Default ["success"]; extend to ["success","degraded"] for replan-rescued runs with clean synthesizer. */
  distill_on?: ("success" | "degraded" | "failed")[];
  /** Minimum judge score (0-1) required to pass the semantic grounding gate on promotion. */
  min_judge_score?: number;
  /** When false (default), the post-distill hook only runs the heuristic screen — candidates that
   *  clear the 6 heuristic gates stay in "candidate" status awaiting an explicit operator promote
   *  call (which adds the judge gate). When true, restores full automatic promotion including the
   *  judge gate, same call site as before this flag existed. */
  auto_promote?: boolean;
}

/** Inter-workflow shared memory for tool results, file snapshots, and failures. */
export interface SessionMemoryConfig {
  enabled: boolean;
  tool_result_ttl_ms: number;
  max_tool_results: number;
  max_file_snapshots: number;
  max_failure_patterns: number;
  session_ttl_ms: number;
  persist: boolean;
}

/**
 * Phase 4 learning loop — observational telemetry, heuristic pool tuning,
 * instruction A/B, and trajectory export for future GRPO training.
 */
export interface ConductorLearningConfig {
  enabled: boolean;
  /** Minimum samples before capability / fallback heuristics apply. */
  min_samples_for_heuristics: number;
  /** Per-optimization capability delta magnitude (0–0.1). */
  capability_adjustment_step: number;
  /** Persist multi-turn conductor + pipeline trajectories for GRPO export. */
  trajectory_export: boolean;
  /** Epsilon-greedy exploration rate for worker-instruction A/B. */
  instruction_ab_epsilon: number;
  /** Max trajectories retained (oldest pruned). */
  max_trajectory_snapshots: number;
}

export interface OrchestratorConfig {
  enabled: boolean;
  agents: OrchestratorAgent[];
  max_recursion_depth: number;
  /** B-02: bound on how many times a single turn may re-invoke the conductor
   *  via `conductor_replan` before the replan loop just runs the remaining
   *  normalized pipeline to completion. Prevents an unbounded replan loop. */
  max_conductor_replans: number;
  conductor: ConductorConfig;
  session_memory: SessionMemoryConfig;
  conductor_learning: ConductorLearningConfig;
  skill_distillation: SkillDistillationConfig;
}

export interface JarvisConfig {
  version: string;
  active_backend: BackendType;
  ollama: OllamaConfig;
  openrouter: OpenRouterConfig;
  /** OpenCode Zen — OpenAI-compatible secondary provider for pool agents. */
  opencode_zen: OpenCodeProviderConfig;
  /** OpenCode Go — OpenAI-compatible secondary provider for pool agents. */
  opencode_go: OpenCodeProviderConfig;
  claude_cli: ClaudeCliConfig;
  tools: ToolConfig;
  reasoning: ReasoningConfig;
  companion: CompanionConfig;
  orchestrator: OrchestratorConfig;
  /** Global system prompt override */
  system_prompt: string;
  mode: string;
  prizepicks_prompt: string;
  /** Temperature for chat completions */
  temperature: number;
  /** Per-surface temperature overrides (ADR 0002 Layer 1) */
  surface_temperatures: SurfaceTemperatures;
  max_tokens: number;
  top_p: number;
  /** Top-K sampling: limit next-token choices to the K most likely (ADR 0002 Layer 1). */
  top_k: number;
  /** Bridge TCP port for agent connections */
  bridge_port: number;
  bridge_enabled: boolean;
  /** Jarvis workspace path */
  jarvis_path: string;
  compaction: CompactionConfigV2;
  profiles: Record<string, ModelProfile>;
  active_profile: string;
  api_sports_key: string;
  /** Filesystem root for agent discovery. Default: ~/.openclaw/jarvis/agents/ */
  agents_root: string;
}

function getWindowsHome(): string | null {
  try {
    const raw = execSync("cmd.exe /c \"echo %USERPROFILE%\"", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = raw.trim();
    if (trimmed && trimmed.match(/^[a-zA-Z]:\\/)) {
      const drive = trimmed[0].toLowerCase();
      const path = trimmed.slice(2).replace(/\\/g, "/");
      return `/mnt/${drive}${path}`;
    }
  } catch (e) {
    // Fail silently
  }
  return null;
}

function locateConfigDir(): string {
  const winHome = getWindowsHome();
  if (winHome) {
    const winDir = join(winHome, ".openclaw", "jarvis");
    if (existsSync(winDir) && existsSync(join(winDir, "config.json"))) {
      return winDir;
    }
  }
  return join(homedir(), ".openclaw", "jarvis");
}

export const CONFIG_DIR = locateConfigDir();
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
export const COMPANION_FILE = join(CONFIG_DIR, "companion.json");
export const LOGS_DIR = join(CONFIG_DIR, "logs");

// ── Defaults ──

export function defaultConfig(): JarvisConfig {
  return {
    version: "3.0.0",
    active_backend: "ollama",
    ollama: {
      base_url: "http://localhost:11434/v1",
      model: "qwen3.5-9b:latest",
      auto_pull: true,
      health_check_interval_ms: 30000,
      options: {
        num_ctx: 8192,
        num_gpu: 31,
        num_thread: 8,
        num_batch: 256,
      },
    },
    openrouter: {
      base_url: "https://openrouter.ai/api/v1",
      api_key: "",
      model: "qwen/qwen3-coder:free",
      site_url: "http://localhost:19877",
      site_name: "Jarvis Home-Base",
      fallbacks: [
        "openrouter/free",
        "openrouter/owl-alpha",
        "qwen/qwen3-coder:free",
        "cohere/north-mini-code:free",
        "nvidia/llama-3.1-nemotron-ultra-253b-v1:free",
      ],
      enable_fallbacks: true,
      enable_paid_fallbacks: false,
      max_retries: 3,
      timeout_ms: 60000,
    },
    // Secondary OpenAI-compatible providers. Keys are intentionally blank in
    // source (no secrets committed) — they are written to the live config.json
    // store. base_url defaults match the OpenCode Zen/Go endpoints.
    opencode_zen: {
      base_url: "https://opencode.ai/zen/v1",
      api_key: "",
    },
    opencode_go: {
      base_url: "https://opencode.ai/zen/go/v1",
      api_key: "",
    },
    claude_cli: {
      enabled: true,
      path: "claude",
      args: ["--bare", "--print", "--output-format", "stream-json", "--no-telemetry"],
      timeout_ms: 120000,
      cwd: homedir(),
      model: "",
    },
    tools: {
      enabled: true,
      require_approval: [
        "Write",
        "Edit",
        "Bash",
        "MultiEdit",
        "write_file",
        "edit_file",
        "multi_edit",
        "bash",
        "powershell",
        "mcp_call_tool",
        "agent",
        "task_create",
        "task_stop",
      ],
      sandbox_mode: "strict",
      interactive_approval: false,
    },
    reasoning: {
      enabled: true,
      show_trace_by_default: false,
      max_tokens: 2048,
    },
    companion: {
      enabled: true,
      name: "Nyx",
      species: "cat",
      rarity: "rare",
    },
    orchestrator: {
      enabled: true,
      agents: DEFAULT_ORCHESTRATOR_AGENTS,
      max_recursion_depth: 2,
      max_conductor_replans: 2,
      conductor: {
        enabled: true,
        model: "gemma4:e2b",
        fallback_model: "gemma4:e4b",
        base_url: "",
        output_mode: "tool_call",
        temperature: 1.0,
        top_p: 0.95,
        top_k: 64,
        max_tokens: 700,
        num_ctx: 8192,
        fallback_to_api: true,
        session_ttl_ms: 30 * 60 * 1000,
        max_turns_in_cache: 12,
        persist_sessions: true,
        kv_persist: true,
        kv_backend: "ollama",
      },
      session_memory: {
        enabled: true,
        tool_result_ttl_ms: 30 * 60 * 1000,
        max_tool_results: 128,
        max_file_snapshots: 64,
        max_failure_patterns: 32,
        session_ttl_ms: 30 * 60 * 1000,
        persist: true,
      },
      conductor_learning: {
        enabled: true,
        min_samples_for_heuristics: 5,
        capability_adjustment_step: 0.03,
        trajectory_export: true,
        instruction_ab_epsilon: 0.15,
        max_trajectory_snapshots: 500,
      },
      skill_distillation: {
        enabled: true,
        min_confidence: 0.55,
        promotion_eval_delta: 0.02,
        max_candidates: 200,
        distill_on: ["success"],
        min_judge_score: 0.75,
        auto_promote: false,
      },
    },
    system_prompt: `You are Jarvis, a local AI coding assistant running on Qwen 3.5 9B in WSL2.
Workspace: \`/home/ethan/.openclaw/agents/coderclaw/workspace/home-base\`.

## Tool Protocol (No native tool support. Always emit this format for file/shell/web operations):
<tool_call>{"name":"TOOL_NAME","arguments":{"key":"val"}}</tool_call>

Tools: read_file, write_file, edit_file, multi_edit, list_directory, glob, grep, bash, web_fetch, web_search.
- Emit a tool block IMMEDIATELY when required. Never fabricate outcomes. Retry on failure.

## Reasoning & Tag Parsing
- Place all thinking inside a single, unnested \`<think>...</think>\` block.
- Always write your direct response immediately after \`</think>\`. Never end a turn inside a think block.
- Be extremely concise. Avoid conversational filler. Run tests to confirm output.

## Code Style & Safety
- Keep it simple, correct, and secure. Avoid premature abstractions.
- Do not add features, refactoring, comments, or type annotations unless requested.
- Do not run destructive commands without user confirmation.
`,
    mode: "chat",
    prizepicks_prompt: "You are the PrizePicks Monster — an expert NFL prediction engine with access to comprehensive 2025 season statistics. Analyze player prop questions using statistical data, matchups, recent form, and situational factors. Always provide structured JSON predictions with confidence scores, projections, and clear over or under recommendations.",
    temperature: 0.3,
    surface_temperatures: {
      chat: 0.3,
      tool: 0.1,
      cron: 0.2,
      agent: 0.2,
      compaction: 0.3,
    },
    max_tokens: 8192,
    top_p: 0.95,
    top_k: 40,
    bridge_port: 19876,
    bridge_enabled: true,
    jarvis_path: "",
    compaction: {
      model: "nemotron-mini:4b",
      ollama_url: "",
      max_tokens: 2048,
      auto_compact_threshold: 0.8,
      enabled: true,
    },
    profiles: {
      fast: {
        name: "fast",
        model_id: "qwen2.5-coder:7b",
        context_window: 4096,
        batch_size: 256,
        gpu_layers: 31,
        num_threads: 8,
        temperature: 0.3,
        top_p: 0.95,
        description: "Qwen2.5-Coder 7B: Fast responses for quick edits and simple queries",
      },
      quality: {
        name: "quality",
        model_id: "qwen3.5-9b",
        context_window: 8192,
        batch_size: 256,
        gpu_layers: 31,
        num_threads: 8,
        temperature: 0.3,
        top_p: 0.95,
        description: "Qwen3.5-9B: Best quality for complex reasoning and code architecture",
      },
      compaction: {
        name: "compaction",
        model_id: "nemotron-mini:4b",
        context_window: 4096,
        batch_size: 256,
        gpu_layers: 31,
        num_threads: 8,
        temperature: 0.3,
        top_p: 0.9,
        description: "Nemotron-Mini 4B: Lightweight model for context compaction and relevance scoring",
      },
    },
    active_profile: "quality",
    api_sports_key: "",
    agents_root: join(homedir(), ".openclaw", "jarvis", "agents"),
  };
}

export function normalizeConfig(raw: any): JarvisConfig {
  const merged = deepMerge(defaultConfig(), raw);
  // Ensure jarvis_path is always set — an empty string or missing value
  // must never cause the workspace to silently resolve to process.cwd()
  // (e.g. the Windows Desktop when spawned from Tauri via wsl.exe).
  if (!merged.jarvis_path || merged.jarvis_path.trim() === "") {
    merged.jarvis_path = join(homedir(), ".openclaw", "agents", "coderclaw", "workspace", "home-base");
  }
  return merged;
}

// ── Load / Save ──

let configCache: JarvisConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5 seconds

export function loadConfig(): JarvisConfig {
  const now = Date.now();
  if (configCache && (now - configCacheTime) < CONFIG_CACHE_TTL) {
    return configCache;
  }

  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      configCache = normalizeConfig(raw);
      configCacheTime = now;
      return configCache!;
    }
  } catch (e) {
    console.error("[Config] Load error, using defaults:", e);
  }

  return defaultConfig();
}

export function invalidateConfigCache(): void {
  configCache = null;
  configCacheTime = 0;
}

/** Merge partial updates into the on-disk config (canonical Bun write path). */
export function saveConfig(partial: Partial<JarvisConfig>): JarvisConfig {
  const current = loadConfig();
  const merged = normalizeConfig(deepMerge(current, partial));
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
  configCache = merged;
  configCacheTime = Date.now();
  return merged;
}

// ── Helpers ──

export function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    if (
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], sourceVal);
    } else {
      // A blank value in the saved config must never wipe out a meaningful
      // default. A persisted partial config such as
      //   {"openrouter":{"base_url":"","model":""}}
      // would otherwise leave the OpenRouter URL/model empty — streamJarvis
      // then builds `fetch("/chat/completions")` ("URL is invalid") and every
      // chat turn fails, which is exactly how chat looked "completely dead".
      // null/undefined are always non-overriding; an empty string only yields
      // to a *non-empty string* default (so clearing a field whose default is
      // already "" — e.g. api_key — still works).
      if (sourceVal === undefined || sourceVal === null) continue;
      if (sourceVal === "" && typeof target[key] === "string" && target[key] !== "") continue;
      result[key] = sourceVal;
    }
  }
  return result;
}

// ── Validation ──

export interface ConfigValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateConfig(cfg: JarvisConfig): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Backend validation
  if (cfg.active_backend === "ollama") {
    if (!cfg.ollama.model) errors.push("Ollama model is required");
    if (!cfg.ollama.base_url) errors.push("Ollama base URL is required");
  } else if (cfg.active_backend === "openrouter") {
    if (!cfg.openrouter.api_key || cfg.openrouter.api_key.length < 10) {
      errors.push("OpenRouter API key is required (min 10 chars)");
    }
    if (!cfg.openrouter.model) errors.push("OpenRouter model is required");
  } else if (cfg.active_backend === "claude_cli") {
    if (!cfg.claude_cli.path) errors.push("Claude CLI path is required");
  }

  // Parameter validation
  if (cfg.temperature < 0 || cfg.temperature > 2) {
    warnings.push("Temperature outside typical range (0-2)");
  }
  if (cfg.max_tokens < 1 || cfg.max_tokens > 131072) {
    warnings.push("max_tokens outside typical range (1-131072)");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function resolveAgentsRoot(cfg: JarvisConfig): string {
  const root = cfg.agents_root?.trim();
  if (!root) {
    return join(homedir(), ".openclaw", "jarvis", "agents");
  }
  return root;
}

export function surfaceTemperature(cfg: JarvisConfig, surface: SurfaceType): number {
  return cfg.surface_temperatures?.[surface] ?? cfg.temperature ?? 0.3;
}

export function validateAgentsRootPath(pathStr: string): { valid: boolean; error?: string; resolved_path: string } {
  const resolved = resolve(pathStr || "");
  
  if (!pathStr) {
    return { valid: false, error: "Path cannot be empty", resolved_path: resolved };
  }
  
  if (pathStr.includes("..")) {
    return { valid: false, error: "Path cannot contain directory traversal components (..)", resolved_path: resolved };
  }
  
  try {
    if (!existsSync(resolved)) {
      return { valid: false, error: "Path does not exist", resolved_path: resolved };
    }
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { valid: false, error: "Path is not a directory", resolved_path: resolved };
    }
    return { valid: true, resolved_path: resolved };
  } catch (e: any) {
    return { valid: false, error: e.message, resolved_path: resolved };
  }
}
