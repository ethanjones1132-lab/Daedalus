/// Get the currently active model profile (WHERE is_active = 1)
#[tauri::command]
pub async fn get_active_profile(db: State<'_, AppDb>) -> Result<Option<ModelProfile>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id, name, provider, model, api_base, api_key, max_tokens,
                    temperature, top_p, system_prompt, is_active, created_at, updated_at
             FROM model_profiles
             WHERE is_active = 1
             LIMIT 1",
        )
        .map_err(|e| format!("DB prepare error: {}", e))?;

    let result = stmt
        .query_row([], |row| {
            Ok(ModelProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                provider: row.get(2)?,
                model: row.get(3)?,
                api_base: row.get(4)?,
                api_key: row.get(5)?,
                max_tokens: row.get(6)?,
                temperature: row.get(7)?,
                top_p: row.get(8)?,
                system_prompt: row.get(9)?,
                is_active: {
                    let val: i64 = row.get(10)?;
                    val != 0
                },
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })
        .optional()
        .map_err(|e| format!("DB query error: {}", e))?;

    Ok(result)
}

/// Set a profile as active: first clears all is_active, then sets the given one
#[tauri::command]
pub async fn set_active_profile(db: State<'_, AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    // Clear all active flags
    conn.execute("UPDATE model_profiles SET is_active = 0", [])
        .map_err(|e| format!("DB update error: {}", e))?;
    // Set the chosen one
    let rows = conn
        .execute(
            "UPDATE model_profiles SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
            [&id],
        )
        .map_err(|e| format!("DB update error: {}", e))?;
    Ok(rows > 0)
}

/// Create a new model profile
#[tauri::command]
pub async fn create_profile(
    db: State<'_, AppDb>,
    name: String,
    backend: String,
    model: String,
    temperature: f64,
    max_tokens: i64,
    top_p: f64,
) -> Result<ModelProfile, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // Determine api_base from backend
    let api_base = match backend.as_str() {
        "ollama" => "http://localhost:11434/v1".to_string(),
        "openrouter" => "https://openrouter.ai/api/v1".to_string(),
        _ => String::new(),
    };

    conn.execute(
        "INSERT INTO model_profiles (id, name, provider, model, api_base, max_tokens, temperature, top_p, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        [&id, &name, &backend, &model, &api_base, &max_tokens.to_string(), &temperature.to_string(), &top_p.to_string(), &now],
    )
    .map_err(|e| format!("DB insert error: {}", e))?;

    Ok(ModelProfile {
        id,
        name,