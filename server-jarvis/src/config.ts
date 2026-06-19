// ═══════════════════════════════════════════════════════════════
// ── Jarvis Unified Configuration ──
// ═══════════════════════════════════════════════════════════════
// Single source of truth for all Jarvis settings.
// Loaded by both the Bun HTTP server and the Rust backend.

import { readFileSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

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

export interface OrchestratorConfig {
  enabled: boolean;
}

export interface JarvisConfig {
  version: string;
  active_backend: BackendType;
  ollama: OllamaConfig;
  openrouter: OpenRouterConfig;
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
      model: "openrouter/free",
      site_url: "http://localhost:19877",
      site_name: "Jarvis Home-Base",
      fallbacks: [
        "openrouter/free",
        "openrouter/owl-alpha",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "qwen/qwen3-coder:free",
      ],
      enable_fallbacks: true,
      enable_paid_fallbacks: false,
      max_retries: 3,
      timeout_ms: 60000,
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

// ── Helpers ──

export function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
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
