// ═══════════════════════════════════════════════════════════════
// Agent Manager Commands — SQLite-backed agent CRUD
// ═══════════════════════════════════════════════════════════════
//
// The `#[tauri::command]` entry points are thin: they lock the connection and
// delegate to the `*_row` / `fetch_*` helpers below. The helpers take a plain
// `&Connection`, which keeps the real CRUD logic unit-testable without a Tauri
// `State` (see the `tests` module at the bottom).

use crate::db::AppDb;
use crate::jarvis::memory::contracts::MemoryError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProjection {
    pub slug: String,
    pub source_path: String,
    pub source_hash: String,
    pub projection_version: i64,
    pub status: String,
    pub validation_errors: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub tools: Option<Vec<String>>,
    pub version_tag: Option<String>,
    pub activated_at: Option<String>,
    pub active: bool,
    pub active_source_hash: String,
    pub source_size_bytes: Option<i64>,
    pub last_validated_at: Option<String>,
    pub deactivated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProjectionInput {
    pub slug: String,
    pub source_path: String,
    pub source_hash: String,
    pub projection_version: Option<i64>,
    pub status: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub tools: Option<Vec<String>>,
    pub version_tag: Option<String>,
    pub source_size_bytes: Option<i64>,
    pub validation_errors: Option<String>,
}

const PROJECTION_COLS: &str = "slug, source_path, source_hash, projection_version, status, validation_errors, name, description, tools_json, version_tag, activated_at, active, active_source_hash, source_size_bytes, last_validated_at, deactivated_at, created_at, updated_at";

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

fn row_to_agent_projection(row: &rusqlite::Row) -> rusqlite::Result<AgentProjection> {
    let tools_json: Option<String> = row.get(8)?;
    let tools = tools_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok());
    Ok(AgentProjection {
        slug: row.get(0)?,
        source_path: row.get(1)?,
        source_hash: row.get(2)?,
        projection_version: row.get(3)?,
        status: row.get(4)?,
        validation_errors: row.get(5)?,
        name: row.get(6)?,
        description: row.get(7)?,
        tools,
        version_tag: row.get(9)?,
        activated_at: row.get(10)?,
        active: row.get::<_, i64>(11)? != 0,
        active_source_hash: row.get(12)?,
        source_size_bytes: row.get(13)?,
        last_validated_at: row.get(14)?,
        deactivated_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
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

pub(crate) fn fetch_agent_projection(
    conn: &Connection,
    slug: &str,
) -> Result<Option<AgentProjection>, String> {
    let sql = format!("SELECT {PROJECTION_COLS} FROM agent_projections WHERE slug = ?");
    conn.query_row(&sql, [slug], row_to_agent_projection)
        .optional()
        .map_err(|e| e.to_string())
}

pub(crate) fn fetch_agent_projections(conn: &Connection) -> Result<Vec<AgentProjection>, String> {
    let sql = format!("SELECT {PROJECTION_COLS} FROM agent_projections ORDER BY slug");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let projections = stmt
        .query_map([], row_to_agent_projection)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(projections)
}

fn valid_projection_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Classified denial for an unattended activation. `WaitingForUser` means the
/// Agent authority exists but requires operator action (disabled); `Blocked`
/// means the authority is missing/invalid/stale/mismatched and must not be
/// silently substituted with a privileged default.
#[derive(Debug, Clone)]
pub enum ActivationDenial {
    WaitingForUser(String),
    Blocked(String),
}

impl ActivationDenial {
    pub fn claim_state(&self) -> &'static str {
        match self {
            ActivationDenial::WaitingForUser(_) => "waiting_for_user",
            ActivationDenial::Blocked(_) => "blocked",
        }
    }

    pub fn reason(&self) -> &str {
        match self {
            ActivationDenial::WaitingForUser(reason) | ActivationDenial::Blocked(reason) => reason,
        }
    }
}

/// Canonical instructions for the built-in default Jarvis agent. The built-in
/// path may run unattended only through this exact canonical identity; an
/// arbitrary unknown Agent id is never treated as Jarvis.
pub const BUILTIN_JARVIS_AGENT_ID: &str = "jarvis";

/// Resolve and validate the Agent lifecycle authority for one unattended cron
/// activation. Returns the canonical projection snapshot the Bun boundary can
/// bind, or a classified denial that the caller records durably without
/// dispatching.
///
/// Rules:
///   * The job's Agent must resolve through the native Agent authority. A
///     missing Agent is `Blocked`; a disabled Agent is `WaitingForUser`.
///   * A custom Agent (anything other than the canonical built-in `jarvis`)
///     must have a valid, active, non-stale projection; a missing/invalid/
///     inactive/stale projection is `Blocked`. Its instructions are never
///     substituted with a default.
///   * The canonical built-in `jarvis` is allowed without a projection only
///     because its identity is the exact built-in runtime default; it is never
///     inferred from an arbitrary id.
pub fn resolve_activation_boundary(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> Result<crate::cron_scheduler::ProjectionSnapshot, ActivationDenial> {
    let agent = fetch_agent(conn, agent_id)
        .map_err(|e| ActivationDenial::Blocked(format!("agent authority unreadable: {e}")))?;
    let is_builtin = agent_id == BUILTIN_JARVIS_AGENT_ID;
    match agent {
        Some(row) if !row.enabled => Err(ActivationDenial::WaitingForUser(format!(
            "Agent '{}' is disabled; reactivate it to resume unattended activation",
            agent_id
        ))),
        Some(_) => resolve_projection_snapshot(conn, agent_id, is_builtin),
        None if is_builtin => {
            // The built-in Jarvis identity is the default runtime authority; it
            // is permitted without an explicit agents row. Any OTHER unknown id
            // is not Jarvis and is blocked.
            resolve_projection_snapshot(conn, agent_id, true)
        }
        None => Err(ActivationDenial::Blocked(format!(
            "unknown Agent '{}'; no Agent authority exists",
            agent_id
        ))),
    }
}

/// Validate the projection for an Agent. A built-in agent may run with no
/// projection (legacy default); a custom agent, or any agent that has a
/// projection row, must present a valid/active/non-stale projection.
fn resolve_projection_snapshot(
    conn: &rusqlite::Connection,
    agent_id: &str,
    builtin_allowed: bool,
) -> Result<crate::cron_scheduler::ProjectionSnapshot, ActivationDenial> {
    match fetch_agent_projection(conn, agent_id) {
        Err(e) => Err(ActivationDenial::Blocked(format!(
            "agent projection authority unreadable: {e}"
        ))),
        Ok(Some(projection)) => {
            if projection.status != "valid" {
                return Err(ActivationDenial::Blocked(format!(
                    "agent projection '{}' is invalid",
                    agent_id
                )));
            }
            if !projection.active {
                return Err(ActivationDenial::Blocked(format!(
                    "agent projection '{}' is inactive",
                    agent_id
                )));
            }
            let Some(activated_at) = projection.activated_at.clone() else {
                return Err(ActivationDenial::Blocked(format!(
                    "agent projection '{}' is stale (never activated)",
                    agent_id
                )));
            };
            if projection.source_hash.is_empty()
                || projection.active_source_hash != projection.source_hash
            {
                return Err(ActivationDenial::Blocked(format!(
                    "agent projection '{}' is stale (source hash mismatch)",
                    agent_id
                )));
            }
            Ok(crate::cron_scheduler::ProjectionSnapshot {
                slug: projection.slug,
                source_path: projection.source_path,
                source_hash: projection.source_hash,
                active_source_hash: projection.active_source_hash,
                projection_version: projection.projection_version,
                activated_at,
            })
        }
        Ok(None) => {
            if builtin_allowed {
                // The canonical built-in Jarvis runs on the default runtime
                // instructions; this is the one legacy path that needs no row.
                Ok(crate::cron_scheduler::ProjectionSnapshot {
                    slug: agent_id.to_string(),
                    source_path: String::new(),
                    source_hash: String::new(),
                    active_source_hash: String::new(),
                    projection_version: 0,
                    activated_at: String::new(),
                })
            } else {
                Err(ActivationDenial::Blocked(format!(
                    "agent '{}' has no activated projection; refusing a privileged fallback",
                    agent_id
                )))
            }
        }
    }
}

pub(crate) fn activate_projection_row(
    conn: &Connection,
    projection: AgentProjectionInput,
) -> Result<AgentProjection, String> {
    let slug = projection.slug.trim().to_string();
    if slug.is_empty() || projection.status != "valid" {
        return Err("a valid Agent projection is required".to_string());
    }
    if projection.source_path.trim().is_empty() || !valid_projection_hash(&projection.source_hash) {
        return Err("a source path and SHA-256 source hash are required".to_string());
    }

    let previous = fetch_agent_projection(conn, &slug)?;
    let same_active_projection = previous
        .as_ref()
        .map(|row| row.active && row.source_hash == projection.source_hash)
        .unwrap_or(false);
    let projection_version = if same_active_projection {
        previous
            .as_ref()
            .map(|row| row.projection_version)
            .unwrap_or(1)
    } else {
        previous
            .as_ref()
            .map(|row| row.projection_version + 1)
            .unwrap_or(1)
    };
    let now = chrono::Utc::now().to_rfc3339();
    let activated_at = previous
        .as_ref()
        .and_then(|row| row.activated_at.clone())
        .unwrap_or_else(|| now.clone());
    let tools_json = projection
        .tools
        .as_ref()
        .map(|tools| serde_json::to_string(tools).map_err(|e| e.to_string()))
        .transpose()?;

    conn.execute(
        "INSERT INTO agent_projections
         (slug, source_path, source_hash, projection_version, status, validation_errors,
          name, description, tools_json, version_tag, activated_at, active,
          active_source_hash, source_size_bytes, last_validated_at, deactivated_at, updated_at)
         VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)
         ON CONFLICT(slug) DO UPDATE SET
           source_path = excluded.source_path,
           source_hash = excluded.source_hash,
           projection_version = excluded.projection_version,
           status = excluded.status,
           validation_errors = excluded.validation_errors,
           name = excluded.name,
           description = excluded.description,
           tools_json = excluded.tools_json,
           version_tag = excluded.version_tag,
           activated_at = excluded.activated_at,
           active = 1,
           active_source_hash = excluded.active_source_hash,
           source_size_bytes = excluded.source_size_bytes,
           last_validated_at = excluded.last_validated_at,
           deactivated_at = NULL,
           updated_at = excluded.updated_at",
        params![
            slug,
            projection.source_path,
            projection.source_hash,
            projection_version,
            projection.validation_errors,
            projection.name,
            projection.description,
            tools_json,
            projection.version_tag,
            activated_at,
            projection.source_hash,
            projection.source_size_bytes,
            now,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    fetch_agent_projection(conn, &slug)?
        .ok_or_else(|| "activated projection disappeared during readback".to_string())
}

pub(crate) fn deactivate_projection_row(
    conn: &Connection,
    slug: &str,
) -> Result<Option<AgentProjection>, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE agent_projections
         SET active = 0,
             deactivated_at = COALESCE(deactivated_at, ?),
             updated_at = ?
         WHERE slug = ?",
        params![now, now, slug],
    )
    .map_err(|e| e.to_string())?;
    fetch_agent_projection(conn, slug)
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
///
/// Agent identity is required by `resolve_session_memory_scope`, so removing an
/// Agent changes native memory ownership eligibility. The production adapter
/// enters the derived gate before locking AppDb and resolves the exact affected
/// Sessions for this Agent; `delete_agent_row` stays a pure helper for existing
/// callers and tests.
#[tauri::command]
pub async fn delete_agent(app: AppHandle, id: String) -> Result<(), String> {
    let plan_agent = id.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        String::new(),
        move |conn| {
            // Every Session owned by this Agent is a derived-context consumer.
            let mut affected_session_ids: Vec<String> = Vec::new();
            let mut stmt = conn
                .prepare("SELECT id FROM sessions WHERE agent_id = ?")
                .map_err(MemoryError::from)?;
            let rows = stmt
                .query_map([&plan_agent], |row| row.get::<_, String>(0))
                .map_err(MemoryError::from)?;
            for row in rows {
                affected_session_ids.push(row.map_err(MemoryError::from)?);
            }
            Ok(crate::jarvis::memory::capture_contracts::NativeDerivedMutationPlan {
                invalidation:
                    crate::jarvis::memory::capture_contracts::MemoryDerivedInvalidation {
                        operation_id: uuid::Uuid::new_v4().to_string(),
                        affected_session_ids,
                        memory_ids: Vec::new(),
                        source_message_ids: Vec::new(),
                    },
                scope: None,
            })
        },
        move |conn, _plan| {
            delete_agent_row(conn, &id).map_err(MemoryError::storage_unavailable)
        },
    )
    .await
    .map_err(|error| error.message)
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

#[tauri::command]
pub fn list_agent_projections(db: State<AppDb>) -> Result<Vec<AgentProjection>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    fetch_agent_projections(&conn)
}

#[tauri::command]
pub fn activate_agent_projection(
    db: State<AppDb>,
    projection: AgentProjectionInput,
) -> Result<AgentProjection, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    activate_projection_row(&conn, projection)
}

#[tauri::command]
pub fn deactivate_agent_projection(
    db: State<AppDb>,
    slug: String,
) -> Result<Option<AgentProjection>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    deactivate_projection_row(&conn, &slug)
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

    fn projection(slug: &str, source_hash: &str, version: Option<i64>) -> AgentProjectionInput {
        AgentProjectionInput {
            slug: slug.into(),
            source_path: format!("/agents/{slug}/soul.md"),
            source_hash: source_hash.into(),
            projection_version: version,
            status: "valid".into(),
            name: Some("Coder".into()),
            description: Some("Canonical".into()),
            tools: Some(vec!["search".into()]),
            version_tag: Some("1".into()),
            source_size_bytes: Some(128),
            validation_errors: None,
        }
    }

    #[test]
    fn activation_rejects_invalid_or_unverifiable_projection_input() {
        let conn = test_db();
        let mut invalid = projection("coder", &"a".repeat(64), None);
        invalid.status = "invalid".into();
        assert!(activate_projection_row(&conn, invalid).is_err());

        let invalid_hash = projection("coder", "not-a-sha", None);
        assert!(activate_projection_row(&conn, invalid_hash).is_err());
        assert!(fetch_agent_projections(&conn).unwrap().is_empty());
    }

    #[test]
    fn activation_is_idempotent_for_the_same_source_and_increments_for_a_new_source() {
        let conn = test_db();
        let first = activate_projection_row(&conn, projection("coder", &"a".repeat(64), None)).unwrap();
        assert!(first.active);
        assert_eq!(first.projection_version, 1);

        let same = activate_projection_row(&conn, projection("coder", &"a".repeat(64), None)).unwrap();
        assert_eq!(same.projection_version, 1);

        let changed = activate_projection_row(&conn, projection("coder", &"b".repeat(64), None)).unwrap();
        assert_eq!(changed.projection_version, 2);
        assert_eq!(changed.source_hash, "b".repeat(64));
        assert!(changed.active);
    }

    #[test]
    fn deactivation_preserves_provenance_and_is_idempotent() {
        let conn = test_db();
        let active = activate_projection_row(&conn, projection("coder", &"a".repeat(64), None)).unwrap();
        let inactive = deactivate_projection_row(&conn, "coder").unwrap().expect("projection");
        assert!(!inactive.active);
        assert!(inactive.activated_at.is_some());
        assert!(inactive.deactivated_at.is_some());
        assert_eq!(inactive.source_hash, active.source_hash);
        assert_eq!(deactivate_projection_row(&conn, "coder").unwrap().expect("projection").active, false);
    }

    #[test]
    fn activation_state_survives_database_reopen() {
        let dir = std::env::temp_dir().join(format!("jarvis-agent-projection-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AppDb::new(&dir).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            activate_projection_row(&conn, projection("coder", &"a".repeat(64), None)).unwrap();
        }
        drop(db);
        let reopened = AppDb::new(&dir).unwrap();
        let conn = reopened.conn.lock().unwrap();
        let rows = fetch_agent_projections(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].active);
        drop(conn);
        drop(reopened);
        let _ = std::fs::remove_dir_all(dir);
    }
}
