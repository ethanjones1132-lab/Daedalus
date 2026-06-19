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
            .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let msgs: Vec<(String, String)> = stmt
            .query_map([&sid], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
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
