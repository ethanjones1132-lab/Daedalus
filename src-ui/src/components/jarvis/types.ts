// ═══════════════════════════════════════════════════════════════
// ── Jarvis View Types v3.0 ──
// ═══════════════════════════════════════════════════════════════

export type JarvisBackend = 'ollama' | 'openrouter' | 'claude_cli';

/// Build provenance returned by the `get_build_info` Tauri command.
export interface BuildInfo {
  version: string;
  git_sha: string;
  git_short: string;
  dirty: boolean;
  build_time: string;
  source_sha: string | null;
  stale: boolean;
}

export interface JarvisConfig {
  version: string;
  active_backend: JarvisBackend;
  ollama: {
    base_url: string;
    model: string;
    auto_pull: boolean;
    health_check_interval_ms: number;
    options: { num_ctx: number; num_gpu: number; num_thread: number };
  };
  openrouter: {
    base_url: string;
    api_key: string;
    model: string;
    site_url: string;
    site_name: string;
    fallbacks: string[];
    enable_fallbacks: boolean;
    enable_paid_fallbacks: boolean;
    max_retries: number;
    timeout_ms: number;
  };
  claude_cli: {
    enabled: boolean;
    path: string;
    args: string[];
    timeout_ms: number;
    cwd: string;
    model?: string;
  };
  tools: {
    enabled: boolean;
    require_approval: string[];
    sandbox_mode: 'strict' | 'permissive' | 'off';
  };
  reasoning: {
    enabled: boolean;
    show_trace_by_default: boolean;
    max_tokens: number;
  };
  companion: {
    enabled: boolean;
    name: string;
    species: string;
    rarity: string;
  };
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  top_p: number;
  bridge_port: number;
  bridge_enabled: boolean;
  jarvis_path: string;
  active_profile: string;
  api_sports_key: string;
}

export interface JarvisSession {
  id: string;
  name?: string;
  title?: string;
  created_at: string;
  model: string;
  message_count: number;
  last_active?: string;
  total_tokens?: number;
  backend: string;
}

export interface JarvisMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  tool_name?: string;
  isStreaming?: boolean;
}

export interface ReasoningStep {
  type: 'thought' | 'action' | 'observation' | 'reflection' | 'plan';
  content: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  timestamp: number;
}

export interface ReasoningTrace {
  id: string;
  session_id: string;
  steps: ReasoningStep[];
  is_complete: boolean;
  total_tokens: number;
  duration_ms: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface FileDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw patch lines, each prefixed with " " (context), "+" (add) or "-" (del). */
  lines: string[];
}

export interface FileDiff {
  path: string;
  changed: boolean;
  additions: number;
  deletions: number;
  hunks: FileDiffHunk[];
}

export interface ToolResult {
  call_id: string;
  name: string;
  output: string;
  is_error: boolean;
  duration_ms: number;
  /** Unified diff for file-mutating tools (write_file/edit_file/multi_edit). */
  diff?: FileDiff | null;
}

export interface JarvisStatus {
  // Ollama backend
  ollama_running: boolean;
  model_available: boolean;
  // Bun server (needed by all backends)
  bun_server_running: boolean;
  bun_server_url: string;
  // Claude CLI proxy
  claude_proxy_running: boolean;
  // Bridge
  bridge_active: boolean;
  bridge_port: number;
  // General availability
  bun_available: boolean;
  // Active backend descriptor
  active_backend: string;
  model: string;
  openrouter_key_set: boolean;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  size_bytes?: number;
  context_length: number;
  max_completion_tokens?: number;
  already_installed?: boolean;
  pricing_prompt?: string;
  pricing_completion?: string;
  is_free?: boolean;
  is_router?: boolean;
  modality?: string;
  supported_parameters?: string[];
  default_temperature?: number | null;
  default_top_p?: number | null;
}

export interface JarvisSkill {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  source: string;
  usage_count: number;
  last_used?: string;
}

export interface JarvisTool {
  name: string;
  description: string;
  parameters: JarvisToolParam[];
}

export interface JarvisToolParam {
  name: string;
  param_type: string;
  description: string;
  required: boolean;
  default_value?: string;
}

export interface CompanionState {
  enabled: boolean;
  name: string;
  species: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  mood: 'happy' | 'excited' | 'sleeping' | 'thinking' | 'idle';
  happiness: number;
  energy: number;
  level: number;
  xp: number;
  xp_to_next: number;
  interactions_total: number;
  last_interaction?: string;
  current_message?: string;
  is_speaking: boolean;
  is_petting: boolean;
  hatched_at?: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: string;
  description?: string;
  is_free?: boolean;
  is_router?: boolean;
}

export type JarvisSubView =
  | 'hub'
  | 'chat'
  | 'sessions'
  | 'skills'
  | 'tools'
  | 'companion'
  | 'control'
  | 'memory'
  | 'self-improvement'
  | 'prizepicks';

// Popular OpenRouter models for the dropdown
// NOTE: No Anthropic cloud models — all inference must be local or non-Anthropic
export const OPENROUTER_MODELS: OpenRouterModel[] = [
  { id: 'openrouter/free', name: 'Free Models Router', context_length: 200000, pricing: 'free', description: 'Routes to available free OpenRouter models', is_free: true, is_router: true },
  { id: 'openrouter/owl-alpha', name: 'Owl Alpha', context_length: 1048756, pricing: 'free', description: 'OpenRouter free model', is_free: true },
  { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1:free', name: 'Nemotron Ultra 253B', context_length: 131072, pricing: 'free', description: 'NVIDIA Llama-3.1 Nemotron Ultra — free reasoning/orchestration model', is_free: true },
  { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder 480B', context_length: 1048576, pricing: 'free', description: 'Free coder model', is_free: true },
  { id: 'openai/gpt-oss-120b:free', name: 'GPT OSS 120B', context_length: 131072, pricing: 'free', description: 'Free OpenAI OSS model', is_free: true },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', context_length: 131072, pricing: 'free', description: 'Free Llama instruct model', is_free: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: '$$', description: 'OpenAI flagship' },
  { id: 'deepseek/deepseek-v3', name: 'DeepSeek V3', context_length: 65536, pricing: '$', description: 'Paid value fallback' },
];

// ── Recommended Ollama Models ──
export interface RecommendedOllamaModel {
  id: string;
  label: string;
  tags: string[];
  ctx: string;
  size: string;
}
export const RECOMMENDED_OLLAMA_MODELS: RecommendedOllamaModel[] = [
  { id: 'qwen3.5:9b', label: 'Qwen3.5 9B', tags: ['coding', 'agentic'], ctx: '131K', size: '5.7GB' },
  { id: 'qwen3.5:4b', label: 'Qwen3.5 4B', tags: ['coding', 'fast'], ctx: '131K', size: '2.9GB' },
  { id: 'qwen2.5:7b', label: 'Qwen2.5 7B', tags: ['general', 'chat'], ctx: '131K', size: '4.4GB' },
  { id: 'llama3.2:3b', label: 'Llama 3.2 3B', tags: ['general', 'fast'], ctx: '128K', size: '2.0GB' },
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B', tags: ['general', 'coding'], ctx: '128K', size: '4.6GB' },
  { id: 'mistral:7b', label: 'Mistral 7B', tags: ['general'], ctx: '32K', size: '4.1GB' },
  { id: 'codellama:13b', label: 'Code Llama 13B', tags: ['coding'], ctx: '16K', size: '7.3GB' },
  { id: 'deepseek-coder:6.7b', label: 'DeepSeek Coder 6.7B', tags: ['coding', 'local'], ctx: '128K', size: '3.8GB' },
  { id: 'phi3:3.8b', label: 'Phi-3 3.8B', tags: ['small', 'fast'], ctx: '128K', size: '2.3GB' },
  { id: 'gemma2:9b', label: 'Gemma 2 9B', tags: ['general', 'reasoning'], ctx: '8K', size: '5.5GB' },
];

// ── Companion Species & Rarity ──

export const COMPANION_SPECIES = [
  'duck', 'goose', 'blob', 'cat', 'dragon', 'bat', 'octopus', 'owl',
  'penguin', 'turtle', 'snail', 'ghost', 'axolotl', 'capybara',
  'cactus', 'robot', 'rabbit', 'mushroom', 'chonk',
] as const;

export type CompanionSpecies = typeof COMPANION_SPECIES[number];

export const COMPANION_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type CompanionRarity = typeof COMPANION_RARITIES[number];

export const RARITY_COLORS: Record<CompanionRarity, string> = {
  common: '#9090b8',
  uncommon: '#34d399',
  rare: '#8b5cf6',
  epic: '#f59e0b',
  legendary: '#fbbf24',
};

export const RARITY_STARS: Record<CompanionRarity, string> = {
  common: '★',
  uncommon: '★★',
  rare: '★★★',
  epic: '★★★★',
  legendary: '★★★★★',
};

export const RARITY_BG: Record<CompanionRarity, string> = {
  common: 'from-iron/20 to-iron/10',
  uncommon: 'from-success/20 to-success/10',
  rare: 'from-royal/20 to-royal/10',
  epic: 'from-warning/20 to-warning/10',
  legendary: 'from-amber-400/20 to-amber-400/10',
};

export const RARITY_BORDER: Record<CompanionRarity, string> = {
  common: 'border-iron/40',
  uncommon: 'border-success/40',
  rare: 'border-royal/40',
  epic: 'border-warning/40',
  legendary: 'border-amber-400/40',
};

export const RARITY_GLOW: Record<CompanionRarity, string> = {
  common: '',
  uncommon: 'neon-glow-cyan',
  rare: 'neon-glow-royal',
  epic: 'neon-glow-amber',
  legendary: 'neon-glow-amber',
};

// ── Spinner Types ──

export type SpinnerType = 'dots' | 'bars' | 'pulse' | 'bounce' | 'wave' | 'companion';

export interface SpinnerConfig {
  type: SpinnerType;
  speed?: number;
  color?: string;
  size?: 'sm' | 'md' | 'lg';
  message?: string;
  stalled?: boolean;
}

// ── Activity Log ──

export interface ActivityEntry {
  id: string;
  timestamp: string;
  type: 'session' | 'skill' | 'tool' | 'companion' | 'system' | 'error';
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface PrizePicksPlayer {
  name: string;
  team: string;
  position: string;
  games_played: number;
  fantasy_points_ppr: number;
  avg_pass_yards?: number;
  avg_rush_yards?: number;
  avg_rec_yards?: number;
  avg_receptions?: number;
  avg_targets?: number;
  last_3_games_avg?: number;
  floor?: number;
  ceiling?: number;
}

export interface PrizePicksDefense {
  team: string;
  rank_total_yards: number;
  rank_points_allowed: number;
  points_allowed_per_game: number;
  fp_allowed_qb: number;
  fp_allowed_rb: number;
  fp_allowed_wr: number;
  fp_allowed_te: number;
}

export interface PrizePicksPrediction {
  prediction: {
    player: string;
    team: string;
    position: string;
    stat_type: string;
    line: number;
    projection: number;
    confidence_pct: number;
    recommendation: 'over' | 'under';
    ev_score: number;
    risk_level: 'low' | 'medium' | 'high';
  };
  reasoning: string[];
  key_stats: Record<string, number>;
  context_factors: string[];
}
