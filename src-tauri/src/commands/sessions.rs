// ═══════════════════════════════════════════════════════════════
// Session Commands — SQLite-backed session management
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use crate::jarvis::memory::contracts::MemoryError;
use rusqlite::OptionalExtension;
use tauri::{AppHandle, Manager, State};

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
    app: AppHandle,
    _db: State<'_, AppDb>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    // Take the sanitized, suppression-aware transcript snapshot under the
    // operation gate (pending-cleanup drain + revision capture) so a forgotten
    // or corrected source can never enter the model-facing summary and no
    // unrelated mutation can interleave. Run on a blocking thread so the
    // bounded HTTP does not block the Tauri executor; a cleanup failure
    // surfaces as a typed error rather than a stale summary.
    let app_for_snapshot = app.clone();
    let session_for_snapshot = session_id.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_snapshot.state::<AppDb>();
        crate::jarvis::memory::transport::snapshot_sanitized_session_messages(
            state.inner(),
            crate::jarvis::memory::transport::native_memory_transport(),
            &session_for_snapshot,
            chrono::Utc::now(),
        )
        .map_err(|error| error.message)
    })
    .await
    .map_err(|error| format!("memory snapshot task join error: {error}"))??;

    let messages: Vec<(String, String)> = snapshot
        .messages
        .iter()
        .map(|message| (message.role.clone(), message.content.clone()))
        .collect();

    if messages.len() < 4 {
        return Ok(serde_json::json!({ "compacted": false, "reason": "too few messages" }));
    }

    let split = messages.len() / 2;
    let (old, recent) = messages.split_at(split);
    let summary = compact_messages(old, "http://127.0.0.1:11434", "qwen2.5:7b", 1024).await?;

    // Refuse to publish a summary built from a snapshot that a memory mutation
    // invalidated while the model was running. The raw stale summary never
    // returns; the caller may retry against a fresh sanitized snapshot.
    let app_for_recheck = app.clone();
    let session_for_recheck = session_id.clone();
    let (store_revision, continuity_revision, session_binding_revision) =
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_for_recheck.state::<AppDb>();
            crate::jarvis::memory::transport::memory_context_revisions(
                state.inner(),
                &session_for_recheck,
            )
            .map_err(|error| error.message)
        })
        .await
        .map_err(|error| format!("memory revision recheck task join error: {error}"))??;
    if store_revision != snapshot.store_revision
        || continuity_revision != snapshot.continuity_revision
        || session_binding_revision != snapshot.session_binding_revision
    {
        return Ok(serde_json::json!({
            "compacted": false,
            "reason": "memory_invalidated",
        }));
    }

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
    /// Explicit, validated project workspace binding, if any. `None` means
    /// the Session has no project scope (Agent scope only).
    pub project_root: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionRunRecord {
    pub session_id: String,
    pub run_id: String,
    pub outcome: String,
    pub selected_model: Option<String>,
    pub token_count: i64,
    pub tool_count: i64,
    pub cancelled_reason: Option<String>,
    pub partial_output: Option<String>,
}

/// Persist the terminal outcome of one native SSE turn. `run_id` is emitted
/// by the Bun pipeline and is the durable idempotency key for relay retries.
pub fn persist_terminal_run(
    db: &AppDb,
    session_id: &str,
    run_id: &str,
    outcome: &str,
    selected_model: Option<&str>,
    token_count: i64,
    tool_count: i64,
    cancelled_reason: Option<&str>,
    partial_output: Option<&str>,
) -> Result<SessionRunRecord, String> {
    if !matches!(
        outcome,
        "success" | "partial" | "failed" | "timed_out" | "cancelled"
    ) {
        return Err(format!("invalid terminal outcome: {outcome}"));
    }
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    persist_terminal_run_conn(
        &conn,
        session_id,
        run_id,
        outcome,
        selected_model,
        token_count,
        tool_count,
        cancelled_reason,
        partial_output,
    )
}

pub fn persist_terminal_run_at(
    db_path: &std::path::Path,
    session_id: &str,
    run_id: &str,
    outcome: &str,
    selected_model: Option<&str>,
    token_count: i64,
    tool_count: i64,
    cancelled_reason: Option<&str>,
    partial_output: Option<&str>,
) -> Result<SessionRunRecord, String> {
    let conn = rusqlite::Connection::open(db_path)
        .map_err(|e| format!("Failed to open session database: {e}"))?;
    persist_terminal_run_conn(
        &conn,
        session_id,
        run_id,
        outcome,
        selected_model,
        token_count,
        tool_count,
        cancelled_reason,
        partial_output,
    )
}

fn persist_terminal_run_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    run_id: &str,
    outcome: &str,
    selected_model: Option<&str>,
    token_count: i64,
    tool_count: i64,
    cancelled_reason: Option<&str>,
    partial_output: Option<&str>,
) -> Result<SessionRunRecord, String> {
    if !matches!(
        outcome,
        "success" | "partial" | "failed" | "timed_out" | "cancelled"
    ) {
        return Err(format!("invalid terminal outcome: {outcome}"));
    }
    conn.execute(
        "INSERT INTO session_runs
         (run_id, session_id, outcome, selected_model, token_count, tool_count, cancelled_reason, partial_output, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(run_id) DO UPDATE SET
           outcome=excluded.outcome, selected_model=excluded.selected_model,
           token_count=excluded.token_count, tool_count=excluded.tool_count,
           cancelled_reason=excluded.cancelled_reason, partial_output=excluded.partial_output,
           finished_at=excluded.finished_at",
        rusqlite::params![
            run_id, session_id, outcome, selected_model, token_count.max(0), tool_count.max(0),
            cancelled_reason, partial_output,
        ],
    )
    .map_err(|e| format!("Failed to persist terminal session run: {e}"))?;
    Ok(SessionRunRecord {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        outcome: outcome.to_string(),
        selected_model: selected_model.map(str::to_string),
        token_count: token_count.max(0),
        tool_count: tool_count.max(0),
        cancelled_reason: cancelled_reason.map(str::to_string),
        partial_output: partial_output.map(str::to_string),
    })
}

/// List every terminal run recorded for a single session, newest first.
pub fn list_session_runs(db: &AppDb, session_id: &str) -> Result<Vec<SessionRunRecord>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT session_id, run_id, outcome, selected_model, token_count, tool_count,
                    cancelled_reason, partial_output, finished_at
             FROM session_runs WHERE session_id = ? ORDER BY finished_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok(SessionRunRecord {
                session_id: row.get(0)?,
                run_id: row.get(1)?,
                outcome: row.get(2)?,
                selected_model: row.get(3)?,
                token_count: row.get(4)?,
                tool_count: row.get(5)?,
                cancelled_reason: row.get(6)?,
                partial_output: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

/// List all terminal runs across every session, newest first.
pub fn list_all_session_runs(db: &AppDb) -> Result<Vec<SessionRunRecord>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT session_id, run_id, outcome, selected_model, token_count, tool_count,
                    cancelled_reason, partial_output, finished_at
             FROM session_runs ORDER BY finished_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SessionRunRecord {
                session_id: row.get(0)?,
                run_id: row.get(1)?,
                outcome: row.get(2)?,
                selected_model: row.get(3)?,
                token_count: row.get(4)?,
                tool_count: row.get(5)?,
                cancelled_reason: row.get(6)?,
                partial_output: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
pub fn get_session_runs(
    db: State<AppDb>,
    session_id: String,
) -> Result<Vec<SessionRunRecord>, String> {
    list_session_runs(&db, &session_id)
}

#[tauri::command]
pub fn get_all_session_runs(db: State<AppDb>) -> Result<Vec<SessionRunRecord>, String> {
    list_all_session_runs(&db)
}

/// Task 4.1: the webview streams `/chat/stream` directly from the Bun server
/// (JarvisView.tsx), bypassing the Rust SSE relay in `jarvis/runner.rs` that
/// owns terminal-run persistence — which is why `session_runs` stayed empty
/// while the UI was in daily use (the 2026-07-12 force-stop left no trace).
/// The UI observes every terminal SSE frame anyway; this command lets it
/// report the outcome it saw, keeping the native SQLite store the single
/// durable authority (the Bun server still never writes session tables).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn record_terminal_run(
    db: State<AppDb>,
    session_id: String,
    run_id: String,
    outcome: String,
    selected_model: Option<String>,
    token_count: i64,
    tool_count: i64,
    cancelled_reason: Option<String>,
    partial_output: Option<String>,
) -> Result<SessionRunRecord, String> {
    persist_terminal_run(
        &db,
        &session_id,
        &run_id,
        &outcome,
        selected_model.as_deref(),
        token_count,
        tool_count,
        cancelled_reason.as_deref(),
        partial_output.as_deref(),
    )
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
                    COALESCE((SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id), 0),
                    s.project_root
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
                project_root: row.get(11)?,
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
        project_root: None,
    })
}

pub fn delete_session_row_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<bool, String> {
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

pub fn delete_session_row(db: &AppDb, session_id: &str) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    delete_session_row_conn(&conn, session_id)
}

#[tauri::command]
pub fn update_token_count(
    db: State<AppDb>,
    session_id: String,
    tokens_in: i64,
    tokens_out: i64,
) -> Result<(), String> {
    update_db_token_count(db, &session_id, tokens_in, tokens_out)
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
pub async fn delete_session(app: AppHandle, session_id: String) -> Result<bool, String> {
    super::memory_turn::run_derived_gated_mutation(
        app,
        session_id.clone(),
        {
            let session_for_plan = session_id.clone();
            move |_conn| {
                // The deleted Session's own derived prompt state must be evicted
                // before it disappears; the outbox row has no Session FK, so it
                // survives that Session's deletion and the drain reuses the
                // exact original initiating-Session wire key.
                Ok(crate::jarvis::memory::capture_contracts::NativeDerivedMutationPlan {
                    invalidation:
                        crate::jarvis::memory::capture_contracts::MemoryDerivedInvalidation {
                            operation_id: uuid::Uuid::new_v4().to_string(),
                            affected_session_ids: vec![session_for_plan],
                            memory_ids: Vec::new(),
                            source_message_ids: Vec::new(),
                        },
                    scope: None,
                })
            }
        },
        move |conn, _plan| {
            delete_session_row_conn(conn, &session_id).map_err(MemoryError::storage_unavailable)
        },
    )
    .await
    .map_err(|error| error.message)
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

/// Prior messages for the Bun `/chat/stream` body (excludes the in-flight user turn).
pub fn history_for_chat_stream(
    db: &AppDb,
    session_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        let (role, content) = row;
        if ["user", "assistant", "system", "tool"].contains(&role.as_str()) {
            out.push(serde_json::json!({ "role": role, "content": content }));
        }
    }
    Ok(out)
}

/// Insert a message row (shared by Tauri command + jarvis_send_message).
pub fn insert_message_row(
    db: &AppDb,
    session_id: &str,
    role: &str,
    content: &str,
    tokens: i64,
) -> Result<String, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    insert_message_row_conn(&conn, session_id, role, content, tokens, None)
}

/// Read the single assistant message already associated with one turn, if any.
fn existing_turn_message_id(
    conn: &rusqlite::Connection,
    turn_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT message_id FROM memory_turn_messages WHERE turn_id = ? LIMIT 1",
        [turn_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("Failed to read turn association: {}", e))
}

/// Insert a message row inside one SQLite transaction. When `memory_turn_id` is
/// supplied for an assistant message, the whole append is atomic at-most-once for
/// that turn:
///
/// 1. The persisted Session/turn identity is validated from the canonical
///    `memory_turn_preparations` row.
/// 2. If the turn already owns an assistant association, an exact-content replay
///    returns that existing DB message id with no new write; differing content is
///    rejected as a conflict. This removes the race-prone pre-check.
/// 3. Otherwise the row is inserted, associated, and — in the same transaction —
///    the model-facing transcript is neutralized for any selected/applied memory
///    the turn used that has since been invalidated.
///
/// This is transcript association only and never confers factual authority.
/// Callers that omit the turn id retain the original behavior exactly.
pub fn insert_message_row_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    role: &str,
    content: &str,
    tokens: i64,
    memory_turn_id: Option<&str>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Failed to begin message transaction: {}", e))?;

    if let Some(turn_id) = memory_turn_id {
        // Association is only defined for a persisted assistant message tied to
        // the exact same Session/turn. A cross-Session or non-assistant pairing
        // is rejected before any write.
        if role != "assistant" {
            return Err("Memory turn association requires an assistant message".to_string());
        }
        let persisted = crate::jarvis::memory::turn::read_memory_turn(&tx, session_id, turn_id)
            .map_err(|_| "Memory turn does not belong to this Session".to_string())?;

        // Atomic at-most-once: an already associated row is authoritative for
        // this turn. Exact content is an idempotent replay of the same append;
        // any other content is a conflicting append and is rejected.
        if let Some(existing_id) = existing_turn_message_id(&tx, turn_id)? {
            let existing: Option<(String, String)> = tx
                .query_row(
                    "SELECT role, content FROM messages WHERE id = ? AND session_id = ?",
                    rusqlite::params![&existing_id, session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| format!("Failed to read associated message: {}", e))?;
            return match existing {
                Some((existing_role, existing_content))
                    if existing_role == "assistant" && existing_content == content =>
                {
                    Ok(existing_id)
                }
                _ => Err(
                    "Memory turn already has a different assistant message".to_string(),
                ),
            };
        }

        tx.execute(
            "INSERT INTO messages (id, session_id, role, content, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![&id, session_id, role, content, tokens, &now],
        )
        .map_err(|e| format!("Failed to insert message: {}", e))?;
        tx.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            rusqlite::params![&now, session_id],
        )
        .map_err(|e| format!("Failed to update session timestamp: {}", e))?;

        tx.execute(
            "INSERT INTO memory_turn_messages (turn_id, message_id) VALUES (?, ?)",
            rusqlite::params![turn_id, &id],
        )
        .map_err(|e| format!("Failed to associate assistant message with turn: {}", e))?;

        // Same-transaction late-write barrier: neutralize the model-facing
        // transcript for any invalidated memory this turn selected/applied. The
        // operator transcript row itself stays raw.
        crate::jarvis::memory::continuity::suppress_invalidated_turn_attachments(
            &tx,
            &persisted,
            &id,
            chrono::Utc::now(),
        )
        .map_err(|e| e.message)?;

        tx.commit()
            .map_err(|e| format!("Failed to commit message transaction: {}", e))?;
        return Ok(id);
    }

    tx.execute(
        "INSERT INTO messages (id, session_id, role, content, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![&id, session_id, role, content, tokens, &now],
    )
    .map_err(|e| format!("Failed to insert message: {}", e))?;
    tx.execute(
        "UPDATE sessions SET updated_at = ? WHERE id = ?",
        rusqlite::params![&now, session_id],
    )
    .map_err(|e| format!("Failed to update session timestamp: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit message transaction: {}", e))?;
    Ok(id)
}

#[tauri::command]
pub fn append_message(
    db: State<AppDb>,
    session_id: String,
    role: String,
    content: String,
    tokens: Option<i64>,
    memory_turn_id: Option<String>,
) -> Result<String, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    insert_message_row_conn(
        &conn,
        &session_id,
        &role,
        &content,
        tokens.unwrap_or(0),
        memory_turn_id.as_deref(),
    )
}

/// Awaited assistant append for the relay runner: run the transaction on the
/// caller's blocking thread against the shared AppDb. Returns the generated DB
/// message id.
pub fn append_assistant_message_for_turn(
    db: &AppDb,
    session_id: &str,
    content: &str,
    memory_turn_id: &str,
) -> Result<String, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    insert_message_row_conn(&conn, session_id, "assistant", content, 0, Some(memory_turn_id))
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
        let _b =
            create_session_row(&db, Some("second".into()), None, None, None).expect("create b");

        let listed = list_session_rows(&db).expect("list");
        assert_eq!(listed.len(), 2, "both sessions should be listed");
        assert!(listed.iter().any(|s| s.id == a.id && s.title == "first"));

        assert!(delete_session_row(&db, &a.id).expect("delete"));
        let after = list_session_rows(&db).expect("list after delete");
        assert_eq!(after.len(), 1, "one session remains after delete");
        assert!(!after.iter().any(|s| s.id == a.id));
    }

    #[test]
    fn history_for_chat_stream_returns_prior_messages_in_order() {
        let db = mem_db();
        let session =
            create_session_row(&db, Some("chat".into()), None, None, None).expect("create");
        insert_message_row(&db, &session.id, "user", "hello", 0).expect("user");
        insert_message_row(&db, &session.id, "assistant", "hi there", 0).expect("assistant");
        let history = history_for_chat_stream(&db, &session.id).expect("history");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["role"], "user");
        assert_eq!(history[0]["content"], "hello");
        assert_eq!(history[1]["role"], "assistant");
    }

    #[test]
    fn cancelled_run_persists_a_terminal_outcome() {
        let db = mem_db();
        let session =
            create_session_row(&db, Some("cancel test".into()), None, None, None).expect("create");
        let record = persist_terminal_run(
            &db,
            &session.id,
            "run-cancelled",
            "cancelled",
            Some("deepseek-v4-pro"),
            12,
            1,
            Some("user_stop"),
            Some("partial answer"),
        )
        .expect("persist");
        assert_eq!(record.outcome, "cancelled");
        assert_eq!(record.cancelled_reason.as_deref(), Some("user_stop"));
        assert_eq!(record.partial_output.as_deref(), Some("partial answer"));
    }
}
