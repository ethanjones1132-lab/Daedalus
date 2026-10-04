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

use super::capture_contracts::{ActiveObjective, MemoryDerivedInvalidation, SessionContinuity};
use super::contracts::{MemoryError, MemoryScope, MemoryScopeKind};
use super::turn::{MemoryTurnTerminalStatus, PersistedMemoryTurn, PreparedMemorySelection};
use super::{engine, scoped};

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
