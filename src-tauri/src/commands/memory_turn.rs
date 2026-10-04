// ═══════════════════════════════════════════════════════════════
// Native memory turn commands — Phase 2.2 adapter surface
// ═══════════════════════════════════════════════════════════════
//
// Four request-wrapped Tauri commands backed by the owned Bun transport.
// Preparation and synchronization perform bounded blocking HTTP, so their
// async bodies run inside `spawn_blocking` and never block the Tauri
// executor. History and diagnostics are read-only native SQLite reads.

use chrono::Utc;
use tauri::{AppHandle, Manager, State};

use crate::db::AppDb;
use crate::jarvis::memory::capture_contracts::NativeDerivedMutationPlan;
use crate::jarvis::memory::contracts::MemoryError;
use crate::jarvis::memory::transport::{self, native_memory_transport};
use crate::jarvis::memory::turn::{
    self, MemoryTurnDiagnostic, MemoryTurnHistoryRequest, MemoryTurnIdentityRequest,
    MemoryTurnPreparation, PrepareMemoryTurnRequest, PromptHistoryMessage,
};

fn join_error(context: &str, error: impl std::fmt::Display) -> MemoryError {
    MemoryError::storage_unavailable(format!("{context}: {error}"))
}

/// Run one semantic-memory/Session-binding mutation through the native
/// operation gate on a blocking thread. The gate invalidates the live owned
/// Bun registry BEFORE the AppDb mutex is acquired and before the callback
/// runs; a live registry that cannot acknowledge blocks the callback.
pub async fn run_gated_mutation<T, F>(
    app: AppHandle,
    reason: &'static str,
    mutation: F,
) -> Result<T, MemoryError>
where
    T: Send + 'static,
    F: FnOnce(&rusqlite::Connection) -> Result<T, MemoryError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();
        transport::with_memory_mutation_gate(db.inner(), transport, reason, Utc::now(), mutation)
    })
    .await
    .map_err(|error| join_error("memory mutation task join error", error))?
}

/// Run one semantic mutation through the Phase 3.2 derived-state gate. The
/// `resolve` closure runs UNDER the operation mutex (with a brief AppDb
/// snapshot) and recomputes the exact affected Sessions/memory/source ids, so
/// no other Session can consume an affected memory between planning and the
/// gate. The gate then ACKs unconsumed-preparation invalidation plus scoped
/// derived cleanup in one authenticated round trip before the mutation
/// callback runs. A failed resolve or failed ACK writes nothing.
pub async fn run_derived_gated_mutation<T, P, F>(
    app: AppHandle,
    session_id: String,
    resolve: P,
    mutation: F,
) -> Result<T, MemoryError>
where
    T: Send + 'static,
    P: FnOnce(&rusqlite::Connection) -> Result<NativeDerivedMutationPlan, MemoryError>
        + Send
        + 'static,
    F: FnOnce(&rusqlite::Connection, &NativeDerivedMutationPlan) -> Result<T, MemoryError>
        + Send
        + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();
        transport::run_derived_mutation_gate(
            db.inner(),
            transport,
            &session_id,
            resolve,
            mutation,
        )
    })
    .await
    .map_err(|error| join_error("memory derived mutation task join error", error))?
}

/// Replay-aware derived mutation adapter. The resolver may return an exact
/// canonical replay, in which case no cleanup/invalidation occurs and the
/// persisted result is returned directly.
pub async fn run_derived_gated_mutation_with_replay<T, P, F>(
    app: AppHandle,
    session_id: String,
    resolve: P,
    mutation: F,
) -> Result<T, MemoryError>
where
    T: Send + 'static,
    P: FnOnce(&rusqlite::Connection) -> Result<transport::DerivedGatePlan<T>, MemoryError>
        + Send
        + 'static,
    F: FnOnce(&rusqlite::Connection, &NativeDerivedMutationPlan) -> Result<T, MemoryError>
        + Send
        + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();
        transport::run_derived_mutation_gate_with_replay(
            db.inner(),
            transport,
            &session_id,
            resolve,
            mutation,
        )
    })
    .await
    .map_err(|error| join_error("memory derived mutation task join error", error))?
}

#[tauri::command]
pub async fn memory_prepare_turn(
    app: AppHandle,
    request: PrepareMemoryTurnRequest,
) -> Result<MemoryTurnPreparation, MemoryError> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();
        transport::prepare_memory_turn(db.inner(), transport, request, Utc::now())
    })
    .await
    .map_err(|error| join_error("memory prepare task join error", error))?
}

#[tauri::command]
pub async fn memory_sync_turn(
    app: AppHandle,
    request: MemoryTurnIdentityRequest,
) -> Result<MemoryTurnDiagnostic, MemoryError> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();
        transport::sync_memory_turn(db.inner(), transport, request, Utc::now())
    })
    .await
    .map_err(|error| join_error("memory sync task join error", error))?
}

#[tauri::command]
pub async fn memory_turn_history(
    app: AppHandle,
    request: MemoryTurnHistoryRequest,
) -> Result<Vec<PromptHistoryMessage>, MemoryError> {
    // Blocking HTTP (the pending-cleanup drain) must not run on the Tauri async
    // executor: adapt through spawn_blocking and hold one operation gate across
    // drain + snapshot + read so there is no TOCTOU gap.
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = native_memory_transport();
        transport::read_memory_turn_history(
            db.inner(),
            transport,
            &request.session_id,
            &request.user_message_id,
            Utc::now(),
        )
    })
    .await
    .map_err(|error| join_error("memory turn history task join error", error))?
}

#[tauri::command]
pub fn memory_turn_diagnostic(
    db: State<AppDb>,
    request: MemoryTurnIdentityRequest,
) -> Result<MemoryTurnDiagnostic, MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let persisted = turn::read_memory_turn(&conn, &request.session_id, &request.turn_id)?;
    Ok(turn::memory_turn_diagnostic(&persisted))
}
