// ═══════════════════════════════════════════════════════════════
// Agent Manager Commands — SQLite-backed agent CRUD
// ═══════════════════════════════════════════════════════════════
//
// The `#[tauri::command]` entry points are thin: they lock the connection and
// delegate to the `*_row` / `fetch_*` helpers below. The helpers take a plain
// `&Connection`, which keeps the real CRUD logic unit-testable without a Tauri
// `State` (see the `tests` module at the bottom).

use crate::db::AppDb;
use rusqlite::{params, Connection, OptionalExtension};
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

// ── Connection-level helpers (testable) ──────────────────────────

pub(crate) fn fetch_agents(conn: &Connection) -> Result<Vec<Agent>, String> {
    let sql = format!("SELECT {COLS} FROM agents ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let agents = stmt
        .query_map([], row_to_agent)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(agents)
}

pub(crate) fn fetch_agent(conn: &Connection, id: &str) -> Result<Option<Agent>, String> {
    let sql = format!("SELECT {COLS} FROM agents WHERE id = ?");
    conn.query_row(&sql, [&id], row_to_agent)
        .optional()
        .map_err(|e| e.to_string())
}

pub(crate) fn insert_agent(
    conn: &Connection,
    name: String,
    model: String,
    description: Option<String>,
    backend: Option<String>,
    system_prompt: Option<String>,
) -> Result<Agent, String> {
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

pub(crate) fn delete_agent_row(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM agents WHERE id = ?", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn update_agent_identity(
    conn: &Connection,
    id: &str,
    name: Option<String>,
    description: Option<String>,
    system_prompt: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
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

pub(crate) fn set_agent_enabled_row(
    conn: &Connection,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?",
        params![enabled as i64, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_binding_table(conn: &Connection) -> Result<(), String> {
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

pub(crate) fn bind_channel_row(
    conn: &Connection,
    agent_id: &str,
    channel_id: &str,
) -> Result<(), String> {
    ensure_binding_table(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO agent_channels (agent_id, channel_id) VALUES (?, ?)",
        params![agent_id, channel_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn unbind_channel_row(
    conn: &Connection,
    agent_id: &str,
    channel_id: &str,
) -> Result<(), String> {
    ensure_binding_table(conn)?;
    conn.execute(
        "DELETE FROM agent_channels WHERE agent_id = ? AND channel_id = ?",
        params![agent_id, channel_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Channel ids bound to an agent.
pub(crate) fn channel_bindings(conn: &Connection, agent_id: &str) -> Result<Vec<String>, String> {
    ensure_binding_table(conn)?;
    let mut stmt = conn
        .prepare("SELECT channel_id FROM agent_channels WHERE agent_id = ? ORDER BY channel_id")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([agent_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids)
}

// ── Commands (thin delegates) ────────────────────────────────────

/// List all agents ordered by created_at DESC.
#[tauri::command]
pub fn list_agents(db: State<AppDb>) -> Result<Vec<Agent>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    fetch_agents(&conn)
}

/// Get a single agent by id.
#[tauri::command]
pub fn get_agent(db: State<AppDb>, id: String) -> Result<Option<Agent>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    fetch_agent(&conn, &id)
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
    insert_agent(&conn, name, model, description, backend, system_prompt)
}

/// Delete an agent by id.
#[tauri::command]
pub fn delete_agent(db: State<AppDb>, id: String) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    delete_agent_row(&conn, &id)
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
    update_agent_identity(&conn, &id, name, description, system_prompt, model)
}

/// Enable / disable an agent.
#[tauri::command]
pub fn set_agent_enabled(db: State<AppDb>, id: String, enabled: bool) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    set_agent_enabled_row(&conn, &id, enabled)
}

/// Bind an agent to a channel.
#[tauri::command]
pub fn bind_agent_channel(
    db: State<AppDb>,
    agent_id: String,
    channel_id: String,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    bind_channel_row(&conn, &agent_id, &channel_id)
}

/// Remove an agent↔channel binding.
#[tauri::command]
pub fn unbind_agent_channel(
    db: State<AppDb>,
    agent_id: String,
    channel_id: String,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    unbind_channel_row(&conn, &agent_id, &channel_id)
}

/// List channel ids bound to an agent (from the agent_channels table).
#[tauri::command]
pub fn list_agent_channel_bindings(
    db: State<AppDb>,
    agent_id: String,
) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    channel_bindings(&conn, &agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;
    use rusqlite::Connection;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run_migrations(&conn).expect("run migrations");
        conn
    }

    #[test]
    fn insert_then_fetch_roundtrip() {
        let conn = test_db();
        let created = insert_agent(
            &conn,
            "Scout".into(),
            "qwen2.5-coder:7b".into(),
            Some("recon agent".into()),
            None,
            Some("be terse".into()),
        )
        .unwrap();

        // Defaults applied.
        assert!(created.enabled);
        assert_eq!(created.backend, "jarvis");
        assert_eq!(created.description, "recon agent");

        let all = fetch_agents(&conn).unwrap();
        assert_eq!(all.len(), 1);

        let one = fetch_agent(&conn, &created.id)
            .unwrap()
            .expect("agent exists");
        assert_eq!(one.id, created.id);
        assert_eq!(one.name, "Scout");
        assert_eq!(one.model, "qwen2.5-coder:7b");
        assert_eq!(one.system_prompt, "be terse");
    }

    #[test]
    fn fetch_missing_agent_is_none() {
        let conn = test_db();
        assert!(fetch_agent(&conn, "nope").unwrap().is_none());
    }

    #[test]
    fn update_identity_coalesces_nulls() {
        let conn = test_db();
        let a = insert_agent(&conn, "A".into(), "m1".into(), None, None, None).unwrap();

        // Only update the name; everything else passed as None must be preserved.
        update_agent_identity(&conn, &a.id, Some("Renamed".into()), None, None, None).unwrap();

        let updated = fetch_agent(&conn, &a.id).unwrap().unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.model, "m1", "model preserved when None passed");
    }

    #[test]
    fn toggle_enabled() {
        let conn = test_db();
        let a = insert_agent(&conn, "A".into(), "m".into(), None, None, None).unwrap();
        assert!(fetch_agent(&conn, &a.id).unwrap().unwrap().enabled);

        set_agent_enabled_row(&conn, &a.id, false).unwrap();
        assert!(!fetch_agent(&conn, &a.id).unwrap().unwrap().enabled);

        set_agent_enabled_row(&conn, &a.id, true).unwrap();
        assert!(fetch_agent(&conn, &a.id).unwrap().unwrap().enabled);
    }

    #[test]
    fn delete_removes_agent() {
        let conn = test_db();
        let a = insert_agent(&conn, "A".into(), "m".into(), None, None, None).unwrap();
        delete_agent_row(&conn, &a.id).unwrap();
        assert!(fetch_agent(&conn, &a.id).unwrap().is_none());
        assert_eq!(fetch_agents(&conn).unwrap().len(), 0);
    }

    #[test]
    fn channel_binding_is_idempotent_and_reversible() {
        let conn = test_db();
        let a = insert_agent(&conn, "A".into(), "m".into(), None, None, None).unwrap();

        bind_channel_row(&conn, &a.id, "chan-1").unwrap();
        bind_channel_row(&conn, &a.id, "chan-1").unwrap(); // INSERT OR IGNORE — no dup
        bind_channel_row(&conn, &a.id, "chan-2").unwrap();
        assert_eq!(
            channel_bindings(&conn, &a.id).unwrap(),
            vec!["chan-1", "chan-2"]
        );

        unbind_channel_row(&conn, &a.id, "chan-1").unwrap();
        assert_eq!(channel_bindings(&conn, &a.id).unwrap(), vec!["chan-2"]);
    }
}
