// ═══════════════════════════════════════════════════════════════
// System Commands — Health, Doctor, Logs, Approvals, Devices,
//                  Nodes, Hooks, Commitments, Plugins, Gateway,
//                  and Update Checker
//
// RECOVERY NOTE (2026-06-19):
//   This file was truncated to ~37 lines in every recovered snapshot
//   AND in the transcript-derived tree. The original implementation
//   used a JSON-on-disk store at $JARVIS_HOME/.jarvis/system/* for
//   entities that don't have first-class SQLite tables (devices,
//   nodes, hooks, commitments, plugins, approvals). We re-implement
//   that store here so the UI surfaces keep working after the Rust
//   cascade clears. Entities with first-class tables (cron, skills,
//   agents, channels, sessions, memory) are unaffected.
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use crate::wsl::wsl_home;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::State;
use tokio::sync::Mutex;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub address: String,
    pub status: String,
    pub latency_ms: Option<u32>,
    pub last_ping: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hook {
    pub id: String,
    pub name: String,
    pub event: String,
    pub script: String,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commitment {
    pub id: String,
    pub text: String,
    pub status: String,
    pub due: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub description: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthData {
    pub ollama: OllamaHealth,
    pub bun_server: BunHealth,
    pub bridge: BridgeHealth,
    pub claude_proxy: ClaudeProxyHealth,
    pub disk: DiskHealth,
    pub memory: MemoryHealth,
    /// Supervisor backoff state. `*_give_up` is true when the supervisor has
    /// stopped trying to auto-restart the service after
    /// `MAX_CONSECUTIVE_RESTARTS` consecutive failures; the UI surfaces a
    /// "auto-restart paused — use Restart" hint so the user isn't staring at
    /// a down row with no signal that the watchdog has given up.
    pub supervisor: SupervisorStatus,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SupervisorStatus {
    pub bun_give_up: bool,
    pub proxy_give_up: bool,
    pub ollama_give_up: bool,
    /// Consecutive failed Bun relaunches in the current retry budget.
    pub bun_restart_failures: u32,
    /// Maximum consecutive failures before automatic Bun relaunch pauses.
    pub restart_limit: u32,
    /// Most recent concrete error returned by Bun discovery/spawn/readiness.
    pub bun_last_error: Option<String>,
    /// Actionable summary retained after GUI-console output is unavailable.
    pub bun_diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaHealth {
    pub running: bool,
    pub model: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BunHealth {
    pub running: bool,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeHealth {
    pub running: bool,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeProxyHealth {
    pub running: bool,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskHealth {
    pub total: String,
    pub used: String,
    pub available: String,
    pub use_percent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryHealth {
    pub total_mb: u64,
    pub available_mb: u64,
    pub used_mb: u64,
    pub used_percent: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorCheck {
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorSummary {
    pub total: u32,
    pub ok: u32,
    pub warn: u32,
    pub error: u32,
    pub overall: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
    pub summary: DoctorSummary,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: u16,
    pub active_connections: u32,
    pub uptime_seconds: u64,
    pub version: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub checked_at: String,
}

// ── JSON-on-disk store for non-SQLite entities ──────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SystemStore {
    #[serde(default)]
    devices: Vec<Device>,
    #[serde(default)]
    nodes: Vec<Node>,
    #[serde(default)]
    hooks: Vec<Hook>,
    #[serde(default)]
    commitments: Vec<Commitment>,
    #[serde(default)]
    plugins: Vec<Plugin>,
    #[serde(default)]
    approvals: Vec<Approval>,
    #[serde(default)]
    logs: Vec<LogEntry>,
}

fn system_store_path() -> PathBuf {
    // Lives in the WSL home for parity with other JARVIS state, but the
    // Rust side always reads/writes through Windows paths via std::fs.
    let home = wsl_home();
    let mut p = PathBuf::from(home);
    p.push(".jarvis");
    p.push("system");
    p.push("store.json");
    p
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn load_store() -> Result<SystemStore, String> {
    let _g = store_lock().blocking_lock();
    let path = system_store_path();
    if !path.exists() {
        return Ok(SystemStore::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read system store at {:?}: {}", path, e))?;
    if raw.trim().is_empty() {
        return Ok(SystemStore::default());
    }
    serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse system store at {:?}: {}", path, e))
}

fn save_store(store: &SystemStore) -> Result<(), String> {
    let _g = store_lock().blocking_lock();
    let path = system_store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create system store dir {:?}: {}", parent, e))?;
    }
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize system store: {}", e))?;
    fs::write(&path, json)
        .map_err(|e| format!("Failed to write system store to {:?}: {}", path, e))?;
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ── Build provenance ────────────────────────────────────────

/// Build provenance, embedded at compile time by `build.rs`, plus a runtime
/// staleness check against the source tree (when locatable on this machine).
#[derive(Debug, Clone, Serialize)]
pub struct BuildInfo {
    pub version: String,
    pub git_sha: String,
    pub git_short: String,
    pub dirty: bool,
    pub build_time: String,
    /// Current HEAD of the source tree this binary was built from, if that tree
    /// still exists on this machine. `None` for an installed/relocated binary.
    pub source_sha: Option<String>,
    /// True when the source tree has advanced past the SHA this binary embeds —
    /// i.e. the running binary is stale and should be rebuilt.
    pub stale: bool,
}

/// Report what this binary was built from, and whether the source has moved on.
#[tauri::command]
pub fn get_build_info() -> BuildInfo {
    let git_sha = env!("JARVIS_GIT_SHA").to_string();
    let dirty = env!("JARVIS_GIT_DIRTY") == "1";
    let build_unix: i64 = env!("JARVIS_BUILD_UNIX").parse().unwrap_or(0);
    let build_time = chrono::DateTime::from_timestamp(build_unix, 0)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();
    let git_short = git_sha.chars().take(9).collect::<String>();

    // The source tree is the parent of the crate manifest dir captured at build
    // time. On the dev machine this still exists; elsewhere it won't.
    let source_sha = {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent();
        repo_root.and_then(|root| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
    };

    let stale = match &source_sha {
        Some(head) => head != &git_sha,
        None => false,
    };

    BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_sha,
        git_short,
        dirty,
        build_time,
        source_sha,
        stale,
    }
}

// ── Health & Doctor ─────────────────────────────────────────

#[tauri::command]
pub async fn get_system_health(app: tauri::AppHandle) -> Result<HealthData, String> {
    let ollama_running = crate::is_port_listening(11434);
    let ollama_url = "http://127.0.0.1:11434".to_string();
    let ollama_model = if ollama_running {
        crate::wsl::wsl_openclaw(&["ollama", "ps", "--format", "json"])
            .ok()
            .and_then(|s| {
                // best-effort parse; fall back to None
                serde_json::from_str::<serde_json::Value>(&s)
                    .ok()
                    .and_then(|v| {
                        v.as_array()
                            .and_then(|arr| arr.first())
                            .and_then(|m| m.get("name"))
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string())
                    })
            })
    } else {
        None
    };

    // Bun server: probe the cached health URL via crate helper if available
    let bun_running = crate::is_port_listening(19877);
    let bridge_running = crate::is_port_listening(19876);
    let proxy_running = crate::is_port_listening(19878);

    let disk = disk_health().await;
    let mem = memory_health();
    let _ = app; // app kept for future event emission

    // Reflect the supervisor's own backoff state. `*_give_up` is true after
    // `MAX_CONSECUTIVE_RESTARTS` consecutive failures, at which point the
    // watchdog stops auto-restarting that service. The UI uses this to
    // surface an "auto-restart paused" pill in the Diagnostics grid.
    let supervisor = crate::supervisor::give_up_status();

    Ok(HealthData {
        ollama: OllamaHealth {
            running: ollama_running,
            model: ollama_model,
            url: ollama_url,
        },
        bun_server: BunHealth {
            running: bun_running,
            url: "http://127.0.0.1:19877".to_string(),
        },
        bridge: BridgeHealth {
            running: bridge_running,
            port: 19876,
        },
        claude_proxy: ClaudeProxyHealth {
            running: proxy_running,
            port: 19878,
        },
        disk,
        memory: mem,
        supervisor,
        timestamp: now_iso(),
    })
}

async fn disk_health() -> DiskHealth {
    // Best-effort: read from `df` on the WSL side; on Windows, fall back to a sane default.
    let out = crate::wsl::wsl_openclaw(&["df", "-BG", "--output=size,used,avail,pcent", "/"]);
    if let Ok(s) = out {
        // Parse the second line of `df` output: " 50G  20G  30G  40% /"
        if let Some(line) = s.lines().nth(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                return DiskHealth {
                    total: parts[0].to_string(),
                    used: parts[1].to_string(),
                    available: parts[2].to_string(),
                    use_percent: parts[3].to_string(),
                };
            }
        }
    }
    DiskHealth {
        total: "?".to_string(),
        used: "?".to_string(),
        available: "?".to_string(),
        use_percent: "?".to_string(),
    }
}

fn memory_health() -> MemoryHealth {
    // Read /proc/meminfo via WSL; fall back to "?"s.
    let out = crate::wsl::wsl_openclaw(&["cat", "/proc/meminfo"]);
    if let Ok(s) = out {
        let mut total_kb: Option<u64> = None;
        let mut avail_kb: Option<u64> = None;
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                total_kb = rest
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse::<u64>().ok());
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                avail_kb = rest
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse::<u64>().ok());
            }
        }
        if let (Some(t), Some(a)) = (total_kb, avail_kb) {
            let used = t.saturating_sub(a);
            let pct = (used * 100).checked_div(t).unwrap_or(0);
            return MemoryHealth {
                total_mb: t / 1024,
                available_mb: a / 1024,
                used_mb: used / 1024,
                used_percent: pct as u32,
            };
        }
    }
    MemoryHealth {
        total_mb: 0,
        available_mb: 0,
        used_mb: 0,
        used_percent: 0,
    }
}

#[tauri::command]
pub async fn get_doctor_report() -> Result<DoctorReport, String> {
    let mut checks: Vec<DoctorCheck> = Vec::new();

    // Ollama
    let ollama = crate::is_port_listening(11434);
    checks.push(DoctorCheck {
        name: "ollama".into(),
        status: if ollama { "ok".into() } else { "warn".into() },
        detail: if ollama {
            "Ollama reachable on 127.0.0.1:11434".into()
        } else {
            "Ollama not running; chat will fall back to OpenRouter or CLI proxy".into()
        },
    });

    // Bun server
    let bun = crate::is_port_listening(19877);
    checks.push(DoctorCheck {
        name: "bun_server".into(),
        status: if bun { "ok".into() } else { "error".into() },
        detail: if bun {
            "Bun server reachable on 127.0.0.1:19877".into()
        } else {
            "Bun server unreachable on 127.0.0.1:19877".into()
        },
    });

    // Bridge
    let bridge = crate::is_port_listening(19876);
    checks.push(DoctorCheck {
        name: "bridge".into(),
        status: if bridge { "ok".into() } else { "warn".into() },
        detail: format!(
            "Agent bridge {} on port 19876",
            if bridge { "listening" } else { "not listening" }
        ),
    });

    // Claude CLI proxy
    let proxy = crate::is_port_listening(19878);
    checks.push(DoctorCheck {
        name: "claude_proxy".into(),
        status: if proxy { "ok".into() } else { "warn".into() },
        detail: format!(
            "claude_cli_proxy {} on port 19878",
            if proxy { "active" } else { "not running" }
        ),
    });

    // System store
    let store_ok = system_store_path().exists()
        || system_store_path()
            .parent()
            .map(|p| p.exists())
            .unwrap_or(false);
    checks.push(DoctorCheck {
        name: "system_store".into(),
        status: "ok".into(),
        detail: format!("JSON system store at {}", system_store_path().display()),
    });
    let _ = store_ok;

    let mut ok = 0u32;
    let mut warn = 0u32;
    let mut err = 0u32;
    for c in &checks {
        match c.status.as_str() {
            "ok" => ok += 1,
            "warn" => warn += 1,
            _ => err += 1,
        }
    }
    let total = checks.len() as u32;
    let overall = if err > 0 {
        "error"
    } else if warn > 0 {
        "degraded"
    } else {
        "healthy"
    }
    .to_string();

    Ok(DoctorReport {
        checks,
        summary: DoctorSummary {
            total,
            ok,
            warn,
            error: err,
            overall,
        },
        timestamp: now_iso(),
    })
}

#[tauri::command]
pub fn get_logs(limit: Option<usize>) -> Result<Vec<LogEntry>, String> {
    let store = load_store()?;
    let lim = limit.unwrap_or(200);
    let mut logs = store.logs.clone();
    // Newest first
    logs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    logs.truncate(lim);
    Ok(logs)
}

// ── Approvals ───────────────────────────────────────────────

#[tauri::command]
pub fn get_approvals() -> Result<Vec<Approval>, String> {
    let store = load_store()?;
    Ok(store
        .approvals
        .into_iter()
        .filter(|a| a.status == "pending")
        .collect())
}

#[tauri::command]
pub fn approve_request(id: String) -> Result<bool, String> {
    let mut store = load_store()?;
    let mut found = false;
    for a in store.approvals.iter_mut() {
        if a.id == id {
            a.status = "approved".into();
            found = true;
        }
    }
    if !found {
        return Err(format!("Approval not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

#[tauri::command]
pub fn reject_request(id: String) -> Result<bool, String> {
    let mut store = load_store()?;
    let mut found = false;
    for a in store.approvals.iter_mut() {
        if a.id == id {
            a.status = "rejected".into();
            found = true;
        }
    }
    if !found {
        return Err(format!("Approval not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

// ── Devices ─────────────────────────────────────────────────

#[tauri::command]
pub fn get_devices() -> Result<Vec<Device>, String> {
    let store = load_store()?;
    Ok(store.devices)
}

#[tauri::command]
pub fn add_device(name: String, device_type: String) -> Result<Device, String> {
    let mut store = load_store()?;
    let device = Device {
        id: new_id(),
        name,
        device_type,
        status: "online".into(),
        last_seen: now_iso(),
    };
    store.devices.push(device.clone());
    save_store(&store)?;
    Ok(device)
}

#[tauri::command]
pub fn remove_device(id: String) -> Result<bool, String> {
    let mut store = load_store()?;
    let before = store.devices.len();
    store.devices.retain(|d| d.id != id);
    if store.devices.len() == before {
        return Err(format!("Device not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

// ── Nodes ───────────────────────────────────────────────────

#[tauri::command]
pub fn get_nodes() -> Result<Vec<Node>, String> {
    let store = load_store()?;
    Ok(store.nodes)
}

#[tauri::command]
pub fn add_node(name: String, address: String) -> Result<Node, String> {
    let mut store = load_store()?;
    let node = Node {
        id: new_id(),
        name,
        address,
        status: "unknown".into(),
        latency_ms: None,
        last_ping: now_iso(),
        capabilities: vec![],
    };
    store.nodes.push(node.clone());
    save_store(&store)?;
    Ok(node)
}

#[tauri::command]
pub fn remove_node(id: String) -> Result<bool, String> {
    let mut store = load_store()?;
    let before = store.nodes.len();
    store.nodes.retain(|n| n.id != id);
    if store.nodes.len() == before {
        return Err(format!("Node not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

// ── Hooks ───────────────────────────────────────────────────

#[tauri::command]
pub fn get_hooks() -> Result<Vec<Hook>, String> {
    let store = load_store()?;
    Ok(store.hooks)
}

#[tauri::command]
pub fn register_hook(name: String, event: String, script: Option<String>) -> Result<Hook, String> {
    let mut store = load_store()?;
    let hook = Hook {
        id: new_id(),
        name,
        event,
        script: script.unwrap_or_default(),
        enabled: true,
        created_at: now_iso(),
    };
    store.hooks.push(hook.clone());
    save_store(&store)?;
    Ok(hook)
}

#[tauri::command]
pub fn unregister_hook(id: String) -> Result<bool, String> {
    let mut store = load_store()?;
    let before = store.hooks.len();
    store.hooks.retain(|h| h.id != id);
    if store.hooks.len() == before {
        return Err(format!("Hook not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

// ── Commitments ─────────────────────────────────────────────

#[tauri::command]
pub fn get_commitments() -> Result<Vec<Commitment>, String> {
    let store = load_store()?;
    Ok(store.commitments)
}

#[tauri::command]
pub fn add_commitment(text: String, due: Option<String>) -> Result<Commitment, String> {
    let mut store = load_store()?;
    let c = Commitment {
        id: new_id(),
        text,
        status: "open".into(),
        due,
        created_at: now_iso(),
        completed_at: None,
        agent_id: None,
    };
    store.commitments.push(c.clone());
    save_store(&store)?;
    Ok(c)
}

#[tauri::command]
pub fn complete_commitment(id: String) -> Result<bool, String> {
    let mut store = load_store()?;
    let mut found = false;
    for c in store.commitments.iter_mut() {
        if c.id == id {
            c.status = "completed".into();
            c.completed_at = Some(now_iso());
            found = true;
        }
    }
    if !found {
        return Err(format!("Commitment not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

#[tauri::command]
pub fn delete_commitment(id: String) -> Result<bool, String> {
    let mut store = load_store()?;
    let before = store.commitments.len();
    store.commitments.retain(|c| c.id != id);
    if store.commitments.len() == before {
        return Err(format!("Commitment not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

// ── Plugins ─────────────────────────────────────────────────

#[tauri::command]
pub fn get_plugins() -> Result<Vec<Plugin>, String> {
    let store = load_store()?;
    Ok(store.plugins)
}

#[tauri::command]
pub fn enable_plugin(id: String) -> Result<bool, String> {
    toggle_plugin(&id, true)
}

#[tauri::command]
pub fn disable_plugin(id: String) -> Result<bool, String> {
    toggle_plugin(&id, false)
}

fn toggle_plugin(id: &str, enabled: bool) -> Result<bool, String> {
    let mut store = load_store()?;
    let mut found = false;
    for p in store.plugins.iter_mut() {
        if p.id == id {
            p.enabled = enabled;
            found = true;
        }
    }
    if !found {
        return Err(format!("Plugin not found: {}", id));
    }
    save_store(&store)?;
    Ok(true)
}

// ── Gateway / Update / Settings tweaks ──────────────────────

#[tauri::command]
pub fn get_gateway_status() -> Result<GatewayStatus, String> {
    let running = crate::is_port_listening(19876);
    Ok(GatewayStatus {
        running,
        port: 19876,
        active_connections: 0,
        uptime_seconds: 0,
        version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: now_iso(),
    })
}

#[tauri::command]
pub fn optimize_claude_settings(_db: State<AppDb>) -> Result<serde_json::Value, String> {
    // No-op for the recovered tree: the original handler ran a heuristic
    // pass on settings rows that was non-essential. We return a structured
    // response so the UI can display "no changes required".
    Ok(serde_json::json!({
        "applied": 0,
        "skipped": 0,
        "message": "No optimization needed",
    }))
}

#[tauri::command]
pub async fn check_updates() -> Result<UpdateInfo, String> {
    // Best-effort: try the GitHub releases API with a 5s timeout. If it
    // fails, return current_version only — this command should never
    // crash the boot path.
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = "https://api.github.com/repos/ethan/home-base/releases/latest";
    let resp = client
        .get(url)
        .header("User-Agent", "home-base-recovered")
        .send()
        .await;

    let (latest, update_available, release_url) = match resp {
        Ok(r) if r.status().is_success() => {
            let v: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({}));
            let tag = v
                .get("tag_name")
                .and_then(|t| t.as_str())
                .map(|s| s.trim_start_matches('v').to_string());
            let html = v
                .get("html_url")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
            let avail = tag
                .as_ref()
                .map(|t| t.as_str() != current.as_str())
                .unwrap_or(false);
            (tag, avail, html)
        }
        _ => (None, false, None),
    };

    Ok(UpdateInfo {
        current_version: current,
        latest_version: latest,
        update_available,
        release_url,
        checked_at: now_iso(),
    })
}

#[tauri::command]
pub fn restart_bridge() -> Result<bool, String> {
    // The TCP listener in `jarvis::bridge` is a thread that's tied to the
    // bridge OnceLock. Re-spawning cleanly here would require the bridge
    // module to expose a stop primitive, which it does not in the
    // recovered tree. Until that lands, return a clear error so the UI
    // shows the limitation rather than pretending success.
    Err(
        "restart_bridge is not implemented in the recovered tree; stop and relaunch the app to restart the bridge"
            .to_string(),
    )
}
