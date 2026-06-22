use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronSchedule {
    pub kind: String,
    pub expr: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronState {
    pub next_run_at_ms: Option<i64>,
    pub last_run_at_ms: Option<i64>,
    pub last_run_status: Option<String>,
    pub last_status: Option<String>,
    pub last_duration_ms: Option<i64>,
    pub last_delivery_status: Option<String>,
    pub consecutive_errors: i64,
    pub consecutive_skipped: i64,
    pub last_delivered: Option<bool>,
    pub last_error: Option<String>,
    pub last_error_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronJob {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub schedule: CronSchedule,
    pub session_target: String,
    pub wake_mode: String,
    pub payload_kind: String,
    pub delivery_mode: String,
    pub delivery_channel: Option<String>,
    pub state: CronState,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CronJobsList {
    pub jobs: Vec<CronJob>,
}

// ═══════════════════════════════════════════════════════════════
// ── Skills ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillMissing {
    pub bins: Vec<String>,
    pub env: Vec<String>,
    pub config: Vec<String>,
    pub os: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub eligible: bool,
    pub disabled: bool,
    pub blocked_by_allowlist: bool,
    pub source: String,
    pub bundled: bool,
    pub homepage: Option<String>,
    pub missing: SkillMissing,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillsList {
    pub workspace_dir: String,
    pub managed_skills_dir: String,
    pub skills: Vec<SkillInfo>,
}

// ═══════════════════════════════════════════════════════════════
// ── Nodes ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NodeInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub paired: bool,
    #[serde(default)]
    pub caps: Vec<String>,
    #[serde(default)]
    pub last_connected_at: Option<i64>,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

// ═══════════════════════════════════════════════════════════════
// ── Channels ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChannelStatus {
    pub configured: bool,
    pub running: bool,
    pub last_start_at: Option<i64>,
    pub last_stop_at: Option<i64>,
    pub last_error: Option<String>,
    pub token_source: Option<String>,
    pub last_probe_at: Option<i64>,
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChannelsStatusData {
    pub channel_order: Vec<String>,
    pub channel_labels: serde_json::Value,
    pub channels: serde_json::Map<String, serde_json::Value>,
    pub channel_accounts: serde_json::Map<String, serde_json::Value>,
}

// ═══════════════════════════════════════════════════════════════
// ── Models ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub key: String,
    pub name: String,
    pub input: String,
    pub context_window: u64,
    pub local: bool,
    pub available: bool,
    pub tags: Vec<String>,
    pub missing: bool,
}

// ═══════════════════════════════════════════════════════════════
// ── Plugins ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub status: String,
    pub origin: String,
    pub format: String,
}

// ═══════════════════════════════════════════════════════════════
// ── Memory / Tasks / Logs / Health / Config ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryStatus {
    pub enabled: bool,
    pub slot: String,
    #[serde(flatten)]
    pub extra: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigData {
    pub path: String,
    pub content: serde_json::Value,
}

// ═══════════════════════════════════════════════════════════════
// ── Chat History ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionHistory {
    pub session_key: String,
    pub agent_id: String,
    pub session_id: String,
    pub messages: Vec<ChatMessage>,
}

// ═══════════════════════════════════════════════════════════════
// ── Hooks ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HookInfo {
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub eligible: bool,
    pub disabled: bool,
    pub enabled_by_config: bool,
    pub requirements_satisfied: bool,
    pub loadable: bool,
    pub source: String,
    pub events: Vec<String>,
    pub homepage: Option<String>,
    pub missing_bins: Vec<String>,
    pub managed_by_plugin: bool,
}

mod extra;
pub use extra::*;
