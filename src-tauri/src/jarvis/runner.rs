use crate::commands::sessions::persist_terminal_run_at;
use crate::jarvis::types::*;
use crate::wsl::wsl_openclaw;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

/// Accumulates the evidence needed to persist one durable `session_runs` record.
/// The Bun server is the source of truth for run identity and outcome, but the
/// native SQLite store is the only durable authority; this struct bridges the
/// SSE frame stream to a single terminal write.
#[derive(Debug, Default)]
struct TerminalRunAccumulator {
    run_id: Option<String>,
    selected_model: Option<String>,
    token_count: i64,
    tool_count: i64,
    tool_use_count: i64,
    outcome: Option<String>,
    partial_output: Option<String>,
    cancelled_reason: Option<String>,
}

impl TerminalRunAccumulator {
    fn observe_event(&mut self, evt: &serde_json::Value) {
        match evt.get("type").and_then(|t| t.as_str()) {
            Some("agent_run_id") => {
                self.run_id = evt
                    .get("agent_run_id")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            Some("cost_info") => {
                self.selected_model = evt.get("model").and_then(|v| v.as_str()).map(String::from);
                self.token_count = evt
                    .get("total_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                self.tool_count = evt.get("tool_count").and_then(|v| v.as_i64()).unwrap_or(0);
            }
            Some("tool_use") | Some("tool_call") => {
                self.tool_use_count += 1;
            }
            Some("result") => {
                let subtype = evt
                    .get("subtype")
                    .and_then(|v| v.as_str())
                    .unwrap_or("success");
                let code = evt.get("code").and_then(|v| v.as_str());
                let is_error = evt
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                self.outcome = Some(map_terminal_outcome(subtype, code, is_error));
                if subtype == "partial" || code == Some("stage_timeout") {
                    self.partial_output =
                        evt.get("result").and_then(|v| v.as_str()).map(String::from);
                }
            }
            Some("cancelled") => {
                self.outcome = Some("cancelled".to_string());
                // 2026-07-13 finding: this used to hardcode "user_stop"
                // regardless of cause, so a resend racing an in-flight turn
                // (server-side ActiveStreamRegistry superseding it) recorded
                // identically to a deliberate Stop click. The Bun server now
                // classifies the real reason (index.ts's classifyAbortReason)
                // and includes it on the frame; fall back to "user_stop" only
                // if an older server build omits the field.
                self.cancelled_reason = Some(
                    evt.get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("user_stop")
                        .to_string(),
                );
            }
            Some("error") => {
                // Timeout failures are emitted as structured `error` frames by
                // Bun (there is no trailing `result` frame on this path). Keep
                // the durable outcome typed so timeout telemetry is not flattened
                // into a generic failure.
                let code = evt.get("code").and_then(|v| v.as_str());
                self.outcome = Some(map_error_outcome(code));
                if code.map(is_timeout_code).unwrap_or(false) {
                    self.partial_output = evt
                        .get("partial_output")
                        .or_else(|| evt.get("result"))
                        .and_then(|v| v.as_str())
                        .map(String::from);
                }
            }
            _ => {}
        }
    }
}

fn is_timeout_code(code: &str) -> bool {
    matches!(
        code,
        "stage_timeout"
            | "first_token_timeout"
            | "stream_idle_timeout"
            | "visible_progress_timeout"
            | "turn_deadline_exceeded"
    )
}

fn map_error_outcome(code: Option<&str>) -> String {
    if code.map(is_timeout_code).unwrap_or(false) {
        "timed_out".to_string()
    } else {
        "failed".to_string()
    }
}

fn map_terminal_outcome(subtype: &str, code: Option<&str>, is_error: bool) -> String {
    if is_error {
        return "failed".to_string();
    }
    if code == Some("stage_timeout") {
        return "timed_out".to_string();
    }
    match subtype {
        "success" => "success".to_string(),
        "partial" => "partial".to_string(),
        "error" => "failed".to_string(),
        _ => "success".to_string(),
    }
}

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
    history: Vec<serde_json::Value>,
    db_path: PathBuf,
) -> Result<(), String> {
    let effective_session_id = if session_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        session_id
    };
    let url = format!("{}/chat/stream", base_url.trim_end_matches('/'));
    let sid = effective_session_id;

    std::thread::spawn(move || {
        eprintln!(
            "[jarvis-chat] relay thread started session={} url={}",
            sid, url
        );
        let _ = app.emit(
            "jarvis://stage",
            serde_json::json!({
                "stage": "stream relay",
                "status": "running",
                "agent": "native",
                "session_id": sid,
            }),
        );

        let emit_error = |app: &AppHandle, sid: &str, msg: String| {
            let _ = app.emit(
                "jarvis://error",
                serde_json::json!({ "error": msg, "session_id": sid }),
            );
        };

        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(900))
            // Bound the connect phase: a stale or wrong-interface cached URL
            // (e.g. WSL IP after a native restart) would otherwise hang the SYN
            // forever — the 900s overall timeout covers the full request, not
            // the individual connect. 5s is long enough to ride out WSL2
            // localhost-forward latency, short enough that a dead URL surfaces
            // an error banner instead of a forever-spinning spinner.
            .connect_timeout(std::time::Duration::from_secs(5))
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
            .json(&serde_json::json!({
                "message": message,
                "session_id": sid,
                "history": history,
            }))
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                eprintln!(
                    "[jarvis-chat] stream POST failed session={} error={}",
                    sid, e
                );
                emit_error(
                    &app,
                    &sid,
                    format!("Could not reach the Jarvis server: {e}"),
                );
                return;
            }
        };

        eprintln!(
            "[jarvis-chat] stream response session={} status={}",
            sid,
            resp.status()
        );

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
        let mut run_acc = TerminalRunAccumulator::default();
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Some(payload) = line.trim().strip_prefix("data:") {
                let payload = payload.trim();
                if !payload.is_empty() && payload != "[DONE]" {
                    if let Ok(evt) = serde_json::from_str::<serde_json::Value>(payload) {
                        run_acc.observe_event(&evt);
                    }
                }
            }
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
                SseFrameOutcome::Recursion {
                    depth,
                    status,
                    reenter_stage,
                    critique,
                } => {
                    let _ = app.emit(
                        "jarvis://recursion",
                        serde_json::json!({
                            "depth": depth,
                            "status": status,
                            "reenter_stage": reenter_stage,
                            "critique": critique,
                            "session_id": sid,
                        }),
                    );
                }
                SseFrameOutcome::AgentRunId { run_id } => {
                    let _ = app.emit(
                        "jarvis://agent_run",
                        serde_json::json!({ "run_id": run_id, "session_id": sid }),
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
                SseFrameOutcome::MessageStop => {
                    // Bun always emits `message_stop` immediately before the trailing
                    // `result` frame (orchestrator + non-orchestrator paths). Do NOT
                    // terminate here — breaking the read loop drops the aggregate
                    // answer when no `stream_event` deltas were sent (orchestrator
                    // synthesizer, holdVisibleText tool turns, etc.). Terminal `done`
                    // is emitted by ResultThenDone / Done / the EOF safety net.
                }
                SseFrameOutcome::Cancelled => {
                    // User-initiated stop — clear the spinner without a scary error banner.
                    let _ = app.emit("jarvis://done", serde_json::json!({ "session_id": sid }));
                    terminated = true;
                    break;
                }
                SseFrameOutcome::ToolCall {
                    call_id,
                    name,
                    arguments,
                } => {
                    let _ = app.emit(
                        "jarvis://tool_call",
                        serde_json::json!({
                            "call_id": call_id,
                            "name": name,
                            "arguments": arguments,
                            "session_id": sid,
                        }),
                    );
                }
                SseFrameOutcome::ReasoningComplete { trace } => {
                    let _ = app.emit(
                        "jarvis://reasoning_complete",
                        serde_json::json!({
                            "trace": trace,
                            "session_id": sid,
                        }),
                    );
                }
                SseFrameOutcome::ToolResult {
                    name,
                    output,
                    is_error,
                    call_id,
                } => {
                    let _ = app.emit(
                        "jarvis://tool_result",
                        serde_json::json!({
                            "call_id": call_id,
                            "name": name,
                            "output": output,
                            "is_error": is_error,
                            "session_id": sid,
                        }),
                    );
                }
                SseFrameOutcome::Cost { tokens, cost_usd } => {
                    let _ = app.emit(
                        "jarvis://cost",
                        serde_json::json!({
                            "tokens": tokens,
                            "cost_usd": cost_usd,
                            "session_id": sid,
                        }),
                    );
                }
                SseFrameOutcome::ApprovalRequest {
                    call_id,
                    name,
                    arguments,
                } => {
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

        // Persist the terminal run outcome to the native SQLite authority. This is
        // the single durable record for the turn; the Bun server must never own a
        // parallel writable session table.
        if let (Some(run_id), Some(outcome)) = (run_acc.run_id.as_ref(), run_acc.outcome.as_ref()) {
            let tool_count = if run_acc.tool_count > 0 {
                run_acc.tool_count
            } else {
                run_acc.tool_use_count
            };
            let _ = persist_terminal_run_at(
                &db_path,
                &sid,
                run_id,
                outcome,
                run_acc.selected_model.as_deref(),
                run_acc.token_count,
                tool_count,
                run_acc.cancelled_reason.as_deref(),
                run_acc.partial_output.as_deref(),
            );
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
    /// `message_stop` frame — terminal. Bun emits this on every chat completion,
    /// so we honor it directly instead of relying on a trailing `result`/EOF only.
    MessageStop,
    /// `cancelled` frame — terminal. Bun emits this on abort and exits without a
    /// trailing `result` or `message_stop`; without honoring it the relay would
    /// block until the 900s reqwest timeout (the EOF fallback eventually clears
    /// the spinner, but the user perceives "no response").
    Cancelled,
    /// Tool call visibility frame — Bun emits `tool_use` (extracted below) when an
    /// agent invokes a tool. We surface it so the UI can render an inline tool-call
    /// card with name + arguments.
    ToolCall {
        call_id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Chain-of-thought trace finalized for the turn (`reasoning_complete`).
    ReasoningComplete { trace: serde_json::Value },
    /// Tool result visibility frame — Bun emits `tool_result` after a tool runs;
    /// we surface output + error flag for the inline card.
    ToolResult {
        call_id: String,
        name: String,
        output: String,
        is_error: bool,
    },
    /// Token usage / cost frame — Bun emits `cost_info`. We surface tokens and
    /// dollar cost so the footer can show the running tally per turn.
    Cost { tokens: i64, cost_usd: f64 },
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
    AgentActivity { stage: String, text: String },
    /// Recursive-critique loop progress (`orchestrator_recursion`). Emitted when the
    /// `recursive` topology enters a critique or re-enter cycle.
    Recursion {
        depth: u64,
        status: String,
        reenter_stage: Option<String>,
        critique: Option<String>,
    },
    /// Stable identifier for the orchestrator run that produced this turn's answer.
    /// Emitted as `agent_run_id` after the pipeline completes; used by self-tuning
    /// to correlate a user rating with the run record in SQLite.
    AgentRunId { run_id: String },
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
                            let is_err = evt
                                .get("is_error")
                                .and_then(|b| b.as_bool())
                                .unwrap_or(false);
                            if is_err {
                                error = Some(text.to_string());
                            } else {
                                token = Some(text.to_string());
                            }
                        } else if evt
                            .get("is_error")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(false)
                        {
                            // Explicit error result with empty text — surface the
                            // subtype (or a generic message) as a readable error.
                            error = Some(
                                evt.get("subtype")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("Empty error result")
                                    .to_string(),
                            );
                        } else {
                            // Empty result with no tokens streamed and no error
                            // flag — most likely the synthesizer threw before
                            // emitting any chunk. Synthesize a fallback token so the
                            // chat bubble isn't blank. Keeps the user informed instead
                            // of staring at a streaming cursor that disappeared.
                            token = Some("⚠ The model returned no content. This can happen due to transient model issues. Try your request again.".to_string());
                        }
                    } else if evt
                        .get("is_error")
                        .and_then(|b| b.as_bool())
                        .unwrap_or(false)
                    {
                        // No result field at all but is_error=true — surface the
                        // subtype if present, otherwise a generic message.
                        error = Some(
                            evt.get("subtype")
                                .and_then(|s| s.as_str())
                                .unwrap_or("Empty model response")
                                .to_string(),
                        );
                    } else {
                        // No result field and no error — same scenario: a fallback
                        // so the chat bubble isn't blank.
                        token = Some("⚠ The model returned no content. This can happen due to transient model issues. Try your request again.".to_string());
                    }
                }
                SseFrameOutcome::ResultThenDone { token, error }
            }
            Some("orchestrator_stage") => SseFrameOutcome::Stage {
                stage: evt
                    .get("stage")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                status: evt
                    .get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                agent: evt
                    .get("agent")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
            },
            Some("reasoning_step") | Some("reasoning_chunk") => {
                if let Some(text) = evt
                    .get("content")
                    .or_else(|| evt.get("chunk"))
                    .or_else(|| evt.get("text"))
                    .and_then(|c| c.as_str())
                {
                    return SseFrameOutcome::Reasoning(text.to_string());
                }
                // Bun emits reasoning_step as `{ step: { content: "..." } }`.
                if evt.get("type").and_then(|t| t.as_str()) == Some("reasoning_step") {
                    if let Some(text) = evt
                        .get("step")
                        .and_then(|s| s.get("content"))
                        .and_then(|c| c.as_str())
                    {
                        return SseFrameOutcome::Reasoning(text.to_string());
                    }
                }
                SseFrameOutcome::Continue
            }
            Some("tool_approval_request") => {
                let call_id = evt
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = evt
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = evt
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                SseFrameOutcome::ApprovalRequest {
                    call_id,
                    name,
                    arguments,
                }
            }
            Some("agent_activity") => {
                if let Some(text) = evt.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        return SseFrameOutcome::AgentActivity {
                            stage: evt
                                .get("stage")
                                .and_then(|s| s.as_str())
                                .unwrap_or("agent")
                                .to_string(),
                            text: text.to_string(),
                        };
                    }
                }
                SseFrameOutcome::Continue
            }
            Some("orchestrator_recursion") => SseFrameOutcome::Recursion {
                depth: evt.get("depth").and_then(|v| v.as_u64()).unwrap_or(0),
                status: evt
                    .get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                reenter_stage: evt
                    .get("reenter_stage")
                    .and_then(|s| s.as_str())
                    .map(str::to_string),
                critique: evt
                    .get("critique")
                    .and_then(|s| s.as_str())
                    .map(str::to_string),
            },
            Some("agent_run_id") => SseFrameOutcome::AgentRunId {
                run_id: evt
                    .get("agent_run_id")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
            },
            Some("message_stop") => SseFrameOutcome::MessageStop,
            Some("cancelled") => SseFrameOutcome::Cancelled,
            Some("reasoning_complete") => {
                let trace = evt.get("trace").cloned().unwrap_or(serde_json::Value::Null);
                SseFrameOutcome::ReasoningComplete { trace }
            }
            Some("tool_use") => {
                let call_id = evt
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| evt.get("call_id").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                let name = evt
                    .get("name")
                    .and_then(|v| v.as_str())
                    .or_else(|| evt.get("tool_name").and_then(|v| v.as_str()))
                    .unwrap_or("unknown")
                    .to_string();
                let arguments = evt
                    .get("arguments")
                    .cloned()
                    .or_else(|| evt.get("input").cloned())
                    .unwrap_or(serde_json::Value::Null);
                SseFrameOutcome::ToolCall {
                    call_id,
                    name,
                    arguments,
                }
            }
            Some("tool_result") => {
                let call_id = evt
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| evt.get("tool_use_id").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                let name = evt
                    .get("name")
                    .and_then(|v| v.as_str())
                    .or_else(|| evt.get("tool_name").and_then(|v| v.as_str()))
                    .unwrap_or("unknown")
                    .to_string();
                let output = evt
                    .get("output")
                    .and_then(|v| v.as_str())
                    .or_else(|| evt.get("content").and_then(|c| c.as_str()))
                    .unwrap_or("")
                    .to_string();
                let is_error = evt
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .or_else(|| {
                        evt.get("status")
                            .and_then(|s| s.as_str())
                            .map(|s| s == "error")
                    })
                    .unwrap_or(false);
                SseFrameOutcome::ToolResult {
                    call_id,
                    name,
                    output,
                    is_error,
                }
            }
            Some("cost_info") => {
                let tokens = evt
                    .get("total_tokens")
                    .and_then(|v| v.as_i64())
                    .or_else(|| evt.get("tokens").and_then(|v| v.as_i64()))
                    .unwrap_or(0);
                let cost_usd = evt
                    .get("cost_usd")
                    .and_then(|v| v.as_f64())
                    .or_else(|| evt.get("cost").and_then(|v| v.as_f64()))
                    .unwrap_or(0.0);
                SseFrameOutcome::Cost { tokens, cost_usd }
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
    fn message_stop_is_non_terminal_marker() {
        // `message_stop` is a progress marker, not a stream terminator. The Bun
        // server always sends a trailing `result` frame after it.
        let mut r = SseRelay::new();
        assert_eq!(
            r.handle_line(r#"data: {"type":"message_stop"}"#),
            SseFrameOutcome::MessageStop,
        );
    }

    #[test]
    fn message_stop_before_result_surfaces_aggregate_answer() {
        // Regression: breaking the SSE read loop on `message_stop` dropped the
        // trailing `result` when no `stream_event` deltas were sent (orchestrator
        // path). The relay must keep parsing through `message_stop`.
        let mut r = SseRelay::new();
        assert_eq!(
            r.handle_line(r#"data: {"type":"message_stop","session_id":"abc"}"#),
            SseFrameOutcome::MessageStop,
        );
        let out = r.handle_line(
            r#"data: {"type":"result","subtype":"success","is_error":false,"result":"final answer"}"#,
        );
        assert_eq!(
            out,
            SseFrameOutcome::ResultThenDone {
                token: Some("final answer".to_string()),
                error: None,
            }
        );
    }

    #[test]
    fn reasoning_chunk_accepts_text_field_from_bun() {
        let mut r = SseRelay::new();
        assert_eq!(
            r.handle_line(r#"data: {"type":"reasoning_chunk","text":"thinking"}"#),
            SseFrameOutcome::Reasoning("thinking".to_string())
        );
    }

    #[test]
    fn reasoning_step_accepts_nested_step_content_from_bun() {
        let mut r = SseRelay::new();
        let out =
            r.handle_line(r#"data: {"type":"reasoning_step","step":{"content":"planning step"}}"#);
        assert_eq!(out, SseFrameOutcome::Reasoning("planning step".to_string()));
    }

    #[test]
    fn cancelled_frame_is_terminal() {
        // Bun's abort path emits `cancelled` and exits without a trailing
        // `result`/`message_stop` — without honoring it the relay blocks until
        // the reqwest 900s timeout.
        let mut r = SseRelay::new();
        assert_eq!(
            r.handle_line(r#"data: {"type":"cancelled"}"#),
            SseFrameOutcome::Cancelled,
        );
    }

    #[test]
    fn empty_result_after_no_tokens_surfaces_a_fallback_token() {
        // Regression: previously a `{type:"result", result:"", is_error:false}`
        // frame following zero tokens would short-circuit on `text.is_empty()`
        // and never emit, leaving no chat bubble while still firing `done`. The
        // user saw the spinner disappear with no message.
        let mut r = SseRelay::new();
        let out = r.handle_line(r#"data: {"type":"result","result":"","is_error":false}"#);
        match out {
            SseFrameOutcome::ResultThenDone {
                token: Some(t),
                error: None,
            } => {
                assert!(!t.is_empty(), "fallback token must be non-empty");
            }
            other => panic!("expected ResultThenDone with a fallback token, got {other:?}"),
        }
    }

    #[test]
    fn empty_result_with_explicit_is_error_surfaces_a_readable_error() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"result","result":"","is_error":true,"subtype":"no_output"}"#,
        );
        match out {
            SseFrameOutcome::ResultThenDone {
                token: None,
                error: Some(e),
            } => {
                assert_eq!(e, "no_output");
            }
            other => panic!("expected ResultThenDone with an error, got {other:?}"),
        }
    }

    #[test]
    fn tool_use_frame_maps_to_tool_call_outcome() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"tool_use","id":"tc_1","name":"shell_exec","arguments":{"cmd":"ls"}}"#,
        );
        match out {
            SseFrameOutcome::ToolCall {
                call_id,
                name,
                arguments,
            } => {
                assert_eq!(call_id, "tc_1");
                assert_eq!(name, "shell_exec");
                assert_eq!(arguments, serde_json::json!({"cmd": "ls"}));
            }
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn reasoning_complete_frame_maps_to_reasoning_complete_outcome() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"reasoning_complete","trace":{"steps":[]},"session_id":"s1"}"#,
        );
        match out {
            SseFrameOutcome::ReasoningComplete { trace } => {
                assert_eq!(trace, serde_json::json!({"steps": []}));
            }
            other => panic!("expected ReasoningComplete, got {other:?}"),
        }
    }

    #[test]
    fn tool_result_frame_maps_to_tool_result_outcome() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"tool_result","call_id":"c1","name":"shell_exec","output":"src\n","is_error":false}"#,
        );
        match out {
            SseFrameOutcome::ToolResult {
                call_id,
                name,
                output,
                is_error,
            } => {
                assert_eq!(call_id, "c1");
                assert_eq!(name, "shell_exec");
                assert_eq!(output, "src\n");
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn cost_info_frame_maps_to_cost_outcome() {
        let mut r = SseRelay::new();
        let out =
            r.handle_line(r#"data: {"type":"cost_info","total_tokens":1234,"cost_usd":0.002}"#);
        match out {
            SseFrameOutcome::Cost { tokens, cost_usd } => {
                assert_eq!(tokens, 1234);
                assert!((cost_usd - 0.002).abs() < 1e-9);
            }
            other => panic!("expected Cost, got {other:?}"),
        }
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
        let out =
            r.handle_line(r#"data: {"type":"agent_activity","stage":"planner","text":"step 1"}"#);
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
        let _ = r.handle_line(
            r#"data: {"type":"agent_activity","stage":"planner","text":"planning..."}"#,
        );
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
    fn orchestrator_recursion_maps_fields() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"orchestrator_recursion","depth":1,"status":"reenter","reenter_stage":"executor","critique":"answer was incomplete"}"#,
        );
        assert!(
            matches!(
                out,
                SseFrameOutcome::Recursion { depth: 1, ref status, ref reenter_stage, ref critique }
                if status == "reenter"
                    && reenter_stage.as_deref() == Some("executor")
                    && critique.as_deref() == Some("answer was incomplete")
            ),
            "expected Recursion, got {out:?}",
        );
    }

    #[test]
    fn orchestrator_recursion_maps_b03_reenter_stages() {
        // B-03: the recursive critic may now re-enter `planner` (a fresh
        // plan), `executor` (re-verify), or `conductor_replan` (defer to
        // the conductor's own replan path). The SSE relay is string-typed
        // for `reenter_stage` so the new values flow through as-is; this
        // test pins that the relay doesn't silently drop or normalize
        // them.
        for stage in ["planner", "executor", "conductor_replan"] {
            let mut r = SseRelay::new();
            let payload = format!(
                r#"data: {{"type":"orchestrator_recursion","depth":1,"status":"reenter","reenter_stage":"{stage}","critique":"b03 test"}}"#
            );
            let out = r.handle_line(&payload);
            assert!(
                matches!(
                    &out,
                    SseFrameOutcome::Recursion { depth: 1, ref status, ref reenter_stage, ref critique }
                    if status == "reenter"
                        && reenter_stage.as_deref() == Some(stage)
                        && critique.as_deref() == Some("b03 test")
                ),
                "expected Recursion for reenter_stage={stage}, got {out:?}",
            );
        }
    }

    #[test]
    fn orchestrator_recursion_handles_missing_optional_fields() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"orchestrator_recursion","depth":0,"status":"critique"}"#,
        );
        assert!(
            matches!(
                out,
                SseFrameOutcome::Recursion { depth: 0, ref status, reenter_stage: None, critique: None }
                if status == "critique"
            ),
            "expected Recursion with optional fields absent, got {out:?}",
        );
    }

    #[test]
    fn agent_run_id_frame_extracts_run_id() {
        let mut r = SseRelay::new();
        let out = r.handle_line(
            r#"data: {"type":"agent_run_id","agent_run_id":"run_abc123","session_id":"sess1"}"#,
        );
        assert_eq!(
            out,
            SseFrameOutcome::AgentRunId {
                run_id: "run_abc123".to_string(),
            }
        );
    }
}

#[cfg(test)]
mod terminal_run_tests {
    use super::*;

    fn temp_migrated_db() -> std::path::PathBuf {
        let db_path =
            std::env::temp_dir().join(format!("jarvis_runner_test_{}.db", uuid::Uuid::new_v4()));
        let conn = rusqlite::Connection::open(&db_path).expect("open temp db");
        crate::db::run_migrations(&conn).expect("run migrations");
        db_path
    }

    #[test]
    fn accumulator_maps_success_result() {
        let mut acc = TerminalRunAccumulator::default();
        acc.observe_event(&serde_json::json!({"type": "agent_run_id", "agent_run_id": "run-1"}));
        acc.observe_event(&serde_json::json!({"type": "cost_info", "model": "deepseek-v4-pro", "total_tokens": 42, "tool_count": 3}));
        acc.observe_event(
            &serde_json::json!({"type": "result", "subtype": "success", "result": "final answer"}),
        );
        assert_eq!(acc.run_id, Some("run-1".to_string()));
        assert_eq!(acc.selected_model, Some("deepseek-v4-pro".to_string()));
        assert_eq!(acc.token_count, 42);
        assert_eq!(acc.tool_count, 3);
        assert_eq!(acc.outcome, Some("success".to_string()));
        assert_eq!(acc.partial_output, None);
    }

    #[test]
    fn accumulator_maps_stage_timeout_to_timed_out() {
        let mut acc = TerminalRunAccumulator::default();
        acc.observe_event(&serde_json::json!({"type": "cost_info", "model": "deepseek-v4-pro", "total_tokens": 12, "tool_count": 1}));
        acc.observe_event(&serde_json::json!({"type": "result", "subtype": "partial", "code": "stage_timeout", "result": "partial answer"}));
        assert_eq!(acc.outcome, Some("timed_out".to_string()));
        assert_eq!(acc.partial_output, Some("partial answer".to_string()));
    }

    #[test]
    fn accumulator_maps_timeout_error_frame_to_timed_out() {
        let mut acc = TerminalRunAccumulator::default();
        acc.observe_event(&serde_json::json!({
            "type": "error",
            "code": "first_token_timeout",
            "error": "model did not start responding",
            "partial_output": ""
        }));
        assert_eq!(acc.outcome, Some("timed_out".to_string()));
    }

    #[test]
    fn accumulator_falls_back_to_counting_tool_use_frames() {
        let mut acc = TerminalRunAccumulator::default();
        acc.observe_event(&serde_json::json!({"type": "tool_use", "name": "read"}));
        acc.observe_event(&serde_json::json!({"type": "tool_use", "name": "grep"}));
        acc.observe_event(
            &serde_json::json!({"type": "result", "subtype": "success", "result": "ok"}),
        );
        assert_eq!(acc.tool_count, 0);
        assert_eq!(acc.tool_use_count, 2);
    }

    #[test]
    fn accumulator_persists_cancelled_run() {
        let db_path = temp_migrated_db();
        {
            let conn = rusqlite::Connection::open(&db_path).expect("open temp db");
            conn.execute(
                "INSERT INTO sessions (id, agent_id, title, backend, model, created_at, updated_at) VALUES (?1, 'main', 'test', 'ollama', 'qwen3:8b', datetime('now'), datetime('now'))",
                ["s1"],
            )
            .expect("insert session");
        }
        let mut acc = TerminalRunAccumulator::default();
        acc.observe_event(
            &serde_json::json!({"type": "agent_run_id", "agent_run_id": "run-cancel"}),
        );
        acc.observe_event(&serde_json::json!({"type": "cancelled"}));
        let (run_id, outcome) = (acc.run_id.unwrap(), acc.outcome.unwrap());
        let record = persist_terminal_run_at(
            &db_path,
            "s1",
            &run_id,
            &outcome,
            None,
            0,
            0,
            acc.cancelled_reason.as_deref(),
            None,
        )
        .expect("persist");
        assert_eq!(record.outcome, "cancelled");
        assert_eq!(record.cancelled_reason.as_deref(), Some("user_stop"));
    }

    #[test]
    fn accumulator_distinguishes_superseded_from_user_stop() {
        // 2026-07-13 finding (live session 7254c3ae): a resend racing an
        // in-flight turn for the same session previously recorded
        // identically to a deliberate Stop click. The server now includes
        // the real reason on the cancelled frame; the accumulator must pass
        // it through rather than hardcoding "user_stop".
        let mut acc = TerminalRunAccumulator::default();
        acc.observe_event(&serde_json::json!({
            "type": "cancelled",
            "reason": "superseded",
        }));
        assert_eq!(acc.outcome.as_deref(), Some("cancelled"));
        assert_eq!(acc.cancelled_reason.as_deref(), Some("superseded"));
    }
}

/// Check Jarvis status: Ollama, Bun server, proxy, bridge, model availability.
/// Uses blocking threads for HTTP checks to avoid tokio runtime issues.
fn check_claude_proxy_status(config: &JarvisConfig, probe: impl FnOnce() -> bool) -> bool {
    crate::claude_proxy_enabled(config) && probe()
}

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
    let bun_server_url =
        crate::wsl::get_cached_bun_url().unwrap_or_else(|| "http://127.0.0.1:19877".to_string());
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
    let claude_proxy_running =
        check_claude_proxy_status(config, || crate::is_port_listening(19878));

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

#[cfg(test)]
mod proxy_status_tests {
    use super::*;

    #[test]
    fn status_skips_proxy_probe_for_disabled_and_subscription_configs() {
        let mut config = JarvisConfig::default();
        config.claude_cli.enabled = false;
        assert!(!check_claude_proxy_status(&config, || {
            panic!("disabled proxy must not be probed by status")
        }));

        config.claude_cli.enabled = true;
        config.claude_cli.auth_mode = crate::jarvis::types::ClaudeCliAuthMode::Subscription;
        assert!(!check_claude_proxy_status(&config, || {
            panic!("subscription proxy must not be probed by status")
        }));

        config.claude_cli.auth_mode = crate::jarvis::types::ClaudeCliAuthMode::Proxy;
        assert!(check_claude_proxy_status(&config, || true));
    }
}
