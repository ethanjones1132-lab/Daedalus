pub mod bridge;
pub mod hermes;
pub mod learning;
pub mod memory;
pub mod queue;
pub mod runner;
pub mod types;

pub use types::JarvisState;

use crate::jarvis::types::JarvisConfig;
use crate::wsl::wsl_home;
use std::fs;
use std::path::PathBuf;

const CONFIG_DIR: &str = ".openclaw/jarvis";
const CONFIG_FILE: &str = "config.json";
const SESSIONS_DIR: &str = "sessions";

/// Load Jarvis config from disk, creating defaults only if the file is missing.
pub fn load_jarvis_config() -> JarvisConfig {
    let config_path = get_config_path();
    let jarvis_path = format!("{}/.openclaw/agents/coderclaw/workspace/Jarvis", wsl_home());

    if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(content) => match serde_json::from_str::<JarvisConfig>(&content) {
                Ok(mut config) => {
                    config.jarvis_path = jarvis_path;
                    return config;
                }
                Err(e) => {
                    // The file exists but doesn't parse as our schema. Do NOT overwrite
                    // it — the Bun server reads this SAME file, so clobbering it with
                    // defaults would wipe the user's real settings (incl. the OpenRouter
                    // key). Fall back to in-memory defaults and leave the file intact.
                    eprintln!(
                        "[Jarvis] config.json present but unparseable ({e}); using in-memory \
                         defaults and leaving the existing file untouched"
                    );
                    let mut config = JarvisConfig::default();
                    config.jarvis_path = jarvis_path;
                    return config;
                }
            },
            Err(e) => {
                eprintln!("[Jarvis] could not read config.json ({e}); using in-memory defaults");
                let mut config = JarvisConfig::default();
                config.jarvis_path = jarvis_path;
                return config;
            }
        }
    }

    // No config file yet — create one from defaults.
    let mut config = JarvisConfig::default();
    config.jarvis_path = jarvis_path;
    if let Some(parent) = config_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&config) {
        let _ = fs::write(&config_path, json);
    }
    config
}

/// Recursively merge `overlay` onto `base`, preserving keys from `base` that
/// are not present in `overlay` at any nesting level. This prevents a config
/// save from the UI from clobbering Bun-only nested fields like
/// `compaction.ollama_url` or `surface_temperatures.*`.
fn deep_merge_obj(
    base: &mut serde_json::Map<String, serde_json::Value>,
    overlay: serde_json::Map<String, serde_json::Value>,
) {
    for (k, v) in overlay {
        match (base.get_mut(&k), v) {
            (Some(serde_json::Value::Object(base_inner)), serde_json::Value::Object(overlay_inner)) => {
                deep_merge_obj(base_inner, overlay_inner);
            }
            (slot, v) => {
                if let Some(s) = slot {
                    *s = v;
                } else {
                    base.insert(k, v);
                }
            }
        }
    }
}

/// Save Jarvis config to disk. Deep-merges our fields onto the existing file so
/// that top-level AND nested keys owned by the Bun server (e.g.
/// `compaction.ollama_url`, `surface_temperatures`) survive a UI save.
/// Both the Tauri process and the Bun server share this file.
pub fn save_jarvis_config(config: &JarvisConfig) -> Result<(), String> {
    let config_path = get_config_path();
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let new_value =
        serde_json::to_value(config).map_err(|e| format!("Failed to serialize config: {}", e))?;

    let final_value = if let Ok(existing_str) = fs::read_to_string(&config_path) {
        if let (Ok(serde_json::Value::Object(mut merged)), serde_json::Value::Object(new_map)) = (
            serde_json::from_str::<serde_json::Value>(&existing_str),
            new_value.clone(),
        ) {
            deep_merge_obj(&mut merged, new_map);
            serde_json::Value::Object(merged)
        } else {
            new_value
        }
    } else {
        new_value
    };

    let json = serde_json::to_string_pretty(&final_value)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

/// Native config base dir: `<native-home>/.openclaw/jarvis`.
///
/// This MUST match the Bun server's `CONFIG_DIR`, which is built from Node's
/// `homedir()` (`C:\Users\<user>` on Windows). Previously this used `wsl_home()`,
/// which resolves to a WSL path like `/home/<user>` — so the UI wrote `config.json`
/// (including the OpenRouter API key) to a location the natively-run Bun server never
/// read, breaking both OpenRouter chat and key persistence across restarts.
fn config_base() -> PathBuf {
    PathBuf::from(crate::get_home_dir()).join(CONFIG_DIR)
}

/// Get the config file path
pub fn get_config_path() -> PathBuf {
    config_base().join(CONFIG_FILE)
}

/// Get the sessions directory path
pub fn get_sessions_dir() -> PathBuf {
    config_base().join(SESSIONS_DIR)
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
                if let Ok(session) =
                    serde_json::from_str::<crate::jarvis::types::JarvisSession>(&content)
                {
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
pub fn create_jarvis_session(
    name: Option<String>,
    model: &str,
) -> Result<crate::jarvis::types::JarvisSession, String> {
    let dir = ensure_sessions_dir()?;
    let id = uuid::Uuid::new_v4().to_string();
    let session = crate::jarvis::types::JarvisSession {
        id: id.clone(),
        name: name.unwrap_or_else(|| format!("Session {}", &id[..8])),
        created_at: chrono::Utc::now().to_rfc3339(),
        model: model.to_string(),
        message_count: 0,
    };
    let json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Failed to serialize session: {}", e))?;
    fs::write(dir.join(format!("{}.json", id)), json)
        .map_err(|e| format!("Failed to write session: {}", e))?;
    Ok(session)
}
