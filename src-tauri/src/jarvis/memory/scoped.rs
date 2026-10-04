// ═══════════════════════════════════════════════════════════════
// Scoped Memory — transactional mutation and eligible retrieval
// ═══════════════════════════════════════════════════════════════
//
// Every mutation runs inside a named SQL savepoint so callers (Phase 3) can
// compose tombstones, replacements, relationships, events, and an operation
// ledger into one outer transaction. The per-row revision and singleton store
// revision move atomically with the mutation and its audit event.

use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Utc};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as JsonValue;

use super::contracts::{
    AuthorityKind, MemoryDraft, MemoryError, MemoryProvenance, MemoryScope, MemoryScopeKind,
    MutationResult, ScopedMemoryEntry,
};
use super::engine;

const MAX_MEMORY_CONTENT_BYTES: usize = 4096;

static SAVEPOINT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Run `operation` inside a uniquely-named SQL SAVEPOINT. On success the
/// savepoint is released; on error it is rolled back and released. Using
/// SAVEPOINT (not BEGIN/COMMIT) keeps native operations composable.
pub(crate) fn with_memory_savepoint<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> Result<T, MemoryError>,
) -> Result<T, MemoryError> {
    let name = format!("memory_sp_{}", SAVEPOINT_SEQ.fetch_add(1, Ordering::Relaxed));
    conn.execute_batch(&format!("SAVEPOINT {}", name))
        .map_err(MemoryError::from)?;
    match operation(conn) {
        Ok(value) => {
            conn.execute_batch(&format!("RELEASE SAVEPOINT {}", name))
                .map_err(MemoryError::from)?;
            Ok(value)
        }
        Err(err) => {
            let _ = conn.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {name}; RELEASE SAVEPOINT {name}"
            ));
            Err(err)
        }
    }
}

/// Read the singleton store revision. Must be called after the mutation's
/// transaction has committed to observe the final invalidation value.
pub fn memory_store_revision(conn: &Connection) -> Result<i64, MemoryError> {
    conn.query_row(
        "SELECT revision FROM memory_store_state WHERE singleton = 1",
        [],
        |row| row.get(0),
    )
    .map_err(MemoryError::from)
}

pub(crate) fn parse_scope_kind(value: &str) -> MemoryScopeKind {
    match value {
        "project" => MemoryScopeKind::Project,
        "agent" => MemoryScopeKind::Agent,
        "user" => MemoryScopeKind::User,
        _ => MemoryScopeKind::LegacyUnscoped,
    }
}

pub(crate) fn parse_authority(value: &str) -> AuthorityKind {
    match value {
        "manual" => AuthorityKind::Manual,
        "user_statement" => AuthorityKind::UserStatement,
        "verified_observation" => AuthorityKind::VerifiedObservation,
        "assistant_proposal" => AuthorityKind::AssistantProposal,
        _ => AuthorityKind::LegacyUnknown,
    }
}

pub(crate) fn authority_str(kind: AuthorityKind) -> &'static str {
    match kind {
        AuthorityKind::Manual => "manual",
        AuthorityKind::UserStatement => "user_statement",
        AuthorityKind::VerifiedObservation => "verified_observation",
        AuthorityKind::AssistantProposal => "assistant_proposal",
        AuthorityKind::LegacyUnknown => "legacy_unknown",
    }
}

fn default_confidence(authority: AuthorityKind) -> f64 {
    match authority {
        AuthorityKind::Manual => 0.9,
        AuthorityKind::UserStatement => 0.95,
        AuthorityKind::VerifiedObservation => 0.98,
        AuthorityKind::AssistantProposal => 0.5,
        AuthorityKind::LegacyUnknown => 0.3,
    }
}

fn scope_columns(scope: &MemoryScope) -> (&'static str, Option<String>) {
    match scope.kind {
        MemoryScopeKind::Project => ("project", scope.project_root.clone()),
        MemoryScopeKind::Agent => ("agent", None),
        MemoryScopeKind::User => ("user", None),
        MemoryScopeKind::LegacyUnscoped => ("legacy_unscoped", None),
    }
}

fn validate_writable_scope(scope: &MemoryScope) -> Result<(), MemoryError> {
    match scope.kind {
        MemoryScopeKind::Project => {
            if scope.project_root.is_none() || scope.agent_id.is_empty() {
                return Err(MemoryError::invalid_scope(
                    "Project scope requires an Agent identity and a project root",
                ));
            }
            Ok(())
        }
        MemoryScopeKind::Agent => {
            if scope.project_root.is_some() || scope.agent_id.is_empty() {
                return Err(MemoryError::invalid_scope(
                    "Agent scope requires an Agent identity and no project root",
                ));
            }
            Ok(())
        }
        MemoryScopeKind::User => {
            if scope.project_root.is_some() || !scope.agent_id.is_empty() {
                return Err(MemoryError::invalid_scope(
                    "User scope has no Agent identity and no project root",
                ));
            }
            Ok(())
        }
        MemoryScopeKind::LegacyUnscoped => Err(MemoryError::invalid_scope(
            "Legacy scope is read-only; adopt the record explicitly first",
        )),
    }
}

fn validate_draft(draft: &MemoryDraft) -> Result<(), MemoryError> {
    if draft.content.len() > MAX_MEMORY_CONTENT_BYTES {
        return Err(MemoryError::invalid_payload(
            "Memory content exceeds the 4096-byte limit",
        ));
    }
    engine::validate_memory_payload(&draft.title, &draft.content, &draft.category)
        .map_err(|block| MemoryError::invalid_payload(block.reason))
}

fn normalize_optional_ts(value: Option<&str>) -> Result<Option<String>, MemoryError> {
    match value {
        None => Ok(None),
        Some(raw) if raw.trim().is_empty() => Ok(None),
        Some(raw) => DateTime::parse_from_rfc3339(raw.trim())
            .map(|dt| Some(dt.with_timezone(&Utc).to_rfc3339()))
            .map_err(|_| MemoryError::invalid_payload("Invalid timestamp")),
    }
}

fn validate_provenance_for_write(
    conn: &Connection,
    provenance: &MemoryProvenance,
) -> Result<(), MemoryError> {
    match provenance.authority_kind {
        AuthorityKind::LegacyUnknown => Err(MemoryError::invalid_provenance(
            "Legacy authority cannot be written directly",
        )),
        AuthorityKind::VerifiedObservation => Err(MemoryError::invalid_provenance(
            "Verified observations require trusted native capture evidence (phase 3)",
        )),
        AuthorityKind::Manual | AuthorityKind::AssistantProposal => Ok(()),
        AuthorityKind::UserStatement => {
            let session = provenance.source_session_id.as_deref().ok_or_else(|| {
                MemoryError::invalid_provenance("user_statement requires a source Session")
            })?;
            if provenance.source_message_ids.is_empty() {
                return Err(MemoryError::invalid_provenance(
                    "user_statement requires cited message IDs",
                ));
            }
            for message_id in &provenance.source_message_ids {
                let role: Option<String> = conn
                    .query_row(
                        "SELECT role FROM messages WHERE id = ? AND session_id = ?",
                        rusqlite::params![message_id, session],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(MemoryError::from)?;
                match role.as_deref() {
                    Some("user") => {}
                    Some(_) => {
                        return Err(MemoryError::invalid_provenance(
                            "cited message is not a user statement",
                        ))
                    }
                    None => {
                        return Err(MemoryError::invalid_provenance(
                            "cited message does not belong to the Session",
                        ))
                    }
                }
            }
            Ok(())
        }
    }
}

fn scope_predicate(prefix: &str, scope: &MemoryScope) -> (String, Vec<Value>) {
    let p = prefix;
    match scope.kind {
        MemoryScopeKind::Project => (
            format!(
                "({p}.scope_kind = 'project' AND {p}.agent_id = ? AND {p}.project_root = ?)"
            ),
            vec![
                Value::from(scope.agent_id.clone()),
                Value::from(scope.project_root.clone().unwrap_or_default()),
            ],
        ),
        MemoryScopeKind::Agent => (
            format!("({p}.scope_kind = 'agent' AND {p}.agent_id = ? AND {p}.project_root IS NULL)"),
            vec![Value::from(scope.agent_id.clone())],
        ),
        MemoryScopeKind::User => (
            format!("({p}.scope_kind = 'user' AND {p}.agent_id = '' AND {p}.project_root IS NULL)"),
            vec![],
        ),
        MemoryScopeKind::LegacyUnscoped => {
            (format!("({p}.scope_kind = 'legacy_unscoped')"), vec![])
        }
    }
}

fn scoped_select_columns() -> String {
    format!(
        "{}, m.scope_kind, m.project_root, m.authority_kind, m.source_run_id, m.verified_at, m.revision",
        engine::prefixed_memory_columns("m")
    )
}

fn scoped_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScopedMemoryEntry> {
    let entry = engine::memory_from_row(row)?;
    let scope_kind: String = row
        .get(25)
        .unwrap_or_else(|_| "legacy_unscoped".to_string());
    let memory_root: Option<String> = row.get(26).unwrap_or(None);
    let authority: String = row
        .get(27)
        .unwrap_or_else(|_| "legacy_unknown".to_string());
    let source_run_id: Option<String> = row.get(28).unwrap_or(None);
    let verified_at: Option<String> = row.get(29).unwrap_or(None);
    let revision: i64 = row.get(30).unwrap_or(1);
    Ok(ScopedMemoryEntry {
        scope: MemoryScope {
            kind: parse_scope_kind(&scope_kind),
            agent_id: entry.agent_id.clone(),
            project_root: memory_root,
        },
        entry,
        authority_kind: parse_authority(&authority),
        source_run_id,
        verified_at,
        revision,
    })
}

fn read_scoped_memory_inner(
    conn: &Connection,
    scope: &MemoryScope,
    id: &str,
) -> Result<ScopedMemoryEntry, MemoryError> {
    let (predicate, scope_params) = scope_predicate("m", scope);
    let sql = format!(
        "SELECT {} FROM memory m WHERE m.id = ? AND {}",
        scoped_select_columns(),
        predicate
    );
    let mut values: Vec<Value> = Vec::with_capacity(1 + scope_params.len());
    values.push(Value::from(id.to_string()));
    values.extend(scope_params);
    conn.query_row(&sql, rusqlite::params_from_iter(values), scoped_from_row)
        .optional()
        .map_err(MemoryError::from)?
        .ok_or_else(|| MemoryError::not_found("Memory not found in the selected scope"))
}

pub fn read_scoped_memory(
    conn: &Connection,
    scope: &MemoryScope,
    id: &str,
) -> Result<ScopedMemoryEntry, MemoryError> {
    read_scoped_memory_inner(conn, scope, id)
}

pub fn list_scoped_memories(
    conn: &Connection,
    scope: &MemoryScope,
    include_inactive: bool,
) -> Result<Vec<ScopedMemoryEntry>, MemoryError> {
    let (predicate, scope_params) = scope_predicate("m", scope);
    let status_clause = if include_inactive {
        ""
    } else {
        " AND m.status = 'active'"
    };
    let sql = format!(
        "SELECT {} FROM memory m WHERE {}{} ORDER BY m.updated_at DESC",
        scoped_select_columns(),
        predicate,
        status_clause
    );
    let mut stmt = conn.prepare(&sql).map_err(MemoryError::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(scope_params), scoped_from_row)
        .map_err(MemoryError::from)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(MemoryError::from)
}

pub fn save_scoped_memory(
    conn: &Connection,
    scope: &MemoryScope,
    draft: MemoryDraft,
    provenance: &MemoryProvenance,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    validate_writable_scope(scope)?;
    validate_draft(&draft)?;
    validate_provenance_for_write(conn, provenance)?;

    let id = uuid::Uuid::new_v4().to_string();
    let stored = with_memory_savepoint(conn, |conn| {
        let now_str = now.to_rfc3339();
        let tags_json =
            serde_json::to_string(&draft.tags).unwrap_or_else(|_| "[]".to_string());
        let source_message_ids = serde_json::to_string(&provenance.source_message_ids)
            .unwrap_or_else(|_| "[]".to_string());
        let expires_at = normalize_optional_ts(draft.expires_at.as_deref())?;
        let review_after = normalize_optional_ts(draft.review_after.as_deref())?;
        let (scope_kind, project_root) = scope_columns(scope);
        let confidence = default_confidence(provenance.authority_kind);

        conn.execute(
            "INSERT INTO memory
             (id, title, content, tags, category, relevance_score, created_at, updated_at,
              agent_id, source, source_session_id, source_message_ids, confidence, last_used_at,
              usage_count, expires_at, review_after, status, supersedes_id, metadata,
              scope_kind, project_root, authority_kind, source_run_id, verified_at, revision)
             VALUES (?, ?, ?, ?, ?, 0.0, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 'active', NULL, NULL,
                     ?, ?, ?, ?, ?, 1)",
            rusqlite::params![
                &id,
                &draft.title,
                &draft.content,
                &tags_json,
                &draft.category,
                &now_str,
                &now_str,
                &scope.agent_id,
                &provenance.source,
                &provenance.source_session_id,
                &source_message_ids,
                confidence,
                &expires_at,
                &review_after,
                scope_kind,
                &project_root,
                authority_str(provenance.authority_kind),
                &provenance.source_run_id,
                &provenance.verified_at,
            ],
        )
        .map_err(MemoryError::from)?;

        let stored = read_scoped_memory_inner(conn, scope, &id)?;
        engine::write_memory_event(
            conn,
            Some(&id),
            "create",
            "memory_scoped",
            None,
            Some(serde_json::to_value(&stored).unwrap_or(JsonValue::Null)),
            "Scoped memory save",
            stored.entry.confidence,
            provenance.source_session_id.as_deref(),
        )
        .map_err(MemoryError::storage_unavailable)?;
        Ok(stored)
    })?;

    let store_revision = memory_store_revision(conn)?;
    Ok(MutationResult {
        memory: stored,
        store_revision,
        changed: true,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn update_scoped_memory(
    conn: &Connection,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    draft: MemoryDraft,
    provenance: &MemoryProvenance,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    validate_writable_scope(scope)?;
    validate_draft(&draft)?;
    validate_provenance_for_write(conn, provenance)?;

    let (predicate, scope_params) = scope_predicate("memory", scope);
    let updated = with_memory_savepoint(conn, |conn| {
        let before = read_scoped_memory_inner(conn, scope, id)?;
        if before.revision != expected_revision {
            return Err(MemoryError::revision_conflict(
                "Memory revision no longer matches the expected revision",
            ));
        }
        let now_str = now.to_rfc3339();
        let tags_json =
            serde_json::to_string(&draft.tags).unwrap_or_else(|_| "[]".to_string());
        let source_message_ids = serde_json::to_string(&provenance.source_message_ids)
            .unwrap_or_else(|_| "[]".to_string());
        let expires_at = normalize_optional_ts(draft.expires_at.as_deref())?;
        let review_after = normalize_optional_ts(draft.review_after.as_deref())?;

        let mut values: Vec<Value> = vec![
            Value::from(draft.title.clone()),
            Value::from(draft.content.clone()),
            Value::from(tags_json),
            Value::from(draft.category.clone()),
            expires_at.clone().map(Value::from).unwrap_or(Value::Null),
            review_after.clone().map(Value::from).unwrap_or(Value::Null),
            Value::from(authority_str(provenance.authority_kind)),
            Value::from(provenance.source.clone()),
            provenance
                .source_session_id
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
            Value::from(source_message_ids),
            provenance
                .source_run_id
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
            provenance
                .verified_at
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
            Value::from(now_str.clone()),
            Value::from(id.to_string()),
        ];
        values.extend(scope_params);

        let sql = format!(
            "UPDATE memory SET title = ?, content = ?, tags = ?, category = ?,
                 expires_at = ?, review_after = ?, authority_kind = ?, source = ?,
                 source_session_id = ?, source_message_ids = ?, source_run_id = ?,
                 verified_at = ?, revision = revision + 1, updated_at = ?
             WHERE id = ? AND {}",
            predicate
        );
        conn.execute(&sql, rusqlite::params_from_iter(values))
            .map_err(MemoryError::from)?;

        let after = read_scoped_memory_inner(conn, scope, id)?;
        engine::write_memory_event(
            conn,
            Some(id),
            "update",
            "memory_scoped",
            Some(serde_json::to_value(&before).unwrap_or(JsonValue::Null)),
            Some(serde_json::to_value(&after).unwrap_or(JsonValue::Null)),
            "Scoped memory update",
            after.entry.confidence,
            provenance.source_session_id.as_deref(),
        )
        .map_err(MemoryError::storage_unavailable)?;
        Ok(after)
    })?;

    let store_revision = memory_store_revision(conn)?;
    Ok(MutationResult {
        memory: updated,
        store_revision,
        changed: true,
    })
}

pub fn tombstone_scoped_memory(
    conn: &Connection,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    validate_writable_scope(scope)?;
    let (predicate, scope_params) = scope_predicate("memory", scope);
    let (stored, changed) = with_memory_savepoint(conn, |conn| {
        let before = read_scoped_memory_inner(conn, scope, id)?;
        if before.entry.status == "tombstoned" {
            return Ok((before, false));
        }
        if before.revision != expected_revision {
            return Err(MemoryError::revision_conflict(
                "Memory revision no longer matches the expected revision",
            ));
        }
        let mut values: Vec<Value> = vec![
            Value::from(now.to_rfc3339()),
            Value::from(id.to_string()),
        ];
        values.extend(scope_params.clone());
        let sql = format!(
            "UPDATE memory SET status = 'tombstoned', revision = revision + 1, updated_at = ?
             WHERE id = ? AND {}",
            predicate
        );
        conn.execute(&sql, rusqlite::params_from_iter(values))
            .map_err(MemoryError::from)?;
        let after = read_scoped_memory_inner(conn, scope, id)?;
        engine::write_memory_event(
            conn,
            Some(id),
            "tombstone",
            "memory_scoped",
            Some(serde_json::to_value(&before).unwrap_or(JsonValue::Null)),
            Some(serde_json::to_value(&after).unwrap_or(JsonValue::Null)),
            reason,
            1.0,
            None,
        )
        .map_err(MemoryError::storage_unavailable)?;
        Ok((after, true))
    })?;

    let store_revision = memory_store_revision(conn)?;
    Ok(MutationResult {
        memory: stored,
        store_revision,
        changed,
    })
}

pub fn restore_scoped_memory(
    conn: &Connection,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    validate_writable_scope(scope)?;
    let (predicate, scope_params) = scope_predicate("memory", scope);
    let (stored, changed) = with_memory_savepoint(conn, |conn| {
        let before = read_scoped_memory_inner(conn, scope, id)?;
        if before.entry.status == "active" {
            return Ok((before, false));
        }
        if before.revision != expected_revision {
            return Err(MemoryError::revision_conflict(
                "Memory revision no longer matches the expected revision",
            ));
        }
        let mut values: Vec<Value> = vec![
            Value::from(now.to_rfc3339()),
            Value::from(id.to_string()),
        ];
        values.extend(scope_params.clone());
        let sql = format!(
            "UPDATE memory SET status = 'active', revision = revision + 1, updated_at = ?
             WHERE id = ? AND {}",
            predicate
        );
        conn.execute(&sql, rusqlite::params_from_iter(values))
            .map_err(MemoryError::from)?;
        let after = read_scoped_memory_inner(conn, scope, id)?;
        engine::write_memory_event(
            conn,
            Some(id),
            "restore",
            "memory_scoped",
            Some(serde_json::to_value(&before).unwrap_or(JsonValue::Null)),
            Some(serde_json::to_value(&after).unwrap_or(JsonValue::Null)),
            "Scoped memory restore",
            1.0,
            None,
        )
        .map_err(MemoryError::storage_unavailable)?;
        Ok((after, true))
    })?;

    let store_revision = memory_store_revision(conn)?;
    Ok(MutationResult {
        memory: stored,
        store_revision,
        changed,
    })
}
