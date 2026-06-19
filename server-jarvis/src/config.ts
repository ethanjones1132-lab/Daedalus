// ═══════════════════════════════════════════════════════════════
// ── Jarvis Server Configuration ──
// ═══════════════════════════════════════════════════════════════
// Single source of truth for Bun-server configuration: defaults, validation,
// load/save, and agents-root resolution.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export const CONFIG_DIR = join(homedir(), ".openclaw", "jarvis");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CONFIG_CACHE_TTL = 5000; // 5 seconds

let configCache: JarvisConfig | null = null;
let configCacheTime = 0;

// ── Type Contracts ────────────────────────────────────────────────────────────

export interface ReasoningConfig {
  enabled: boolean;
  strip_tags: string[];
}

export interface ToolConfig {
  enabled: boolean;
  sandbox_mode: "off" | "workspace" | "strict" | "permissive";
  require_approval: string[];
}

export interface OllamaConfig {
  base_url: string;
  model: string;
}

export interface OpenRouterConfig {
  base_url: string;
  model: string;
  api_key: string;
}

export interface ClaudeCliConfig {
  enabled: boolean;
  path: string;
  args: string[];
  cwd: string;
  timeout_ms: number;
}

export interface MemoryConfig {
  enabled: boolean;
}

export interface WebConfig {
  enabled: boolean;
}

export interface McpConfig {
  servers: Record<string, unknown>;
}

export interface BridgeConfig {
  enabled: boolean;
  port: number;
}

export interface JarvisConfig {
  agents_root: string;
  jarvis_path: string;
  active_backend: "ollama" | "openrouter" | string;
  ollama: OllamaConfig;
  openrouter: OpenRouterConfig;
  claude_cli: ClaudeCliConfig;
  tools: ToolConfig;
  temperature: number;
  max_tokens: number;
  top_k: number;
  memory: MemoryConfig;
  web: WebConfig;
  mcp: McpConfig;
  bridge: BridgeConfig;
  reasoning: ReasoningConfig;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export function defaultConfig(): JarvisConfig {
  return {
    agents_root: join(homedir(), ".openclaw", "jarvis", "agents"),
    jarvis_path: process.cwd(),
    active_backend: "ollama",
    ollama: {
      base_url: "http://localhost:11434/v1",
      model: "qwen3:8b",
    },
    openrouter: {
      base_url: "https://openrouter.ai/api/v1",
      model: "openrouter/free",
      api_key: "",
    },
    claude_cli: {
      enabled: false,
      path: "claude",
      args: ["--output-format", "stream-json"],
      cwd: process.cwd(),
      timeout_ms: 120000,
    },
    tools: {
      enabled: true,
      sandbox_mode: "workspace",
      require_approval: ["bash", "write_file", "edit_file", "multi_edit"],
    },
    temperature: 0.7,
    max_tokens: 4096,
    top_k: 40,
    memory: { enabled: true },
    web: { enabled: true },
    mcp: { servers: {} },
    bridge: { enabled: true, port: 19876 },
    reasoning: {
      enabled: true,
      strip_tags: ["think", "reasoning"],
    },
  };
}

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizeConfig(raw: Partial<JarvisConfig>): JarvisConfig {
  const defaults = defaultConfig();

  return {
    agents_root: typeof raw.agents_root === "string" ? raw.agents_root : defaults.agents_root,
    jarvis_path: typeof raw.jarvis_path === "string" && raw.jarvis_path.trim()
      ? raw.jarvis_path
      : defaults.jarvis_path,
    active_backend: typeof raw.active_backend === "string" ? raw.active_backend : defaults.active_backend,
    ollama: { ...defaults.ollama, ...raw.ollama },
    openrouter: { ...defaults.openrouter, ...raw.openrouter },
    claude_cli: { ...defaults.claude_cli, ...raw.claude_cli },
    tools: {
      enabled: raw.tools?.enabled ?? defaults.tools.enabled,
      sandbox_mode: raw.tools?.sandbox_mode ?? defaults.tools.sandbox_mode,
      require_approval: Array.isArray(raw.tools?.require_approval)
        ? raw.tools.require_approval
        : defaults.tools.require_approval,
    },
    temperature: typeof raw.temperature === "number" ? raw.temperature : defaults.temperature,
    max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : defaults.max_tokens,
    top_k: typeof raw.top_k === "number" ? raw.top_k : defaults.top_k,
    memory: { enabled: raw.memory?.enabled ?? defaults.memory.enabled },
    web: { enabled: raw.web?.enabled ?? defaults.web.enabled },
    mcp: { servers: raw.mcp?.servers ?? defaults.mcp.servers },
    bridge: { ...defaults.bridge, ...raw.bridge },
    reasoning: { ...defaults.reasoning, ...raw.reasoning },
  };
}

// ── Load / Save ───────────────────────────────────────────────────────────────

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
      return configCache;
    }
  } catch (e) {
    console.error("[Config] Load error, using defaults:", e);
  }

  return defaultConfig();
}

export function saveConfig(cfg: JarvisConfig): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
    configCache = cfg;
    configCacheTime = Date.now();
  } catch (e) {
    console.error("[Config] Save error:", e);
    throw e;
  }
}

export function invalidateConfigCache(): void {
  configCache = null;
  configCacheTime = 0;
}

// ── Agents Root Resolution ────────────────────────────────────────────────────

export function resolveAgentsRoot(cfg: JarvisConfig): string {
  const raw = cfg.agents_root ?? "";
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || defaultConfig().agents_root;
}

export function validateAgentsRootPath(inputPath: string): {
  valid: boolean;
  resolved_path: string;
  error?: string;
} {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    return { valid: false, resolved_path: "", error: "agents_root path is empty" };
  }

  const normalized = inputPath.trim();
  const parts = normalized.split(/[\\/]/);
  if (parts.includes("..")) {
    return { valid: false, resolved_path: "", error: "agents_root must not contain '..' traversal components" };
  }

  const resolved = resolve(normalized);
  if (!existsSync(resolved)) {
    return { valid: false, resolved_path: resolved, error: `agents_root does not exist: ${resolved}` };
  }

  return { valid: true, resolved_path: resolved };
}
