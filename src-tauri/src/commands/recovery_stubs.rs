// Recovery command stubs.
//
// RECOVERY NOTE (2026-06-19):
//   A handful of jarvis_* Tauri commands referenced in lib.rs's
//   `tauri::generate_handler!` were never recovered from any snapshot
//   or transcript. The two Tauri commands the front-end hits on every
//   page (jarvis_get_skills, jarvis_get_tools) and the seven that gate
//   the companion / model / health UI are stubbed here with typed
//   responses that match the TS interfaces in
//   src-ui/src/components/jarvis/types.ts.
//
//   Each stub is intentionally minimal: it returns a stable, schema-
//   matching payload so the UI renders without throwing, and the
//   caller's error path can be exercised. Real implementations belong
//   in a follow-up pass once the Bun server is reachable again and the
//   engine layer can talk to it.
//
//   The whole module is gated behind `#[allow(dead_code)]` so unused
//   fields don't trip the linter.

#![allow(dead_code)]

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct JarvisSkillStub {
    pub name: String,
    pub description: String,
    pub category: String,
    pub enabled: bool,
    pub source: String,
    pub usage_count: u64,
}

#[derive(Serialize)]
pub struct JarvisToolParamStub {
    pub name: String,
    pub param_type: String,
    pub description: String,
    pub required: bool,
    pub default_value: Option<String>,
}

#[derive(Serialize)]
pub struct JarvisToolStub {
    pub name: String,
    pub description: String,
    pub parameters: Vec<JarvisToolParamStub>,
}

#[derive(Serialize)]
pub struct JarvisCompanionStub {
    pub enabled: bool,
    pub name: String,
    pub species: String,
    pub rarity: String,
    pub mood: String,
    pub happiness: u32,
    pub energy: u32,
    pub level: u32,
    pub xp: u32,
    pub xp_to_next: u32,
    pub interactions_total: u64,
}

#[tauri::command]
pub async fn jarvis_get_skills() -> Result<Vec<JarvisSkillStub>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn jarvis_get_tools() -> Result<Vec<JarvisToolStub>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn jarvis_invoke_skill(
    name: String,
    _args: Option<Value>,
) -> Result<Value, String> {
    Err(format!(
        "jarvis_invoke_skill({}) is not yet wired up in the recovered tree; \
         restore the skill runner from transcripts or implement against the \
         Bun-side registry",
        name
    ))
}

#[tauri::command]
pub async fn jarvis_ping() -> Result<String, String> {
    Ok("pong".to_string())
}

#[tauri::command]
pub async fn jarvis_discover_models(
    _backend: Option<String>,
) -> Result<Vec<Value>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn jarvis_test_connection(
    _backend: String,
    _config: Option<Value>,
) -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": false,
        "latency_ms": 0,
        "error": "test_connection is not yet wired up in the recovered tree",
    }))
}

#[tauri::command]
pub async fn jarvis_switch_backend(backend: String) -> Result<(), String> {
    eprintln!("[jarvis] switch_backend requested: {backend} (no-op in recovered tree)");
    Ok(())
}

#[tauri::command]
pub async fn jarvis_get_companion() -> Result<JarvisCompanionStub, String> {
    Ok(JarvisCompanionStub {
        enabled: false,
        name: "Sprout".into(),
        species: "spriggan".into(),
        rarity: "common".into(),
        mood: "idle".into(),
        happiness: 50,
        energy: 50,
        level: 1,
        xp: 0,
        xp_to_next: 100,
        interactions_total: 0,
    })
}

#[tauri::command]
pub async fn jarvis_save_companion(
    _companion: Value,
) -> Result<(), String> {
    Err("jarvis_save_companion is not yet wired up in the recovered tree".to_string())
}

#[tauri::command]
pub async fn jarvis_restart_server() -> Result<bool, String> {
    // Trigger a re-probe + re-spawn. The real implementation lives in
    // lib.rs's `ensure_jarvis_server_started`; this command is a marker
    // that the caller (UI button) can fire.
    crate::ensure_jarvis_server_started().await?;
    Ok(true)
}

#[tauri::command]
pub async fn jarvis_restart_ollama() -> Result<bool, String> {
    Err("jarvis_restart_ollama is not yet wired up in the recovered tree".to_string())
}

#[tauri::command]
pub async fn jarvis_review_session(_session_id: String) -> Result<Value, String> {
    Ok(serde_json::json!({ "reviewed": false, "note": "stub" }))
}

#[tauri::command]
pub async fn jarvis_commit_session_end(
    _session_id: String,
    _summary: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn jarvis_get_tier_stats() -> Result<Value, String> {
    Ok(serde_json::json!({
        "hot": 0, "warm": 0, "cold": 0,
        "note": "stub",
    }))
}

#[tauri::command]
pub async fn jarvis_list_memories_by_tier(_tier: String) -> Result<Vec<Value>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn jarvis_recall_cold_memory(_id: String) -> Result<Value, String> {
    Err("jarvis_recall_cold_memory is not yet wired up in the recovered tree".to_string())
}

// `update_token_count` is referenced by lib.rs but is also a member of the
// sessions command set; the canonical impl lives in commands/sessions.rs.
// Stub here as a no-op so the macro can resolve either way.
#[tauri::command]
pub async fn update_token_count(
    _session_id: String,
    _tokens_in: i64,
    _tokens_out: i64,
) -> Result<(), String> {
    Ok(())
}
