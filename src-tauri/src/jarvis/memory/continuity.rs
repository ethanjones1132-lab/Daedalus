// ═══════════════════════════════════════════════════════════════
// Native Session Continuity — structured objective + source suppression
// ═══════════════════════════════════════════════════════════════
//
// Phase 3.1 owns the continuity read model and the source-suppression
// persistence helper. Continuity WRITES are gated in Part 3.4; until then the
// read helper returns the stored revision or the default revision 1, and the
// legacy `session_memory.current_goal/summary/decisions` fields are never read
// into typed continuity.
//
// Suppression records exact (Session, message, memory) ids whose source
// instructions must not be replayed from derived prompt state. The visible
// operator transcript is untouched.

use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use super::capture_contracts::{
    ActiveObjective, ContinuityMode, ContinuityPreview, ContinuitySetRequest,
    MemoryDerivedInvalidation, SessionContinuity,
};
use super::contracts::{MemoryError, MemoryScope, MemoryScopeKind};
use super::turn::{MemoryTurnTerminalStatus, PersistedMemoryTurn, PreparedMemorySelection};
use super::{capture, engine, scoped};

/// Durable outbox row reconstructed during a drain. The namespaced
/// `operation_id` key is rebuilt from the owning Session when it is sent.
#[derive(Debug, Clone)]
pub struct PendingDerivedInvalidation {
    pub session_id: String,
    pub invalidation: MemoryDerivedInvalidation,
    /// Internal routing metadata persisted alongside the frozen four-field
    /// invalidation; never sent on the wire.
    pub scope: Option<MemoryScope>,
}

const MEMORY_SOURCE_REMOVED: &str = "[Memory source removed]";

pub fn source_removed_marker() -> &'static str {
    MEMORY_SOURCE_REMOVED
}

/// Read the structured continuity for one Session. A Session with no typed
/// continuity yet reports the default revision 1 with no active objective.
/// Legacy summary/current_goal values are deliberately ignored.
pub fn read_session_continuity(
    conn: &Connection,
    session_id: &str,
) -> Result<SessionContinuity, MemoryError> {
    let row: Option<(Option<String>, Option<String>, i64)> = conn
        .query_row(
            "SELECT active_objective_json, latest_turn_id, revision
             FROM session_continuity WHERE session_id = ?",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(MemoryError::from)?;

    match row {
        Some((Some(objective_json), latest_turn_id, revision)) => {
            let objective: ActiveObjective = serde_json::from_str(&objective_json).map_err(|_| {
                MemoryError::storage_unavailable("Corrupt persisted continuity objective")
            })?;
            Ok(SessionContinuity {
                session_id: session_id.to_string(),
                active_objective: Some(objective),
                latest_turn_id,
                revision,
            })
        }
        Some((None, latest_turn_id, revision)) => Ok(SessionContinuity {
            session_id: session_id.to_string(),
            active_objective: None,
            latest_turn_id,
            revision,
        }),
        None => Ok(SessionContinuity {
            session_id: session_id.to_string(),
            active_objective: None,
            latest_turn_id: None,
            revision: 1,
        }),
    }
}

// ── Phase 3.4 explicit objective continuity ─────────────────────────────────
//
// Objective state is controlled only by exact whole-message directives read
// from the immutable saved user source. Ordinary text, corrections, questions,
// failures, and assistant suggestions never replace or advance it. Preparation
// previews an action ephemerally; only post-turn capture (or the explicit
// gated setter) commits durable state.

const CLEAR_DIRECTIVE: &str = "Clear active objective";
const RESUME_DIRECTIVE: &str = "Continue active objective";
const OBJECTIVE_PREFIX: &str = "Objective:";
/// Bounded, wire-safe length for an operator continuity operation id.
const MAX_OPERATION_ID_LEN: usize = 200;

/// True when a public continuity operation id is nonempty, bounded, and safe in
/// the native `session/<id>/operation/<id>` wire grammar: printable, no control
/// characters, and no path/namespace separator (`/`, `\`). Rejecting an unsafe
/// id BEFORE replay/cleanup prevents persisting an undrainable outbox payload
/// and prevents a caller from controlling the wire namespace.
fn valid_continuity_operation_id(operation_id: &str) -> bool {
    !operation_id.is_empty()
        && operation_id.chars().count() <= MAX_OPERATION_ID_LEN
        && operation_id
            .chars()
            .all(|c| !c.is_control() && c != '/' && c != '\\')
}
/// Content-safety boundary for a replacement objective, byte-identical to the
/// scoped-memory content boundary.
const MAX_OBJECTIVE_BYTES: usize = 4096;

/// Parsed exact objective directive. `Invalid` leaves durable continuity
/// unchanged; it exists so the capture path can record a bounded observable
/// rejection without inventing authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectiveDirective {
    Preserve,
    Resume,
    Replace(String),
    Clear,
    Invalid(String),
}

/// Parse only exact whole-message objective controls from the persisted user
/// source. No case folding, keyword search, assistant text, or suffix trimming:
/// for `Objective: <text>` the exact remaining raw bytes after the mandatory
/// `Objective: ` delimiter are preserved verbatim (including meaningful leading
/// or trailing whitespace). The payload may contain whitespace but must not be
/// whitespace-only. `Clear active objective` and `Continue active objective`
/// are matched as the exact whole saved message.
pub fn parse_objective_directive(source: &str) -> ObjectiveDirective {
    if source == CLEAR_DIRECTIVE {
        return ObjectiveDirective::Clear;
    }
    if source == RESUME_DIRECTIVE {
        return ObjectiveDirective::Resume;
    }
    let Some(rest) = source.strip_prefix(OBJECTIVE_PREFIX) else {
        return ObjectiveDirective::Preserve;
    };
    let Some(payload) = rest.strip_prefix(' ') else {
        return ObjectiveDirective::Invalid("malformed_objective".to_string());
    };
    if payload.trim().is_empty() {
        return ObjectiveDirective::Invalid("empty_objective".to_string());
    }
    if payload.as_bytes().len() > MAX_OBJECTIVE_BYTES {
        return ObjectiveDirective::Invalid("objective_too_large".to_string());
    }
    ObjectiveDirective::Replace(payload.to_string())
}

/// The `(created_at, rowid)` ordering key for one persisted message in a
/// Session, or `None` when the row is gone. Used to prove an older recorded
/// directive cannot undo a later explicitly accepted objective/clear.
fn message_order_key(
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

/// The highest `(created_at, rowid)` order key among all persisted messages of
/// this Session (user and assistant), or `None` when the Session has no message
/// rows. This is the exact "latest User order at call" the manual boundary
/// freezes.
fn latest_source_order_key(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, i64)>, MemoryError> {
    conn.query_row(
        "SELECT created_at, rowid FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
        [session_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
    )
    .optional()
    .map_err(MemoryError::from)
}

/// Validate one persisted internal ordering key. A present highwater must carry
/// a nonempty, parseable RFC3339 timestamp and a strictly positive rowid; a
/// partially or corruptly written cursor/boundary fails closed (Err) rather than
/// silently widening or dropping staleness protection.
fn validate_order_key(created_at: &str, rowid: i64) -> Result<(), MemoryError> {
    if created_at.trim().is_empty()
        || DateTime::parse_from_rfc3339(created_at).is_err()
        || rowid <= 0
    {
        return Err(MemoryError::storage_unavailable(
            "Corrupt persisted continuity ordering key",
        ));
    }
    Ok(())
}

/// A durable `(created_at, rowid)` highwater read from two internal cursor
/// columns. `Err` on a partially-written boundary (one column present without
/// the other), so corrupt metadata fails closed rather than silently widening
/// or dropping staleness protection.
fn read_highwater(
    conn: &Connection,
    session_id: &str,
    created_col: &str,
    rowid_col: &str,
) -> Result<Option<(String, i64)>, MemoryError> {
    let sql = format!(
        "SELECT {created_col}, {rowid_col} FROM session_continuity WHERE session_id = ?"
    );
    let row: Option<(Option<String>, Option<i64>)> = conn
        .query_row(&sql, [session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(MemoryError::from)?;
    match row {
        None => Ok(None),
        Some((None, None)) => Ok(None),
        Some((Some(created_at), Some(rowid))) => {
            validate_order_key(&created_at, rowid)?;
            Ok(Some((created_at, rowid)))
        }
        Some(_) => Err(MemoryError::storage_unavailable(format!(
            "Corrupt persisted continuity highwater ({created_col})"
        ))),
    }
}

/// Read the previous action cursor including its recorded source id. All three
/// cursor columns present with a nonempty source id is a complete cursor; all
/// three NULL is the legitimate pre-Part-3.4 old row (no cursor). ANY partial
/// set, or a present ordering key with an empty/absent source id, fails closed
/// so corruption cannot silently drop staleness protection.
fn read_action_cursor(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(Option<String>, String, i64)>, MemoryError> {
    let row: Option<(Option<String>, Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT last_action_source_message_id, last_action_created_at, last_action_rowid
             FROM session_continuity WHERE session_id = ?",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(MemoryError::from)?;
    match row {
        None => Ok(None),
        // The whole old row: no cursor columns at all is legitimate.
        Some((None, None, None)) => Ok(None),
        Some((Some(source), Some(created_at), Some(rowid))) => {
            if source.trim().is_empty() {
                return Err(MemoryError::storage_unavailable(
                    "Corrupt persisted continuity action cursor (empty source id)",
                ));
            }
            validate_order_key(&created_at, rowid)?;
            Ok(Some((Some(source), created_at, rowid)))
        }
        // Any other combination (partial set, key without source, source
        // without key) is corrupt and must not fail open.
        Some(_) => Err(MemoryError::storage_unavailable(
            "Corrupt persisted continuity action cursor",
        )),
    }
}

/// Monotonic maximum of two `(created_at, rowid)` order keys. `rowid` is only a
/// tie-breaker within one timestamp, so lexicographic timestamp comparison (the
/// same relation `directive_is_stale` uses) is authoritative.
fn max_order_key(
    a: Option<(String, i64)>,
    b: Option<(String, i64)>,
) -> Option<(String, i64)> {
    match (a, b) {
        (Some(a), Some(b)) => Some(if a >= b { a } else { b }),
        (Some(a), None) => Some(a),
        (None, b) => b,
    }
}

/// The durable order key of the LAST accepted objective action (replace, clear,
/// or explicit operator set). Read from the internal cursor columns, which
/// survive a later clear (objective NULL) and removal of the recorded source
/// row. A row created before Part 3.4 (cursor columns NULL) falls back to the
/// active objective's source row when one still exists.
fn action_order_cursor(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, i64)>, MemoryError> {
    // Use the FULLY validated cursor read (all three columns, nonempty source),
    // so preview/resolve/gate/commit/read/write all share one policy and a
    // source-id-only corruption fails closed rather than falling back.
    if let Some((_, created_at, rowid)) = read_action_cursor(conn, session_id)? {
        return Ok(Some((created_at, rowid)));
    }
    let current = read_session_continuity(conn, session_id)?;
    match current.active_objective {
        Some(objective) => message_order_key(conn, session_id, &objective.source_message_id),
        None => Ok(None),
    }
}

/// The durable manual-operator highwater boundary, or `None` when no manual set
/// has occurred (or a pre-Part-3.4 row lacks the columns).
fn manual_boundary(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, i64)>, MemoryError> {
    read_highwater(
        conn,
        session_id,
        "manual_boundary_created_at",
        "manual_boundary_rowid",
    )
}

/// The single staleness policy shared by preview, resolve, cleanup planning and
/// commit. A directive is stale when it is at OR BEFORE the last automatic
/// objective action (a later objective/clear is already accepted) or at OR
/// BEFORE a manual operator boundary (a manual choice may have deliberately
/// picked an older source, and every source already recorded at that call is
/// protected). A missing directive source row has no provable ordering, so it
/// fails closed: the directive is treated as stale and never applied as a new
/// current objective.
pub(crate) fn directive_is_stale(
    conn: &Connection,
    session_id: &str,
    directive_source_message_id: &str,
) -> Result<bool, MemoryError> {
    let Some(directive_key) = message_order_key(conn, session_id, directive_source_message_id)?
    else {
        return Ok(true);
    };
    if let Some(boundary) = manual_boundary(conn, session_id)? {
        if directive_key <= boundary {
            return Ok(true);
        }
    }
    if let Some(cursor) = action_order_cursor(conn, session_id)? {
        if directive_key <= cursor {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Build the effective (ephemeral) continuity snapshot for one turn without
/// touching durable state. `None` means the private envelope omits continuity
/// entirely: an ordinary message with no active objective and no objective
/// action. A stale automatic replacement/clear previews `preserve` with the
/// currently accepted snapshot and is never shown as a current replacement.
pub fn preview_turn_continuity(
    conn: &Connection,
    session_id: &str,
    source_message_id: &str,
    turn_id: &str,
    source_text: &str,
) -> Result<Option<ContinuityPreview>, MemoryError> {
    let current = read_session_continuity(conn, session_id)?;
    let directive = parse_objective_directive(source_text);
    let stale = matches!(
        &directive,
        ObjectiveDirective::Replace(_) | ObjectiveDirective::Clear
    ) && directive_is_stale(conn, session_id, source_message_id)?;
    Ok(preview_from(
        &current,
        source_message_id,
        turn_id,
        directive,
        stale,
    ))
}

fn preview_from(
    current: &SessionContinuity,
    source_message_id: &str,
    turn_id: &str,
    directive: ObjectiveDirective,
    stale: bool,
) -> Option<ContinuityPreview> {
    if stale {
        current.active_objective.as_ref()?;
        return Some(ContinuityPreview {
            snapshot: current.clone(),
            mode: ContinuityMode::Preserve,
        });
    }
    let mut snapshot = current.clone();
    match directive {
        ObjectiveDirective::Preserve | ObjectiveDirective::Invalid(_) => {
            current.active_objective.as_ref()?;
            Some(ContinuityPreview {
                snapshot,
                mode: ContinuityMode::Preserve,
            })
        }
        ObjectiveDirective::Resume => {
            current.active_objective.as_ref()?;
            Some(ContinuityPreview {
                snapshot,
                mode: ContinuityMode::Resume,
            })
        }
        ObjectiveDirective::Replace(text) => {
            snapshot.active_objective = Some(ActiveObjective {
                text,
                source_message_id: source_message_id.to_string(),
                source_turn_id: Some(turn_id.to_string()),
                depends_on_memory_ids: Vec::new(),
            });
            snapshot.latest_turn_id = Some(turn_id.to_string());
            Some(ContinuityPreview {
                snapshot,
                mode: ContinuityMode::Replace,
            })
        }
        ObjectiveDirective::Clear => {
            snapshot.active_objective = None;
            snapshot.latest_turn_id = Some(turn_id.to_string());
            Some(ContinuityPreview {
                snapshot,
                mode: ContinuityMode::Clear,
            })
        }
    }
}

/// The truthful durable effect of the exact objective directive recorded on one
/// turn. Used to build the single automatic capture operation receipt: resume
/// and preserve produce no new operation; a stale older directive is observable
/// but changes nothing; a malformed directive is a bounded pending rejection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectiveCommit {
    None,
    Saved,
    Cleared,
    Stale,
    Malformed(String),
}

/// Classify the exact objective action for one immutable turn, including the
/// durable staleness comparison. Never writes.
pub fn resolve_objective_commit(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
) -> Result<ObjectiveCommit, MemoryError> {
    let directive = parse_objective_directive(&turn.user_message);
    let stale = match &directive {
        ObjectiveDirective::Replace(_) | ObjectiveDirective::Clear => {
            directive_is_stale(conn, &turn.session_id, &turn.source_message_id)?
        }
        _ => false,
    };
    Ok(match directive {
        ObjectiveDirective::Preserve | ObjectiveDirective::Resume => ObjectiveCommit::None,
        ObjectiveDirective::Invalid(reason) => ObjectiveCommit::Malformed(reason),
        ObjectiveDirective::Replace(_) if !stale => ObjectiveCommit::Saved,
        ObjectiveDirective::Clear if !stale => ObjectiveCommit::Cleared,
        ObjectiveDirective::Replace(_) | ObjectiveDirective::Clear => ObjectiveCommit::Stale,
    })
}

/// Upsert the durable continuity row and return the persisted result. The
/// first real write is revision 2 (the no-row default is revision 1), and every
/// write advances the revision so stale preparations are invalidated. A missing
/// objective persists `NULL` (an explicit clear), never a fabricated source.
/// `action_source_message_id` records the internal order cursor of the accepted
/// action so a delayed older directive (including one after a later clear) can
/// be rejected even if the source row is later removed. `set_manual_boundary`
/// additionally freezes the manual-operator highwater at the latest message
/// order currently present, so a manual choice of an older source cannot be
/// undone by any already-recorded automatic directive (including one with the
/// same source order). Both persisted ordering keys are MONOTONIC: a write can
/// never lower a previously recorded action cursor or manual boundary, even
/// when it chooses an old source or the newest message rows were deleted.
fn write_session_continuity(
    conn: &Connection,
    session_id: &str,
    objective: Option<&ActiveObjective>,
    latest_turn_id: Option<&str>,
    action_source_message_id: Option<&str>,
    set_manual_boundary: bool,
    now: DateTime<Utc>,
) -> Result<SessionContinuity, MemoryError> {
    let objective_json = match objective {
        Some(objective) => Some(serde_json::to_string(objective).map_err(|_| {
            MemoryError::storage_unavailable("Failed to serialize continuity objective")
        })?),
        None => None,
    };
    let previous_cursor = read_action_cursor(conn, session_id)?;
    let previous_boundary = read_highwater(
        conn,
        session_id,
        "manual_boundary_created_at",
        "manual_boundary_rowid",
    )?;
    let candidate_cursor = match action_source_message_id {
        Some(source_message_id) => message_order_key(conn, session_id, source_message_id)?
            .map(|(created_at, rowid)| (Some(source_message_id.to_string()), created_at, rowid)),
        None => None,
    };
    // Monotonic action cursor: advance only to a strictly newer source, never
    // rewind to an older chosen source or drop the cursor when the source row
    // was deleted.
    let action_cursor: Option<(Option<String>, String, i64)> =
        match (previous_cursor, candidate_cursor) {
            (Some(prev), Some(cand)) => {
                if (cand.1.clone(), cand.2) > (prev.1.clone(), prev.2) {
                    Some(cand)
                } else {
                    Some(prev)
                }
            }
            (Some(prev), None) => Some(prev),
            (None, cand) => cand,
        };
    let (cursor_source, cursor_created_at, cursor_rowid) = match action_cursor {
        Some((source, created_at, rowid)) => (source, Some(created_at), Some(rowid)),
        None => (None, None, None),
    };
    // Monotonic manual boundary: a manual set after newer rows were removed
    // must not lower the protected highwater.
    let candidate_boundary = if set_manual_boundary {
        latest_source_order_key(conn, session_id)?
    } else {
        None
    };
    let (boundary_created_at, boundary_rowid) =
        match max_order_key(previous_boundary, candidate_boundary) {
            Some((created_at, rowid)) => (Some(created_at), Some(rowid)),
            None => (None, None),
        };
    conn.execute(
        "INSERT INTO session_continuity
             (session_id, active_objective_json, latest_turn_id, revision, updated_at,
              last_action_source_message_id, last_action_created_at, last_action_rowid,
              manual_boundary_created_at, manual_boundary_rowid)
         VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
             active_objective_json = excluded.active_objective_json,
             latest_turn_id = excluded.latest_turn_id,
             revision = session_continuity.revision + 1,
             updated_at = excluded.updated_at,
             last_action_source_message_id = excluded.last_action_source_message_id,
             last_action_created_at = excluded.last_action_created_at,
             last_action_rowid = excluded.last_action_rowid,
             manual_boundary_created_at = excluded.manual_boundary_created_at,
             manual_boundary_rowid = excluded.manual_boundary_rowid",
        params![
            session_id,
            objective_json,
            latest_turn_id,
            now.to_rfc3339(),
            cursor_source,
            cursor_created_at,
            cursor_rowid,
            boundary_created_at,
            boundary_rowid,
        ],
    )
    .map_err(MemoryError::from)?;
    read_session_continuity(conn, session_id)
}

/// Write one mandatory continuity audit event inside the caller's savepoint. A
/// failed audit write propagates and rolls the whole continuity/receipt/ledger
/// transaction back: an accepted objective change is never observable without
/// its audit.
fn write_continuity_audit(
    conn: &Connection,
    event_type: &str,
    session_id: &str,
    before: Option<serde_json::Value>,
    after: Option<serde_json::Value>,
    reason: &str,
) -> Result<(), MemoryError> {
    engine::write_memory_event(
        conn,
        None,
        event_type,
        "memory_capture",
        before,
        after,
        reason,
        1.0,
        Some(session_id),
    )
    .map_err(MemoryError::storage_unavailable)
}

/// Commit the exact objective action recorded on one immutable turn. Runs
/// inside the capture savepoint (same outer transaction as receipt/ledger) and
/// never opens its own ledger or mutation gate. An older directive that would
/// undo a strictly later accepted objective/clear is recorded as stale and
/// leaves durable state untouched. `resume` and `preserve` NEVER rewrite native
/// objective state or advance the revision; `resume` is a Bun continuation mode
/// and is recorded as an audit only.
pub fn apply_turn_continuity(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
    now: DateTime<Utc>,
) -> Result<SessionContinuity, MemoryError> {
    let current = read_session_continuity(conn, &turn.session_id)?;
    match parse_objective_directive(&turn.user_message) {
        ObjectiveDirective::Preserve => Ok(current),
        ObjectiveDirective::Invalid(reason) => {
            write_continuity_audit(
                conn,
                "continuity_directive_invalid",
                &turn.session_id,
                None,
                None,
                &format!("Rejected malformed objective directive: {reason}"),
            )?;
            Ok(current)
        }
        ObjectiveDirective::Resume => {
            if current.active_objective.is_none() {
                return Ok(current);
            }
            write_continuity_audit(
                conn,
                "continuity_resume",
                &turn.session_id,
                Some(json!(current.active_objective)),
                Some(json!(current.active_objective)),
                "Active objective resumed for the current turn; stored objective preserved",
            )?;
            Ok(current)
        }
        ObjectiveDirective::Replace(text) => {
            if directive_is_stale(conn, &turn.session_id, &turn.source_message_id)? {
                write_continuity_audit(
                    conn,
                    "continuity_directive_stale",
                    &turn.session_id,
                    Some(json!(current.active_objective)),
                    None,
                    "Ignored older objective directive; a later objective action is already accepted",
                )?;
                return Ok(current);
            }
            let objective = ActiveObjective {
                text,
                source_message_id: turn.source_message_id.clone(),
                source_turn_id: Some(turn.turn_id.clone()),
                depends_on_memory_ids: Vec::new(),
            };
            let updated = write_session_continuity(
                conn,
                &turn.session_id,
                Some(&objective),
                Some(&turn.turn_id),
                Some(&turn.source_message_id),
                false,
                now,
            )?;
            write_continuity_audit(
                conn,
                "continuity_set",
                &turn.session_id,
                Some(json!(current.active_objective)),
                Some(json!(updated.active_objective)),
                "Active objective replaced from exact saved user source",
            )?;
            Ok(updated)
        }
        ObjectiveDirective::Clear => {
            if directive_is_stale(conn, &turn.session_id, &turn.source_message_id)? {
                write_continuity_audit(
                    conn,
                    "continuity_directive_stale",
                    &turn.session_id,
                    Some(json!(current.active_objective)),
                    None,
                    "Ignored older clear directive; a later objective action is already accepted",
                )?;
                return Ok(current);
            }
            let updated = write_session_continuity(
                conn,
                &turn.session_id,
                None,
                Some(&turn.turn_id),
                Some(&turn.source_message_id),
                false,
                now,
            )?;
            write_continuity_audit(
                conn,
                "continuity_clear",
                &turn.session_id,
                Some(json!(current.active_objective)),
                None,
                "Active objective cleared from exact saved user source",
            )?;
            Ok(updated)
        }
    }
}

/// Load the exact persisted source user message owned by this Session for the
/// explicit continuity setter. A missing row, a non-user role, or a foreign
/// Session is a typed failure; assistant text can never be objective source.
fn load_source_user_content(
    conn: &Connection,
    session_id: &str,
    source_message_id: &str,
) -> Result<String, MemoryError> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT role, content FROM messages WHERE id = ? AND session_id = ?",
            params![source_message_id, session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(MemoryError::from)?;
    let (role, content) = row.ok_or_else(|| {
        MemoryError::invalid_payload("Objective source message is not persisted in this Session")
    })?;
    if role != "user" {
        return Err(MemoryError::invalid_payload(
            "Objective source must be a persisted user-role message",
        ));
    }
    Ok(content)
}

/// Validate an explicit continuity set against expected revision and exact
/// persisted source. Read-only: the durable write and ledger happen inside the
/// gated mutation.
pub fn validate_continuity_set(
    conn: &Connection,
    request: &ContinuitySetRequest,
) -> Result<(), MemoryError> {
    if !valid_continuity_operation_id(&request.operation_id) {
        return Err(MemoryError::invalid_payload(
            "Continuity operation id must be a bounded, wire-safe, nonempty id",
        ));
    }
    if request.expected_revision < 1 {
        return Err(MemoryError::invalid_payload(
            "Continuity expected revision must be positive",
        ));
    }
    let current = read_session_continuity(conn, &request.session_id)?;
    if current.revision != request.expected_revision {
        return Err(MemoryError::revision_conflict(
            "Continuity revision no longer matches the expected revision",
        ));
    }
    let source = load_source_user_content(conn, &request.session_id, &request.source_message_id)?;
    match &request.objective {
        Some(text) => {
            if text.trim().is_empty() || !source.contains(text) {
                return Err(MemoryError::invalid_payload(
                    "Objective must be a nonempty exact substring of the saved user source",
                ));
            }
            if text.as_bytes().len() > MAX_OBJECTIVE_BYTES {
                return Err(MemoryError::invalid_payload(
                    "Objective exceeds the content-safety boundary",
                ));
            }
        }
        None => {
            if source != CLEAR_DIRECTIVE {
                return Err(MemoryError::invalid_payload(
                    "Clear requires the exact saved user content `Clear active objective`",
                ));
            }
        }
    }
    Ok(())
}

/// Canonical payload hash for the explicit setter. Includes the EXACT persisted
/// user source bytes so a deleted/role-changed/edited source can never replay a
/// previously saved objective. `source` is `None` only when the source row is
/// missing or no longer user-role; that sentinel can never match a stored hash,
/// so any existing ledger row becomes an observable `operation_conflict`.
fn continuity_operation_hash(request: &ContinuitySetRequest, source: Option<&str>) -> String {
    capture::hash_parts(vec![
        json!("set_session_continuity"),
        json!(request.session_id),
        json!(request.expected_revision),
        json!(request.source_message_id),
        json!(request.objective),
        json!(request.operation_id),
        json!(source),
    ])
}

/// Exact canonical replay for the explicit continuity setter. Loads and
/// revalidates the exact same-Session persisted USER source first (without
/// checking the expected revision), then replays only when the stored hash
/// matches. `None` when no ledger row exists; a same-identity/different-payload
/// retry is `operation_conflict`. Never writes and never submits to the
/// mutation.
pub fn replay_session_continuity_set(
    conn: &Connection,
    request: &ContinuitySetRequest,
) -> Result<Option<SessionContinuity>, MemoryError> {
    // Validate the wire-safe operation id BEFORE any ledger replay/cleanup. An
    // unsafe id must never reach the ledger lookup or the derived gate; the
    // expected revision remains a NEW-operation-only check.
    if !valid_continuity_operation_id(&request.operation_id) {
        return Err(MemoryError::invalid_payload(
            "Continuity operation id must be a bounded, wire-safe, nonempty id",
        ));
    }
    let source = load_source_user_content(conn, &request.session_id, &request.source_message_id);
    let payload_hash = continuity_operation_hash(request, source.as_deref().ok());
    capture::replay_ledger::<SessionContinuity>(
        conn,
        &request.session_id,
        &request.operation_id,
        &payload_hash,
    )
}

/// Explicit operator continuity set. Revalidates the exact persisted user
/// source and (for a NEW operation only) the expected revision, then atomically
/// persists the objective/clear and records the original response in the
/// Session operation ledger. The caller holds the Phase 3.2 derived mutation
/// gate; this helper opens only a nested savepoint.
pub fn set_session_continuity(
    conn: &Connection,
    request: ContinuitySetRequest,
    now: DateTime<Utc>,
) -> Result<SessionContinuity, MemoryError> {
    // Validate the wire-safe operation id BEFORE any ledger replay/cleanup so an
    // unsafe id can never be persisted into the `session/<id>/operation/<id>`
    // wire namespace. The expected revision stays NEW-operation-only.
    if !valid_continuity_operation_id(&request.operation_id) {
        return Err(MemoryError::invalid_payload(
            "Continuity operation id must be a bounded, wire-safe, nonempty id",
        ));
    }
    scoped::with_memory_savepoint(conn, |conn| {
        let source =
            load_source_user_content(conn, &request.session_id, &request.source_message_id);
        let payload_hash = continuity_operation_hash(&request, source.as_deref().ok());
        if let Some(prior) = capture::replay_ledger::<SessionContinuity>(
            conn,
            &request.session_id,
            &request.operation_id,
            &payload_hash,
        )? {
            return Ok(prior);
        }
        // NEW operation: a valid persisted user source and the exact expected
        // revision are both required before any durable write.
        let _source = source?;
        validate_continuity_set(conn, &request)?;
        let objective = match &request.objective {
            Some(text) => Some(ActiveObjective {
                text: text.clone(),
                source_message_id: request.source_message_id.clone(),
                source_turn_id: None,
                depends_on_memory_ids: Vec::new(),
            }),
            None => None,
        };
        let current = read_session_continuity(conn, &request.session_id)?;
        // A manual operator set is authoritative: freeze a highwater at the
        // latest message order present now so every already-recorded source
        // (including the chosen one) is protected from later automatic turns.
        let updated = write_session_continuity(
            conn,
            &request.session_id,
            objective.as_ref(),
            None,
            Some(&request.source_message_id),
            true,
            now,
        )?;
        write_continuity_audit(
            conn,
            if objective.is_some() {
                "continuity_set"
            } else {
                "continuity_clear"
            },
            &request.session_id,
            Some(json!(current.active_objective)),
            Some(json!(updated.active_objective)),
            "Explicit operator continuity action",
        )?;
        capture::ledger_put(
            conn,
            &request.session_id,
            &request.operation_id,
            &payload_hash,
            &updated,
            now,
        )?;
        Ok(updated)
    })
}

/// Resolve the actual owner Session of a persisted message, or `None` when the
/// message row no longer exists. The owner is the only Session whose derived
/// prompt state can replay the message, so suppression is always recorded
/// against the real owner rather than a memory's recorded origin Session.
pub fn message_owner_session(
    conn: &Connection,
    message_id: &str,
) -> Result<Option<String>, MemoryError> {
    conn.query_row(
        "SELECT session_id FROM messages WHERE id = ?",
        [message_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(MemoryError::from)
}

fn session_exists(conn: &Connection, session_id: &str) -> Result<bool, MemoryError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?)",
        [session_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(MemoryError::from)
}

/// Insert one prompt-source suppression under the message's ACTUAL owner
/// Session. `fallback_session_id` is used only for a deleted source message
/// that carries authenticated origin provenance and whose origin Session still
/// exists; an associated assistant message without a persisted row cannot be
/// resolved and is skipped. Every consequence id is pushed to `affected`,
/// whether or not the message row itself still exists.
fn insert_prompt_suppression(
    conn: &Connection,
    message_id: &str,
    memory_id: &str,
    fallback_session_id: Option<&str>,
    now: DateTime<Utc>,
    affected: &mut Vec<String>,
) -> Result<(), MemoryError> {
    let owner = match message_owner_session(conn, message_id)? {
        Some(owner) => Some(owner),
        None => match fallback_session_id {
            Some(fallback) if !fallback.is_empty() && session_exists(conn, fallback)? => {
                Some(fallback.to_string())
            }
            _ => None,
        },
    };
    if let Some(owner) = owner {
        conn.execute(
            "INSERT OR IGNORE INTO memory_prompt_suppressions
                 (session_id, message_id, memory_id, reason, created_at)
             VALUES (?, ?, ?, ?, ?)",
            params![
                &owner,
                message_id,
                memory_id,
                "memory source suppressed",
                now.to_rfc3339()
            ],
        )
        .map_err(MemoryError::from)?;
    }
    let owned = message_id.to_string();
    if !affected.contains(&owned) {
        affected.push(owned);
    }
    Ok(())
}

/// Persist prompt-source suppression for every exact consequence message of the
/// given scoped memories and return the affected message ids (deduplicated).
/// The lineage includes the memory's own recorded source messages, an accepted/
/// superseded proposal's assistant source, and every assistant message whose
/// persisted turn actually applied an invalidated memory id (conservatively
/// using the prepared selection only when application evidence is missing).
/// Associations are always collected, even for a manual memory with no recorded
/// source Session. Every suppression is recorded under the message's ACTUAL
/// owner Session, so a recalled memory neutralizes the assistant response in a
/// different Session too. Ids absent from the exact scope are skipped; the
/// caller has already validated target ids. A corrupt source column or a
/// corrupt preparation selection is a typed storage failure.
pub fn suppress_memory_sources(
    conn: &Connection,
    scope: &MemoryScope,
    memory_ids: &[String],
    now: DateTime<Utc>,
) -> Result<Vec<String>, MemoryError> {
    suppress_memory_sources_excluding(conn, scope, memory_ids, &[], now)
}

/// As [`suppress_memory_sources`], but the given exact message ids (for example
/// the current directive that produced a replacement) are never suppressed.
pub fn suppress_memory_sources_excluding(
    conn: &Connection,
    scope: &MemoryScope,
    memory_ids: &[String],
    excluded_message_ids: &[String],
    now: DateTime<Utc>,
) -> Result<Vec<String>, MemoryError> {
    let mut affected: Vec<String> = Vec::new();
    for memory_id in memory_ids {
        let memory = match scoped::read_scoped_memory(conn, scope, memory_id) {
            Ok(memory) => memory,
            Err(err) if err.code == super::contracts::MemoryErrorCode::NotFound => continue,
            Err(err) => return Err(err),
        };
        let source_session_id = memory.entry.source_session_id.clone();

        // (a) The memory's own recorded source messages. Ownership is resolved
        // from the messages table; the recorded origin Session is only a
        // fallback for a deleted source row.
        let own_sources: Vec<String> = serde_json::from_str(&memory.entry.source_message_ids)
            .map_err(|_| MemoryError::storage_unavailable("Corrupt persisted memory source ids"))?;
        for message_id in own_sources {
            if excluded_message_ids.contains(&message_id) {
                continue;
            }
            insert_prompt_suppression(
                conn,
                &message_id,
                memory_id,
                source_session_id.as_deref(),
                now,
                &mut affected,
            )?;
        }

        // (b) Proposal lineage: an accepted/superseded proposal's assistant
        // source must also be neutralized. Its own recorded origin Session is
        // the fallback owner for a deleted source row.
        if let Some(proposal_id) = memory.entry.supersedes_id.as_deref() {
            if let Ok(proposal) = scoped::read_scoped_memory(conn, scope, proposal_id) {
                let proposal_source_session = proposal.entry.source_session_id.clone();
                let lineage: Vec<String> = serde_json::from_str(&proposal.entry.source_message_ids)
                    .map_err(|_| {
                        MemoryError::storage_unavailable("Corrupt persisted proposal source ids")
                    })?;
                for message_id in lineage {
                    if excluded_message_ids.contains(&message_id) {
                        continue;
                    }
                    insert_prompt_suppression(
                        conn,
                        &message_id,
                        memory_id,
                        proposal_source_session.as_deref(),
                        now,
                        &mut affected,
                    )?;
                }
            }
        }

        // (c) Assistant-turn consequence, always collected even when the
        // memory has no recorded source Session. Ownership comes from the
        // actual persisted owner; the turn association already authenticated it.
        let associated = collect_applied_assistant_message_ids(conn, &[memory_id.clone()])?;
        for message_id in associated {
            if excluded_message_ids.contains(&message_id) {
                continue;
            }
            insert_prompt_suppression(conn, &message_id, memory_id, None, now, &mut affected)?;
        }
    }
    Ok(affected)
}

/// Clear every active objective that declares a dependency on an invalidated
/// memory id, recording one bounded continuity audit event per affected
/// Session. Returns the affected Session ids. This is the continuity
/// consequence of a correction/forget and must commit with the mutation.
pub fn clear_continuity_dependent_on(
    conn: &Connection,
    memory_ids: &[String],
    now: DateTime<Utc>,
) -> Result<Vec<String>, MemoryError> {
    if memory_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut rows: Vec<(String, String, i64)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT session_id, active_objective_json, revision
                 FROM session_continuity WHERE active_objective_json IS NOT NULL",
            )
            .map_err(MemoryError::from)?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(MemoryError::from)?;
        for row in mapped {
            rows.push(row.map_err(MemoryError::from)?);
        }
    }

    let mut affected: Vec<String> = Vec::new();
    for (session_id, objective_json, revision) in rows {
        // A corrupt persisted objective is a typed storage failure: silently
        // skipping it could leave a declared dependency on an invalidated
        // memory in a prompt-visible objective and publish stale context after
        // an ACK. Fail closed and withhold the ACK instead.
        let objective: ActiveObjective = serde_json::from_str(&objective_json).map_err(|_| {
            MemoryError::storage_unavailable("Corrupt persisted continuity objective")
        })?;
        let depends = objective
            .depends_on_memory_ids
            .iter()
            .any(|id| memory_ids.contains(id));
        if !depends {
            continue;
        }
        let updated = conn
            .execute(
                "UPDATE session_continuity
                 SET active_objective_json = NULL, revision = revision + 1, updated_at = ?
                 WHERE session_id = ? AND revision = ?",
                params![now.to_rfc3339(), &session_id, revision],
            )
            .map_err(MemoryError::from)?;
        if updated == 0 {
            continue;
        }
        engine::write_memory_event(
            conn,
            None,
            "continuity_clear",
            "memory_capture",
            Some(serde_json::to_value(&objective).unwrap_or(serde_json::Value::Null)),
            None,
            "Active objective cleared because a declared memory dependency was invalidated",
            1.0,
            Some(&session_id),
        )
        .map_err(MemoryError::storage_unavailable)?;
        affected.push(session_id);
    }
    Ok(affected)
}

// ── Derived-invalidation outbox (Part 3.2) ──────────────────────────────────
//
// The outbox row is written in the same savepoint as the native mutation and
// its suppressions. It is marked acknowledged only after the authenticated Bun
// cleanup succeeds (and, for a live owned child, inside the same savepoint as
// the mutation so an acknowledgement failure rolls the mutation back too). A
// process death between commit and acknowledgement leaves the row pending for
// the next drain; retries of the same namespaced key are no-ops on the Bun side.
//
// `scope_json` stores the actual resolved MemoryScope. `source_message_ids_json`
// stores the exact source message ids. Malformed persisted metadata is a typed
// storage failure: it is never silently defaulted or skipped (serving stale
// derived context after a corrupt cleanup record is worse than failing closed).

fn json_array(value: &str, field: &str) -> Result<Vec<String>, MemoryError> {
    serde_json::from_str::<Vec<String>>(value).map_err(|_| {
        MemoryError::storage_unavailable(format!(
            "Corrupt persisted derived-invalidation {field}"
        ))
    })
}

/// Persist one unacknowledged outbox row. `INSERT OR IGNORE` keeps an exact
/// operation retry idempotent and never rewrites an already-recorded row.
/// `scope` is internal routing metadata (never the wire DTO) stored as
/// `scope_json`; a `None` scope is stored as JSON null.
pub fn record_memory_derived_invalidation(
    conn: &Connection,
    session_id: &str,
    invalidation: &MemoryDerivedInvalidation,
    scope: Option<&MemoryScope>,
    _now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    let scope_json = match scope {
        Some(scope) => serde_json::to_string(scope)
            .map_err(|_| MemoryError::storage_unavailable("Failed to serialize derived scope"))?,
        None => "null".to_string(),
    };
    let source_json = serde_json::to_string(&invalidation.source_message_ids)
        .map_err(|_| MemoryError::storage_unavailable("Failed to serialize source ids"))?;
    let affected_json = serde_json::to_string(&invalidation.affected_session_ids)
        .map_err(|_| MemoryError::storage_unavailable("Failed to serialize affected sessions"))?;
    let memory_json = serde_json::to_string(&invalidation.memory_ids)
        .map_err(|_| MemoryError::storage_unavailable("Failed to serialize memory ids"))?;
    conn.execute(
        "INSERT OR IGNORE INTO memory_derived_cleanup_outbox
             (session_id, operation_id, scope_json, source_message_ids_json,
              affected_session_ids_json, memory_ids_json)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            session_id,
            &invalidation.operation_id,
            scope_json,
            source_json,
            affected_json,
            memory_json,
        ],
    )
    .map_err(MemoryError::from)?;
    Ok(())
}

/// Mark one outbox row acknowledged after the Bun cleanup ACK. Only the owning
/// Session/operation pair is touched, and only once. Callers that confirmed a
/// live acknowledgement run this INSIDE the mutation savepoint so a failure
/// rolls back the memory/suppression/ledger/receipt writes as well.
pub fn acknowledge_memory_derived_invalidation(
    conn: &Connection,
    session_id: &str,
    operation_id: &str,
    now: DateTime<Utc>,
) -> Result<(), MemoryError> {
    conn.execute(
        "UPDATE memory_derived_cleanup_outbox SET acknowledged_at = ?
         WHERE session_id = ? AND operation_id = ? AND acknowledged_at IS NULL",
        params![now.to_rfc3339(), session_id, operation_id],
    )
    .map_err(MemoryError::from)?;
    Ok(())
}

/// Read every unacknowledged outbox row. Any malformed persisted column is a
/// typed storage failure rather than a silently-skipped cleanup.
pub fn pending_memory_derived_invalidations(
    conn: &Connection,
) -> Result<Vec<PendingDerivedInvalidation>, MemoryError> {
    let mut stmt = conn
        .prepare(
            "SELECT session_id, operation_id, scope_json, source_message_ids_json,
                    affected_session_ids_json, memory_ids_json
             FROM memory_derived_cleanup_outbox
             WHERE acknowledged_at IS NULL
             ORDER BY session_id, operation_id",
        )
        .map_err(MemoryError::from)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(MemoryError::from)?;
    let mut out = Vec::new();
    for row in rows {
        let (session_id, operation_id, scope_json, source_json, affected_json, memory_json) =
            row.map_err(MemoryError::from)?;
        // `scope_json` is CHECK(json_valid(...)), so an empty string can never
        // be a legitimate None. Only the exact JSON literal `null` decodes to
        // no scope; anything else must parse strictly or fail as corrupt
        // storage. An empty/unknown value must never silently become `None`.
        let scope: Option<MemoryScope> = if scope_json.trim() == "null" {
            None
        } else {
            Some(serde_json::from_str(&scope_json).map_err(|_| {
                MemoryError::storage_unavailable("Corrupt persisted derived scope")
            })?)
        };
        out.push(PendingDerivedInvalidation {
            session_id,
            invalidation: MemoryDerivedInvalidation {
                operation_id,
                affected_session_ids: json_array(&affected_json, "affected session ids")?,
                memory_ids: json_array(&memory_json, "memory ids")?,
                source_message_ids: json_array(&source_json, "source message ids")?,
            },
            scope,
        });
    }
    Ok(out)
}

/// Read-only lineage: every exact source message id recorded for the given
/// scoped memories, plus (a) the proposal lineage of an accepted/superseded
/// proposal and (b) every assistant message whose persisted turn actually
/// applied an invalidated memory id. The prepared selection is used only while
/// application evidence is missing. Missing ids are skipped only after the
/// scope has been validated by the caller; a corrupt source column is a typed
/// storage failure.
pub fn collect_memory_source_message_ids(
    conn: &Connection,
    scope: &MemoryScope,
    memory_ids: &[String],
) -> Result<Vec<String>, MemoryError> {
    let mut affected: Vec<String> = Vec::new();
    for memory_id in memory_ids {
        let memory = match scoped::read_scoped_memory(conn, scope, memory_id) {
            Ok(memory) => memory,
            Err(err) if err.code == super::contracts::MemoryErrorCode::NotFound => continue,
            Err(err) => return Err(err),
        };
        let source_message_ids: Vec<String> = serde_json::from_str(&memory.entry.source_message_ids)
            .map_err(|_| {
            MemoryError::storage_unavailable("Corrupt persisted memory source ids")
        })?;
        for message_id in source_message_ids {
            if !affected.contains(&message_id) {
                affected.push(message_id);
            }
        }
        // A superseded/accepted proposal's own assistant source must also be
        // neutralized; it is stored on the target row's provenance.
        if let Some(proposal_id) = memory.entry.supersedes_id.as_deref() {
            if let Ok(proposal) = scoped::read_scoped_memory(conn, scope, proposal_id) {
                let lineage: Vec<String> = serde_json::from_str(&proposal.entry.source_message_ids)
                    .map_err(|_| {
                        MemoryError::storage_unavailable("Corrupt persisted proposal source ids")
                    })?;
                for message_id in lineage {
                    if !affected.contains(&message_id) {
                        affected.push(message_id);
                    }
                }
            }
        }
    }
    for message_id in collect_applied_assistant_message_ids(conn, memory_ids)? {
        if !affected.contains(&message_id) {
            affected.push(message_id);
        }
    }
    Ok(affected)
}

/// True only when a persisted preparation has a DURABLE AUTHENTICATED
/// COMPLETION receipt, which is the sole evidence that its applied union is a
/// known/authoritative `actually applied` set (including a genuine zero-item
/// budget omission).
///
/// The proof is `finished_at.is_some()`, OR an authenticated non-`unterminated`
/// terminal type. A bare `terminal_status = 'unterminated'` is NOT authoritative:
/// native `turn::mark_turn_unterminated` and `turn::recover_pending_memory_turns`
/// set `terminal_status = 'unterminated'` WITHOUT any authenticated finish or
/// applied evidence (generation loss / no receipt), so an empty applied union
/// there is not a real omission. A Bun `unterminated` terminal that DOES carry a
/// durable `finished_at` is authenticated and therefore known. `started_at` alone
/// is never sufficient: an inference that started but has not finished can still
/// apply further recall fallbacks, and a native `invalidated`/`expired`
/// generation-loss row has no authenticated completion at all. While application
/// remains unknown or nonterminal, callers must keep the conservative
/// prepared-selection fallback.
fn preparation_application_known(
    finished_at: Option<&str>,
    terminal_status: Option<&str>,
) -> bool {
    if finished_at.is_some() {
        return true;
    }
    matches!(
        terminal_status,
        Some(
            "completed" | "partial" | "cancelled" | "failed"
        )
    )
}

/// Every assistant message associated (via `memory_turn_messages`) with a turn
/// whose recorded application (or conservatively prepared selection) includes an
/// invalidated memory id.
///
/// Only a durable authenticated completion (a `finished_at`, or an
/// authenticated non-`unterminated` terminal type) makes the applied union
/// authoritative; then it is consulted alone (an empty union is a real
/// omission). While application is unknown or the preparation is nonterminal —
/// an unconsumed `ready` row, a `registered` row, a `started`-but-unsynced
/// inference, or an `invalidated`/`expired`/native-`unterminated` generation-loss
/// row with no authenticated finish — the union of the prepared selection and any
/// currently-known applied ids is used, never inferring completeness from a
/// native invalidation/unterminated marker or a prepared recall status.
/// `selected_json` is decoded as the typed prepared-selection shape, so a
/// malformed persisted object fails closed rather than being silently dropped.
fn collect_applied_assistant_message_ids(
    conn: &Connection,
    memory_ids: &[String],
) -> Result<Vec<String>, MemoryError> {
    let mut affected: Vec<String> = Vec::new();
    if memory_ids.is_empty() {
        return Ok(affected);
    }
    let mut stmt = conn
        .prepare(
            "SELECT p.finished_at, p.terminal_status,
                    p.selected_json, p.applied_selected_ids_json, m.message_id
             FROM memory_turn_preparations p
             JOIN memory_turn_messages m ON m.turn_id = p.turn_id",
        )
        .map_err(MemoryError::from)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(MemoryError::from)?;
    for row in rows {
        let (finished_at, terminal_status, selected_json, applied_json, message_id) =
            row.map_err(MemoryError::from)?;
        let applied: Vec<String> = serde_json::from_str(&applied_json).map_err(|_| {
            MemoryError::storage_unavailable("Corrupt persisted applied selection ids")
        })?;
        let known = preparation_application_known(
            finished_at.as_deref(),
            terminal_status.as_deref(),
        );
        let touched = if known {
            // Authenticated completion: the applied union is authoritative.
            applied
                .iter()
                .any(|id| memory_ids.iter().any(|memory_id| memory_id == id))
        } else {
            // Unknown/nonterminal: conservatively include both the prepared
            // selection and whatever applied ids are currently known.
            let selected: Vec<PreparedMemorySelection> =
                serde_json::from_str(&selected_json).map_err(|_| {
                    MemoryError::storage_unavailable("Corrupt persisted prepared selection")
                })?;
            selected
                .iter()
                .any(|item| memory_ids.iter().any(|memory_id| memory_id == &item.id))
                || applied
                    .iter()
                    .any(|id| memory_ids.iter().any(|memory_id| memory_id == id))
        };
        if touched && !affected.contains(&message_id) {
            affected.push(message_id);
        }
    }
    Ok(affected)
}

fn terminal_status_wire(status: MemoryTurnTerminalStatus) -> &'static str {
    match status {
        MemoryTurnTerminalStatus::Completed => "completed",
        MemoryTurnTerminalStatus::Partial => "partial",
        MemoryTurnTerminalStatus::Cancelled => "cancelled",
        MemoryTurnTerminalStatus::Failed => "failed",
        MemoryTurnTerminalStatus::Unterminated => "unterminated",
    }
}

/// True when any suppression row already references this memory id, the stored
/// proof that a correction/forget consequence was recorded for it. Combined with
/// the live status/revision recheck below, this neutralizes a late answer that
/// selected a memory whose source was suppressed without a row mutation (for
/// example a historically-tombstoned forget).
fn memory_has_prompt_suppression(
    conn: &Connection,
    memory_id: &str,
) -> Result<bool, MemoryError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_prompt_suppressions WHERE memory_id = ?)",
        [memory_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(MemoryError::from)
}

/// Neutralize a newly appended late assistant message whose turn selected or
/// actually applied a memory that has since been tombstoned, corrected/in-place
/// revised, or previously suppressed. The candidate ids follow the SAME
/// authenticated-application policy as [`collect_applied_assistant_message_ids`]:
/// an authenticated completion consults ONLY the applied union; otherwise the
/// union of the prepared selection and the known applied ids is used. Manual
/// facts with no recorded source ids participate because the decision is based
/// on the selected memory lifecycle, not on source-message provenance.
///
/// Runs inside the caller's assistant-append transaction. Only the model-facing
/// suppression is recorded; the operator transcript row stays raw. A missing or
/// corrupt selection entry fails closed by neutralizing the answer rather than
/// letting it revive an invalidated memory.
pub fn suppress_invalidated_turn_attachments(
    conn: &Connection,
    turn: &PersistedMemoryTurn,
    message_id: &str,
    now: DateTime<Utc>,
) -> Result<Vec<String>, MemoryError> {
    let known = preparation_application_known(
        turn.finished_at.as_deref(),
        turn.terminal_status.map(terminal_status_wire),
    );

    let candidate_ids: Vec<String> = if known {
        turn.applied_selected_ids.clone()
    } else {
        let mut ids: Vec<String> = turn.selected.iter().map(|item| item.id.clone()).collect();
        for id in &turn.applied_selected_ids {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        ids
    };

    let mut affected: Vec<String> = Vec::new();
    for id in candidate_ids {
        let invalidated = match turn.selected.iter().find(|item| item.id == id) {
            Some(selection) => match scoped::read_scoped_memory(conn, &selection.scope, &id) {
                Ok(current) => {
                    current.entry.status != "active"
                        || current.revision != selection.revision
                        || memory_has_prompt_suppression(conn, &id)?
                }
                Err(err) if err.code == super::contracts::MemoryErrorCode::NotFound => true,
                Err(err) => return Err(err),
            },
            // An applied id absent from the prepared selection is corrupt
            // metadata; fail closed by neutralizing the late answer.
            None => true,
        };
        if invalidated {
            insert_prompt_suppression(
                conn,
                message_id,
                &id,
                Some(&turn.session_id),
                now,
                &mut affected,
            )?;
        }
    }
    Ok(affected)
}

/// Read-only lineage for legacy (unscoped) rows read directly from the engine.
/// A malformed persisted source column is a typed storage failure; only an
/// absent row is skipped.
pub fn collect_legacy_source_message_ids(
    conn: &Connection,
    memory_ids: &[String],
) -> Result<Vec<String>, MemoryError> {
    let mut affected: Vec<String> = Vec::new();
    for memory_id in memory_ids {
        let row: Option<String> = conn
            .query_row(
                "SELECT source_message_ids FROM memory WHERE id = ?",
                [memory_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(MemoryError::from)?;
        let Some(raw) = row else { continue };
        let source_message_ids: Vec<String> = serde_json::from_str(&raw).map_err(|_| {
            MemoryError::storage_unavailable("Corrupt persisted legacy memory source ids")
        })?;
        for message_id in source_message_ids {
            if !affected.contains(&message_id) {
                affected.push(message_id);
            }
        }
    }
    for message_id in collect_applied_assistant_message_ids(conn, memory_ids)? {
        if !affected.contains(&message_id) {
            affected.push(message_id);
        }
    }
    Ok(affected)
}

/// Persist prompt-source suppression for legacy (unscoped) rows using each
/// row's recorded source Session and message ids, plus its associated assistant
/// consequences. Suppression is recorded under the message's ACTUAL owner
/// Session; a manual row with no recorded source Session still has its
/// associations collected.
pub fn suppress_legacy_memory_sources(
    conn: &Connection,
    memory_ids: &[String],
    now: DateTime<Utc>,
) -> Result<Vec<String>, MemoryError> {
    let mut affected: Vec<String> = Vec::new();
    for memory_id in memory_ids {
        let row: Option<(Option<String>, String)> = conn
            .query_row(
                "SELECT source_session_id, source_message_ids FROM memory WHERE id = ?",
                [memory_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(MemoryError::from)?;
        let Some((source_session_id, raw)) = row else {
            continue;
        };
        let source_message_ids: Vec<String> = serde_json::from_str(&raw).map_err(|_| {
            MemoryError::storage_unavailable("Corrupt persisted legacy memory source ids")
        })?;
        for message_id in source_message_ids {
            insert_prompt_suppression(
                conn,
                &message_id,
                memory_id,
                source_session_id.as_deref(),
                now,
                &mut affected,
            )?;
        }
        for message_id in collect_applied_assistant_message_ids(conn, &[memory_id.clone()])? {
            insert_prompt_suppression(conn, &message_id, memory_id, None, now, &mut affected)?;
        }
    }
    Ok(affected)
}

/// Enumerate every Session whose derived prompt state could hold an invalidated
/// memory: the initiating Session, the scope's Session consumers, and recorded
/// preparation selection consumers (including user-scope opt-ins). It never
/// returns an unbounded global reset.
pub fn collect_affected_session_ids(
    conn: &Connection,
    initiating_session_id: &str,
    scope: Option<&MemoryScope>,
    memory_ids: &[String],
) -> Result<Vec<String>, MemoryError> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    if !initiating_session_id.is_empty() {
        set.insert(initiating_session_id.to_string());
    }
    if let Some(scope) = scope {
        match scope.kind {
            MemoryScopeKind::Project => {
                if let Some(root) = scope.project_root.as_deref() {
                    let mut stmt = conn
                        .prepare(
                            "SELECT id FROM sessions WHERE agent_id = ? AND project_root = ?",
                        )
                        .map_err(MemoryError::from)?;
                    let rows = stmt
                        .query_map(params![&scope.agent_id, root], |row| {
                            row.get::<_, String>(0)
                        })
                        .map_err(MemoryError::from)?;
                    for row in rows {
                        set.insert(row.map_err(MemoryError::from)?);
                    }
                }
            }
            MemoryScopeKind::Agent => {
                let mut stmt = conn
                    .prepare("SELECT id FROM sessions WHERE agent_id = ?")
                    .map_err(MemoryError::from)?;
                let rows = stmt
                    .query_map(params![&scope.agent_id], |row| row.get::<_, String>(0))
                    .map_err(MemoryError::from)?;
                for row in rows {
                    set.insert(row.map_err(MemoryError::from)?);
                }
            }
            // User scope has no bounded Session enumeration; the initiating
            // Session plus recorded selection consumers below are exact.
            MemoryScopeKind::User | MemoryScopeKind::LegacyUnscoped => {}
        }
    }

    // Opt-in user-wide consumers are only relevant to a User-scope mutation;
    // a project/Agent mutation must not expand to every include_user_scope turn.
    // A NEW user-scope accepted save has no target memory ids but must still
    // include every explicit opt-in consumer, so this work runs even when
    // `memory_ids` is empty (it must not early-return before it).
    let include_user_scope_consumers =
        matches!(scope.map(|scope| scope.kind), Some(MemoryScopeKind::User));

    let mut stmt = conn
        .prepare(
            "SELECT session_id, finished_at, terminal_status,
                    selected_json, applied_selected_ids_json, include_user_scope
             FROM memory_turn_preparations",
        )
        .map_err(MemoryError::from)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(MemoryError::from)?;
    for row in rows {
        let (
            session_id,
            finished_at,
            terminal_status,
            selected_json,
            applied_json,
            include_user_scope,
        ) = row.map_err(MemoryError::from)?;
        // A malformed persisted selection/applied column is a typed storage
        // failure: it must never silently shrink the affected-Session set and
        // leave stale derived context un-evicted. Only a durable authenticated
        // completion makes the applied union authoritative; otherwise the
        // prepared-target consumer is conservatively included so a mid-turn
        // forget cleans every prepared target, not only already-applied ones.
        let applied: Vec<String> = serde_json::from_str(&applied_json).map_err(|_| {
            MemoryError::storage_unavailable("Corrupt persisted applied selection ids")
        })?;
        let selected: Vec<PreparedMemorySelection> =
            serde_json::from_str(&selected_json).map_err(|_| {
                MemoryError::storage_unavailable("Corrupt persisted prepared selection")
            })?;
        let prepared_target = selected
            .iter()
            .any(|item| memory_ids.iter().any(|memory_id| memory_id == &item.id));
        let known = preparation_application_known(
            finished_at.as_deref(),
            terminal_status.as_deref(),
        );
        let touched = if known {
            applied
                .iter()
                .any(|id| memory_ids.iter().any(|memory_id| memory_id == id))
        } else {
            prepared_target
                || applied
                    .iter()
                    .any(|id| memory_ids.iter().any(|memory_id| memory_id == id))
        };
        if include_user_scope_consumers && include_user_scope != 0 {
            set.insert(session_id.clone());
        }
        if touched {
            set.insert(session_id);
        }
    }

    // Sessions whose active objective declared a dependency on the invalidated
    // ids are also derived-context consumers. A corrupt persisted objective is a
    // typed storage failure: it is never silently skipped, because that would
    // withhold an unsafe ACK and leave a dependent Session's derived state
    // intact.
    let mut stmt = conn
        .prepare("SELECT session_id, active_objective_json FROM session_continuity WHERE active_objective_json IS NOT NULL")
        .map_err(MemoryError::from)?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(MemoryError::from)?;
    for row in rows {
        let (session_id, objective_json) = row.map_err(MemoryError::from)?;
        let objective: ActiveObjective = serde_json::from_str(&objective_json).map_err(|_| {
            MemoryError::storage_unavailable("Corrupt persisted continuity objective")
        })?;
        if objective
            .depends_on_memory_ids
            .iter()
            .any(|id| memory_ids.iter().any(|memory_id| memory_id == id))
        {
            set.insert(session_id);
        }
    }
    Ok(ordered_sessions(set, initiating_session_id))
}

/// Preserve the initiating Session as the first element (the wire namespace
/// key) followed by the remaining affected Sessions in stable order.
fn ordered_sessions(set: BTreeSet<String>, initiating_session_id: &str) -> Vec<String> {
    let mut ordered: Vec<String> = Vec::with_capacity(set.len());
    if !initiating_session_id.is_empty() {
        ordered.push(initiating_session_id.to_string());
    }
    for session_id in set {
        if session_id != initiating_session_id {
            ordered.push(session_id);
        }
    }
    ordered
}

/// Explicit, monotonic Session workspace-binding revision, defaulting to 0 for
/// a Session created before this column existed. It advances on every
/// `sessions.project_root` change (trigger-maintained), so a preparation can
/// detect a pure rebind that changes the effective memory scope even when the
/// global store revision and continuity revision are unchanged.
pub fn session_binding_revision(
    conn: &Connection,
    session_id: &str,
) -> Result<i64, MemoryError> {
    let revision: Option<i64> = conn
        .query_row(
            "SELECT binding_revision FROM sessions WHERE id = ?",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(MemoryError::from)?;
    Ok(revision.unwrap_or(0))
}

/// Clear the legacy derived summary fields for affected Sessions. Structured
/// continuity replaces their future prompt use, so an old summary/current_goal
/// can never be re-served from `session_memory`. The visible transcript is not
/// touched. Returns the number of rows cleared.
pub fn sanitize_legacy_session_summary(
    conn: &Connection,
    session_ids: &[String],
    now: DateTime<Utc>,
) -> Result<usize, MemoryError> {
    if session_ids.is_empty() {
        return Ok(0);
    }
    let mut cleared = 0usize;
    for session_id in session_ids {
        cleared += conn
            .execute(
                "UPDATE session_memory
                 SET summary = '', current_goal = '', decisions = '[]', next_steps = '[]', updated_at = ?
                 WHERE session_id = ?",
                params![now.to_rfc3339(), session_id],
            )
            .map_err(MemoryError::from)?;
    }
    Ok(cleared)
}
