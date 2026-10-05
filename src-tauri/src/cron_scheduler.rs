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
        let goal = crate::commands::goals::validate_cron_goal_activation(&conn, gid, job_id)
            .map_err(|e| format!("goal association blocks activation: {e}"))?;
        goal_scope = goal.project_root;
    }

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
              schedule_occurrence, trigger_kind, claim_state, claimed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'claimed', \
                     strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            rusqlite::params![
                &activation_id,
                job_id,
                goal_id,
                &agent_id,
                &session_id,
                &goal_scope,
                occurrence.to_string(),
                trigger_kind,
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
/// needing direct access to the Tauri SQLite database.
#[derive(Debug, Clone, serde::Serialize)]
struct ProjectionSnapshot {
    slug: String,
    source_path: String,
    source_hash: String,
    active_source_hash: String,
    projection_version: i64,
    activated_at: String,
}

/// Query the agent projection for `agent_id` from the native SQLite store.
/// Returns `None` when no valid projection exists for the slug.
fn query_projection_snapshot(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> Result<Option<ProjectionSnapshot>, String> {
    let row = conn
        .query_row(
            "SELECT slug, source_path, source_hash, active_source_hash, projection_version,
                    status, active, activated_at
             FROM agent_projections
             WHERE slug = ?",
            [agent_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((
        slug,
        source_path,
        source_hash,
        active_source_hash,
        projection_version,
        status,
        active,
        activated_at,
    )) = row
    else {
        return Ok(None);
    };
    if status != "valid" {
        return Err("projection_invalid".to_string());
    }
    if active == 0 {
        return Err("projection_inactive".to_string());
    }
    let Some(activated_at) = activated_at else {
        return Err("projection_stale".to_string());
    };
    if source_hash.is_empty() || active_source_hash != source_hash {
        return Err("projection_stale".to_string());
    }
    Ok(Some(ProjectionSnapshot {
        slug,
        source_path,
        source_hash,
        active_source_hash,
        projection_version,
        activated_at,
    }))
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
) -> Result<CronDispatchResult, String> {
    let (prompt, agent_id, snapshot) = {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

        // Query prompt and agent_id together
        let (prompt, agent_id): (String, Option<String>) = conn
            .query_row(
                "SELECT prompt, agent_id FROM cron_jobs WHERE id = ?",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("Cron job '{}' not found: {}", job_id, e))?;

        let snapshot = match agent_id.as_deref() {
            Some(aid) => query_projection_snapshot(&conn, aid)?,
            None => None,
        };

        (prompt, agent_id, snapshot)
    };

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

    let response = client
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(STREAM_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Cron run server returned {}: {}", status, text));
    }

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse cron run response: {}", e))?;

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
        })
    } else {
        Ok(CronDispatchResult {
            output,
            error: error.or(Some("cron run failed with unknown error".to_string())),
            execution_evidence,
            bun_run_id,
        })
    }
}

/// Insert a `cron_runs` row and update the job's `last_run` / `next_run`, then
/// settle the correlated activation claim. Correlation columns are nullable so
/// legacy/unlinked runs remain readable.
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
) {
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

    // Settle the activation claim. A completed/failed terminal state is never
    // revived and no occurrence is replayed.
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
             WHERE activation_id = ?5",
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

    let started_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let start = std::time::Instant::now();
    let result = dispatch_cron_job(app, job_id, Some(&activation_id)).await;
    let duration_ms = start.elapsed().as_millis() as i64;
    let next_run = compute_next_run(schedule_expr);

    match &result {
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
        Err(err) => {
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

    {
        let mut guard = get_in_flight_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.remove(job_id);
    }

    result.map(|d| d.output)
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
