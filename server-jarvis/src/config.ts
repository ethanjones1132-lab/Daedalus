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
import { validateOrchestratorAgents } from "./orchestration/agent-validation";

// ── A3: review→rewrite repair budget ──
// Base cap of repair rounds that run unconditionally on a gate/reviewer
// failure. The pipeline grants at most ONE progress-gated bonus round beyond
// this (only on a real content delta), so the absolute ceiling is base + 1.
// Single source of truth: referenced by defaultConfig(), the normalizeConfig
// clamp, and the pipeline's defensive clamp + replan-eligibility guards.
export const DEFAULT_REVIEW_REPAIR_ROUNDS = 2;
export const MAX_REVIEW_REPAIR_ROUNDS = 3;

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
  /** First-byte watchdog before this provider advances to the next fallback. */
  first_token_timeout_ms: number;
}

export interface ClaudeCliConfig {
  enabled: boolean;
  /** Proxy uses Jarvis' local Anthropic-compatible endpoint; subscription uses Claude OAuth/keychain auth. */
  auth_mode: 'proxy' | 'subscription';
  /** Path to the `claude` binary */
  path: string;
  args: string[];
  timeout_ms: number;
  /** Working directory for Claude CLI sessions */
  cwd: string;
  /** Model id the Claude-CLI engine drives the proxy with (set per active profile). */
  model?: string;
  /** Stock Claude executor delegation, projected independently from chat CLI settings. */
  delegate: ClaudeDelegateConfig;
}

export interface ClaudeDelegateConfig {
  enabled: boolean;
  policy: "delegate_first" | "escalation";
  permission_mode: "acceptEdits" | "bypassPermissions";
  allowed_tools: string[];
  /** Proxy-routable model used by the stock Claude CLI delegate. */
  model: string;
  timeout_ms: number;
}

export interface ToolConfig {
  enabled: boolean;
  /** Tools that require user approval before execution */
  require_approval: string[];
  /**
   * Sandbox mode: 'strict' | 'permissive' | 'off'.
   * - strict: all paths confined to allowed_roots ∪ session_grants
   * - permissive: reads outside roots allowed (logged); writes always confined
   *   to allowed_roots ∪ session_grants (same write fence as strict)
   * - off: no path containment
   */
  sandbox_mode: 'strict' | 'permissive' | 'off';
  /**
   * When true, tools whose policy resolves to "ask" in the interactive chat
   * surface block on a real user approve/reject round-trip (a `tool_approval`
   * event + `/tool/decision` response). When false (default), "ask" falls
   * through to legacy passthrough so chat writes are not gated.
   */
  interactive_approval: boolean;
  /** Persistent filesystem roots available to every invocation. */
  allowed_roots: string[];
  /** Whether absolute roots in the raw user message become Session grants. */
  grant_session_roots: boolean;
  /**
   * Explicit interpreter for the `bash` tool. Empty means auto-resolve. On
   * Windows this matters: `C:\Windows\System32\bash.exe` is the WSL launcher,
   * not Git Bash, and running workspace commands through it silently crosses
   * into a different filesystem namespace.
   */
  bash_path: string;
  /** Ceiling for a single shell invocation, in milliseconds. */
  shell_timeout_max_ms: number;
  /** Run a bounded direct-argv verification target after successful writes. */
  run_gate: boolean;
}

export interface ReasoningConfig {
  enabled: boolean;
  /** Show reasoning traces by default */
  show_trace_by_default: boolean;
  /** Max tokens for reasoning */
  max_tokens: number;
}

export interface WebSearchConfig {
  /**
   * Search backend. `duckduckgo` is the keyless default and needs no config;
   * `brave` and `tavily` are higher-quality but require an API key and fall
   * back to DuckDuckGo when their key is missing or the request fails.
   */
  provider: "duckduckgo" | "brave" | "tavily";
  brave_api_key: string;
  tavily_api_key: string;
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
  /** Keep the local conductor resident with periodic tiny pings. */
  keep_warm: boolean;
  /** Interval between local conductor keep-warm pings (ms). */
  keep_warm_interval_ms: number;
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
  /** Live-conductor supervision policy (request-scoped, never global). */
  supervision: ConductorSupervisionConfig;
}

/** Request-scoped live-conductor supervision knobs. */
export interface ConductorSupervisionConfig {
  /** Hard timeout for each supervisory inference call. */
  supervision_timeout_ms: number;
  /** Re-enter planner after this many consecutive tool errors in one stage. */
  max_tool_errors_before_reroute: number;
  /** When false, low-complexity turns skip the supervisory model call. */
  supervise_low_complexity: boolean;
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
  /** When true, the post-distill hook runs the existing heuristic screen and
   *  semantic judge gate before promoting the candidate. */
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

export interface DynamicAgentsConfig {
  /** T3.3: when false (default), POST /agents/pool/define is rejected. */
  enabled: boolean;
  max_dynamic_agents: number;
}

export interface OrchestratorConfig {
  enabled: boolean;
  agents: OrchestratorAgent[];
  max_recursion_depth: number;
  /** B-02: bound on how many times a single turn may re-invoke the conductor
   *  via `conductor_replan` before the replan loop just runs the remaining
   *  normalized pipeline to completion. Prevents an unbounded replan loop. */
  max_conductor_replans: number;
  /** B-04: cumulative per-session cap. The effective per-turn cap is the
   *  min of this and `max_conductor_replans`, so a session cannot slowly
   *  accumulate replan spend across many turns even if no single turn
   *  trips the per-turn cap. Reset on session reset. */
  max_conductor_replans_per_session: number;
  /** Maximum automatic review -> rewrite repair rounds for a full turn. */
  max_review_repair_rounds: number;
  /** Retry a high-complexity change once with a different strong executor after a deterministic gate failure. */
  high_complexity_executor_retry?: boolean;
  /**
   * T2.4: when true (default), all orchestrator turns run through
   * runPipelineWithReplanning so mid-run replan triggers can fire.
   */
  mid_run_replan?: boolean;
  /** T3.3: conductor-facing dynamic agent registration (default OFF). */
  dynamic_agents?: DynamicAgentsConfig;
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
  web_search: WebSearchConfig;
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
      model: "cohere/north-mini-code:free",
      site_url: "http://localhost:19877",
      site_name: "Jarvis Home-Base",
      fallbacks: [
        "openrouter/free",
        "cohere/north-mini-code:free",
        "openrouter/free",
        "qwen/qwen3-coder:free",
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
      first_token_timeout_ms: 45_000,
    },
    opencode_go: {
      base_url: "https://opencode.ai/zen/go/v1",
      api_key: "",
      first_token_timeout_ms: 45_000,
    },
    claude_cli: {
      enabled: true,
      auth_mode: "proxy",
      path: "claude",
      args: ["--print", "--output-format", "stream-json"],
      timeout_ms: 120000,
      cwd: homedir(),
      model: "",
      delegate: {
        enabled: true,
        policy: "delegate_first",
        permission_mode: "acceptEdits",
        allowed_tools: [
          "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob",
          "WebSearch", "WebFetch", "TodoWrite",
        ],
        model: "deepseek-v4-pro",
        timeout_ms: 420_000,
      },
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
      allowed_roots: [],
      grant_session_roots: true,
      bash_path: "",
      shell_timeout_max_ms: 120_000,
      run_gate: true,
    },
    reasoning: {
      enabled: true,
      show_trace_by_default: false,
      max_tokens: 2048,
    },
    web_search: {
      provider: "duckduckgo",
      brave_api_key: "",
      tavily_api_key: "",
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
      max_conductor_replans_per_session: 6,
      max_review_repair_rounds: DEFAULT_REVIEW_REPAIR_ROUNDS,
      high_complexity_executor_retry: true,
      mid_run_replan: true,
      dynamic_agents: {
        enabled: false,
        max_dynamic_agents: 4,
      },
      conductor: {
        enabled: true,
        // 2026-07-18 measured on the live Ollama host: qwen3.5:4b answers a
        // conductor directive in ~1.8s vs gemma4:e2b's ~4.4s (both with
        // think:false; both otherwise burn the whole budget in the thinking
        // channel and emit empty content). Fast primary, gemma as fallback.
        model: "qwen3.5:4b",
        fallback_model: "gemma4:e2b",
        base_url: "",
        output_mode: "tool_call",
        temperature: 1.0,
        top_p: 0.95,
        top_k: 64,
        // 700 structurally truncated multi-stage replan decisions (2026-07-16
        // incident memory) — routing itself stays capped by per-call
        // numPredict, so the wider ceiling only helps the bigger decisions.
        max_tokens: 1600,
        num_ctx: 16384,
        fallback_to_api: true,
        keep_warm: true,
        keep_warm_interval_ms: 600_000,
        session_ttl_ms: 30 * 60 * 1000,
        max_turns_in_cache: 12,
        persist_sessions: true,
        kv_persist: true,
        kv_backend: "ollama",
        supervision: {
          // 5s left no headroom above the ~2-4.5s measured local latency;
          // a single GC pause turned supervision into fallback-continue.
          supervision_timeout_ms: 8000,
          max_tool_errors_before_reroute: 3,
          supervise_low_complexity: false,
        },
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
        auto_promote: true,
      },
    },
    system_prompt: `You are Jarvis, a local AI coding assistant running on Qwen 3.5 9B in WSL2.
Workspace: \`/home/ethan/.openclaw/agents/coderclaw/workspace/home-base\`.

## Tool Protocol (No native tool support. Always emit this format for file/shell/web operations):
<tool_call>{"name":"TOOL_NAME","arguments":{"key":"val"}}</tool_call>

- The full tool list, with parameters, is appended below at runtime from the live registry — use only tools named there.
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

export interface NormalizeConfigOptions {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/** True when a configured jarvis_path is unusable on this platform. */
export function isInvalidWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (!path || !path.trim()) return true;
  if (platform === "win32" && /^\//.test(path)) return true;
  if (platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(path)) return true;
  try {
    return !exists(path);
  } catch {
    return true;
  }
}

// Task 3.5: normalizeConfig runs on every uncached loadConfig() (the 5s
// config cache is shorter than the 15s health poll), so a stale jarvis_path
// previously produced the same WARN ~5,700 times/day. The state is
// process-lifetime by design: the warning re-fires only after a restart or
// when a DIFFERENT stale path appears (i.e., new information).
const warnedStaleWorkspacePaths = new Set<string>();

export function normalizeConfig(raw: any, options: NormalizeConfigOptions = {}): JarvisConfig {
  const merged = deepMerge(defaultConfig(), raw);
  // Stock Claude delegation must not silently fall back to the proxy's weak
  // implicit model. Preserve an explicitly configured model, but migrate old
  // blank configs to the strongest currently proxy-routable free model.
  if (!merged.claude_cli.delegate.model || !merged.claude_cli.delegate.model.trim()) {
    merged.claude_cli.delegate.model = "deepseek-v4-pro";
  }
  // A3: base cap of unconditional review→rewrite repair rounds. Default 2, and
  // the ceiling is 3 so the pipeline's progress-gated bonus round has headroom
  // (the loop grants one conditional 3rd round only on a real content delta).
  const configuredRepairRounds = Number(merged.orchestrator.max_review_repair_rounds);
  merged.orchestrator.max_review_repair_rounds = Number.isFinite(configuredRepairRounds)
    ? Math.min(MAX_REVIEW_REPAIR_ROUNDS, Math.max(0, Math.floor(configuredRepairRounds)))
    : DEFAULT_REVIEW_REPAIR_ROUNDS;
  const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
  const openCodeKey = process.env.OPENCODE_API_KEY || process.env.OPENCODE_KEY;
  const openCodeZenKey = process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_ZEN_KEY || openCodeKey;
  const openCodeGoKey = process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_GO_KEY || openCodeKey;
  if ((!merged.openrouter.api_key || merged.openrouter.api_key.length < 10) && openRouterKey) {
    merged.openrouter.api_key = openRouterKey;
  }
  if ((!merged.opencode_zen.api_key || merged.opencode_zen.api_key.length < 10) && openCodeZenKey) {
    merged.opencode_zen.api_key = openCodeZenKey;
  }
  if ((!merged.opencode_go.api_key || merged.opencode_go.api_key.length < 10) && openCodeGoKey) {
    merged.opencode_go.api_key = openCodeGoKey;
  }
  if (Array.isArray(merged.claude_cli?.args)) {
    merged.claude_cli.args = merged.claude_cli.args.filter((arg: unknown) => arg !== "--no-telemetry");
  }
  const defaultWorkspacePath = join(homedir(), ".openclaw", "agents", "coderclaw", "workspace", "home-base");
  // Ensure jarvis_path is always set — an empty string or missing value
  // must never cause the workspace to silently resolve to process.cwd()
  // (e.g. the Windows Desktop when spawned from Tauri via wsl.exe).
  if (!merged.jarvis_path || merged.jarvis_path.trim() === "") {
    merged.jarvis_path = defaultWorkspacePath;
  }
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  if (merged.jarvis_path !== defaultWorkspacePath && isInvalidWorkspacePath(merged.jarvis_path, platform, exists)) {
    const stalePath = merged.jarvis_path;
    merged.jarvis_path = defaultWorkspacePath;
    if (!warnedStaleWorkspacePaths.has(stalePath)) {
      warnedStaleWorkspacePaths.add(stalePath);
      console.warn(
        `[Config] jarvis_path "${stalePath}" is unusable on ${platform}; using "${merged.jarvis_path}" in memory. ` +
        "The on-disk config is not rewritten until the next explicit save. (This warning fires once per process per path.)",
      );
    }
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
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8").replace(/^\uFEFF/, ""));
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

/**
 * Merge partial updates into the on-disk config (canonical Bun write path).
 *
 * P1-N (live-issues priority plan): validate before write. `validateConfig`
 * is run on the normalized merge; if it surfaces `errors`, this function
 * throws an `InvalidConfigError` carrying the full list — the on-disk
 * config is NOT touched in that case. Warnings (e.g. `temperature` outside
 * the 0-2 range) are logged. Use `saveConfigWithValidation` when the
 * caller wants the warnings returned in the response (e.g. the
 * `POST /config` HTTP route).
 */
export class InvalidConfigError extends Error {
  readonly validation: ConfigValidation;
  constructor(validation: ConfigValidation) {
    super(
      `Refusing to save invalid Jarvis config: ${validation.errors.join("; ")}`,
    );
    this.name = "InvalidConfigError";
    this.validation = validation;
  }
}

export interface SaveConfigOptions {
  /**
   * If true (default), `saveConfig` runs `validateConfig` on the normalized
   * result and throws `InvalidConfigError` when there are validation errors.
   * Set to false only for tests or migration paths that must persist
   * intermediate partial state.
   */
  validate?: boolean;
}

export interface SaveConfigResult {
  config: JarvisConfig;
  validation: ConfigValidation;
}

export function saveConfig(
  partial: Partial<JarvisConfig>,
  options: SaveConfigOptions = {},
): JarvisConfig {
  const validate = options.validate !== false;
  const current = loadConfig();
  const merged = normalizeConfig(deepMerge(current, partial));
  const validation = validateConfig(merged);
  for (const warning of validation.warnings) {
    console.warn(`[Config] saveConfig warning: ${warning}`);
  }
  if (validate && !validation.valid) {
    throw new InvalidConfigError(validation);
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
  configCache = merged;
  configCacheTime = Date.now();
  return merged;
}

/**
 * Variant of `saveConfig` that returns the `ConfigValidation` alongside the
 * saved config. Use this from the `POST /config` HTTP route so the response
 * can surface warnings (and the `InvalidConfigError` can be caught at the
 * route boundary and rendered as a 400 with the errors list).
 */
export function saveConfigWithValidation(
  partial: Partial<JarvisConfig>,
  options: SaveConfigOptions = {},
): SaveConfigResult {
  const config = saveConfig(partial, options);
  return { config, validation: validateConfig(config) };
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

  // T3.1: WARN-level orchestrator agent pool validation (existing configs keep booting).
  // Even "error"-severity rules surface as warnings so pre-existing pool entries load.
  for (const issue of validateOrchestratorAgents(cfg.orchestrator?.agents ?? [])) {
    warnings.push(`orchestrator.agents[${issue.agentId}]: ${issue.message}`);
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


/** Known top-level setting keys that may be written through the raw settings surface. */
const KNOWN_SETTING_KEYS = new Set([
  "version",
  "active_backend",
  "ollama",
  "openrouter",
  "opencode_zen",
  "opencode_go",
  "claude_cli",
  "tools",
  "reasoning",
  "companion",
  "orchestrator",
  "system_prompt",
  "mode",
  "prizepicks_prompt",
  "temperature",
  "surface_temperatures",
  "max_tokens",
  "top_p",
  "top_k",
  "bridge_port",
  "bridge_enabled",
  "jarvis_path",
  "compaction",
  "profiles",
  "active_profile",
  "api_sports_key",
  "agents_root",
]);

export interface SettingMutation {
  key: string;
  value: unknown;
}

/**
 * Validate and serialize a single raw setting mutation. Rejects unknown keys
 * so the settings UI cannot silently store untyped garbage in the canonical
 * SQLite settings table.
 */
export function normalizeSettingMutation(mutation: SettingMutation): { key: string; value: string } {
  if (!KNOWN_SETTING_KEYS.has(mutation.key)) {
    throw new Error(`unknown_setting: ${mutation.key}`);
  }
  const value =
    mutation.value === null || mutation.value === undefined
      ? ""
      : typeof mutation.value === "string"
        ? mutation.value
        : JSON.stringify(mutation.value);
  return { key: mutation.key, value };
}
