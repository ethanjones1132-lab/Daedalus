// Recovery command stubs — now partly wired to the live Bun server.
//
// RECOVERY NOTE (2026-06-19):
//   A handful of jarvis_* Tauri commands referenced in lib.rs's
//   `tauri::generate_handler!` were never recovered from any snapshot
//   or transcript. They were originally stubbed here with typed
//   responses matching the TS interfaces in
//   src-ui/src/components/jarvis/types.ts.
//
// WIRED (2026-06-21):
//   The six read-path commands the UI hits on every page load now proxy
//   to the live Bun server (http://localhost:19877):
//     jarvis_get_skills      -> GET  /skills
//     jarvis_get_tools       -> GET  /tools
//     jarvis_discover_models -> GET  /models
//     jarvis_test_connection -> POST /test   {config}
//     jarvis_ping            -> GET  /health
//     jarvis_get_companion   -> GET  /companion
//   The Bun JSON is already snake_case and matches the UI interfaces, so
//   we deserialize into serde_json::Value and proxy it through verbatim
//   rather than re-deriving typed structs that could drift.
//
//   The memory-tier read commands (jarvis_get_tier_stats,
//   jarvis_list_memories_by_tier) are wired directly to the SQLite
//   `memory` table — that subsystem is Rust/SQLite-side, not Bun.
//
//   The remaining commands (invoke_skill, save_companion, switch_backend,
//   restart_ollama, review_session, commit_session_end, recall_cold_memory)
//   are still stubs: they have no current UI caller and map to
//   streaming/mutating endpoints, so they belong in a follow-up pass.
//
//   The whole module is gated behind `#[allow(dead_code)]` so unused
//   fields don't trip the linter.

#![allow(dead_code)]

use crate::db::AppDb;
use serde_json::Value;
use tauri::State;

/// Resolve the base URL of the live Bun server, starting it if needed.
///
/// Prefers the cached URL discovered by the health-probe in lib.rs; if it
/// has not been resolved yet, triggers a probe/spawn and re-reads the cache.
async fn bun_base() -> Result<String, String> {
    if let Some(url) = crate::wsl::get_cached_bun_url() {
        return Ok(url.trim_end_matches('/').to_string());
    }
    crate::ensure_jarvis_server_started().await?;
    crate::wsl::get_cached_bun_url()
        .map(|u| u.trim_end_matches('/').to_string())
        .ok_or_else(|| "Jarvis Bun server is not reachable".to_string())
}

/// Shared reqwest client with a sane timeout, mirroring commands/models.rs.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

/// GET `{bun_base}{path}` and deserialize the JSON body into `T`.
async fn bun_get_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let base = bun_base().await?;
    let url = format!("{}{}", base, path);
    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Bun server request to {} failed: {}", path, e))?;
    resp.json::<T>()
        .await
        .map_err(|e| format!("JSON parse error from {}: {}", path, e))
}

#[tauri::command]
pub async fn jarvis_get_skills() -> Result<Vec<Value>, String> {
    bun_get_json("/skills").await
}

#[tauri::command]
pub async fn jarvis_get_tools() -> Result<Vec<Value>, String> {
    bun_get_json("/tools").await
}

#[tauri::command]
pub async fn jarvis_invoke_skill(name: String, args: Option<Value>) -> Result<Value, String> {
    // Invoke a skill via the Bun server's `POST /skills/invoke`, which streams the
    // result as SSE (`init` → `stream_event` deltas → `message_stop`). The command
    // contract is a single Value, so we collect the stream and return the aggregate
    // text plus the server-assigned session id.
    let base = bun_base().await?;
    let client = http_client()?;
    let body = serde_json::json!({ "name": name, "args": args.unwrap_or(Value::Null) });

    let resp = client
        .post(format!("{}/skills/invoke", base))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("skills/invoke request failed: {}", e))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Skill not found: {}", name));
    }
    if !resp.status().is_success() {
        return Err(format!("skills/invoke returned HTTP {}", resp.status()));
    }

    let raw = resp
        .text()
        .await
        .map_err(|e| format!("reading skills/invoke stream: {}", e))?;

    let mut output = String::new();
    let mut session_id = String::new();
    for line in raw.lines() {
        let payload = match line.trim().strip_prefix("data:") {
            Some(p) => p.trim(),
            None => continue,
        };
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(evt) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        match evt.get("type").and_then(|t| t.as_str()) {
            Some("init") => {
                if let Some(s) = evt.get("session_id").and_then(|s| s.as_str()) {
                    session_id = s.to_string();
                }
            }
            Some("stream_event") => {
                if let Some(text) = evt
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                {
                    output.push_str(text);
                }
            }
            Some("error") => {
                return Err(evt
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("skill invocation error")
                    .to_string());
            }
            _ => {}
        }
    }

    Ok(serde_json::json!({ "session_id": session_id, "skill": name, "output": output }))
}

#[tauri::command]
pub async fn jarvis_ping() -> Result<String, String> {
    // Liveness probe against the Bun server's /health endpoint. Returns the
    // classic "pong" sentinel the HealthBanner expects on a 2xx response.
    let base = bun_base().await?;
    let client = http_client()?;
    let resp = client
        .get(format!("{}/health", base))
        .send()
        .await
        .map_err(|e| format!("Bun server health check failed: {}", e))?;
    if resp.status().is_success() {
        Ok("pong".to_string())
    } else {
        Err(format!("Bun server unhealthy: HTTP {}", resp.status()))
    }
}

#[tauri::command]
pub async fn jarvis_discover_models(_backend: Option<String>) -> Result<Vec<Value>, String> {
    // The Bun server's /models endpoint discovers across all configured
    // backends (Ollama + OpenRouter); the optional `_backend` hint is not
    // needed for the GET form.
    bun_get_json("/models").await
}

#[tauri::command]
pub async fn jarvis_test_connection(
    backend: String,
    config: Option<Value>,
) -> Result<Value, String> {
    // POST /test with the optional config override. The Bun server validates
    // reachability for the active (or supplied) backend and returns
    // { ok, latency_ms, error? }.
    let base = bun_base().await?;
    let client = http_client()?;
    let body = serde_json::json!({ "backend": backend, "config": config });
    let resp = client
        .post(format!("{}/test", base))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Bun server connection test failed: {}", e))?;
    resp.json::<Value>()
        .await
        .map_err(|e| format!("JSON parse error from /test: {}", e))
}

#[tauri::command]
pub async fn jarvis_switch_backend(
    backend: String,
    state: State<'_, crate::jarvis::types::JarvisState>,
    db: State<'_, crate::db::AppDb>,
) -> Result<(), String> {
    use crate::jarvis::types::JarvisBackend;
    let new_backend = match backend.as_str() {
        "ollama" => JarvisBackend::Ollama,
        "openrouter" => JarvisBackend::OpenRouter,
        "claude_cli" => JarvisBackend::ClaudeCli,
        other => return Err(format!("unknown backend: {other}")),
    };

    // Persist canonically (SQLite + file projection) and mirror into the
    // in-memory state so subsequent chats route to the new backend immediately.
    let mut cfg = { state.config.lock().await.clone() };
    cfg.active_backend = new_backend.clone();
    crate::commands::persist_jarvis_config(&db, &cfg)?;
    let ollama_model = cfg.ollama.model.clone();
    {
        let mut guard = state.config.lock().await;
        *guard = cfg;
    }

    // Start whatever the new backend needs (Ollama for local; Bun for all).
    crate::reconcile_backend_services(new_backend, ollama_model);
    Ok(())
}

#[tauri::command]
pub async fn jarvis_get_companion() -> Result<Value, String> {
    // GET /companion returns the live companion state, or { enabled: false }
    // when no companion is configured — proxied through as-is.
    bun_get_json("/companion").await
}

#[tauri::command]
pub async fn jarvis_save_companion(companion: Value) -> Result<(), String> {
    // Persist the full companion state to companion.json (the file the Bun server's
    // GET /companion reads). The Bun POST /companion route is an interaction, not a
    // save, so we write the canonical state directly.
    crate::jarvis::save_companion_state(&companion)
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
pub async fn jarvis_restart_ollama(
    state: tauri::State<'_, crate::jarvis::types::JarvisState>,
) -> Result<bool, String> {
    // Kill the tracked Ollama child (if we spawned one), let the port free up, then
    // respawn + warm. Returns true once Ollama is listening again. Best-effort: if
    // Ollama was started outside the app there may be no child to kill, in which case
    // we simply (re)ensure it is up.
    let model = state.config.lock().await.ollama.model.clone();
    if let Some(m) = crate::OLLAMA_PROCESS.get() {
        if let Ok(mut g) = m.lock() {
            if let Some(mut child) = g.take() {
                let _ = child.kill();
            }
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    crate::start_ollama_and_warm(model).await;
    if crate::is_port_listening(11434) {
        Ok(true)
    } else {
        Err("Ollama did not come back up within the startup window".to_string())
    }
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
pub fn jarvis_get_tier_stats(db: State<AppDb>) -> Result<Value, String> {
    // Live counts of active memories per Drive-Brain tier (hot/warm/cold),
    // backed by the SQLite `memory` table + idx_memory_tier index. Matches
    // the `Record<Tier, number>` shape MemoryView expects.
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut counts = serde_json::Map::new();
    for tier in ["hot", "warm", "cold"] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory WHERE tier = ?1 AND status = 'active'",
                [tier],
                |row| row.get(0),
            )
            .map_err(|e| format!("tier stats query failed: {}", e))?;
        counts.insert(tier.to_string(), Value::from(n));
    }
    Ok(Value::Object(counts))
}

#[tauri::command]
pub fn jarvis_list_memories_by_tier(db: State<AppDb>, tier: String) -> Result<Vec<Value>, String> {
    // Active memories in a given tier, serialized as the same MemoryEntry
    // shape the other memory_* commands return.
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let all = crate::jarvis::memory::engine::list_memories(&conn)?;
    let filtered = all
        .into_iter()
        .filter(|m| m.tier == tier && m.status == "active")
        .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
        .collect();
    Ok(filtered)
}

#[tauri::command]
pub async fn jarvis_recall_cold_memory(
    db: tauri::State<'_, crate::db::AppDb>,
    id: String,
) -> Result<Value, String> {
    // Wired to the real memory engine (was a silent "not wired" stub). Hot/warm
    // and DB-resident cold memories return their content; Drive-offloaded cold
    // memories return an explicit deferred error rather than empty content.
    let content = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        crate::jarvis::memory::engine::recall_cold_memory(&conn, &id)?
    };
    Ok(serde_json::json!({
        "id": id,
        "found": content.is_some(),
        "content": content,
    }))
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
