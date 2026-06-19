pub mod memory;
pub mod types;
pub mod runner;
pub mod queue;
pub mod bridge;
pub mod hermes;
pub mod learning;

pub use types::JarvisState;

use crate::wsl::wsl_home;
use crate::jarvis::types::JarvisConfig;
use std::fs;
use std::path::PathBuf;

const CONFIG_DIR: &str = ".openclaw/jarvis";
const CONFIG_FILE: &str = "config.json";
const SESSIONS_DIR: &str = "sessions";

/// Load Jarvis config from disk, creating defaults if missing
pub fn load_jarvis_config() -> JarvisConfig {
    let config_path = get_config_path();
    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(mut config) = serde_json::from_str::<JarvisConfig>(&content) {
                // Always resolve jarvis_path from current workspace
                config.jarvis_path = format!("{}/.openclaw/agents/coderclaw/workspace/Jarvis", wsl_home());
                return config;
            }
        }
    }
    // Create default config
    let mut config = JarvisConfig::default();
    config.jarvis_path = format!("{}/.openclaw/agents/coderclaw/workspace/Jarvis", wsl_home());
    // Ensure config directory exists
    if let Some(parent) = config_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Save defaults
    if let Ok(json) = serde_json::to_string_pretty(&config) {
        let _ = fs::write(&config_path, json);
    }
    config
}

/// Save Jarvis config to disk
pub fn save_jarvis_config(config: &JarvisConfig) -> Result<(), String> {
    let config_path = get_config_path();
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

/// Get the config file path
pub fn get_config_path() -> PathBuf {
    PathBuf::from(format!("{}/{}", wsl_home(), CONFIG_DIR))
        .join(CONFIG_FILE)
}

/// Get the sessions directory path
pub fn get_sessions_dir() -> PathBuf {
    PathBuf::from(format!("{}/{}", wsl_home(), CONFIG_DIR))
        .join(SESSIONS_DIR)
}

/// Ensure the sessions directory exists
pub fn ensure_sessions_dir() -> Result<PathBuf, String> {
    let dir = get_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    Ok(dir)
}

/// List all Jarvis sessions from disk
pub fn list_jarvis_sessions() -> Result<Vec<crate::jarvis::types::JarvisSession>, String> {
    let dir = get_sessions_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("Failed to read sessions dir: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read session entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(session) = serde_json::from_str::<crate::jarvis::types::JarvisSession>(&content) {
                    sessions.push(session);
                }
            }
        }
    }
    sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(sessions)
}

/// Delete a Jarvis session
pub fn delete_jarvis_session(session_id: &str) -> Result<(), String> {
    let path = get_sessions_dir().join(format!("{}.json", session_id));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete session: {}", e))?;
    }
    Ok(())
}

/// Create a new Jarvis session
pub fn create_jarvis_session(name: Option<String>, model: &str) -> Result<crate::jarvis::types::JarvisSession, String> {
    let dir = ensure_sessions_dir()?;
    let id = uuid::Uuid::new_v4().to_string();
    let session = crate::jarvis::types::JarvisSession {
        id: id.clone(),
        name: name.unwrap_or_else(|| format!("Session {}", &id[..8])),
        created_at: chrono::Utc::now().to_rfc3339(),
        model: model.to_string(),
        message_count: 0,
    };
    let json = serde_json::to_string_pretty(&session).map_err(|e| format!("Failed to serialize session: {}", e))?;
    fs::write(dir.join(format!("{}.json", id)), json).map_err(|e| format!("Failed to write session: {}", e))?;
    Ok(session)
}
