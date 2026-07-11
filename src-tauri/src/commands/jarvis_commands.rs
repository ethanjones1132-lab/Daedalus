use crate::jarvis::bridge::{start_bridge, stop_bridge};
use crate::jarvis::runner::{check_jarvis_status, run_jarvis_message};
use crate::jarvis::types::*;
use crate::jarvis_types::JarvisState;
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, State};

async fn chat_base_url() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("Failed to build Jarvis health client: {e}"))?;

    let base_url = crate::cron_scheduler::resolve_jarvis_url(&client).await;
    if probe_chat_health(&client, &base_url).await {
        return Ok(base_url);
    }

    tokio::time::timeout(
        Duration::from_secs(25),
        crate::ensure_jarvis_server_started(),
    )
    .await
    .map_err(|_| "Timed out while starting the Bun server for chat".to_string())??;

    let base_url = crate::cron_scheduler::resolve_jarvis_url(&client).await;
    if probe_chat_health(&client, &base_url).await {
        return Ok(base_url);
    }

    Err(format!(
        "Bun server is not reachable at {} after startup",
        base_url.trim_end_matches('/')
    ))
}

async fn probe_chat_health(client: &reqwest::Client, base_url: &str) -> bool {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    matches!(
        client.get(url).timeout(Duration::from_secs(2)).send().await,
        Ok(resp) if resp.status().is_success()
    )
}

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
    db: tauri::State<'_, crate::db::AppDb>,
    message: String,
    session_id: String,
) -> Result<(), String> {
    // Chat is served by the native Bun server, which loads the active config
    // (backend + model + OpenRouter key) itself. Make sure it is up, then hand the
    // turn to the SSE relay. We no longer pass config through here — the server is
    // the single source of truth, which is also why the key must be persisted to the
    // config file it reads (see jarvis::get_config_path).
    eprintln!(
        "[jarvis-chat] send requested session={} chars={}",
        session_id,
        message.chars().count()
    );
    // Re-probe the Bun URL on every turn. `get_cached_bun_url()` returns
    // whatever was last validated, which can go stale when the server is
    // restarted in a different mode (WSL → native, or vice versa) — a stale
    // WSL IP cached against a now-native server (or vice versa) makes the
    // chat POST hang on a dead SYN. `resolve_jarvis_url` re-checks the
    // cached URL against /health, falls through to all candidates on
    // failure, and re-caches the first live one. Cost: 1 GET /health per
    // chat turn (sub-millisecond when the server is up).
    let base_url = chat_base_url().await?;
    eprintln!(
        "[jarvis-chat] stream target session={} base={}",
        session_id, base_url
    );

    let history = if session_id.is_empty() {
        Vec::new()
    } else {
        crate::commands::sessions::history_for_chat_stream(&db, &session_id)?
    };

    if !session_id.is_empty() {
        crate::commands::sessions::insert_message_row(&db, &session_id, "user", &message, 0)?;
    }

    eprintln!("[jarvis-chat] spawning stream relay session={}", session_id);
    let db_path = db.db_path.clone();
    run_jarvis_message(app, base_url, session_id, message, history, db_path)
}

#[tauri::command]
pub async fn cancel_chat_stream(session_id: String) -> Result<bool, String> {
    // POST to the Bun server's `/chat/cancel` route so the in-flight SSE
    // controller on the Bun side aborts the OpenRouter/Ollama fetch and emits
    // a `cancelled` frame (which the Rust `SseRelay` now treats as terminal —
    // see runner.rs::SseFrameOutcome::Cancelled). Without this, the only way
    // to escape a hung stream was to restart the app.
    //
    // The Bun route reads `session_id` to match the active StreamSession
    // (see server-jarvis/src/index.ts ::POST /chat/cancel). Returns Ok(true)
    // when the cancel fires; the UI flips `isStreaming=false` on success and
    // surfaces any returned error to the user as a toast.
    //
    // Re-probe the Bun URL on every call (see `jarvis_send_message` for the
    // stale-cache rationale — a cancelled stream against a dead URL leaves
    // the UI pinned with no way out short of an app restart).
    let probe_client = reqwest::Client::new();
    let base = crate::cron_scheduler::resolve_jarvis_url(&probe_client).await;
    let url = format!("{}/chat/cancel", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build /chat/cancel client: {e}"))?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "session_id": session_id }))
        .send()
        .await
        .map_err(|e| format!("Failed to POST /chat/cancel: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("/chat/cancel returned {code}: {body}"));
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
    Ok(body
        .get("cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
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
    // continuation can resume or be denied. Surface the POST error to the UI
    // (the previous implementation silently swallowed it via `let _ = ...`,
    // leaving the orchestrator pinned waiting on a decision that never came).
    //
    // Re-probe the Bun URL on every call (see `jarvis_send_message` for the
    // stale-cache rationale — a denied tool against a dead URL leaves the
    // orchestrator pinned mid-turn).
    let probe_client = reqwest::Client::new();
    let base = crate::cron_scheduler::resolve_jarvis_url(&probe_client).await;
    let url = format!("{}/tool/decision", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build /tool/decision client: {e}"))?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "call_id": tool_call_id, "approved": approved }))
        .send()
        .await
        .map_err(|e| format!("Tool decision POST failed: {e}"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Tool decision returned {code}: {body}"));
    }
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
    // Clone under the mutex, then release it before the synchronous health
    // probes. `check_jarvis_status` performs blocking HTTP and WSL process
    // work, so running it on an async command worker can starve Tauri IPC.
    let config = state.config.lock().await.clone();
    run_blocking_status_work(move || check_jarvis_status(&config)).await
}

async fn run_blocking_status_work<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("status task join error: {e}"))
}

#[tauri::command]
pub async fn jarvis_start_bridge(state: State<'_, JarvisState>) -> Result<(), String> {
    let queue = state.queue.clone();
    start_bridge(19876, queue).map(|_| ())
}

#[tauri::command]
pub async fn jarvis_stop_bridge() -> Result<(), String> {
    stop_bridge()
}

#[cfg(test)]
mod status_check_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_status_work_does_not_starve_the_async_runtime() {
        let release = Arc::new(AtomicBool::new(false));
        let timer_release = Arc::clone(&release);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            timer_release.store(true, Ordering::SeqCst);
        });

        let worker_release = Arc::clone(&release);
        let started = std::time::Instant::now();
        let value = run_blocking_status_work(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
            while !worker_release.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            42
        })
        .await
        .expect("blocking status task should join");

        assert_eq!(value, 42);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(150),
            "status work blocked the single-thread async runtime"
        );
    }
}
