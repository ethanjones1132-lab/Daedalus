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
