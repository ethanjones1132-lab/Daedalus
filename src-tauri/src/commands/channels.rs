// ═══════════════════════════════════════════════════════════════
// Channel Manager Commands — SQLite-backed channel CRUD
// ═══════════════════════════════════════════════════════════════

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::AppDb;

// ── Structs ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Channel {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub last_used: Option<String>,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

// ── Commands ─────────────────────────────────────────────────────

/// List all channels from the database
#[tauri::command]
pub async fn list_channels(db: State<'_, AppDb>) -> Result<Vec<Channel>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, enabled, config, last_used, created_at, updated_at
             FROM channels
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("DB prepare error: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let config_str: String = row.get(4).unwrap_or_default();
            let config: serde_json::Value =
                serde_json::from_str(&config_str).unwrap_or(serde_json::Value::Null);
            let enabled_val: i64 = row.get(3).unwrap_or(1);
            Ok(Channel {
                id: row.get(0)?,
                name: row.get(1)?,
                channel_type: row.get(2).unwrap_or_else(|_| "webhook".to_string()),
                enabled: enabled_val != 0,
                config,
                last_used: row.get(5).ok().flatten(),
                connected: false,
                created_at: row.get(6).unwrap_or_default(),
                updated_at: row.get(7).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("DB query error: {}", e))?;

    let mut channels = Vec::new();
    for row in rows {
        channels.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(channels)
}

/// Add a new channel
#[tauri::command]
pub async fn add_channel(
    db: State<'_, AppDb>,
    name: String,
    channel_type: String,
    config: serde_json::Value,
) -> Result<Channel, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let config_str = serde_json::to_string(&config).unwrap_or_else(|_| "{}".to_string());

    conn.execute(
        "INSERT INTO channels (id, name, type, config, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        [&id, &name, &channel_type, &config_str, &now],
    )
    .map_err(|e| format!("DB insert error: {}", e))?;

    Ok(Channel {
        id,
        name,
        channel_type,
        enabled: true,
        config,
        last_used: None,
        connected: false,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Remove a channel by id
#[tauri::command]
pub async fn remove_channel(db: State<'_, AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let rows = conn
        .execute("DELETE FROM channels WHERE id = ?1", [&id])
        .map_err(|e| format!("DB delete error: {}", e))?;
    Ok(rows > 0)
}

/// Login (connect) a channel — sets a connected flag in config and updates last_used
#[tauri::command]
pub async fn login_channel(db: State<'_, AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let now = chrono::Utc::now().to_rfc3339();

    // Fetch existing config
    let config_str: String = conn
        .query_row("SELECT config FROM channels WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| format!("DB query error: {}", e))?
        .unwrap_or_else(|| "{}".to_string());

    let mut config: serde_json::Value =
        serde_json::from_str(&config_str).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = config.as_object_mut() {
        obj.insert("connected".to_string(), serde_json::Value::Bool(true));
        obj.insert(
            "last_connected".to_string(),
            serde_json::Value::String(now.clone()),
        );
    }
    let new_config_str = serde_json::to_string(&config).unwrap_or_else(|_| "{}".to_string());

    let rows = conn
        .execute(
            "UPDATE channels SET config = ?1, last_used = ?2, updated_at = ?3 WHERE id = ?4",
            [&new_config_str, &now, &now, &id],
        )
        .map_err(|e| format!("DB update error: {}", e))?;
    Ok(rows > 0)
}

/// Logout (disconnect) a channel — clears connected flag
#[tauri::command]
pub async fn logout_channel(db: State<'_, AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let now = chrono::Utc::now().to_rfc3339();

    // Fetch existing config
    let config_str: String = conn
        .query_row("SELECT config FROM channels WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| format!("DB query error: {}", e))?
        .unwrap_or_else(|| "{}".to_string());

    let mut config: serde_json::Value =
        serde_json::from_str(&config_str).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = config.as_object_mut() {
        obj.insert("connected".to_string(), serde_json::Value::Bool(false));
    }
    let new_config_str = serde_json::to_string(&config).unwrap_or_else(|_| "{}".to_string());

    let rows = conn
        .execute(
            "UPDATE channels SET config = ?1, updated_at = ?2 WHERE id = ?3",
            [&new_config_str, &now, &id],
        )
        .map_err(|e| format!("DB update error: {}", e))?;
    Ok(rows > 0)
}