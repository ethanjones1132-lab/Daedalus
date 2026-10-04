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
    AuthorityKind, MemoryDraft, MemoryError, MemoryProvenance, MemoryScope,
    MemoryScopeKind, MutationResult, RecallOptions, RecallPreview, ScopedMemoryEntry,
    ScopedMemoryRecall,
};
use super::engine;

const MAX_MEMORY_CONTENT_BYTES: usize = 4096;
const RECALL_LIMIT: usize = 5;
const CANDIDATE_LIMIT: usize = 30;

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
    scope: &MemoryScope,
    provenance: &MemoryProvenance,
) -> Result<(), MemoryError> {
    match provenance.authority_kind {
        AuthorityKind::LegacyUnknown => Err(MemoryError::invalid_provenance(
            "Legacy authority cannot be written directly",
        )),
        AuthorityKind::VerifiedObservation => Err(MemoryError::invalid_provenance(
            "Verified observations require trusted native capture evidence (phase 3)",
        )),
        AuthorityKind::Manual | AuthorityKind::AssistantProposal | AuthorityKind::UserStatement => {
            // Source-less manual writes are valid. Any supplied provenance must
            // be internally consistent: the cited Session must exist, its
            // Agent must match a project/Agent scope, and every cited message
            // must belong to that Session.
            let session = match provenance.source_session_id.as_deref() {
                Some(session) => session,
                None => {
                    if !provenance.source_message_ids.is_empty() {
                        return Err(MemoryError::invalid_provenance(
                            "cited messages require a source Session",
                        ));
                    }
                    if provenance.authority_kind == AuthorityKind::UserStatement {
                        return Err(MemoryError::invalid_provenance(
                            "user_statement requires a source Session",
                        ));
                    }
                    return Ok(());
                }
            };

            let owner: Option<String> = conn
                .query_row(
                    "SELECT agent_id FROM sessions WHERE id = ?",
                    [session],
                    |row| row.get(0),
                )
                .optional()
                .map_err(MemoryError::from)?;
            let owner = owner.ok_or_else(|| {
                MemoryError::invalid_provenance("source Session does not exist")
            })?;
            if matches!(
                scope.kind,
                MemoryScopeKind::Project | MemoryScopeKind::Agent
            ) && owner != scope.agent_id
            {
                return Err(MemoryError::invalid_provenance(
                    "source Session Agent does not match the memory scope",
                ));
            }

            if provenance.authority_kind == AuthorityKind::UserStatement
                && provenance.source_message_ids.is_empty()
            {
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
                    Some(_) if provenance.authority_kind == AuthorityKind::UserStatement => {
                        return Err(MemoryError::invalid_provenance(
                            "cited message is not a user statement",
                        ))
                    }
                    Some(_) => {}
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
    validate_provenance_for_write(conn, scope, provenance)?;

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

/// Coarse lifecycle filter applied in SQL. It intentionally does not evaluate
/// expiry or timestamp validity: exact RFC3339 parsing and precise comparison
/// cannot be expressed in SQLite. Malformed and expired rows are rejected
/// during streaming admission before they can enter the candidate budget.
const LIFECYCLE_FILTER: &str = "(m.status = 'active'
    AND m.tier IN ('hot','warm')
    AND m.authority_kind IN ('manual','user_statement','verified_observation'))";

fn recall_scope_predicate(scope: &MemoryScope, include_user: bool) -> (String, Vec<Value>) {
    let (base, params) = match scope.kind {
        MemoryScopeKind::Project => (
            "( (m.scope_kind = 'project' AND m.agent_id = ? AND m.project_root = ?)
               OR (m.scope_kind = 'agent' AND m.agent_id = ?) )"
                .to_string(),
            vec![
                Value::from(scope.agent_id.clone()),
                Value::from(scope.project_root.clone().unwrap_or_default()),
                Value::from(scope.agent_id.clone()),
            ],
        ),
        MemoryScopeKind::Agent => (
            "(m.scope_kind = 'agent' AND m.agent_id = ?)".to_string(),
            vec![Value::from(scope.agent_id.clone())],
        ),
        MemoryScopeKind::User => (
            "(m.scope_kind = 'user' AND m.agent_id = '')".to_string(),
            vec![],
        ),
        MemoryScopeKind::LegacyUnscoped => (
            "(m.scope_kind = 'legacy_unscoped')".to_string(),
            vec![],
        ),
    };

    if include_user && scope.kind != MemoryScopeKind::User {
        (
            format!("({} OR (m.scope_kind = 'user' AND m.agent_id = ''))", base),
            params,
        )
    } else {
        (base, params)
    }
}

fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Stream a scoped result set, applying strict lifecycle admission. Each row is
/// parsed and compared in Rust before it may consume a candidate slot, and
/// iteration stops as soon as `limit` genuinely eligible entries exist. This
/// keeps matching rows from being materialized and prevents malformed/expired
/// rows (which SQL cannot judge precisely) from displacing valid candidates.
fn admit_lifecycle(
    rows: impl Iterator<Item = rusqlite::Result<ScopedMemoryEntry>>,
    now: &DateTime<Utc>,
    limit: usize,
) -> Result<Vec<(ScopedMemoryEntry, bool)>, MemoryError> {
    let mut admitted: Vec<(ScopedMemoryEntry, bool)> = Vec::new();
    let mut rows = rows;
    while admitted.len() < limit {
        let Some(row) = rows.next() else { break };
        let memory = row.map_err(MemoryError::from)?;
        let id = memory.entry.id.clone();
        let expires_at = match parse_recall_timestamp(&memory.entry.expires_at, &id, "expires_at") {
            Ok(value) => value,
            Err(()) => continue,
        };
        let review_after =
            match parse_recall_timestamp(&memory.entry.review_after, &id, "review_after") {
                Ok(value) => value,
                Err(()) => continue,
            };
        if expires_at.map(|expires| expires <= *now).unwrap_or(false) {
            continue;
        }
        let stale = review_after
            .map(|review| review <= *now)
            .unwrap_or(false);
        admitted.push((memory, stale));
    }
    Ok(admitted)
}

/// Parse one persisted lifecycle timestamp. Returns `Err(())` for a present but
/// unparseable value, emitting a structured warning that contains only the
/// memory ID and the offending field (never memory content).
fn parse_recall_timestamp(
    value: &Option<String>,
    memory_id: &str,
    field: &'static str,
) -> Result<Option<DateTime<Utc>>, ()> {
    match value {
        None => Ok(None),
        Some(raw) => match DateTime::parse_from_rfc3339(raw) {
            Ok(dt) => Ok(Some(dt.with_timezone(&Utc))),
            Err(_) => {
                eprintln!(
                    "[memory] malformed timestamp memory_id={} field={}",
                    memory_id, field
                );
                Err(())
            }
        },
    }
}

/// Retrieve only eligible memories inside the explicit scope, ranking and
/// limiting after scope/status/expiry/tier filtering. This is a read-only
/// preview: it never marks usage, writes recall events, or touches revisions.
pub fn recall_scoped_memories(
    conn: &Connection,
    scope: &MemoryScope,
    query: &str,
    options: &RecallOptions,
    now: DateTime<Utc>,
) -> Result<RecallPreview, MemoryError> {
    let store_revision = memory_store_revision(conn)?;
    let limit = options.limit.min(RECALL_LIMIT);
    let terms = engine::query_terms(query);
    if terms.is_empty() || limit == 0 {
        return Ok(RecallPreview {
            scope: scope.clone(),
            store_revision,
            entries: Vec::new(),
        });
    }

    let (scope_clause, scope_params) = recall_scope_predicate(scope, options.include_user_scope);

    let mut candidates: Vec<(ScopedMemoryEntry, bool)> = Vec::new();

    if let Some(expr) = engine::fts_expr(query) {
        let sql = format!(
            "SELECT {} FROM memory_fts JOIN memory m ON m.id = memory_fts.id
             WHERE memory_fts MATCH ? AND {} AND {}",
            scoped_select_columns(),
            LIFECYCLE_FILTER,
            scope_clause
        );
        let attempt = (|| -> Result<Vec<(ScopedMemoryEntry, bool)>, MemoryError> {
            let mut stmt = conn.prepare(&sql).map_err(MemoryError::from)?;
            let mut values: Vec<Value> = vec![Value::from(expr.clone())];
            values.extend(scope_params.clone());
            let rows = stmt
                .query_map(rusqlite::params_from_iter(values), scoped_from_row)
                .map_err(MemoryError::from)?;
            admit_lifecycle(rows, &now, CANDIDATE_LIMIT)
        })();
        match attempt {
            Ok(rows) => candidates = rows,
            Err(err) => {
                // A missing or broken FTS index is not fatal; fall through to
                // the scoped literal fallback below. Genuine storage failure
                // will fail there too and surface as storage_unavailable.
                eprintln!("[memory] scoped FTS recall unavailable: {err}");
            }
        }
    }

    if candidates.is_empty() {
        let escaped = escape_like(query.trim());
        let pattern = format!("%{}%", escaped);
        let sql = format!(
            "SELECT {} FROM memory m WHERE {} AND
                (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'
                 OR m.tags LIKE ? ESCAPE '\\' OR m.category LIKE ? ESCAPE '\\')
             AND {}",
            scoped_select_columns(),
            LIFECYCLE_FILTER,
            scope_clause
        );
        let mut values: Vec<Value> = vec![
            Value::from(pattern.clone()),
            Value::from(pattern.clone()),
            Value::from(pattern.clone()),
            Value::from(pattern),
        ];
        values.extend(scope_params);
        let mut stmt = conn.prepare(&sql).map_err(MemoryError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), scoped_from_row)
            .map_err(MemoryError::from)?;
        candidates = admit_lifecycle(rows, &now, CANDIDATE_LIMIT)?;
    }

    let mut recalls: Vec<ScopedMemoryRecall> = candidates
        .into_iter()
        .filter_map(|(memory, stale)| {
            let (score, matched_terms) = engine::score_memory(&memory.entry, &terms);
            if matched_terms.is_empty() || score <= 0.05 {
                return None;
            }
            Some(ScopedMemoryRecall {
                memory,
                score,
                matched_terms,
                stale,
            })
        })
        .collect();

    recalls.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.memory.entry.id.cmp(&b.memory.entry.id))
    });
    recalls.truncate(limit);

    Ok(RecallPreview {
        scope: scope.clone(),
        store_revision,
        entries: recalls,
    })
}

/// Deliberately adopt one legacy quarantined record into an explicit scope.
/// The original content/metadata is preserved; only scope and authority are
/// changed, and the scope change is audited with before/after values.
pub fn adopt_legacy_memory(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
    target: &MemoryScope,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    validate_writable_scope(target)?;
    let (scope_kind, project_root) = scope_columns(target);
    let legacy = MemoryScope {
        kind: MemoryScopeKind::LegacyUnscoped,
        agent_id: String::new(),
        project_root: None,
    };

    let adopted = with_memory_savepoint(conn, |conn| {
        let before = read_scoped_memory_inner(conn, &legacy, id)?;
        if before.revision != expected_revision {
            return Err(MemoryError::revision_conflict(
                "Memory revision no longer matches the expected revision",
            ));
        }
        let adopted_authority = if before.entry.source == "manual" {
            AuthorityKind::Manual
        } else {
            // Unknown/automatic old attribution stays quarantined and
            // ineligible until a new explicit correction or verified record.
            AuthorityKind::LegacyUnknown
        };
        let now_str = now.to_rfc3339();
        conn.execute(
            "UPDATE memory SET scope_kind = ?, agent_id = ?, project_root = ?,
                 authority_kind = ?, revision = revision + 1, updated_at = ?
             WHERE id = ? AND scope_kind = 'legacy_unscoped'",
            rusqlite::params![
                scope_kind,
                &target.agent_id,
                &project_root,
                authority_str(adopted_authority),
                &now_str,
                id,
            ],
        )
        .map_err(MemoryError::from)?;

        let after = read_scoped_memory_inner(conn, target, id)?;
        engine::write_memory_event(
            conn,
            Some(id),
            "adopt_legacy",
            "memory_scoped",
            Some(serde_json::to_value(&before).unwrap_or(JsonValue::Null)),
            Some(serde_json::to_value(&after).unwrap_or(JsonValue::Null)),
            "Explicit legacy memory adoption",
            1.0,
            None,
        )
        .map_err(MemoryError::storage_unavailable)?;
        Ok(after)
    })?;

    let store_revision = memory_store_revision(conn)?;
    Ok(MutationResult {
        memory: adopted,
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
    validate_provenance_for_write(conn, scope, provenance)?;

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
            Value::from(authority_str(provenance.authority_kind).to_string()),
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
        if before.revision != expected_revision {
            return Err(MemoryError::revision_conflict(
                "Memory revision no longer matches the expected revision",
            ));
        }
        if before.entry.status == "tombstoned" {
            return Ok((before, false));
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
        if before.revision != expected_revision {
            return Err(MemoryError::revision_conflict(
                "Memory revision no longer matches the expected revision",
            ));
        }
        if before.entry.status == "active" {
            return Ok((before, false));
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
