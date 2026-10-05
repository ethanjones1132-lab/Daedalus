// ═══════════════════════════════════════════════════════════════
// Goal Commands — durable native Goal authority and association
// contracts (Roadmap Priority #2, Part 1)
//
// The user owns the objective and acceptance criteria. This module
// stores them durably in SQLite, validates identities and lifecycle
// transitions, and exposes explicit create/read/list/update/transition
// operations. It never dispatches work, never grants permissions, and
// never lets objective text or a status-only call mark a Goal complete.
// Completion (with accepted evidence) belongs to a later part.
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

/// All declared lifecycle states. Terminal states remain distinct.
const GOAL_STATUSES: &[&str] = &[
    "pending",
    "running",
    "waiting_for_user",
    "blocked",
    "paused",
    "completed",
    "failed",
    "cancelled",
];

const TERMINAL_GOAL_STATUSES: &[&str] = &["completed", "failed", "cancelled"];

/// Stable association target kinds for `goal_links`.
const GOAL_LINK_TARGET_KINDS: &[&str] = &[
    "task_plan",
    "task_run",
    "commitment",
    "cron_job",
    "cron_run",
    "session_run",
    "evidence",
];

// ── DTOs ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    pub id: String,
    pub objective: String,
    pub status: String,
    pub agent_id: String,
    pub project_root: Option<String>,
    /// Always `user_statement`; model-generated summaries are never accepted.
    pub objective_authority: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalCriterion {
    pub id: String,
    pub goal_id: String,
    pub ordinal: i64,
    pub text: String,
    /// Always `user_statement`.
    pub authority: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalEvent {
    pub id: String,
    pub goal_id: String,
    pub event_type: String,
    pub from_status: Option<String>,
    pub to_status: Option<String>,
    pub actor: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalLink {
    pub id: String,
    pub goal_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalDetail {
    pub goal: Goal,
    pub criteria: Vec<GoalCriterion>,
    pub links: Vec<GoalLink>,
    pub events: Vec<GoalEvent>,
}

// ── Helpers ──────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A missing or invalid Goal ID fails closed.
fn validate_goal_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| format!("invalid goal id: {}", id))
}

fn map_goal(row: &rusqlite::Row<'_>) -> rusqlite::Result<Goal> {
    Ok(Goal {
        id: row.get(0)?,
        objective: row.get(1)?,
        status: row.get(2)?,
        agent_id: row.get(3)?,
        project_root: row.get(4)?,
        objective_authority: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn load_goal(conn: &rusqlite::Connection, id: &str) -> Result<Goal, String> {
    validate_goal_id(id)?;
    conn.query_row(
        "SELECT id, objective, status, agent_id, project_root, objective_authority, \
                created_at, updated_at FROM goals WHERE id = ?1",
        [id],
        map_goal,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("goal not found: {}", id))
}

fn load_criteria(conn: &rusqlite::Connection, goal_id: &str) -> Result<Vec<GoalCriterion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, goal_id, ordinal, text, authority, created_at \
             FROM goal_criteria WHERE goal_id = ?1 ORDER BY ordinal ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([goal_id], |row| {
            Ok(GoalCriterion {
                id: row.get(0)?,
                goal_id: row.get(1)?,
                ordinal: row.get(2)?,
                text: row.get(3)?,
                authority: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn load_links(conn: &rusqlite::Connection, goal_id: &str) -> Result<Vec<GoalLink>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, goal_id, target_kind, target_id, created_at \
             FROM goal_links WHERE goal_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([goal_id], |row| {
            Ok(GoalLink {
                id: row.get(0)?,
                goal_id: row.get(1)?,
                target_kind: row.get(2)?,
                target_id: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn load_events(conn: &rusqlite::Connection, goal_id: &str) -> Result<Vec<GoalEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, goal_id, event_type, from_status, to_status, actor, reason, created_at \
             FROM goal_events WHERE goal_id = ?1 ORDER BY created_at ASC, rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([goal_id], |row| {
            Ok(GoalEvent {
                id: row.get(0)?,
                goal_id: row.get(1)?,
                event_type: row.get(2)?,
                from_status: row.get(3)?,
                to_status: row.get(4)?,
                actor: row.get(5)?,
                reason: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn build_detail(conn: &rusqlite::Connection, id: &str) -> Result<GoalDetail, String> {
    let goal = load_goal(conn, id)?;
    let criteria = load_criteria(conn, id)?;
    let links = load_links(conn, id)?;
    let events = load_events(conn, id)?;
    Ok(GoalDetail {
        goal,
        criteria,
        links,
        events,
    })
}

/// Normalize user-provided objective/criteria text. Empty entries are dropped;
/// the objective and criterion set must remain non-empty. Nothing is inferred.
fn normalize_texts(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .collect()
}

fn transition_allowed(from: &str, to: &str) -> bool {
    match from {
        "pending" | "running" | "waiting_for_user" | "blocked" | "paused" => matches!(
            to,
            "running" | "waiting_for_user" | "blocked" | "paused" | "failed" | "cancelled"
        ),
        _ => false,
    }
}

fn validate_transition(from: &str, to: &str) -> Result<(), String> {
    if !GOAL_STATUSES.contains(&to) {
        return Err(format!("invalid goal status: {}", to));
    }
    if from == to {
        return Err(format!("goal is already '{}'", to));
    }
    if TERMINAL_GOAL_STATUSES.contains(&from) {
        return Err(format!(
            "goal is terminal ('{}'); no further transitions are allowed",
            from
        ));
    }
    if to == "completed" {
        return Err(
            "completion requires accepted evidence; the acceptance gate is not implemented \
             (Roadmap Priority #2 Part 4)"
                .to_string(),
        );
    }
    if !transition_allowed(from, to) {
        return Err(format!("illegal goal transition: {} -> {}", from, to));
    }
    Ok(())
}

/// Replace the criterion set transactionally while preserving the stable
/// identity of criteria whose text is unchanged. New text receives a new id.
fn replace_criteria(
    tx: &rusqlite::Transaction<'_>,
    goal_id: &str,
    texts: &[String],
    now: &str,
) -> Result<(), String> {
    let mut existing: Vec<(String, String, String)> = {
        let mut stmt = tx
            .prepare(
                "SELECT id, text, created_at FROM goal_criteria \
                 WHERE goal_id = ?1 ORDER BY ordinal ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([goal_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    let mut next: Vec<(String, String, String)> = Vec::new();
    for text in texts {
        if let Some(pos) = existing.iter().position(|(_, t, _)| t == text) {
            let (id, _, created_at) = existing.remove(pos);
            next.push((id, text.clone(), created_at));
        } else {
            next.push((new_id(), text.clone(), now.to_string()));
        }
    }

    tx.execute("DELETE FROM goal_criteria WHERE goal_id = ?1", [goal_id])
        .map_err(|e| e.to_string())?;
    for (index, (id, text, created_at)) in next.iter().enumerate() {
        tx.execute(
            "INSERT INTO goal_criteria (id, goal_id, ordinal, text, authority, created_at) \
             VALUES (?1, ?2, ?3, ?4, 'user_statement', ?5)",
            rusqlite::params![id, goal_id, index as i64, text, created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Refuse a target that is already associated with a different Goal. An existing
/// association for this same Goal is allowed so repeated links stay idempotent.
fn reject_conflicting_goal(
    existing_goal_id: Option<String>,
    goal: &Goal,
    label: &str,
    target_id: &str,
) -> Result<(), String> {
    match existing_goal_id {
        Some(existing) if existing != goal.id => Err(format!(
            "{} '{}' is already linked to a different goal '{}'",
            label, target_id, existing
        )),
        _ => Ok(()),
    }
}

/// Require the target's owning Agent to match the Goal's Agent identity.
fn require_same_agent(
    target_agent: &str,
    goal: &Goal,
    label: &str,
    target_id: &str,
) -> Result<(), String> {
    if target_agent == goal.agent_id {
        Ok(())
    } else {
        Err(format!(
            "{} '{}' belongs to Agent '{}', not goal Agent '{}'",
            label, target_id, target_agent, goal.agent_id
        ))
    }
}

/// Require a cron target's bound Session to prove the same Agent identity as
/// both the owning cron job and the Goal. A cron job whose Session binding was
/// created under a different Agent must not be routed under this Goal even when
/// the cron job's own Agent column was spoofed or left stale.
fn require_bound_session_agent(
    session_agent: &str,
    owner_agent: &str,
    goal: &Goal,
    label: &str,
    target_id: &str,
) -> Result<(), String> {
    if session_agent != owner_agent {
        return Err(format!(
            "{} '{}' bound Session belongs to Agent '{}', not owning Agent '{}'",
            label, target_id, session_agent, owner_agent
        ));
    }
    require_same_agent(session_agent, goal, label, target_id)
}

/// Require the target's validated workspace scope to match the Goal's scope.
/// An unscoped Goal may not absorb a project-bound target, and a project-scoped
/// Goal requires an exact canonical match, so a link never overstates scope.
///
/// Both persisted roots are re-canonicalized through the trusted memory-scope
/// validator before comparison. A stored string that no longer resolves to an
/// available directory fails closed rather than linking two paths whose
/// persisted spellings merely happen to agree.
fn require_same_workspace(
    target_project_root: Option<&str>,
    goal: &Goal,
    label: &str,
    target_id: &str,
) -> Result<(), String> {
    match (goal.project_root.as_deref(), target_project_root) {
        (Some(goal_root), Some(target_root)) => {
            let goal_canon = crate::jarvis::memory::scope::normalize_project_root(goal_root)
                .map_err(|e| format!("goal '{}' workspace scope is unavailable: {}", goal.id, e))?;
            let target_canon = crate::jarvis::memory::scope::normalize_project_root(target_root)
                .map_err(|e| {
                    format!(
                        "{} '{}' workspace scope is unavailable: {}",
                        label, target_id, e
                    )
                })?;
            if goal_canon == target_canon {
                Ok(())
            } else {
                Err(format!(
                    "{} '{}' workspace '{}' does not match goal scope '{}'",
                    label, target_id, target_canon, goal_canon
                ))
            }
        }
        (Some(goal_root), None) => Err(format!(
            "{} '{}' has no matching workspace binding for goal scope '{}'",
            label, target_id, goal_root
        )),
        (None, None) => Ok(()),
        (None, Some(_)) => Err(format!(
            "{} '{}' is bound to a project workspace, but goal '{}' has no project scope",
            label, target_id, goal.id
        )),
    }
}

/// Resolve a native Session run to its owning Session and validate the Goal's
/// Agent/workspace scope against it. The run's own nullable `goal_id` must not
/// already point at a different Goal.
fn validate_session_run(
    conn: &rusqlite::Connection,
    goal: &Goal,
    target_id: &str,
) -> Result<(), String> {
    let row: Option<(Option<String>, String, Option<String>)> = conn
        .query_row(
            "SELECT sr.goal_id, s.agent_id, s.project_root \
             FROM session_runs sr JOIN sessions s ON s.id = sr.session_id \
             WHERE sr.run_id = ?1",
            [target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (existing_goal, agent_id, project_root) =
        row.ok_or_else(|| format!("session run not found: {}", target_id))?;

    reject_conflicting_goal(existing_goal, goal, "session run", target_id)?;
    require_same_agent(&agent_id, goal, "session run", target_id)?;
    require_same_workspace(project_root.as_deref(), goal, "session run", target_id)
}

/// Resolve a cron job's Agent and optional bound Session to validate scope
/// against the Goal, and refuse a conflicting existing Goal association. When a
/// Session is bound, its own Agent identity must match both the cron job and the
/// Goal; an unbound job keeps its unscoped compatibility.
fn validate_cron_job(
    conn: &rusqlite::Connection,
    goal: &Goal,
    target_id: &str,
) -> Result<(), String> {
    let row: Option<(Option<String>, String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT cj.goal_id, cj.agent_id, s.agent_id, s.project_root \
             FROM cron_jobs cj LEFT JOIN sessions s ON s.id = cj.session_id \
             WHERE cj.id = ?1",
            [target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (existing_goal, agent_id, bound_session_agent, project_root) =
        row.ok_or_else(|| format!("cron job not found: {}", target_id))?;

    reject_conflicting_goal(existing_goal, goal, "cron job", target_id)?;
    require_same_agent(&agent_id, goal, "cron job", target_id)?;
    if let Some(session_agent) = bound_session_agent.as_deref() {
        require_bound_session_agent(
            session_agent,
            &agent_id,
            goal,
            "cron job",
            target_id,
        )?;
    }
    require_same_workspace(project_root.as_deref(), goal, "cron job", target_id)
}

/// Resolve a cron run through its owning cron job (and that job's optional bound
/// Session) to validate scope against the Goal. As with a cron job, a bound
/// Session's own Agent identity must match both the owning job and the Goal.
fn validate_cron_run(
    conn: &rusqlite::Connection,
    goal: &Goal,
    target_id: &str,
) -> Result<(), String> {
    let row: Option<(Option<String>, String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT cr.goal_id, cj.agent_id, s.agent_id, s.project_root \
             FROM cron_runs cr \
             JOIN cron_jobs cj ON cj.id = cr.cron_job_id \
             LEFT JOIN sessions s ON s.id = cj.session_id \
             WHERE cr.id = ?1",
            [target_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (existing_goal, agent_id, bound_session_agent, project_root) =
        row.ok_or_else(|| format!("cron run not found: {}", target_id))?;

    reject_conflicting_goal(existing_goal, goal, "cron run", target_id)?;
    require_same_agent(&agent_id, goal, "cron run", target_id)?;
    if let Some(session_agent) = bound_session_agent.as_deref() {
        require_bound_session_agent(
            session_agent,
            &agent_id,
            goal,
            "cron run",
            target_id,
        )?;
    }
    require_same_workspace(project_root.as_deref(), goal, "cron run", target_id)
}

/// Validate a Commitment against the Goal using the native JSON commitment
/// store. A Commitment has no workspace/scope field today: an explicit Agent
/// binding must match, an unbound (user-wide) Commitment stays compatible, and
/// a project-scoped Goal is refused because no matching workspace association
/// can be proven.
fn validate_commitment(goal: &Goal, target_id: &str) -> Result<(), String> {
    let commitment = crate::commands::system::fetch_commitment(target_id)?
        .ok_or_else(|| format!("commitment not found: {}", target_id))?;

    reject_conflicting_goal(commitment.goal_id.clone(), goal, "commitment", target_id)?;
    if goal.project_root.is_some() {
        return Err(format!(
            "commitment '{}' has no workspace association and cannot be linked to \
             project-scoped goal '{}'",
            target_id, goal.id
        ));
    }
    if let Some(agent_id) = commitment.agent_id.as_deref() {
        require_same_agent(agent_id, goal, "commitment", target_id)?;
    }
    Ok(())
}

/// Validate that a link target actually exists in its authoritative store and
/// that its Agent/workspace identity is compatible with the loaded Goal before
/// any link is persisted. Only kinds whose authority is reachable from this
/// part's native context are accepted: cron jobs/runs and native Session runs
/// live in the same SQLite authority, and Commitments in the native JSON store.
/// TaskPlan/TaskRun (Bun) and output evidence are declared association kinds
/// reserved for later parts; arbitrary ids for them are refused rather than
/// persisted as dangling or untrusted links.
fn validate_link_target(
    conn: &rusqlite::Connection,
    goal: &Goal,
    target_kind: &str,
    target_id: &str,
) -> Result<(), String> {
    match target_kind {
        "cron_job" => validate_cron_job(conn, goal, target_id),
        "cron_run" => validate_cron_run(conn, goal, target_id),
        "session_run" => validate_session_run(conn, goal, target_id),
        "commitment" => validate_commitment(goal, target_id),
        "task_plan" | "task_run" | "evidence" => Err(format!(
            "goal links to '{}' are not yet supported: that authority is not wired to native \
             Goal links (Roadmap Priority #2 later part)",
            target_kind
        )),
        other => Err(format!("invalid goal link target kind: {}", other)),
    }
}

fn insert_event(
    tx: &rusqlite::Transaction<'_>,
    goal_id: &str,
    event_type: &str,
    from_status: Option<&str>,
    to_status: Option<&str>,
    reason: &str,
    now: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO goal_events \
             (id, goal_id, event_type, from_status, to_status, actor, reason, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'user', ?6, ?7)",
        rusqlite::params![
            new_id(),
            goal_id,
            event_type,
            from_status,
            to_status,
            reason,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────

/// Create a Goal owned by the user with at least one acceptance criterion.
#[tauri::command]
pub fn goal_create(
    db: State<AppDb>,
    objective: String,
    criteria: Vec<String>,
    agent_id: Option<String>,
    project_root: Option<String>,
) -> Result<GoalDetail, String> {
    let objective = objective.trim().to_string();
    if objective.is_empty() {
        return Err("goal objective must not be empty".to_string());
    }
    let criteria = normalize_texts(&criteria);
    if criteria.is_empty() {
        return Err("a goal requires at least one acceptance criterion".to_string());
    }

    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    // Agent ownership and workspace scope are attribution only and are
    // validated against existing native authorities before any write; they
    // never grant filesystem or tool permissions. An omitted Agent keeps the
    // default Jarvis Goal usable. An explicit Agent must resolve to a known,
    // enabled native Agent row, and an explicit project root must canonicalize
    // through the trusted memory-scope validator; invalid scope is rejected
    // rather than persisted as arbitrary attribution.
    let agent_id = match agent_id {
        Some(raw) => {
            let candidate = raw.trim().to_string();
            if candidate.is_empty() {
                "jarvis".to_string()
            } else {
                match crate::commands::agents::fetch_agent(&conn, &candidate)? {
                    Some(agent) if agent.enabled => agent.id,
                    Some(_) => return Err(format!("Agent is disabled: {}", candidate)),
                    None => return Err(format!("Unknown Agent: {}", candidate)),
                }
            }
        }
        None => "jarvis".to_string(),
    };
    let project_root = match project_root {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(
                    crate::jarvis::memory::scope::normalize_project_root(trimmed)
                        .map_err(|e| e.to_string())?,
                )
            }
        }
        None => None,
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let id = new_id();
    let now = now_iso();
    tx.execute(
        "INSERT INTO goals \
             (id, objective, status, agent_id, project_root, objective_authority, created_at, updated_at) \
         VALUES (?1, ?2, 'pending', ?3, ?4, 'user_statement', ?5, ?5)",
        rusqlite::params![&id, &objective, &agent_id, project_root, &now],
    )
    .map_err(|e| format!("Failed to create goal: {}", e))?;

    replace_criteria(&tx, &id, &criteria, &now)?;
    insert_event(&tx, &id, "created", None, Some("pending"), "", &now)?;

    let detail = build_detail(&tx, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(detail)
}

/// List Goals (summary rows only), newest first.
#[tauri::command]
pub fn goal_list(db: State<AppDb>) -> Result<Vec<Goal>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(
            "SELECT id, objective, status, agent_id, project_root, objective_authority, \
                    created_at, updated_at FROM goals ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_goal)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Read one Goal with its criteria, links, and lifecycle events.
#[tauri::command]
pub fn goal_get(db: State<AppDb>, id: String) -> Result<GoalDetail, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    build_detail(&conn, &id)
}

/// Update the user-owned objective and/or the acceptance criterion set.
/// Criterion identity is preserved for unchanged text.
#[tauri::command]
pub fn goal_update(
    db: State<AppDb>,
    id: String,
    objective: Option<String>,
    criteria: Option<Vec<String>>,
) -> Result<GoalDetail, String> {
    let normalized_objective = match objective {
        Some(o) => {
            let trimmed = o.trim().to_string();
            if trimmed.is_empty() {
                return Err("goal objective must not be empty".to_string());
            }
            Some(trimmed)
        }
        None => None,
    };
    let normalized_criteria = match criteria {
        Some(c) => {
            let normalized = normalize_texts(&c);
            if normalized.is_empty() {
                return Err("a goal requires at least one acceptance criterion".to_string());
            }
            Some(normalized)
        }
        None => None,
    };
    if normalized_objective.is_none() && normalized_criteria.is_none() {
        return Err("no fields to update".to_string());
    }

    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let goal = load_goal(&tx, &id)?;
    if TERMINAL_GOAL_STATUSES.contains(&goal.status.as_str()) {
        return Err(format!(
            "goal is terminal ('{}'); it can no longer be edited",
            goal.status
        ));
    }

    let now = now_iso();
    if let Some(objective) = normalized_objective {
        tx.execute(
            "UPDATE goals SET objective = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![&objective, &now, &id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(criteria) = normalized_criteria {
        replace_criteria(&tx, &id, &criteria, &now)?;
    }
    tx.execute(
        "UPDATE goals SET updated_at = ?1 WHERE id = ?2",
        rusqlite::params![&now, &id],
    )
    .map_err(|e| e.to_string())?;

    insert_event(
        &tx,
        &id,
        "updated",
        Some(&goal.status),
        Some(&goal.status),
        "",
        &now,
    )?;

    let detail = build_detail(&tx, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(detail)
}

/// Explicitly transition a Goal's lifecycle state. Terminal states are distinct
/// and immutable, and `completed` is refused until verified evidence exists.
#[tauri::command]
pub fn goal_transition(
    db: State<AppDb>,
    id: String,
    to_status: String,
    reason: Option<String>,
) -> Result<GoalDetail, String> {
    let to_status = to_status.trim().to_string();

    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let goal = load_goal(&tx, &id)?;
    validate_transition(&goal.status, &to_status)?;

    let now = now_iso();
    let reason = reason.unwrap_or_default();
    tx.execute(
        "UPDATE goals SET status = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![&to_status, &now, &id],
    )
    .map_err(|e| e.to_string())?;
    insert_event(
        &tx,
        &id,
        "transition",
        Some(&goal.status),
        Some(&to_status),
        &reason,
        &now,
    )?;

    let detail = build_detail(&tx, &id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(detail)
}

/// List the association links currently recorded for a Goal.
#[tauri::command]
pub fn goal_links_list(db: State<AppDb>, goal_id: String) -> Result<Vec<GoalLink>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    load_goal(&conn, &goal_id)?;
    load_links(&conn, &goal_id)
}

/// Record an explicit association between a Goal and an existing record. This
/// only persists a link; it does not dispatch, schedule, or execute anything.
#[tauri::command]
pub fn goal_link_add(
    db: State<AppDb>,
    goal_id: String,
    target_kind: String,
    target_id: String,
) -> Result<GoalLink, String> {
    let target_kind = target_kind.trim().to_string();
    if !GOAL_LINK_TARGET_KINDS.contains(&target_kind.as_str()) {
        return Err(format!("invalid goal link target kind: {}", target_kind));
    }
    let target_id = target_id.trim().to_string();
    if target_id.is_empty() {
        return Err("goal link target id must not be empty".to_string());
    }

    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

    // The Goal must exist and the target must resolve through its own
    // authoritative store with a compatible Agent/workspace identity. Unknown,
    // cross-scope, conflicting, and not-yet-wired targets are refused rather
    // than persisted as dangling or misleading links.
    let goal = load_goal(&conn, &goal_id)?;
    validate_link_target(&conn, &goal, &target_kind, &target_id)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = now_iso();
    let id = new_id();
    tx.execute(
        "INSERT OR IGNORE INTO goal_links (id, goal_id, target_kind, target_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![&id, &goal_id, &target_kind, &target_id, &now],
    )
    .map_err(|e| format!("Failed to link goal: {}", e))?;

    let link = tx
        .query_row(
            "SELECT id, goal_id, target_kind, target_id, created_at FROM goal_links \
             WHERE goal_id = ?1 AND target_kind = ?2 AND target_id = ?3",
            rusqlite::params![&goal_id, &target_kind, &target_id],
            |row| {
                Ok(GoalLink {
                    id: row.get(0)?,
                    goal_id: row.get(1)?,
                    target_kind: row.get(2)?,
                    target_id: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(link)
}

/// Remove an explicit Goal association link.
#[tauri::command]
pub fn goal_link_remove(
    db: State<AppDb>,
    goal_id: String,
    target_kind: String,
    target_id: String,
) -> Result<bool, String> {
    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    load_goal(&tx, &goal_id)?;
    let affected = tx
        .execute(
            "DELETE FROM goal_links WHERE goal_id = ?1 AND target_kind = ?2 AND target_id = ?3",
            rusqlite::params![&goal_id, &target_kind, &target_id],
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(affected > 0)
}
