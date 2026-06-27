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

    // Preserve the file loader's behavior: jarvis_path defaults to the agent
    // workspace path when not explicitly stored. Boot now hydrates from SQLite,
    // so this fallback lives here instead of in the (retired) file loader.
    if config.jarvis_path.is_empty() {
        config.jarvis_path = format!(
            "{}/.openclaw/agents/coderclaw/workspace/Jarvis",
            crate::wsl::wsl_home()
        );
    }

    normalize_jarvis_config(&mut config);
    Ok(config)
}

/// Persist the full JarvisConfig. **SQLite `settings` is the single source of
/// truth**; the file store (`~/.openclaw/jarvis/config.json`) is a one-way
/// projection that the Bun server reads. Writing SQLite first and then
/// deep-merging into the file means a UI save can never drift from what the
/// chat path (which reads SQLite via `load_jarvis_config`) sees, while
/// Bun-only nested keys in the file (e.g. `compaction.ollama_url`) survive.
///
/// This is the one canonical write path; every command that mutates config
/// (`save_jarvis_config`, `jarvis_save_config`, `jarvis_switch_backend`) routes
/// through it.
pub fn persist_jarvis_config(db: &AppDb, config: &JarvisConfig) -> Result<(), String> {
    let mut config = config.clone();
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

    // Project the canonical config onto the Bun-readable file. `save_jarvis_config`
    // in jarvis/mod.rs deep-merges onto the existing file, so nested keys the Bun
    // server owns survive a UI save (replacing the previous wholesale overwrite,
    // which could clobber `compaction.*`, `surface_temperatures`, etc.).
    crate::jarvis::save_jarvis_config(&config)?;

    Ok(())
}

/// Save the full JarvisConfig (SQLite-canonical). Thin command wrapper over
/// [`persist_jarvis_config`].
#[tauri::command]
pub fn save_jarvis_config(db: State<AppDb>, config: JarvisConfig) -> Result<(), String> {
    persist_jarvis_config(&db, &config)
}

/// One-time migration for the file→SQLite cutover. If SQLite has never been
/// seeded (no `active_backend` row) but a legacy file store exists, import it so
/// the user's persisted backend/key/etc. survive. Idempotent — once SQLite holds
/// the row this is a no-op. Returns whether a migration actually ran.
pub fn migrate_file_config_into_sqlite_if_needed(db: &AppDb) -> Result<bool, String> {
    {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let seeded: bool = conn
            .query_row(
                "SELECT 1 FROM settings WHERE key = 'active_backend' LIMIT 1",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if seeded {
            return Ok(false);
        }
    }
    // SQLite not seeded yet — pull from the legacy file store if present.
    if !crate::jarvis::get_config_path().exists() {
        return Ok(false);
    }
    let file_cfg = crate::jarvis::load_jarvis_config();
    persist_jarvis_config(db, &file_cfg)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{run_migrations, AppDb};
    use crate::jarvis::types::JarvisBackend;
    use rusqlite::Connection;
    use std::sync::Mutex;

    /// In-memory AppDb with migrations applied — no filesystem side effects, so
    /// no write to the real `~/.openclaw`.
    fn mem_db() -> AppDb {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run_migrations(&conn).expect("run migrations");
        AppDb {
            conn: Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    fn put(db: &AppDb, key: &str, value: &str) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .unwrap();
    }

    #[test]
    fn load_reads_canonical_fields_from_sqlite() {
        let db = mem_db();
        put(&db, "active_backend", "openrouter");
        put(&db, "system_prompt", "be terse");
        put(&db, "temperature", "0.42");

        let cfg = load_jarvis_config(&db).expect("load");
        assert!(matches!(cfg.active_backend, JarvisBackend::OpenRouter));
        assert_eq!(cfg.system_prompt, "be terse");
        assert!((cfg.temperature - 0.42).abs() < 1e-9);
    }

    #[test]
    fn load_fills_jarvis_path_when_unset() {
        let db = mem_db();
        let cfg = load_jarvis_config(&db).expect("load");
        assert!(
            !cfg.jarvis_path.is_empty(),
            "jarvis_path should fall back to a non-empty default"
        );
    }

    #[test]
    fn migrate_is_noop_once_sqlite_is_seeded() {
        let db = mem_db();
        put(&db, "active_backend", "ollama");
        // Seeded → migration must not run (and must not touch the file store).
        assert_eq!(
            migrate_file_config_into_sqlite_if_needed(&db).expect("migrate"),
            false
        );
    }
}
