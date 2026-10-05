// ═══════════════════════════════════════════════════════════════
// Trusted Acceptance & Terminal Delivery — native authority
// (Roadmap Priority #2, Part 4)
// ═══════════════════════════════════════════════════════════════
//
// Acceptance is separate from execution. A tool run succeeding never verifies
// the Action Registry and never completes a Goal. Only after the exact durable
// execution receipt proves the approved manifest ran, and every native-stored
// acceptance check for every required Goal criterion has a runtime-owned output
// SHA-256 equal to the stored trusted expectation, does terminal delivery run:
// mark the exact Action Registry action done, then complete the Goal from the
// persisted accepted-evidence rows in one transaction.
//
// Callers supply only the execution identity. Acceptance calls, expected
// values, and the Goal identity are derived solely from the native trusted
// manifest and native Goal authority; no UI/model/registry text is trusted.

use crate::db::AppDb;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::commands::trusted_execution::{
    load_execution, load_manifest_scope, sha256, ManifestScope, TrustedActionExecution,
};

const ACCEPTANCE_TIMEOUT_MS: u64 = 600_000;
const MAX_ACCEPTANCE_CHECKS: usize = 500;

const STATUS_ACCEPTED: &str = "accepted";
const STATUS_REJECTED: &str = "rejected";
const STATUS_BLOCKED: &str = "blocked";
const STATUS_WAITING: &str = "waiting_for_user";
const STATUS_FAILED: &str = "failed";
const STATUS_CANCELLED: &str = "cancelled";
const STATUS_PARTIAL: &str = "partial";
const STATUS_AMBIGUOUS: &str = "ambiguous";

// ── Wire types (native ⇄ owned Bun child) ────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TrustedAcceptanceCheckWire {
    pub criterion_id: String,
    pub index: usize,
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
    pub expect_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrustedAcceptanceRequestWire {
    pub acceptance_id: String,
    pub execution_id: String,
    pub action_id: String,
    pub manifest_id: String,
    pub manifest_registry_version: i64,
    pub manifest_content_hash: String,
    pub manifest_schema_version: i64,
    pub agent_id: String,
    pub project_root: String,
    pub timeout_ms: u64,
    pub max_checks: u64,
    pub checks: Vec<TrustedAcceptanceCheckWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedAcceptanceCheckEvidenceWire {
    pub criterion_id: String,
    pub index: usize,
    pub tool: String,
    pub status: String,
    #[serde(default)]
    pub output_sha256: Option<String>,
    #[serde(default)]
    pub output_bytes: Option<u64>,
    #[serde(default)]
    pub matched: bool,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedAcceptanceResponseWire {
    pub acceptance_id: String,
    pub execution_id: String,
    pub action_id: String,
    pub manifest_id: String,
    pub manifest_registry_version: i64,
    pub manifest_content_hash: String,
    pub manifest_schema_version: i64,
    pub agent_id: String,
    pub project_root: String,
    pub bun_instance_id: String,
    pub run_id: String,
    pub outcome: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub calls: Vec<TrustedAcceptanceCheckEvidenceWire>,
    pub started_at: String,
    pub finished_at: String,
}

// ── DTOs returned to callers ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedAcceptanceCriterionReceipt {
    pub criterion_id: String,
    pub tool: String,
    pub check_index: i64,
    pub expected_sha256: String,
    pub actual_sha256: Option<String>,
    pub accepted: bool,
    pub evidence: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedAcceptanceReceipt {
    pub acceptance_key: String,
    pub execution_id: String,
    pub action_id: String,
    pub manifest_id: String,
    pub goal_id: String,
    pub status: String,
    pub terminal_reason: Option<String>,
    pub bun_run_id: Option<String>,
    pub bun_instance_id: Option<String>,
    pub evidence: Option<serde_json::Value>,
    pub runtime_started_at: Option<String>,
    pub runtime_finished_at: Option<String>,
    pub settled_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub criteria: Vec<TrustedAcceptanceCriterionReceipt>,
    /// True only after the Action Registry is terminally done and the Goal is
    /// completed with exact readback.
    pub confirmed: bool,
}

struct GoalScope {
    id: String,
    status: String,
    agent_id: String,
    project_root: Option<String>,
}

/// One bounded check result, ready to persist as a criterion receipt row.
struct AcceptanceCriterionRow {
    criterion_id: String,
    tool: String,
    check_index: i64,
    expected_sha256: String,
    actual_sha256: Option<String>,
    accepted: bool,
    evidence: Option<serde_json::Value>,
}

// ── Persistence ──────────────────────────────────────────────

fn load_acceptance(
    conn: &Connection,
    execution_id: &str,
) -> Result<Option<TrustedAcceptanceReceipt>, String> {
    let row = conn
        .query_row(
            "SELECT acceptance_key, execution_id, action_id, manifest_id, goal_id, status, \
                    terminal_reason, bun_run_id, bun_instance_id, evidence_json, \
                    runtime_started_at, runtime_finished_at, settled_at, created_at, updated_at \
             FROM trusted_acceptance_receipts WHERE execution_id = ?1",
            [execution_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((
        acceptance_key,
        execution_id,
        action_id,
        manifest_id,
        goal_id,
        status,
        terminal_reason,
        bun_run_id,
        bun_instance_id,
        evidence_json,
        runtime_started_at,
        runtime_finished_at,
        settled_at,
        created_at,
        updated_at,
    )) = row
    else {
        return Ok(None);
    };
    let evidence = evidence_json
        .map(|raw| serde_json::from_str::<serde_json::Value>(&raw))
        .transpose()
        .map_err(|e| format!("stored acceptance evidence is not valid JSON: {e}"))?;
    let criteria = load_criteria(conn, &acceptance_key)?;
    Ok(Some(TrustedAcceptanceReceipt {
        acceptance_key,
        execution_id,
        action_id,
        manifest_id,
        goal_id,
        status,
        terminal_reason,
        bun_run_id,
        bun_instance_id,
        evidence,
        runtime_started_at,
        runtime_finished_at,
        settled_at,
        created_at,
        updated_at,
        criteria,
        confirmed: false,
    }))
}

fn load_criteria(
    conn: &Connection,
    acceptance_key: &str,
) -> Result<Vec<TrustedAcceptanceCriterionReceipt>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT criterion_id, tool, check_index, expected_sha256, actual_sha256, accepted, \
                    evidence_json \
             FROM trusted_acceptance_criteria WHERE acceptance_key = ?1 \
             ORDER BY criterion_id ASC, check_index ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([acceptance_key], |row| {
            let evidence_json: Option<String> = row.get(6)?;
            Ok(TrustedAcceptanceCriterionReceipt {
                criterion_id: row.get(0)?,
                tool: row.get(1)?,
                check_index: row.get(2)?,
                expected_sha256: row.get(3)?,
                actual_sha256: row.get(4)?,
                accepted: row.get::<_, i64>(5)? != 0,
                evidence: evidence_json.and_then(|raw| serde_json::from_str(&raw).ok()),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[allow(clippy::too_many_arguments)]
fn write_acceptance(
    conn: &Connection,
    execution_id: &str,
    action_id: &str,
    manifest_id: &str,
    goal_id: &str,
    status: &str,
    reason: Option<&str>,
    run_id: Option<&str>,
    bun_instance_id: Option<&str>,
    runtime_started_at: Option<&str>,
    runtime_finished_at: Option<&str>,
    evidence: Option<&serde_json::Value>,
    criteria: &[AcceptanceCriterionRow],
) -> Result<(), String> {
    let key = execution_id.to_string(); // deterministic idempotency by execution id
    let evidence_json = evidence.map(|v| v.to_string());
    conn.execute(
        "INSERT INTO trusted_acceptance_receipts
             (acceptance_key, execution_id, action_id, manifest_id, goal_id, status,
              terminal_reason, bun_run_id, bun_instance_id, evidence_json,
              runtime_started_at, runtime_finished_at, settled_at)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(execution_id) DO UPDATE SET
             status = excluded.status,
             terminal_reason = excluded.terminal_reason,
             bun_run_id = excluded.bun_run_id,
             bun_instance_id = excluded.bun_instance_id,
             evidence_json = excluded.evidence_json,
             runtime_started_at = excluded.runtime_started_at,
             runtime_finished_at = excluded.runtime_finished_at,
             settled_at = excluded.settled_at,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        params![
            &key,
            action_id,
            manifest_id,
            goal_id,
            status,
            reason,
            run_id,
            bun_instance_id,
            evidence_json,
            runtime_started_at,
            runtime_finished_at,
        ],
    )
    .map_err(|e| format!("failed to write acceptance receipt: {e}"))?;

    conn.execute(
        "DELETE FROM trusted_acceptance_criteria WHERE acceptance_key = ?1",
        [&key],
    )
    .map_err(|e| format!("failed to reset acceptance criteria: {e}"))?;
    for row in criteria {
        conn.execute(
            "INSERT INTO trusted_acceptance_criteria
                 (id, acceptance_key, criterion_id, tool, check_index, expected_sha256,
                  actual_sha256, accepted, evidence_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                uuid::Uuid::new_v4().to_string(),
                &key,
                &row.criterion_id,
                &row.tool,
                row.check_index,
                &row.expected_sha256,
                &row.actual_sha256,
                if row.accepted { 1 } else { 0 },
                row.evidence.as_ref().map(|v| v.to_string()),
            ],
        )
        .map_err(|e| format!("failed to write acceptance criterion receipt: {e}"))?;
    }
    Ok(())
}

/// Write then read back the exact receipt; if the readback does not show the
/// expected status the receipt is downgraded to ambiguous. Never claims success
/// from an unconfirmed write.
#[allow(clippy::too_many_arguments)]
fn write_and_confirm(
    conn: &Connection,
    execution_id: &str,
    status: &str,
    reason: Option<&str>,
    run_id: Option<&str>,
    bun_instance_id: Option<&str>,
    runtime_started_at: Option<&str>,
    runtime_finished_at: Option<&str>,
    evidence: Option<&serde_json::Value>,
    criteria: &[AcceptanceCriterionRow],
    action_id: &str,
    manifest_id: &str,
    goal_id: &str,
) -> Result<TrustedAcceptanceReceipt, String> {
    if write_acceptance(
        conn,
        execution_id,
        action_id,
        manifest_id,
        goal_id,
        status,
        reason,
        run_id,
        bun_instance_id,
        runtime_started_at,
        runtime_finished_at,
        evidence,
        criteria,
    )
    .is_ok()
    {
        if let Some(receipt) = load_acceptance(conn, execution_id)? {
            if receipt.status == status {
                return Ok(receipt);
            }
        }
    }
    let _ = write_acceptance(
        conn,
        execution_id,
        action_id,
        manifest_id,
        goal_id,
        STATUS_AMBIGUOUS,
        Some("acceptance receipt could not be durably confirmed"),
        run_id,
        bun_instance_id,
        runtime_started_at,
        runtime_finished_at,
        evidence,
        criteria,
    );
    load_acceptance(conn, execution_id)?
        .ok_or_else(|| "acceptance receipt could not be read back".to_string())
}

// ── Validation / derivation ──────────────────────────────────

fn parse_content(
    manifest: &ManifestScope,
) -> Result<crate::commands::trusted_manifests::TrustedManifestContentV1, String> {
    serde_json::from_str(&manifest.content_json)
        .map_err(|e| format!("stored trusted manifest content is not a valid v1 manifest: {e}"))
}

/// Derive the Goal solely from the manifest's acceptance criterion UUID keys.
fn derive_goal(
    conn: &Connection,
    manifest: &ManifestScope,
    criterion_ids: &[String],
) -> Result<GoalScope, String> {
    if criterion_ids.is_empty() {
        return Err("trusted manifest declares no acceptance criteria".to_string());
    }
    let mut goal_id: Option<String> = None;
    for criterion_id in criterion_ids {
        let owner: Option<String> = conn
            .query_row(
                "SELECT goal_id FROM goal_criteria WHERE id = ?1",
                [criterion_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let owner = owner.ok_or_else(|| {
            format!(
                "acceptance criterion '{criterion_id}' does not match any current Goal criterion"
            )
        })?;
        match &goal_id {
            Some(existing) if existing != &owner => {
                return Err(
                    "acceptance criteria resolve to more than one Goal; refusing ambiguous acceptance"
                        .to_string(),
                );
            }
            _ => goal_id = Some(owner),
        }
    }
    let goal_id = goal_id.ok_or_else(|| "acceptance criteria resolved to no Goal".to_string())?;

    let goal = conn
        .query_row(
            "SELECT id, status, agent_id, project_root FROM goals WHERE id = ?1",
            [&goal_id],
            |row| {
                Ok(GoalScope {
                    id: row.get(0)?,
                    status: row.get(1)?,
                    agent_id: row.get(2)?,
                    project_root: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Goal '{goal_id}' not found"))?;

    let mut required: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM goal_criteria WHERE goal_id = ?1")
            .map_err(|e| e.to_string())?;
        stmt.query_map([&goal_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut declared: Vec<String> = criterion_ids.to_vec();
    declared.sort();
    declared.dedup();
    required.sort();
    if declared != required {
        return Err(
            "manifest acceptance criteria are not the Goal's complete required criterion set"
                .to_string(),
        );
    }

    if goal.status == "failed" || goal.status == "cancelled" {
        return Err(format!(
            "Goal '{}' is terminal ('{}'); acceptance cannot deliver it",
            goal.id, goal.status
        ));
    }
    if goal.agent_id != manifest.agent_id {
        return Err(format!(
            "Goal Agent '{}' does not match manifest Agent '{}'",
            goal.agent_id, manifest.agent_id
        ));
    }
    match goal.project_root.as_deref() {
        Some(root) => {
            let goal_root = crate::jarvis::memory::scope::normalize_project_root(root)
                .map_err(|e| format!("Goal project root unavailable: {e}"))?;
            let manifest_root =
                crate::jarvis::memory::scope::normalize_project_root(&manifest.project_root)
                    .map_err(|e| format!("manifest project root unavailable: {e}"))?;
            if goal_root != manifest_root {
                return Err("Goal workspace does not match manifest workspace".to_string());
            }
        }
        None => {
            return Err("Goal has no workspace binding for trusted acceptance".to_string());
        }
    }
    Ok(goal)
}

/// Validate the durable execution receipt and the current authority before any
/// acceptance check is dispatched.
fn validate_execution(
    conn: &Connection,
    execution: &TrustedActionExecution,
) -> Result<ManifestScope, String> {
    if execution.status != crate::commands::trusted_execution::STATUS_PENDING_ACCEPTANCE {
        return Err(format!(
            "execution '{}' is not awaiting acceptance (status '{}')",
            execution.execution_id, execution.status
        ));
    }
    if execution.execution_id.trim().is_empty()
        || execution.action_id.trim().is_empty()
        || execution.manifest_id.trim().is_empty()
        || execution
            .bun_run_id
            .as_deref()
            .map(|v| v.trim().is_empty())
            .unwrap_or(true)
    {
        return Err("execution receipt is missing required identity fields".to_string());
    }

    let manifest = load_manifest_scope(conn, &execution.manifest_id)?
        .ok_or_else(|| format!("trusted manifest not found: {}", execution.manifest_id))?;
    if manifest.action_id.as_deref() != Some(execution.action_id.as_str()) {
        return Err("manifest is no longer bound to the execution's action".to_string());
    }
    if manifest.schema_version != 1 {
        return Err("unsupported trusted manifest schema version".to_string());
    }
    if sha256(&manifest.content_json) != manifest.content_hash {
        return Err("stored manifest content failed its canonical integrity check".to_string());
    }
    if manifest.content_hash != execution.manifest_content_hash
        || manifest.registry_version != execution.manifest_registry_version
    {
        return Err("manifest changed since execution; acceptance is stale".to_string());
    }

    // Native receipt runtime identity/bounds must be present.
    let run_id = execution.run_id.as_deref().unwrap_or("");
    let bun_run_id = execution.bun_run_id.as_deref().unwrap_or("");
    let runtime_started = execution.runtime_started_at.as_deref().unwrap_or("");
    let runtime_finished = execution.runtime_finished_at.as_deref().unwrap_or("");
    if run_id.trim().is_empty()
        || bun_run_id.trim().is_empty()
        || runtime_started.trim().is_empty()
        || runtime_finished.trim().is_empty()
    {
        return Err(
            "execution receipt is missing runtime run identity or bounds".to_string()
        );
    }

    let content = parse_content(&manifest)?;
    let declared = content.execution.len();
    let evidence_items = execution
        .evidence
        .as_ref()
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if declared == 0 || evidence_items.len() != declared {
        return Err("execution evidence does not cover every declared execution call".to_string());
    }
    for (index, item) in evidence_items.iter().enumerate() {
        let item_index = item.get("index").and_then(|v| v.as_i64());
        if item_index != Some(index as i64) {
            return Err(format!(
                "execution evidence at position {index} has a mismatched index; reordered or duplicated evidence is refused"
            ));
        }
        let item_tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("");
        if item_tool != content.execution[index].tool {
            return Err(format!(
                "execution evidence at position {index} does not match the declared tool"
            ));
        }
        if item.get("status").and_then(|v| v.as_str()) != Some("ok") {
            return Err("execution evidence contains a non-successful call".to_string());
        }
        let output_sha = item.get("output_sha256").and_then(|v| v.as_str()).unwrap_or("");
        if !is_sha256_hex(output_sha) {
            return Err(format!(
                "execution evidence at position {index} is missing a valid output hash"
            ));
        }
        if item.get("output_bytes").and_then(|v| v.as_u64()).is_none() {
            return Err(format!(
                "execution evidence at position {index} is missing its bounded output size"
            ));
        }
    }

    match crate::commands::agents::resolve_activation_boundary(conn, &manifest.agent_id) {
        Ok(_) => {}
        Err(denial) => {
            return Err(format!(
                "Agent authority is not currently valid: {}",
                denial.reason()
            ))
        }
    }
    let root = crate::jarvis::memory::scope::normalize_project_root(&manifest.project_root)
        .map_err(|e| format!("manifest project root unavailable: {e}"))?;
    if root != execution.project_root || manifest.agent_id != execution.agent_id {
        return Err("execution scope no longer matches the current manifest scope".to_string());
    }

    // Exactly one current active Action Registry row with approval satisfied.
    crate::commands::action_registry::resolve_bindable_action_conn(conn, &execution.action_id)?;
    Ok(manifest)
}

fn content_acceptance_keys(manifest: &ManifestScope) -> Result<Vec<String>, String> {
    let content = parse_content(manifest)?;
    Ok(content.acceptance.keys().cloned().collect())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Record a non-terminal delivery/reconciliation reason on an already-`accepted`
/// receipt WITHOUT changing its status. Accepted check evidence is never lost.
fn set_delivery_reason(conn: &Connection, execution_id: &str, reason: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE trusted_acceptance_receipts
         SET terminal_reason = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE execution_id = ?2 AND status = ?3",
        params![reason, execution_id, STATUS_ACCEPTED],
    )
    .map_err(|e| format!("failed to record acceptance delivery reason: {e}"))?;
    Ok(())
}

// ── Command ──────────────────────────────────────────────────

#[tauri::command]
pub async fn run_trusted_acceptance(
    app: tauri::AppHandle,
    execution_id: String,
) -> Result<TrustedAcceptanceReceipt, String> {
    let execution_id = execution_id.trim().to_string();
    if execution_id.is_empty() {
        return Err("an exact execution id is required".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run_acceptance(&app, &execution_id))
        .await
        .map_err(|e| format!("trusted acceptance task join error: {e}"))?
}

fn run_acceptance(
    app: &tauri::AppHandle,
    execution_id: &str,
) -> Result<TrustedAcceptanceReceipt, String> {
    use tauri::Manager;

    // Phase 1: validate, derive identity, and detect an already-accepted attempt.
    let (manifest, goal_id, checks, acceptance_key, already_accepted) = {
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let execution = load_execution(&conn, execution_id)?;
        let manifest = validate_execution(&conn, &execution)?;
        let content = parse_content(&manifest)?;

        let mut criterion_ids: Vec<String> = content.acceptance.keys().cloned().collect();
        criterion_ids.sort();
        let goal = derive_goal(&conn, &manifest, &criterion_ids)?;

        let mut checks: Vec<TrustedAcceptanceCheckWire> = Vec::new();
        for criterion_id in &criterion_ids {
            let Some(criterion_checks) = content.acceptance.get(criterion_id) else {
                return Err(format!(
                    "missing acceptance checks for criterion '{criterion_id}'"
                ));
            };
            for (index, check) in criterion_checks.iter().enumerate() {
                let arguments = match &check.arguments {
                    Some(args) => Some(
                        serde_json::to_value(args)
                            .map_err(|e| format!("failed to encode acceptance arguments: {e}"))?,
                    ),
                    None => None,
                };
                checks.push(TrustedAcceptanceCheckWire {
                    criterion_id: criterion_id.clone(),
                    index,
                    tool: check.tool.clone(),
                    arguments,
                    expect_sha256: check.expect_sha256.clone(),
                });
            }
        }
        if checks.is_empty() || checks.len() > MAX_ACCEPTANCE_CHECKS {
            return Err("acceptance check list is empty or exceeds the bound".to_string());
        }

        // A non-accepted attempt is returned as-is. An accepted attempt is REUSED
        // for terminal delivery without re-running any check, so persisted
        // accepted evidence is never lost or regenerated.
        let already_accepted = match load_acceptance(&conn, execution_id)? {
            Some(existing) if existing.status != STATUS_ACCEPTED => return Ok(existing),
            Some(_) => true,
            None => false,
        };

        (
            manifest,
            goal.id,
            checks,
            execution_id.to_string(),
            already_accepted,
        )
    };

    let action_id = manifest
        .action_id
        .clone()
        .ok_or_else(|| "manifest has no action binding".to_string())?;

    let mut run_id: Option<String> = None;
    let mut bun_instance_id: Option<String> = None;
    let mut runtime_started: Option<String> = None;
    let mut runtime_finished: Option<String> = None;
    let mut criteria: Vec<AcceptanceCriterionRow> = Vec::new();

    if already_accepted {
        // Reuse the persisted accepted evidence; never rerun checks.
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let existing = load_acceptance(&conn, execution_id)?
            .ok_or_else(|| "accepted receipt disappeared".to_string())?;
        if existing.status != STATUS_ACCEPTED {
            return Ok(existing);
        }
        if existing.criteria.iter().filter(|c| c.accepted).count() != checks.len() {
            return Err(
                "persisted accepted evidence does not cover every acceptance check".to_string(),
            );
        }
        criteria = existing
            .criteria
            .iter()
            .map(|c| AcceptanceCriterionRow {
                criterion_id: c.criterion_id.clone(),
                tool: c.tool.clone(),
                check_index: c.check_index,
                expected_sha256: c.expected_sha256.clone(),
                actual_sha256: c.actual_sha256.clone(),
                accepted: c.accepted,
                evidence: c.evidence.clone(),
            })
            .collect();
        run_id = existing.bun_run_id.clone();
        bun_instance_id = existing.bun_instance_id.clone();
        runtime_started = existing.runtime_started_at.clone();
        runtime_finished = existing.runtime_finished_at.clone();
    } else {
        // Phase 2: dispatch acceptance checks through the private capability path.
        let request = TrustedAcceptanceRequestWire {
            acceptance_id: acceptance_key.clone(),
            execution_id: execution_id.to_string(),
            action_id: action_id.clone(),
            manifest_id: manifest.manifest_id.clone(),
            manifest_registry_version: manifest.registry_version,
            manifest_content_hash: manifest.content_hash.clone(),
            manifest_schema_version: manifest.schema_version,
            agent_id: manifest.agent_id.clone(),
            project_root: manifest.project_root.clone(),
            timeout_ms: ACCEPTANCE_TIMEOUT_MS,
            max_checks: checks.len() as u64,
            checks: checks.clone(),
        };
        let transport = crate::jarvis::memory::transport::native_memory_transport();
        let response =
            crate::jarvis::memory::transport::execute_trusted_acceptance(transport, &request);

        // Phase 3: persist attempt + evidence and confirm by readback.
        let db = app.state::<AppDb>();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

        let mut status = STATUS_AMBIGUOUS;
        let mut reason: Option<String> = None;
        let mut evidence: Option<serde_json::Value> = None;

        match response {
            Ok(None) => {
                status = STATUS_BLOCKED;
                reason = Some(
                    "owned Bun runtime is not live; acceptance was not dispatched".to_string(),
                );
            }
            Err(err) => {
                status = STATUS_AMBIGUOUS;
                reason = Some(err);
            }
            Ok(Some(resp)) => {
                // Exact echo + one-to-one coverage integrity. Any mismatch is
                // nonterminal/ambiguous and never finalizes.
                let echo_ok = resp.acceptance_id == acceptance_key
                    && resp.execution_id == execution_id
                    && resp.action_id == action_id
                    && resp.manifest_id == manifest.manifest_id
                    && resp.manifest_registry_version == manifest.registry_version
                    && resp.manifest_content_hash == manifest.content_hash
                    && resp.manifest_schema_version == manifest.schema_version
                    && resp.agent_id == manifest.agent_id
                    && resp.project_root == manifest.project_root
                    && !resp.bun_instance_id.trim().is_empty()
                    && !resp.run_id.trim().is_empty()
                    && !resp.started_at.trim().is_empty()
                    && !resp.finished_at.trim().is_empty()
                    && resp.calls.len() == checks.len();

                if !echo_ok {
                    status = STATUS_AMBIGUOUS;
                    reason = Some(
                        "acceptance response did not echo the requested identity".to_string(),
                    );
                } else {
                    let mut seen: std::collections::BTreeSet<(String, usize)> =
                        std::collections::BTreeSet::new();
                    let mut unique = true;
                    let mut by_key: std::collections::BTreeMap<
                        (String, usize),
                        &TrustedAcceptanceCheckEvidenceWire,
                    > = std::collections::BTreeMap::new();
                    for c in &resp.calls {
                        if !seen.insert((c.criterion_id.clone(), c.index)) {
                            unique = false;
                            break;
                        }
                        by_key.insert((c.criterion_id.clone(), c.index), c);
                    }
                    if !unique {
                        status = STATUS_AMBIGUOUS;
                        reason = Some(
                            "acceptance response contained duplicate check identities".to_string(),
                        );
                    } else {
                        let mut all_ok = true;
                        for check in &checks {
                            let actual = by_key.get(&(check.criterion_id.clone(), check.index));
                            let ok = actual
                                .map(|c| {
                                    c.tool == check.tool
                                        && c.status == "ok"
                                        && c.matched
                                        && c.output_bytes.is_some()
                                        && c.output_sha256.as_deref()
                                            == Some(check.expect_sha256.as_str())
                                })
                                .unwrap_or(false);
                            if !ok {
                                all_ok = false;
                            }
                            criteria.push(AcceptanceCriterionRow {
                                criterion_id: check.criterion_id.clone(),
                                tool: check.tool.clone(),
                                check_index: check.index as i64,
                                expected_sha256: check.expect_sha256.clone(),
                                actual_sha256: actual.and_then(|c| c.output_sha256.clone()),
                                accepted: ok,
                                evidence: actual.and_then(|c| serde_json::to_value(c).ok()),
                            });
                        }
                        if all_ok && resp.outcome == STATUS_ACCEPTED {
                            status = STATUS_ACCEPTED;
                        } else {
                            status = match resp.outcome.as_str() {
                                STATUS_BLOCKED => STATUS_BLOCKED,
                                STATUS_WAITING => STATUS_WAITING,
                                STATUS_FAILED => STATUS_FAILED,
                                STATUS_CANCELLED => STATUS_CANCELLED,
                                STATUS_PARTIAL => STATUS_PARTIAL,
                                _ => STATUS_REJECTED,
                            };
                        }
                        reason = resp.reason.clone();
                        run_id = Some(resp.run_id.clone());
                        bun_instance_id = Some(resp.bun_instance_id.clone());
                        runtime_started = Some(resp.started_at.clone());
                        runtime_finished = Some(resp.finished_at.clone());
                        evidence = serde_json::to_value(&resp.calls)
                            .map_err(|e| format!("failed to serialize acceptance evidence: {e}"))?;
                    }
                }
            }
        }

        let receipt = write_and_confirm(
            &conn,
            execution_id,
            status,
            reason.as_deref(),
            run_id.as_deref(),
            bun_instance_id.as_deref(),
            runtime_started.as_deref(),
            runtime_finished.as_deref(),
            evidence.as_ref(),
            &criteria,
            &action_id,
            &manifest.manifest_id,
            &goal_id,
        )?;
        if receipt.status != STATUS_ACCEPTED {
            return Ok(receipt);
        }
    }

    // Phase 4 (E): mark the exact Action Registry action terminally done. This
    // performs registry file I/O (and a DB config lookup), so it MUST run with
    // NO DB lock held.
    let db = app.state::<AppDb>();
    let evidence_report = serde_json::json!({
        "run_id": &run_id,
        "status": "accepted",
        "acceptance_result": "accepted",
        "started_at": &runtime_started,
        "finished_at": &runtime_finished,
        "execution_id": execution_id,
        "manifest_id": &manifest.manifest_id,
        "goal_id": &goal_id,
    });
    let terminal = crate::commands::action_registry::finalize_action_registry_done(
        db.inner(),
        &action_id,
        &evidence_report,
    )
    .and_then(|_| {
        crate::commands::action_registry::verify_action_registry_done(
            db.inner(),
            &action_id,
            &evidence_report,
        )
    });
    if let Err(e) = terminal {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = set_delivery_reason(
            &conn,
            execution_id,
            &format!("Action Registry terminal not confirmed: {e}"),
        );
        let mut receipt = load_acceptance(&conn, execution_id)?
            .ok_or_else(|| "accepted receipt missing after registry attempt".to_string())?;
        receipt.confirmed = false;
        return Ok(receipt);
    }

    // Phase 5 (F): revalidate persisted state, then complete the Goal from the
    // accepted rows in one transaction.
    let accepted_criterion_ids: Vec<String> = criteria
        .iter()
        .filter(|c| c.accepted)
        .map(|c| c.criterion_id.clone())
        .collect();
    let receipt_ref = format!("trusted_acceptance:{acceptance_key}");
    let complete_result = (|| -> Result<(), String> {
        let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());

        let receipt_now = load_acceptance(&conn, execution_id)?
            .ok_or_else(|| "acceptance receipt missing before Goal completion".to_string())?;
        if receipt_now.status != STATUS_ACCEPTED {
            return Err("acceptance receipt is no longer accepted".to_string());
        }
        let execution_now = load_execution(&conn, execution_id)?;
        validate_execution(&conn, &execution_now)?;
        let manifest_now = load_manifest_scope(&conn, &manifest.manifest_id)?
            .ok_or_else(|| "trusted manifest not found before Goal completion".to_string())?;
        let keys_now = content_acceptance_keys(&manifest_now)?;
        derive_goal(&conn, &manifest_now, &keys_now)?;

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crate::commands::goals::complete_goal_from_accepted_evidence(
            &tx,
            &goal_id,
            &acceptance_key,
            &accepted_criterion_ids,
            checks.len(),
            &receipt_ref,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(e) = complete_result {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = set_delivery_reason(
            &conn,
            execution_id,
            &format!("Goal completion not confirmed: {e}"),
        );
        let mut receipt = load_acceptance(&conn, execution_id)?
            .ok_or_else(|| "accepted receipt missing after Goal attempt".to_string())?;
        receipt.confirmed = false;
        return Ok(receipt);
    }

    // Exact readback before confirming: Goal terminal proof, receipt + criteria.
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    crate::commands::goals::verify_goal_terminal_evidence(&conn, &goal_id, &receipt_ref)?;
    let mut receipt = load_acceptance(&conn, execution_id)?
        .ok_or_else(|| "acceptance receipt missing after confirmation".to_string())?;
    let accepted_ok = receipt.status == STATUS_ACCEPTED
        && receipt.criteria.iter().filter(|c| c.accepted).count() == checks.len();
    receipt.confirmed = accepted_ok;
    Ok(receipt)
}

/// Read back one durable acceptance receipt (idempotent reconciliation).
#[tauri::command]
pub fn get_trusted_acceptance(
    db: State<AppDb>,
    execution_id: String,
) -> Result<Option<TrustedAcceptanceReceipt>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    load_acceptance(&conn, execution_id.trim())
}
