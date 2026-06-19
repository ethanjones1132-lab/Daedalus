// ═══════════════════════════════════════════════════════════════
// Agent Manager Commands — SQLite-backed agent CRUD
// ═══════════════════════════════════════════════════════════════
//
// NOTE (recovery): only the `Agent` struct + the head of `list_agents` survived
// in any snapshot/transcript. The command bodies below were reconstructed from
// the `agents` table schema (db/migrations.rs) and the surrounding CRUD style
// (see commands/skills.rs). See RECOVERY_STATUS.md.

use crate::db::AppDb;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

/// An agent stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub model: String,
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub system_prompt: String,
    pub enabled: bool,
    #[serde(default)]
    pub config: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const COLS: &str =
    "id, name, description, model, backend, system_prompt, enabled, config, created_at, updated_at";

fn row_to_agent(row: &rusqlite::Row) -> rusqlite::Result<Agent> {
    Ok(Agent {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        model: row.get(3)?,
        backend: row.get(4)?,
        system_prompt: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
        config: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ── Commands ─────────────────────────────────────────────────

/// List all agents ordered by created_at DESC.
#[tauri::command]
pub fn list_agents(db: State<AppDb>) -> Result<Vec<Agent>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let sql = format!("SELECT {COLS} FROM agents ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let agents = stmt
        .query_map([], row_to_agent)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(agents)
}

/// Get a single agent by id.
#[tauri::command]
pub fn get_agent(db: State<AppDb>, id: String) -> Result<Option<Agent>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let sql = format!("SELECT {COLS} FROM agents WHERE id = ?");
    conn.query_row(&sql, [&id], row_to_agent)
        .optional()
        .map_err(|e| e.to_string())
}

/// Create a new agent.
#[tauri::command]
pub fn add_agent(
    db: State<AppDb>,
    name: String,
    model: String,
    description: Option<String>,
    backend: Option<String>,
    system_prompt: Option<String>,
) -> Result<Agent, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let agent = Agent {
        id: id.clone(),
        name,
        description: description.unwrap_or_default(),
        model,
        backend: backend.unwrap_or_else(|| "jarvis".to_string()),
        system_prompt: system_prompt.unwrap_or_default(),
        enabled: true,
        config: None,
        created_at: now.clone(),
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO agents (id, name, description, model, backend, system_prompt, enabled, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)",
        params![
            agent.id, agent.name, agent.description, agent.model, agent.backend,
            agent.system_prompt, agent.created_at, agent.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(agent)
}

/// Delete an agent by id.
#[tauri::command]
pub fn delete_agent(db: State<AppDb>, id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.execute("DELETE FROM agents WHERE id = ?", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Update an agent's identity fields (name / description / system prompt / model).
#[tauri::command]
pub fn set_agent_identity(
    db: State<AppDb>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    system_prompt: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE agents SET
            name          = COALESCE(?, name),
            description   = COALESCE(?, description),
            system_prompt = COALESCE(?, system_prompt),
            model         = COALESCE(?, model),
            updated_at    = ?
         WHERE id = ?",
        params![name, description, system_prompt, model, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Enable / disable an agent.
#[tauri::command]
pub fn set_agent_enabled(db: State<AppDb>, id: String, enabled: bool) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?",
        params![enabled as i64, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_binding_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_channels (
            agent_id   TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            PRIMARY KEY (agent_id, channel_id)
        );",
    )
    .map_err(|e| e.to_string())
}

/// Bind an agent to a channel.
#[tauri::command]
pub fn bind_agent_channel(db: State<AppDb>, agent_id: String, channel_id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    ensure_binding_table(&conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO agent_channels (agent_id, channel_id) VALUES (?, ?)",
        params![agent_id, channel_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove an agent↔channel binding.
#[tauri::command]
pub fn unbind_agent_channel(db: State<AppDb>, agent_id: String, channel_id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    ensure_binding_table(&conn)?;
    conn.execute(
        "DELETE FROM agent_channels WHERE agent_id = ? AND channel_id = ?",
        params![agent_id, channel_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
