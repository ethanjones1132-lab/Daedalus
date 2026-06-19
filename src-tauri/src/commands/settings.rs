use crate::db::AppDb;
use crate::jarvis::types::JarvisConfig;
use std::collections::HashMap;
use tauri::State;

/// Get all settings as a key-value map from the SQLite settings table.
#[tauri::command]
pub fn get_all_settings(db: State<AppDb>) -> Result<HashMap<String, String>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        map.insert(k, v);
    }
    Ok(map)
}

/// Get a single setting value by key. Returns None if the key doesn't exist.
#[tauri::command]
pub fn get_setting(db: State<AppDb>, key: String) -> Result<Option<String>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?")
        .map_err(|e| e.to_string())?;
    let result: Result<String, _> = stmt.query_row([&key], |row| row.get(0));
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Set a single setting value. Inserts or updates (upsert) with the current timestamp.
#[tauri::command]
pub fn set_setting(db: State<AppDb>, key: String, value: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [&key, &value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Load the full JarvisConfig from the settings table.
/// Each top-level field is stored as a JSON blob under its field name.
/// Falls back to defaults for any missing field.
#[tauri::command]
pub fn get_jarvis_config(db: State<AppDb>) -> Result<JarvisConfig, String> {
    load_jarvis_config(&db)
}

fn normalize_jarvis_config(config: &mut JarvisConfig) {
    if config.ollama.model == "qwen3.6:9b" {
        config.ollama.model = "qwen3.5-9b:latest".to_string();
    }
    if config.openrouter.model == "qwen/qwen3.6-9b" {
        config.openrouter.model = "openrouter/free".to_string();
    }
}

/// Load the full JarvisConfig from the Native surface settings table.
///
/// This is the canonical loader used by both Tauri commands and the chat
/// turn path before it delegates inference streaming to the Bun server.
pub fn load_jarvis_config(db: &AppDb) -> Result<JarvisConfig, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut settings = HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        settings.insert(k, v);
    }

    // Start from defaults, then overlay any stored JSON blobs
    let mut config = JarvisConfig::default();

    if let Some(v) = settings.get("version") {
        config.version = v.clone();
    }
    if let Some(v) = settings.get("active_backend") {
        config.active_backend = match v.as_str() {
            "ollama" => crate::jarvis::types::JarvisBackend::Ollama,
            "openrouter" => crate::jarvis::types::JarvisBackend::OpenRouter,
            "claude_cli" => crate::jarvis::types::JarvisBackend::ClaudeCli,
            _ => crate::jarvis::types::JarvisBackend::Ollama,
        };
    }
    if let Some(v) = settings.get("ollama") {
        if let Ok(parsed) = serde_json::from_str::<crate::jarvis::types::OllamaConfig>(v) {
            config.ollama = parsed;
        }
    }
    if let Some(v) = settings.get("openrouter") {
        if let Ok(parsed) = serde_json::from_str::<crate::jarvis::types::OpenRouterConfig>(v) {
            config.openrouter = parsed;
        }
    }
    if let Some(v) = settings.get("claude_cli") {
        if let Ok(parsed) = serde_json::from_str::<crate::jarvis::types::ClaudeCliConfig>(v) {
            config.claude_cli = parsed;
        }
    }
    if let Some(v) = settings.get("tools") {
        if let Ok(parsed) = serde_json::from_str::<crate::jarvis::types::ToolConfig>(v) {
            config.tools = parsed;
        }
    }
    if let Some(v) = settings.get("reasoning") {
        if let Ok(parsed) = serde_json::from_str::<crate::jarvis::types::ReasoningConfig>(v) {
            config.reasoning = parsed;
        }
    }
    if let Some(v) = settings.get("companion") {
        if let Ok(parsed) = serde_json::from_str::<crate::jarvis::types::CompanionConfig>(v) {
            config.companion = parsed;
        }
    }
    if let Some(v) = settings.get("system_prompt") {
        config.system_prompt = v.clone();
    }
    if let Some(v) = settings.get("mode") {
        config.mode = v.clone();
    }
    if let Some(v) = settings.get("prizepicks_prompt") {
        config.prizepicks_prompt = v.clone();
    }
    if let Some(v) = settings.get("temperature") {
        if let Ok(t) = v.parse::<f64>() {
            config.temperature = t;
        }
    }
    if let Some(v) = settings.get("max_tokens") {
        if let Ok(t) = v.parse::<u32>() {
            config.max_tokens = t;
        }
    }
    if let Some(v) = settings.get("top_p") {
        if let Ok(t) = v.parse::<f64>() {
            config.top_p = t;
        }
    }
    if let Some(v) = settings.get("bridge_port") {
        if let Ok(p) = v.parse::<u16>() {
            config.bridge_port = p;
        }
    }
    if let Some(v) = settings.get("bridge_enabled") {
        if let Ok(b) = v.parse::<bool>() {
            config.bridge_enabled = b;
        }
    }
    if let Some(v) = settings.get("jarvis_path") {
        config.jarvis_path = v.clone();
    }
    if let Some(v) = settings.get("compaction") {
        if let Ok(parsed) = serde_json::from_str::<crate::jarvis::types::CompactionConfigV2>(v) {
            config.compaction = parsed;
        }
    }
    if let Some(v) = settings.get("profiles") {
        if let Ok(parsed) =
            serde_json::from_str::<HashMap<String, crate::jarvis::types::ModelProfile>>(v)
        {
            config.profiles = parsed;
        }
    }
    if let Some(v) = settings.get("active_profile") {
        config.active_profile = v.clone();
    }
    if let Some(v) = settings.get("api_sports_key") {
        config.api_sports_key = v.clone();
    }
    if let Some(v) = settings.get("agents_root") {
        config.agents_root = v.clone();
    }

    normalize_jarvis_config(&mut config);
    Ok(config)
}

/// Save the full JarvisConfig into the settings table.
/// Each top-level field is serialized as a JSON blob (or plain string for simple fields).
#[tauri::command]
pub fn save_jarvis_config(db: State<AppDb>, mut config: JarvisConfig) -> Result<(), String> {
    normalize_jarvis_config(&mut config);

    let pairs: Vec<(&str, String)> = vec![
        ("version", config.version.clone()),
        ("active_backend", config.active_backend.to_string()),
        (
            "ollama",
            serde_json::to_string(&config.ollama).map_err(|e| e.to_string())?,
        ),
        (
            "openrouter",
            serde_json::to_string(&config.openrouter).map_err(|e| e.to_string())?,
        ),
        (
            "claude_cli",
            serde_json::to_string(&config.claude_cli).map_err(|e| e.to_string())?,
        ),
        (
            "tools",
            serde_json::to_string(&config.tools).map_err(|e| e.to_string())?,
        ),
        (
            "reasoning",
            serde_json::to_string(&config.reasoning).map_err(|e| e.to_string())?,
        ),
        (
            "companion",
            serde_json::to_string(&config.companion).map_err(|e| e.to_string())?,
        ),
        ("system_prompt", config.system_prompt.clone()),
        ("mode", config.mode.clone()),
        ("prizepicks_prompt", config.prizepicks_prompt.clone()),
        ("temperature", config.temperature.to_string()),
        ("max_tokens", config.max_tokens.to_string()),
        ("top_p", config.top_p.to_string()),
        ("bridge_port", config.bridge_port.to_string()),
        ("bridge_enabled", config.bridge_enabled.to_string()),
        ("jarvis_path", config.jarvis_path.clone()),
        (
            "compaction",
            serde_json::to_string(&config.compaction).map_err(|e| e.to_string())?,
        ),
        (
            "profiles",
            serde_json::to_string(&config.profiles).map_err(|e| e.to_string())?,
        ),
        ("active_profile", config.active_profile.clone()),
        ("api_sports_key", config.api_sports_key.clone()),
        ("agents_root", config.agents_root.clone()),
    ];

    {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

        for (key, value) in &pairs {
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                rusqlite::params![key, value],
            )
            .map_err(|e| format!("Failed to save setting '{}': {}", key, e))?;
        }
    }

    // Write the same nested config shape that the Bun inference adapter reads.
    // Older flat configs are still accepted by server-jarvis/src/config.ts.
    let bun_config = serde_json::to_value(&config).map_err(|e| e.to_string())?;
    let home = crate::get_home_dir();
    let config_dir = format!("{}/.openclaw/jarvis", home);
    let config_file = format!("{}/config.json", config_dir);
    let _ = std::fs::create_dir_all(&config_dir);
    let bun_json = serde_json::to_string_pretty(&bun_config).map_err(|e| e.to_string())?;
    std::fs::write(&config_file, bun_json)
        .map_err(|e| format!("Failed to write Bun config: {}", e))?;

    Ok(())
}
