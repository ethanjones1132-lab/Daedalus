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

use std::collections::HashSet;

use chrono::Utc;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::AppDb;
use crate::jarvis::memory::capture::{self, UserMemoryOperation};
use crate::jarvis::memory::capture_contracts::{
    CaptureReceipt, CaptureReceiptsRequest, CaptureTurnRequest, ContinuityReadRequest,
    ContinuitySetRequest, CorrectionResult, ForgetResult, MemoryDerivedInvalidation,
    NativeDerivedMutationPlan, ScopedCorrectRequest, ScopedForgetRequest, SessionContinuity,
    StageProposalRequest,
};
use crate::jarvis::memory::continuity;
use crate::jarvis::memory::contracts::{
    AuthorityKind, MemoryError, MemoryProvenance, MutationResult,
};
use crate::jarvis::memory::scope;
use crate::jarvis::memory::transport::{self, native_memory_transport, NativeMemoryTransport};
use crate::jarvis::memory::turn::{
    self, MemoryTurnDiagnostic, MemoryTurnIdentityRequest, MemoryTurnTerminalStatus,
};

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

/// Emit one metadata-only status frame so a sync/join failure is observable
/// without claiming assistant verification, inventing a receipt field, or being
/// mistaken for a capture failure. The code is `sync_unavailable`, never
/// `capture_unavailable`: an eligible captured source may still commit.
fn emit_sync_unavailable(app: &AppHandle, session_id: &str, turn_id: &str, code: &str) {
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
            emit_sync_unavailable(
                &app,
                &request.session_id,
                &request.turn_id,
                "sync_unavailable",
            );
        }
        Err(error) => {
            eprintln!("[memory] capture pre-sync join error: {}", error);
            emit_sync_unavailable(
                &app,
                &request.session_id,
                &request.turn_id,
                "sync_unavailable",
            );
        }
        Ok(Ok(())) => {}
    }

    let session_id = request.session_id.clone();
    let turn_id = request.turn_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();
        // The ONE shared gated-capture path, identical to the relay finalizer
        // and startup recovery. An exact replay returns the persisted result
        // with NO cleanup; a valid accepted write recomputes and ACKs cleanup
        // under the gate.
        run_capture_for_turn(db.inner(), transport, &session_id, &turn_id)
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

// ── Explicit continuity read/set (Phase 3.4) ────────────────────────────────
//
// `memory_continuity_read` is a pure SQLite read. `memory_continuity_set` is an
// explicit operator action routed through the same derived-state gate as every
// other semantic mutation; its exact canonical replay precedes cleanup.

/// Read the structured continuity for one Session. Read-only: never mutates,
/// invalidates, or performs HTTP.
#[tauri::command]
pub fn memory_continuity_read(
    db: State<AppDb>,
    request: ContinuityReadRequest,
) -> Result<SessionContinuity, MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    continuity::read_session_continuity(&conn, &request.session_id)
}

/// Explicitly set or clear the active objective. Validates expected continuity
/// revision and exact saved user source BEFORE the gate, resolves an exact
/// canonical replay without cleanup, and otherwise ACKs derived cleanup and
/// commits the objective + ledger atomically under the operation mutex.
#[tauri::command]
pub async fn memory_continuity_set(
    app: AppHandle,
    request: ContinuitySetRequest,
) -> Result<SessionContinuity, MemoryError> {
    let session_id = request.session_id.clone();
    let resolve_request = request.clone();
    super::memory_turn::run_derived_gated_mutation_with_replay(
        app,
        session_id,
        move |conn| {
            if let Some(prior) = continuity::replay_session_continuity_set(conn, &resolve_request)?
            {
                return Ok(transport::DerivedGatePlan::Replay(prior));
            }
            continuity::validate_continuity_set(conn, &resolve_request)?;
            let affected_session_ids = continuity::collect_affected_session_ids(
                conn,
                &resolve_request.session_id,
                None,
                &[],
            )?;
            Ok(transport::DerivedGatePlan::Invalidate(
                NativeDerivedMutationPlan {
                    invalidation: MemoryDerivedInvalidation {
                        operation_id: resolve_request.operation_id.clone(),
                        affected_session_ids,
                        memory_ids: Vec::new(),
                        source_message_ids: Vec::new(),
                    },
                    scope: None,
                },
            ))
        },
        move |conn, _plan| continuity::set_session_continuity(conn, request, Utc::now()),
    )
    .await
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
        request.statement_kind,
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
            let scope = scope::resolve_write_scope(
                conn,
                &resolve_request.session_id,
                &resolve_request.selector,
            )?;
            let memory_ids = vec![resolve_request.id.clone()];
            let source_message_ids =
                continuity::collect_memory_source_message_ids(conn, &scope, &memory_ids)?;
            let affected_session_ids = continuity::collect_affected_session_ids(
                conn,
                &resolve_request.session_id,
                Some(&scope),
                &memory_ids,
            )?;
            Ok(transport::DerivedGatePlan::Invalidate(
                NativeDerivedMutationPlan {
                    invalidation: MemoryDerivedInvalidation {
                        operation_id: resolve_request.operation_id.clone(),
                        affected_session_ids,
                        memory_ids,
                        source_message_ids,
                    },
                    scope: Some(scope),
                },
            ))
        },
        move |conn, _plan| {
            // Recheck the operation identity inside the gate to close races.
            if let Some(prior) = replay_manual_correct(conn, &request)? {
                return Ok(prior);
            }
            let scope = scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
            let provenance = manual_provenance(&request.session_id);
            capture::correct_scoped_memory_with_kind(
                conn,
                &request.session_id,
                &scope,
                &request.id,
                request.expected_revision,
                request.draft,
                &provenance,
                &request.operation_id,
                request.statement_kind,
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
            let scope = scope::resolve_write_scope(
                conn,
                &resolve_request.session_id,
                &resolve_request.selector,
            )?;
            let memory_ids = vec![resolve_request.id.clone()];
            let source_message_ids =
                continuity::collect_memory_source_message_ids(conn, &scope, &memory_ids)?;
            let affected_session_ids = continuity::collect_affected_session_ids(
                conn,
                &resolve_request.session_id,
                Some(&scope),
                &memory_ids,
            )?;
            Ok(transport::DerivedGatePlan::Invalidate(
                NativeDerivedMutationPlan {
                    invalidation: MemoryDerivedInvalidation {
                        operation_id: resolve_request.operation_id.clone(),
                        affected_session_ids,
                        memory_ids,
                        source_message_ids,
                    },
                    scope: Some(scope),
                },
            ))
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
            let persisted = turn::read_memory_turn(
                conn,
                &resolve_request.session_id,
                &resolve_request.turn_id,
            )?;
            let affected_session_ids = continuity::collect_affected_session_ids(
                conn,
                &resolve_request.session_id,
                Some(&persisted.scope),
                &[],
            )?;
            Ok(transport::DerivedGatePlan::Invalidate(
                NativeDerivedMutationPlan {
                    invalidation: MemoryDerivedInvalidation {
                        operation_id: resolve_request.operation_id.clone(),
                        affected_session_ids,
                        memory_ids: Vec::new(),
                        source_message_ids: Vec::new(),
                    },
                    scope: Some(persisted.scope),
                },
            ))
        },
        move |conn, _plan| {
            // Stage rechecks the payload identity inside its own savepoint.
            capture::stage_memory_proposal(conn, request, Utc::now())
        },
    )
    .await
}

// ── Relay whole-lifecycle finalization (Phase 3.3) ──────────────────────────
//
// The native relay owns exactly one assistant DB append per registered turn.
// This helper runs the whole relay finalization — phase 2 sync, optional
// assistant append (only for an authoritative completed terminal with nonempty
// output), then capture — as independent error branches so a sync or append
// failure still dispatches capture from the original immutable user source.
// The caller (runner.rs) bounds the whole attempt with one 5-second wait; this
// function never emits a late diagnostic of its own.

#[derive(Debug, Clone)]
pub struct RelayTurnFinalization {
    /// Authenticated native diagnostic projection (metadata only). For a source
    /// conflict this describes the OLD canonical turn and MUST NOT be published
    /// as this relay turn's metadata.
    pub diagnostic: MemoryTurnDiagnostic,
    /// Generated DB id of the assistant row the relay appended, if any. UI uses
    /// this to suppress a duplicate append; it is nullable.
    pub assistant_message_id: Option<String>,
    /// Committed capture receipt, if capture ran and returned one.
    pub capture: Option<CaptureReceipt>,
    /// True when phase 2 sync failed (subsequent capture still attempted).
    pub sync_failed: bool,
    /// True when the assistant append failed (capture still attempted).
    pub append_failed: bool,
    /// True when capture failed (observable metadata only; never alters the
    /// ordinary inference result).
    pub capture_failed: bool,
    /// True when the canonical persisted turn does NOT own the newly saved relay
    /// user source. No sync, append, or capture runs; the old turn is never
    /// mutated or republished for a reused `turn_id`.
    pub source_conflict: bool,
}

/// Resolve one capture-gate plan under the operation mutex. An existing receipt
/// (finalized replay, allowed one-time terminal augmentation, or repeated
/// pre-terminal observation) goes straight through the canonical capture helper
/// with NO HTTP cleanup and NO invalidation. Ordinary text and an ambiguous
/// directive likewise persist the ledger receipt without cleanup. Only a valid
/// accepted user write recomputes its exact affected ids for cleanup.
/// Derived invalidation for an objective-only semantic change. Objective
/// continuity is Session-local: only the originating Session is a derived-state
/// consumer, and no memory or source ids are involved. It is still routed
/// through the gate so unconsumed preparations are invalidated and the
/// Session's derived prompt state is evicted before the new objective commits.
fn objective_capture_invalidation(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
) -> Result<NativeDerivedMutationPlan, MemoryError> {
    let affected_session_ids =
        continuity::collect_affected_session_ids(conn, session_id, None, &[])?;
    Ok(NativeDerivedMutationPlan {
        invalidation: MemoryDerivedInvalidation {
            operation_id: format!("turn/{turn_id}/user/0"),
            affected_session_ids,
            memory_ids: Vec::new(),
            source_message_ids: Vec::new(),
        },
        scope: None,
    })
}

fn capture_gate_plan(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
) -> Result<transport::DerivedGatePlan<CaptureReceipt>, MemoryError> {
    // Validate the canonical immutable source tuple (source id/body/hash/role/
    // session/terminal) BEFORE classification/cleanup. An invalid source or a
    // conflicting terminal tuple is rejected here, so derived TaskRun state is
    // never scrubbed for a capture that cannot commit. Read-only and identical
    // to the mutation-path comparison.
    let persisted = capture::validate_turn_source(conn, session_id, turn_id)?;
    if capture::read_capture_receipt(conn, session_id, turn_id)?.is_some() {
        let receipt = capture::capture_recorded_turn(conn, &persisted, Utc::now())?;
        return Ok(transport::DerivedGatePlan::Replay(receipt));
    }
    let directive = continuity::parse_objective_directive(&persisted.user_message);
    // The objective namespace is EXCLUSIVE and is handled BEFORE any memory
    // parser-derived cleanup. A recognized objective control must never select
    // the memory-operation scope cleanup, even when the objective text itself
    // contains memory grammar words (`Objective: Remember: ...`): the goal
    // payload is inert DATA. A valid, nonstale replace/clear invalidates only
    // the originating Session's derived state (scope `None`). Resume, invalid,
    // and stale directives change nothing and go through the canonical capture
    // replay/no-cleanup path.
    if capture::is_objective_namespace_directive(&directive) {
        let objective_is_semantic = match directive {
            continuity::ObjectiveDirective::Replace(_) | continuity::ObjectiveDirective::Clear => {
                !continuity::directive_is_stale(conn, session_id, &persisted.source_message_id)?
            }
            _ => false,
        };
        if objective_is_semantic {
            return Ok(transport::DerivedGatePlan::Invalidate(
                objective_capture_invalidation(conn, session_id, turn_id)?,
            ));
        }
        let receipt = capture::capture_recorded_turn(conn, &persisted, Utc::now())?;
        return Ok(transport::DerivedGatePlan::Replay(receipt));
    }
    let memory_op = capture::parse_user_memory_operation(&persisted)?;
    match memory_op {
        None | Some(UserMemoryOperation::Pending { .. }) => {
            let receipt = capture::capture_recorded_turn(conn, &persisted, Utc::now())?;
            Ok(transport::DerivedGatePlan::Replay(receipt))
        }
        Some(_) => Ok(transport::DerivedGatePlan::Invalidate(
            capture_turn_invalidation(conn, session_id, turn_id)?,
        )),
    }
}

/// ONE shared gated-capture path for the command surface, the relay finalizer,
/// and startup recovery. Resolves the exact operation metadata under the
/// operation mutex, ACKs derived cleanup before any accepted mutation, and runs
/// the canonical capture helper inside the mutation savepoint. Replay and
/// no-cleanup semantics are identical for all three callers; Part 3.4 Objective
/// controls extend this one helper rather than duplicating parse branches.
pub fn run_capture_for_turn(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    session_id: &str,
    turn_id: &str,
) -> Result<CaptureReceipt, MemoryError> {
    let gate_session = session_id.to_string();
    let resolve_session = session_id.to_string();
    let resolve_turn = turn_id.to_string();
    let mutation_session = session_id.to_string();
    let mutation_turn = turn_id.to_string();
    transport::run_derived_mutation_gate_with_replay(
        db,
        transport,
        &gate_session,
        move |conn| capture_gate_plan(conn, &resolve_session, &resolve_turn),
        move |conn, _plan| {
            let persisted = turn::read_memory_turn(conn, &mutation_session, &mutation_turn)?;
            capture::capture_recorded_turn(conn, &persisted, Utc::now())
        },
    )
}

/// Run the whole relay finalization for one registered turn. The immutable
/// `{session_id, turn_id}` identity plus the ORIGINAL newly saved user source
/// id/hash are used throughout; no current UI selection participates. Capture is
/// attempted even when sync or append fails.
pub fn finalize_relay_turn_with_capture(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    identity: MemoryTurnIdentityRequest,
    expected_source_message_id: &str,
    expected_message_hash: &str,
    answer_text: Option<&str>,
) -> Result<RelayTurnFinalization, MemoryError> {
    let now = Utc::now();
    let session_id = identity.session_id.clone();
    let turn_id = identity.turn_id.clone();

    // ── 0. Bind to the ORIGINAL newly saved relay user source. A public caller
    // may reuse a turn id; if the canonical stored turn does not own this exact
    // source, we must not sync, append, or capture against the old turn. ─────
    let persisted = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::read_memory_turn(&conn, &session_id, &turn_id)
    };
    let persisted = match persisted {
        Ok(turn) => turn,
        Err(error) => return Err(error),
    };
    let source_conflict = persisted.session_id != session_id
        || persisted.source_message_id != expected_source_message_id
        || persisted.message_hash != expected_message_hash;
    if source_conflict {
        // Report the old canonical diagnostic, but the caller suppresses its
        // publication. Nothing from the old source is mutated or captured.
        // Ordinary inference is not stopped: the successful answer is still
        // persisted as a plain, UNASSOCIATED transcript row so it is never
        // attached to the old turn and no turn-scoped memory effect occurs.
        let mut assistant_message_id: Option<String> = None;
        let mut append_failed = false;
        if let Some(answer) = answer_text.map(str::trim).filter(|text| !text.is_empty()) {
            match crate::commands::sessions::insert_message_row(
                db,
                &session_id,
                "assistant",
                answer,
                0,
            ) {
                Ok(id) => assistant_message_id = Some(id),
                Err(error) => {
                    append_failed = true;
                    eprintln!(
                        "[memory] plain relay append failed session={} turn={} error={}",
                        session_id, turn_id, error
                    );
                }
            }
        }
        let diagnostic = turn::memory_turn_diagnostic(&persisted);
        return Ok(RelayTurnFinalization {
            diagnostic,
            assistant_message_id,
            capture: None,
            sync_failed: false,
            append_failed,
            capture_failed: false,
            source_conflict: true,
        });
    }

    // ── 1. Phase 2 sync. A failure is observable and does not stop capture. ──
    let sync_result = transport::sync_memory_turn(db, transport, identity.clone(), now);
    let sync_failed = sync_result.is_err();
    if let Err(error) = &sync_result {
        eprintln!(
            "[memory] relay capture pre-sync failed session={} turn={} error={}",
            session_id, turn_id, error
        );
    }

    // Re-read the canonical persisted turn after sync so append/capture see the
    // terminal metadata the sync just persisted.
    let persisted = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        turn::read_memory_turn(&conn, &session_id, &turn_id)?
    };

    // ── 2. Optional assistant append. Only an authoritative completed terminal
    // with nonempty output is persisted. The append transaction is atomic and
    // at-most-once for the turn. Capture runs even if the append fails. ──────
    let mut assistant_message_id: Option<String> = None;
    let mut append_failed = false;
    let trimmed_answer = answer_text.map(str::trim).filter(|text| !text.is_empty());
    if persisted.terminal_status == Some(MemoryTurnTerminalStatus::Completed) {
        if let Some(answer) = trimmed_answer {
            match crate::commands::sessions::append_assistant_message_for_turn(
                db,
                &session_id,
                answer,
                &turn_id,
            ) {
                Ok(id) => assistant_message_id = Some(id),
                Err(error) => {
                    append_failed = true;
                    eprintln!(
                        "[memory] relay assistant append failed session={} turn={} error={}",
                        session_id, turn_id, error
                    );
                }
            }
        }
    }

    // ── 3. Capture through the shared derived gate. Runs even if sync/append
    // failed, always against the immutable user source. Capture failure is
    // recorded independently and never alters the ordinary result. ──────────
    let mut capture_receipt: Option<CaptureReceipt> = None;
    let mut capture_failed = false;
    match run_capture_for_turn(db, transport, &session_id, &turn_id) {
        Ok(receipt) => capture_receipt = Some(receipt),
        Err(error) => {
            capture_failed = true;
            eprintln!(
                "[memory] relay capture failed session={} turn={} error={}",
                session_id, turn_id, error
            );
        }
    }

    let diagnostic = match sync_result {
        Ok(diagnostic) => diagnostic,
        Err(_) => turn::memory_turn_diagnostic(&persisted),
    };

    Ok(RelayTurnFinalization {
        diagnostic,
        assistant_message_id,
        capture: capture_receipt,
        sync_failed,
        append_failed,
        capture_failed,
        source_conflict: false,
    })
}

// ── Startup recovery sweep (Phase 3.3) ──────────────────────────────────────
//
// Capture every recorded user directive on a persisted turn that never
// received a capture receipt, using the same derived gate as the live paths.
// A never-started preparation keeps its null terminal; a started-but-lost turn
// is `unterminated`. No fact is ever inferred from a summary or a run outcome.
// A cleanup failure (or an unknown live Bun state) leaves the derived outbox
// pending rather than serving stale derived context; the next preparation/history
// read drains it.

/// The maximum number of turn candidates one startup recovery pass examines.
///
/// Cold start must do a fixed, small amount of recovery work no matter how many
/// uncaptured turns have accumulated: every candidate costs a bounded
/// operation/HTTP gate round trip, so an unbounded sweep made startup time grow
/// with the whole turn history. Oldest-first order means the backlog still drains
/// in order across later passes and later boots. This is deliberately a
/// build-time constant rather than a config key or CLI flag: it is a safety
/// bound on startup cost, not a user preference.
const RECOVERY_TURN_LIMIT: usize = 25;

/// Turn ids whose recovery capture already failed during this process. A turn
/// that keeps failing would otherwise sit at the front of the oldest-first sweep
/// and consume part of every pass's bounded budget; excluding it lets later
/// passes make progress on the rest of the backlog. The set is process-lifetime
/// (never persisted), so a fresh boot still gets one retry per turn. Failures are
/// still observable through the sweep's `eprintln!`.
fn recovery_skip_set() -> &'static std::sync::Mutex<HashSet<String>> {
    static SKIP: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
        std::sync::OnceLock::new();
    SKIP.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

/// Select up to `limit` recovery candidates in the existing oldest-first order.
///
/// The candidate predicate is unchanged: turns with no receipt, plus turns with a
/// preterminal receipt (`terminal_hash IS NULL`) whose canonical turn now carries
/// an authoritative terminal tuple, so the canonical capture helper performs its
/// allowed one-time terminal augmentation WITHOUT rerunning operations. Only an
/// authenticated `finished_at` or a `completed|partial|cancelled|failed` terminal
/// is authoritative; a bare `unterminated` generation-loss marker is not. Turn ids
/// in `skip` (already failed in this process) are excluded before the limit is
/// applied, so a poisoned turn cannot consume the bounded budget.
fn select_recovery_candidates(
    conn: &Connection,
    limit: usize,
    skip: &HashSet<String>,
) -> Result<Vec<(String, String)>, MemoryError> {
    let mut sql = String::from(
        "SELECT p.session_id, p.turn_id
         FROM memory_turn_preparations p
         LEFT JOIN memory_capture_receipts r ON r.turn_id = p.turn_id
         WHERE (r.turn_id IS NULL
                OR (r.terminal_hash IS NULL
                    AND (p.finished_at IS NOT NULL
                         OR p.terminal_status IN
                             ('completed','partial','cancelled','failed'))))",
    );
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    if !skip.is_empty() {
        let placeholders = std::iter::repeat("?")
            .take(skip.len())
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(" AND p.turn_id NOT IN ({placeholders})"));
        for turn_id in skip {
            params.push(rusqlite::types::Value::Text(turn_id.clone()));
        }
    }
    sql.push_str(" ORDER BY p.prepared_at ASC LIMIT ?");
    params.push(rusqlite::types::Value::Integer(limit as i64));

    let mut stmt = conn.prepare(&sql).map_err(MemoryError::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(MemoryError::from)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(MemoryError::from)
}

/// Run one bounded recovery pass. `capture` performs the actual per-turn capture
/// so the selection, budget, and failure bookkeeping stay testable without a live
/// transport; every failed turn id is added to `skip` for later passes in this
/// process.
fn sweep_recorded_memory_captures<F>(
    db: &AppDb,
    limit: usize,
    skip: &mut HashSet<String>,
    mut capture: F,
) -> Result<usize, MemoryError>
where
    F: FnMut(&AppDb, &str, &str) -> Result<(), MemoryError>,
{
    let candidates = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        select_recovery_candidates(&conn, limit, skip)?
    };

    let mut captured = 0usize;
    for (session_id, turn_id) in candidates {
        match capture(db, &session_id, &turn_id) {
            Ok(()) => captured += 1,
            Err(error) => {
                // Recovery is best-effort and observable; one bad turn must not
                // abort the sweep or fabricate a receipt, and it must not be
                // retried for the rest of this process.
                eprintln!(
                    "[memory] recovery capture failed session={} turn={} error={}",
                    session_id, turn_id, error
                );
                skip.insert(turn_id);
            }
        }
    }
    Ok(captured)
}

/// One startup recovery pass over unfinalized capture turns.
///
/// Runs each selected turn through the shared gate (idempotent: an exact replay
/// is a no-op) and never holds the AppDb lock while entering the operation/HTTP
/// gate. At most `RECOVERY_TURN_LIMIT` turns are examined per call, and turns that
/// already failed earlier in this process are skipped. Returns the number of turns
/// that now have a committed receipt.
pub fn recover_recorded_memory_captures(
    db: &AppDb,
    transport: &NativeMemoryTransport,
    _now: chrono::DateTime<Utc>,
) -> Result<usize, MemoryError> {
    let mut skip = recovery_skip_set()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sweep_recorded_memory_captures(
        db,
        RECOVERY_TURN_LIMIT,
        &mut *skip,
        |db: &AppDb, session_id: &str, turn_id: &str| {
            run_capture_for_turn(db, transport, session_id, turn_id).map(|_| ())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;
    use rusqlite::Connection;
    use std::collections::HashSet;
    use std::sync::Mutex;

    fn mem_db() -> AppDb {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        run_migrations(&conn).expect("run migrations");
        AppDb {
            conn: Mutex::new(conn),
            db_path: std::path::PathBuf::from(":memory:"),
        }
    }

    /// A real in-memory AppDb with one Session and one user message, enough to
    /// satisfy the preparation foreign keys.
    fn fixture() -> (AppDb, String, String) {
        let db = mem_db();
        let session = crate::commands::sessions::create_session_row(
            &db,
            Some("recovery".into()),
            None,
            None,
            None,
        )
        .expect("create session");
        let message_id = crate::commands::sessions::insert_message_row(
            &db,
            &session.id,
            "user",
            "remember this",
            0,
        )
        .expect("insert user message");
        (db, session.id, message_id)
    }

    /// Seed one never-receipted, never-terminal preparation.
    fn seed_preparation(
        db: &AppDb,
        session_id: &str,
        message_id: &str,
        turn_id: &str,
        prepared_at: &str,
    ) {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO memory_turn_preparations
             (turn_id, preparation_id, session_id, source_message_id, user_message, message_hash,
              scope_json, include_user_scope, store_revision, selected_json,
              applied_selected_ids_json, app_instance_id, state, recall_status, prepared_at,
              expires_at)
             VALUES (?, ?, ?, ?, 'remember this', 'message-hash', '{}', 0, 1, '[]', '[]',
                     'test-app', 'prepared', 'ready', ?, ?)",
            rusqlite::params![
                turn_id,
                format!("prep-{turn_id}"),
                session_id,
                message_id,
                prepared_at,
                prepared_at
            ],
        )
        .expect("seed preparation");
    }

    fn seed_turns(db: &AppDb, session_id: &str, message_id: &str, count: usize) {
        for index in 0..count {
            let turn_id = format!("turn-{index:02}");
            // Distinct, lexically ordered timestamps so `ORDER BY prepared_at`
            // gives an unambiguous oldest-first order.
            let prepared_at = format!("2026-01-01T00:00:{index:02}Z");
            seed_preparation(db, session_id, message_id, &turn_id, &prepared_at);
        }
    }

    fn record_receipt(db: &AppDb, session_id: &str, turn_id: &str) {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO memory_capture_receipts (turn_id, session_id, receipt_json)
             VALUES (?, ?, '{}')",
            rusqlite::params![turn_id, session_id],
        )
        .expect("record receipt");
    }

    fn turn_ids(candidates: &[(String, String)]) -> Vec<String> {
        candidates
            .iter()
            .map(|(_, turn_id)| turn_id.clone())
            .collect()
    }

    #[test]
    fn sweep_examines_at_most_the_limit_oldest_first() {
        let (db, session_id, message_id) = fixture();
        seed_turns(&db, &session_id, &message_id, 30);

        let candidates = {
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            select_recovery_candidates(&conn, RECOVERY_TURN_LIMIT, &HashSet::new())
                .expect("select candidates")
        };

        let expected: Vec<String> = (0..RECOVERY_TURN_LIMIT)
            .map(|index| format!("turn-{index:02}"))
            .collect();
        assert_eq!(
            candidates.len(),
            RECOVERY_TURN_LIMIT,
            "a 30-turn backlog must be bounded to the limit"
        );
        assert_eq!(
            turn_ids(&candidates),
            expected,
            "candidates must be the oldest turns in ascending prepared_at order"
        );
    }

    #[test]
    fn a_preparation_with_a_receipt_is_never_returned() {
        let (db, session_id, message_id) = fixture();
        seed_turns(&db, &session_id, &message_id, 3);
        // A receipt that carries no terminal hash is still a committed capture:
        // this turn must not satisfy either branch of the candidate predicate.
        record_receipt(&db, &session_id, "turn-01");

        let candidates = {
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            select_recovery_candidates(&conn, RECOVERY_TURN_LIMIT, &HashSet::new())
                .expect("select candidates")
        };

        assert_eq!(
            turn_ids(&candidates),
            vec!["turn-00".to_string(), "turn-02".to_string()],
            "a receipted turn must never be selected for recovery"
        );
    }

    #[test]
    fn a_failed_turn_is_not_selected_again_in_the_same_process() {
        let (db, session_id, message_id) = fixture();
        seed_turns(&db, &session_id, &message_id, 30);
        let poisoned = "turn-00".to_string();

        let mut skip = recovery_skip_set()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut first_attempts: Vec<String> = Vec::new();
        let captured = sweep_recorded_memory_captures(
            &db,
            RECOVERY_TURN_LIMIT,
            &mut *skip,
            |db: &AppDb, session_id: &str, turn_id: &str| {
                first_attempts.push(turn_id.to_string());
                if turn_id == poisoned.as_str() {
                    return Err(MemoryError::storage_unavailable("poisoned turn"));
                }
                record_receipt(db, session_id, turn_id);
                Ok(())
            },
        )
        .expect("first sweep");

        assert_eq!(
            first_attempts.len(),
            RECOVERY_TURN_LIMIT,
            "the first pass must examine exactly the bounded budget"
        );
        assert_eq!(captured, RECOVERY_TURN_LIMIT - 1);
        assert!(skip.contains(&poisoned), "the failed turn must be skipped");

        let mut second_attempts: Vec<String> = Vec::new();
        let captured = sweep_recorded_memory_captures(
            &db,
            RECOVERY_TURN_LIMIT,
            &mut *skip,
            |db: &AppDb, session_id: &str, turn_id: &str| {
                assert_ne!(turn_id, poisoned.as_str(), "a failed turn must not be retried");
                second_attempts.push(turn_id.to_string());
                record_receipt(db, session_id, turn_id);
                Ok(())
            },
        )
        .expect("second sweep");

        let expected_remaining: Vec<String> = (RECOVERY_TURN_LIMIT..30)
            .map(|index| format!("turn-{index:02}"))
            .collect();
        assert_eq!(
            second_attempts, expected_remaining,
            "the poisoned oldest turn must be skipped so the rest of the backlog still drains"
        );
        assert_eq!(captured, 30 - RECOVERY_TURN_LIMIT);
        // The skip set is process-lifetime; leave it tidy for any later check.
        skip.remove(&poisoned);
    }
}
