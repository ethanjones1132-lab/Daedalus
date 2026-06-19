    }

    Ok(content.to_string())
}

/// Get the total_tokens for a session from the database.
/// This replaces the file-based session::get_token_count().
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
/// This replaces the file-based session::update_token_count().
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

/// DB-backed compaction: reads messages from the DB, compacts the oldest 50%,
/// writes back the compacted summary + remaining messages.
#[tauri::command]
pub async fn compact_session_db(
    db: State<'_, AppDb>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let sid = session_id.clone();
    let db_path = db.db_path.clone();

    // Run the blocking DB read + compaction in spawn_blocking
    let summary = tokio::task::spawn_blocking(move || {
        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| format!("Failed to open DB at {:?}: {}", db_path, e))?;

        // Load messages from DB
        let mut stmt = conn
            .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let messages: Vec<(String, String)> = stmt
            .query_map([&sid], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        if messages.len() < 4 {
            return Ok::<_, String>(None); // signal: too few messages
        }