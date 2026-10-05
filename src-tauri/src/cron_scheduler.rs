//! Background cron scheduler — polls due jobs every 60 s and dispatches
//! their prompts to the Bun server, mirroring OpenClaw's architecture:
//! isolated session per run, inFlight guard, missed-task detection on startup,
//! next_run written from fire time (lastFiredAt pattern, no catch-up on missed ticks).

use crate::db::AppDb;
use chrono::Utc;
use rusqlite::OptionalExtension;
use cron::Schedule;
use reqwest::Client;
use serde_json::json;
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{interval, MissedTickBehavior};

const POLL_INTERVAL_SECS: u64 = 60;
const INITIAL_DELAY_SECS: u64 = 20;
// T1.3: final-stream grace window means worst-case orchestrator turn ≈ 210s
// (180s absolute turn cap + 30s grace). Cron dispatch must tolerate that.
const STREAM_TIMEOUT_SECS: u64 = 240;
pub const INFERENCE_FEEDBACK_CRON_JOB_ID: &str = "jarvis-system-inference-feedback";
const INFERENCE_FEEDBACK_SCHEDULE: &str = "17 */6 * * *";

use std::sync::OnceLock;

static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub fn get_in_flight_registry() -> &'static Mutex<HashSet<String>> {
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

static PENDING_MISSED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub fn get_pending_missed_registry() -> &'static Mutex<HashSet<String>> {
    PENDING_MISSED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Jobs whose in-flight execution the user (or a Goal/disable event) has asked
/// to cancel. The scheduler registers a `CancellationToken` here keyed by job id
/// and aborts it when a cancel is requested; the token's abort is what actually
/// stops the tracked `/cron/run` request. The entry is written BEFORE the token
/// is registered so an early cancel is already visible to `execute_job`.
static CANCEL_REQUESTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancel_requests() -> &'static Mutex<HashSet<String>> {
    CANCEL_REQUESTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn take_cancel_request(job_id: &str) -> bool {
    let mut guard = cancel_requests().lock().unwrap_or_else(|p| p.into_inner());
    guard.remove(job_id)
}

fn is_cancel_requested(job_id: &str) -> bool {
    cancel_requests()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(job_id)
}

/// Execution abort channels keyed by job id. A running `execute_job` inserts a
/// `watch` sender while dispatching; a cancel request flips it to `true`, which
/// cancels the underlying `/cron/run` request through `dispatch_cron_job`.
/// Per-job cancellation registration held for the lifetime of one tracked
/// execution. It carries a signal into `execute_job`/`dispatch_cron_job` and a
/// broadcast used by the worker to acknowledge when it has actually observed the
/// cancellation and its request has completed.
struct CancelControl {
    activation_id: String,
    signal_tx: tokio::sync::watch::Sender<bool>,
    ack_tx: tokio::sync::broadcast::Sender<()>,
}

static CANCEL_TOKENS: OnceLock<Mutex<std::collections::HashMap<String, CancelControl>>> =
    OnceLock::new();

fn cancel_registry() -> &'static Mutex<std::collections::HashMap<String, CancelControl>> {
    CANCEL_TOKENS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub fn get_pending_missed_jobs() -> Vec<String> {
    let guard = get_pending_missed_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    guard.iter().cloned().collect()
}

/// Convert a 5-field cron expression (min hr dom mon dow) to the 7-field
/// format required by the `cron` crate (sec min hr dom mon dow yr).
fn five_to_seven_field(expr: &str) -> String {
    let trimmed = expr.trim();
    if trimmed.split_whitespace().count() == 7 {
        return trimmed.to_string();
    }
    format!("0 {} *", trimmed)
}

/// Compute the next UTC wall-clock time at which `schedule_expr` fires,
/// anchored from now. Returns an ISO-8601 string for SQLite.
pub fn compute_next_run(schedule_expr: &str) -> Option<String> {
    let seven = five_to_seven_field(schedule_expr);
    let schedule = Schedule::from_str(&seven).ok()?;
    schedule
        .upcoming(Utc)
        .next()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Deterministic UTC-millisecond occurrence key for the scheduled fire time of
/// a due job. This is stable across scheduler polls and restarts because it is
/// derived from the persisted `next_run` wall-clock value, never a fresh UUID.
fn scheduled_occurrence_at(next_run: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(next_run.trim())
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Record a durable claim-time denial for an unlinked/bound-Session scope
/// mismatch (or missing Session authority) as a schema-valid `blocked`
/// activation and return a fail-closed error with no dispatch. Uses
/// `INSERT OR IGNORE` on the unique `(cron_job_id, schedule_occurrence)` key so
/// the denied occurrence can never be replayed, and returns the caller's `Err`.
#[allow(clippy::too_many_arguments)]
fn record_claim_denial<T>(
    conn: &rusqlite::Connection,
    job_id: &str,
    goal_id: &Option<String>,
    agent_id: &str,
    session_id: &Option<String>,
    project_root: &Option<String>,
    occurrence: &i64,
    trigger_kind: &str,
    claim_state: &str,
    reason: &str,
) -> Result<Option<T>, String> {
    let activation_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO cron_activations \
         (activation_id, cron_job_id, goal_id, agent_id, session_id, project_root, \
          schedule_occurrence, trigger_kind, claim_state, terminal_reason, claimed_at, settled_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, \
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        rusqlite::params![
            &activation_id,
            job_id,
            goal_id,
            agent_id,
            session_id,
            project_root,
            occurrence.to_string(),
            trigger_kind,
            claim_state,
            reason,
        ],
    )
    .map_err(|e| format!("failed to record denied activation: {e}"))?;
    Err(format!("activation denied: {reason}"))
}

/// Additive, idempotent projection-identity columns on the durable
/// `cron_activations` authority. A claim records the exact validated Agent
/// projection snapshot it resolved; final dispatch must re-resolve and match it
/// field-for-field before any external effect. The columns are ensured lazily by
/// the only writer here rather than in `db/migrations.rs` so the durable claim
/// can carry projection identity without widening the migration batch.
fn ensure_activation_projection_columns(conn: &rusqlite::Connection) -> Result<(), String> {
    let existing: HashSet<String> = conn
        .prepare("PRAGMA table_info(cron_activations)")
        .map_err(|e| format!("failed to inspect cron_activations: {e}"))?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("failed to inspect cron_activations: {e}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| format!("failed to inspect cron_activations: {e}"))?;
    let additions = [
        ("projection_slug", "projection_slug TEXT"),
        ("projection_source_path", "projection_source_path TEXT"),
        ("projection_source_hash", "projection_source_hash TEXT"),
        (
            "projection_active_source_hash",
            "projection_active_source_hash TEXT",
        ),
        ("projection_version", "projection_version INTEGER"),
        ("projection_activated_at", "projection_activated_at TEXT"),
    ];
    for (column, ddl) in additions {
        if !existing.contains(column) {
            conn.execute(
                &format!("ALTER TABLE cron_activations ADD COLUMN {ddl}"),
                [],
            )
            .map_err(|e| format!("failed to add cron_activations.{column}: {e}"))?;
        }
    }
    Ok(())
}

/// Claim the deterministic occurrence for one due job so a given schedule fire
/// dispatches at most once, even across a restart or overlapping polls.
///
/// Returns `Ok(Some(activation_id))` when this caller newly claimed the
/// occurrence, `Ok(None)` when the occurrence is already durable (completed,
/// cancelled, or previously attempted) and must not be re-dispatched. A terminal
/// `cancelled`/`failed` claim is never revived; any other existing claim is
/// marked `ambiguous` for explicit reconciliation instead of replay. Fails closed
/// if the job is missing/disabled, the occurrence cannot be derived, or the
/// insert/update does not commit.
fn claim_activation(
    app: &AppHandle,
    job_id: &str,
    schedule_expr: &str,
    trigger_kind: &str,
    next_run_override: Option<&str>,
) -> Result<Option<String>, String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    // The durable activation authority must be able to carry claim-time Agent
    // projection identity before any claim/denial row is written.
    ensure_activation_projection_columns(&conn)?;

    let row: Option<(i64, Option<String>, String, Option<String>)> = conn
        .query_row(
            "SELECT enabled, next_run, agent_id, session_id FROM cron_jobs WHERE id = ?1",
            [job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (enabled, stored_next, agent_id, session_id) =
        row.ok_or_else(|| format!("cron job not found: {job_id}"))?;

    // A disabled job never activates (disable stops future scheduling).
    if enabled == 0 {
        return Err(format!("cron job '{}' is disabled", job_id));
    }

    // A user cancel intent recorded before this dispatch must be honoured before
    // any claim/dispatch. The intent was already persisted by the caller; this
    // path simply refuses to start.
    if is_cancel_requested(job_id) {
        return Err(format!("cron job '{}' was cancelled before dispatch", job_id));
    }

    let occurrence_source = next_run_override
        .map(|s| s.to_string())
        .or(stored_next)
        .ok_or_else(|| format!("cron job '{}' has no occurrence time", job_id))?;
    let occurrence = scheduled_occurrence_at(&occurrence_source)
        .ok_or_else(|| format!("cron job '{}' has an invalid next_run", job_id))?;

    // Goal-cancellation guard, native-side and fail-closed. A missing Goal (or
    // an unreachable Goal authority) blocks activation rather than dispatching
    // under stale authority.
    let goal_id: Option<String> = conn
        .query_row(
            "SELECT goal_id FROM cron_jobs WHERE id = ?1",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let mut goal_scope: Option<String> = None;
    if let Some(ref gid) = goal_id {
        match crate::commands::goals::validate_cron_goal_activation(&conn, gid, job_id) {
            Ok(goal) => goal_scope = goal.project_root,
            // A failed Goal validation must not return before the durable
            // activation denial exists: record the due occurrence as `blocked`
            // with the truthful reason so a bad association can never be
            // re-attempted as an unrecorded claim. No workspace is authoritative
            // here because the Goal scope could not be validated.
            Err(e) => {
                return record_claim_denial(
                    &conn,
                    job_id,
                    &goal_id,
                    &agent_id,
                    &session_id,
                    &None,
                    &occurrence,
                    trigger_kind,
                    "blocked",
                    &format!("goal association blocks activation: {e}"),
                );
            }
        }
    }

    // Effective activation scope. A bound Session's actual persisted workspace is
    // the scope for an unlinked job; a linked Goal's canonical scope is the
    // authority and a bound Session must agree with it. `None` only when there is
    // no Goal and no Session. A Session whose Agent does not match the cron Agent,
    // or whose workspace disagrees with the Goal, is a fail-closed denial
    // recorded durably as `blocked` with no dispatch.
    let bound_session_root: Option<Option<String>> = match session_id.as_deref() {
        Some(sid) => {
            let row: Option<(String, Option<String>)> = match conn
                .query_row(
                    "SELECT agent_id, project_root FROM sessions WHERE id = ?1",
                    [sid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
            {
                Ok(row) => row,
                Err(e) => {
                    // An unreadable bound-Session authority is a fail-closed
                    // denial recorded durably, never a plain claim error.
                    return record_claim_denial(
                        &conn,
                        job_id,
                        &goal_id,
                        &agent_id,
                        &session_id,
                        &goal_scope,
                        &occurrence,
                        trigger_kind,
                        "blocked",
                        &format!("bound session authority unreadable: {e}"),
                    );
                }
            };
            match row {
                Some((session_agent, session_root)) if session_agent == agent_id => {
                    Some(session_root)
                }
                Some((session_agent, _)) => {
                    return record_claim_denial(
                        &conn,
                        job_id,
                        &goal_id,
                        &agent_id,
                        &session_id,
                        &goal_scope,
                        &occurrence,
                        trigger_kind,
                        "blocked",
                        &format!(
                            "bound session '{sid}' belongs to Agent '{session_agent}', not '{agent_id}'"
                        ),
                    );
                }
                None => {
                    return record_claim_denial(
                        &conn,
                        job_id,
                        &goal_id,
                        &agent_id,
                        &session_id,
                        &goal_scope,
                        &occurrence,
                        trigger_kind,
                        "blocked",
                        &format!("bound session '{sid}' no longer exists"),
                    );
                }
            }
        }
        None => None,
    };

    let effective_scope: Option<String> = match goal_scope {
        Some(goal_root) => match bound_session_root {
            Some(Some(session_root)) if session_root != goal_root => {
                return record_claim_denial(
                    &conn,
                    job_id,
                    &goal_id,
                    &agent_id,
                    &session_id,
                    &Some(goal_root),
                    &occurrence,
                    trigger_kind,
                    "blocked",
                    "bound session workspace does not match goal scope",
                );
            }
            _ => Some(goal_root),
        },
        None => bound_session_root.flatten(),
    };

    // Agent lifecycle/projection boundary, re-checked before the claim. A
    // disabled Agent becomes an explicit `waiting_for_user`; a missing/invalid/
    // stale/mismatched authority becomes `blocked`. Neither dispatches, and
    // neither substitutes default instructions. The resolved snapshot is the
    // exact claim-time projection identity persisted below and required again at
    // final dispatch; a custom Agent's validated hash and a built-in Jarvis
    // default (empty identity) are both carried verbatim.
    let projection = match crate::commands::agents::resolve_activation_boundary(&conn, &agent_id) {
        Ok(snapshot) => snapshot,
        Err(denial) => {
            let activation_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT OR IGNORE INTO cron_activations \
                 (activation_id, cron_job_id, goal_id, agent_id, session_id, project_root, \
                  schedule_occurrence, trigger_kind, claim_state, terminal_reason, claimed_at, settled_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, \
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                rusqlite::params![
                    &activation_id,
                    job_id,
                    goal_id,
                    &agent_id,
                    &session_id,
                    &effective_scope,
                    occurrence.to_string(),
                    trigger_kind,
                    denial.claim_state(),
                    denial.reason(),
                ],
            )
            .map_err(|e| format!("failed to record denied activation: {e}"))?;
            return Err(format!("activation denied: {}", denial.reason()));
        }
    };

    // Dedupe: this occurrence key is unique per job. A prior claim means the
    // effect may already exist and must not be reissued.
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT activation_id, claim_state FROM cron_activations \
             WHERE cron_job_id = ?1 AND schedule_occurrence = ?2",
            rusqlite::params![job_id, occurrence.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((existing_id, state)) = existing {
        if state != "cancelled" && state != "failed" {
            conn.execute(
                "UPDATE cron_activations SET claim_state = 'ambiguous', \
                 terminal_reason = COALESCE(terminal_reason, 'unresolved prior attempt; reconciliation required'), \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                 WHERE activation_id = ?1",
                [&existing_id],
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(None);
    }

    let activation_id = uuid::Uuid::new_v4().to_string();
    let affected = conn
        .execute(
            "INSERT INTO cron_activations \
             (activation_id, cron_job_id, goal_id, agent_id, session_id, project_root, \
              schedule_occurrence, trigger_kind, claim_state, claimed_at, \
              projection_slug, projection_source_path, projection_source_hash, \
              projection_active_source_hash, projection_version, projection_activated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'claimed', \
                     strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                &activation_id,
                job_id,
                goal_id,
                &agent_id,
                &session_id,
                &effective_scope,
                occurrence.to_string(),
                trigger_kind,
                &projection.slug,
                &projection.source_path,
                &projection.source_hash,
                &projection.active_source_hash,
                projection.projection_version,
                &projection.activated_at,
            ],
        )
        .map_err(|e| format!("failed to claim activation: {e}"))?;
    if affected != 1 {
        return Err("activation claim was not committed".to_string());
    }
    let _ = schedule_expr;
    Ok(Some(activation_id))
}

/// Reconcile activation claims left pending across a restart. A claimed, not-yet-
/// dispatched occurrence that has already passed is a missed-missed state: mark
/// it `ambiguous` (reconciliation required) or `missed`-cancelled so it is never
/// silently replayed. Dispatched-but-unsettled claims become `ambiguous` so a
/// possibly-in-flight effect is surfaced for review rather than re-issued.
fn reconcile_activations(app: &AppHandle) {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let claimed: Vec<String> = match conn
        .prepare(
            "SELECT activation_id FROM cron_activations \
             WHERE claim_state = 'claimed' \
             AND schedule_occurrence < ?1",
        )
        .and_then(|mut stmt| {
            stmt.query_map([Utc::now().timestamp_millis().to_string()], |row| {
                row.get::<_, String>(0)
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        }) {
        Ok(ids) => ids,
        Err(e) => {
            eprintln!("[cron] activation reconcile query failed: {}", e);
            return;
        }
    };

    if !claimed.is_empty() {
        for id in &claimed {
            if let Err(e) = conn.execute(
                "UPDATE cron_activations SET claim_state = 'ambiguous', \
                 terminal_reason = 'claim survived restart without dispatch; reconciliation required', \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                 WHERE activation_id = ?1 AND claim_state = 'claimed'",
                [id],
            ) {
                eprintln!("[cron] failed to reconcile activation {}: {}", id, e);
            }
        }
        eprintln!(
            "[cron] reconciled {} interrupted activation claim(s) to ambiguous",
            claimed.len()
        );
    }

    // A dispatched claim that never settled after a restart is ambiguous: the
    // external effect may or may not have occurred, so never auto-replay it.
    if let Err(e) = conn.execute(
        "UPDATE cron_activations SET claim_state = 'ambiguous', \
         terminal_reason = 'dispatch outcome unknown after restart; reconciliation required', \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE claim_state = 'dispatched'",
        [],
    ) {
        eprintln!("[cron] failed to reconcile dispatched activations: {}", e);
    }

    // A cancellation request persisted before the previous shutdown had no live
    // task to acknowledge it, so the effect cannot be confirmed cancelled.
    // Surface the actionable `ambiguous` state rather than asserting cancellation
    // or leaving the intent stuck.
    if let Err(e) = conn.execute(
        "UPDATE cron_activations SET claim_state = 'ambiguous', \
         terminal_reason = 'cancellation requested but not acknowledged before restart; reconciliation required', \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE cancel_requested_at IS NOT NULL AND cancel_acknowledged_at IS NULL \
         AND claim_state NOT IN ('completed','failed','cancelled','ambiguous')",
        [],
    ) {
        eprintln!("[cron] failed to reconcile pending cancellations: {}", e);
    }
}

/// A cancellation request that was persisted but for which no tracked execution
/// acknowledged the abort. The activation is settled to `ambiguous` with a
/// truthful reason instead of claiming a cancellation that may not have taken
/// effect. The recorded `cancel_requested_at` intent is left in place for audit
/// so a retry or later reconcile remains possible. Returns `Err` if the durable
/// write fails so the caller does not report an actionable persisted state that
/// did not commit.
fn settle_cancellation_unconfirmed(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.execute(
        "UPDATE cron_activations SET claim_state = 'ambiguous', \
         terminal_reason = 'cancellation requested but no tracked execution acknowledged it; reconciliation required', \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE cron_job_id = ?1 AND cancel_requested_at IS NOT NULL \
         AND cancel_acknowledged_at IS NULL \
         AND claim_state NOT IN ('completed','failed','cancelled')",
        [job_id],
    )
    .map_err(|e| format!("failed to persist unconfirmed cancellation for '{job_id}': {e}"))?;
    Ok(())
}

/// Record a durable cancellation request on the job's active activation without
/// asserting that it stopped. Writes the intent columns (schema-valid
/// `claim_state` is left untouched) and returns the activation id it applied to,
/// if any. Fails closed if the intent write does not commit.
pub fn persist_cancellation_intent(app: &AppHandle, job_id: &str, reason: &str) -> Result<Option<String>, String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let activation_id: Option<String> = conn
        .query_row(
            "SELECT activation_id FROM cron_activations \
             WHERE cron_job_id = ?1 AND claim_state NOT IN ('completed','failed','cancelled') \
             ORDER BY claimed_at DESC LIMIT 1",
            [job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("failed to read active cron activation: {e}"))?;

    if let Some(ref id) = activation_id {
        conn.execute(
            "UPDATE cron_activations SET cancel_requested_at = COALESCE(cancel_requested_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')), \
             cancel_requested_reason = COALESCE(cancel_requested_reason, ?1), \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE activation_id = ?2 AND claim_state NOT IN ('completed','failed','cancelled')",
            rusqlite::params![reason, id],
        )
        .map_err(|e| format!("failed to record cron cancellation intent: {e}"))?;
    }
    Ok(activation_id)
}

/// Durably settle a claimed activation to a fail-closed denied state
/// (`waiting_for_user` or `blocked`) with the specific actionable reason. No run
/// is created and no request is sent. Returns `Err` if the write fails or does
/// not update exactly one eligible activation, so a denied occurrence is never
/// reported as durably blocked without proof. An already-identical denial is
/// idempotent: the update guard leaves it as-is and this succeeds.
fn settle_activation_denied(
    app: &AppHandle,
    activation_id: &str,
    claim_state: &str,
    reason: &str,
) -> Result<(), String> {
    debug_assert!(claim_state == "waiting_for_user" || claim_state == "blocked");
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    // Read the current state so an already-recorded identical denial is treated
    // as an idempotent success rather than a failed update.
    let existing: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT claim_state, terminal_reason, goal_id, cron_job_id, session_id \
             FROM cron_activations WHERE activation_id = ?1",
            [activation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|e| format!("failed to read activation {activation_id}: {e}"))?;
    let (goal_id, cron_job_id) = match &existing {
        Some((_, _, goal_id, cron_job_id, _)) => (goal_id.clone(), cron_job_id.clone()),
        None => (None, None),
    };
    match existing {
        None => {
            return Err(format!(
                "activation {activation_id} not found; denied state not persisted"
            ))
        }
        Some((state, existing_reason, _, _, _))
            if state == claim_state && existing_reason.as_deref() == Some(reason) =>
        {
            return Ok(());
        }
        Some((state, _, _, _, _)) if matches!(state.as_str(), "completed" | "failed" | "cancelled") => {
            // A terminal activation must not be overwritten by a late denial.
            return Ok(());
        }
        Some(_) => {}
    }

    let affected = conn
        .execute(
            "UPDATE cron_activations SET claim_state = ?1, terminal_reason = ?2, \
             settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE activation_id = ?3 AND claim_state NOT IN ('completed','failed','cancelled')",
            rusqlite::params![claim_state, reason, activation_id],
        )
        .map_err(|e| format!("failed to record denied activation {activation_id}: {e}"))?;
    if affected != 1 {
        return Err(format!(
            "denied state for activation {activation_id} was not persisted (affected {affected})"
        ));
    }
    drop(conn);

    // Notify only after the denied state is durably persisted, and only for a
    // Goal-linked activation. A blocked denial is actionable; a waiting denial
    // is a request for user input.
    if let (Some(goal_id), Some(cron_job_id)) = (goal_id, cron_job_id) {
        let request = if claim_state == "waiting_for_user" {
            crate::notifications::waiting_request(
                &goal_id,
                activation_id,
                &cron_job_id,
                None,
                activation_id,
                reason,
            )
        } else {
            crate::notifications::blocked_request(
                &goal_id,
                activation_id,
                &cron_job_id,
                None,
                activation_id,
                reason,
            )
        };
        crate::notifications::emit_goal_notifications(app, vec![request]);
    }
    Ok(())
}

/// Mark an activation `cancelled` after its tracked execution actually
/// acknowledged the abort (observed the signal AND its request completed).
/// Repeated cancels are idempotent and a completed/failed activation is never
/// overwritten with a cancelled state. Records the acknowledgement timestamp.
/// Returns `Err` if the durable write fails so the caller never reports a
/// confirmed cancellation that was not persisted.
pub fn mark_activation_cancelled(
    app: &AppHandle,
    activation_id: &str,
    reason: &str,
) -> Result<(), String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    // Capture the Goal/job identity (if any) so the post-write notification can
    // be scoped to a Goal-linked activation.
    let identity: Option<(Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT goal_id, cron_job_id, run_id FROM cron_activations WHERE activation_id = ?1",
            [activation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("failed to read activation {activation_id}: {e}"))?;
    conn.execute(
        "UPDATE cron_activations SET claim_state = 'cancelled', terminal_reason = ?1, \
         cancel_acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
         settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE activation_id = ?2 AND claim_state NOT IN ('completed','failed','cancelled')",
        rusqlite::params![reason, activation_id],
    )
    .map_err(|e| format!("failed to persist cancellation for activation {activation_id}: {e}"))?;
    drop(conn);

    // A confirmed cancellation is a distinct terminal state (never completion).
    // Notify only after the durable write and only when Goal-linked.
    if let Some((Some(goal_id), Some(cron_job_id), run_id)) = identity {
        let request = crate::notifications::cancelled_request(
            &goal_id,
            activation_id,
            &cron_job_id,
            run_id.as_deref(),
            activation_id,
            reason,
        );
        crate::notifications::emit_goal_notifications(app, vec![request]);
    }
    Ok(())
}

/// Whether a job currently has a non-terminal activation (an active/possible
/// in-flight run). Used by delete to avoid removing a job whose run is still
/// running. Fails closed: a read error is returned so the caller does not delete
/// a job whose active status cannot be established.
pub fn has_active_activation(app: &AppHandle, job_id: &str) -> Result<bool, String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM cron_activations \
         WHERE cron_job_id = ?1 AND claim_state NOT IN ('completed','failed','cancelled'))",
        [job_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|v| v != 0)
    .map_err(|e| format!("failed to determine active cron activation for '{job_id}': {e}"))
}

/// Cancel an in-flight or pending cron activation.
///
/// Order is deliberate: (1) persist the durable cancellation request, (2)
/// subscribe to the task acknowledgement, (3) signal the tracked `/cron/run`
/// operation, (4) await (bounded) the task's acknowledgement that it observed
/// the cancellation and its request actually completed. Only then is the
/// activation recorded `cancelled`, and only after that write commits is success
/// reported. If no tracked execution exists or no acknowledgement arrives, the
/// durable request is kept and the activation is settled to the actionable
/// `ambiguous` state — cancellation is never asserted without proof. Returns
/// `Ok(true)` when the cancel is proven and persisted, OR as an idempotent
/// no-op success when no active activation exists (nothing was running to
/// stop); `Ok(false)` only when an active run's cancellation is durable but
/// unconfirmed; `Err` when a durable write could not be completed. No SQLite or
/// registry lock is held while awaiting the acknowledgement.
pub async fn request_cron_cancellation(
    app: &AppHandle,
    job_id: &str,
    reason: &str,
) -> Result<bool, String> {
    // Persist intent first, before any signalling.
    let activation_id = persist_cancellation_intent(app, job_id, reason)?;

    // No durable active activation means no in-flight effect exists. This is an
    // idempotent successful no-op: there is no run to stop, so report success
    // without setting a process-local cancel flag (which would block future
    // recurrence) and without claiming an active run was cancelled.
    let Some(id) = activation_id else {
        take_cancel_request(job_id);
        return Ok(true);
    };

    // Subscribe to the acknowledgement BEFORE signalling so a fast worker cannot
    // publish before the receiver exists. Take the signal sender under the same
    // lock, then release all locks before awaiting.
    let control = {
        let guard = cancel_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.get(job_id).and_then(|control| {
            if control.activation_id != id {
                return None;
            }
            Some((control.signal_tx.clone(), control.ack_tx.subscribe()))
        })
    };

    // Record the in-process cancel flag so concurrent claims observe it.
    {
        let mut guard = cancel_requests().lock().unwrap_or_else(|p| p.into_inner());
        guard.insert(job_id.to_string());
    }

    let Some((signal_tx, mut ack_rx)) = control else {
        // No tracked execution for this activation: signal sent is impossible,
        // so settle to the actionable ambiguous state (persisted).
        settle_cancellation_unconfirmed(app, job_id)?;
        return Ok(false);
    };

    // Signal after subscribing so the ack cannot be missed.
    let _ = signal_tx.send(true);

    // Only `Ok(Ok(()))` is an acknowledgement; a closed channel (`Ok(Err(_))`)
    // or a timeout is NOT.
    let acknowledged = matches!(
        tokio::time::timeout(Duration::from_secs(15), ack_rx.recv()).await,
        Ok(Ok(()))
    );

    if acknowledged {
        // Persist the confirmed terminal state; only then report success.
        mark_activation_cancelled(app, &id, reason)?;
        Ok(true)
    } else {
        settle_cancellation_unconfirmed(app, job_id)?;
        Ok(false)
    }
}

/// Cancel only the cron jobs linked to a specific Goal, including their active
/// runs. Job ids come from the authoritative `cron_jobs.goal_id` column; a DB
/// error fails closed (no cancellation is attempted). Unrelated and unlinked
/// jobs are never touched. Future activation for a terminal Goal is separately
/// blocked at claim time. Every linked job is attempted; per-job persistence
/// failures are collected and surfaced so a partial failure cannot be mistaken
/// for a clean cancellation.
pub async fn cancel_goal_in_flight(
    app: &AppHandle,
    goal_id: &str,
    reason: &str,
) -> Result<usize, String> {
    let job_ids: Vec<String> = {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare("SELECT id FROM cron_jobs WHERE goal_id = ?1")
            .map_err(|e| format!("failed to resolve goal cron jobs: {e}"))?;
        let rows = stmt
            .query_map([goal_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("failed to resolve goal cron jobs: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("failed to resolve goal cron jobs: {e}"))?;
        rows
    };

    let mut confirmed = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for job_id in &job_ids {
        // A persistence failure for one job does not prevent cancelling the
        // others, but it must be surfaced rather than swallowed.
        match request_cron_cancellation(app, job_id, reason).await {
            Ok(true) => confirmed += 1,
            // Durable-but-unconfirmed stays ambiguous; not silently confirmed.
            Ok(false) => {}
            Err(e) => errors.push(format!("{job_id}: {e}")),
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "cancellation persistence failed for {} of {} goal-linked cron job(s): {}",
            errors.len(),
            job_ids.len(),
            errors.join("; ")
        ));
    }
    Ok(confirmed)
}

/// Validate that `schedule_expr` can be parsed into a valid cron schedule.
pub fn validate_cron_schedule(schedule_expr: &str) -> Result<(), String> {
    let seven = five_to_seven_field(schedule_expr);
    match Schedule::from_str(&seven) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!(
            "Invalid cron expression '{}': {}",
            schedule_expr, e
        )),
    }
}

/// Probe candidate Bun-server URLs and return the first healthy one.
pub async fn resolve_jarvis_url(client: &Client) -> String {
    let local_candidates = crate::wsl::local_jarvis_api_candidates();
    for candidate in &local_candidates {
        let probe = format!("{}/health", candidate);
        if client
            .get(&probe)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            crate::wsl::set_cached_bun_url(candidate.clone());
            return candidate.clone();
        }
    }

    crate::wsl::clear_cached_bun_url();

    let candidates = tokio::task::spawn_blocking(crate::wsl::jarvis_api_candidates)
        .await
        .unwrap_or_default();
    for candidate in candidates {
        if local_candidates.contains(&candidate) {
            continue;
        }
        let probe = format!("{}/health", candidate);
        if client
            .get(&probe)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            crate::wsl::set_cached_bun_url(candidate.clone());
            return candidate;
        }
    }
    "http://127.0.0.1:19877".to_string()
}

/// Serializable projection snapshot mirroring TypeScript's `ProjectionSnapshot`.
/// Passed inline to the Bun server so it can call `restoreBoundary()` without
/// needing direct access to the Tauri SQLite database. A built-in Jarvis
/// snapshot legitimately has empty source/hash fields (default runtime
/// instructions); a custom Agent snapshot always carries a validated hash.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProjectionSnapshot {
    pub slug: String,
    pub source_path: String,
    pub source_hash: String,
    pub active_source_hash: String,
    pub projection_version: i64,
    pub activated_at: String,
}

/// Result of dispatching a cron job to the Bun server.
#[derive(Debug, Clone)]
pub struct CronDispatchResult {
    pub output: String,
    pub error: Option<String>,
    pub execution_evidence: Option<String>,
    /// The Bun-executed run identity from `execution_evidence.run_id`, used to
    /// correlate the durable run record with the accepted-output evidence chain.
    pub bun_run_id: Option<String>,
    /// True only when the dispatch was actually aborted by the cancellation
    /// branch winning the request/response `select!`. A signal that arrives after
    /// the response already completed is NOT reflected here, so a successful run
    /// is never misclassified as cancelled.
    pub cancelled: bool,
}

/// Failure of a cron dispatch, distinguishing a fail-closed authority denial
/// (which must be recorded as a durable `blocked`/`waiting_for_user` activation,
/// never a failed run) from an ordinary transport/runtime error.
#[derive(Debug, Clone)]
pub enum CronDispatchError {
    /// A final-boundary authority denial: the activation must be settled to a
    /// schema-valid denied state with this reason, and no run/request occurs.
    Denied(crate::commands::agents::ActivationDenial),
    /// An ordinary transport/runtime failure (HTTP, parse, timeout).
    Transport(String),
}

impl CronDispatchError {
    pub fn message(&self) -> &str {
        match self {
            CronDispatchError::Denied(denial) => denial.reason(),
            CronDispatchError::Transport(message) => message,
        }
    }
}

/// Dispatch a cron job via the Bun server's `/cron/run` endpoint.
///
/// Replaces the previous `/chat/stream` path:
///   - Passes the prompt AND a projection snapshot (if available) so the Bun server
///     can bind an `ActivationBoundary` before running.
///   - The Bun server creates a non-interactive `ExecutionContext` (surface: "cron")
///     and routes all tool calls through the canonical `ToolRuntime`.
///   - Returns JSON rather than an SSE stream, eliminating the SSE accumulation loop.
pub async fn dispatch_cron_job(
    app: &AppHandle,
    job_id: &str,
    activation_id: Option<&str>,
    cancel: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<CronDispatchResult, CronDispatchError> {
    let (prompt, agent_id, snapshot) = {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

        // Final-boundary identity revalidation. Re-read the CURRENT cron job tuple
        // and the claimed activation row and require an exact identity match, then
        // revalidate the Goal and Session/projection authority. Any SQL error or
        // stale/mismatched identity fails closed. The revalidated tuple below is
        // the one carried into the HTTP body.
        let (prompt, job_agent, job_session, job_goal, job_enabled): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
        ) = conn
            .query_row(
                "SELECT prompt, agent_id, session_id, goal_id, enabled FROM cron_jobs WHERE id = ?1",
                [job_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(|e| {
                CronDispatchError::Denied(crate::commands::agents::ActivationDenial::Blocked(
                    format!("cron job authority unreadable or missing: {e}"),
                ))
            })?;

        // A job disabled after claim must not dispatch.
        if job_enabled == 0 {
            return Err(CronDispatchError::Denied(
                crate::commands::agents::ActivationDenial::WaitingForUser(format!(
                    "cron job '{}' was disabled before dispatch",
                    job_id
                )),
            ));
        }

        let sender_agent = job_agent
            .as_deref()
            .ok_or_else(|| CronDispatchError::Denied(
                crate::commands::agents::ActivationDenial::Blocked(
                    "cron job has no Agent identity; refusing dispatch".to_string(),
                ),
            ))?;

        // Captured claim workspace policy, if this is a claimed activation. It is
        // compared against the current canonical Goal/Session workspace below.
        let mut claim_root: Option<String> = None;

        // The exact claim-time Agent projection identity. Final dispatch
        // re-resolves the projection and must match this field-for-field; a
        // claim row that carries no captured identity fails closed rather than
        // dispatching under an unverified projection.
        let mut stored_projection: Option<ProjectionSnapshot> = None;

        // When called from a claimed activation, the activation row captured at
        // claim time must still match this job exactly. An unreadable/missing/
        // malformed authority row is a fail-closed denial, not a runtime failure.
        if let Some(aid) = activation_id {
            #[allow(clippy::type_complexity)]
            let claimed: Option<(
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<i64>,
                Option<String>,
            )> = conn
                .query_row(
                    "SELECT agent_id, session_id, goal_id, project_root, claim_state, \
                     projection_slug, projection_source_path, projection_source_hash, \
                     projection_active_source_hash, projection_version, projection_activated_at \
                     FROM cron_activations WHERE activation_id = ?1",
                    [aid],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                            row.get(8)?,
                            row.get(9)?,
                            row.get(10)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| {
                    CronDispatchError::Denied(crate::commands::agents::ActivationDenial::Blocked(
                        format!("activation authority unreadable: {e}"),
                    ))
                })?;
            let Some((
                claim_agent,
                claim_session,
                claim_goal,
                claimed_root,
                claim_state,
                claim_projection_slug,
                claim_projection_source_path,
                claim_projection_source_hash,
                claim_projection_active_source_hash,
                claim_projection_version,
                claim_projection_activated_at,
            )) = claimed
            else {
                return Err(CronDispatchError::Denied(
                    crate::commands::agents::ActivationDenial::Blocked(format!(
                        "activation '{aid}' not found at dispatch"
                    )),
                ));
            };
            if claim_state != "claimed" && claim_state != "dispatched" {
                return Err(CronDispatchError::Denied(
                    crate::commands::agents::ActivationDenial::Blocked(format!(
                        "activation '{aid}' is no longer dispatchable (state '{claim_state}')"
                    )),
                ));
            }
            if claim_agent != sender_agent
                || claim_session != job_session
                || claim_goal != job_goal
            {
                return Err(CronDispatchError::Denied(
                    crate::commands::agents::ActivationDenial::Blocked(
                        "cron job identity changed after claim; refusing dispatch".to_string(),
                    ),
                ));
            }
            // A schema-valid claim always captured slug and source hash (the
            // built-in Jarvis default is an explicit empty hash, not NULL). A
            // NULL means the claim predates projection identity capture; refuse
            // rather than dispatch under an unverified projection.
            let (Some(claim_projection_slug), Some(claim_projection_source_hash)) =
                (claim_projection_slug, claim_projection_source_hash)
            else {
                return Err(CronDispatchError::Denied(
                    crate::commands::agents::ActivationDenial::Blocked(
                        "activation has no claim-time projection identity; refusing dispatch"
                            .to_string(),
                    ),
                ));
            };
            stored_projection = Some(ProjectionSnapshot {
                slug: claim_projection_slug,
                source_path: claim_projection_source_path.unwrap_or_default(),
                source_hash: claim_projection_source_hash,
                active_source_hash: claim_projection_active_source_hash.unwrap_or_default(),
                projection_version: claim_projection_version.unwrap_or(0),
                activated_at: claim_projection_activated_at.unwrap_or_default(),
            });
            claim_root = claimed_root;
        }

        // Goal authority must still permit activation for the CURRENT job row.
        // The canonical Goal project_root returned here is the authority the
        // claim's captured workspace must match exactly.
        let mut goal_root: Option<String> = None;
        if let Some(ref gid) = job_goal {
            let goal = crate::commands::goals::validate_cron_goal_activation(&conn, gid, job_id)
                .map_err(|e| {
                    CronDispatchError::Denied(crate::commands::agents::ActivationDenial::Blocked(
                        format!("goal association blocks activation: {e}"),
                    ))
                })?;
            goal_root = goal.project_root;
        }

        // A bound Session must still match its actual Agent/workspace authority
        // and the job's Agent. The Session's canonical project_root is retained so
        // the claim's captured workspace can be checked against it.
        let mut session_root: Option<String> = None;
        if let Some(ref sid) = job_session {
            let session_row: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT agent_id, project_root FROM sessions WHERE id = ?1",
                    [sid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| {
                    CronDispatchError::Denied(crate::commands::agents::ActivationDenial::Blocked(
                        format!("bound session authority unreadable: {e}"),
                    ))
                })?;
            let (session_agent, session_project_root) = session_row.ok_or_else(|| {
                CronDispatchError::Denied(crate::commands::agents::ActivationDenial::Blocked(
                    format!("bound session '{sid}' no longer exists"),
                ))
            })?;
            if session_agent != sender_agent {
                return Err(CronDispatchError::Denied(
                    crate::commands::agents::ActivationDenial::Blocked(format!(
                        "bound session '{sid}' belongs to Agent '{session_agent}', not '{sender_agent}'"
                    )),
                ));
            }
            session_root = session_project_root;
        }

        // The claim's captured workspace must equal the current authoritative
        // workspace EXACTLY, including a None<->Some change. For a linked job that
        // is the canonical Goal scope; the bound Session (if any) must also agree
        // with it. For an unlinked job the bound Session's canonical workspace is
        // the authority; if neither is present the authority is None. Scope is
        // never inferred from a client-supplied value.
        let authoritative_root: Option<&str> = match goal_root.as_deref() {
            Some(goal_root) => {
                if let Some(ref session_root) = session_root {
                    if session_root != goal_root {
                        return Err(CronDispatchError::Denied(
                            crate::commands::agents::ActivationDenial::Blocked(
                                "bound session workspace does not match goal scope".to_string(),
                            ),
                        ));
                    }
                }
                Some(goal_root)
            }
            None => session_root.as_deref(),
        };
        if claim_root.as_deref() != authoritative_root {
            return Err(CronDispatchError::Denied(
                crate::commands::agents::ActivationDenial::Blocked(
                    "cron activation workspace changed after claim; refusing dispatch".to_string(),
                ),
            ));
        }

        // Agent enabled/projection status/hash must still pass. The returned
        // snapshot is exactly what the HTTP body will carry.
        let snapshot = crate::commands::agents::resolve_activation_boundary(&conn, sender_agent)
            .map_err(CronDispatchError::Denied)?;
        // Require exact equality with the claim-time projection identity. A
        // changed source hash, version, path, or activation time means the Agent
        // instructions were replaced after the claim; never execute the changed
        // projection. The denial is persisted durably by the caller as a
        // blocked activation. The built-in Jarvis default (explicit empty
        // identity) is preserved: both snapshots are empty and compare equal.
        if matches!(&stored_projection, Some(stored) if stored != &snapshot) {
            return Err(CronDispatchError::Denied(
                crate::commands::agents::ActivationDenial::Blocked(
                    "agent projection changed after claim; refusing dispatch".to_string(),
                ),
            ));
        }
        let snapshot = if snapshot.source_hash.is_empty() {
            None
        } else {
            Some(snapshot)
        };

        (prompt, job_agent, snapshot)
    };
    let agent_id = agent_id;

    // Each automated run gets a fresh isolated session
    let run_session = uuid::Uuid::new_v4().to_string();

    let client = Client::new();
    let base_url = resolve_jarvis_url(&client).await;
    let url = format!("{}/cron/run", base_url);

    let mut body = json!({
        "job_id": job_id,
        "prompt": prompt,
        "session_id": run_session,
    });
    if let Some(aid) = activation_id {
        body["activation_id"] = serde_json::Value::String(aid.to_string());
    }

    // Attach agent_id and projection snapshot if available
    if let Some(ref aid) = agent_id {
        body["agent_id"] = serde_json::Value::String(aid.clone());
    }
    if let Some(ref snap) = snapshot {
        body["projection_snapshot"] = serde_json::to_value(snap).unwrap_or(serde_json::Value::Null);
    }

    let request = client
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(STREAM_TIMEOUT_SECS))
        .send();

    // Race the request send/response-header wait against cancellation. Dropping
    // the in-progress request future closes the connection, which aborts the
    // upstream `/cron/run` request signal Bun passes into inference. This also
    // stops a stalled header wait, not just the body read. `biased;` with the
    // request branch first makes a simultaneously-ready completion win the tie:
    // an already-arrived response is recorded as its actual success/failure, and
    // cancellation is reported only when the request is still pending.
    let response = match cancel.clone() {
        Some(mut rx) => {
            tokio::select! {
                biased;
                result = request => result.map_err(|e| CronDispatchError::Transport(format!("HTTP request failed: {}", e)))?,
                _ = rx.changed() => {
                    return Ok(CronDispatchResult {
                        output: String::new(),
                        error: Some("cron execution cancelled".to_string()),
                        execution_evidence: None,
                        bun_run_id: None,
                        cancelled: true,
                    });
                }
            }
        }
        None => request
            .await
            .map_err(|e| CronDispatchError::Transport(format!("HTTP request failed: {}", e)))?,
    };

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(CronDispatchError::Transport(format!(
            "Cron run server returned {}: {}",
            status, text
        )));
    }

    // Read the body while racing the tracked cancel signal. Dropping the response
    // future closes the connection, which aborts the upstream `/cron/run` request
    // (the request signal Bun passes into inference). `biased;` with the body
    // branch first makes an already-completed body win the tie, so a response
    // that arrived before/with the cancel is recorded as its actual result and
    // cancellation fires only while the body read is still pending.
    let text_future = response.text();
    let raw_body: String = match cancel {
        Some(mut rx) => {
            tokio::select! {
                biased;
                result = text_future => {
                    result.map_err(|e| CronDispatchError::Transport(format!("Failed to read cron run response: {}", e)))?
                }
                _ = rx.changed() => {
                    return Ok(CronDispatchResult {
                        output: String::new(),
                        error: Some("cron execution cancelled".to_string()),
                        execution_evidence: None,
                        bun_run_id: None,
                        cancelled: true,
                    });
                }
            }
        }
        None => text_future
            .await
            .map_err(|e| CronDispatchError::Transport(format!("Failed to read cron run response: {}", e)))?,
    };

    let result: serde_json::Value = serde_json::from_str(&raw_body)
        .map_err(|e| CronDispatchError::Transport(format!("Failed to parse cron run response: {}", e)))?;

    let output = result["output"].as_str().unwrap_or("").to_string();
    let error = result["error"].as_str().map(|s| s.to_string());
    let execution_evidence = result.get("execution_evidence").map(|v| v.to_string());
    let bun_run_id = result
        .get("execution_evidence")
        .and_then(|v| v.get("run_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if result["success"].as_bool().unwrap_or(false) {
        Ok(CronDispatchResult {
            output,
            error: None,
            execution_evidence,
            bun_run_id,
            cancelled: false,
        })
    } else {
        Ok(CronDispatchResult {
            output,
            error: error.or(Some("cron run failed with unknown error".to_string())),
            execution_evidence,
            bun_run_id,
            cancelled: false,
        })
    }
}

/// Insert a `cron_runs` row and update the job's `last_run` / `next_run`, then
/// settle the correlated activation claim. Correlation columns are nullable so
/// legacy/unlinked runs remain readable. Returns true when the terminal claim
/// settlement was durably applied (or there was no activation to settle), false
/// when the settle write failed, so a cancellation acknowledgement is never sent
/// before its terminal state is persisted.
#[allow(clippy::too_many_arguments)]
fn record_run(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    output: &str,
    error: &str,
    duration_ms: i64,
    started_at: &str,
    next_run: Option<&str>,
    execution_evidence: Option<&str>,
    activation: Option<&ActivationContext>,
) -> bool {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let run_id = uuid::Uuid::new_v4().to_string();
    let finished_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    let (activation_id, schedule_occurrence, goal_id, bun_run_id) = match activation {
        Some(ctx) => (
            Some(ctx.activation_id.as_str()),
            Some(ctx.schedule_occurrence.as_str()),
            ctx.goal_id.as_deref(),
            ctx.bun_run_id.as_deref(),
        ),
        None => (None, None, None, None),
    };

    if let Err(e) = conn.execute(
        "INSERT INTO cron_runs \
         (id, cron_job_id, status, output, error, duration_ms, started_at, finished_at, \
          execution_evidence, activation_id, schedule_occurrence, goal_id, terminal_reason) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            run_id,
            job_id,
            status,
            output,
            error,
            duration_ms,
            started_at,
            finished_at,
            execution_evidence,
            activation_id,
            schedule_occurrence,
            goal_id,
            error,
        ],
    ) {
        eprintln!(
            "[cron] Failed to insert cron run log for job {}: {}",
            job_id, e
        );
    }

    if let Err(e) = conn.execute(
        "UPDATE cron_jobs SET \
         last_run = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
         run_count = run_count + 1, \
         next_run = ?, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = ?",
        rusqlite::params![next_run, job_id],
    ) {
        eprintln!(
            "[cron] Failed to update cron job run metadata for {}: {}",
            job_id, e
        );
    }

    // Settle the activation claim. A completed/failed/cancelled terminal state
    // is never revived: in particular a late success can never overwrite an
    // accepted cancellation. The `WHERE` guard makes late/duplicate settles
    // idempotent no-ops. `settled` tracks whether the durable settlement write
    // succeeded so a caller never acknowledges before persisting.
    let mut settled = true;
    if let Some(ctx) = activation {
        let claim_state = if status == "success" {
            "completed"
        } else if status == "cancelled" {
            "cancelled"
        } else {
            "failed"
        };
        if let Err(e) = conn.execute(
            "UPDATE cron_activations SET claim_state = ?1, run_id = ?2, bun_run_id = ?3, \
             terminal_reason = ?4, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE activation_id = ?5 \
             AND (claim_state NOT IN ('cancelled','completed','failed') OR claim_state = ?1)",
            rusqlite::params![
                claim_state,
                run_id,
                bun_run_id,
                error,
                ctx.activation_id.as_str()
            ],
        ) {
            eprintln!(
                "[cron] Failed to settle activation {} for job {}: {}",
                ctx.activation_id, job_id, e
            );
            settled = false;
        }
        // A settled non-cancelled outcome clears any stale cancel intent (both
        // the in-process flag and the durable columns) so the next legitimate
        // recurring occurrence can start clean and is never blocked by an old
        // cancellation request.
        if claim_state != "cancelled" {
            take_cancel_request(job_id);
            let _ = conn.execute(
                "UPDATE cron_activations SET cancel_requested_at = NULL, \
                 cancel_requested_reason = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                 WHERE activation_id = ?1",
                [ctx.activation_id.as_str()],
            );
        } else {
            // A proven cancellation also clears the in-process flag so a future
            // recurring activation is permitted.
            take_cancel_request(job_id);
        }

        // Preference-aware in-app notification, emitted ONLY after the terminal
        // state and the durable run row are persisted, and only for a
        // Goal-linked activation. A `success` is reported as a verified
        // scheduled-run completion, never as Goal completion or acceptance.
        if settled && ctx.goal_id.is_some() {
            let goal_id = ctx.goal_id.as_deref().unwrap_or_default();
            let request = match claim_state {
                "completed" => crate::notifications::completed_request(
                    goal_id,
                    &ctx.activation_id,
                    job_id,
                    &run_id,
                    &run_id,
                ),
                "cancelled" => crate::notifications::cancelled_request(
                    goal_id,
                    &ctx.activation_id,
                    job_id,
                    Some(&run_id),
                    &run_id,
                    error,
                ),
                _ => crate::notifications::failed_request(
                    goal_id,
                    &ctx.activation_id,
                    job_id,
                    Some(&run_id),
                    &run_id,
                    error,
                ),
            };
            // Drop the DB lock before emitting; emit re-acquires it.
            drop(conn);
            crate::notifications::emit_goal_notifications(app, vec![request]);
            return settled;
        }
    }

    // Prune runs for this job to keep only the last 100 entries.
    // This prevents SQLite database footprint bloat over time.
    if let Err(e) = conn.execute(
        "DELETE FROM cron_runs \
         WHERE cron_job_id = ? \
         AND id NOT IN ( \
             SELECT id FROM cron_runs \
             WHERE cron_job_id = ? \
             ORDER BY started_at DESC \
             LIMIT 100 \
         )",
        rusqlite::params![job_id, job_id],
    ) {
        eprintln!(
            "[cron] Failed to prune older runs for job {}: {}",
            job_id, e
        );
    }

    settled
}

/// Correlation carried from the claimed activation into the dispatch/run record.
struct ActivationContext {
    activation_id: String,
    schedule_occurrence: String,
    goal_id: Option<String>,
    bun_run_id: Option<String>,
}

/// Execute a single cron job: claim the deterministic occurrence, dispatch it,
/// and record the correlated result. `occurrence_override` supplies the due
/// occurrence for scheduled polls; when `None` (manual/missed triggers) the
/// current stored `next_run` is used as the occurrence key.
pub async fn execute_job(
    app: &AppHandle,
    job_id: &str,
    schedule_expr: &str,
    trigger_kind: &str,
    occurrence_override: Option<&str>,
) -> Result<String, String> {
    // Claim first. A durable prior claim for this occurrence is never
    // re-dispatched; errors (disabled/missing job, terminal Goal association,
    // invalid occurrence) fail closed before any dispatch.
    let claim = claim_activation(app, job_id, schedule_expr, trigger_kind, occurrence_override)?;
    let Some(activation_id) = claim else {
        eprintln!(
            "[cron] {} occurrence already claimed; skipping dispatch",
            job_id
        );
        return Ok(String::new());
    };

    {
        let mut guard = get_in_flight_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if guard.contains(job_id) {
            // The claim is durable but the in-flight guard refused. Leave the
            // claim as `claimed`; reconcile marks it ambiguous rather than
            // replaying blindly.
            return Err(format!("Cron job '{}' is already running.", job_id));
        }
        guard.insert(job_id.to_string());
    }

    let schedule_occurrence = occurrence_source(app, job_id, occurrence_override);
    let goal_id = cron_job_goal_id(app, job_id);

    // Transition the claim to `dispatched` before the external effect so a crash
    // mid-dispatch is recoverable as `ambiguous`, not a silent replay.
    update_claim_state(app, &activation_id, "dispatched", None);

    // Meaningful progress notification: this fires once per claimed Goal-linked
    // occurrence (the durable `dispatched` state is the dedupe identity), not on
    // every internal step. Only after the claim state is persisted.
    if let Some(ref gid) = goal_id {
        let request = crate::notifications::progress_request(
            gid,
            &activation_id,
            job_id,
            &activation_id,
            "dispatched",
        );
        crate::notifications::emit_goal_notifications(app, vec![request]);
    }

    // Register a cancellation control for this execution and re-check the cancel
    // intent under the registry lock so a cancel cannot slip between the
    // pre-claim check and registration.
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let (ack_tx, _ack_keepalive) = tokio::sync::broadcast::channel::<()>(4);
    let mut pre_cancelled = false;
    {
        let mut guard = cancel_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.insert(
            job_id.to_string(),
            CancelControl {
                activation_id: activation_id.clone(),
                signal_tx: cancel_tx.clone(),
                ack_tx: ack_tx.clone(),
            },
        );
        if is_cancel_requested(job_id) {
            pre_cancelled = true;
        }
    }
    if pre_cancelled {
        let _ = cancel_tx.send(true);
        release_cancel_registration(job_id);
        // Persist the cancelled terminal state BEFORE acknowledging: the ack must
        // represent task-observed abort + durable settlement. If persistence
        // fails, do not ack (a concurrent waiter then settles ambiguous).
        if mark_activation_cancelled(app, &activation_id, "cancelled before dispatch").is_ok() {
            let _ = ack_tx.send(());
        }
        release_in_flight(job_id);
        return Ok(String::new());
    }

    let started_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let start = std::time::Instant::now();
    let dispatch_result =
        dispatch_cron_job(app, job_id, Some(&activation_id), Some(cancel_rx)).await;
    let duration_ms = start.elapsed().as_millis() as i64;
    let next_run = compute_next_run(schedule_expr);

    // Always release the registration before recording so a cancel that arrives
    // after the channel is removed sees no target and settles as unconfirmed.
    release_cancel_registration(job_id);

    // Cancellation is only real when dispatch itself was aborted by the cancel
    // branch winning the request/response `select!`. A signal that arrived after
    // the response already completed did NOT cancel the run: the actual
    // completed/failed result is preserved, and any concurrent cancellation
    // request remains unconfirmed (the caller settles it as `ambiguous`).
    let cancelled = matches!(&dispatch_result, Ok(dispatch) if dispatch.cancelled);
    if cancelled {
        let reason = if is_cancel_requested(job_id) {
            "user cancelled"
        } else {
            "execution aborted"
        };
        let context = ActivationContext {
            activation_id: activation_id.clone(),
            schedule_occurrence: schedule_occurrence.clone().unwrap_or_default(),
            goal_id: goal_id.clone(),
            bun_run_id: None,
        };
        // record_run settles the activation to `cancelled`. The ack must only be
        // sent after that durable settlement succeeds, so it represents
        // task-observed abort + closed request + durable terminal state.
        let settled = record_run(
            app,
            job_id,
            "cancelled",
            "",
            reason,
            duration_ms,
            &started_at,
            next_run.as_deref(),
            None,
            Some(&context),
        );
        if settled {
            let _ = ack_tx.send(());
        }
        release_in_flight(job_id);
        return Ok(String::new());
    }

    match &dispatch_result {
        Ok(dispatch) => {
            let status = if dispatch.error.is_none() {
                "success"
            } else {
                "failed"
            };
            let context = ActivationContext {
                activation_id: activation_id.clone(),
                schedule_occurrence: schedule_occurrence.clone().unwrap_or_default(),
                goal_id: goal_id.clone(),
                bun_run_id: dispatch.bun_run_id.clone(),
            };
            record_run(
                app,
                job_id,
                status,
                &dispatch.output,
                dispatch.error.as_deref().unwrap_or(""),
                duration_ms,
                &started_at,
                next_run.as_deref(),
                dispatch.execution_evidence.as_deref(),
                Some(&context),
            );
        }
        Err(CronDispatchError::Denied(denial)) => {
            // A final-boundary authority denial is NOT a runtime failure. Durably
            // settle the claimed activation to the schema-valid denied state with
            // the specific reason; create no run and send no request. The dedupe
            // key means reconcile never replays this occurrence. A persistence
            // failure is surfaced rather than claiming a durable denied state.
            if let Err(e) =
                settle_activation_denied(app, &activation_id, denial.claim_state(), denial.reason())
            {
                release_in_flight(job_id);
                return Err(e);
            }
        }
        Err(CronDispatchError::Transport(err)) => {
            let context = ActivationContext {
                activation_id: activation_id.clone(),
                schedule_occurrence: schedule_occurrence.clone().unwrap_or_default(),
                goal_id: goal_id.clone(),
                bun_run_id: None,
            };
            record_run(
                app,
                job_id,
                "failed",
                "",
                err,
                duration_ms,
                &started_at,
                next_run.as_deref(),
                None,
                Some(&context),
            );
        }
    }

    release_in_flight(job_id);

    dispatch_result
        .map(|d| d.output)
        .map_err(|err| err.message().to_string())
}

/// Remove the abort token registration for a job.
fn release_cancel_registration(job_id: &str) {
    let mut guard = cancel_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    guard.remove(job_id);
}

/// Remove the in-flight guard for a job.
fn release_in_flight(job_id: &str) {
    let mut guard = get_in_flight_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    guard.remove(job_id);
}

/// Read the occurrence key that `claim_activation` derived, for correlation into
/// the run record. Mirrors the claim derivation (override, else stored next_run).
fn occurrence_source(app: &AppHandle, job_id: &str, override_next: Option<&str>) -> Option<String> {
    if let Some(value) = override_next {
        return scheduled_occurrence_at(value).map(|ms| ms.to_string());
    }
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let stored: Option<String> = conn
        .query_row("SELECT next_run FROM cron_jobs WHERE id = ?1", [job_id], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten();
    stored.and_then(|value| scheduled_occurrence_at(&value).map(|ms| ms.to_string()))
}

/// Read the cron job's validated Goal association for run attribution.
fn cron_job_goal_id(app: &AppHandle, job_id: &str) -> Option<String> {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    conn.query_row("SELECT goal_id FROM cron_jobs WHERE id = ?1", [job_id], |r| {
        r.get(0)
    })
    .optional()
    .ok()
    .flatten()
}

/// Move one activation claim to a new state, preserving a stable terminal reason.
fn update_claim_state(app: &AppHandle, activation_id: &str, state: &str, reason: Option<&str>) {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    if let Err(e) = conn.execute(
        "UPDATE cron_activations SET claim_state = ?1, \
         terminal_reason = COALESCE(?2, terminal_reason), \
         dispatched_at = CASE WHEN ?1 = 'dispatched' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dispatched_at END, \
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE activation_id = ?3",
        rusqlite::params![state, reason, activation_id],
    ) {
        eprintln!(
            "[cron] Failed to update activation {} state to {}: {}",
            activation_id, state, e
        );
    }
}

/// Detect jobs whose `next_run` has already passed (missed while the app was closed).
fn detect_missed_jobs(app: &AppHandle) {
    #[derive(serde::Serialize, Clone)]
    struct MissedJob {
        id: String,
        name: String,
        schedule: String,
        next_run: String,
    }

    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = match conn.prepare(
        "SELECT id, name, schedule, next_run FROM cron_jobs \
         WHERE enabled = 1 \
         AND next_run IS NOT NULL \
         AND next_run < strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[cron] missed-job query error: {}", e);
            return;
        }
    };

    let missed: Vec<MissedJob> = stmt
        .query_map([], |row| {
            Ok(MissedJob {
                id: row.get(0)?,
                name: row.get(1)?,
                schedule: row.get(2)?,
                next_run: row.get(3)?,
            })
        })
        .into_iter()
        .flatten()
        .filter_map(|r| r.ok())
        .collect();

    if !missed.is_empty() {
        {
            let mut guard = get_pending_missed_registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            for m in &missed {
                guard.insert(m.id.clone());
            }
        }
        eprintln!("[cron] {} missed job(s) detected on startup", missed.len());
        let _ = app.emit("cron://missed-jobs", missed);
    }
}

/// Scheduler loop — spawned once at app startup.
pub async fn start_cron_scheduler(app: AppHandle) {
    {
        let db = app.state::<AppDb>();
        let conn = db
            .conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match ensure_inference_feedback_job(&conn) {
            Ok(true) => println!("[cron] seeded deterministic inference-feedback job"),
            Ok(false) => {}
            Err(error) => eprintln!("[cron] {error}"),
        }
    }
    tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS)).await;

    // Reconcile any activation claims interrupted by the previous shutdown before
    // scheduling resumes; ambiguous claims are never auto-replayed.
    reconcile_activations(&app);

    detect_missed_jobs(&app);

    let mut ticker = interval(Duration::from_secs(POLL_INTERVAL_SECS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;

        let due_jobs: Vec<(String, String, Option<String>)> = {
            let db = app.state::<AppDb>();
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            let mut stmt = match conn.prepare(
                "SELECT id, schedule, next_run FROM cron_jobs \
                 WHERE enabled = 1 \
                 AND next_run IS NOT NULL \
                 AND next_run <= strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            ) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[cron] query error: {}", e);
                    continue;
                }
            };
            let collected: Vec<(String, String, Option<String>)> = match stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            {
                Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                Err(e) => {
                    eprintln!("[cron] row error: {}", e);
                    vec![]
                }
            };
            collected
        };

        for (job_id, schedule_expr, due_next_run) in due_jobs {
            {
                let pending_missed = get_pending_missed_registry()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if pending_missed.contains(&job_id) {
                    eprintln!(
                        "[cron] {} is pending missed action — skipping auto-trigger",
                        job_id
                    );
                    continue;
                }
            }

            {
                let guard = get_in_flight_registry()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if guard.contains(&job_id) {
                    eprintln!("[cron] {} still running — skipping tick", job_id);
                    continue;
                }
            }

            let app_clone = app.clone();
            let occurrence = due_next_run;
            tokio::spawn(async move {
                match execute_job(
                    &app_clone,
                    &job_id,
                    &schedule_expr,
                    "schedule",
                    occurrence.as_deref(),
                )
                .await
                {
                    Ok(out) => println!("[cron] {} done ({} chars)", job_id, out.len()),
                    Err(e) => eprintln!("[cron] {} failed: {}", job_id, e),
                }
            });
        }
    }
}

/// Dismiss a pending missed cron job. Removes it from PENDING_MISSED registry,
/// re-computes its `next_run` from now, and updates the database.
pub fn dismiss_missed_job(app: &AppHandle, id: &str) -> Result<bool, String> {
    {
        let mut guard = get_pending_missed_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.remove(id);
    }

    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let schedule: String = conn
        .query_row("SELECT schedule FROM cron_jobs WHERE id = ?", [id], |row| {
            row.get(0)
        })
        .map_err(|e| format!("Cron job '{}' not found: {}", id, e))?;

    let next_run = compute_next_run(&schedule);
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE cron_jobs SET next_run = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![next_run, &now, id],
    )
    .map_err(|e| format!("Failed to update dismissed cron job next_run: {}", e))?;

    Ok(true)
}

/// Trigger a pending missed cron job. Removes it from PENDING_MISSED registry
/// and executes it immediately.
pub async fn trigger_missed_job(app: &AppHandle, id: &str) -> Result<bool, String> {
    {
        let mut guard = get_pending_missed_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.remove(id);
    }

    let schedule_expr = {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row("SELECT schedule FROM cron_jobs WHERE id = ?", [id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("Cron job '{}' not found: {}", id, e))?
    };

    execute_job(app, id, &schedule_expr, "missed", None)
        .await
        .map(|_| true)
}

fn ensure_inference_feedback_job(conn: &rusqlite::Connection) -> Result<bool, String> {
    let next_run = compute_next_run(INFERENCE_FEEDBACK_SCHEDULE)
        .ok_or_else(|| "Could not compute inference-feedback next_run".to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO cron_jobs
         (id, name, schedule, agent_id, prompt, enabled, next_run, metadata)
         VALUES (?, 'Inference telemetry feedback', ?, 'jarvis',
                 '__jarvis_system_inference_feedback__', 1, ?,
                 '{\"system_job\":\"inference_feedback\",\"deterministic\":true}')",
        rusqlite::params![
            INFERENCE_FEEDBACK_CRON_JOB_ID,
            INFERENCE_FEEDBACK_SCHEDULE,
            next_run,
        ],
    )
    .map(|affected| affected > 0)
    .map_err(|error| format!("Failed to seed inference-feedback cron job: {error}"))
}

#[cfg(test)]
mod inference_feedback_job_tests {
    use super::*;

    #[test]
    fn system_feedback_job_is_seeded_idempotently_without_overriding_operator_disable() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE cron_jobs (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL,
                agent_id TEXT NOT NULL DEFAULT 'jarvis', session_id TEXT,
                prompt TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
                last_run TEXT, next_run TEXT, run_count INTEGER NOT NULL DEFAULT 0,
                metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .unwrap();

        assert!(ensure_inference_feedback_job(&conn).unwrap());
        assert!(!ensure_inference_feedback_job(&conn).unwrap());
        let seeded: (String, i64, Option<String>) = conn
            .query_row(
                "SELECT schedule, enabled, next_run FROM cron_jobs WHERE id = ?",
                [INFERENCE_FEEDBACK_CRON_JOB_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(seeded.0, "17 */6 * * *");
        assert_eq!(seeded.1, 1);
        assert!(seeded.2.is_some());

        conn.execute(
            "UPDATE cron_jobs SET enabled = 0 WHERE id = ?",
            [INFERENCE_FEEDBACK_CRON_JOB_ID],
        )
        .unwrap();
        assert!(!ensure_inference_feedback_job(&conn).unwrap());
        let enabled: i64 = conn
            .query_row(
                "SELECT enabled FROM cron_jobs WHERE id = ?",
                [INFERENCE_FEEDBACK_CRON_JOB_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(enabled, 0);
    }
}
