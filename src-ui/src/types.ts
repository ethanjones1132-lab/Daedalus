// ═══════════════════════════════════════════════════════════════
// ── Centralized TypeScript Interfaces ──
// ═══════════════════════════════════════════════════════════════

export type ViewId =
  | 'overview' | 'chat-feeds' | 'jarvis' | 'channels' | 'instances' | 'sessions'
  | 'usage' | 'cron' | 'agents' | 'skills' | 'nodes' | 'dreaming'
  | 'models' | 'config' | 'logs' | 'hooks' | 'commitments' | 'devices'
  | 'approvals' | 'gateway' | 'doctor';

export interface NavItem { id: ViewId; label: string; icon: string; }
export interface NavSection { title: string; items: NavItem[]; }

// ── Chat ──

export interface ChatMessage {
  role: string;
  content: string;
  timestamp: string | null;
}

export interface SessionHistory {
  session_key: string;
  agent_id: string;
  session_id: string;
  messages: ChatMessage[];
}

export interface ChatSession {
  key: string;
  agent_id: string;
  session_id: string;
  kind: string;
  updated_at: number;
  age_ms: number;
  model: string;
  last_message_preview: string;
}

// ── Sessions ──

export interface SessionData {
  key: string;
  agent_id: string;
  session_id: string;
  kind: string;
  updated_at: number;
  age_ms: number;
  model: string;
  model_provider: string;
  thinking_level: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  context_tokens: number | null;
  percent_used: number | null;
  remaining_tokens: number | null;
  total_tokens_fresh: boolean;
  system_sent: boolean;
  aborted_last_run: boolean;
  flags: string[];
}

// ── Agents ──

export interface AgentData {
  id: string;
  name: string;
  identity_name: string;
  identity_emoji: string;
  identity_source: string;
  workspace: string;
  agent_dir: string;
  model: string;
  bindings: number;
  is_default: boolean;
  sessions_count?: number;
  last_active_age_ms?: number;
  bootstrap_pending?: boolean;
}

// ── Skills ──

export interface SkillInfo {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  disabled: boolean;
  blocked_by_allowlist: boolean;
  source: string;
  bundled: boolean;
  homepage: string | null;
  missing: { bins: string[]; env: string[]; config: string[]; os: string[] };
}

// ── Models ──

export interface ModelInfo {
  key: string;
  name: string;
  input: string;
  context_window: number;
  local: boolean;
  available: boolean;
  tags: string[];
  missing: boolean;
}

// ── Cron Jobs ──

export interface CronJob {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  enabled: boolean;
  created_at_ms: number;
  updated_at_ms: number;
  schedule: { kind: string; expr: string };
  session_target: string;
  wake_mode: string;
  payload_kind: string;
  delivery_mode: string;
  delivery_channel: string | null;
  state: {
    next_run_at_ms: number | null;
    last_run_at_ms: number | null;
    last_run_status: string | null;
    last_status: string | null;
    last_duration_ms: number | null;
    last_delivery_status: string | null;
    consecutive_errors: number;
    consecutive_skipped: number;
    last_delivered: boolean | null;
    last_error: string | null;
    last_error_reason: string | null;
  };
}

// ── Hooks ──

export interface HookInfo {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  disabled: boolean;
  enabled_by_config: boolean;
  requirements_satisfied: boolean;
  loadable: boolean;
  source: string;
  events: string[];
  homepage: string | null;
  missing_bins: string[];
  managed_by_plugin: boolean;
}

// ── Commitments ──

export interface CommitmentInfo {
  id: string;
  status: string;
  summary: string;
  agent_id: string | null;
  created_at_ms: number | null;
  due_at_ms: number | null;
  extra: Record<string, unknown>;
}

// ── Dashboard ──

export interface DashboardData {
  status: {
    runtime_version: string;
    os: { label: string };
    gateway: { mode: string; url: string; reachable: boolean; error?: string };
    gateway_service: { status: string; runtime_short: string };
    node_service: { installed: boolean; runtime_short: string };
    update: { available: boolean; latest_version: string; channel: string; package_manager: string; install_kind: string };
    memory: { enabled: boolean; slot: string };
    agents_total: number;
    sessions_total: number;
  };
  agents: AgentData[];
  sessions: SessionData[];
}