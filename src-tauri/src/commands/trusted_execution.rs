// ═══════════════════════════════════════════════════════════════
// Trusted Action Execution — native-approved manifest execution
// (Roadmap Priority #2, Part 4)
// ═══════════════════════════════════════════════════════════════
//
// This module wires a native-approved Action Registry `action_id` plus a
// registered trusted `manifest_id` to the canonical Bun ToolRuntime. The only
// call data that ever crosses the boundary is the exact execution list stored
// in the user-supplied trusted manifest (validated at registration); UI, Goal,
// model, and Action Registry text can never supply tool calls, arguments, or
// acceptance checks.
//
// Every dispatch:
//   * resolves exactly one currently active `open`/`in_progress` Action Registry
//     row whose existing approval condition is already satisfied;
//   * requires the manifest's exact `action_id` binding, schema/registry
//     version and content hash (CAS), and scope;
//   * revalidates the exact enabled Agent and canonical workspace root;
//   * captures the current Agent projection snapshot and re-compares it at final
//     dispatch, persisting enough identity to detect a stale Agent/projection;
//   * claims a durable idempotency key before dispatch, so a lost/ambiguous
//     response or partial execution is never replayed;
//   * persists a durable receipt with the runtime-owned tool outcomes/evidence
//     and marks `pending_acceptance` only after a readback proves the write.
//
// Registering/dispatching grants no permission. It never sets
// `skip_approval_gate`, never invents a grant, never requests approval, and
// never calls shell or a direct command executor. A policy denial or an
// unattended approval requirement is persisted as `blocked`/`waiting_for_user`
// without invoking the tool. A successful execution does not verify the Action
// Registry and does not complete a Goal; acceptance belongs to a later slice.

use crate::db::AppDb;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Whole-run bound. The manifest content is already capped at 64 KiB and 50
/// calls, so the transport request stays bounded. This is the hard execution
/// deadline and the basis for the dedicated trusted-execution HTTP timeout in
/// the transport (`WHOLE_RUN_TIMEOUT_MS` + margin).
pub const WHOLE_RUN_TIMEOUT_MS: u64 = 600_000;
const MAX_EXECUTION_CALLS: usize = 50;

/// Durable statuses. `pending_acceptance` means every declared call actually ran
/// to a successful tool outcome and an acceptance decision is still outstanding;
/// nothing here completes a Goal. `partial` means some calls were skipped after
/// a bounded-evidence stop and must never be read as success.
pub const STATUS_CLAIMED: &str = "claimed";
pub const STATUS_DISPATCHED: &str = "dispatched";
pub const STATUS_PENDING_ACCEPTANCE: &str = "pending_acceptance";
pub const STATUS_WAITING_FOR_USER: &str = "waiting_for_user";
pub const STATUS_BLOCKED: &str = "blocked";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_PARTIAL: &str = "partial";
pub const STATUS_AMBIGUOUS: &str = "ambiguous";

// ── DTOs ─────────────────────────────────────────────────────

/// One exact execution call taken from the stored trusted manifest. Native
/// already validated its tool allowlist and bounded arguments at registration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrustedExecutionCall {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
}

/// Wire request for the private authenticated Bun execution route. Only the
/// native-selected manifest calls and exact identity cross the boundary.
#[derive(Debug, Clone, Serialize)]
pub struct TrustedExecutionRequestWire {
    pub execution_id: String,
    pub action_id: String,
    pub manifest_id: String,
    pub manifest_registry_version: i64,
    pub manifest_content_hash: String,
    pub manifest_schema_version: i64,
    pub agent_id: String,
    pub project_root: String,
    pub projection_slug: String,
    pub projection_source_hash: String,
    pub projection_active_source_hash: String,
    pub projection_version: i64,
    pub calls: Vec<TrustedExecutionCall>,
    pub timeout_ms: u64,
    pub max_calls: u64,
}

/// Runtime-owned evidence for one executed call. `output_sha256` is the
/// canonical digest of the untruncated output; no raw transcript is persisted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedExecutionCallEvidence {
    pub index: usize,
    pub tool: String,
    pub status: String,
    #[serde(default)]
    pub output_sha256: Option<String>,
    #[serde(default)]
    pub output_bytes: Option<u64>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Wire response from the private authenticated Bun execution route.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedExecutionResponseWire {
    pub execution_id: String,
    pub bun_instance_id: String,
    pub run_id: String,
    pub outcome: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub calls: Vec<TrustedExecutionCallEvidence>,
    pub started_at: String,
    pub finished_at: String,
}

/// Honest report of why a requested execution was refused in favor of an
/// existing durable receipt for the same action. Computed at read time; never
/// mutates the stored outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedExecutionConflict {
    pub kind: String,
    pub detail: String,
}

/// Durable execution receipt returned to callers and shown by the UI.
/// `conflict` is present only when a second execution request for the same
/// action was refused because the requested manifest/binding/projection no
/// longer matches the durable receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedActionExecution {
    pub execution_id: String,
    pub idempotency_key: String,
    pub action_id: String,
    pub manifest_id: String,
    pub manifest_registry_version: i64,
    pub manifest_content_hash: String,
    pub manifest_schema_version: i64,
    pub agent_id: String,
    pub project_root: String,
    pub status: String,
    pub terminal_reason: Option<String>,
    pub run_id: Option<String>,
    pub bun_run_id: Option<String>,
    pub evidence: Option<serde_json::Value>,
    pub started_at: Option<String>,
    pub settled_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub conflict: Option<TrustedExecutionConflict>,
}

// ── Helpers ──────────────────────────────────────────────────

fn sha256(value: &str) -> String {
    crate::jarvis::memory::turn::message_sha256(value)
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

struct ManifestScope {
    manifest_id: String,
    registry_version: i64,
    schema_version: i64,
    content_hash: String,
    content_json: String,
    agent_id: String,
    project_root: String,
    action_id: Option<String>,
}

fn load_manifest_scope(conn: &Connection, manifest_id: &str) -> Result<Option<ManifestScope>, String> {
    conn.query_row(
        "SELECT manifest_id, registry_version, schema_version, content_hash, content_json, \
                agent_id, project_root, action_id \
         FROM trusted_acceptance_manifests WHERE manifest_id = ?1",
        [manifest_id],
        |row| {
            Ok(ManifestScope {
                manifest_id: row.get(0)?,
                registry_version: row.get(1)?,
                schema_version: row.get(2)?,
                content_hash: row.get(3)?,
                content_json: row.get(4)?,
                agent_id: row.get(5)?,
                project_root: row.get(6)?,
                action_id: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("failed to read trusted manifest '{manifest_id}': {e}"))
}

/// Extract the exact native-validated execution calls from the stored canonical
/// manifest content. The stored content was strictly validated at registration;
/// this only re-reads the calls and never accepts caller-supplied data.
fn execution_calls_from_content(content_json: &str) -> Result<Vec<TrustedExecutionCall>, String> {
    let value: serde_json::Value = serde_json::from_str(content_json)
        .map_err(|e| format!("stored manifest content is not valid JSON: {e}"))?;
    let execution = value
        .get("execution")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "stored manifest content has no execution list".to_string())?;
    if execution.is_empty() || execution.len() > MAX_EXECUTION_CALLS {
        return Err("stored manifest execution list is out of bounds".to_string());
    }
    let mut calls = Vec::with_capacity(execution.len());
    for item in execution {
        let tool = item
            .get("tool")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "stored manifest execution call has no tool".to_string())?;
        let arguments = item.get("arguments").cloned().filter(|v| !v.is_null());
        calls.push(TrustedExecutionCall {
            tool: tool.to_string(),
            arguments,
        });
    }
    Ok(calls)
}

/// Authority resolved at dispatch: the exact bound action, canonical root, and
/// the current Agent projection snapshot.
struct DispatchAuthority {
    action_id: String,
    project_root: String,
    snapshot: crate::cron_scheduler::ProjectionSnapshot,
}

enum DispatchDenial {
    Waiting(String),
    Blocked(String),
}

impl DispatchDenial {
    fn status(&self) -> &'static str {
        match self {
            DispatchDenial::Waiting(_) => STATUS_WAITING_FOR_USER,
            DispatchDenial::Blocked(_) => STATUS_BLOCKED,
        }
    }

    fn reason(&self) -> &str {
        match self {
            DispatchDenial::Waiting(reason) | DispatchDenial::Blocked(reason) => reason,
        }
    }
}

fn resolve_dispatch_authority(
    conn: &Connection,
    action_id: &str,
    manifest: &ManifestScope,
) -> Result<DispatchAuthority, DispatchDenial> {
    let bound_action = crate::commands::action_registry::resolve_bindable_action_conn(conn, action_id)
        .map_err(DispatchDenial::Blocked)?;
    if bound_action != action_id {
        return Err(DispatchDenial::Blocked(
            "resolved Action Registry id does not match the requested binding".to_string(),
        ));
    }
    let project_root = crate::jarvis::memory::scope::normalize_project_root(&manifest.project_root)
        .map_err(|e| DispatchDenial::Blocked(format!("project root unavailable: {e}")))?;
    let snapshot = crate::commands::agents::resolve_activation_boundary(conn, &manifest.agent_id)
        .map_err(|denial| match denial {
            crate::commands::agents::ActivationDenial::WaitingForUser(reason) => {
                DispatchDenial::Waiting(reason)
            }
            crate::commands::agents::ActivationDenial::Blocked(reason) => {
                DispatchDenial::Blocked(reason)
            }
        })?;
    Ok(DispatchAuthority {
        action_id: bound_action,
        project_root,
        snapshot,
    })
}

/// Durable idempotency is anchored to the Action Registry `action_id` alone, so
/// one approved action can produce at most one durable execution receipt no
/// matter how the manifest is replaced/rebound or the projection changes. The
/// exact requested manifest/binding identity is reported separately as a
/// conflict instead of minting a new execution.
fn idempotency_key(action_id: &str) -> String {
    sha256(&format!("trusted-action-v1\n{action_id}"))
}

fn record_from_row(
    row: (
        String,
        String,
        String,
        String,
        i64,
        String,
        i64,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    ),
) -> Result<TrustedActionExecution, String> {
    let (
        execution_id,
        idempotency_key,
        action_id,
        manifest_id,
        manifest_registry_version,
        manifest_content_hash,
        manifest_schema_version,
        agent_id,
        project_root,
        status,
        terminal_reason,
        run_id,
        bun_run_id,
        evidence_json,
        started_at,
        settled_at,
        created_at,
        updated_at,
    ) = row;
    let evidence = match evidence_json {
        Some(raw) => Some(
            serde_json::from_str(&raw)
                .map_err(|e| format!("stored execution evidence is not valid JSON: {e}"))?,
        ),
        None => None,
    };
    Ok(TrustedActionExecution {
        execution_id,
        idempotency_key,
        action_id,
        manifest_id,
        manifest_registry_version,
        manifest_content_hash,
        manifest_schema_version,
        agent_id,
        project_root,
        status,
        terminal_reason,
        run_id,
        bun_run_id,
        evidence,
        started_at,
        settled_at,
        created_at,
        updated_at,
        conflict: None,
    })
}

const EXECUTION_COLS: &str = "execution_id, idempotency_key, action_id, manifest_id, \
     manifest_registry_version, manifest_content_hash, manifest_schema_version, agent_id, \
     project_root, status, terminal_reason, run_id, bun_run_id, evidence_json, started_at, \
     settled_at, created_at, updated_at";

#[allow(clippy::type_complexity)]
fn map_execution_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(
    String,
    String,
    String,
    String,
    i64,
    String,
    i64,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
)> {
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
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
        row.get(16)?,
        row.get(17)?,
    ))
}

fn load_execution(conn: &Connection, execution_id: &str) -> Result<TrustedActionExecution, String> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {EXECUTION_COLS} FROM trusted_action_executions WHERE execution_id = ?1"
            ),
            [execution_id],
            map_execution_row,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("trusted execution not found: {execution_id}"))?;
    record_from_row(row)
}

fn load_execution_by_key(
    conn: &Connection,
    key: &str,
) -> Result<Option<TrustedActionExecution>, String> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {EXECUTION_COLS} FROM trusted_action_executions WHERE idempotency_key = ?1"
            ),
            [key],
            map_execution_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        Some(row) => record_from_row(row).map(Some),
        None => Ok(None),
    }
}

fn empty_snapshot(slug: &str) -> crate::cron_scheduler::ProjectionSnapshot {
    crate::cron_scheduler::ProjectionSnapshot {
        slug: slug.to_string(),
        source_path: String::new(),
        source_hash: String::new(),
        active_source_hash: String::new(),
        projection_version: 0,
        activated_at: String::new(),
    }
}

fn attach_conflict(
    mut row: TrustedActionExecution,
    conflict: Option<TrustedExecutionConflict>,
) -> TrustedActionExecution {
    row.conflict = conflict;
    row
}

fn load_stored_projection(
    conn: &Connection,
    execution_id: &str,
) -> Result<(String, String, i64), String> {
    conn.query_row(
        "SELECT projection_slug, projection_source_hash, projection_version \
         FROM trusted_action_executions WHERE execution_id = ?1",
        [execution_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .map_err(|e| e.to_string())
}

/// Compare a requested execution against the durable receipt for the same
/// action, reporting the first identity drift honestly. Returns `None` only when
/// the request exactly matches the receipt.
fn conflict_for_existing(
    conn: &Connection,
    action_id: &str,
    manifest: &ManifestScope,
    stored: &TrustedActionExecution,
) -> Option<TrustedExecutionConflict> {
    let conflict = |kind: &str, detail: String| {
        Some(TrustedExecutionConflict {
            kind: kind.to_string(),
            detail,
        })
    };
    if stored.action_id != action_id {
        return conflict(
            "binding_changed",
            format!("receipt is bound to action '{}'", stored.action_id),
        );
    }
    if stored.manifest_id != manifest.manifest_id {
        return conflict(
            "manifest_changed",
            format!(
                "receipt used manifest '{}', requested '{}'",
                stored.manifest_id, manifest.manifest_id
            ),
        );
    }
    if stored.manifest_registry_version != manifest.registry_version {
        return conflict(
            "manifest_changed",
            format!(
                "receipt used registry version {}, current is {}",
                stored.manifest_registry_version, manifest.registry_version
            ),
        );
    }
    if stored.manifest_schema_version != manifest.schema_version {
        return conflict(
            "manifest_changed",
            format!(
                "receipt used schema version {}, current is {}",
                stored.manifest_schema_version, manifest.schema_version
            ),
        );
    }
    let recomputed = sha256(&manifest.content_json);
    if recomputed != manifest.content_hash {
        return conflict(
            "manifest_integrity",
            "stored manifest content hash does not match its canonical content".to_string(),
        );
    }
    if stored.manifest_content_hash != manifest.content_hash {
        return conflict(
            "payload_changed",
            format!(
                "receipt payload hash {} differs from current {}",
                stored.manifest_content_hash, manifest.content_hash
            ),
        );
    }
    if stored.agent_id != manifest.agent_id {
        return conflict(
            "binding_changed",
            format!(
                "receipt Agent '{}' differs from current '{}'",
                stored.agent_id, manifest.agent_id
            ),
        );
    }
    match crate::jarvis::memory::scope::normalize_project_root(&manifest.project_root) {
        Ok(root) => {
            if root != stored.project_root {
                return conflict(
                    "binding_changed",
                    format!(
                        "receipt root '{}' differs from current '{}'",
                        stored.project_root, root
                    ),
                );
            }
        }
        Err(e) => {
            return conflict(
                "binding_unavailable",
                format!("current project root unavailable: {e}"),
            );
        }
    }
    match crate::commands::agents::resolve_activation_boundary(conn, &manifest.agent_id) {
        Ok(snapshot) => match load_stored_projection(conn, &stored.execution_id) {
            Ok((slug, source_hash, version)) => {
                if slug != snapshot.slug
                    || source_hash != snapshot.source_hash
                    || version != snapshot.projection_version
                {
                    return conflict(
                        "projection_changed",
                        format!(
                            "receipt projection '{}@{}' differs from current '{}@{}'",
                            slug, version, snapshot.slug, snapshot.projection_version
                        ),
                    );
                }
            }
            Err(e) => {
                return conflict(
                    "projection_unavailable",
                    format!("stored projection identity unreadable: {e}"),
                );
            }
        },
        Err(denial) => {
            let reason = match denial {
                crate::commands::agents::ActivationDenial::WaitingForUser(reason)
                | crate::commands::agents::ActivationDenial::Blocked(reason) => reason,
            };
            return conflict("projection_unavailable", reason);
        }
    }
    None
}

/// Verify the persisted manifest row still exactly matches the wire/claim
/// identity captured when the execution was claimed. Any drift is a hard block
/// that must happen before the execution request.
fn verify_claimed_identity(
    manifest: &ManifestScope,
    wire: &TrustedExecutionRequestWire,
) -> Result<(), String> {
    if manifest.manifest_id != wire.manifest_id {
        return Err("manifest id changed after claim".to_string());
    }
    if manifest.registry_version != wire.manifest_registry_version {
        return Err("manifest registry version changed after claim".to_string());
    }
    if manifest.schema_version != wire.manifest_schema_version {
        return Err("manifest schema version changed after claim".to_string());
    }
    let recomputed = sha256(&manifest.content_json);
    if recomputed != manifest.content_hash || recomputed != wire.manifest_content_hash {
        return Err("manifest content changed after claim".to_string());
    }
    if manifest.action_id.as_deref() != Some(wire.action_id.as_str()) {
        return Err("manifest action binding changed after claim".to_string());
    }
    if manifest.agent_id != wire.agent_id {
        return Err("manifest Agent changed after claim".to_string());
    }
    let calls = execution_calls_from_content(&manifest.content_json)?;
    if calls != wire.calls {
        return Err("manifest execution call payload changed after claim".to_string());
    }
    Ok(())
}

fn settle_execution(
    conn: &Connection,
    execution_id: &str,
    status: &str,
    terminal_reason: Option<&str>,
    run_id: Option<&str>,
    bun_run_id: Option<&str>,
    evidence: Option<&serde_json::Value>,
) -> Result<(), String> {
    let evidence_json = evidence.map(|value| value.to_string());
    conn.execute(
        "UPDATE trusted_action_executions
         SET status = ?1,
             terminal_reason = ?2,
             run_id = ?3,
             bun_run_id = ?4,
             evidence_json = ?5,
             settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE execution_id = ?6",
        params![
            status,
            terminal_reason,
            run_id,
            bun_run_id,
            evidence_json,
            execution_id,
        ],
    )
    .map_err(|e| format!("failed to settle trusted execution '{execution_id}': {e}"))?;
    Ok(())
}

/// Transition a claimed execution to `dispatched` immediately before the
/// transport call. This is not a settled state, so `settled_at` stays null; a
/// crash after this point is reconciled as `ambiguous`, never replayed.
fn mark_dispatched(conn: &Connection, execution_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE trusted_action_executions
         SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE execution_id = ?2",
        params![STATUS_DISPATCHED, execution_id],
    )
    .map_err(|e| format!("failed to mark trusted execution dispatched: {e}"))?;
    Ok(())
}

/// Persist a receipt and prove it by reading it back. If the readback does not
/// show the expected status, the row is marked `ambiguous` rather than claiming
/// a state that was not durably observed.
fn settle_and_verify(
    conn: &Connection,
    execution_id: &str,
    expected_status: &str,
    terminal_reason: Option<&str>,
    run_id: Option<&str>,
    bun_run_id: Option<&str>,
    evidence: Option<&serde_json::Value>,
) -> TrustedActionExecution {
    if settle_execution(
        conn,
        execution_id,
        expected_status,
        terminal_reason,
        run_id,
        bun_run_id,
        evidence,
    )
    .is_ok()
    {
        if let Ok(row) = load_execution(conn, execution_id) {
            if row.status == expected_status {
                return row;
            }
        }
    }
    let _ = settle_execution(
        conn,
        execution_id,
        STATUS_AMBIGUOUS,
        Some("execution receipt could not be durably confirmed"),
        run_id,
        bun_run_id,
        evidence,
    );
    load_execution(conn, execution_id)
        .unwrap_or_else(|_| TrustedActionExecution {
            execution_id: execution_id.to_string(),
            idempotency_key: String::new(),
            action_id: String::new(),
            manifest_id: String::new(),
            manifest_registry_version: 0,
            manifest_content_hash: String::new(),
            manifest_schema_version: 0,
            agent_id: String::new(),
            project_root: String::new(),
            status: STATUS_AMBIGUOUS.to_string(),
            terminal_reason: Some("execution receipt could not be durably confirmed".to_string()),
            run_id: None,
            bun_run_id: None,
            evidence: None,
            started_at: None,
            settled_at: None,
            created_at: String::new(),
            updated_at: String::new(),
            conflict: None,
        })
}

fn insert_claimed_execution(
    conn: &Connection,
    execution_id: &str,
    key: &str,
    manifest: &ManifestScope,
    authority: &DispatchAuthority,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO trusted_action_executions
             (execution_id, idempotency_key, action_id, manifest_id, manifest_registry_version,
              manifest_content_hash, manifest_schema_version, agent_id, project_root,
              projection_slug, projection_source_hash, projection_active_source_hash,
              projection_version, projection_activated_at, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            execution_id,
            key,
            &authority.action_id,
            &manifest.manifest_id,
            manifest.registry_version,
            &manifest.content_hash,
            manifest.schema_version,
            &manifest.agent_id,
            &authority.project_root,
            &authority.snapshot.slug,
            &authority.snapshot.source_hash,
            &authority.snapshot.active_source_hash,
            authority.snapshot.projection_version,
            &authority.snapshot.activated_at,
            STATUS_CLAIMED,
        ],
    )
    .map_err(|e| format!("failed to claim trusted execution: {e}"))?;
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────

/// Execute the native-approved trusted manifest bound to `manifest_id` for the
/// active Action Registry `action_id`. Validates every identity, claims a
/// durable idempotency key, revalidates the projection at final dispatch, and
/// dispatches the manifest's exact calls through the private canonical
/// ToolRuntime capability path. Returns the durable receipt.
#[tauri::command]
pub async fn execute_trusted_manifest_action(
    app: tauri::AppHandle,
    action_id: String,
    manifest_id: String,
    expected_manifest_version: Option<i64>,
    expected_manifest_hash: Option<String>,
) -> Result<TrustedActionExecution, String> {
    let action_id = action_id.trim().to_string();
    let manifest_id = manifest_id.trim().to_string();
    if action_id.is_empty() || manifest_id.is_empty() {
        return Err("an exact action id and manifest id are required".to_string());
    }
    let expected_manifest_hash = normalize_optional(expected_manifest_hash);

    tauri::async_runtime::spawn_blocking(move || {
        run_trusted_execution(
            &app,
            &action_id,
            &manifest_id,
            expected_manifest_version,
            expected_manifest_hash.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("trusted execution task join error: {error}"))?
}

fn run_trusted_execution(
    app: &tauri::AppHandle,
    action_id: &str,
    manifest_id: &str,
    expected_manifest_version: Option<i64>,
    expected_manifest_hash: Option<&str>,
) -> Result<TrustedActionExecution, String> {
    use tauri::Manager;

    let execution_id;
    let wire;
    let captured_snapshot;

    // Phase 1: validate authority, claim durably, and release the DB lock before
    // any HTTP. The claim exists before dispatch so a crash cannot replay.
    {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

        // Durable idempotency is action-scoped: never mint a second execution for
        // the same action, even if the manifest was replaced/rebound or the Agent
        // projection changed after an ambiguous/partial run. An existing receipt
        // is returned with an explicit conflict rather than re-executing.
        let key = idempotency_key(action_id);
        let existing = load_execution_by_key(&conn, &key)?;
        let manifest = load_manifest_scope(&conn, manifest_id)?;
        if let Some(existing) = existing {
            let conflict = match manifest.as_ref() {
                Some(manifest) => conflict_for_existing(&conn, action_id, manifest, &existing),
                None => Some(TrustedExecutionConflict {
                    kind: "manifest_unavailable".to_string(),
                    detail: format!("trusted manifest '{manifest_id}' is not present"),
                }),
            };
            return Ok(attach_conflict(existing, conflict));
        }
        let manifest = manifest
            .ok_or_else(|| format!("trusted manifest not found: {manifest_id}"))?;
        if manifest.action_id.as_deref() != Some(action_id) {
            return Err(format!(
                "trusted manifest '{manifest_id}' is not bound to action '{action_id}'"
            ));
        }
        if manifest.schema_version != 1 {
            return Err(format!(
                "unsupported trusted manifest schema version: {}",
                manifest.schema_version
            ));
        }
        if let Some(version) = expected_manifest_version {
            if version != manifest.registry_version {
                return Err(format!(
                    "trusted manifest changed: expected registry version {version}, current is {}",
                    manifest.registry_version
                ));
            }
        }
        if let Some(hash) = expected_manifest_hash {
            if hash != manifest.content_hash {
                return Err(
                    "trusted manifest changed: expected content hash does not match".to_string(),
                );
            }
        }
        if sha256(&manifest.content_json) != manifest.content_hash {
            return Err(
                "trusted manifest content failed its canonical integrity check".to_string(),
            );
        }

        // Resolve the exact active/approved action and current projection. A
        // denial is persisted as waiting/blocked without any dispatch.
        let authority = match resolve_dispatch_authority(&conn, action_id, &manifest) {
            Ok(authority) => authority,
            Err(denial) => {
                let execution_id = uuid::Uuid::new_v4().to_string();
                insert_claimed_execution(
                    &conn,
                    &execution_id,
                    &key,
                    &manifest,
                    &DispatchAuthority {
                        action_id: action_id.to_string(),
                        project_root: manifest.project_root.clone(),
                        snapshot: empty_snapshot(&manifest.agent_id),
                    },
                )?;
                return Ok(settle_and_verify(
                    &conn,
                    &execution_id,
                    denial.status(),
                    Some(denial.reason()),
                    None,
                    None,
                    None,
                ));
            }
        };

        let calls = execution_calls_from_content(&manifest.content_json)?;
        let execution = uuid::Uuid::new_v4().to_string();
        insert_claimed_execution(&conn, &execution, &key, &manifest, &authority)?;
        captured_snapshot = authority.snapshot.clone();
        wire = TrustedExecutionRequestWire {
            execution_id: execution.clone(),
            action_id: authority.action_id.clone(),
            manifest_id: manifest_id.to_string(),
            manifest_registry_version: manifest.registry_version,
            manifest_content_hash: manifest.content_hash.clone(),
            manifest_schema_version: manifest.schema_version,
            agent_id: manifest.agent_id.clone(),
            project_root: authority.project_root.clone(),
            projection_slug: authority.snapshot.slug.clone(),
            projection_source_hash: authority.snapshot.source_hash.clone(),
            projection_active_source_hash: authority.snapshot.active_source_hash.clone(),
            projection_version: authority.snapshot.projection_version,
            calls,
            timeout_ms: WHOLE_RUN_TIMEOUT_MS,
            max_calls: MAX_EXECUTION_CALLS as u64,
        };
        execution_id = execution;
    }

    // Phase 2: final dispatch revalidation against persisted identity. If the
    // Agent/projection/root changed since the claim, block without dispatch.
    {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let manifest = load_manifest_scope(&conn, manifest_id)?
            .ok_or_else(|| format!("trusted manifest not found: {manifest_id}"))?;

        // Compare the complete persisted manifest identity against the wire/claim
        // before any request: id, registry/schema version, canonical content hash
        // (recomputed), action binding, Agent, and execution call payload.
        if let Err(reason) = verify_claimed_identity(&manifest, &wire) {
            return Ok(settle_and_verify(
                &conn,
                &execution_id,
                STATUS_BLOCKED,
                Some(&reason),
                None,
                None,
                None,
            ));
        }

        match resolve_dispatch_authority(&conn, action_id, &manifest) {
            Ok(authority)
                if authority.snapshot == captured_snapshot
                    && authority.project_root == wire.project_root => {}
            Ok(_) => {
                return Ok(settle_and_verify(
                    &conn,
                    &execution_id,
                    STATUS_BLOCKED,
                    Some(
                        "Agent projection or workspace root changed before dispatch; no effect was applied",
                    ),
                    None,
                    None,
                    None,
                ));
            }
            Err(denial) => {
                return Ok(settle_and_verify(
                    &conn,
                    &execution_id,
                    denial.status(),
                    Some(denial.reason()),
                    None,
                    None,
                    None,
                ));
            }
        }
        mark_dispatched(&conn, &execution_id)?;
    }

    // Phase 3: dispatch through the private authenticated capability path.
    let transport = crate::jarvis::memory::transport::native_memory_transport();
    let response = crate::jarvis::memory::transport::execute_trusted_manifest(transport, &wire);
    let db = app.state::<AppDb>();
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    match response {
        Ok(None) => Ok(settle_and_verify(
            &conn,
            &execution_id,
            STATUS_BLOCKED,
            Some("owned Bun runtime is not live; no execution was dispatched"),
            None,
            None,
            None,
        )),
        Err(reason) => Ok(settle_and_verify(
            &conn,
            &execution_id,
            STATUS_AMBIGUOUS,
            Some(&reason),
            None,
            None,
            None,
        )),
        Ok(Some(wire_response)) => {
            let (status, reason) = match wire_response.outcome.as_str() {
                "executed" => (STATUS_PENDING_ACCEPTANCE, None),
                "blocked" => (STATUS_BLOCKED, wire_response.reason.as_deref()),
                "waiting_for_user" => (STATUS_WAITING_FOR_USER, wire_response.reason.as_deref()),
                "failed" => (STATUS_FAILED, wire_response.reason.as_deref()),
                "cancelled" => (STATUS_CANCELLED, wire_response.reason.as_deref()),
                "partial" => (STATUS_PARTIAL, wire_response.reason.as_deref()),
                _ => (
                    STATUS_AMBIGUOUS,
                    Some("unrecognized execution outcome; receipt preserved for reconciliation"),
                ),
            };
            let evidence = serde_json::to_value(&wire_response.calls)
                .map_err(|e| format!("failed to serialize execution evidence: {e}"))?;
            Ok(settle_and_verify(
                &conn,
                &execution_id,
                status,
                reason,
                Some(&wire_response.run_id),
                Some(&wire_response.bun_instance_id),
                Some(&evidence),
            ))
        }
    }
}

/// Read one durable trusted execution receipt.
#[tauri::command]
pub fn get_trusted_execution(
    db: State<AppDb>,
    execution_id: String,
) -> Result<TrustedActionExecution, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    load_execution(&conn, execution_id.trim())
}

/// List durable trusted execution receipts for an action (newest first).
#[tauri::command]
pub fn list_trusted_executions(
    db: State<AppDb>,
    action_id: Option<String>,
) -> Result<Vec<TrustedActionExecution>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut rows = Vec::new();
    match normalize_optional(action_id) {
        Some(action_id) => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {EXECUTION_COLS} FROM trusted_action_executions WHERE action_id = ?1 ORDER BY created_at DESC"
                ))
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map([&action_id], map_execution_row)
                .map_err(|e| e.to_string())?;
            for row in mapped {
                rows.push(row.map_err(|e| e.to_string())?);
            }
        }
        None => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {EXECUTION_COLS} FROM trusted_action_executions ORDER BY created_at DESC"
                ))
                .map_err(|e| e.to_string())?;
            let mapped = stmt.query_map([], map_execution_row).map_err(|e| e.to_string())?;
            for row in mapped {
                rows.push(row.map_err(|e| e.to_string())?);
            }
        }
    }
    rows.into_iter().map(record_from_row).collect()
}

/// Explicit private cancel route. Only a non-terminal execution owned by this
/// native registry can be cancelled; the request aborts the real Bun
/// AbortSignal for that exact execution and never manufactures a terminal state.
#[tauri::command]
pub async fn cancel_trusted_execution(
    app: tauri::AppHandle,
    execution_id: String,
) -> Result<TrustedActionExecution, String> {
    let execution_id = execution_id.trim().to_string();
    if execution_id.is_empty() {
        return Err("an exact execution id is required".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let current = load_execution(&conn, &execution_id)?;
        if matches!(
            current.status.as_str(),
            STATUS_PENDING_ACCEPTANCE
                | STATUS_BLOCKED
                | STATUS_FAILED
                | STATUS_CANCELLED
                | STATUS_PARTIAL
                | STATUS_WAITING_FOR_USER
        ) {
            return Ok(current);
        }
        drop(conn);
        let transport = crate::jarvis::memory::transport::native_memory_transport();
        let _ = crate::jarvis::memory::transport::cancel_trusted_execution(transport, &execution_id);
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        load_execution(&conn, &execution_id)
    })
    .await
    .map_err(|error| format!("trusted cancel task join error: {error}"))?
}
