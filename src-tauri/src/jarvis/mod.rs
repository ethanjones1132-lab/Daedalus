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
                    return JarvisConfig {
                        jarvis_path,
                        ..Default::default()
                    };
                }
            },
            Err(e) => {
                eprintln!("[Jarvis] could not read config.json ({e}); using in-memory defaults");
                return JarvisConfig {
                    jarvis_path,
                    ..Default::default()
                };
            }
        }
    }

    // No config file yet — create one from defaults.
    let config = JarvisConfig {
        jarvis_path,
        ..Default::default()
    };
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
            (
                Some(serde_json::Value::Object(base_inner)),
                serde_json::Value::Object(overlay_inner),
            ) => {
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

/// Path to the companion state file, shared with the Bun server's `COMPANION_FILE`
/// (`<native-home>/.openclaw/jarvis/companion.json`).
pub fn get_companion_path() -> PathBuf {
    config_base().join("companion.json")
}

/// Persist the full companion state to `companion.json` so the Bun server's
/// `GET /companion` reflects it. The Bun `POST /companion` route is an *interaction*
/// (feed/talk/…), not a state save, so a true save writes the file directly.
pub fn save_companion_state(state: &serde_json::Value) -> Result<(), String> {
    let path = get_companion_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create companion dir: {}", e))?;
    }
    let json =
        serde_json::to_string_pretty(state).map_err(|e| format!("serialize companion: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("write companion: {}", e))?;
    Ok(())
}

// Session persistence was unified onto SQLite in Phase 1.2. The former
// file-based session store (`~/.openclaw/jarvis/sessions/*.json`) and its
// `create/list/delete_jarvis_session` helpers were removed; the `jarvis_*`
// chat-session commands now route through `commands::sessions` (the canonical
// SQLite `sessions`/`messages` tables). The Bun server keeps its own per-session
// message history as a runtime context cache — a projection, not a competing
// metadata store.
