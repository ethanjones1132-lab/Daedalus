// ═══════════════════════════════════════════════════════════════
// Cron Commands — SQLite-backed cron job management
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// A cron job stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJob {
    pub id: String,
    pub name: String,
    pub schedule: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub enabled: bool,
    pub last_run: Option<String>,
    pub next_run: Option<String>,
    pub run_count: i64,
    #[serde(default)]
    pub metadata: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronExecutionEvidence {
    pub run_id: String,
    pub status: String,
    #[serde(default)]
    pub acceptance_result: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

/// A single cron job run record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronRun {
    pub id: String,
    pub cron_id: String,
    pub status: String,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub duration_ms: i64,
    pub started_at: String,
    pub finished_at: Option<String>,
    #[serde(default)]
    pub execution_evidence: Option<CronExecutionEvidence>,
}

// ── Commands ─────────────────────────────────────────────────

/// List all cron jobs ordered by created_at DESC.
#[tauri::command]
pub fn list_cron_jobs(db: State<AppDb>) -> Result<Vec<CronJob>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let mut stmt = conn
        .prepare(
            "SELECT id, name, schedule, agent_id, session_id, prompt, enabled,
                    last_run, next_run, run_count, metadata, created_at, updated_at
             FROM cron_jobs
             ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let jobs = stmt
        .query_map([], |row| {
            Ok(CronJob {
                id: row.get(0)?,
                name: row.get(1)?,
                schedule: row.get(2)?,
                agent_id: row.get(3)?,
                session_id: row.get(4)?,
                prompt: row.get(5)?,
                enabled: row.get::<_, i64>(6)? != 0,
                last_run: row.get(7)?,
                next_run: row.get(8)?,
                run_count: row.get(9)?,
                metadata: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(jobs)
}

/// Add a new cron job.
#[tauri::command]
pub fn add_cron_job(
    db: State<AppDb>,
    name: String,
    schedule: String,
    prompt: String,
    agent_id: Option<String>,
) -> Result<CronJob, String> {
    crate::cron_scheduler::validate_cron_schedule(&schedule)?;

    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let id = uuid::Uuid::new_v4().to_string();
    let aid = agent_id.unwrap_or_else(|| "jarvis".to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let next_run = crate::cron_scheduler::compute_next_run(&schedule);

    conn.execute(
        "INSERT INTO cron_jobs (id, name, schedule, agent_id, prompt, enabled, next_run, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)",
        rusqlite::params![&id, &name, &schedule, &aid, &prompt, next_run.as_deref(), &now, &now],
    )
    .map_err(|e| format!("Failed to insert cron job: {}", e))?;

    // Fetch and return the newly created job
    let job = conn
        .query_row(
            "SELECT id, name, schedule, agent_id, session_id, prompt, enabled,
                    last_run, next_run, run_count, metadata, created_at, updated_at
             FROM cron_jobs WHERE id = ?",
            [&id],
            |row| {
                Ok(CronJob {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    schedule: row.get(2)?,
                    agent_id: row.get(3)?,
                    session_id: row.get(4)?,
                    prompt: row.get(5)?,
                    enabled: row.get::<_, i64>(6)? != 0,
                    last_run: row.get(7)?,
                    next_run: row.get(8)?,
                    run_count: row.get(9)?,
                    metadata: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .map_err(|e| format!("Failed to fetch new cron job: {}", e))?;

    Ok(job)
}

/// Edit an existing cron job using a JSON patch object.
/// Supported keys: name, schedule, prompt, agent_id, session_id, next_run
#[tauri::command]
pub fn edit_cron_job(
    db: State<AppDb>,
    id: String,
    patch: serde_json::Value,
) -> Result<CronJob, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let obj = patch.as_object().ok_or("patch must be a JSON object")?;

    // Validate patch fields against whitelist (prevent SQL injection via dynamic keys)
    const ALLOWED_CRON_PATCH_FIELDS: &[&str] = &[
        "name",
        "schedule",
        "prompt",
        "agent_id",
        "session_id",
        "next_run",
    ];
    for key in obj.keys() {
        if !ALLOWED_CRON_PATCH_FIELDS.contains(&key.as_str()) {
            return Err(format!(
                "Invalid patch field: '{}'. Allowed: {:?}",
                key, ALLOWED_CRON_PATCH_FIELDS
            ));
        }
    }

    let now = chrono::Utc::now().to_rfc3339();

    // Build dynamic UPDATE from provided keys
    let mut sets: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(v) = obj.get("name") {
        sets.push("name = ?".to_string());
        params.push(Box::new(v.as_str().unwrap_or("").to_string()));
    }
    let mut schedule_str = None;
    if let Some(v) = obj.get("schedule") {
        let s = v.as_str().unwrap_or("").to_string();
        crate::cron_scheduler::validate_cron_schedule(&s)?;
        sets.push("schedule = ?".to_string());
        params.push(Box::new(s.clone()));
        schedule_str = Some(s);
    }
    if let Some(v) = obj.get("prompt") {
        sets.push("prompt = ?".to_string());
        params.push(Box::new(v.as_str().unwrap_or("").to_string()));
    }
    if let Some(v) = obj.get("agent_id") {
        sets.push("agent_id = ?".to_string());
        params.push(Box::new(v.as_str().unwrap_or("jarvis").to_string()));
    }
    if let Some(v) = obj.get("session_id") {
        sets.push("session_id = ?".to_string());
        params.push(Box::new(v.as_str().map(|s| s.to_string())));
    }
    if let Some(v) = obj.get("next_run") {
        sets.push("next_run = ?".to_string());
        params.push(Box::new(v.as_str().map(|s| s.to_string())));
    } else if let Some(ref sched) = schedule_str {
        let next_run = crate::cron_scheduler::compute_next_run(sched);
        sets.push("next_run = ?".to_string());
        params.push(Box::new(next_run));
    }

    if sets.is_empty() {
        return Err("No fields to update".to_string());
    }

    sets.push("updated_at = ?".to_string());
    params.push(Box::new(now.clone()));
    params.push(Box::new(id.clone()));

    let sql = format!("UPDATE cron_jobs SET {} WHERE id = ?", sets.join(", "));

    // We need to convert params to references for rusqlite
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let affected = conn
        .execute(&sql, &*param_refs)
        .map_err(|e| format!("Failed to update cron job: {}", e))?;

    if affected == 0 {
        return Err(format!("Cron job '{}' not found", id));
    }

    // Return updated job
    let job = conn
        .query_row(
            "SELECT id, name, schedule, agent_id, session_id, prompt, enabled,
                    last_run, next_run, run_count, metadata, created_at, updated_at
             FROM cron_jobs WHERE id = ?",
            [&id],
            |row| {
                Ok(CronJob {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    schedule: row.get(2)?,
                    agent_id: row.get(3)?,
                    session_id: row.get(4)?,
                    prompt: row.get(5)?,
                    enabled: row.get::<_, i64>(6)? != 0,
                    last_run: row.get(7)?,
                    next_run: row.get(8)?,
                    run_count: row.get(9)?,
                    metadata: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .map_err(|e| format!("Failed to fetch updated cron job: {}", e))?;

    Ok(job)
}

/// Enable a cron job (set enabled = 1).
#[tauri::command]
pub fn enable_cron_job(db: State<AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let affected = conn
        .execute(
            "UPDATE cron_jobs SET enabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            [&id],
        )
        .map_err(|e| format!("Failed to enable cron job '{}': {}", id, e))?;

    Ok(affected > 0)
}

/// Disable a cron job (set enabled = 0).
#[tauri::command]
pub fn disable_cron_job(db: State<AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let affected = conn
        .execute(
            "UPDATE cron_jobs SET enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
            [&id],
        )
        .map_err(|e| format!("Failed to disable cron job '{}': {}", id, e))?;

    Ok(affected > 0)
}

/// Delete a cron job by id.
#[tauri::command]
pub fn delete_cron_job(db: State<AppDb>, id: String) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let affected = conn
        .execute("DELETE FROM cron_jobs WHERE id = ?", [&id])
        .map_err(|e| {
            eprintln!("[cron] Failed to delete cron job '{}': {}", id, e);
            format!("Failed to delete cron job '{}': {}", id, e)
        })?;

    Ok(affected > 0)
}

/// Trigger a cron job run — dispatches the prompt to the Bun server,
/// records the result, and advances `next_run`.
#[tauri::command]
pub async fn run_cron_job(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let schedule_expr = {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT schedule FROM cron_jobs WHERE id = ?",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("Cron job '{}' not found: {}", id, e))?
    };
    crate::cron_scheduler::execute_job(&app, &id, &schedule_expr)
        .await
        .map(|_| true)
}

/// Get run history for a specific cron job.
#[tauri::command]
pub fn get_cron_runs(db: State<AppDb>, cron_id: String) -> Result<Vec<CronRun>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let mut stmt = conn
        .prepare(
            "SELECT id, cron_job_id, status, output, error, duration_ms, started_at, finished_at, execution_evidence
             FROM cron_runs
             WHERE cron_job_id = ?
             ORDER BY started_at DESC
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;

    let runs = stmt
        .query_map([&cron_id], |row| {
            let evidence_json: Option<String> = row.get(8)?;
            let execution_evidence =
                evidence_json.and_then(|j| serde_json::from_str::<CronExecutionEvidence>(&j).ok());
            Ok(CronRun {
                id: row.get(0)?,
                cron_id: row.get(1)?,
                status: row.get(2)?,
                output: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                error: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                duration_ms: row.get(5)?,
                started_at: row.get(6)?,
                finished_at: row.get(7)?,
                execution_evidence,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(runs)
}

/// Get the list of currently executing cron job IDs from the global IN_FLIGHT registry.
#[tauri::command]
pub fn get_in_flight_cron_jobs() -> Result<Vec<String>, String> {
    let guard = crate::cron_scheduler::get_in_flight_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    Ok(guard.iter().cloned().collect())
}

/// Get all cron jobs that are currently pending missed actions from startup.
#[tauri::command]
pub fn list_pending_missed_jobs(db: State<AppDb>) -> Result<Vec<CronJob>, String> {
    let pending_ids = crate::cron_scheduler::get_pending_missed_jobs();
    if pending_ids.is_empty() {
        return Ok(vec![]);
    }

    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let mut jobs = Vec::new();
    for id in pending_ids {
        let job = conn.query_row(
            "SELECT id, name, schedule, agent_id, session_id, prompt, enabled,
                        last_run, next_run, run_count, metadata, created_at, updated_at
                 FROM cron_jobs WHERE id = ?",
            [&id],
            |row| {
                Ok(CronJob {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    schedule: row.get(2)?,
                    agent_id: row.get(3)?,
                    session_id: row.get(4)?,
                    prompt: row.get(5)?,
                    enabled: row.get::<_, i64>(6)? != 0,
                    last_run: row.get(7)?,
                    next_run: row.get(8)?,
                    run_count: row.get(9)?,
                    metadata: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        );
        if let Ok(j) = job {
            jobs.push(j);
        }
    }

    Ok(jobs)
}

/// Dismiss a pending missed cron job, resetting its next_run without executing.
#[tauri::command]
pub fn dismiss_missed_cron_job(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    crate::cron_scheduler::dismiss_missed_job(&app, &id)
}

/// Trigger a pending missed cron job immediately.
#[tauri::command]
pub async fn trigger_missed_cron_job(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    crate::cron_scheduler::trigger_missed_job(&app, &id).await
}
