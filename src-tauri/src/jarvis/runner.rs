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
        // a `[DONE]` sentinel. All frame parsing/decisioning lives in `SseRelay`
        // (pure + unit-tested below); this loop only maps outcomes to `app.emit`.
        let reader = BufReader::new(resp);
        let mut relay = SseRelay::new();
        let mut terminated = false;
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            match relay.handle_line(&line) {
                SseFrameOutcome::Continue => {}
                SseFrameOutcome::Token(text) => {
                    let _ = app.emit(
                        "jarvis://token",
                        serde_json::json!({ "text": text, "session_id": sid }),
                    );
                }
                SseFrameOutcome::Reasoning(text) => {
                    let _ = app.emit(
                        "jarvis://reasoning",
                        serde_json::json!({ "text": text, "session_id": sid }),
                    );
                }
                SseFrameOutcome::Stage {
                    stage,
                    status,
                    agent,
                } => {
                    let _ = app.emit(
                        "jarvis://stage",
                        serde_json::json!({
                            "stage": stage,
                            "status": status,
                            "agent": agent,
                            "session_id": sid,
                        }),
                    );
                }
                SseFrameOutcome::Error(err) => {
                    emit_error(&app, &sid, err);
                    terminated = true;
                    break;
                }
                SseFrameOutcome::ResultThenDone { token, error } => {
                    // Orchestrator aggregate: surface the answer (or failure) that
                    // never streamed as deltas, then close the turn.
                    if let Some(t) = token {
                        let _ = app.emit(
                            "jarvis://token",
                            serde_json::json!({ "text": t, "session_id": sid }),
                        );
                    }
                    if let Some(e) = error {
                        emit_error(&app, &sid, e);
                    }
                    let _ = app.emit("jarvis://done", serde_json::json!({ "session_id": sid }));
                    terminated = true;
                    break;
                }
                SseFrameOutcome::Done => {
                    let _ = app.emit("jarvis://done", serde_json::json!({ "session_id": sid }));
                    terminated = true;
                    break;
                }
                SseFrameOutcome::ApprovalRequest { call_id, name, arguments } => {
                    // Relay to the UI so ToolApprovalModal can surface it. The UI
                    // sends the decision back via `jarvis_tool_decision` (Tauri command)
                    // which POSTs to /tool/decision on the Bun server.
                    let _ = app.emit(
                        "jarvis://approval_request",
                        serde_json::json!({
                            "call_id": call_id,
                            "name": name,
                            "arguments": arguments,
                            "session_id": sid,
                        }),
                    );
                }
                SseFrameOutcome::AgentActivity { stage, text } => {
                    let _ = app.emit(
                        "jarvis://agent_activity",
                        serde_json::json!({
                            "stage": stage,
                            "text": text,
                            "session_id": sid,
                        }),
                    );
                }
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

/// The decision for a single SSE line, decoupled from how it's delivered to the
/// UI. The I/O loop maps each variant to a `jarvis://*` Tauri event.
#[derive(Debug, Clone, PartialEq)]
pub enum SseFrameOutcome {
    /// Nothing to emit (comment, blank, malformed, or an unhandled frame type).
    Continue,
    /// Incremental answer token (`stream_event` delta).
    Token(String),
    /// Chain-of-thought text (`reasoning_step` / `reasoning_chunk`).
    Reasoning(String),
    /// Orchestrator pipeline stage breadcrumb (`orchestrator_stage`).
    Stage {
        stage: String,
        status: String,
        agent: String,
    },
    /// Server-reported error — terminal.
    Error(String),
    /// Terminal `result` frame: surface the aggregate answer/failure that never
    /// streamed as deltas, then finish.
    ResultThenDone {
        token: Option<String>,
        error: Option<String>,
    },
    /// `[DONE]` sentinel — terminal.
    Done,
    /// Policy "ask" — the server paused on a tool call and needs the user to
    /// approve or deny before execution continues. The UI shows ToolApprovalModal
    /// and POSTs the decision to `/tool/decision`.
    ApprovalRequest {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Intermediate pipeline stage activity (planner/executor/reviewer/rewriter output).
    /// Does NOT flip `streamed_any` so the terminal `result` frame still surfaces if
    /// no synthesizer tokens hit the chat bubble.
    AgentActivity {
        stage: String,
        text: String,
    },
}

/// Stateful SSE frame relay. Holds the one piece of cross-frame state the
/// protocol needs — whether any token streamed — so the terminal `result`
/// frame knows whether to surface its aggregate text.
pub struct SseRelay {
    streamed_any: bool,
}

impl SseRelay {
    pub fn new() -> Self {
        Self {
            streamed_any: false,
        }
    }

    /// Decide what a single raw SSE line means. Handles the `data:` prefix, the
    /// `[DONE]` sentinel, malformed JSON (skipped), and every known frame type.
    pub fn handle_line(&mut self, raw_line: &str) -> SseFrameOutcome {
        let payload = match raw_line.trim().strip_prefix("data:") {
            Some(p) => p.trim(),
            None => return SseFrameOutcome::Continue, // comments / blank separators
        };
        if payload.is_empty() {
            return SseFrameOutcome::Continue;
        }
        if payload == "[DONE]" {
            return SseFrameOutcome::Done;
        }

        let evt: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return SseFrameOutcome::Continue, // skip, don't abort the turn
        };

        match evt.get("type").and_then(|t| t.as_str()) {
            Some("stream_event") => {
                if let Some(text) = evt
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                {
                    self.streamed_any = true;
                    return SseFrameOutcome::Token(text.to_string());
                }
                SseFrameOutcome::Continue
            }
            Some("error") => {
                let err = evt
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("Unknown error from Jarvis server");
                SseFrameOutcome::Error(err.to_string())
            }
            Some("result") => {
                let mut token = None;
                let mut error = None;
                if !self.streamed_any {
                    if let Some(text) = evt.get("result").and_then(|r| r.as_str()) {
                        if !text.is_empty() {
                            let is_err =
                                evt.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
                            if is_err {
                                error = Some(text.to_string());
                            } else {
                                token = Some(text.to_string());
                            }
                        }
                    }
                }
                SseFrameOutcome::ResultThenDone { token, error }
            }
            Some("orchestrator_stage") => SseFrameOutcome::Stage {
                stage: evt.get("stage").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                status: evt.get("status").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                agent: evt.get("agent").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            },
            Some("reasoning_step") | Some("reasoning_chunk") => {
                if let Some(text) = evt
                    .get("content")
                    .or_else(|| evt.get("chunk"))
                    .and_then(|c| c.as_str())
                {
                    return SseFrameOutcome::Reasoning(text.to_string());
                }
                SseFrameOutcome::Continue
            }
            Some("tool_approval_request") => {
                let call_id = evt.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = evt.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let arguments = evt.get("arguments").cloned().unwrap_or(serde_json::Value::Null);
                SseFrameOutcome::ApprovalRequest { call_id, name, arguments }
            }
            Some("agent_activity") => {
                if let Some(text) = evt.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        return SseFrameOutcome::AgentActivity {
                            stage: evt.get("stage").and_then(|s| s.as_str()).unwrap_or("agent").to_string(),
                            text: text.to_string(),
                        };
                    }
                }
                SseFrameOutcome::Continue
            }
            _ => SseFrameOutcome::Continue, // init / heartbeat / unknown
        }
    }
}

impl Default for SseRelay {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod sse_tests {
    use super::*;

    #[test]
    fn non_data_lines_and_blanks_are_ignored() {
        let mut r = SseRelay::new();
        assert_eq!(r.handle_line(": comment"), SseFrameOutcome::Continue);
        assert_eq!(r.handle_line(""), SseFrameOutcome::Continue);
        assert_eq!(r.handle_line("data:"), SseFrameOutcome::Continue);
        assert_eq!(r.handle_line("data:   "), SseFrameOutcome::Continue);
    }

    #[test]
    fn malformed_json_is_skipped_not_fatal() {
        let mut r = SseRelay::new();
        assert_eq!(r.handle_line("data: {not json"), SseFrameOutcome::Continue);
    }

    #[test]
    fn stream_event_delta_becomes_a_token() {
        let mut r = SseRelay::new();
        let out = r.handle_line(r#"data: {"type":"stream_event","delta":{"text":"hi"}}"#);
        assert_eq!(out, SseFrameOutcome::Token("hi".to_string()));
    }

    #[test]
    fn done_sentinel_is_terminal() {
        let mut r = SseRelay::new();
        assert_eq!(r.handle_line("data: [DONE]"), SseFrameOutcome::Done);
    }

    #[test]
    fn error_frame_surfaces_message() {
        let mut r = SseRelay::new();
        let out = r.handle_line(r#"data: {"type":"error","error":"boom"}"#);
        assert_eq!(out, SseFrameOutcome::Error("boom".to_string()));
    }

    #[test]
    fn result_surfaces_aggregate_when_nothing_streamed() {
        let mut r = SseRelay::new();
        let out = r.handle_line(r#"data: {"type":"result","result":"final answer"}"#);
        assert_eq!(
            out,
            SseFrameOutcome::ResultThenDone {
                token: Some("final answer".to_string()),
                error: None,
            }
        );
    }

    #[test]
    fn result_is_error_routes_to_error_slot() {
        let mut r = SseRelay::new();
        let out = r.handle_line(r#"data: {"type":"result","result":"it failed","is_error":true}"#);
        assert_eq!(
            out,
            SseFrameOutcome::ResultThenDone {
                token: None,
                error: Some("it failed".to_string()),
            }
        );
    }

    #[test]
    fn result_is_suppressed_after_tokens_streamed() {
        let mut r = SseRelay::new();
        // A token streamed first…
        let _ = r.handle_line(r#"data: {"type":"stream_event","delta":{"text":"partial"}}"#);
        // …so the terminal result must NOT re-surface the aggregate (no double answer).
        let out = r.handle_line(r#"data: {"type":"result","result":"partial"}"#);
        assert_eq!(
            out,
            SseFrameOutcome::ResultThenDone {
                token: None,
                error: None,
            }
        );
    }

    #[test]
    fn orchestrator_stage_maps_fields() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"orchestrator_stage","stage":"plan","status":"running","agent":"planner"}"#,
        );
        assert_eq!(
            out,
            SseFrameOutcome::Stage {
                stage: "plan".to_string(),
                status: "running".to_string(),
                agent: "planner".to_string(),
            }
        );
    }

    #[test]
    fn approval_request_frame_extracts_fields() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"tool_approval_request","call_id":"c1","name":"shell_exec","arguments":{"cmd":"rm -rf /"}}"#,
        );
        assert!(
            matches!(out, SseFrameOutcome::ApprovalRequest { ref call_id, ref name, .. }
                if call_id == "c1" && name == "shell_exec"),
            "expected ApprovalRequest, got {out:?}",
        );
    }

    #[test]
    fn reasoning_frames_relay_content_or_chunk() {
        let mut r = SseRelay::new();
        assert_eq!(
            r.handle_line(r#"data: {"type":"reasoning_step","content":"thinking"}"#),
            SseFrameOutcome::Reasoning("thinking".to_string())
        );
        assert_eq!(
            r.handle_line(r#"data: {"type":"reasoning_chunk","chunk":"more"}"#),
            SseFrameOutcome::Reasoning("more".to_string())
        );
    }

    #[test]
    fn agent_activity_frame_is_relayed() {
        let mut r = SseRelay::new();
        let out = r.handle_line(r#"data: {"type":"agent_activity","stage":"planner","text":"step 1"}"#);
        assert_eq!(
            out,
            SseFrameOutcome::AgentActivity {
                stage: "planner".to_string(),
                text: "step 1".to_string(),
            }
        );
    }

    #[test]
    fn agent_activity_does_not_suppress_result_frame() {
        let mut r = SseRelay::new();
        // AgentActivity must NOT flip streamed_any — the final result should still surface.
        let _ = r.handle_line(r#"data: {"type":"agent_activity","stage":"planner","text":"planning..."}"#);
        let out = r.handle_line(r#"data: {"type":"result","result":"final answer"}"#);
        assert_eq!(
            out,
            SseFrameOutcome::ResultThenDone {
                token: Some("final answer".to_string()),
                error: None,
            }
        );
    }
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
                                            .is_some_and(|n| n.contains(&model))
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
