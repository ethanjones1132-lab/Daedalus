// ═══════════════════════════════════════════════════════════════
// Native Memory Capture — deterministic admission + atomic receipts
// ═══════════════════════════════════════════════════════════════
//
// Phase 3.1 owns the deterministic admission grammar, the canonical
// operation hash, the idempotent operation ledger, and the transactional
// capture/correction/forget/proposal primitives. It does NOT register a
// command or route a live caller: Part 3.2 installs the derived-state
// invalidation gate before any of these helpers may become callable.
//
// Every helper composes Phase 1 `with_memory_savepoint` and the scoped
// mutation primitives so memory, audit, source suppression, continuity
// effects, and the operation ledger share one outer transaction. Inner
// results remain provisional until that outer savepoint releases.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value as JsonValue};

use super::capture_contracts::{
    CaptureOperationReceipt, CaptureOperationStatus, CaptureReceipt, CorrectionResult,
    ForgetResult, StageProposalRequest,
};
use super::contracts::{
    AuthorityKind, MemoryDraft, MemoryError, MemoryErrorCode, MemoryProvenance, MemoryScope,
    MemoryScopeKind, MutationResult,
};
use super::turn::{self, MemoryTurnTerminalStatus, PersistedMemoryTurn};
use super::{continuity, engine, scoped};

const CAPTURE_HASH_VERSION: &str = "memory_capture_v1";
const MAX_TITLE_SCALARS: usize = 80;

// ── Exact grammar ───────────────────────────────────────────────────────────

/// One parsed user directive. Parsed data never carries Agent identity,
/// project root, source authority, or recalled text: those are resolved
/// exclusively from the immutable `PersistedMemoryTurn` snapshot.
#[derive(Debug, Clone)]
pub enum UserMemoryOperation {
    Save { draft: MemoryDraft, source: String },
    Correct {
        id: String,
        expected_revision: i64,
        draft: MemoryDraft,
    },
    Forget {
        id: String,
        expected_revision: i64,
    },
    AcceptProposal {
        id: String,
    },
    Pending {
        reason_code: String,
    },
}

const PREFIX_SAVE_COLON: &str = "remember:";
const PREFIX_SAVE_THAT: &str = "remember that";
const PREFIX_CONSTRAINT: &str = "constraint:";
const PREFIX_DECISION: &str = "decision:";
const PREFIX_CORRECT: &str = "correct memory ";
const PREFIX_FORGET: &str = "forget memory ";
const PREFIX_ACCEPT: &str = "accept memory proposal ";

const SOURCE_REMEMBER: &str = "explicit_remember";
const SOURCE_CONSTRAINT: &str = "explicit_constraint";
const SOURCE_DECISION: &str = "explicit_decision";
const SOURCE_CORRECTION: &str = "explicit_correction";
const SOURCE_FORGET: &str = "explicit_forget";
const SOURCE_ACCEPTED_PROPOSAL: &str = "accepted_proposal";

fn directive_prefixes() -> [&'static str; 7] {
    [
        PREFIX_SAVE_COLON,
        PREFIX_SAVE_THAT,
        PREFIX_CONSTRAINT,
        PREFIX_DECISION,
        PREFIX_CORRECT,
        PREFIX_FORGET,
        PREFIX_ACCEPT,
    ]
}

fn scalar_len(value: &str) -> usize {
    value.chars().count()
}

fn truncate_scalars(value: &str, max: usize) -> String {
    if scalar_len(value) <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

fn category_for_scope(scope: &MemoryScope) -> String {
    match scope.kind {
        MemoryScopeKind::Project => "project".to_string(),
        _ => "user".to_string(),
    }
}

fn pending(reason: &str) -> UserMemoryOperation {
    UserMemoryOperation::Pending {
        reason_code: reason.to_string(),
    }
}

/// A whole-message quote or code fence removes directive authority. A quoted
/// ordinary sentence still yields no operation; a wrapped directive is
/// conservatively admitted as `pending`.
fn quoted_or_fenced(message: &str) -> bool {
    if message.starts_with("```") {
        return true;
    }
    let mut chars = message.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let Some(last) = chars.last() else {
        return false;
    };
    (first == '"' && last == '"')
        || (first == '\'' && last == '\'')
        || (first == '`' && last == '`')
}

fn mentions_directive(lower: &str) -> bool {
    directive_prefixes().iter().any(|prefix| lower.contains(prefix))
}

/// Count sentence-like segments whose trimmed start matches a directive
/// prefix. Two or more means the message attempts multiple directives.
fn directive_segment_count(message: &str) -> usize {
    message
        .split(|c| matches!(c, '\n' | '.' | ';' | '!' | '?'))
        .filter(|segment| {
            let lowered = segment.trim_start().to_lowercase();
            directive_prefixes()
                .iter()
                .any(|prefix| lowered.starts_with(prefix))
        })
        .count()
}

fn is_hypothetical(lower: &str) -> bool {
    [
        "if we decide",
        "if i decide",
        "if we choose",
        "if the user decides",
        "we might decide",
        "we may decide",
        "might decide",
        "hypothetically",
        "suppose we",
        "assuming we",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn is_vague_assent(message: &str) -> bool {
    let normalized: String = message
        .trim()
        .trim_matches(|c: char| c.is_ascii_punctuation())
        .to_lowercase();
    matches!(
        normalized.as_str(),
        "yes"
            | "yeah"
            | "yep"
            | "yup"
            | "no"
            | "nope"
            | "sure"
            | "ok"
            | "okay"
            | "k"
            | "sounds good"
            | "forget that"
            | "never mind"
            | "nevermind"
            | "maybe"
            | "we might decide"
    )
}

fn first_token_is_directiveish(lower: &str) -> bool {
    let token: String = lower
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    matches!(
        token.as_str(),
        "remember" | "constraint" | "decision" | "correct" | "forget" | "accept"
    )
}

fn build_save(
    turn: &PersistedMemoryTurn,
    source: &str,
    payload: &str,
    whole_lower: &str,
) -> UserMemoryOperation {
    let payload = payload.trim();
    if payload.is_empty() {
        return pending("empty_payload");
    }
    if is_hypothetical(&payload.to_lowercase()) || is_hypothetical(whole_lower) {
        return pending("hypothetical_directive");
    }
    UserMemoryOperation::Save {
        draft: MemoryDraft {
            title: truncate_scalars(payload, MAX_TITLE_SCALARS),
            content: payload.to_string(),
            tags: Vec::new(),
            category: category_for_scope(&turn.scope),
            expires_at: None,
            review_after: None,
        },
        source: source.to_string(),
    }
}

fn parse_id_revision(raw: &str) -> Option<(String, i64)> {
    let (id, revision) = raw.trim().rsplit_once('@')?;
    let id = id.trim();
    let revision: i64 = revision.trim().parse().ok()?;
    if id.is_empty() || revision < 1 || id.chars().any(char::is_whitespace) {
        return None;
    }
    Some((id.to_string(), revision))
}

fn slice_after<'a>(message: &'a str, prefix_len: usize) -> &'a str {
    // Directive prefixes are ASCII, so `prefix_len` is a valid byte boundary
    // in the original message regardless of its case.
    message.get(prefix_len..).unwrap_or("")
}

/// Parse exactly one whole trimmed user message. Ordinary conversational text
/// returns `Ok(None)`; malformed, quoted, multiple, hypothetical, or vague
/// directive attempts return `Some(Pending)` with no mutation authority.
pub fn parse_user_memory_operation(
    turn: &PersistedMemoryTurn,
) -> Result<Option<UserMemoryOperation>, MemoryError> {
    let message = turn.user_message.trim();
    if message.is_empty() {
        return Ok(None);
    }
    let lower = message.to_lowercase();

    if directive_segment_count(message) >= 2 {
        return Ok(Some(pending("multiple_directives")));
    }
    if quoted_or_fenced(message) {
        return Ok(if mentions_directive(&lower) {
            Some(pending("quoted_directive"))
        } else {
            None
        });
    }

    if lower.starts_with(PREFIX_SAVE_COLON) {
        return Ok(Some(build_save(
            turn,
            SOURCE_REMEMBER,
            slice_after(message, PREFIX_SAVE_COLON.len()),
            &lower,
        )));
    }
    if lower.starts_with(PREFIX_SAVE_THAT) {
        return Ok(Some(build_save(
            turn,
            SOURCE_REMEMBER,
            slice_after(message, PREFIX_SAVE_THAT.len()),
            &lower,
        )));
    }
    if lower.starts_with(PREFIX_CONSTRAINT) {
        return Ok(Some(build_save(
            turn,
            SOURCE_CONSTRAINT,
            slice_after(message, PREFIX_CONSTRAINT.len()),
            &lower,
        )));
    }
    if lower.starts_with(PREFIX_DECISION) {
        return Ok(Some(build_save(
            turn,
            SOURCE_DECISION,
            slice_after(message, PREFIX_DECISION.len()),
            &lower,
        )));
    }
    if lower.starts_with(PREFIX_CORRECT) {
        let rest = slice_after(message, PREFIX_CORRECT.len());
        let Some((target, payload)) = rest.split_once(':') else {
            return Ok(Some(pending("malformed_directive")));
        };
        let payload = payload.trim();
        if payload.is_empty() {
            return Ok(Some(pending("empty_payload")));
        }
        if is_hypothetical(&payload.to_lowercase()) {
            return Ok(Some(pending("hypothetical_directive")));
        }
        let Some((id, expected_revision)) = parse_id_revision(target) else {
            return Ok(Some(pending("malformed_directive")));
        };
        return Ok(Some(UserMemoryOperation::Correct {
            id,
            expected_revision,
            draft: MemoryDraft {
                title: truncate_scalars(payload, MAX_TITLE_SCALARS),
                content: payload.to_string(),
                tags: Vec::new(),
                category: category_for_scope(&turn.scope),
                expires_at: None,
                review_after: None,
            },
        }));
    }
    if lower.starts_with(PREFIX_FORGET) {
        let rest = slice_after(message, PREFIX_FORGET.len()).trim();
        if rest.contains(':') {
            return Ok(Some(pending("malformed_directive")));
        }
        let Some((id, expected_revision)) = parse_id_revision(rest) else {
            return Ok(Some(pending("malformed_directive")));
        };
        return Ok(Some(UserMemoryOperation::Forget {
            id,
            expected_revision,
        }));
    }
    if lower.starts_with(PREFIX_ACCEPT) {
        let rest = slice_after(message, PREFIX_ACCEPT.len()).trim();
        if rest.is_empty() || rest.chars().any(char::is_whitespace) {
            return Ok(Some(pending("malformed_directive")));
        }
        return Ok(Some(UserMemoryOperation::AcceptProposal {
            id: rest.to_string(),
        }));
    }

    if is_vague_assent(message) {
        return Ok(Some(pending("vague_assent")));
    }
    if first_token_is_directiveish(&lower) {
        return Ok(Some(pending("ambiguous_directive")));
    }

    Ok(None)
}

// ── Canonical hashing ───────────────────────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{:02x}", byte);
    }
    out
}

fn hash_parts(parts: Vec<JsonValue>) -> String {
    let mut canonical = Vec::with_capacity(parts.len() + 1);
    canonical.push(JsonValue::String(CAPTURE_HASH_VERSION.to_string()));
    canonical.extend(parts);
    let serialized = serde_json::to_string(&JsonValue::Array(canonical))
        .unwrap_or_else(|_| "[]".to_string());
    sha256_hex(serialized.as_bytes())
}

fn scope_kind_str(scope: &MemoryScope) -> &'static str {
    match scope.kind {
        MemoryScopeKind::Project => "project",
        MemoryScopeKind::Agent => "agent",
        MemoryScopeKind::User => "user",
        MemoryScopeKind::LegacyUnscoped => "legacy_unscoped",
    }
}

fn scope_parts(scope: &MemoryScope) -> Vec<JsonValue> {
    vec![
        json!(scope_kind_str(scope)),
        json!(scope.agent_id),
        json!(scope.project_root),
    ]
}

fn draft_parts(draft: &MemoryDraft) -> Vec<JsonValue> {
    vec![
        json!(draft.title),
        json!(draft.content),
        json!(draft.tags),
        json!(draft.category),
        json!(draft.expires_at),
        json!(draft.review_after),
    ]
}

fn save_operation_hash(
    scope: &MemoryScope,
    source_message_id: &str,
    message_hash: &str,
    source: &str,
    draft: &MemoryDraft,
) -> String {
    let mut parts = vec![json!("save"), json!(source), json!(source_message_id), json!(message_hash)];
    parts.extend(scope_parts(scope));
    parts.extend(draft_parts(draft));
    hash_parts(parts)
}

fn correct_operation_hash(
    scope: &MemoryScope,
    source_message_id: &str,
    message_hash: &str,
    id: &str,
    expected_revision: i64,
    draft: &MemoryDraft,
) -> String {
    let mut parts = vec![
        json!("correct"),
        json!(source_message_id),
        json!(message_hash),
        json!(id),
        json!(expected_revision),
    ];
    parts.extend(scope_parts(scope));
    parts.extend(draft_parts(draft));
    hash_parts(parts)
}

fn forget_operation_hash(
    scope: &MemoryScope,
    source_message_id: &str,
    message_hash: &str,
    id: &str,
    expected_revision: i64,
    reason: &str,
) -> String {
    let mut parts = vec![
        json!("forget"),
        json!(source_message_id),
        json!(message_hash),
        json!(id),
        json!(expected_revision),
        json!(reason),
    ];
    parts.extend(scope_parts(scope));
    hash_parts(parts)
}

fn accept_operation_hash(
    scope: &MemoryScope,
    source_message_id: &str,
    message_hash: &str,
    proposal_id: &str,
) -> String {
    let mut parts = vec![
        json!("accept_proposal"),
        json!(source_message_id),
        json!(message_hash),
        json!(proposal_id),
    ];
    parts.extend(scope_parts(scope));
    hash_parts(parts)
}

fn manual_correct_operation_hash(
    session_id: &str,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    draft: &MemoryDraft,
) -> String {
    let mut parts = vec![
        json!("manual_correct"),
        json!(session_id),
        json!(id),
        json!(expected_revision),
    ];
    parts.extend(scope_parts(scope));
    parts.extend(draft_parts(draft));
    hash_parts(parts)
}

fn manual_forget_operation_hash(
    session_id: &str,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    reason: &str,
) -> String {
    let mut parts = vec![
        json!("manual_forget"),
        json!(session_id),
        json!(id),
        json!(expected_revision),
        json!(reason),
    ];
    parts.extend(scope_parts(scope));
    hash_parts(parts)
}

fn stage_operation_hash(
    scope: &MemoryScope,
    session_id: &str,
    assistant_message_id: &str,
    assistant_message_hash: &str,
    operation_id: &str,
    draft: &MemoryDraft,
) -> String {
    let mut parts = vec![
        json!("stage_proposal"),
        json!(session_id),
        json!(assistant_message_id),
        json!(assistant_message_hash),
        json!(operation_id),
    ];
    parts.extend(scope_parts(scope));
    parts.extend(draft_parts(draft));
    hash_parts(parts)
}

fn terminal_tuple_hash(turn: &PersistedMemoryTurn) -> String {
    let value = json!({
        "turn_id": turn.turn_id,
        "session_id": turn.session_id,
        "source_message_id": turn.source_message_id,
        "message_hash": turn.message_hash,
        "app_instance_id": turn.app_instance_id,
        "bun_instance_id": turn.bun_instance_id,
        "state": turn.state,
        "recall_status": turn.recall_status,
        "terminal_status": turn.terminal_status,
        "started_at": turn.started_at,
        "finished_at": turn.finished_at,
        "run_id": turn.run_id,
        "applied_selected_ids": turn.applied_selected_ids,
        "runtime_evidence": turn.runtime_evidence,
    });
    sha256_hex(serde_json::to_string(&value).unwrap_or_default().as_bytes())
}

fn operation_payload_hash(
    turn: &PersistedMemoryTurn,
    parsed: &Option<UserMemoryOperation>,
) -> String {
    match parsed {
        None => hash_parts(vec![json!("none")]),
        Some(UserMemoryOperation::Save { draft, source }) => save_operation_hash(
            &turn.scope,
            &turn.source_message_id,
            &turn.message_hash,
            source,
            draft,
        ),
        Some(UserMemoryOperation::Correct {
            id,
            expected_revision,
            draft,
        }) => correct_operation_hash(
            &turn.scope,
            &turn.source_message_id,
            &turn.message_hash,
            id,
            *expected_revision,
            draft,
        ),
        Some(UserMemoryOperation::Forget {
            id,
            expected_revision,
        }) => forget_operation_hash(
            &turn.scope,
            &turn.source_message_id,
            &turn.message_hash,
            id,
            *expected_revision,
            SOURCE_FORGET,
        ),
        Some(UserMemoryOperation::AcceptProposal { id }) => accept_operation_hash(
            &turn.scope,
            &turn.source_message_id,
            &turn.message_hash,
            id,
        ),
        Some(UserMemoryOperation::Pending { reason_code }) => {
            hash_parts(vec![json!("pending"), json!(reason_code)])
        }
    }
}

// ── Operation ledger ────────────────────────────────────────────────────────

struct LedgerRow {
    payload_hash: String,
    response_json: String,
}

fn ledger_get(
    conn: &Connection,
    session_id: &str,
    operation_id: &str,
) -> Result<Option<LedgerRow>, MemoryError> {
    conn.query_row(
        "SELECT payload_hash, response_json FROM memory_operations
         WHERE session_id = ? AND operation_id = ?",
        params![session_id, operation_id],
        |row| {
            Ok(LedgerRow {
                payload_hash: row.get(0)?,
                response_json: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(MemoryError::from)
}

fn ledger_put<T: Serialize>(
    conn: &Connection,
    session_id: &str,
    operation_id: &str,
    payload_hash: &str,
    response: &T,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    let response_json = serde_json::to_string(response)
        .map_err(|_| MemoryError::storage_unavailable("Failed to serialize operation result"))?;
    conn.execute(
        "INSERT INTO memory_operations
             (session_id, operation_id, payload_hash, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, operation_id) DO NOTHING",
        params![session_id, operation_id, payload_hash, response_json, now.to_rfc3339()],
    )
    .map_err(MemoryError::from)?;
    Ok(())
}

fn replay_ledger<T: DeserializeOwned>(
    conn: &Connection,
    session_id: &str,
    operation_id: &str,
    payload_hash: &str,
) -> Result<Option<T>, MemoryError> {
    let Some(row) = ledger_get(conn, session_id, operation_id)? else {
        return Ok(None);
    };
    if row.payload_hash != payload_hash {
        return Err(MemoryError::operation_conflict(
            "Operation identity was reused with a different payload",
        ));
    }
    serde_json::from_str(&row.response_json)
        .map(Some)
        .map_err(|_| MemoryError::storage_unavailable("Corrupt persisted operation result"))
}

// ── Provenance helpers ──────────────────────────────────────────────────────

fn user_statement_provenance(turn: &PersistedMemoryTurn, source: &str) -> MemoryProvenance {
    MemoryProvenance {
        authority_kind: AuthorityKind::UserStatement,
        source: source.to_string(),
        source_session_id: Some(turn.session_id.clone()),
        source_message_ids: vec![turn.source_message_id.clone()],
        source_run_id: None,
        verified_at: None,
    }
}

fn error_code_str(code: MemoryErrorCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "capture_unavailable".to_string())
}

/// Only content-safety admission failures may be reported as a `blocked`
/// operation receipt. Technical/target/revision/storage failures stay errors.
fn is_admission_block(err: &MemoryError) -> bool {
    matches!(
        err.code,
        MemoryErrorCode::InvalidPayload | MemoryErrorCode::InvalidProvenance
    )
}

// ── Transactional mutation bodies (no ledger/savepoint of their own) ────────

/// Insert a replacement that supersedes `target_id` and tombstone the target
/// atomically. The replacement row keeps the exact resolved scope; the
/// relationship points from the new row to the old row.
fn replace_scoped_memory(
    conn: &Connection,
    scope: &MemoryScope,
    target_id: &str,
    expected_revision: i64,
    draft: MemoryDraft,
    provenance: &MemoryProvenance,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<CorrectionResult, MemoryError> {
    let previous = scoped::read_scoped_memory(conn, scope, target_id)?;
    if previous.revision != expected_revision {
        return Err(MemoryError::revision_conflict(
            "Memory revision no longer matches the expected revision",
        ));
    }
    if previous.entry.status == "tombstoned" {
        return Err(MemoryError::operation_conflict(
            "Target memory is already tombstoned",
        ));
    }

    let saved = scoped::save_scoped_memory(conn, scope, draft, provenance, now)?;
    let replacement_id = saved.memory.entry.id.clone();

    conn.execute(
        "UPDATE memory SET supersedes_id = ? WHERE id = ?",
        params![&target_id, &replacement_id],
    )
    .map_err(MemoryError::from)?;

    let replacement = scoped::read_scoped_memory(conn, scope, &replacement_id)?;
    engine::write_memory_event(
        conn,
        Some(&replacement_id),
        "supersede",
        "memory_capture",
        Some(serde_json::to_value(&previous).unwrap_or(JsonValue::Null)),
        Some(serde_json::to_value(&replacement).unwrap_or(JsonValue::Null)),
        "Replacement supersedes previous memory",
        1.0,
        provenance.source_session_id.as_deref(),
    )
    .map_err(MemoryError::storage_unavailable)?;

    let tombstoned = scoped::tombstone_scoped_memory(
        conn,
        scope,
        target_id,
        expected_revision,
        reason,
        now,
    )?;

    // The superseded record's exact source messages must not be replayed from
    // derived prompt state, and any active objective that declared a dependency
    // on it is cleared with an explicit continuity event. Both commit with the
    // replacement/ledger; the replacement's own new user source is NOT
    // suppressed.
    let _ = continuity::suppress_memory_sources(conn, scope, &[target_id.to_string()], now)?;
    let _ =
        continuity::clear_continuity_dependent_on(conn, &[target_id.to_string()], now)?;

    Ok(CorrectionResult {
        previous: tombstoned.memory,
        replacement,
        store_revision: scoped::memory_store_revision(conn)?,
        changed: true,
    })
}

fn correct_scoped_memory_body(
    conn: &Connection,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    draft: MemoryDraft,
    provenance: &MemoryProvenance,
    now: DateTime<Utc>,
) -> Result<CorrectionResult, MemoryError> {
    replace_scoped_memory(
        conn,
        scope,
        id,
        expected_revision,
        draft,
        provenance,
        SOURCE_CORRECTION,
        now,
    )
}

fn forget_scoped_memory_body(
    conn: &Connection,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<ForgetResult, MemoryError> {
    let before = scoped::read_scoped_memory(conn, scope, id)?;
    // The expected revision is validated before the no-op branch so a stale
    // caller cannot be told an unprotected forget succeeded. Exact operation
    // replays are handled by the ledger before this body runs.
    if before.revision != expected_revision {
        return Err(MemoryError::revision_conflict(
            "Memory revision no longer matches the expected revision",
        ));
    }
    if before.entry.status == "tombstoned" {
        // Ensure suppression is established even for a historically tombstoned
        // row, and return the persisted consequence ids for inspectability.
        let suppressed =
            continuity::suppress_memory_sources(conn, scope, &[id.to_string()], now)?;
        let _ = continuity::clear_continuity_dependent_on(conn, &[id.to_string()], now)?;
        return Ok(ForgetResult {
            memory: before,
            store_revision: scoped::memory_store_revision(conn)?,
            changed: false,
            suppressed_message_ids: suppressed,
        });
    }
    let tombstoned =
        scoped::tombstone_scoped_memory(conn, scope, id, expected_revision, reason, now)?;
    let suppressed = continuity::suppress_memory_sources(conn, scope, &[id.to_string()], now)?;
    let _ = continuity::clear_continuity_dependent_on(conn, &[id.to_string()], now)?;
    Ok(ForgetResult {
        memory: tombstoned.memory,
        store_revision: scoped::memory_store_revision(conn)?,
        changed: tombstoned.changed,
        suppressed_message_ids: suppressed,
    })
}

fn acceptance_draft(scope: &MemoryScope, content: &str) -> MemoryDraft {
    MemoryDraft {
        title: truncate_scalars(content, MAX_TITLE_SCALARS),
        content: content.to_string(),
        tags: Vec::new(),
        category: category_for_scope(scope),
        expires_at: None,
        review_after: None,
    }
}

/// Read the stable `(created_at, rowid)` ordering key for one persisted message
/// in a Session. Missing messages return `None`.
fn message_ordering_key(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<Option<(String, i64)>, MemoryError> {
    conn.query_row(
        "SELECT created_at, rowid FROM messages WHERE id = ? AND session_id = ?",
        params![message_id, session_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )
    .optional()
    .map_err(MemoryError::from)
}

/// True when `later_id` strictly follows `earlier_id` by the actual persisted
/// `(created_at, rowid)` order in the same Session.
fn message_is_strictly_after(
    conn: &Connection,
    session_id: &str,
    later_id: &str,
    earlier_id: &str,
) -> Result<bool, MemoryError> {
    let later = message_ordering_key(conn, session_id, later_id)?;
    let earlier = message_ordering_key(conn, session_id, earlier_id)?;
    match (later, earlier) {
        (Some(later), Some(earlier)) => Ok(later > earlier),
        _ => Ok(false),
    }
}

/// Accept one staged assistant proposal. The proposal must exist in the exact
/// turn scope with `assistant_proposal` authority and an exact persisted
/// assistant-message association lineage in the same Session. Acceptance must
/// be strictly later than both the assistant source and the staging turn's user
/// source by actual `(created_at, rowid)` order. It creates a `user_statement`
/// replacement sourced from the current user acceptance message and tombstones
/// the proposal in the same transaction, recording the lineage audit.
fn accept_proposal(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
    proposal_id: &str,
    now: DateTime<Utc>,
) -> Result<CorrectionResult, MemoryError> {
    let proposal = scoped::read_scoped_memory(conn, &turn.scope, proposal_id)?;
    if proposal.authority_kind != AuthorityKind::AssistantProposal {
        return Err(MemoryError::invalid_acceptance(
            "Target is not a staged assistant proposal",
        ));
    }
    if proposal.entry.source_session_id.as_deref() != Some(turn.session_id.as_str()) {
        return Err(MemoryError::invalid_acceptance(
            "Proposal was not staged in this Session",
        ));
    }
    let cited: Vec<String> = serde_json::from_str(&proposal.entry.source_message_ids)
        .unwrap_or_default();
    let assistant_message_id = cited.first().cloned().ok_or_else(|| {
        MemoryError::invalid_acceptance("Proposal has no persisted assistant source message")
    })?;

    // Exact association lineage: the assistant message must be associated to a
    // persisted turn via `memory_turn_messages`, and that staging turn must
    // belong to the same Session and exact scope. Assistant role alone is not
    // sufficient. Until Part 3.3 creates associations, staging is rejected.
    let staging_turn_id: Option<String> = conn
        .query_row(
            "SELECT turn_id FROM memory_turn_messages WHERE message_id = ?",
            [&assistant_message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(MemoryError::from)?;
    let staging_turn_id = staging_turn_id.ok_or_else(|| {
        MemoryError::invalid_acceptance(
            "Proposal assistant message has no persisted turn association",
        )
    })?;
    let staging_turn = turn::read_memory_turn(conn, &turn.session_id, &staging_turn_id)
        .map_err(|_| {
            MemoryError::invalid_acceptance(
                "Proposal staging turn does not belong to this Session",
            )
        })?;
    if staging_turn.scope != turn.scope {
        return Err(MemoryError::invalid_acceptance(
            "Proposal staging turn scope does not match the acceptance scope",
        ));
    }

    let acceptance_message = turn.source_message_id.as_str();
    if !message_is_strictly_after(conn, &turn.session_id, acceptance_message, &assistant_message_id)?
    {
        return Err(MemoryError::invalid_acceptance(
            "Acceptance must be strictly later than the assistant proposal source",
        ));
    }
    if !message_is_strictly_after(
        conn,
        &turn.session_id,
        acceptance_message,
        &staging_turn.source_message_id,
    )? {
        return Err(MemoryError::invalid_acceptance(
            "Acceptance must be strictly later than the staging turn's user source",
        ));
    }

    let provenance = MemoryProvenance {
        authority_kind: AuthorityKind::UserStatement,
        source: SOURCE_ACCEPTED_PROPOSAL.to_string(),
        source_session_id: Some(turn.session_id.clone()),
        source_message_ids: vec![turn.source_message_id.clone()],
        source_run_id: None,
        verified_at: None,
    };
    let draft = acceptance_draft(&turn.scope, &proposal.entry.content);
    replace_scoped_memory(
        conn,
        &turn.scope,
        proposal_id,
        proposal.revision,
        draft,
        &provenance,
        SOURCE_ACCEPTED_PROPOSAL,
        now,
    )
}

fn operation_receipt(
    operation_id: &str,
    status: CaptureOperationStatus,
    memory_id: Option<String>,
    replacement_id: Option<String>,
    reason_code: Option<String>,
) -> CaptureOperationReceipt {
    CaptureOperationReceipt {
        operation_id: operation_id.to_string(),
        status,
        memory_id,
        replacement_id,
        reason_code,
    }
}

fn execute_capture_operation(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
    parsed: &Option<UserMemoryOperation>,
    operation_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<CaptureOperationReceipt>, MemoryError> {
    let Some(operation) = parsed else {
        return Ok(Vec::new());
    };
    match operation {
        UserMemoryOperation::Pending { reason_code } => Ok(vec![operation_receipt(
            operation_id,
            CaptureOperationStatus::Pending,
            None,
            None,
            Some(reason_code.clone()),
        )]),
        UserMemoryOperation::Save { draft, source } => {
            let provenance = user_statement_provenance(turn, source);
            let attempt = scoped::with_memory_savepoint(conn, |conn| {
                scoped::save_scoped_memory(conn, &turn.scope, draft.clone(), &provenance, now)
            });
            match attempt {
                Ok(saved) => Ok(vec![operation_receipt(
                    operation_id,
                    CaptureOperationStatus::Saved,
                    Some(saved.memory.entry.id.clone()),
                    None,
                    None,
                )]),
                Err(err) if is_admission_block(&err) => Ok(vec![operation_receipt(
                    operation_id,
                    CaptureOperationStatus::Blocked,
                    None,
                    None,
                    Some(error_code_str(err.code)),
                )]),
                Err(err) => Err(err),
            }
        }
        UserMemoryOperation::Correct {
            id,
            expected_revision,
            draft,
        } => {
            let provenance = user_statement_provenance(turn, SOURCE_CORRECTION);
            // A nested savepoint guarantees no replacement row or audit event
            // survives a content-safety rejection.
            let attempt = scoped::with_memory_savepoint(conn, |conn| {
                correct_scoped_memory_body(
                    conn,
                    &turn.scope,
                    id,
                    *expected_revision,
                    draft.clone(),
                    &provenance,
                    now,
                )
            });
            match attempt {
                Ok(result) => Ok(vec![operation_receipt(
                    operation_id,
                    CaptureOperationStatus::Corrected,
                    Some(id.clone()),
                    Some(result.replacement.entry.id.clone()),
                    None,
                )]),
                Err(err) if is_admission_block(&err) => Ok(vec![operation_receipt(
                    operation_id,
                    CaptureOperationStatus::Blocked,
                    Some(id.clone()),
                    None,
                    Some(error_code_str(err.code)),
                )]),
                Err(err) => Err(err),
            }
        }
        UserMemoryOperation::Forget {
            id,
            expected_revision,
        } => {
            scoped::with_memory_savepoint(conn, |conn| {
                forget_scoped_memory_body(
                    conn,
                    &turn.scope,
                    id,
                    *expected_revision,
                    SOURCE_FORGET,
                    now,
                )
            })?;
            Ok(vec![operation_receipt(
                operation_id,
                CaptureOperationStatus::Forgotten,
                Some(id.clone()),
                None,
                None,
            )])
        }
        UserMemoryOperation::AcceptProposal { id } => {
            let result = scoped::with_memory_savepoint(conn, |conn| {
                accept_proposal(conn, turn, id, now)
            })?;
            Ok(vec![operation_receipt(
                operation_id,
                CaptureOperationStatus::Corrected,
                Some(id.clone()),
                Some(result.replacement.entry.id.clone()),
                None,
            )])
        }
    }
}

// ── Receipt persistence ─────────────────────────────────────────────────────

struct StoredReceipt {
    session_id: String,
    terminal_hash: Option<String>,
    receipt: CaptureReceipt,
}

fn read_receipt_row(
    conn: &Connection,
    turn_id: &str,
) -> Result<Option<StoredReceipt>, MemoryError> {
    let row = conn
        .query_row(
            "SELECT session_id, terminal_hash, receipt_json
             FROM memory_capture_receipts WHERE turn_id = ?",
            [turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(MemoryError::from)?;
    match row {
        Some((session_id, terminal_hash, receipt_json)) => {
            let receipt = serde_json::from_str(&receipt_json).map_err(|_| {
                MemoryError::storage_unavailable("Corrupt persisted capture receipt")
            })?;
            Ok(Some(StoredReceipt {
                session_id,
                terminal_hash,
                receipt,
            }))
        }
        None => Ok(None),
    }
}

fn write_receipt_row(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
    terminal_hash: Option<&str>,
    receipt: &CaptureReceipt,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    let receipt_json = serde_json::to_string(receipt)
        .map_err(|_| MemoryError::storage_unavailable("Failed to serialize capture receipt"))?;
    conn.execute(
        "INSERT INTO memory_capture_receipts
             (turn_id, session_id, terminal_hash, receipt_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(turn_id) DO UPDATE SET
             terminal_hash = excluded.terminal_hash,
             receipt_json = excluded.receipt_json,
             updated_at = excluded.updated_at",
        params![
            &turn.turn_id,
            &turn.session_id,
            terminal_hash,
            receipt_json,
            now.to_rfc3339()
        ],
    )
    .map_err(MemoryError::from)?;
    Ok(())
}

fn summarize_counts(operations: &[CaptureOperationReceipt]) -> (usize, usize) {
    let saved = operations
        .iter()
        .filter(|op| {
            matches!(
                op.status,
                CaptureOperationStatus::Saved | CaptureOperationStatus::Corrected
            )
        })
        .count();
    let pending = operations
        .iter()
        .filter(|op| matches!(op.status, CaptureOperationStatus::Pending))
        .count();
    (saved, pending)
}

fn build_receipt(
    turn: &PersistedMemoryTurn,
    operations: Vec<CaptureOperationReceipt>,
    store_revision: i64,
    continuity_revision: i64,
) -> CaptureReceipt {
    let (saved_count, pending_count) = summarize_counts(&operations);
    CaptureReceipt {
        turn_id: turn.turn_id.clone(),
        session_id: turn.session_id.clone(),
        terminal_status: turn.terminal_status,
        operations,
        store_revision,
        continuity_revision,
        saved_count,
        pending_count,
    }
}

/// The immutable prepared-snapshot fields that are not covered by the terminal
/// tuple hash: turn/message preparation identity, scope opt-in, effective
/// workspace, store revision, and the exact prepared selection.
fn immutable_snapshot_json(turn: &PersistedMemoryTurn) -> JsonValue {
    json!({
        "preparation_id": turn.preparation_id,
        "include_user_scope": turn.include_user_scope,
        "effective_workspace": turn.effective_workspace,
        "store_revision": turn.store_revision,
        "selected": turn.selected,
        "prepared_at": turn.prepared_at,
        "expires_at": turn.expires_at,
    })
}

/// Load the canonical persisted turn and reject a provided observation that
/// differs from it in any terminal or immutable prepared-snapshot field. The
/// returned canonical turn is the only authority capture may use: a plain
/// helper caller can never supply fabricated terminal evidence, generation,
/// timestamps, or selected ids. A legitimate in-gate race is handled by Part
/// 3.2 re-reading the turn inside the mutation gate before calling this.
fn revalidate_turn_snapshot(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
) -> Result<PersistedMemoryTurn, MemoryError> {
    let persisted = turn::read_memory_turn(conn, &turn.session_id, &turn.turn_id)
        .map_err(|_| MemoryError::operation_conflict("Capture turn identity is not persisted"))?;
    if persisted.session_id != turn.session_id
        || persisted.turn_id != turn.turn_id
        || persisted.source_message_id != turn.source_message_id
        || persisted.user_message != turn.user_message
        || persisted.message_hash != turn.message_hash
        || persisted.scope != turn.scope
        || terminal_tuple_hash(&persisted) != terminal_tuple_hash(turn)
        || immutable_snapshot_json(&persisted) != immutable_snapshot_json(turn)
    {
        return Err(MemoryError::operation_conflict(
            "Provided capture observation does not match the persisted turn",
        ));
    }
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT role, content FROM messages WHERE id = ? AND session_id = ?",
            params![&persisted.source_message_id, &persisted.session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(MemoryError::from)?;
    match row {
        Some((role, content))
            if role == "user" && sha256_hex(content.as_bytes()) == persisted.message_hash =>
        {
            Ok(persisted)
        }
        _ => Err(MemoryError::operation_conflict(
            "Capture source message no longer matches the persisted turn hash",
        )),
    }
}

fn short_hash(hash: &str) -> &str {
    let end = hash.len().min(12);
    &hash[..end]
}

/// Record one bounded, content-free terminal-conflict diagnostic for operator
/// inspection. This runs outside the rolled-back mutation savepoint and never
/// touches the frozen ledger response or the successful receipt. Repeated
/// identical conflicts are not duplicated.
fn record_capture_terminal_conflict(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
    stored_terminal: Option<MemoryTurnTerminalStatus>,
    stored_hash: &str,
    incoming_hash: &str,
) {
    let reason = format!(
        "capture terminal conflict turn={} stored_terminal={:?} incoming_terminal={:?} stored_hash={} incoming_hash={}",
        turn.turn_id,
        stored_terminal,
        turn.terminal_status,
        short_hash(stored_hash),
        short_hash(incoming_hash),
    );
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_events
             WHERE event_type = 'capture_terminal_conflict' AND session_id = ? AND reason = ?)",
            params![&turn.session_id, &reason],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .unwrap_or(false);
    if exists {
        return;
    }
    let _ = engine::write_memory_event(
        conn,
        None,
        "capture_terminal_conflict",
        "memory_capture",
        None,
        None,
        &reason,
        1.0,
        Some(&turn.session_id),
    );
}

// ── Public primitives ───────────────────────────────────────────────────────

/// Commit the explicit user operation recorded on one immutable turn into
/// accepted memory and persist one idempotent capture receipt. The loaded
/// canonical persisted turn supplies scope, provenance, source message, and
/// terminal tuple; the provided `turn` is only an identity/observation claim
/// that must exactly match it. No live caller exists until Part 3.2 installs
/// the derived-state invalidation gate.
pub fn capture_recorded_turn(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
    now: DateTime<Utc>,
) -> Result<CaptureReceipt, MemoryError> {
    // Load and revalidate the canonical persisted observation first; only the
    // canonical turn may supply capture authority.
    let persisted = revalidate_turn_snapshot(conn, turn)?;
    let turn = &persisted;
    let parsed = parse_user_memory_operation(turn)?;
    let operation_id = format!("turn/{}/user/0", turn.turn_id);
    let terminal_hash = terminal_tuple_hash(turn);
    let payload_hash = operation_payload_hash(turn, &parsed);

    // Ledger payload identity is checked before any replay.
    if let Some(row) = ledger_get(conn, &turn.session_id, &operation_id)? {
        if row.payload_hash != payload_hash {
            return Err(MemoryError::operation_conflict(
                "Operation identity was reused with a different capture payload",
            ));
        }
    }

    // A finalized terminal tuple change is rejected and recorded as a
    // non-mutating diagnostic before opening the mutation savepoint. This
    // includes same-terminal changed evidence/timestamps/source.
    let existing = read_receipt_row(conn, &turn.turn_id)?;
    if let Some(stored) = &existing {
        if stored.session_id != turn.session_id {
            return Err(MemoryError::turn_conflict(
                "Capture receipt does not belong to this Session",
            ));
        }
        if let Some(stored_hash) = stored.terminal_hash.as_deref() {
            if stored_hash != terminal_hash {
                record_capture_terminal_conflict(
                    conn,
                    turn,
                    stored.receipt.terminal_status,
                    stored_hash,
                    &terminal_hash,
                );
                return Err(MemoryError::operation_conflict(
                    "Terminal tuple changed after the capture receipt was finalized",
                ));
            }
        }
    }

    scoped::with_memory_savepoint(conn, |conn| {
        if let Some(stored) = read_receipt_row(conn, &turn.turn_id)? {
            if stored.terminal_hash.is_some() {
                // Terminal hash was pre-checked equal: exact terminal replay.
                return Ok(stored.receipt);
            }
            if turn.terminal_status.is_some() {
                // One-time null -> authoritative terminal augmentation. Retains
                // the original mutation revisions; freezes the terminal tuple.
                // The ledger's frozen user-operation response is NOT rewritten.
                let mut augmented = stored.receipt.clone();
                augmented.terminal_status = turn.terminal_status;
                write_receipt_row(conn, turn, Some(&terminal_hash), &augmented, now)?;
                return Ok(augmented);
            }
            // Repeated pre-terminal observation: no-op, no null->null rewrite.
            return Ok(stored.receipt);
        }

        if ledger_get(conn, &turn.session_id, &operation_id)?.is_some() {
            // The operation ledger and its capture receipt are written in one
            // savepoint and must never be observable in isolation. A missing
            // receipt beside an existing ledger row is corrupt storage, not a
            // repairable state; fail closed rather than synthesize authority.
            return Err(MemoryError::storage_unavailable(
                "Capture operation ledger exists without its atomic receipt",
            ));
        }

        let operations = execute_capture_operation(conn, turn, &parsed, &operation_id, now)?;
        let continuity_revision =
            continuity::read_session_continuity(conn, &turn.session_id)?.revision;
        let store_revision = scoped::memory_store_revision(conn)?;
        let receipt = build_receipt(turn, operations, store_revision, continuity_revision);
        let initial_hash = if turn.terminal_status.is_some() {
            Some(terminal_hash.as_str())
        } else {
            None
        };
        write_receipt_row(conn, turn, initial_hash, &receipt, now)?;
        ledger_put(
            conn,
            &turn.session_id,
            &operation_id,
            &payload_hash,
            &receipt,
            now,
        )?;
        Ok(receipt)
    })
}

/// Read the stored capture receipt for one Session/turn without rewriting its
/// recorded revision. A receipt from another Session is not disclosed.
pub fn read_capture_receipt(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<CaptureReceipt>, MemoryError> {
    match read_receipt_row(conn, turn_id)? {
        Some(stored) if stored.session_id == session_id => Ok(Some(stored.receipt)),
        _ => Ok(None),
    }
}

/// Stage an exact assistant-substring proposal. Staging requires an
/// authoritative terminal turn plus an exact persisted `(turn_id,
/// assistant_message_id)` association, and the draft content must be an exact
/// nonempty contiguous substring of that assistant message. The proposal
/// carries `assistant_proposal` authority and is never eligible for recall;
/// only a later exact user acceptance can promote it. Until Part 3.3 creates
/// turn/message associations, staging is rejected truthfully.
pub fn stage_memory_proposal(
    conn: &Connection,
    request: StageProposalRequest,
    now: DateTime<Utc>,
) -> Result<MutationResult, MemoryError> {
    if request.assistant_message_id.trim().is_empty() || request.draft.content.trim().is_empty() {
        return Err(MemoryError::invalid_acceptance(
            "Proposal requires an assistant message and nonempty content",
        ));
    }
    let turn = turn::read_memory_turn(conn, &request.session_id, &request.turn_id)?;

    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT role, content FROM messages WHERE id = ? AND session_id = ?",
            params![&request.assistant_message_id, &request.session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(MemoryError::from)?;
    let (role, content) = row.ok_or_else(|| {
        MemoryError::invalid_acceptance("Assistant message is not persisted in this Session")
    })?;
    if role != "assistant" {
        return Err(MemoryError::invalid_acceptance(
            "Proposal source must be a persisted assistant message",
        ));
    }
    if !content.contains(&request.draft.content) {
        return Err(MemoryError::invalid_acceptance(
            "Proposal content must be an exact contiguous substring of the assistant message",
        ));
    }

    // Staging requires an authoritative terminal turn and an exact persisted
    // turn/message association. There is no permissive unmapped fallback:
    // until Part 3.3 creates associations, staging is rejected truthfully.
    if turn.terminal_status.is_none() {
        return Err(MemoryError::invalid_acceptance(
            "Proposal can only be staged from an authoritative terminal turn",
        ));
    }
    let associated: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_turn_messages
             WHERE turn_id = ? AND message_id = ?)",
            params![&request.turn_id, &request.assistant_message_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(MemoryError::from)?;
    if !associated {
        return Err(MemoryError::invalid_acceptance(
            "Assistant message is not associated with this persisted turn",
        ));
    }

    let assistant_hash = sha256_hex(content.as_bytes());
    let payload_hash = stage_operation_hash(
        &turn.scope,
        &request.session_id,
        &request.assistant_message_id,
        &assistant_hash,
        &request.operation_id,
        &request.draft,
    );
    let operation_id = request.operation_id.clone();
    let session_id = request.session_id.clone();
    let scope = turn.scope.clone();
    let provenance = MemoryProvenance {
        authority_kind: AuthorityKind::AssistantProposal,
        source: "assistant_proposal".to_string(),
        source_session_id: Some(session_id.clone()),
        source_message_ids: vec![request.assistant_message_id.clone()],
        source_run_id: None,
        verified_at: None,
    };
    let draft = request.draft;

    scoped::with_memory_savepoint(conn, |conn| {
        if let Some(prior) =
            replay_ledger::<MutationResult>(conn, &session_id, &operation_id, &payload_hash)?
        {
            return Ok(prior);
        }
        let saved = scoped::save_scoped_memory(conn, &scope, draft, &provenance, now)?;
        ledger_put(
            conn,
            &session_id,
            &operation_id,
            &payload_hash,
            &saved,
            now,
        )?;
        Ok(saved)
    })
}

/// Atomically replace one exact scoped record: the replacement points
/// `supersedes_id` at the old row, the old row is tombstoned, its exact source
/// messages are suppressed, any active objective that declared a dependency on
/// it is cleared, and the operation ledger records the original result.
#[allow(clippy::too_many_arguments)]
pub fn correct_scoped_memory(
    conn: &Connection,
    session_id: &str,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    draft: MemoryDraft,
    provenance: &MemoryProvenance,
    operation_id: &str,
    now: DateTime<Utc>,
) -> Result<CorrectionResult, MemoryError> {
    let payload_hash = manual_correct_operation_hash(
        session_id,
        scope,
        id,
        expected_revision,
        &draft,
    );
    scoped::with_memory_savepoint(conn, |conn| {
        if let Some(prior) = replay_ledger::<CorrectionResult>(
            conn,
            session_id,
            operation_id,
            &payload_hash,
        )? {
            return Ok(prior);
        }
        let result = correct_scoped_memory_body(
            conn,
            scope,
            id,
            expected_revision,
            draft,
            provenance,
            now,
        )?;
        ledger_put(conn, session_id, operation_id, &payload_hash, &result, now)?;
        Ok(result)
    })
}

/// Tombstone one exact scoped record without fuzzy matching, suppress its
/// source messages, and record the original result in the operation ledger.
#[allow(clippy::too_many_arguments)]
pub fn forget_scoped_memory(
    conn: &Connection,
    session_id: &str,
    scope: &MemoryScope,
    id: &str,
    expected_revision: i64,
    reason: &str,
    operation_id: &str,
    now: DateTime<Utc>,
) -> Result<ForgetResult, MemoryError> {
    let payload_hash =
        manual_forget_operation_hash(session_id, scope, id, expected_revision, reason);
    scoped::with_memory_savepoint(conn, |conn| {
        if let Some(prior) =
            replay_ledger::<ForgetResult>(conn, session_id, operation_id, &payload_hash)?
        {
            return Ok(prior);
        }
        let result =
            forget_scoped_memory_body(conn, scope, id, expected_revision, reason, now)?;
        ledger_put(conn, session_id, operation_id, &payload_hash, &result, now)?;
        Ok(result)
    })
}
