use crate::jarvis::types::*;
use crate::wsl::wsl_openclaw;
use std::io::{BufRead, BufReader};
use tauri::{AppHandle, Emitter};

/// Send a chat turn to the native Bun server (the JARVIS_API) and relay its SSE
/// stream back to the UI as `jarvis://token` / `jarvis://done` / `jarvis://error`
/// events.
///
/// The Bun server owns inference: it loads the active config (backend, model, and the
/// OpenRouter key) and performs the request with streaming. We just POST the turn to
/// `POST /chat/stream` and forward frames. The previous implementation shelled out to
/// `wsl.exe -- bash -c "bun run main.tsx …"`, which silently did nothing once the WSL
/// distro was lost — that was why prompting appeared dead.
pub fn run_jarvis_message(
    app: AppHandle,
    base_url: String,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let effective_session_id = if session_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        session_id
    };
    let url = format!("{}/chat/stream", base_url.trim_end_matches('/'));
    let sid = effective_session_id;

    std::thread::spawn(move || {
        let emit_error = |app: &AppHandle, sid: &str, msg: String| {
            let _ = app.emit(
                "jarvis://error",
                serde_json::json!({ "error": msg, "session_id": sid }),
            );
        };

        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(900))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                emit_error(&app, &sid, format!("HTTP client error: {e}"));
                return;
            }
        };

        let resp = match client
            .post(&url)
            .json(&serde_json::json!({ "message": message, "session_id": sid }))
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                emit_error(&app, &sid, format!("Could not reach the Jarvis server: {e}"));
                return;
            }
        };

        if !resp.status().is_success() {
            let code = resp.status();
            let body = resp.text().unwrap_or_default();
            emit_error(&app, &sid, format!("Jarvis server returned {code}: {body}"));
            return;
        }

        // Parse the SSE stream: newline-delimited `data: {json}` frames, terminated by
        // a `[DONE]` sentinel. Tokens arrive as `stream_event` frames with `delta.text`.
        let reader = BufReader::new(resp);
        let mut terminated = false;
        // Track whether any incremental token was streamed. The server has two answer
        // shapes: a token stream (`stream_event` deltas) and an orchestrator pipeline
        // that returns the whole answer in the terminal `result` frame. If nothing was
        // streamed, we surface the `result` text so the turn isn't silently blank.
        let mut streamed_any = false;
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let payload = match line.trim().strip_prefix("data:") {
                Some(p) => p.trim(),
                None => continue, // SSE comments / blank separators between frames
            };
            if payload.is_empty() {
                continue;
            }
            if payload == "[DONE]" {
                let _ = app.emit("jarvis://done", serde_json::json!({ "session_id": sid }));
                terminated = true;
                break;
            }

            let evt: serde_json::Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(_) => continue, // skip malformed frames rather than aborting the turn
            };

            match evt.get("type").and_then(|t| t.as_str()) {
                Some("stream_event") => {
                    if let Some(text) = evt
                        .get("delta")
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        streamed_any = true;
                        let _ = app.emit(
                            "jarvis://token",
                            serde_json::json!({ "text": text, "session_id": sid }),
                        );
                    }
                }
                Some("error") => {
                    let err = evt
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("Unknown error from Jarvis server");
                    emit_error(&app, &sid, err.to_string());
                    terminated = true;
                    break;
                }
                Some("result") => {
                    // Terminal frame. If the answer came back as one aggregate (orchestrator
                    // mode) rather than streamed deltas, surface it now so the turn isn't
                    // blank. `result` carries either the final answer or a failure message.
                    if !streamed_any {
                        if let Some(text) = evt.get("result").and_then(|r| r.as_str()) {
                            if !text.is_empty() {
                                let is_err =
                                    evt.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                                if is_err {
                                    emit_error(&app, &sid, text.to_string());
                                } else {
                                    let _ = app.emit(
                                        "jarvis://token",
                                        serde_json::json!({ "text": text, "session_id": sid }),
                                    );
                                }
                            }
                        }
                    }
                    let _ = app.emit("jarvis://done", serde_json::json!({ "session_id": sid }));
                    terminated = true;
                    break;
                }
                Some("orchestrator_stage") => {
                    // Pipeline stage progress from the multi-agent orchestrator.
                    // Shape: { type, stage, status, agent? }
                    // Relay to the UI so it can show a "Planner → Executor → …" breadcrumb.
                    let _ = app.emit(
                        "jarvis://stage",
                        serde_json::json!({
                            "stage":  evt.get("stage").and_then(|s| s.as_str()).unwrap_or(""),
                            "status": evt.get("status").and_then(|s| s.as_str()).unwrap_or(""),
                            "agent":  evt.get("agent").and_then(|s| s.as_str()).unwrap_or(""),
                            "session_id": sid,
                        }),
                    );
                }
                Some("reasoning_step") | Some("reasoning_chunk") => {
                    // Internal chain-of-thought text from the model. Relay as a separate
                    // event so the UI can show it in a collapsible "Thinking…" section
                    // without mixing it into the final answer tokens.
                    if let Some(text) = evt
                        .get("content")
                        .or_else(|| evt.get("chunk"))
                        .and_then(|c| c.as_str())
                    {
                        let _ = app.emit(
                            "jarvis://reasoning",
                            serde_json::json!({ "text": text, "session_id": sid }),
                        );
                    }
                }
                _ => {} // ignore init / heartbeat / other frame types
            }
        }

        // Guarantee the UI's streaming spinner is always cleared, even if the stream
        // ended without an explicit terminal frame.
        if !terminated {
            let _ = app.emit("jarvis://done", serde_json::json!({ "session_id": sid }));
        }
    });

    Ok(())
}

/// Check Jarvis status: Ollama, Bun server, proxy, bridge, model availability.
/// Uses blocking threads for HTTP checks to avoid tokio runtime issues.
pub fn check_jarvis_status(config: &JarvisConfig) -> JarvisStatus {
    let is_ollama = matches!(config.active_backend, JarvisBackend::Ollama);

    // ── Ollama ──────────────────────────────────────────────────
    let ollama_running = crate::is_port_listening(11434);

    let model_available = if is_ollama && ollama_running {
        let url = config.ollama.base_url.clone();
        let model = config.ollama.model.clone();
        std::thread::spawn(move || {
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build();
            match client {
                Ok(c) => {
                    if let Ok(resp) = c.get(format!("{}/api/tags", url)).send() {
                        if let Ok(json) = resp.json::<serde_json::Value>() {
                            return json
                                .get("models")
                                .and_then(|m| m.as_array())
                                .map(|models| {
                                    models.iter().any(|m| {
                                        m.get("name")
                                            .and_then(|n| n.as_str())
                                            .map_or(false, |n| n.contains(&model))
                                    })
                                })
                                .unwrap_or(false);
                        }
                    }
                    false
                }
                Err(_) => false,
            }
        })
        .join()
        .unwrap_or(false)
    } else {
        !is_ollama // non-Ollama backends don't need a local model
    };

    // ── Bun server ──────────────────────────────────────────────
    let bun_server_url = crate::wsl::get_cached_bun_url()
        .unwrap_or_else(|| "http://127.0.0.1:19877".to_string());
    let bun_server_running = {
        let url = format!("{}/health", bun_server_url.trim_end_matches('/'));
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .ok()
            .and_then(|c| c.get(&url).send().ok())
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    };

    // ── Claude CLI proxy ─────────────────────────────────────────
    let claude_proxy_running = crate::is_port_listening(19878);

    // ── Bridge ───────────────────────────────────────────────────
    let bridge_active =
        std::net::TcpStream::connect(format!("127.0.0.1:{}", config.bridge_port)).is_ok();

    // ── Bun binary availability (cheap, no HTTP) ─────────────────
    let bun_available = wsl_openclaw(&["which", "bun"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // ── Active backend descriptor ────────────────────────────────
    let (active_backend, model) = match config.active_backend {
        JarvisBackend::Ollama => ("ollama".to_string(), config.ollama.model.clone()),
        JarvisBackend::OpenRouter => ("openrouter".to_string(), config.openrouter.model.clone()),
        JarvisBackend::ClaudeCli => (
            "claude_cli".to_string(),
            config.claude_cli.model.clone().unwrap_or_default(),
        ),
    };

    JarvisStatus {
        ollama_running,
        model_available,
        bun_server_running,
        bun_server_url,
        claude_proxy_running,
        bridge_active,
        bridge_port: config.bridge_port,
        bun_available,
        active_backend,
        model,
        openrouter_key_set: !config.openrouter.api_key.trim().is_empty(),
    }
}
