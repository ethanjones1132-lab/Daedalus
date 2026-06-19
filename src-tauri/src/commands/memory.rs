use crate::db::AppDb;
use crate::jarvis::memory::engine::{self, MemoryEntry, MemoryEvent, MemoryRecall, MemoryRun};
use tauri::State;

#[tauri::command]
pub fn memory_list(db: State<AppDb>) -> Result<Vec<MemoryEntry>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::list_memories(&conn)
}

#[tauri::command]
pub fn memory_read(db: State<AppDb>, id: String) -> Result<MemoryEntry, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::read_memory(&conn, &id)
}

#[tauri::command]
pub fn memory_save(
    db: State<AppDb>,
    title: String,
    content: String,
    tags: Vec<String>,
    category: String,
) -> Result<MemoryEntry, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::save_manual_memory(&conn, title, content, tags, category)
}

#[tauri::command]
pub fn memory_update(
    db: State<AppDb>,
    id: String,
    title: String,
    content: String,
    tags: Vec<String>,
    category: String,
) -> Result<MemoryEntry, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::update_manual_memory(&conn, id, title, content, tags, category)
}

#[tauri::command]
pub fn memory_delete(db: State<AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::tombsto
}

#[tauri::command]
pub fn memory_restore(db: State<AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::restore_memory(&conn, &id)
}

#[tauri::command]
pub fn memory_search(db: State<AppDb>, query: String) -> Result<Vec<MemoryEntry>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::search_memories(&conn, &query)
}

#[tauri::command]
pub fn memory_recall_preview(db: State<AppDb>, query: String) -> Result<Vec<MemoryRecall>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::recall_memories(&conn, &query, 5, false)
}

#[tauri::command]
pub fn memory_events_list(
    db: State<AppDb>,
    memory_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemoryEvent>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::list_memory_events(&conn, memory_id, limit)
}

#[tauri::command]
pub fn memory_runs_list(
    db: State<AppDb>,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemoryRun>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::list_memory_runs(&conn, kind, limit)
}

#[tauri::command]
pub fn memory_run_now(db: State<AppDb>, kind: String) -> Result<MemoryRun, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    match kind.as_str() {
        "consolidation" | "auto_dream" => engine::consolidate_memories(&conn),
        other => Err(format!("Unsupported memory run kind '{}'", other)),
    }
}

fn expand_path_safe(path_str: &str) -> Result<std::path::PathBuf, String> {
    if path_str.contains("..") || path_str.contains('\0') {
        return Err("Path traversal or invalid characters detected".to_string());
    }

    let expanded = if path_str.starts_with('~') {
        let home = crate::get_home_dir();
        let suffix = &path_str[1..];
        let suffix = if suffix.starts_with('/') || suffix.starts_with('\\') {
            &suffix[1..]
        } else {
            suffix
        };
        std::path::PathBuf::from(home).join(suffix)
    } else {
        std::path::PathBuf::from(path_str)
    };

    if !crate::jarvis::memory::paths::is_memory_path(&expanded) {
        return Err("Access denied: path is outside the memory directory".to_string());
    }

    Ok(expanded)
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
            let created_at: String = row.get(5)?;

            let importance = if confidence >= 0.8 {
                "high"
            } else if confidence >= 0.5 {
                "medium"
            } else {
                "low"
            };

            Ok(serde_json::json!({
                "id": id,
                "title": title,
                "content": content,
                "category": category,
                "importance": importance,
                "created_at": created_at,
            }))
        })
        .map_err(|e| format!("Failed to execute SQL query: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        if let Ok(val) = row {
            results.push(val);
        }
    }

    Ok(results)
}
