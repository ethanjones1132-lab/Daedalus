// ═══════════════════════════════════════════════════════════════
// Native memory capture commands — Phase 3.2 gated surface
// ═══════════════════════════════════════════════════════════════
//
// Every command here resolves its exact operation metadata (target revision,
// scope, affected Sessions, memory ids, source message ids) BEFORE entering the
// Phase 3.2 derived-state gate. The gate ACKs unconsumed-preparation
// invalidation plus scoped derived cleanup before the atomic native mutation,
// so a failed cleanup can never confirm a mutation. Replay lookups precede the
// gate and return the persisted original result without invalidating.

use chrono::Utc;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::AppDb;
use crate::jarvis::memory::capture::{self, UserMemoryOperation};
use crate::jarvis::memory::capture_contracts::{
    CaptureReceipt, CaptureReceiptsRequest, CaptureTurnRequest, CorrectionResult,
    ForgetResult, MemoryDerivedInvalidation, NativeDerivedMutationPlan, ScopedCorrectRequest,
    ScopedForgetRequest, StageProposalRequest,
};
use crate::jarvis::memory::contracts::{
    AuthorityKind, MemoryError, MemoryProvenance, MutationResult,
};
use crate::jarvis::memory::scope;
use crate::jarvis::memory::transport::{self, native_memory_transport};
use crate::jarvis::memory::turn::{self, MemoryTurnIdentityRequest};
use crate::jarvis::memory::continuity;

fn join_error(context: &str, error: impl std::fmt::Display) -> MemoryError {
    MemoryError::storage_unavailable(format!("{context}: {error}"))
}

fn manual_provenance(session_id: &str) -> MemoryProvenance {
    MemoryProvenance {
        authority_kind: AuthorityKind::Manual,
        source: "manual".to_string(),
        source_session_id: Some(session_id.to_string()),
        source_message_ids: Vec::new(),
        source_run_id: None,
        verified_at: None,
    }
}

/// Build the derived-invalidation payload for one recorded user turn. Only
/// correction/forget/acceptance name an existing target whose source lineage
/// must be suppressed; a save/additive operation carries no memory id.
fn capture_turn_invalidation(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
) -> Result<NativeDerivedMutationPlan, MemoryError> {
    let persisted = turn::read_memory_turn(conn, session_id, turn_id)?;
    let parsed = capture::parse_user_memory_operation(&persisted)?;
    let mut memory_ids: Vec<String> = Vec::new();
    match &parsed {
        Some(UserMemoryOperation::Correct { id, .. })
        | Some(UserMemoryOperation::Forget { id, .. })
        | Some(UserMemoryOperation::AcceptProposal { id }) => memory_ids.push(id.clone()),
        _ => {}
    }
    let source_message_ids = if memory_ids.is_empty() {
        Vec::new()
    } else {
        continuity::collect_memory_source_message_ids(conn, &persisted.scope, &memory_ids)?
    };
    let affected_session_ids = continuity::collect_affected_session_ids(
        conn,
        session_id,
        Some(&persisted.scope),
        &memory_ids,
    )?;
    Ok(NativeDerivedMutationPlan {
        invalidation: MemoryDerivedInvalidation {
            operation_id: format!("turn/{turn_id}/user/0"),
            affected_session_ids,
            memory_ids,
            source_message_ids,
        },
        scope: Some(persisted.scope),
    })
}

/// Emit one metadata-only `capture_unavailable` status frame so a sync/join
/// failure is observable without claiming assistant verification or inventing a
/// receipt field.
fn emit_capture_unavailable(app: &AppHandle, session_id: &str, turn_id: &str, code: &str) {
    let _ = app.emit(
        "jarvis://memory-status",
        serde_json::json!({
            "turn_id": turn_id,
            "session_id": session_id,
            "status": "unavailable",
            "selected_ids": [],
            "store_revision": serde_json::Value::Null,
            "code": code,
        }),
    );
}

/// Capture the explicit user operation on one persisted turn. Attempts the
/// private Phase 2 sync first; a sync failure is observable and does not block
/// explicit user admission from the existing immutable record. An exact
/// already-committed replay is resolved through the validated 3.1 capture
/// revalidation before any invalidation, so a conflicting payload/terminal
/// tuple is rejected and no mutation is replayed.
#[tauri::command]
pub async fn memory_capture_turn(
    app: AppHandle,
    request: CaptureTurnRequest,
) -> Result<CaptureReceipt, MemoryError> {
    let sync_session = request.session_id.clone();
    let sync_turn = request.turn_id.clone();
    let app_for_sync = app.clone();
    let sync_result = tauri::async_runtime::spawn_blocking(move || {
        let db = app_for_sync.state::<AppDb>();
        let transport = native_memory_transport();
        transport::sync_memory_turn(
            db.inner(),
            transport,
            MemoryTurnIdentityRequest {
                session_id: sync_session,
                turn_id: sync_turn,
            },
            Utc::now(),
        )
        .map(|_| ())
    })
    .await;
    match &sync_result {
        Ok(Err(error)) => {
            eprintln!("[memory] capture pre-sync failed: {}", error);
            emit_capture_unavailable(&app, &request.session_id, &request.turn_id, "capture_unavailable");
        }
        Err(error) => {
            eprintln!("[memory] capture pre-sync join error: {}", error);
            emit_capture_unavailable(&app, &request.session_id, &request.turn_id, "capture_unavailable");
        }
        Ok(Ok(())) => {}
    }

    let session_id = request.session_id.clone();
    let turn_id = request.turn_id.clone();
    let gate_session = session_id.clone();
    let resolve_session = session_id.clone();
    let resolve_turn = turn_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();

        transport::run_derived_mutation_gate_with_replay(
            db.inner(),
            transport,
            &gate_session,
            move |conn| {
                let persisted = turn::read_memory_turn(conn, &resolve_session, &resolve_turn)?;
                // An existing receipt (finalized replay, one-time terminal
                // augmentation, or repeated pre-terminal observation) carries no
                // new semantic mutation. The canonical 3.1 capture helper handles
                // it (including terminal-conflict rejection) with NO HTTP cleanup
                // and NO invalidation.
                if capture::read_capture_receipt(conn, &resolve_session, &resolve_turn)?.is_some() {
                    let receipt = capture::capture_recorded_turn(conn, &persisted, Utc::now())?;
                    return Ok(transport::DerivedGatePlan::Replay(receipt));
                }
                // Ordinary text (`None`) or an ambiguous/quoted/multiple
                // directive (`Pending`) has no accepted mutation authority:
                // persist the ledger receipt without cleanup/invalidation.
                match capture::parse_user_memory_operation(&persisted)? {
                    None | Some(UserMemoryOperation::Pending { .. }) => {
                        let receipt = capture::capture_recorded_turn(conn, &persisted, Utc::now())?;
                        Ok(transport::DerivedGatePlan::Replay(receipt))
                    }
                    // A valid accepted user write recomputes its exact affected
                    // ids under the gate and ACKs cleanup before committing.
                    Some(_) => Ok(transport::DerivedGatePlan::Invalidate(
                        capture_turn_invalidation(conn, &resolve_session, &resolve_turn)?,
                    )),
                }
            },
            move |conn, _plan| {
                // Reload the canonical turn inside the gate and run the full
                // validated 3.1 capture: payload/scope/terminal checks,
                // null->terminal augmentation, and exact receipt replay all
                // proceed through the same authority.
                let persisted = turn::read_memory_turn(conn, &session_id, &turn_id)?;
                capture::capture_recorded_turn(conn, &persisted, Utc::now())
            },
        )
    })
    .await
    .map_err(|error| join_error("memory capture task join error", error))?
}

/// Read-only receipt lookup. Missing receipts are reported as `null`; nothing
/// is mutated or invalidated.
#[tauri::command]
pub fn memory_capture_receipts(
    db: State<AppDb>,
    request: CaptureReceiptsRequest,
) -> Result<Option<CaptureReceipt>, MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    capture::read_capture_receipt(&conn, &request.session_id, &request.turn_id)
}

/// Exact canonical replay for a manual correct/forget. Returns the persisted
/// result only when the stored payload hash matches the exact requested
/// operation; a same-identity/different-payload retry is `operation_conflict`.
fn replay_manual_correct(
    conn: &Connection,
    request: &ScopedCorrectRequest,
) -> Result<Option<CorrectionResult>, MemoryError> {
    let scope = scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    let payload_hash = capture::manual_correct_hash(
        &request.session_id,
        &scope,
        &request.id,
        request.expected_revision,
        &request.draft,
    );
    capture::replay_operation_result(
        conn,
        &request.session_id,
        &request.operation_id,
        &payload_hash,
    )
}

fn replay_manual_forget(
    conn: &Connection,
    request: &ScopedForgetRequest,
) -> Result<Option<ForgetResult>, MemoryError> {
    let scope = scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    let payload_hash = capture::manual_forget_hash(
        &request.session_id,
        &scope,
        &request.id,
        request.expected_revision,
        &request.reason,
    );
    capture::replay_operation_result(
        conn,
        &request.session_id,
        &request.operation_id,
        &payload_hash,
    )
}

#[tauri::command]
pub async fn memory_scoped_correct(
    app: AppHandle,
    request: ScopedCorrectRequest,
) -> Result<CorrectionResult, MemoryError> {
    let session_id = request.session_id.clone();
    let resolve_request = request.clone();
    super::memory_turn::run_derived_gated_mutation_with_replay(
        app,
        session_id,
        move |conn| {
            // Exact canonical replay precedes cleanup/invalidation.
            if let Some(prior) = replay_manual_correct(conn, &resolve_request)? {
                return Ok(transport::DerivedGatePlan::Replay(prior));
            }
            let scope =
                scope::resolve_write_scope(conn, &resolve_request.session_id, &resolve_request.selector)?;
            let memory_ids = vec![resolve_request.id.clone()];
            let source_message_ids =
                continuity::collect_memory_source_message_ids(conn, &scope, &memory_ids)?;
            let affected_session_ids = continuity::collect_affected_session_ids(
                conn,
                &resolve_request.session_id,
                Some(&scope),
                &memory_ids,
            )?;
            Ok(transport::DerivedGatePlan::Invalidate(NativeDerivedMutationPlan {
                invalidation: MemoryDerivedInvalidation {
                    operation_id: resolve_request.operation_id.clone(),
                    affected_session_ids,
                    memory_ids,
                    source_message_ids,
                },
                scope: Some(scope),
            }))
        },
        move |conn, _plan| {
            // Recheck the operation identity inside the gate to close races.
            if let Some(prior) = replay_manual_correct(conn, &request)? {
                return Ok(prior);
            }
            let scope = scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
            let provenance = manual_provenance(&request.session_id);
            capture::correct_scoped_memory(
                conn,
                &request.session_id,
                &scope,
                &request.id,
                request.expected_revision,
                request.draft,
                &provenance,
                &request.operation_id,
                Utc::now(),
            )
        },
    )
    .await
}

#[tauri::command]
pub async fn memory_scoped_forget(
    app: AppHandle,
    request: ScopedForgetRequest,
) -> Result<ForgetResult, MemoryError> {
    let session_id = request.session_id.clone();
    let resolve_request = request.clone();
    super::memory_turn::run_derived_gated_mutation_with_replay(
        app,
        session_id,
        move |conn| {
            if let Some(prior) = replay_manual_forget(conn, &resolve_request)? {
                return Ok(transport::DerivedGatePlan::Replay(prior));
            }
            let scope =
                scope::resolve_write_scope(conn, &resolve_request.session_id, &resolve_request.selector)?;
            let memory_ids = vec![resolve_request.id.clone()];
            let source_message_ids =
                continuity::collect_memory_source_message_ids(conn, &scope, &memory_ids)?;
            let affected_session_ids = continuity::collect_affected_session_ids(
                conn,
                &resolve_request.session_id,
                Some(&scope),
                &memory_ids,
            )?;
            Ok(transport::DerivedGatePlan::Invalidate(NativeDerivedMutationPlan {
                invalidation: MemoryDerivedInvalidation {
                    operation_id: resolve_request.operation_id.clone(),
                    affected_session_ids,
                    memory_ids,
                    source_message_ids,
                },
                scope: Some(scope),
            }))
        },
        move |conn, _plan| {
            if let Some(prior) = replay_manual_forget(conn, &request)? {
                return Ok(prior);
            }
            let scope = scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
            capture::forget_scoped_memory(
                conn,
                &request.session_id,
                &scope,
                &request.id,
                request.expected_revision,
                &request.reason,
                &request.operation_id,
                Utc::now(),
            )
        },
    )
    .await
}

#[tauri::command]
pub async fn memory_stage_proposal(
    app: AppHandle,
    request: StageProposalRequest,
) -> Result<MutationResult, MemoryError> {
    let session_id = request.session_id.clone();
    let resolve_request = request.clone();
    super::memory_turn::run_derived_gated_mutation_with_replay(
        app,
        session_id,
        move |conn| {
            // Exact canonical replay precedes cleanup/invalidation.
            if let Some(prior) = capture::stage_memory_proposal_replay(conn, &resolve_request)? {
                return Ok(transport::DerivedGatePlan::Replay(prior));
            }
            let persisted =
                turn::read_memory_turn(conn, &resolve_request.session_id, &resolve_request.turn_id)?;
            let affected_session_ids = continuity::collect_affected_session_ids(
                conn,
                &resolve_request.session_id,
                Some(&persisted.scope),
                &[],
            )?;
            Ok(transport::DerivedGatePlan::Invalidate(NativeDerivedMutationPlan {
                invalidation: MemoryDerivedInvalidation {
                    operation_id: resolve_request.operation_id.clone(),
                    affected_session_ids,
                    memory_ids: Vec::new(),
                    source_message_ids: Vec::new(),
                },
                scope: Some(persisted.scope),
            }))
        },
        move |conn, _plan| {
            // Stage rechecks the payload identity inside its own savepoint.
            capture::stage_memory_proposal(conn, request, Utc::now())
        },
    )
    .await
}

