use crate::db::AppDb;
use crate::jarvis::memory::capture_contracts::{
    MemoryDerivedInvalidation, NativeDerivedMutationPlan,
};
use crate::jarvis::memory::contracts::{
    AuthorityKind, MemoryDraft, MemoryError, MemoryProvenance, MemoryScope, MutationResult,
    RecallOptions, RecallPreview, ScopeSelector, ScopedMemoryEntry,
};
use crate::jarvis::memory::engine::{self, MemoryEntry, MemoryEvent, MemoryRecall, MemoryRun};
use crate::jarvis::memory::{continuity, scope, scoped};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::Deserialize;
use tauri::{AppHandle, State};

/// Build a derived-invalidation payload for a scoped mutation: exact source
/// lineage (including assistant consequence ids) plus every bounded Session
/// whose derived prompt state could hold the affected memories. `operation_id`
/// is a fresh UUID for operator/manual routes.
fn plan_scoped_invalidation(
    conn: &Connection,
    session_id: &str,
    scope: &MemoryScope,
    memory_ids: Vec<String>,
    operation_id: String,
) -> Result<NativeDerivedMutationPlan, MemoryError> {
    let source_message_ids =
        continuity::collect_memory_source_message_ids(conn, scope, &memory_ids)?;
    let affected_session_ids =
        continuity::collect_affected_session_ids(conn, session_id, Some(scope), &memory_ids)?;
    Ok(NativeDerivedMutationPlan {
        invalidation: MemoryDerivedInvalidation {
            operation_id,
            affected_session_ids,
            memory_ids,
            source_message_ids,
        },
        scope: Some(scope.clone()),
    })
}

/// Build a derived-invalidation plan for a legacy (unscoped) mutation.
fn plan_legacy_invalidation(
    conn: &Connection,
    session_id: &str,
    memory_ids: Vec<String>,
    operation_id: String,
) -> Result<NativeDerivedMutationPlan, MemoryError> {
    let source_message_ids = continuity::collect_legacy_source_message_ids(conn, &memory_ids)?;
    let affected_session_ids =
        continuity::collect_affected_session_ids(conn, session_id, None, &memory_ids)?;
    Ok(NativeDerivedMutationPlan {
        invalidation: MemoryDerivedInvalidation {
            operation_id,
            affected_session_ids,
            memory_ids,
            source_message_ids,
        },
        scope: None,
    })
}

fn fresh_operation_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[tauri::command]
pub fn memory_list(db: State<AppDb>) -> Result<Vec<MemoryEntry>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::list_memories(&conn)
}

#[tauri::command]
pub fn memory_read(db: State<AppDb>, id: String) -> Result<MemoryEntry, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::read_memory(&conn, &id)
}

#[tauri::command]
pub async fn memory_save(
    app: AppHandle,
    title: String,
    content: String,
    tags: Vec<String>,
    category: String,
) -> Result<MemoryEntry, String> {
    super::memory_turn::run_derived_gated_mutation(
        app,
        String::new(),
        move |conn| plan_legacy_invalidation(conn, "", Vec::new(), fresh_operation_id()),
        move |conn, _invalidation| {
            engine::save_manual_memory(conn, title, content, tags, category)
                .map_err(MemoryError::storage_unavailable)
        },
    )
    .await
    .map_err(|error| error.message)
}

#[tauri::command]
pub async fn memory_update(
    app: AppHandle,
    id: String,
    title: String,
    content: String,
    tags: Vec<String>,
    category: String,
) -> Result<MemoryEntry, String> {
    let plan_id = id.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        String::new(),
        move |conn| plan_legacy_invalidation(conn, "", vec![plan_id], fresh_operation_id()),
        move |conn, _invalidation| {
            // Preflight: the legacy update route may only touch a verified
            // legacy-unscoped row. An explicitly scoped fact must use the
            // scoped APIs (which enforce expected_revision); a scoped row is a
            // typed scope mismatch, and a genuinely absent row keeps the
            // historical not-found error.
            if !engine::legacy_command_guard(conn, &id)? {
                return Err(MemoryError::not_found("Memory not found"));
            }
            // Suppress the OLD provenance before the in-place overwrite so the
            // replaced source text can never be replayed from derived state.
            continuity::suppress_legacy_memory_sources(conn, &[id.clone()], Utc::now())?;
            engine::update_manual_memory(conn, id, title, content, tags, category)
                .map_err(MemoryError::storage_unavailable)
        },
    )
    .await
    .map_err(|error| error.message)
}

#[tauri::command]
pub async fn memory_delete(app: AppHandle, id: String) -> Result<bool, String> {
    let plan_id = id.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        String::new(),
        move |conn| {
            plan_legacy_invalidation(conn, "", vec![plan_id], fresh_operation_id())
        },
        move |conn, _invalidation| {
            // Preflight: the legacy delete route may only tombstone a verified
            // legacy-unscoped row. A scoped fact must go through the scoped
            // route with its expected_revision; it is never tombstoned here via
            // the generic engine helper. A truly absent row is compatibility
            // false.
            if !engine::legacy_command_guard(conn, &id)? {
                return Ok(false);
            }
            continuity::suppress_legacy_memory_sources(conn, &[id.clone()], Utc::now())?;
            engine::tombstone_memory(conn, &id, "user", "User deleted via UI", None, None)
                .map_err(MemoryError::storage_unavailable)
        },
    )
    .await
    .map_err(|error| error.message)
}

#[tauri::command]
pub async fn memory_restore(app: AppHandle, id: String) -> Result<bool, String> {
    let plan_id = id.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        String::new(),
        move |conn| {
            plan_legacy_invalidation(conn, "", vec![plan_id], fresh_operation_id())
        },
        move |conn, _invalidation| {
            // Preflight: restore preserves the legacy-scope guard that
            // `engine::restore_memory` only partially enforces (it returns
            // `false` for an absent row). A scoped row is a typed mismatch.
            if !engine::legacy_command_guard(conn, &id)? {
                return Ok(false);
            }
            // Restore never removes suppression; the row's own source lineage is
            // (re)suppressed and any dependent objective is cleared.
            continuity::suppress_legacy_memory_sources(conn, &[id.clone()], Utc::now())?;
            let _ = continuity::clear_continuity_dependent_on(conn, &[id.clone()], Utc::now())?;
            engine::restore_memory(conn, &id).map_err(MemoryError::storage_unavailable)
        },
    )
    .await
    .map_err(|error| error.message)
}

#[tauri::command]
pub fn memory_search(db: State<AppDb>, query: String) -> Result<Vec<MemoryEntry>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::search_memories(&conn, &query)
}

#[tauri::command]
pub fn memory_recall_preview(db: State<AppDb>, query: String) -> Result<Vec<MemoryRecall>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::recall_memories(&conn, &query, 5, false)
}

#[tauri::command]
pub fn memory_events_list(
    db: State<AppDb>,
    memory_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemoryEvent>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::list_memory_events(&conn, memory_id, limit)
}

#[tauri::command]
pub fn memory_runs_list(
    db: State<AppDb>,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemoryRun>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    engine::list_memory_runs(&conn, kind, limit)
}

#[tauri::command]
pub async fn memory_run_now(app: AppHandle, kind: String) -> Result<MemoryRun, String> {
    let plan_kind = kind.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        String::new(),
        move |conn| {
            // Invalidation targets only the exact active legacy-unscoped rows a
            // consolidation/auto-dream run can actually mutate. Unrelated
            // explicitly scoped facts are neither enumerated nor invalidated.
            let ids: Vec<String> = if plan_kind == "consolidation" || plan_kind == "auto_dream" {
                engine::legacy_consolidation_candidate_ids(conn)?
            } else {
                Vec::new()
            };
            plan_legacy_invalidation(conn, "", ids, fresh_operation_id())
        },
        move |conn, _invalidation| match kind.as_str() {
            "consolidation" | "auto_dream" => {
                // `consolidate_memories` already reads only active legacy rows
                // via its own legacy-only filter, so unrelated explicitly scoped
                // facts are untouched and must not abort the run. Manual legacy
                // consolidation therefore keeps working alongside scoped memory.
                engine::consolidate_memories(conn).map_err(MemoryError::storage_unavailable)
            }
            _ => Err(MemoryError::invalid_payload(format!(
                "Unsupported memory run kind '{}'",
                kind
            ))),
        },
    )
    .await
    .map_err(|error| error.message)
}
fn expand_path_safe(path_str: &str) -> Result<std::path::PathBuf, String> {
    if path_str.contains("..") || path_str.contains('\0') {
        return Err("Path traversal or invalid characters detected".to_string());
    }

    let expanded = if let Some(rest) = path_str.strip_prefix('~') {
        let home = crate::get_home_dir();
        let suffix = rest.strip_prefix(['/', '\\']).unwrap_or(rest);
        std::path::PathBuf::from(home).join(suffix)
    } else {
        std::path::PathBuf::from(path_str)
    };

    if !crate::jarvis::memory::paths::is_memory_path(&expanded) {
        return Err("Access denied: path is outside the memory directory".to_string());
    }

    Ok(expanded)
}

#[tauri::command]
pub fn list_memory_files(path: String) -> Result<Vec<String>, String> {
    let expanded = expand_path_safe(&path)?;

    if !expanded.exists() {
        return Ok(Vec::new());
    }

    let entries =
        std::fs::read_dir(&expanded).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let file_type = entry.file_type();
        if let Ok(ft) = file_type {
            if ft.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".md") {
                    files.push(name);
                }
            }
        }
    }

    // Sort descending so newer files (often named with dates) appear first
    files.sort_by(|a, b| b.cmp(a));

    Ok(files)
}

#[tauri::command]
pub fn read_memory_file(path: String) -> Result<String, String> {
    let expanded = expand_path_safe(&path)?;

    std::fs::read_to_string(&expanded).map_err(|e| format!("Failed to read memory file: {}", e))
}

#[tauri::command]
pub fn list_recent_memories(
    db: State<AppDb>,
    limit: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let lim = limit.unwrap_or(100).max(0) as usize;

    // Return the canonical MemoryEntry shape (confidence, tags, updated_at, status,
    // metadata, …) by reusing the engine's schema-correct query. The previous
    // hand-rolled projection dropped `confidence` and `tags`, so MemoryView's
    // `m.confidence.toFixed(2)` threw and the whole page rendered "error loading".
    // `list_memories` orders active rows first, newest first.
    let memories = crate::jarvis::memory::engine::list_memories(&conn)?;
    Ok(memories
        .into_iter()
        .take(lim)
        .map(|m| serde_json::to_value(m).unwrap_or(serde_json::Value::Null))
        .filter(|value| !value.is_null())
        .collect())
}

// ── Workspace file commands ──────────────────────────────────────
//
// These are separate from the cold-tier Drive archive; they expose the
// local JARVIS workspace directory (where the agent's persistent notes
// and scratch files live) to the UI. Path validation is the same as
// `expand_path_safe` above.

#[tauri::command]
pub fn list_workspace_files(path: String) -> Result<Vec<String>, String> {
    let expanded = expand_path_safe(&path)?;
    if !expanded.exists() {
        return Ok(Vec::new());
    }
    let entries =
        std::fs::read_dir(&expanded).map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        if let Ok(ft) = entry.file_type() {
            if ft.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                files.push(name);
            }
        }
    }
    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn read_workspace_file(path: String) -> Result<String, String> {
    let expanded = expand_path_safe(&path)?;
    std::fs::read_to_string(&expanded).map_err(|e| format!("Failed to read workspace file: {}", e))
}

// ── Scoped memory commands (Phase 1 native surface) ─────────────────────────
//
// Ownership is always resolved from the persisted Session: the request DTO
// carries no Agent/project/provenance authority. Manual commands construct
// manual authority themselves and never fabricate verification.

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct BindSessionWorkspaceRequest {
    pub session_id: String,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedSaveRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub draft: MemoryDraft,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedReadRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedListRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    #[serde(default)]
    pub include_inactive: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedUpdateRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub id: String,
    pub expected_revision: i64,
    pub draft: MemoryDraft,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedDeleteRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub id: String,
    pub expected_revision: i64,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedRestoreRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub id: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ScopedRecallPreviewRequest {
    pub session_id: String,
    pub query: String,
    #[serde(default)]
    pub options: RecallOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct AdoptLegacyRequest {
    pub session_id: String,
    pub selector: ScopeSelector,
    pub id: String,
    pub expected_revision: i64,
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

pub fn execute_bind_session_workspace(
    conn: &Connection,
    request: BindSessionWorkspaceRequest,
) -> Result<MemoryScope, MemoryError> {
    scope::bind_session_workspace(conn, &request.session_id, request.workspace_root.as_deref())
}

pub fn execute_scoped_save(
    conn: &Connection,
    request: ScopedSaveRequest,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    let write_scope =
        scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    let provenance = manual_provenance(&request.session_id);
    scoped::save_scoped_memory(conn, &write_scope, request.draft, &provenance, now)
}

pub fn execute_scoped_read(
    conn: &Connection,
    request: ScopedReadRequest,
) -> Result<ScopedMemoryEntry, MemoryError> {
    let read_scope =
        scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    scoped::read_scoped_memory(conn, &read_scope, &request.id)
}

pub fn execute_scoped_list(
    conn: &Connection,
    request: ScopedListRequest,
) -> Result<Vec<ScopedMemoryEntry>, MemoryError> {
    let read_scope =
        scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    scoped::list_scoped_memories(conn, &read_scope, request.include_inactive)
}

pub fn execute_scoped_update(
    conn: &Connection,
    request: ScopedUpdateRequest,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    let write_scope =
        scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    let provenance = manual_provenance(&request.session_id);
    scoped::update_scoped_memory(
        conn,
        &write_scope,
        &request.id,
        request.expected_revision,
        request.draft,
        &provenance,
        now,
    )
}

pub fn execute_scoped_delete(
    conn: &Connection,
    request: ScopedDeleteRequest,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    let write_scope =
        scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    scoped::tombstone_scoped_memory(
        conn,
        &write_scope,
        &request.id,
        request.expected_revision,
        &request.reason,
        now,
    )
}

pub fn execute_scoped_restore(
    conn: &Connection,
    request: ScopedRestoreRequest,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    let write_scope =
        scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    scoped::restore_scoped_memory(
        conn,
        &write_scope,
        &request.id,
        request.expected_revision,
        now,
    )
}

pub fn execute_scoped_recall_preview(
    conn: &Connection,
    request: ScopedRecallPreviewRequest,
    now: DateTime<Utc>,
) -> Result<RecallPreview, MemoryError> {
    let read_scope = scope::resolve_session_memory_scope(conn, &request.session_id)?;
    scoped::recall_scoped_memories(conn, &read_scope, &request.query, &request.options, now)
}

pub fn execute_adopt_legacy(
    conn: &Connection,
    request: AdoptLegacyRequest,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    let target_scope =
        scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
    scoped::adopt_legacy_memory(conn, &request.id, request.expected_revision, &target_scope, now)
}

#[tauri::command]
pub async fn memory_bind_session_workspace(
    app: AppHandle,
    request: BindSessionWorkspaceRequest,
) -> Result<MemoryScope, MemoryError> {
    let session_id = request.session_id.clone();
    let plan_session = session_id.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        session_id,
        move |_conn| {
            Ok(NativeDerivedMutationPlan {
                invalidation: MemoryDerivedInvalidation {
                    operation_id: fresh_operation_id(),
                    affected_session_ids: vec![plan_session],
                    memory_ids: Vec::new(),
                    source_message_ids: Vec::new(),
                },
                scope: None,
            })
        },
        move |conn, _plan| execute_bind_session_workspace(conn, request),
    )
    .await
}

#[tauri::command]
pub async fn memory_scoped_save(
    app: AppHandle,
    request: ScopedSaveRequest,
) -> Result<MutationResult, MemoryError> {
    let session_id = request.session_id.clone();
    let plan_request = request.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        session_id,
        move |conn| {
            let write_scope =
                scope::resolve_write_scope(conn, &plan_request.session_id, &plan_request.selector)?;
            plan_scoped_invalidation(
                conn,
                &plan_request.session_id,
                &write_scope,
                Vec::new(),
                fresh_operation_id(),
            )
        },
        move |conn, _invalidation| execute_scoped_save(conn, request, Utc::now()),
    )
    .await
}

#[tauri::command]
pub fn memory_scoped_read(
    db: State<AppDb>,
    request: ScopedReadRequest,
) -> Result<ScopedMemoryEntry, MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    execute_scoped_read(&conn, request)
}

#[tauri::command]
pub fn memory_scoped_list(
    db: State<AppDb>,
    request: ScopedListRequest,
) -> Result<Vec<ScopedMemoryEntry>, MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    execute_scoped_list(&conn, request)
}

#[tauri::command]
pub async fn memory_scoped_update(
    app: AppHandle,
    request: ScopedUpdateRequest,
) -> Result<MutationResult, MemoryError> {
    let session_id = request.session_id.clone();
    let plan_request = request.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        session_id,
        move |conn| {
            let write_scope =
                scope::resolve_write_scope(conn, &plan_request.session_id, &plan_request.selector)?;
            plan_scoped_invalidation(
                conn,
                &plan_request.session_id,
                &write_scope,
                vec![plan_request.id.clone()],
                fresh_operation_id(),
            )
        },
        move |conn, _invalidation| {
            // Suppress the OLD provenance before the in-place overwrite.
            let write_scope =
                scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
            continuity::suppress_memory_sources(
                conn,
                &write_scope,
                &[request.id.clone()],
                Utc::now(),
            )?;
            execute_scoped_update(conn, request, Utc::now())
        },
    )
    .await
}

#[tauri::command]
pub async fn memory_scoped_delete(
    app: AppHandle,
    request: ScopedDeleteRequest,
) -> Result<MutationResult, MemoryError> {
    let session_id = request.session_id.clone();
    let plan_request = request.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        session_id,
        move |conn| {
            let write_scope =
                scope::resolve_write_scope(conn, &plan_request.session_id, &plan_request.selector)?;
            plan_scoped_invalidation(
                conn,
                &plan_request.session_id,
                &write_scope,
                vec![plan_request.id.clone()],
                fresh_operation_id(),
            )
        },
        move |conn, _invalidation| {
            let write_scope =
                scope::resolve_write_scope(conn, &request.session_id, &request.selector)?;
            continuity::suppress_memory_sources(conn, &write_scope, &[request.id.clone()], Utc::now())?;
            let _ = continuity::clear_continuity_dependent_on(conn, &[request.id.clone()], Utc::now())?;
            execute_scoped_delete(conn, request, Utc::now())
        },
    )
    .await
}

#[tauri::command]
pub async fn memory_scoped_restore(
    app: AppHandle,
    request: ScopedRestoreRequest,
) -> Result<MutationResult, MemoryError> {
    let session_id = request.session_id.clone();
    let plan_request = request.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        session_id,
        move |conn| {
            let write_scope =
                scope::resolve_write_scope(conn, &plan_request.session_id, &plan_request.selector)?;
            plan_scoped_invalidation(
                conn,
                &plan_request.session_id,
                &write_scope,
                vec![plan_request.id.clone()],
                fresh_operation_id(),
            )
        },
        move |conn, _invalidation| execute_scoped_restore(conn, request, Utc::now()),
    )
    .await
}

#[tauri::command]
pub fn memory_scoped_recall_preview(
    db: State<AppDb>,
    request: ScopedRecallPreviewRequest,
) -> Result<RecallPreview, MemoryError> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    execute_scoped_recall_preview(&conn, request, Utc::now())
}

#[tauri::command]
pub async fn memory_adopt_legacy(
    app: AppHandle,
    request: AdoptLegacyRequest,
) -> Result<MutationResult, MemoryError> {
    let session_id = request.session_id.clone();
    let plan_request = request.clone();
    super::memory_turn::run_derived_gated_mutation(
        app,
        session_id,
        move |conn| {
            let target_scope =
                scope::resolve_write_scope(conn, &plan_request.session_id, &plan_request.selector)?;
            plan_scoped_invalidation(
                conn,
                &plan_request.session_id,
                &target_scope,
                vec![plan_request.id.clone()],
                fresh_operation_id(),
            )
        },
        move |conn, _invalidation| {
            // Adoption retains suppression of the source provenance and clears
            // any dependent objective with an audit event.
            continuity::suppress_legacy_memory_sources(conn, &[request.id.clone()], Utc::now())?;
            let _ = continuity::clear_continuity_dependent_on(conn, &[request.id.clone()], Utc::now())?;
            execute_adopt_legacy(conn, request, Utc::now())
        },
    )
    .await
}
