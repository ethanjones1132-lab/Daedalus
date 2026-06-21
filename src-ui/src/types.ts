export type ViewId =
  | 'overview' | 'chat-feeds' | 'jarvis' | 'channels' | 'instances' | 'sessions'
  | 'usage' | 'cron' | 'agents' | 'skills' | 'nodes'
  | 'models' | 'control' | 'config' | 'logs' | 'hooks' | 'commitments' | 'devices'
  | 'approvals' | 'gateway' | 'doctor' | 'health' | 'plugins'
  | 'memory' | 'action-registry'
  | 'jarvis-hub' | 'jarvis-chat' | 'jarvis-sessions' | 'jarvis-skills'
  | 'jarvis-tools' | 'jarvis-companion' | 'jarvis-config' | 'jarvis-status';

export interface NavItem { id: ViewId; label: string; icon: string }
export interface NavSection { title: string; items: NavItem[] }

export interface SessionMessage {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
  tool_calls: string | null;
  created_at: string;
}

export interface BackendSession {
  id: string;
  agent_id: string;
  title: string;
  backend: string;
  model: string;
  context_tokens: number;
  total_tokens: number;
  created_at: string;
  updated_at: string;
  archived: boolean;
  message_count: number;
}

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

export interface CommitmentInfo {
  id: string;
  status: string;
  summary: string;
  agent_id: string | null;
  created_at_ms: number | null;
  due_at_ms: number | null;
  extra: Record<string, unknown>;
}
