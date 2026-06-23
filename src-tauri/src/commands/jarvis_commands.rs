use crate::jarvis::bridge::{start_bridge, stop_bridge};
use crate::jarvis::runner::{check_jarvis_status, run_jarvis_message};
use crate::jarvis::types::*;
use crate::jarvis_types::JarvisState;
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct LearningRunResult {
    pub topic: String,
    pub subtopic: String,
    pub started_at: String,
    pub finished_at: String,
    pub output_path: String,
    pub findings: Vec<crate::jarvis::learning::Finding>,
    pub rejected_sources: Vec<crate::jarvis::learning::SourceEvaluation>,
}

#[tauri::command]
pub async fn run_learning_session(
    topic: String,
    seed_urls: Option<Vec<String>>,
    out_dir: Option<String>,
) -> Result<LearningRunResult, String> {
    use crate::jarvis::learning::{self, Finding};

    let started_at = chrono::Utc::now().to_rfc3339();

    // Resolve output directory. Default: $JARVIS_HOME/.jarvis/learning/
    let out_path = match out_dir {
        Some(d) => std::path::PathBuf::from(d),
        None => {
            let mut p = std::path::PathBuf::from(crate::wsl::wsl_home());
            p.push(".jarvis");
            p.push("learning");
            p
        }
    };
    if let Some(parent) = out_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !out_path.exists() {
        let _ = std::fs::create_dir_all(&out_path);
    }

    // Filter seed URLs through the quality gate.
    let mut accepted: Vec<String> = Vec::new();
    let mut rejected: Vec<crate::jarvis::learning::SourceEvaluation> = Vec::new();
    for url in seed_urls.unwrap_or_default() {
        let ev = learning::evaluate_source(&url);
        if matches!(ev.tier, crate::jarvis::learning::CredibilityTier::Tier1) {
            accepted.push(url);
        } else {
            rejected.push(ev);
        }
    }

    // Pick the next subtopic and synthesise findings for each accepted URL.
    // The full research loop (web fetch, summary, LLM extraction) lives in
    // a Python sidecar in production; here we emit deterministic placeholder
    // findings so the UI surfaces keep working end-to-end.
    let subtopic = learning::next_subtopic(&[]).to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let mut findings: Vec<Finding> = Vec::new();
    for url in &accepted {
        findings.push(Finding {
            subtopic: subtopic.clone(),
            source_url: url.clone(),
            summary: format!(
                "Placeholder finding for topic '{}' on subtopic '{}'. The full research loop is provided by the Python sidecar.",
                topic, subtopic
            ),
            captured_at: now.clone(),
        });
    }

    // Write a markdown session file so the result is durable.
    let path = learning::output_path(&out_path, &topic);
    let body = format!(
        "# Learning Session — {}\n\n- Topic: `{}`\n- Subtopic: `{}`\n- Started: {}\n- Sources: {}\n- Rejected: {}\n\n## Findings\n\n{}\n",
        topic,
        topic,
        subtopic,
        started_at,
        findings.len(),
        rejected.len(),
        findings
            .iter()
            .map(|f| format!("- **{}** — {}\n  <{}>\n", f.subtopic, f.summary, f.source_url))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    if let Err(e) = std::fs::write(&path, body) {
        return Err(format!("Failed to write learning session: {}", e));
    }

    Ok(LearningRunResult {
        topic,
        subtopic,
        started_at: started_at.clone(),
        finished_at: chrono::Utc::now().to_rfc3339(),
        output_path: path.to_string_lossy().into_owned(),
        findings,
        rejected_sources: rejected,
    })
}

#[tauri::command]
pub async fn jarvis_send_message(
    app: AppHandle,
    message: String,
    session_id: String,
) -> Result<(), String> {
    // Chat is served by the native Bun server, which loads the active config
    // (backend + model + OpenRouter key) itself. Make sure it is up, then hand the
    // turn to the SSE relay. We no longer pass config through here — the server is
    // the single source of truth, which is also why the key must be persisted to the
    // config file it reads (see jarvis::get_config_path).
    crate::ensure_jarvis_server_started().await?;
    let base_url = crate::wsl::get_cached_bun_url()
        .unwrap_or_else(|| "http://127.0.0.1:19877".to_string());
    run_jarvis_message(app, base_url, session_id, message)
}

#[tauri::command]
pub async fn cancel_chat_stream(session_id: String) -> Result<bool, String> {
    // The recovered runner spawns the WSL child in a fire-and-forget task
    // tracked only by a thread-local handle. A future hardening pass will
    // plumb a CancellationToken through queue.rs; for now we return Ok(false)
    // to signal "no stream found / not implemented" so the UI can fall back
    // to displaying a stale stream as finished.
    //
    // The session_id argument is preserved so the future implementation can
    // match it against the per-session child process table.
    let _ = session_id;
    Ok(false)
}

// The chat-session commands map the canonical SQLite session (commands/sessions.rs)
// onto the `JarvisSession` shape the chat UI expects. There is one session store
// (SQLite); the legacy file store was retired in Phase 1.2.

fn summary_to_jarvis_session(s: crate::commands::SessionSummary) -> JarvisSession {
    JarvisSession {
        id: s.id,
        name: s.title,
        created_at: s.created_at,
        model: s.model,
        message_count: s.message_count.max(0) as u32,
    }
}

#[tauri::command]
pub async fn jarvis_new_session(
    name: Option<String>,
    state: State<'_, JarvisState>,
    db: State<'_, crate::db::AppDb>,
) -> Result<JarvisSession, String> {
    let (backend, model) = {
        let config = state.config.lock().await;
        let model = match config.active_backend {
            crate::jarvis::types::JarvisBackend::Ollama => config.ollama.model.clone(),
            crate::jarvis::types::JarvisBackend::OpenRouter => config.openrouter.model.clone(),
            crate::jarvis::types::JarvisBackend::ClaudeCli => {
                config.claude_cli.model.clone().unwrap_or_default()
            }
        };
        (config.active_backend.to_string(), model)
    };
    let s = crate::commands::create_session_row(
        &db,
        name,
        Some("main".to_string()),
        Some(backend),
        Some(model),
    )?;
    Ok(summary_to_jarvis_session(s))
}

#[tauri::command]
pub async fn jarvis_list_sessions(
    db: State<'_, crate::db::AppDb>,
) -> Result<Vec<JarvisSession>, String> {
    let rows = crate::commands::list_session_rows(&db)?;
    Ok(rows.into_iter().map(summary_to_jarvis_session).collect())
}

#[tauri::command]
pub async fn jarvis_delete_session(
    session_id: String,
    db: State<'_, crate::db::AppDb>,
) -> Result<(), String> {
    crate::commands::delete_session_row(&db, &session_id)?;
    Ok(())
}

/// User decision on a pending tool call (approve / deny / modify).
/// In the recovered tree this is a thin pass-through to the Bun server's
/// `jarvis://tool-decision` event. The full handler (which actually
/// resumes the WSL child) lives in the runner; this command just records
/// the decision in the queue so subsequent polls see it.
#[tauri::command]
pub async fn jarvis_tool_decision(
    session_id: String,
    tool_call_id: String,
    decision: String,
) -> Result<(), String> {
    let approved = decision == "approve";
    eprintln!(
        "[jarvis] tool decision: session={} call={} approved={}",
        session_id, tool_call_id, approved
    );
    // Forward to the Bun server's approval registry so the paused tool
    // continuation can resume or be denied.
    let base = crate::wsl::get_cached_bun_url()
        .unwrap_or_else(|| "http://127.0.0.1:19877".to_string());
    let url = format!("{}/tool/decision", base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let _ = client
        .post(&url)
        .json(&serde_json::json!({ "call_id": tool_call_id, "approved": approved }))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| eprintln!("[jarvis] tool decision POST failed: {e}"));
    Ok(())
}

#[tauri::command]
pub async fn jarvis_get_config(state: State<'_, JarvisState>) -> Result<JarvisConfig, String> {
    Ok(state.config.lock().await.clone())
}

#[tauri::command]
pub async fn jarvis_save_config(
    config: JarvisConfig,
    state: State<'_, JarvisState>,
    db: State<'_, crate::db::AppDb>,
) -> Result<(), String> {
    // SQLite is canonical; this also projects to the Bun-readable file store.
    crate::commands::persist_jarvis_config(&db, &config)?;
    let backend = config.active_backend.clone();
    let ollama_model = config.ollama.model.clone();
    {
        let mut guard = state.config.lock().await;
        *guard = config;
    }
    // Bring up whatever the (possibly newly selected) backend needs — e.g. start
    // Ollama when the user switches to it in Control. Idempotent + non-blocking.
    crate::reconcile_backend_services(backend, ollama_model);
    Ok(())
}

#[tauri::command]
pub async fn jarvis_check_status(state: State<'_, JarvisState>) -> Result<JarvisStatus, String> {
    let config = state.config.lock().await;
    Ok(check_jarvis_status(&config))
}

#[tauri::command]
pub async fn jarvis_start_bridge(state: State<'_, JarvisState>) -> Result<(), String> {
    let queue = state.queue.clone();
    start_bridge(19876, queue)
}

#[tauri::command]
pub async fn jarvis_stop_bridge() -> Result<(), String> {
    stop_bridge()
}
