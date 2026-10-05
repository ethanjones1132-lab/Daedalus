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
use tauri::{Manager, State};

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

/// Native-authorized, single-run binding between a Goal and one prospective
/// Session turn. It is produced only after the native authority validates the
/// Goal's current Agent/workspace binding against the exact Session, and it is
/// registered as a bounded one-shot with the owned Bun child. It carries no
/// permission: it is association identity only and never widens tool/fs grants.
/// Memory availability is deliberately not a precondition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalRunBinding {
    pub binding_id: String,
    pub goal_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub project_root: Option<String>,
    pub objective: String,
    pub criteria: Vec<String>,
    pub turn_id: String,
    /// Native-authoritative saved user message row id this binding is for. It is
    /// the exact `messages.id` native inserted for this turn — never a UI/client
    /// identity.
    pub source_message_id: String,
    /// Canonical lowercase SHA-256 of that saved row's exact UTF-8 content,
    /// computed by native from the authoritative stored bytes.
    pub source_message_hash: String,
    /// Stable native TaskRun identity for this execution. It is minted by
    /// native, carried through registration/consume, and is the identity a
    /// recovered run preserves before any retry.
    pub task_run_id: String,
    pub issued_at: String,
    pub expires_at: String,
}

/// Result of registering one Goal run binding. `registered` is true only when
/// the owned Bun child accepted the exact binding; a null preparation means the
/// run proceeds as an ordinary goal-less turn and no Goal linkage is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalRunPreparation {
    pub goal_id: String,
    pub turn_id: String,
    pub registered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_message_id: Option<String>,
}

/// Durable native record of one registered Goal run binding. The terminal
/// writer verifies a Bun consume receipt against this row before any
/// `session_runs.goal_id` is set, so a client cannot fabricate Goal authority.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalRunBindingRecord {
    pub binding_id: String,
    pub goal_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub project_root: Option<String>,
    pub turn_id: String,
    pub source_message_id: String,
    pub source_message_hash: String,
    pub task_run_id: String,
    pub bun_instance_id: Option<String>,
    pub issued_at: String,
    pub expires_at: String,
    pub consumed_at: Option<String>,
    pub consumed_run_id: Option<String>,
    pub created_at: String,
}

/// Durable per-run recovery view for one Goal-linked Session run. It exposes
/// only identifiers and structured state — never transcripts or memory text.
/// `evidence_refs` are actual progress-evidence references from the persisted
/// Bun TaskRun checkpoint. `accepted_output_pending` is always true while the
/// Part 4 trusted-acceptance gate is unimplemented, so no consumer renders
/// progress evidence as verified accepted output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalRunProgress {
    pub goal_id: String,
    pub session_id: String,
    pub run_id: String,
    pub outcome: String,
    pub goal_status: String,
    pub interrupted: bool,
    pub resumable: bool,
    pub evidence_refs: Vec<String>,
    pub accepted_output_pending: bool,
    pub finished_at: Option<String>,
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

/// Load the Goal's association links. Cron/Session/run links live only in
/// `goal_links`. The Commitment↔Goal relationship, however, is owned by the
/// Commitment JSON authority (`Commitment.goal_id`); a `goal_links` commitment
/// row is only a legacy projection. This read therefore consults the
/// authoritative Commitment index so the two stores can never present
/// simultaneous conflicting associations:
///   * a legacy commitment row is kept only while the authority still names this
///     Goal (or records no association yet),
///   * a legacy row is suppressed when the authority names a different Goal,
///   * commitments linked through the JSON authority with no legacy row are
///     surfaced here.
/// If the Commitment authority is unreadable, the read fails closed with an
/// error rather than falling back to a possibly stale legacy projection.
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

    // Commitments are reconciled against their JSON authority. If that authority
    // is unreadable we cannot prove which legacy rows are current, so fail
    // closed rather than presenting a possibly stale or conflicting link.
    let index = crate::commands::system::commitment_goal_index().map_err(|e| {
        format!("goal links require the Commitment authority, which is unavailable: {e}")
    })?;

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<GoalLink> = Vec::with_capacity(rows.len());
    for row in rows {
        if row.target_kind == "commitment" {
            match index.get(&row.target_id) {
                // Authority still names this Goal: current.
                Some(state) if state.goal_id.as_deref() == Some(goal_id) => {
                    seen.insert(row.target_id.clone());
                    out.push(row);
                }
                // Genuinely old, unmigrated null association: preserve legacy.
                Some(state) if state.goal_id.is_none() && !state.cleared => {
                    seen.insert(row.target_id.clone());
                    out.push(row);
                }
                // Authority names a different Goal, or the association was
                // explicitly cleared: suppress the stale projection.
                Some(_) => {}
                // Commitment no longer exists: drop the dangling row.
                None => {}
            }
        } else {
            out.push(row);
        }
    }

    for (id, state) in &index {
        if state.goal_id.as_deref() == Some(goal_id) && !seen.contains(id) {
            out.push(GoalLink {
                id: format!("commitment:{id}"),
                goal_id: goal_id.to_string(),
                target_kind: "commitment".to_string(),
                target_id: id.clone(),
                created_at: String::new(),
            });
        }
    }

    Ok(out)
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

/// Validate that a Commitment may be bound to `goal_id` from the native
/// Commitment CRUD flow. `commitment_agent_id` is the Commitment's own stored
/// Agent binding (None for a user-wide Commitment); a caller-supplied Agent or
/// project path is never consulted, so the check never widens scope.
///
/// The Goal is loaded through the native Goal authority: a missing or malformed
/// Goal id fails closed, and a terminal Goal (`completed`/`failed`/`cancelled`)
/// refuses new associations because no active work should be attached to closed
/// objectives. A project-scoped Goal is refused because a Commitment carries no
/// workspace association that could be proven against it, matching the existing
/// link validation. An explicitly bound Commitment Agent must match the Goal's
/// Agent. This only proves attribution; it never grants permissions and never
/// treats a Commitment as Goal acceptance.
pub fn validate_commitment_goal_binding(
    conn: &rusqlite::Connection,
    goal_id: &str,
    commitment_agent_id: Option<&str>,
) -> Result<(), String> {
    let goal = load_goal(conn, goal_id)?;
    if TERMINAL_GOAL_STATUSES.contains(&goal.status.as_str()) {
        return Err(format!(
            "goal is terminal ('{}'); a commitment cannot be bound to a closed goal",
            goal.status
        ));
    }
    if goal.project_root.is_some() {
        return Err(format!(
            "commitment has no workspace association and cannot be bound to \
             project-scoped goal '{}'",
            goal.id
        ));
    }
    if let Some(agent_id) = commitment_agent_id {
        require_same_agent(agent_id, &goal, "commitment", "(commitment)")?;
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

    // A Commitment owns its Goal association on its own record, so route a
    // commitment link through that authority (which also clears any legacy
    // `goal_links` projection) instead of inserting a second, independently
    // editable row that could disagree with the Commitment.
    if target_kind == "commitment" {
        let commitment = crate::commands::system::apply_commitment_goal_conn(
            &conn,
            &target_id,
            Some(goal_id.clone()),
        )?;
        return Ok(GoalLink {
            id: format!("commitment:{}", commitment.id),
            goal_id,
            target_kind,
            target_id: commitment.id,
            created_at: now_iso(),
        });
    }

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

    // Remove a commitment association through its authoritative Commitment
    // record, matching the write path. Other target kinds use `goal_links`.
    if target_kind.trim() == "commitment" {
        let target_id = target_id.trim().to_string();
        if target_id.is_empty() {
            return Err("goal link target id must not be empty".to_string());
        }
        load_goal(&conn, &goal_id)?;
        return crate::commands::system::clear_commitment_goal_conn(
            &conn, &target_id, &goal_id,
        );
    }

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

// ── Goal-linked execution authority (Roadmap Priority #2, Part 2) ──────────

/// Load a Goal for run association validation from another native module.
/// Terminal Goals are permitted (a run may finish after its Goal closed); a
/// missing/invalid Goal fails closed.
pub fn load_goal_for_run_validation(
    conn: &rusqlite::Connection,
    goal_id: &str,
) -> Result<Goal, String> {
    load_goal(conn, goal_id)
}

/// Validate that a Goal's Agent and canonical workspace scope match a Session's
/// persisted binding. Used by the terminal run writer so a run is only ever
/// attributed to a Goal the Session could legitimately execute.
pub fn validate_goal_session_scope(
    goal: &Goal,
    session_agent: &str,
    session_project_root: Option<&str>,
    session_id: &str,
) -> Result<(), String> {
    require_same_agent(session_agent, goal, "session", session_id)?;
    require_same_workspace(session_project_root, goal, "session", session_id)
}

/// Bound on a registered Goal run binding, matching the private capability's
/// bounded one-shot window. After this, the binding is unusable and the turn is
/// goal-less rather than silently reusing stale authority.
const GOAL_RUN_BINDING_TTL_SECONDS: i64 = 120;

/// Load the exact native-authoritative saved user source message owned by this
/// Session and compute its canonical UTF-8 SHA-256 from the stored content. A
/// missing row, a non-user role, or a row owned by another Session fails closed.
/// A client-supplied hash is never consulted.
fn load_saved_user_source(
    conn: &rusqlite::Connection,
    session_id: &str,
    source_message_id: &str,
) -> Result<(String, String), String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT role, content FROM messages WHERE id = ?1 AND session_id = ?2",
            rusqlite::params![source_message_id, session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (role, content) =
        row.ok_or_else(|| "source message is not persisted in this Session".to_string())?;
    if role != "user" {
        return Err("source message must be a persisted user-role message".to_string());
    }
    Ok((content.clone(), crate::jarvis::memory::turn::message_sha256(&content)))
}

/// Resolve the native authority for linking one prospective Session turn to a
/// Goal. This is the ONLY place a Goal may become TaskRun/run authority. It
/// loads the Goal, refuses a terminal Goal, validates the Goal's Agent and
/// canonical project scope against the exact persisted Session, and loads the
/// exact saved user source row identity+hash. A missing Session/source row,
/// non-user role, cross-Agent scope, cross-workspace scope, or terminal Goal
/// fails closed. It never consults memory availability, treats no client hash
/// or message as authority, and never grants permissions.
pub fn resolve_goal_run_binding(
    conn: &rusqlite::Connection,
    goal_id: &str,
    session_id: &str,
    turn_id: &str,
    source_message_id: &str,
) -> Result<GoalRunBinding, String> {
    if source_message_id.trim().is_empty() {
        return Err("source message identity is required for a goal-linked run".to_string());
    }
    let goal = load_goal(conn, goal_id)?;
    if TERMINAL_GOAL_STATUSES.contains(&goal.status.as_str()) {
        return Err(format!(
            "goal is terminal ('{}'); it cannot start new execution",
            goal.status
        ));
    }

    let session: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT agent_id, project_root FROM sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (session_agent, session_project_root) =
        session.ok_or_else(|| format!("session not found: {}", session_id))?;

    require_same_agent(&session_agent, &goal, "session", session_id)?;
    require_same_workspace(session_project_root.as_deref(), &goal, "session", session_id)?;

    let (_, source_message_hash) =
        load_saved_user_source(conn, session_id, source_message_id)?;

    let criteria = load_criteria(conn, &goal.id)?
        .into_iter()
        .map(|criterion| criterion.text)
        .collect::<Vec<_>>();

    let issued_at = now_iso();
    let expires_at = (chrono::Utc::now()
        + chrono::Duration::seconds(GOAL_RUN_BINDING_TTL_SECONDS))
    .to_rfc3339();

    Ok(GoalRunBinding {
        binding_id: new_id(),
        goal_id: goal.id,
        session_id: session_id.to_string(),
        agent_id: goal.agent_id,
        project_root: goal.project_root,
        objective: goal.objective,
        criteria,
        turn_id: turn_id.to_string(),
        source_message_id: source_message_id.to_string(),
        source_message_hash,
        task_run_id: format!("task_{}", new_id()),
        issued_at,
        expires_at,
    })
}

/// Persist the native registration record for one Goal run binding. Written
/// only after the owned Bun child confirmed the exact binding, it is the row the
/// terminal writer checks a Bun consume receipt against. An exact replay of the
/// same binding id is idempotent; a conflicting row is refused.
pub fn record_goal_run_binding(
    conn: &rusqlite::Connection,
    binding: &GoalRunBinding,
    bun_instance_id: &str,
) -> Result<(), String> {
    let existing: Option<(String, String, String, String, String)> = conn
        .query_row(
            "SELECT goal_id, session_id, turn_id, source_message_id, source_message_hash \
             FROM goal_run_bindings WHERE binding_id = ?1",
            [&binding.binding_id],
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
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((goal_id, session_id, turn_id, source_id, source_hash)) = existing {
        if goal_id != binding.goal_id
            || session_id != binding.session_id
            || turn_id != binding.turn_id
            || source_id != binding.source_message_id
            || source_hash != binding.source_message_hash
        {
            return Err(format!(
                "goal run binding '{}' is already registered with a conflicting identity",
                binding.binding_id
            ));
        }
        return Ok(());
    }
    conn.execute(
        "INSERT INTO goal_run_bindings
         (binding_id, goal_id, session_id, agent_id, project_root, turn_id,
          source_message_id, source_message_hash, task_run_id, bun_instance_id,
          issued_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        rusqlite::params![
            &binding.binding_id,
            &binding.goal_id,
            &binding.session_id,
            &binding.agent_id,
            &binding.project_root,
            &binding.turn_id,
            &binding.source_message_id,
            &binding.source_message_hash,
            &binding.task_run_id,
            bun_instance_id,
            &binding.issued_at,
            &binding.expires_at,
        ],
    )
    .map_err(|e| format!("Failed to record goal run binding: {e}"))?;
    Ok(())
}

/// Load the native registration record for one Goal run binding by exact
/// binding id. Used by the terminal writer; a missing row fails closed.
pub fn load_goal_run_binding(
    conn: &rusqlite::Connection,
    binding_id: &str,
) -> Result<GoalRunBindingRecord, String> {
    conn.query_row(
        "SELECT binding_id, goal_id, session_id, agent_id, project_root, turn_id, \
                source_message_id, source_message_hash, task_run_id, bun_instance_id, \
                issued_at, expires_at, consumed_at, consumed_run_id, created_at \
         FROM goal_run_bindings WHERE binding_id = ?1",
        [binding_id],
        |row| {
            Ok(GoalRunBindingRecord {
                binding_id: row.get(0)?,
                goal_id: row.get(1)?,
                session_id: row.get(2)?,
                agent_id: row.get(3)?,
                project_root: row.get(4)?,
                turn_id: row.get(5)?,
                source_message_id: row.get(6)?,
                source_message_hash: row.get(7)?,
                task_run_id: row.get(8)?,
                bun_instance_id: row.get(9)?,
                issued_at: row.get(10)?,
                expires_at: row.get(11)?,
                consumed_at: row.get(12)?,
                consumed_run_id: row.get(13)?,
                created_at: row.get(14)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("goal run binding not found: {binding_id}"))
}

/// Mark a native binding record consumed only after the Bun receipt verified the
/// exact pair. Idempotent for the same run; a conflicting consumed run is
/// refused so a binding can never be reassigned to a different execution.
pub fn mark_goal_run_binding_consumed(
    conn: &rusqlite::Connection,
    binding_id: &str,
    run_id: &str,
    consumed_at: &str,
) -> Result<(), String> {
    let existing: Option<Option<String>> = conn
        .query_row(
            "SELECT consumed_run_id FROM goal_run_bindings WHERE binding_id = ?1",
            [binding_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        None => Err(format!("goal run binding not found: {binding_id}")),
        Some(Some(existing_run)) if existing_run != run_id => Err(format!(
            "goal run binding '{binding_id}' is already consumed by a different run"
        )),
        Some(_) => {
            conn.execute(
                "UPDATE goal_run_bindings SET consumed_at = COALESCE(consumed_at, ?2), \
                 consumed_run_id = COALESCE(consumed_run_id, ?3) \
                 WHERE binding_id = ?1",
                rusqlite::params![binding_id, consumed_at, run_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

/// The exact Bun consume receipt for a Goal run binding. Returned only over the
/// private capability; it proves the owned child consumed this exact pair and
/// the stable TaskRun/run identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalRunReceipt {
    pub binding_id: String,
    pub goal_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub source_message_id: String,
    pub source_message_hash: String,
    pub task_run_id: String,
    /// The Bun agent run identity, present only once the pipeline attached it.
    #[serde(default)]
    pub run_id: Option<String>,
    pub bun_instance_id: String,
    pub consumed_at: String,
}

/// Native terminal proof for one Goal-linked run. Verifies the native binding
/// record and the Bun consume receipt agree on the exact binding, Session,
/// turn, saved-user row/hash, Goal, and stable TaskRun identity, and that the
/// receipt's Bun run identity matches the terminal run id. Only then may
/// `session_runs.goal_id` be set. A missing/mismatched/expired receipt fails
/// closed and the run stays goal-less.
pub fn verify_goal_terminal_receipt(
    conn: &rusqlite::Connection,
    binding_id: &str,
    run_id: &str,
    receipt: &GoalRunReceipt,
) -> Result<String, String> {
    let record = load_goal_run_binding(conn, binding_id)?;
    if receipt.binding_id != record.binding_id {
        return Err("goal run receipt binding mismatch".to_string());
    }
    if receipt.goal_id != record.goal_id
        || receipt.session_id != record.session_id
        || receipt.turn_id != record.turn_id
        || receipt.source_message_id != record.source_message_id
        || receipt.source_message_hash != record.source_message_hash
        || receipt.task_run_id != record.task_run_id
    {
        return Err("goal run receipt does not match the native registration".to_string());
    }
    // The receipt's Bun instance must be the instance the native registration
    // was confirmed against; a replaced child cannot authorize the run.
    if let Some(expected) = record.bun_instance_id.as_deref() {
        if receipt.bun_instance_id != expected {
            return Err("goal run receipt came from an unapproved Bun instance".to_string());
        }
    }
    // The terminal run id must be exactly the run identity the consumed binding
    // recorded (the stable Bun run id), never an arbitrary caller value.
    let Some(receipt_run_id) = receipt.run_id.as_deref() else {
        return Err("goal run receipt has no consumed run identity".to_string());
    };
    if receipt_run_id != run_id {
        return Err("goal run receipt run identity does not match the terminal run".to_string());
    }
    if let Some(consumed_run) = record.consumed_run_id.as_deref() {
        if consumed_run != run_id {
            return Err(format!(
                "goal run binding '{}' was consumed by a different run",
                binding_id
            ));
        }
    }
    // The saved source row must still exist with the exact bound bytes; a
    // changed/removed source invalidates the proof.
    let (_, source_hash) =
        load_saved_user_source(conn, &record.session_id, &record.source_message_id)?;
    if source_hash != record.source_message_hash {
        return Err("goal run source message bytes changed since registration".to_string());
    }
    mark_goal_run_binding_consumed(conn, binding_id, run_id, &receipt.consumed_at)?;
    Ok(record.goal_id)
}

/// Deterministic recovery view of terminal runs associated with a Goal, plus
/// whether each is resumable. It reads only persisted facts: a non-terminal Goal
/// status with a recorded run that ended in a non-terminal outcome is
/// `interrupted` and `resumable`; an explicit terminal outcome is surfaced as-is
/// and is never reported as completion.
///
/// Evidence references are populated only from the ACTUAL persisted Bun TaskRun
/// checkpoint (progress evidence references), fetched over the private
/// capability using the native binding/task-run identities. Trusted
/// accepted-output evidence belongs to Part 4 and is surfaced as pending/
/// unverified; the completion gate stays open. A non-live/unknown child yields
/// no refs rather than an empty facade.
#[tauri::command]
pub fn goal_run_progress(
    db: State<AppDb>,
    goal_id: String,
) -> Result<Vec<GoalRunProgress>, String> {
    let (goal, rows) = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let goal = load_goal(&conn, &goal_id)?;

        let mut stmt = conn
            .prepare(
                "SELECT sr.run_id, sr.session_id, sr.outcome, sr.finished_at, \
                        b.binding_id, b.task_run_id \
                 FROM session_runs sr \
                 LEFT JOIN goal_run_bindings b \
                   ON b.session_id = sr.session_id AND b.consumed_run_id = sr.run_id \
                 WHERE sr.goal_id = ?1 \
                 ORDER BY sr.finished_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&goal_id], |row| {
                let run_id: String = row.get(0)?;
                let session_id: String = row.get(1)?;
                let outcome: String = row.get(2)?;
                let finished_at: Option<String> = row.get(3)?;
                let binding_id: Option<String> = row.get(4)?;
                let task_run_id: Option<String> = row.get(5)?;
                Ok((run_id, session_id, outcome, finished_at, binding_id, task_run_id))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        (goal, rows)
    };

    let goal_interrupted = !TERMINAL_GOAL_STATUSES.contains(&goal.status.as_str());
    let transport = crate::jarvis::memory::transport::native_memory_transport();
    let mut out = Vec::with_capacity(rows.len());
    for (run_id, session_id, outcome, finished_at, binding_id, task_run_id) in rows {
        // A run that did not end in a clean success while the Goal is still
        // live is an interruption; it is never treated as Goal completion.
        // A deliberate cancellation is surfaced distinctly and is not
        // advertised as resumable, while failure/timeout/partial remain
        // resumable. The exact outcome string is preserved verbatim.
        let interrupted = outcome != "success" && goal_interrupted;
        let resumable = interrupted && outcome != "cancelled";

        // Populate evidence refs only from the actual persisted Bun TaskRun
        // checkpoint for the exact native binding/task-run identity. A missing
        // child/view yields no refs (never a fabricated empty facade) and never
        // claims Part 4 accepted-output evidence.
        let (evidence_refs, accepted_output_pending) =
            match (binding_id.as_deref(), task_run_id.as_deref()) {
                (Some(binding_id), Some(task_run_id))
                    if !binding_id.is_empty() && !task_run_id.is_empty() =>
                {
                    match crate::jarvis::memory::transport::read_goal_checkpoint(
                        transport,
                        &session_id,
                        &goal.id,
                        binding_id,
                        task_run_id,
                    ) {
                        Some(view) => (
                            view.progress_evidence_refs,
                            view.accepted_output_evidence.pending,
                        ),
                        // No authoritative checkpoint read available: expose no
                        // refs and keep the accepted-output gate open.
                        None => (Vec::new(), true),
                    }
                }
                _ => (Vec::new(), true),
            };

        out.push(GoalRunProgress {
            goal_id: goal.id.clone(),
            session_id,
            run_id,
            outcome,
            goal_status: goal.status.clone(),
            interrupted,
            resumable,
            evidence_refs,
            accepted_output_pending,
            finished_at,
        });
    }
    Ok(out)
}

/// Native-validate and register a bounded one-shot Goal run binding with the
/// owned Bun child. A non-empty Goal id, matching Session/turn, and the exact
/// native saved user source message row are required. Native loads that source
/// row, computes its canonical UTF-8 SHA-256, and mints the stable TaskRun
/// identity. When registration cannot be confirmed the call still succeeds with
/// `registered: false`, so the caller runs the turn goal-less rather than
/// failing the user's turn; Goal linkage is never fabricated.
#[tauri::command]
pub async fn goal_prepare_run(
    app: tauri::AppHandle,
    goal_id: String,
    session_id: String,
    turn_id: String,
    source_message_id: String,
) -> Result<GoalRunPreparation, String> {
    let goal_id = goal_id.trim().to_string();
    let session_id = session_id.trim().to_string();
    let turn_id = turn_id.trim().to_string();
    let source_message_id = source_message_id.trim().to_string();
    if goal_id.is_empty() {
        return Err("goal id must not be empty".to_string());
    }
    if session_id.is_empty() || turn_id.is_empty() || source_message_id.is_empty() {
        return Err(
            "session, turn, and saved source message identity are required for a goal-linked run"
                .to_string(),
        );
    }

    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        let transport = crate::jarvis::memory::transport::native_memory_transport();
        crate::jarvis::memory::transport::register_goal_run_binding(
            db.inner(),
            transport,
            &goal_id,
            &session_id,
            &turn_id,
            &source_message_id,
        )
        .map_err(|error| error.message)
    })
    .await
    .map_err(|error| format!("goal run binding task join error: {error}"))?
}
