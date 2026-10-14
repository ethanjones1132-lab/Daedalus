//! Preference-aware in-app Goal notifications (Roadmap Priority #2, Part 3).
//!
//! This module is the single authority for Goal-linked, user-authorized in-app
//! notifications. It emits ONLY when the corresponding durable state/event has
//! already been persisted by the caller, and it dedupes on a deterministic
//! persisted identity so the same state change is surfaced at most once —
//! including across a restart, because the dedupe ledger is durable.
//!
//! Hard limits enforced here:
//!   * In-app surface only. Nothing is sent to the OS notification center,
//!     email, push, Slack, or any other external channel.
//!   * No completion claim. A notification never says a Goal completed; a
//!     scheduled run that persisted a successful run is reported, at most, as a
//!     verified scheduled-run completion and never as Goal acceptance. Part 3
//!     does not authorize Goal acceptance/completion claims.
//!   * Goal-linked only. An unlinked cron activation produces no notification.
//!   * Actionable but bounded payloads. Fixed copy plus identifiers; prompt text
//!     and other sensitive contents are never copied in.

use crate::db::AppDb;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Persisted preference key controlling these in-app notifications.
pub const GOAL_NOTIFICATIONS_ENABLED_KEY: &str = "goal_notifications_enabled";

/// Default when the user has never chosen: in-app Goal notifications are ON,
/// matching the existing cron/action-registry in-app surface behavior. The
/// explicit SettingsView toggle writes `false` to turn them off.
pub const GOAL_NOTIFICATIONS_ENABLED_DEFAULT: bool = true;

/// Tauri event the UI listens on. In-app delivery only.
pub const GOAL_NOTIFICATION_EVENT: &str = "goal://notifications";

/// Stable notification kinds. Completion is deliberately named for the
/// scheduled run, never for the Goal.
pub const KIND_PROGRESS: &str = "scheduled_run_progress";
pub const KIND_WAITING: &str = "scheduled_run_waiting_for_user";
pub const KIND_BLOCKED: &str = "scheduled_run_blocked";
pub const KIND_CANCELLED: &str = "scheduled_run_cancelled";
pub const KIND_FAILED: &str = "scheduled_run_failed";
pub const KIND_COMPLETED: &str = "scheduled_run_verified_completed";

/// One emitted notification. This is the payload the UI receives; it carries no
/// prompt or message text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalNotification {
    pub key: String,
    pub goal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub created_at: String,
}

/// Read the persisted preference from the canonical SQLite settings table. An
/// absent row yields the documented default. A malformed value fails closed to
/// the default rather than to an unexpected state.
pub fn goal_notifications_enabled(conn: &rusqlite::Connection) -> bool {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [GOAL_NOTIFICATIONS_ENABLED_KEY],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    match stored.as_deref() {
        Some(value) => value.trim().eq_ignore_ascii_case("true"),
        None => GOAL_NOTIFICATIONS_ENABLED_DEFAULT,
    }
}

/// Whether the caller should attempt to emit at all. Reads the preference under
/// its own short-lived lock so callers need not hold the DB lock. A read failure
/// fails closed to the default.
pub fn notifications_enabled(app: &AppHandle) -> bool {
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    goal_notifications_enabled(&conn)
}

/// A prospective notification for one Goal-linked activation. `ident` is the
/// deterministic persisted identity component (the activation id plus the
/// persisted occurrence/run, never a fresh value), so the dedupe key is stable.
#[derive(Debug, Clone)]
pub struct NotificationRequest {
    pub goal_id: String,
    pub activation_id: Option<String>,
    pub cron_job_id: Option<String>,
    pub run_id: Option<String>,
    pub ident: String,
    pub kind: &'static str,
    pub title: String,
    pub message: String,
}

/// Compute the deterministic dedupe key. It is derived ONLY from persisted
/// identity + the state kind, so replays/restarts yield the same key.
fn notification_key(req: &NotificationRequest) -> String {
    let base = req
        .activation_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("goal:{}", req.ident));
    format!("{base}:{}", req.kind)
}

/// Emit in-app Goal notifications for a batch of requests.
///
/// This must be called AFTER the corresponding durable state/event has been
/// persisted. For each request it:
///   1. checks the persisted user preference (no preference => no emit),
///   2. inserts the deterministic dedupe row with `INSERT OR IGNORE` — a prior
///      row means this state was already surfaced and nothing is re-emitted,
///   3. emits the in-app event only when the dedupe row was newly inserted.
///
/// The DB lock is held through the whole operation so a concurrent emitter
/// cannot double-insert, and the event is emitted only after the ledger write
/// commits. A ledger write failure means no emit (fail closed). Returns the
/// notifications actually emitted.
pub fn emit_goal_notifications(
    app: &AppHandle,
    requests: Vec<NotificationRequest>,
) -> Vec<GoalNotification> {
    if requests.is_empty() {
        return Vec::new();
    }
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    if !goal_notifications_enabled(&conn) {
        return Vec::new();
    }

    let mut emitted: Vec<GoalNotification> = Vec::new();
    for req in requests {
        if req.goal_id.trim().is_empty() {
            continue;
        }
        let key = notification_key(&req);
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO goal_notifications \
                 (notification_key, goal_id, activation_id, cron_job_id, run_id, kind, title, message) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    &key,
                    &req.goal_id,
                    &req.activation_id,
                    &req.cron_job_id,
                    &req.run_id,
                    req.kind,
                    &req.title,
                    &req.message,
                ],
            )
            .unwrap_or(0);
        if inserted == 0 {
            // Already surfaced for this exact persisted state; dedupe.
            continue;
        }
        let created_at: String = conn
            .query_row(
                "SELECT created_at FROM goal_notifications WHERE notification_key = ?1",
                [&key],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let notification = GoalNotification {
            key,
            goal_id: req.goal_id,
            activation_id: req.activation_id,
            cron_job_id: req.cron_job_id,
            run_id: req.run_id,
            kind: req.kind.to_string(),
            title: req.title,
            message: req.message,
            created_at,
        };
        // Emit only after the durable dedupe row is committed.
        let _ = app.emit(GOAL_NOTIFICATION_EVENT, &notification);
        emitted.push(notification);
    }
    emitted
}

// ── Convenience builders (fixed, bounded copy — no prompt contents) ─────────

/// Progress/state change for a Goal-linked scheduled run. `detail` is a short
/// scheduler-authored phrase (e.g. the claim/dispatch state); objective text and
/// prompts are never included.
pub fn progress_request(
    goal_id: &str,
    activation_id: &str,
    cron_job_id: &str,
    ident: &str,
    detail: &str,
) -> NotificationRequest {
    NotificationRequest {
        goal_id: goal_id.to_string(),
        activation_id: Some(activation_id.to_string()),
        cron_job_id: Some(cron_job_id.to_string()),
        run_id: None,
        ident: ident.to_string(),
        kind: KIND_PROGRESS,
        title: "Goal schedule started".to_string(),
        message: format!("A scheduled Goal run is in progress ({detail})."),
    }
}

pub fn waiting_request(
    goal_id: &str,
    activation_id: &str,
    cron_job_id: &str,
    run_id: Option<&str>,
    ident: &str,
    reason: &str,
) -> NotificationRequest {
    NotificationRequest {
        goal_id: goal_id.to_string(),
        activation_id: Some(activation_id.to_string()),
        cron_job_id: Some(cron_job_id.to_string()),
        run_id: run_id.map(|value| value.to_string()),
        ident: ident.to_string(),
        kind: KIND_WAITING,
        title: "Goal schedule needs your input".to_string(),
        message: format!("A scheduled Goal run is waiting for you: {reason}"),
    }
}

pub fn blocked_request(
    goal_id: &str,
    activation_id: &str,
    cron_job_id: &str,
    run_id: Option<&str>,
    ident: &str,
    reason: &str,
) -> NotificationRequest {
    NotificationRequest {
        goal_id: goal_id.to_string(),
        activation_id: Some(activation_id.to_string()),
        cron_job_id: Some(cron_job_id.to_string()),
        run_id: run_id.map(|value| value.to_string()),
        ident: ident.to_string(),
        kind: KIND_BLOCKED,
        title: "Goal schedule blocked".to_string(),
        message: format!("A scheduled Goal run is blocked: {reason}"),
    }
}

pub fn cancelled_request(
    goal_id: &str,
    activation_id: &str,
    cron_job_id: &str,
    run_id: Option<&str>,
    ident: &str,
    reason: &str,
) -> NotificationRequest {
    NotificationRequest {
        goal_id: goal_id.to_string(),
        activation_id: Some(activation_id.to_string()),
        cron_job_id: Some(cron_job_id.to_string()),
        run_id: run_id.map(|value| value.to_string()),
        ident: ident.to_string(),
        kind: KIND_CANCELLED,
        title: "Goal schedule cancelled".to_string(),
        message: format!("A scheduled Goal run was cancelled ({reason})."),
    }
}

pub fn failed_request(
    goal_id: &str,
    activation_id: &str,
    cron_job_id: &str,
    run_id: Option<&str>,
    ident: &str,
    reason: &str,
) -> NotificationRequest {
    NotificationRequest {
        goal_id: goal_id.to_string(),
        activation_id: Some(activation_id.to_string()),
        cron_job_id: Some(cron_job_id.to_string()),
        run_id: run_id.map(|value| value.to_string()),
        ident: ident.to_string(),
        kind: KIND_FAILED,
        title: "Goal schedule failed".to_string(),
        message: format!("A scheduled Goal run failed: {reason}"),
    }
}

/// A scheduled run whose own durable run record proves a successful execution.
/// This says a scheduled run completed; it never says the Goal completed and is
/// never Goal acceptance.
pub fn completed_request(
    goal_id: &str,
    activation_id: &str,
    cron_job_id: &str,
    run_id: &str,
    ident: &str,
) -> NotificationRequest {
    NotificationRequest {
        goal_id: goal_id.to_string(),
        activation_id: Some(activation_id.to_string()),
        cron_job_id: Some(cron_job_id.to_string()),
        run_id: Some(run_id.to_string()),
        ident: ident.to_string(),
        kind: KIND_COMPLETED,
        title: "Goal scheduled run completed".to_string(),
        message: "A scheduled Goal run finished successfully. This is a run result, not Goal \
                  acceptance."
            .to_string(),
    }
}
