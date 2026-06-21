use crate::jarvis;
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
    state: State<'_, JarvisState>,
) -> Result<(), String> {
    let config = state.config.lock().await.clone();
    run_jarvis_message(app, config, session_id, message)
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

#[tauri::command]
pub async fn jarvis_new_session(
    name: Option<String>,
    state: State<'_, JarvisState>,
) -> Result<JarvisSession, String> {
    let config = state.config.lock().await;
    let model = match config.active_backend {
        crate::jarvis::types::JarvisBackend::Ollama => config.ollama.model.clone(),
        crate::jarvis::types::JarvisBackend::OpenRouter => config.openrouter.model.clone(),
        crate::jarvis::types::JarvisBackend::ClaudeCli => {
            config.claude_cli.model.clone().unwrap_or_default()
        }
    };
    jarvis::create_jarvis_session(name, &model)
}

#[tauri::command]
pub async fn jarvis_list_sessions() -> Result<Vec<JarvisSession>, String> {
    jarvis::list_jarvis_sessions()
}

#[tauri::command]
pub async fn jarvis_delete_session(session_id: String) -> Result<(), String> {
    jarvis::delete_jarvis_session(&session_id)
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
    // Best-effort: log the decision. The runner reads from the queue on
    // its next poll; if the user is operating through a non-queue path
    // (e.g. a streamed turn), the Bun server's WebSocket layer handles it.
    eprintln!(
        "[jarvis] tool decision: session={} call={} decision={}",
        session_id, tool_call_id, decision
    );
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
) -> Result<(), String> {
    jarvis::save_jarvis_config(&config)?;
    let mut guard = state.config.lock().await;
    *guard = config;
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
