// ═══════════════════════════════════════════════════════════════
// Cron Commands — SQLite-backed cron job management
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use rusqlite::OptionalExtension;
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
    /// Optional durable Goal association. Set through the validated Goal link
    /// path; read at activation to attribute scheduled runs.
    #[serde(default)]
    pub goal_id: Option<String>,
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
    /// Durable activation and deterministic occurrence this run belongs to.
    #[serde(default)]
    pub activation_id: Option<String>,
    #[serde(default)]
    pub schedule_occurrence: Option<String>,
    /// Optional Goal attributed to this run (never an acceptance claim).
    #[serde(default)]
    pub goal_id: Option<String>,
    /// Terminal reason for a cancelled/blocked/ambiguous outcome.
    #[serde(default)]
    pub terminal_reason: Option<String>,
}

/// Durable record of one claimed scheduled occurrence for a cron job. It is the
/// dedupe/claim authority: `(cron_job_id, schedule_occurrence)` is unique, so a
/// completed occurrence is never dispatched again and pending ones reconcile to
/// an explicit `ambiguous` state rather than replaying.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronActivation {
    pub activation_id: String,
    pub cron_id: String,
    #[serde(default)]
    pub goal_id: Option<String>,
    pub agent_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub project_root: Option<String>,
    pub schedule_occurrence: String,
    pub trigger_kind: String,
    pub claim_state: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub bun_run_id: Option<String>,
    #[serde(default)]
    pub terminal_reason: Option<String>,
    pub claimed_at: String,
    #[serde(default)]
    pub dispatched_at: Option<String>,
    #[serde(default)]
    pub settled_at: Option<String>,
}

// ── Commands ─────────────────────────────────────────────────

/// Normalize an optional Goal id from the cron CRUD surface. Empty/whitespace
/// becomes `None` so a cleared field never stores a dangling empty id.
fn normalize_cron_goal_id(goal_id: Option<String>) -> Option<String> {
    goal_id.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

/// List all cron jobs ordered by created_at DESC.
#[tauri::command]
pub fn list_cron_jobs(db: State<AppDb>) -> Result<Vec<CronJob>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let mut stmt = conn
        .prepare(
            "SELECT id, name, schedule, agent_id, session_id, prompt, enabled,
                    last_run, next_run, run_count, metadata, goal_id, created_at, updated_at
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
                goal_id: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
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
    goal_id: Option<String>,
) -> Result<CronJob, String> {
    crate::cron_scheduler::validate_cron_schedule(&schedule)?;

    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let id = uuid::Uuid::new_v4().to_string();
    let aid = agent_id.unwrap_or_else(|| "jarvis".to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let next_run = crate::cron_scheduler::compute_next_run(&schedule);

    // An explicit Goal is validated against the native authority before it is
    // stored; a new job has no bound Session, so the association uses the
    // job's Agent and (unscoped) workspace. Empty means unlinked as before.
    let goal_id = normalize_cron_goal_id(goal_id);
    if let Some(ref gid) = goal_id {
        crate::commands::goals::validate_cron_goal_binding_prospective(&conn, gid, &aid, None)?;
    }

    // The job column and its `goal_links` projection are written in one
    // transaction so they can never disagree.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO cron_jobs (id, name, schedule, agent_id, prompt, enabled, next_run, run_count, goal_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)",
        rusqlite::params![&id, &name, &schedule, &aid, &prompt, next_run.as_deref(), goal_id.as_deref(), &now, &now],
    )
    .map_err(|e| format!("Failed to insert cron job: {}", e))?;
    if let Some(ref gid) = goal_id {
        let link_id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT OR IGNORE INTO goal_links (id, goal_id, target_kind, target_id, created_at)
             VALUES (?1, ?2, 'cron_job', ?3, ?4)",
            rusqlite::params![link_id, gid, &id, &now],
        )
        .map_err(|e| format!("Failed to project cron goal link: {}", e))?;
    }

    // Fetch and return the newly created job
    let job = tx
        .query_row(
            "SELECT id, name, schedule, agent_id, session_id, prompt, enabled,
                    last_run, next_run, run_count, metadata, goal_id, created_at, updated_at
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
                    goal_id: row.get(11)?,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            },
        )
        .map_err(|e| format!("Failed to fetch new cron job: {}", e))?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(job)
}

/// Edit an existing cron job using a JSON patch object.
/// Supported keys: name, schedule, prompt, agent_id, session_id, next_run, goal_id
#[tauri::command]
pub fn edit_cron_job(
    db: State<AppDb>,
    id: String,
    patch: serde_json::Value,
) -> Result<CronJob, String> {
    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let obj = patch.as_object().ok_or("patch must be a JSON object")?;

    // Validate patch fields against whitelist (prevent SQL injection via dynamic keys)
    const ALLOWED_CRON_PATCH_FIELDS: &[&str] = &[
        "name",
        "schedule",
        "prompt",
        "agent_id",
        "session_id",
        "next_run",
        "goal_id",
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
    let goal_patched = obj.contains_key("goal_id");

    // Load the existing authoritative row up front. An edit of Agent or Session
    // must be revalidated against the job's recorded Goal, and an explicit Goal
    // patch is validated against the *effective* Agent/Session. A missing row or
    // a failed authority lookup is an error, never defaulted to jarvis/None.
    let current: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT agent_id, session_id, goal_id FROM cron_jobs WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to load cron job '{}': {}", id, e))?;
    let (current_agent, current_session, current_goal) =
        current.ok_or_else(|| format!("Cron job '{}' not found", id))?;

    // The effective Agent must be exactly the value the UPDATE will persist, so
    // validation can never approve a Goal for one Agent and then store another.
    // `agent_id` follows the same legacy contract as the write path: a patch that
    // omits it keeps the current row's Agent; a non-string value is refused; a
    // string value (including empty) is used verbatim, and empty maps to the
    // default `jarvis` exactly as the persisted value.
    let effective_agent = match obj.get("agent_id") {
        None => current_agent.clone(),
        Some(value) => match value.as_str() {
            Some(raw) => {
                if raw.is_empty() {
                    "jarvis".to_string()
                } else {
                    raw.to_string()
                }
            }
            None => {
                return Err(
                    "Invalid patch field 'agent_id': must be a string".to_string(),
                )
            }
        },
    };
    let effective_session: Option<String> = if let Some(v) = obj.get("session_id") {
        match v {
            serde_json::Value::Null => None,
            serde_json::Value::String(s) => Some(s.to_string()),
            _ => {
                return Err(
                    "Invalid patch field 'session_id': must be a string or null".to_string(),
                )
            }
        }
    } else {
        current_session.clone()
    };

    // Determine the association to persist. An explicit `goal_id` (possibly empty
    // to clear) wins. Otherwise, if Agent or Session changes, the recorded Goal
    // is revalidated against the proposed effective identity before any write; an
    // Agent/Session-only edit never alters the projection.
    let mut goal_field_present = false;
    let mut goal_to_write: Option<String> = None;
    if goal_patched {
        // Distinguish omission (unchanged) from an explicit clear vs. a new
        // binding: JSON null or an empty/whitespace string clears; a non-empty
        // string is validated; every other JSON type is refused rather than
        // being silently coerced to an unlink.
        let requested = match obj.get("goal_id") {
            Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(s)) => normalize_cron_goal_id(Some(s.clone())),
            Some(_) => {
                return Err(
                    "Invalid patch field 'goal_id': must be a string or null".to_string(),
                )
            }
            None => None,
        };
        if let Some(ref gid) = requested {
            crate::commands::goals::validate_cron_goal_binding_prospective(
                &conn,
                gid,
                &effective_agent,
                effective_session.as_deref(),
            )?;
        }
        goal_field_present = true;
        goal_to_write = requested;
    } else if obj.contains_key("agent_id") || obj.contains_key("session_id") {
        if let Some(gid) = current_goal.as_deref() {
            crate::commands::goals::validate_cron_goal_binding_prospective(
                &conn,
                gid,
                &effective_agent,
                effective_session.as_deref(),
            )?;
        }
    }

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
        // Persist exactly the validated `effective_agent`; never re-derive it.
        let _ = v;
        params.push(Box::new(effective_agent.clone()));
    }
    if let Some(v) = obj.get("session_id") {
        sets.push("session_id = ?".to_string());
        let _ = v;
        params.push(Box::new(effective_session.clone()));
    }
    if let Some(v) = obj.get("next_run") {
        sets.push("next_run = ?".to_string());
        params.push(Box::new(v.as_str().map(|s| s.to_string())));
    } else if let Some(ref sched) = schedule_str {
        let next_run = crate::cron_scheduler::compute_next_run(sched);
        sets.push("next_run = ?".to_string());
        params.push(Box::new(next_run));
    }
    if goal_field_present {
        sets.push("goal_id = ?".to_string());
        params.push(Box::new(goal_to_write.clone()));
    }

    if sets.is_empty() {
        return Err("No fields to update".to_string());
    }

    sets.push("updated_at = ?".to_string());
    params.push(Box::new(now.clone()));
    params.push(Box::new(id.clone()));

    let sql = format!("UPDATE cron_jobs SET {} WHERE id = ?", sets.join(", "));

    // Apply the field change and its `goal_links` projection in one transaction
    // so they cannot diverge; validation above happens before any write.
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let affected = tx
        .execute(&sql, &*param_refs)
        .map_err(|e| format!("Failed to update cron job: {}", e))?;
    if affected == 0 {
        return Err(format!("Cron job '{}' not found", id));
    }

    if goal_field_present {
        tx.execute(
            "DELETE FROM goal_links WHERE target_kind = 'cron_job' AND target_id = ?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        if let Some(ref gid) = goal_to_write {
            let link_id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT OR IGNORE INTO goal_links (id, goal_id, target_kind, target_id, created_at)
                 VALUES (?1, ?2, 'cron_job', ?3, ?4)",
                rusqlite::params![link_id, gid, &id, &now],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Return updated job
    let job = tx
        .query_row(
            "SELECT id, name, schedule, agent_id, session_id, prompt, enabled,
                    last_run, next_run, run_count, metadata, goal_id, created_at, updated_at
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
                    goal_id: row.get(11)?,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
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

/// Delete a cron job by id. The job row and its Goal-link projection are removed
/// in one transaction so a deleted job never leaves a dangling association;
/// activation/run rows cascade via the `cron_jobs` foreign key. A cleanup failure
/// rolls back and is surfaced, not ignored.
#[tauri::command]
pub fn delete_cron_job(db: State<AppDb>, id: String) -> Result<bool, String> {
    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let affected = tx
        .execute("DELETE FROM cron_jobs WHERE id = ?", [&id])
        .map_err(|e| {
            eprintln!("[cron] Failed to delete cron job '{}': {}", id, e);
            format!("Failed to delete cron job '{}': {}", id, e)
        })?;

    if affected > 0 {
        tx.execute(
            "DELETE FROM goal_links WHERE target_kind = 'cron_job' AND target_id = ?1",
            [&id],
        )
        .map_err(|e| format!("Failed to remove goal link for deleted cron job '{}': {}", id, e))?;
    }

    tx.commit().map_err(|e| e.to_string())?;
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
    crate::cron_scheduler::execute_job(&app, &id, &schedule_expr, "manual", None)
        .await
        .map(|_| true)
}

/// Get run history for a specific cron job.
#[tauri::command]
pub fn get_cron_runs(db: State<AppDb>, cron_id: String) -> Result<Vec<CronRun>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    let mut stmt = conn
        .prepare(
            "SELECT id, cron_job_id, status, output, error, duration_ms, started_at, finished_at, execution_evidence, activation_id, schedule_occurrence, goal_id, terminal_reason
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
                activation_id: row.get(9)?,
                schedule_occurrence: row.get(10)?,
                goal_id: row.get(11)?,
                terminal_reason: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(runs)
}

/// List durable activation/occurrence claims for a cron job (newest first).
/// Read-only; the scheduler owns claims. A read failure is not a claim failure.
#[tauri::command]
pub fn get_cron_activations(db: State<AppDb>, cron_id: String) -> Result<Vec<CronActivation>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT activation_id, cron_job_id, goal_id, agent_id, session_id, project_root, \
                    schedule_occurrence, trigger_kind, claim_state, run_id, bun_run_id, \
                    terminal_reason, claimed_at, dispatched_at, settled_at \
             FROM cron_activations WHERE cron_job_id = ? ORDER BY claimed_at DESC LIMIT 100",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&cron_id], |row| {
            Ok(CronActivation {
                activation_id: row.get(0)?,
                cron_id: row.get(1)?,
                goal_id: row.get(2)?,
                agent_id: row.get(3)?,
                session_id: row.get(4)?,
                project_root: row.get(5)?,
                schedule_occurrence: row.get(6)?,
                trigger_kind: row.get(7)?,
                claim_state: row.get(8)?,
                run_id: row.get(9)?,
                bun_run_id: row.get(10)?,
                terminal_reason: row.get(11)?,
                claimed_at: row.get(12)?,
                dispatched_at: row.get(13)?,
                settled_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
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
                        last_run, next_run, run_count, metadata, goal_id, created_at, updated_at
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
                    goal_id: row.get(11)?,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
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
