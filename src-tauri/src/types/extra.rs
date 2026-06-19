use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OsInfo {
    pub platform: String,
    pub arch: String,
    pub release: String,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayInfo {
    pub mode: String,
    pub url: String,
    pub reachable: bool,
    pub connect_latency_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GatewayService {
    pub installed: bool,
    pub loaded: bool,
    pub status: String,
    pub state: String,
    pub pid: Option<i64>,
    pub runtime_short: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NodeService {
    pub installed: bool,
    pub loaded: bool,
    pub status: String,
    pub state: String,
    pub runtime_short: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    pub latest_version: String,
    pub channel: String,
    pub install_kind: String,
    pub package_manager: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemoryInfo {
    pub enabled: bool,
    pub slot: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DashboardStatus {
    pub runtime_version: String,
    pub os: OsInfo,
    pub gateway: GatewayInfo,
    pub gateway_service: GatewayService,
    pub node_service: NodeService,
    pub update: UpdateInfo,
    pub memory: MemoryInfo,
    pub agents_total: usize,
    pub sessions_total: u64,
    pub default_agent_id: String,
    pub bootstrap_pending_count: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub workspace_dir: String,
    pub sessions_count: u64,
    pub last_updated_at: i64,
    pub last_active_age_ms: i64,
    pub bootstrap_pending: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionSummary {
    pub key: String,
    pub agent_id: String,
    pub session_id: String,
    pub kind: String,
    pub updated_at: i64,
    pub age_ms: i64,
    pub model: String,
    pub model_provider: String,
    pub thinking_level: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub context_tokens: Option<u64>,
    pub percent_used: Option<f64>,
    pub remaining_tokens: Option<u64>,
    pub total_tokens_fresh: bool,
    pub system_sent: bool,
    pub aborted_last_run: bool,
    pub flags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitmentInfo {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub due_date: Option<String>,
    pub completed: bool,
}
