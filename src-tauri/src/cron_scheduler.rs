//! Background cron scheduler — polls due jobs every 60 s and dispatches
//! their prompts to the Bun server, mirroring OpenClaw's architecture:
//! isolated session per run, inFlight guard, missed-task detection on startup,
//! next_run written from fire time (lastFiredAt pattern, no catch-up on missed ticks).

use crate::db::AppDb;
use chrono::Utc;
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
const STREAM_TIMEOUT_SECS: u64 = 180;

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
    if let Some(cached) = crate::wsl::get_cached_bun_url() {
        let probe = format!("{}/health", cached);
        if client
            .get(&probe)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok()
        {
            return cached;
        }
        crate::wsl::clear_cached_bun_url();
    }
    for candidate in crate::wsl::jarvis_api_candidates() {
        let probe = format!("{}/health", candidate);
        if client
            .get(&probe)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok()
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
    projection_version: i64,
    /// ISO-8601 timestamp when this snapshot was captured.
    bound_at: String,
}

/// Query the agent projection for `agent_id` from the native SQLite store.
/// Returns `None` when no valid projection exists for the slug.
fn query_projection_snapshot(
    conn: &rusqlite::Connection,
    agent_id: &str,
) -> Option<ProjectionSnapshot> {
    conn.query_row(
        "SELECT slug, source_path, source_hash, projection_version
         FROM agent_projections
         WHERE slug = ? AND status = 'valid'",
        [agent_id],
        |row| {
            Ok(ProjectionSnapshot {
                slug: row.get(0)?,
                source_path: row.get(1)?,
                source_hash: row.get(2)?,
                projection_version: row.get(3)?,
                bound_at: Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
            })
        },
    )
    .ok()
}

/// Dispatch a cron job via the Bun server's `/cron/run` endpoint.
///
/// Replaces the previous `/chat/stream` path:
///   - Passes the prompt AND a projection snapshot (if available) so the Bun server
///     can bind an `ActivationBoundary` before running.
///   - The Bun server creates a non-interactive `ExecutionContext` (surface: "cron")
///     and routes all tool calls through the canonical `ToolRuntime`.
///   - Returns JSON rather than an SSE stream, eliminating the SSE accumulation loop.
pub async fn dispatch_cron_job(app: &AppHandle, job_id: &str) -> Result<String, String> {
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

        // Attempt to load a valid projection snapshot for the agent
        let snapshot = agent_id
            .as_deref()
            .and_then(|aid| query_projection_snapshot(&conn, aid));

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

    if result["success"].as_bool().unwrap_or(false) {
        Ok(result["output"].as_str().unwrap_or("").to_string())
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("cron run failed with unknown error")
            .to_string())
    }
}

/// Insert a `cron_runs` row and update the job's `last_run` / `next_run`.
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
) {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let run_id = uuid::Uuid::new_v4().to_string();
    let finished_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    if let Err(e) = conn.execute(
        "INSERT INTO cron_runs \
         (id, cron_job_id, status, output, error, duration_ms, started_at, finished_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            run_id,
            job_id,
            status,
            output,
            error,
            duration_ms,
            started_at,
            finished_at
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

/// Execute a single cron job: dispatch it and record the result.
pub async fn execute_job(
    app: &AppHandle,
    job_id: &str,
    schedule_expr: &str,
) -> Result<String, String> {
    {
        let mut guard = get_in_flight_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if guard.contains(job_id) {
            return Err(format!("Cron job '{}' is already running.", job_id));
        }
        guard.insert(job_id.to_string());
    }

    let started_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let start = std::time::Instant::now();
    let result = dispatch_cron_job(app, job_id).await;
    let duration_ms = start.elapsed().as_millis() as i64;
    let next_run = compute_next_run(schedule_expr);

    match result {
        Ok(ref text) => {
            record_run(
                app,
                job_id,
                "success",
                text,
                "",
                duration_ms,
                &started_at,
                next_run.as_deref(),
            );
        }
        Err(ref err) => {
            record_run(
                app,
                job_id,
                "failed",
                "",
                err,
                duration_ms,
                &started_at,
                next_run.as_deref(),
            );
        }
    }

    {
        let mut guard = get_in_flight_registry()
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        guard.remove(job_id);
    }

    result
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
    tokio::time::sleep(Duration::from_secs(INITIAL_DELAY_SECS)).await;

    detect_missed_jobs(&app);

    let mut ticker = interval(Duration::from_secs(POLL_INTERVAL_SECS));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;

        let due_jobs: Vec<(String, String)> = {
            let db = app.state::<AppDb>();
            let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
            let mut stmt = match conn.prepare(
                "SELECT id, schedule FROM cron_jobs \
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
            let collected: Vec<(String, String)> =
                match stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?))) {
                    Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                    Err(e) => {
                        eprintln!("[cron] row error: {}", e);
                        vec![]
                    }
                };
            collected
        };

        for (job_id, schedule_expr) in due_jobs {
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
            tokio::spawn(async move {
                match execute_job(&app_clone, &job_id, &schedule_expr).await {
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

    execute_job(app, id, &schedule_expr).await.map(|_| true)
}
