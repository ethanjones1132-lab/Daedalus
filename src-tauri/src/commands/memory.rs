}

#[tauri::command]
pub fn list_memory_files(path: String) -> Result<Vec<String>, String> {
    let expanded = expand_path_safe(&path)?;

    if !expanded.exists() {
        return Ok(Vec::new());
    }

    let entries =
        std::fs::read_dir(&expanded).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut files = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            let file_type = entry.file_type();
            if let Ok(ft) = file_type {
                if ft.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.ends_with(".md") {
                        files.push(name);
                    }
                }
            }
        }
    }

    // Sort descending so newer files (often named with dates) appear first
    files.sort_by(|a, b| b.cmp(a));

    Ok(files)
}

#[tauri::command]
pub fn read_memory_file(path: String) -> Result<String, String> {
    let expanded = expand_path_safe(&path)?;

    std::fs::read_to_string(&expanded).map_err(|e| format!("Failed to read memory file: {}", e))
}

#[tauri::command]
pub fn list_recent_memories(
    db: State<AppDb>,
    limit: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let lim = limit.unwrap_or(10);

    let mut stmt = conn
        .prepare("SELECT id, title, content, category, confidence, created_at FROM memory ORDER BY created_at DESC LIMIT ?")
        .map_err(|e| format!("Failed to prepare SQL query: {}", e))?;

    let rows = stmt
        .query_map([lim], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let content: String = row.get(2)?;
            let category: String = row.get(3)?;
            let confidence: f64 = row.get(4)?;