// ═══════════════════════════════════════════════════════════════
// Session Commands — SQLite-backed session management
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use tauri::State;

// ── Compaction ────────────────────────────────────────────────

/// Compact messages using a lightweight model via Ollama's Anthropic-compatible endpoint.
async fn compact_messages(
    messages: &[(String, String)],
    ollama_url: &str,
    model: &str,
    max_tokens: usize,
) -> Result<String, String> {
    let url = format!("{}/v1/messages", ollama_url);

    let conversation_text = messages
        .iter()
        .map(|(role, content)| format!("[{}]: {}", role, content))
        .collect::<Vec<_>>()
        .join("\n\n");

    let user_message = format!(
        "Summarize the following conversation concisely. Preserve key facts, decisions, code changes, and context. Use bullet points. Be comprehensive but brief.\n\n{}",
        conversation_text
    );

    // NOTE (recovery): the body of this helper was lost on both ends across every
    // snapshot; reconstructed from the surviving head/tail + the Anthropic-compatible
    // /v1/messages contract. See RECOVERY_STATUS.md.
    let request_body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [ { "role": "user", "content": user_message } ],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Compaction request failed: {}", e))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse compaction response: {}", e))?;

    let content = json
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|block| block.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    Ok(content.to_string())
}

/// Get the total_tokens for a session from the database.
pub fn get_db_token_count(db: State<'_, AppDb>, session_id: &str) -> Result<i64, String> {
    let conn = rusqlite::Connection::open(&db.db_path)
        .map_err(|e| format!("Failed to open DB at {:?}: {}", db.db_path, e))?;
    let result: Result<i64, _> = conn.query_row(
        "SELECT COALESCE(total_tokens, 0) FROM sessions WHERE id = ?",
        [session_id],
        |row| row.get(0),
    );
    match result {
        Ok(count) => Ok(count),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
        Err(e) => Err(e.to_string()),
    }
}

/// Update the total_tokens for a session in the database.
pub fn update_db_token_count(
    db: State<'_, AppDb>,
    session_id: &str,
    tokens_in: i64,
    tokens_out: i64,
) -> Result<(), String> {
    let conn = rusqlite::Connection::open(&db.db_path)
        .map_err(|e| format!("Failed to open DB at {:?}: {}", db.db_path, e))?;
    let total = tokens_in + tokens_out;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE sessions SET total_tokens = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![total, &now, session_id],
    )
    .map_err(|e| format!("Failed to update token count: {}", e))?;
    Ok(())
}

/// DB-backed compaction: reads messages from the DB, summarizes the oldest half
/// via the local model, and returns a summary payload.
#[tauri::command]
pub async fn compact_session_db(
    db: State<'_, AppDb>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let sid = session_id.clone();
    let db_path = db.db_path.clone();

    let messages: Vec<(String, String)> = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| format!("Failed to open DB at {:?}: {}", db_path, e))?;
        let mut stmt = conn
            .prepare(
                "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let msgs: Vec<(String, String)> = stmt
            .query_map([&sid], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(msgs)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if messages.len() < 4 {
        return Ok(serde_json::json!({ "compacted": false, "reason": "too few messages" }));
    }

    let split = messages.len() / 2;
    let (old, recent) = messages.split_at(split);
    let summary = compact_messages(old, "http://127.0.0.1:11434", "qwen2.5:7b", 1024).await?;

    Ok(serde_json::json!({
        "compacted": true,
        "summarized_count": old.len(),
        "remaining_count": recent.len(),
        "summary": summary,
    }))
}

// ── Canonical session command surface ────────────────────────────────
//
// The Tauri commands below were missing from the recovered sessions.rs.
// They're implemented against the same SQLite path that
// `compact_session_db` uses, so they're durable across restarts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub backend: String,
    pub model: String,
    pub context_tokens: i64,
    pub total_tokens: i64,
    pub created_at: String,
    pub updated_at: String,
    pub archived: bool,
    pub message_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMessageOut {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub tokens: i64,
    pub tool_calls: Option<String>,
    pub created_at: String,
}

// ── &AppDb helpers ───────────────────────────────────────────────────
//
// These hold the canonical SQLite session logic. Both the native "Sessions"
// command surface AND the `jarvis_*` chat-session commands call them, so there
// is exactly ONE session store (SQLite). The legacy file store under
// `~/.openclaw/jarvis/sessions/` was retired in Phase 1.2.

pub fn list_session_rows(db: &AppDb) -> Result<Vec<SessionSummary>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.agent_id, s.title, s.backend, s.model,
                    COALESCE(s.context_tokens, 0), COALESCE(s.total_tokens, 0),
                    s.created_at, s.updated_at, COALESCE(s.archived, 0),
                    COALESCE((SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id), 0)
             FROM sessions s
             ORDER BY s.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SessionSummary {
                id: row.get(0)?,
                agent_id: row.get(1)?,
                title: row.get(2)?,
                backend: row.get(3)?,
                model: row.get(4)?,
                context_tokens: row.get(5)?,
                total_tokens: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                archived: row.get::<_, i64>(9)? != 0,
                message_count: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

pub fn create_session_row(
    db: &AppDb,
    title: Option<String>,
    agent_id: Option<String>,
    backend: Option<String>,
    model: Option<String>,
) -> Result<SessionSummary, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let title = title.unwrap_or_else(|| "Untitled session".to_string());
    let agent_id = agent_id.unwrap_or_else(|| "main".to_string());
    let backend = backend.unwrap_or_else(|| "ollama".to_string());
    let model = model.unwrap_or_else(|| "qwen3:8b".to_string());
    conn.execute(
        "INSERT INTO sessions (id, agent_id, title, backend, model, created_at, updated_at, archived, context_tokens, total_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)",
        rusqlite::params![&id, &agent_id, &title, &backend, &model, &now, &now],
    )
    .map_err(|e| format!("Failed to insert session: {}", e))?;
    Ok(SessionSummary {
        id,
        agent_id,
        title,
        backend,
        model,
        context_tokens: 0,
        total_tokens: 0,
        created_at: now.clone(),
        updated_at: now,
        archived: false,
        message_count: 0,
    })
}

pub fn delete_session_row(db: &AppDb, session_id: &str) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.execute(
        "DELETE FROM messages WHERE session_id = ?",
        rusqlite::params![session_id],
    )
    .map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "DELETE FROM sessions WHERE id = ?",
            rusqlite::params![session_id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

#[tauri::command]
pub fn list_sessions(db: State<AppDb>) -> Result<Vec<SessionSummary>, String> {
    list_session_rows(&db)
}

#[tauri::command]
pub fn create_session(
    db: State<AppDb>,
    title: Option<String>,
    agent_id: Option<String>,
    backend: Option<String>,
    model: Option<String>,
) -> Result<SessionSummary, String> {
    create_session_row(&db, title, agent_id, backend, model)
}

#[tauri::command]
pub fn delete_session(db: State<AppDb>, session_id: String) -> Result<bool, String> {
    delete_session_row(&db, &session_id)
}

#[tauri::command]
pub fn get_session_history(
    db: State<AppDb>,
    session_id: String,
) -> Result<Vec<SessionMessageOut>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, role, content, COALESCE(tokens, 0), tool_calls, created_at
             FROM messages WHERE session_id = ? ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&session_id], |row| {
            Ok(SessionMessageOut {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tokens: row.get(4)?,
                tool_calls: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for m in rows.flatten() {
        out.push(m);
    }
    Ok(out)
}

#[tauri::command]
pub fn append_message(
    db: State<AppDb>,
    session_id: String,
    role: String,
    content: String,
    tokens: Option<i64>,
) -> Result<String, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let t = tokens.unwrap_or(0);
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![&id, &session_id, &role, &content, t, &now],
    )
    .map_err(|e| format!("Failed to insert message: {}", e))?;
    // Bump session's updated_at so list_sessions reorders correctly.
    let _ = conn.execute(
        "UPDATE sessions SET updated_at = ? WHERE id = ?",
        rusqlite::params![&now, &session_id],
    );
    Ok(id)
}

#[tauri::command]
pub fn export_session(
    db: State<AppDb>,
    session_id: String,
    out_path: String,
) -> Result<String, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, role, content, COALESCE(tokens, 0), tool_calls, created_at
             FROM messages WHERE session_id = ? ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&session_id], |row| {
            Ok(SessionMessageOut {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tokens: row.get(4)?,
                tool_calls: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = String::from("# Session export\n\n");
    for m in rows.flatten() {
        out.push_str(&format!(
            "## {} ({})\n\n{}\n\n",
            m.role, m.created_at, m.content
        ));
    }
    std::fs::write(&out_path, out).map_err(|e| format!("Failed to write export: {}", e))?;
    Ok(out_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;
    use rusqlite::Connection;
    use std::sync::Mutex;

    fn mem_db() -> AppDb {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run_migrations(&conn).expect("run migrations");
        AppDb {
            conn: Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    #[test]
    fn session_rows_round_trip_through_sqlite() {
        let db = mem_db();
        let a = create_session_row(
            &db,
            Some("first".into()),
            Some("main".into()),
            Some("ollama".into()),
            Some("qwen3:8b".into()),
        )
        .expect("create a");
        let _b = create_session_row(&db, Some("second".into()), None, None, None).expect("create b");

        let listed = list_session_rows(&db).expect("list");
        assert_eq!(listed.len(), 2, "both sessions should be listed");
        assert!(listed.iter().any(|s| s.id == a.id && s.title == "first"));

        assert!(delete_session_row(&db, &a.id).expect("delete"));
        let after = list_session_rows(&db).expect("list after delete");
        assert_eq!(after.len(), 1, "one session remains after delete");
        assert!(!after.iter().any(|s| s.id == a.id));
    }
}
