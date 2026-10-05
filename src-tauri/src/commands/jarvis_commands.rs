use crate::jarvis::bridge::{start_bridge, stop_bridge};
use crate::jarvis::memory::turn::{MemoryRecallStatus, PrepareMemoryTurnRequest};
use crate::jarvis::runner::{check_jarvis_status, run_jarvis_message};
use crate::jarvis::types::*;
use crate::jarvis_types::JarvisState;
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

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
    pub outcome: crate::jarvis::learning::LearningOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub findings: Vec<crate::jarvis::learning::Finding>,
    pub rejected_sources: Vec<crate::jarvis::learning::SourceEvaluation>,
    pub evidence_binding: crate::jarvis::learning::EvidenceBinding,
}

/// Native-validated learning source tuple. Every field is resolved from
/// authoritative persisted stores at the command boundary; the caller's
/// Session/run IDs are selectors only and are re-read here.
struct LearningAuthority {
    session_id: String,
    agent_run_id: String,
    agent_id: String,
    project_root: String,
}

/// Resolve and validate the exact persisted Session/run/Agent/workspace tuple.
/// Fails closed with a concrete reason on any absence, ambiguity, staleness, or
/// unreadable authority. Never uses latest-row heuristics and never accepts
/// caller Agent/workspace/snapshot/permission claims.
fn resolve_learning_authority(
    conn: &rusqlite::Connection,
    session_id: &str,
    agent_run_id: &str,
) -> Result<LearningAuthority, String> {
    let session_id = session_id.trim();
    let agent_run_id = agent_run_id.trim();
    if session_id.is_empty() || agent_run_id.is_empty() {
        return Err(
            "a persisted Session and one completed Agent run must both be selected".to_string(),
        );
    }

    // 1. Session owner Agent + canonical, revalidated project root.
    let scope = crate::jarvis::memory::scope::resolve_session_memory_scope(conn, session_id)
        .map_err(|error| format!("Session authority is unavailable: {}", error.message))?;
    let project_root = scope.project_root.clone().ok_or_else(|| {
        "the selected Session has no canonical project root binding".to_string()
    })?;

    // 2. Exactly one native-written completed run for the exact tuple.
    //
    // The native durable run record is `session_runs`: the native SSE relay
    // writes it with the exact `run_id` the Bun pipeline emits as
    // `agent_run_id`. Native `agent_runs`/`stage_runs` are created by migration
    // but never written by native — Bun's SelfTuningStore owns that telemetry in
    // its own DB (server-jarvis/src/self-tuning/store.ts) — so `agent_runs`
    // cannot be the run authority; `session_runs` is. The outcome must be the
    // completed successful terminal state.
    let run_outcome: Option<String> = conn
        .query_row(
            "SELECT outcome FROM session_runs WHERE run_id = ?1 AND session_id = ?2",
            rusqlite::params![agent_run_id, session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("could not read the selected Agent run: {error}"))?;
    match run_outcome.as_deref() {
        Some("success") => {}
        Some(other) => {
            return Err(format!(
                "the selected Agent run is not a completed successful run (outcome: {other})"
            ))
        }
        None => {
            return Err(
                "the selected Agent run is not a persisted completed run of the selected Session"
                    .to_string(),
            )
        }
    }

    // 3. Enabled Agent with a current, valid projection (builtin Jarvis has no
    //    projection row by design; resolve_activation_boundary owns that rule).
    crate::commands::agents::resolve_activation_boundary(conn, &scope.agent_id)
        .map_err(|denial| format!("Agent authority is unavailable: {}", denial.reason()))?;

    // 4. If the native telemetry mirror happens to hold a row for this run, it
    //    must agree with the selected Session and be completed. The mirror is
    //    normally schema-only, so absence is not a failure; a present-but-
    //    inconsistent row is.
    let mirror: Option<(i64, String)> = conn
        .query_row(
            "SELECT completed, session_id FROM agent_runs WHERE id = ?1",
            [agent_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("could not read native run mirror: {error}"))?;
    if let Some((completed, mirror_session_id)) = mirror {
        if completed != 1 {
            return Err("the selected Agent run is not marked completed in the native mirror".to_string());
        }
        if mirror_session_id != session_id {
            return Err(
                "the selected Agent run belongs to a different Session in the native mirror"
                    .to_string(),
            );
        }
    }

    Ok(LearningAuthority {
        session_id: session_id.to_string(),
        agent_run_id: agent_run_id.to_string(),
        agent_id: scope.agent_id,
        project_root,
    })
}

/// Build the explicit unavailable result. Carries no findings, no output path,
/// and never a fabricated binding.
fn unavailable_learning_result(
    topic: String,
    subtopic: String,
    started_at: String,
    rejected_sources: Vec<crate::jarvis::learning::SourceEvaluation>,
    reason: impl Into<String>,
) -> LearningRunResult {
    LearningRunResult {
        topic,
        subtopic,
        started_at,
        finished_at: chrono::Utc::now().to_rfc3339(),
        output_path: String::new(),
        outcome: crate::jarvis::learning::LearningOutcome::Unavailable,
        reason: Some(reason.into()),
        findings: Vec::new(),
        rejected_sources,
        evidence_binding: crate::jarvis::learning::EvidenceBinding::unavailable(
            "no authoritative learning source binding was dispatched",
        ),
    }
}

/// True only for a strict lowercase SHA-256 hex value (exactly 64 characters).
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// True only for a strict `sha256:<64 lowercase hex>` digest.
fn is_sha256_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .map(is_sha256_hex)
        .unwrap_or(false)
}

/// Validate one finding's provenance against the response-level binding. Every
/// identity field must tie back to the verified trajectory, the producing Bun
/// instance, and an actual `web_fetch` tool call, and the source citation must
/// be a genuine Tier 1 HTTP(S) URL whose host/digest/reference agree.
fn validate_learning_finding(
    finding: &crate::jarvis::learning::Finding,
    response: &crate::jarvis::learning::LearningResearchResponse,
    authority: &LearningAuthority,
) -> Result<(), String> {
    use crate::jarvis::learning;

    if finding.run_id != authority.agent_run_id {
        return Err("a finding is not bound to the validated run".to_string());
    }
    let binding_digest = response
        .evidence_binding
        .tool_sequence_digest
        .as_deref()
        .unwrap_or("");
    if finding.trajectory_digest != binding_digest {
        return Err("a finding does not carry the validated trajectory digest".to_string());
    }
    if finding.bun_instance_id != response.bun_instance_id {
        return Err("a finding was produced by a different Bun instance".to_string());
    }
    if finding.tool_name != "web_fetch" {
        return Err("a finding was produced by an unexpected tool".to_string());
    }
    let call_suffix = finding
        .tool_call_id
        .strip_prefix("web_fetch-")
        .ok_or_else(|| "a finding has an unexpected tool call id".to_string())?;
    if call_suffix.is_empty() || uuid::Uuid::parse_str(call_suffix).is_err() {
        return Err("a finding has an invalid tool call id".to_string());
    }

    let evaluated = learning::evaluate_source(&finding.source_url);
    if !matches!(evaluated.tier, learning::CredibilityTier::Tier1) {
        return Err("a finding cites a source outside the Tier 1 allowlist".to_string());
    }
    let parsed = reqwest::Url::parse(&finding.source_url)
        .map_err(|_| "a finding cites a malformed source URL".to_string())?;
    let host = parsed
        .host_str()
        .map(|value| value.to_lowercase())
        .ok_or_else(|| "a finding cites a source URL with no host".to_string())?;
    if host != finding.source_host.to_lowercase() {
        return Err("a finding's source host does not match its URL".to_string());
    }

    let digest = finding
        .content_digest
        .strip_prefix("sha256:")
        .ok_or_else(|| "a finding has a non-SHA-256 content digest".to_string())?;
    if !is_sha256_hex(digest) {
        return Err("a finding has an invalid content digest".to_string());
    }
    let expected_reference = format!("{}#sha256={}", finding.source_url, digest);
    if finding.reference != expected_reference {
        return Err("a finding's reference is not bound to its URL and digest".to_string());
    }
    Ok(())
}

/// Validate the Bun learning response identity and every finding against the
/// native-validated authority before anything is persisted. Any mismatch fails
/// closed as unavailable with no output write; no evidence is synthesized.
fn validate_learning_response(
    response: &crate::jarvis::learning::LearningResearchResponse,
    request_id: &str,
    authority: &LearningAuthority,
) -> Result<(), String> {
    use crate::jarvis::learning;

    if response.request_id != request_id {
        return Err("Bun returned a response for a different research request".to_string());
    }
    if response.bun_instance_id.trim().is_empty() {
        return Err("Bun returned no instance identity".to_string());
    }
    let binding = &response.evidence_binding;
    if binding.status != learning::EvidenceBindingStatus::Bound {
        return Err("Bun did not return a bound learning evidence binding".to_string());
    }
    if binding.agent_run_id.as_deref() != Some(authority.agent_run_id.as_str())
        || binding.session_id.as_deref() != Some(authority.session_id.as_str())
    {
        return Err(
            "Bun evidence binding does not match the validated run and Session".to_string(),
        );
    }
    let digest = binding.tool_sequence_digest.as_deref().unwrap_or("");
    if !is_sha256_digest(digest) {
        return Err("Bun evidence binding has no strict SHA-256 tool-sequence digest".to_string());
    }
    if response.run_id != authority.agent_run_id {
        return Err("Bun response run identity does not match the validated run".to_string());
    }

    match &response.outcome {
        learning::LearningOutcome::Unavailable => {
            if !response.findings.is_empty() {
                return Err("Bun reported unavailable while returning findings".to_string());
            }
            return Ok(());
        }
        learning::LearningOutcome::Complete | learning::LearningOutcome::Partial => {}
    }
    if response.findings.is_empty() {
        return Err("Bun reported a successful outcome with no findings".to_string());
    }
    for finding in &response.findings {
        validate_learning_finding(finding, response, authority)?;
    }
    Ok(())
}

/// Run a source-grounded learning session for one user-selected persisted
/// Session and one exact completed Agent run.
///
/// `session_id` and `agent_run_id` are selectors only. Native re-reads both in
/// SQLite and resolves all authority from persisted stores: the Session's owner
/// Agent and canonical project root, an enabled Agent projection, and the exact
/// native `session_runs` completed-run record (with an optional consistency
/// check against the schema-only `agent_runs` mirror). Any absent, duplicate,
/// stale, conflicting, or unreadable record yields explicit `unavailable` with
/// no dispatch and no file.
///
/// Only after that verification is a typed request (the validated tuple plus
/// topic/seeds) sent to the owned Bun service over the private capability
/// transport. Bun resolves the exact stored trajectory by run+session, strictly
/// decodes it, and runs existing `web_search`/`web_fetch` ToolRuntime tools in
/// the validated Session/workspace context under the existing permission
/// policy. A session file is written only when genuine findings exist.
#[tauri::command]
pub async fn run_learning_session(
    db: State<'_, crate::db::AppDb>,
    topic: String,
    session_id: String,
    agent_run_id: String,
    seed_urls: Option<Vec<String>>,
    out_dir: Option<String>,
) -> Result<LearningRunResult, String> {
    use crate::jarvis::learning;

    let started_at = chrono::Utc::now().to_rfc3339();

    // Resolved for later use only. Nothing is created or written unless genuine
    // findings are ready to persist; a failed authority resolution or an empty
    // result must not leave a directory or file.
    let out_path = match out_dir {
        Some(d) => std::path::PathBuf::from(d),
        None => {
            let mut p = std::path::PathBuf::from(crate::wsl::wsl_home());
            p.push(".jarvis");
            p.push("learning");
            p
        }
    };

    let subtopic = learning::next_subtopic(&[]).to_string();

    // Existing Tier 1 host gate for caller feedback only.
    let mut accepted: Vec<String> = Vec::new();
    let mut rejected: Vec<learning::SourceEvaluation> = Vec::new();
    for url in seed_urls.unwrap_or_default() {
        let ev = learning::evaluate_source(&url);
        if matches!(ev.tier, learning::CredibilityTier::Tier1) {
            accepted.push(url);
        } else {
            rejected.push(ev);
        }
    }

    // Resolve the exact persisted tuple. The AppDb mutex is released before any
    // blocking Bun transport call.
    let authority = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        match resolve_learning_authority(&conn, &session_id, &agent_run_id) {
            Ok(authority) => authority,
            Err(reason) => {
                return Ok(unavailable_learning_result(
                    topic, subtopic, started_at, rejected, reason,
                ))
            }
        }
    };

    let request = learning::LearningResearchRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        agent_run_id: authority.agent_run_id.clone(),
        session_id: authority.session_id.clone(),
        agent_id: authority.agent_id.clone(),
        project_root: authority.project_root.clone(),
        topic: topic.clone(),
        subtopic: subtopic.clone(),
        seed_urls: accepted,
        max_sources: 8,
        timeout_ms: 180_000,
    };
    let request_id = request.request_id.clone();

    let response = tauri::async_runtime::spawn_blocking(move || {
        let transport = crate::jarvis::memory::transport::native_memory_transport();
        crate::jarvis::memory::transport::execute_learning_research(transport, &request)
    })
    .await;

    let response = match response {
        Ok(Ok(Some(response))) => response,
        Ok(Ok(None)) => {
            return Ok(unavailable_learning_result(
                topic,
                subtopic,
                started_at,
                rejected,
                "owned Bun runtime is not live; research was not dispatched",
            ))
        }
        Ok(Err(error)) => {
            return Ok(unavailable_learning_result(
                topic, subtopic, started_at, rejected, error,
            ))
        }
        Err(join_error) => {
            return Ok(unavailable_learning_result(
                topic,
                subtopic,
                started_at,
                rejected,
                format!("learning research task join error: {join_error}"),
            ))
        }
    };

    // Validate the Bun response identity and every finding against the exact
    // native-validated tuple before anything is persisted. An inconsistent
    // response fails closed as unavailable with no output write.
    if let Err(reason) = validate_learning_response(&response, &request_id, &authority) {
        return Ok(unavailable_learning_result(
            topic, subtopic, started_at, rejected, reason,
        ));
    }

    let binding = response.evidence_binding;
    let mut rejected = rejected;
    for source in response.rejected_sources {
        rejected.push(learning::SourceEvaluation {
            url: source.url,
            tier: learning::CredibilityTier::Rejected,
            credibility_note: source.reason,
        });
    }
    let findings = response.findings;

    // Persist only genuine source-grounded findings. The output directory is
    // created here, after the response was validated and real findings are in
    // hand, so unavailable/empty results leave no directory or file behind.
    let mut output_path = String::new();
    if !findings.is_empty() {
        std::fs::create_dir_all(&out_path)
            .map_err(|e| format!("Failed to create learning output directory: {}", e))?;
        let path = learning::output_path(&out_path, &topic);
        let body = format!(
            "# Learning Session — {}\n\n- Topic: `{}`\n- Subtopic: `{}`\n- Started: {}\n- Outcome: `{:?}`\n- Source run: `{}`\n- Source session: `{}`\n- Trajectory digest: `{}`\n- Sources: {}\n- Rejected/unavailable: {}\n\n## Findings\n\n{}\n",
            topic,
            topic,
            subtopic,
            started_at,
            response.outcome,
            authority.agent_run_id,
            authority.session_id,
            binding.tool_sequence_digest.as_deref().unwrap_or(""),
            findings.len(),
            rejected.len(),
            findings
                .iter()
                .map(|f| format!(
                    "- **{}** — {} [{}]\n  {} — {}\n  digest: {} | trajectory: {} | tool: {} call: {} run: {}\n  reference: {}\n",
                    f.subtopic,
                    f.source_url,
                    f.source_host,
                    f.retrieved_at,
                    f.excerpt,
                    f.content_digest,
                    f.trajectory_digest,
                    f.tool_name,
                    f.tool_call_id,
                    f.run_id,
                    f.reference,
                ))
                .collect::<Vec<_>>()
                .join("\n"),
        );
        std::fs::write(&path, body)
            .map_err(|e| format!("Failed to write learning session: {}", e))?;
        output_path = path.to_string_lossy().into_owned();
    }

    Ok(LearningRunResult {
        topic,
        subtopic,
        started_at,
        finished_at: chrono::Utc::now().to_rfc3339(),
        output_path,
        outcome: response.outcome,
        reason: response.reason,
        findings,
        rejected_sources: rejected,
        evidence_binding: binding,
    })
}

#[tauri::command]
pub async fn jarvis_send_message(
    app: AppHandle,
    db: tauri::State<'_, crate::db::AppDb>,
    message: String,
    session_id: String,
    // Optional caller-supplied stable turn id (additive, backward compatible).
    // It is only a correlation identity: Native still prepares the turn against
    // its own persisted row and never treats a client id as memory authority.
    turn_id: Option<String>,
    // Optional Goal association selected by the user. It is NOT authority by
    // itself: native validates the Goal's current Session/Agent/canonical-
    // project binding against this exact Session and only then registers a
    // bounded one-shot Goal run binding with the owned Bun child. An invalid
    // or cross-scope Goal fails closed rather than running goal-less.
    goal_id: Option<String>,
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

    // Persist the exact user row FIRST when a real Session exists. Native
    // memory preparation must reference the persisted row id, never an
    // optimistic identity; a blank Session runs ordinary relay inference and
    // cannot become a memory-enabled turn.
    let user_message_id = if session_id.is_empty() {
        None
    } else {
        Some(crate::commands::sessions::insert_message_row(
            &db,
            &session_id,
            "user",
            &message,
            0,
        )?)
    };

    // Native prompt history stops before the exact source row and excludes all
    // later rows. The operator transcript command is untouched. A failed read
    // preserves ordinary relay inference with empty history and surfaces an
    // observable warning; it never silently erases the error.
    let mut history = Vec::new();
    let mut history_unavailable = false;
    if let Some(user_message_id) = user_message_id.as_deref() {
        // One operation-gate-scoped drain + snapshot: the SAME operation mutex
        // covers the pending-cleanup drain and the suppression-aware history
        // read, so no semantic mutation can interleave between them (no TOCTOU)
        // and a stale derived context is never served. The bounded HTTP runs in
        // spawn_blocking, never on the Tauri async executor. A failed drain or
        // history read fails closed: there is no raw-history fallback.
        let app_for_history = app.clone();
        let session_for_history = session_id.clone();
        let before_for_history = user_message_id.to_string();
        let history_result = tauri::async_runtime::spawn_blocking(move || {
            let state = app_for_history.state::<crate::db::AppDb>();
            let transport = crate::jarvis::memory::transport::native_memory_transport();
            crate::jarvis::memory::transport::read_memory_turn_history(
                state.inner(),
                transport,
                &session_for_history,
                &before_for_history,
                chrono::Utc::now(),
            )
        })
        .await;
        match history_result {
            Ok(Ok(messages)) => {
                history = messages
                    .into_iter()
                    .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                    .collect();
            }
            Ok(Err(error)) => {
                history_unavailable = true;
                eprintln!("[jarvis-chat] native memory history failed: {}", error);
            }
            Err(error) => {
                history_unavailable = true;
                eprintln!(
                    "[jarvis-chat] native memory history task join error: {}",
                    error
                );
            }
        }
    }

    // One stable turn identity for this relay turn, distinct from the opaque
    // native preparation id. A caller may supply it so the UI can correlate the
    // relay's asynchronous events unambiguously; otherwise it is generated.
    let turn_id = match turn_id {
        Some(id) if !id.trim().is_empty() => id,
        _ => uuid::Uuid::new_v4().to_string(),
    };

    // Resolve and register the native-authorized Goal run binding BEFORE the
    // relay starts. The Goal is validated against this exact persisted Session,
    // and native loads the exact saved user source row (the same
    // `user_message_id` native inserted above), computes its canonical UTF-8
    // SHA-256, and mints the stable TaskRun identity. A non-empty but
    // invalid/cross-scope Goal fails closed (the turn is not run goal-less under
    // a Goal the user selected). A confirmed registration is required for the
    // terminal run record to later verify a Goal association.
    let validated_goal_binding_id: Option<String> = match goal_id.as_deref().map(str::trim) {
        Some("") | None => None,
        Some(candidate) => {
            let Some(source_message_id) = user_message_id.as_deref() else {
                return Err("a goal-linked run requires a persisted Session".to_string());
            };
            let transport = crate::jarvis::memory::transport::native_memory_transport();
            let preparation = crate::jarvis::memory::transport::register_goal_run_binding(
                db.inner(),
                transport,
                candidate,
                &session_id,
                &turn_id,
                source_message_id,
            )
            .map_err(|error| error.message)?;
            // Validation succeeded. If the owned child could not confirm the
            // bounded one-shot, the turn proceeds goal-less rather than
            // attributing the run to a Goal whose authority was not
            // established. This is fail-closed for authority, not for the turn.
            match preparation.binding_id {
                Some(binding_id) if preparation.registered => Some(binding_id),
                _ => {
                    eprintln!(
                        "[jarvis-chat] goal binding not registered turn={} goal={} (running goal-less)",
                        turn_id, candidate
                    );
                    None
                }
            }
        }
    };

    // Metadata-only, observable history warning tied to this turn. It does not
    // fabricate a saved row or memory readiness.
    if history_unavailable {
        let _ = app.emit(
            "jarvis://memory-status",
            serde_json::json!({
                "turn_id": &turn_id,
                "session_id": &session_id,
                "status": "unavailable",
                "selected_ids": [],
                "store_revision": serde_json::Value::Null,
                "code": "history_unavailable",
            }),
        );
    }

    let (memory_preparation_id, initial_memory_status) = match user_message_id.as_deref() {
        Some(user_message_id) => {
            let request = PrepareMemoryTurnRequest {
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                user_message_id: user_message_id.to_string(),
                include_user_scope: false,
            };
            let app_for_prepare = app.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                let db = app_for_prepare.state::<crate::db::AppDb>();
                let transport = crate::jarvis::memory::transport::native_memory_transport();
                crate::jarvis::memory::transport::prepare_memory_turn(
                    db.inner(),
                    transport,
                    request,
                    chrono::Utc::now(),
                )
            })
            .await
            {
                Ok(Ok(preparation)) => (preparation.preparation_id, preparation.status),
                Ok(Err(error)) => {
                    eprintln!("[jarvis-chat] memory preparation failed: {}", error);
                    (None, MemoryRecallStatus::Unavailable)
                }
                Err(error) => {
                    // A join failure must not skip the persisted turn: fail
                    // closed to typed unavailable and continue ordinary relay
                    // inference, where the terminal finalizer still runs.
                    eprintln!("[jarvis-chat] memory prepare task join error: {}", error);
                    (None, MemoryRecallStatus::Unavailable)
                }
            }
        }
        None => (None, MemoryRecallStatus::Unavailable),
    };

    eprintln!("[jarvis-chat] spawning stream relay session={}", session_id);
    let db_path = db.db_path.clone();
    // Carry the ORIGINAL newly saved relay user source id and exact hash to the
    // runner/finalizer. A public caller may reuse a turn id; the finalizer binds
    // assistant append and capture to this exact source and refuses to mutate or
    // republish an old canonical turn. These are internal coordination values,
    // never public authority.
    let source_message_id = user_message_id.clone().unwrap_or_default();
    let source_message_hash = crate::jarvis::memory::turn::message_sha256(&message);
    run_jarvis_message(
        app,
        base_url,
        session_id,
        message,
        history,
        db_path,
        turn_id,
        source_message_id,
        source_message_hash,
        memory_preparation_id,
        initial_memory_status,
        validated_goal_binding_id,
    )
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
        agent_id: s.agent_id,
        project_root: s.project_root,
    }
}

#[tauri::command]
pub async fn jarvis_new_session(
    name: Option<String>,
    agent_id: Option<String>,
    state: State<'_, JarvisState>,
    db: State<'_, crate::db::AppDb>,
) -> Result<JarvisSession, String> {
    let (backend, model) = {
        let config = state.config.lock().await;
        let model = match config.active_backend {
            crate::jarvis::types::JarvisBackend::Ollama => config.ollama.model.clone(),
            crate::jarvis::types::JarvisBackend::OpenRouter => config.openrouter.model.clone(),
            crate::jarvis::types::JarvisBackend::LlamaCpp => config.llama_cpp.model.clone(),
            crate::jarvis::types::JarvisBackend::ClaudeCli => {
                config.claude_cli.model.clone().unwrap_or_default()
            }
        };
        (config.active_backend.to_string(), model)
    };
    // An omitted Agent preserves the historical `main` alias behavior (a
    // Session may carry `main` even when no Agent row exists). An explicit
    // selection must resolve to an enabled native Agent identity; an unknown
    // or disabled identity fails WITHOUT creating a Session. Agent ownership is
    // immutable for the life of the Session.
    let resolved_agent = match agent_id {
        Some(raw) => {
            let candidate = raw.trim().to_string();
            if candidate.is_empty() {
                return Err("Agent selection must not be empty".to_string());
            }
            let agent = {
                let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
                crate::commands::agents::fetch_agent(&conn, &candidate)?
            };
            match agent {
                Some(agent) if agent.enabled => agent.id,
                Some(_) => return Err(format!("Agent is disabled: {candidate}")),
                None => return Err(format!("Unknown Agent: {candidate}")),
            }
        }
        None => "main".to_string(),
    };
    let s = crate::commands::create_session_row(
        &db,
        name,
        Some(resolved_agent),
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
pub async fn jarvis_delete_session(app: AppHandle, session_id: String) -> Result<(), String> {
    crate::commands::memory_turn::run_derived_gated_mutation(
        app,
        session_id.clone(),
        {
            let session_for_plan = session_id.clone();
            move |_conn| {
                Ok(crate::jarvis::memory::capture_contracts::NativeDerivedMutationPlan {
                    invalidation:
                        crate::jarvis::memory::capture_contracts::MemoryDerivedInvalidation {
                            operation_id: uuid::Uuid::new_v4().to_string(),
                            affected_session_ids: vec![session_for_plan],
                            memory_ids: Vec::new(),
                            source_message_ids: Vec::new(),
                        },
                    scope: None,
                })
            }
        },
        move |conn, _plan| {
            crate::commands::sessions::delete_session_row_conn(conn, &session_id)
                .map_err(crate::jarvis::memory::contracts::MemoryError::storage_unavailable)
        },
    )
    .await
    .map_err(|error| error.message)?;
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
    let llama_cpp = config.llama_cpp.clone();
    {
        let mut guard = state.config.lock().await;
        *guard = config;
    }
    // Bring up whatever the (possibly newly selected) backend needs — e.g. start
    // Ollama when the user switches to it in Control. Idempotent + non-blocking.
    crate::reconcile_backend_services(backend, ollama_model, llama_cpp);
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
