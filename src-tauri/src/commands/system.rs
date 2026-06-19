// ═══════════════════════════════════════════════════════════════
// System Commands — Health, Doctor, Logs, Approvals, Devices,
//                  Nodes, Hooks, Commitments, Plugins, Gateway,
//                  and Update Checker
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use serde::{Deserialize, Serialize};
use tauri::State;

// ── Structs ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub target: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Approval {
    pub id: String,
    pub request_type: String,
    pub description: String,
    pub agent_id: String,
    pub created_at: String,
    pub status: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_args: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub device_type: String,
    pub status: String,
    pub last_seen: String,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub paired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub address: String,
    pub status: String,
    pub latency_ms: Option<u64>,
    pub last_ping: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hook {
    pub id: String,
    pub name: String,
    pub event: String,
    pub enabled: bool,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commitment {
    pub id: String,
    pub text: String,
    pub status: String,
    pub due: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,