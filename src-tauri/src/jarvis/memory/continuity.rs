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

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use super::capture_contracts::{ActiveObjective, SessionContinuity};
use super::contracts::{MemoryError, MemoryScope};
use super::{engine, scoped};

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

/// Persist prompt-source suppression for every exact source message of the
/// given scoped memories and return the affected message ids (deduplicated).
/// Ids that are not present in the exact scope are skipped; the caller has
/// already validated target ids, so a miss is not an error.
pub fn suppress_memory_sources(
    conn: &Connection,
    scope: &MemoryScope,
    memory_ids: &[String],
    now: DateTime<Utc>,
) -> Result<Vec<String>, MemoryError> {
    let mut affected: Vec<String> = Vec::new();
    for memory_id in memory_ids {
        let memory = match scoped::read_scoped_memory(conn, scope, memory_id) {
            Ok(memory) => memory,
            Err(err) if err.code == super::contracts::MemoryErrorCode::NotFound => continue,
            Err(err) => return Err(err),
        };
        let Some(source_session_id) = memory.entry.source_session_id.clone() else {
            continue;
        };
        let source_message_ids: Vec<String> =
            serde_json::from_str(&memory.entry.source_message_ids).unwrap_or_default();
        for message_id in source_message_ids {
            conn.execute(
                "INSERT OR IGNORE INTO memory_prompt_suppressions
                     (session_id, message_id, memory_id, reason, created_at)
                 VALUES (?, ?, ?, ?, ?)",
                params![
                    &source_session_id,
                    &message_id,
                    memory_id,
                    "memory source suppressed",
                    now.to_rfc3339()
                ],
            )
            .map_err(MemoryError::from)?;
            if !affected.contains(&message_id) {
                affected.push(message_id);
            }
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
        let objective: ActiveObjective = match serde_json::from_str(&objective_json) {
            Ok(objective) => objective,
            // A corrupt objective is left untouched for explicit repair.
            Err(_) => continue,
        };
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
