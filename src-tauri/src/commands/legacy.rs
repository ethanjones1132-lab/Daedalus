use crate::parsers::*;
use crate::types::*;
use crate::wsl::{wsl_home, wsl_openclaw, wsl_read_file};

#[tauri::command]
pub async fn get_agents() -> Result<serde_json::Value, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["agents", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse agents JSON: {}", e))
}

#[tauri::command]
pub async fn get_dashboard() -> Result<serde_json::Value, String> {
    let (status_str, sessions_str) = tokio::join!(
        tokio::task::spawn_blocking(|| wsl_openclaw(&["status", "--json"])),
        tokio::task::spawn_blocking(|| wsl_openclaw(&["sessions", "--json", "--all-agents"])),
    );
    let status_str = status_str.map_err(|e| format!("Task join error: {}", e))??;
    let sessions_str = sessions_str.map_err(|e| format!("Task join error: {}", e))??;
    let status_json: serde_json::Value = serde_json::from_str(&status_str).map_err(|e| format!("Failed to parse status JSON: {}", e))?;
    let sessions_json: serde_json::Value = serde_json::from_str(&sessions_str).map_err(|e| format!("Failed to parse sessions JSON: {}", e))?;
    let status = parse_dashboard_status(&status_json)?;
    let agents = parse_agents(&status_json);
    let mut sessions = parse_sessions_from_list(&sessions_json);
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(serde_json::json!({ "status": status, "agents": agents, "sessions": sessions }))
}

#[tauri::command]
pub async fn get_cron_jobs() -> Result<Vec<CronJob>, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["cron", "list", "--json", "--all"])).await.map_err(|e| format!("Task join error: {}", e))??;
    let raw: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse cron JSON: {}", e))?;
    Ok(parse_cron_jobs(&raw))
}

#[tauri::command]
pub async fn get_skills() -> Result<SkillsList, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["skills", "list", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    let raw: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse skills JSON: {}", e))?;
    parse_skills(&raw)
}

#[tauri::command]
pub async fn get_nodes() -> Result<serde_json::Value, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["nodes", "list", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse nodes JSON: {}", e))
}

#[tauri::command]
pub async fn get_channels() -> Result<serde_json::Value, String> {
    let (list_str, status_str) = tokio::join!(
        tokio::task::spawn_blocking(|| wsl_openclaw(&["channels", "list", "--json"])),
        tokio::task::spawn_blocking(|| wsl_openclaw(&["channels", "status", "--json"])),
    );
    let list_str = list_str.map_err(|e| format!("Task join error: {}", e))??;
    let status_str = status_str.map_err(|e| format!("Task join error: {}", e))??;
    let list: serde_json::Value = serde_json::from_str(&list_str).map_err(|e| format!("Failed to parse channels list JSON: {}", e))?;
    let status: serde_json::Value = serde_json::from_str(&status_str).map_err(|e| format!("Failed to parse channels status JSON: {}", e))?;
    Ok(serde_json::json!({ "list": list, "status": status }))
}

#[tauri::command]
pub async fn get_models() -> Result<serde_json::Value, String> {
    let (status_str, list_str) = tokio::join!(
        tokio::task::spawn_blocking(|| wsl_openclaw(&["models", "status", "--json"])),
        tokio::task::spawn_blocking(|| wsl_openclaw(&["models", "list", "--json"])),
    );
    let status_str = status_str.map_err(|e| format!("Task join error: {}", e))??;
    let list_str = list_str.map_err(|e| format!("Task join error: {}", e))??;
    let status: serde_json::Value = serde_json::from_str(&status_str).map_err(|e| format!("Failed to parse models status JSON: {}", e))?;
    let list: serde_json::Value = serde_json::from_str(&list_str).map_err(|e| format!("Failed to parse models list JSON: {}", e))?;
    Ok(serde_json::json!({ "status": status, "models": parse_models(&list) }))
}

#[tauri::command]
pub async fn get_plugins() -> Result<Vec<PluginInfo>, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["plugins", "list", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    let raw: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse plugins JSON: {}", e))?;
    Ok(parse_plugins(&raw))
}

#[tauri::command]
pub async fn get_memory_status() -> Result<serde_json::Value, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["memory", "status", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse memory JSON: {}", e))
}

#[tauri::command]
pub async fn get_tasks() -> Result<serde_json::Value, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["tasks", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse tasks JSON: {}", e))
}

#[tauri::command]
pub async fn get_health() -> Result<serde_json::Value, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["health", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse health JSON: {}", e))
}

#[tauri::command]
pub async fn get_logs(limit: Option<u64>) -> Result<serde_json::Value, String> {
    let limit_val = limit.unwrap_or(50).to_string();
    let json_str = tokio::task::spawn_blocking(move || wsl_openclaw(&["logs", "--json", "--limit", &limit_val])).await.map_err(|e| format!("Task join error: {}", e))??;
    serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse logs JSON: {}", e))
}

#[tauri::command]
pub async fn get_config() -> Result<ConfigData, String> {
    let path = wsl_openclaw(&["config", "file"])?;
    let path = path.trim().to_string();
    let path_clone = path.clone();
    let content_str = tokio::task::spawn_blocking(move || wsl_read_file(&path_clone)).await.map_err(|e| format!("Task join error: {}", e))??;
    let content: serde_json::Value = serde_json::from_str(&content_str).map_err(|e| format!("Failed to parse config JSON: {}", e))?;
    Ok(ConfigData { path, content })
}

#[tauri::command]
pub async fn get_sessions() -> Result<Vec<SessionSummary>, String> {
    let json_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["sessions", "--json", "--all-agents"])).await.map_err(|e| format!("Task join error: {}", e))??;
    let raw: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| format!("Failed to parse sessions JSON: {}", e))?;
    let mut sessions = parse_sessions_from_list(&raw);
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub async fn get_status() -> Result<DashboardStatus, String> {
    let status_str = tokio::task::spawn_blocking(|| wsl_openclaw(&["status", "--json"])).await.map_err(|e| format!("Task join error: {}", e))??;
    let raw: serde_json::Value = serde_json::from_str(&status_str).map_err(|e| format!("Failed to parse status JSON: {}", e))?;
    parse_dashboard_status(&raw)
}

#[tauri::command]
pub async fn get_session_history(session_key: String, limit: Option<i64>) -> Result<SessionHistory, String> {
    let parts: Vec<&str> = session_key.split(':').collect();
    let agent_id = if parts.len() >= 2 { parts[1] } else { "main" };
    let home = wsl_home();
    let sessions_json_path = format!("{}/.openclaw/agents/{}/sessions/sessions.json", home, agent_id);
    let sessions_str = tokio::task::spawn_blocking(move || wsl_read_file(&sessions_json_path)).await.map_err(|e| format!("Task join error: {}", e))??;
    let sessions_map: serde_json::Value = serde_json::from_str(&sessions_str).map_err(|e| format!("Failed to parse sessions.json: {}", e))?;
    let session_entry = sessions_map.as_object().and_then(|obj| obj.get(&session_key)).ok_or_else(|| format!("Session not found: {}", session_key))?;
    let session_id = session_entry.get("sessionId").and_then(|v| v.as_str()).ok_or("Session has no sessionId")?;
    let agent_id_from_entry = session_entry.get("agentId").and_then(|v| v.as_str()).unwrap_or(agent_id).to_string();
    let jsonl_path = format!("{}/.openclaw/agents/{}/sessions/{}.jsonl", home, agent_id, session_id);
    let jsonl_content = tokio::task::spawn_blocking(move || wsl_read_file(&jsonl_path)).await.map_err(|e| format!("Task join error: {}", e))??;

    let msg_limit = limit.unwrap_or(200);
    let mut messages = Vec::new();
    for line in jsonl_content.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if messages.len() >= msg_limit as usize { break; }
        if let Ok(msg_json) = serde_json::from_str::<serde_json::Value>(line) {
            let role = msg_json.get("role").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            let content = msg_json.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let timestamp = msg_json.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string());
            messages.push(ChatMessage { role, content, timestamp });
        }
    }

    Ok(SessionHistory {
        session_key: session_key.clone(),
        agent_id: agent_id_from_entry,
        session_id: session_id.to_string(),
        messages,
    })
}