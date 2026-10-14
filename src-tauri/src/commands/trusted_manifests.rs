// ═══════════════════════════════════════════════════════════════
// Trusted Acceptance Manifest Registry — native trust authority
// (Roadmap Priority #2, Part 4 slice 1)
// ═══════════════════════════════════════════════════════════════
//
// This registry is the single native trust authority for acceptance manifests.
// It lives in the app-owned SQLite `jarvis.db` (via `AppDb`), distinct from the
// mutable file-backed Action Registry under `workspace/action-registry`, which
// remains untrusted action data. Goals, the Action Registry, model output, and
// task text may reference a manifest ID, but none of them can create, supply,
// replace, or authorize manifest content: only an explicit user add/replace in
// the Settings trust surface writes here.
//
// Registering a manifest grants NO tool permission and performs no execution.
// The record is deterministic data bound to an exact enabled Agent and a
// canonical existing workspace root; later Part 4 slices must still resolve the
// manifest and pass current ToolRuntime Permission policy before any effect.
//
// There are no auto-seeded executable manifests. An empty table means no
// trusted executable manifest exists.

use crate::db::AppDb;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Content schema version accepted by this slice. Bump only with a new strictly
/// validated shape; unknown versions are rejected.
const TRUSTED_MANIFEST_SCHEMA_VERSION: i64 = 1;

/// Bounds keep the registry from encoding unbounded payloads. `MAX_CONTENT_BYTES`
/// is the total manifest cap and therefore also bounds the sum of all write
/// payloads; each individual payload additionally has `MAX_PAYLOAD_BYTES`.
const MAX_CONTENT_BYTES: usize = 64 * 1024;
const MAX_EXECUTION_CALLS: usize = 50;
const MAX_ACCEPTANCE_CRITERIA: usize = 100;
const MAX_CHECKS_PER_CRITERION: usize = 50;
const MAX_TOTAL_ACCEPTANCE_CHECKS: usize = 200;
const MAX_PATH_LEN: usize = 1024;
const MAX_PATTERN_LEN: usize = 512;
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// Acceptance checks stay deterministic and read-only: only these tools may
/// appear under `acceptance`.
const ACCEPTANCE_TOOLS: &[&str] = &["read_file", "list_directory", "glob", "grep"];

/// Approved execution calls may additionally use the minimal bounded writers
/// `write_file` and `edit_file`, which carry bounded UTF-8 payloads with exact
/// per-tool argument shapes. Shell tools (`bash`, `powershell`), the
/// unbounded/array writers (`apply_patch`, `multi_edit`), web tools, and any
/// template/script field remain excluded, so a manifest cannot smuggle a shell
/// command, script, or unbounded payload. These tools still run later through
/// the canonical ToolRuntime in an Agent context under current Permission
/// policy; listing a writer here grants no permission and bypasses no approval.
const EXECUTION_TOOLS: &[&str] = &[
    "read_file",
    "list_directory",
    "glob",
    "grep",
    "write_file",
    "edit_file",
];
const ALLOWED_OUTPUT_MODES: &[&str] = &["files_with_matches", "content", "count"];

const TRUSTED_MANIFEST_COLS: &str = "manifest_id, registry_version, schema_version, \
     content_hash, content_json, agent_id, project_root, action_id, created_at, updated_at";

// ── v1 content shape ─────────────────────────────────────────

/// Bounded scalar arguments accepted for a v1 ToolRuntime call. Unknown keys
/// (including any `command`, `shell`, `script`, `template`, or free-form `args`
/// field) are rejected by `deny_unknown_fields`. `content`, `old_string`, and
/// `new_string` are the only payload fields and exist solely for the bounded
/// execution writers; they are rejected for every read-only tool and for all
/// acceptance checks.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCallArgumentsV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_string: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_string: Option<String>,
}

/// One explicit execution call in the approved action's call list. It carries
/// the canonical ToolRuntime tool identity and bounded arguments only — never a
/// command string. Execution calls may use the bounded writers `write_file` and
/// `edit_file` (bounded UTF-8 payloads, workspace-relative paths); acceptance
/// checks may not.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCallV1 {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<ToolCallArgumentsV1>,
}

/// One criterion-keyed acceptance check. The runtime executes the bounded call
/// and compares the deterministic result's canonical SHA-256 to `expect_sha256`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptanceCheckV1 {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<ToolCallArgumentsV1>,
    pub expect_sha256: String,
}

/// Exact v1 trusted acceptance manifest content. `execution` is the explicit
/// approved call list; `acceptance` maps a stable Goal criterion ID to the
/// deterministic checks that accept it (each with an expected SHA-256 result).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedManifestContentV1 {
    pub schema_version: u32,
    pub execution: Vec<ToolCallV1>,
    pub acceptance: std::collections::BTreeMap<String, Vec<AcceptanceCheckV1>>,
}

/// Validated, canonicalized manifest content ready to persist.
pub struct ValidatedTrustedManifest {
    pub schema_version: i64,
    pub canonical_json: String,
    pub content_hash: String,
    pub content: serde_json::Value,
}

// ── DTO returned to the UI ───────────────────────────────────

/// One registered manifest as shown in Settings. Read-only: the UI displays the
/// native ID/version/schema/hash, bound Action Registry id, and Agent/workspace
/// scope, and never infers trust from registry/model/Goal text. `action_id` is
/// `None` only for legacy rows created before action binding existed; such rows
/// are unbound/unavailable until explicitly replaced/rebound.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedAcceptanceManifest {
    pub manifest_id: String,
    pub registry_version: i64,
    pub schema_version: i64,
    pub content_hash: String,
    pub content: serde_json::Value,
    pub agent_id: String,
    pub project_root: String,
    pub action_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ── Validation ───────────────────────────────────────────────

fn has_control_chars(value: &str) -> bool {
    value.chars().any(|c| c == '\0' || c.is_control())
}

fn validate_relative_path(label: &str, raw: &str) -> Result<(), String> {
    if raw.trim().is_empty() {
        return Err(format!("{label}: path must not be empty"));
    }
    if raw.len() > MAX_PATH_LEN {
        return Err(format!("{label}: path exceeds {MAX_PATH_LEN} characters"));
    }
    if has_control_chars(raw) {
        return Err(format!("{label}: path contains control characters"));
    }
    if raw.starts_with('/') || raw.starts_with('\\') || raw.starts_with("//") {
        return Err(format!("{label}: path must be workspace-relative, not absolute"));
    }
    if raw.as_bytes().get(1) == Some(&b':') {
        return Err(format!("{label}: path must not use a drive prefix"));
    }
    for component in std::path::Path::new(raw).components() {
        match component {
            std::path::Component::ParentDir => {
                return Err(format!("{label}: path must not contain '..'"));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(format!("{label}: path must be workspace-relative"));
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_pattern(label: &str, raw: &str) -> Result<(), String> {
    if raw.trim().is_empty() {
        return Err(format!("{label}: pattern must not be empty"));
    }
    if raw.len() > MAX_PATTERN_LEN {
        return Err(format!("{label}: pattern exceeds {MAX_PATTERN_LEN} characters"));
    }
    if has_control_chars(raw) {
        return Err(format!("{label}: pattern contains control characters"));
    }
    Ok(())
}

fn validate_opt_range(
    label: &str,
    value: Option<u32>,
    min: u32,
    max: u32,
) -> Result<(), String> {
    if let Some(n) = value {
        if n < min || n > max {
            return Err(format!("{label}: must be between {min} and {max}"));
        }
    }
    Ok(())
}

fn reject_present<T>(label: &str, field: &str, value: &Option<T>) -> Result<(), String> {
    if value.is_some() {
        Err(format!("{label}: does not accept '{field}'"))
    } else {
        Ok(())
    }
}

/// Reject every payload field. Used by read-only tools and acceptance checks so
/// a write payload can never ride on a read-only call.
fn reject_payload_fields(label: &str, a: &ToolCallArgumentsV1) -> Result<(), String> {
    reject_present(label, "content", &a.content)?;
    reject_present(label, "old_string", &a.old_string)?;
    reject_present(label, "new_string", &a.new_string)
}

/// A bounded UTF-8 payload for the execution writers. Rust strings are already
/// valid UTF-8; NUL is rejected and length is capped at `MAX_PAYLOAD_BYTES`, with
/// the overall manifest cap bounding the total.
fn validate_payload(label: &str, raw: &str) -> Result<(), String> {
    if raw.len() > MAX_PAYLOAD_BYTES {
        return Err(format!("{label}: payload exceeds {MAX_PAYLOAD_BYTES} bytes"));
    }
    if raw.contains('\0') {
        return Err(format!("{label}: payload contains a NUL byte"));
    }
    Ok(())
}

/// Validate one ToolRuntime call. `allow_writers` selects the allowlist:
/// execution calls may use `write_file`/`edit_file`; acceptance checks are
/// read-only. Every argument must match the exact bounded shape for the tool.
fn validate_call_tool(
    label: &str,
    tool: &str,
    args: Option<&ToolCallArgumentsV1>,
    allow_writers: bool,
) -> Result<(), String> {
    let allowed = if allow_writers { EXECUTION_TOOLS } else { ACCEPTANCE_TOOLS };
    if !allowed.contains(&tool) {
        let kind = if allow_writers { "execution" } else { "acceptance" };
        return Err(format!(
            "{label}: tool '{tool}' is not allowlisted for {kind} calls"
        ));
    }
    let empty = ToolCallArgumentsV1::default();
    let a = args.unwrap_or(&empty);
    match tool {
        "read_file" => {
            let path = a
                .path
                .as_deref()
                .ok_or_else(|| format!("{label}: read_file requires 'path'"))?;
            validate_relative_path(&format!("{label}.path"), path)?;
            reject_present(label, "pattern", &a.pattern)?;
            reject_present(label, "output_mode", &a.output_mode)?;
            reject_present(label, "head_limit", &a.head_limit)?;
            validate_opt_range(&format!("{label}.offset"), a.offset, 1, 1_000_000)?;
            validate_opt_range(&format!("{label}.limit"), a.limit, 1, 10_000)?;
            reject_payload_fields(label, a)?;
        }
        "list_directory" => {
            let path = a
                .path
                .as_deref()
                .ok_or_else(|| format!("{label}: list_directory requires 'path'"))?;
            validate_relative_path(&format!("{label}.path"), path)?;
            reject_present(label, "pattern", &a.pattern)?;
            reject_present(label, "offset", &a.offset)?;
            reject_present(label, "limit", &a.limit)?;
            reject_present(label, "output_mode", &a.output_mode)?;
            reject_present(label, "head_limit", &a.head_limit)?;
            reject_payload_fields(label, a)?;
        }
        "glob" => {
            let pattern = a
                .pattern
                .as_deref()
                .ok_or_else(|| format!("{label}: glob requires 'pattern'"))?;
            validate_pattern(&format!("{label}.pattern"), pattern)?;
            if let Some(path) = a.path.as_deref() {
                validate_relative_path(&format!("{label}.path"), path)?;
            }
            reject_present(label, "offset", &a.offset)?;
            reject_present(label, "limit", &a.limit)?;
            reject_present(label, "output_mode", &a.output_mode)?;
            reject_present(label, "head_limit", &a.head_limit)?;
            reject_payload_fields(label, a)?;
        }
        "grep" => {
            let pattern = a
                .pattern
                .as_deref()
                .ok_or_else(|| format!("{label}: grep requires 'pattern'"))?;
            validate_pattern(&format!("{label}.pattern"), pattern)?;
            if let Some(path) = a.path.as_deref() {
                validate_relative_path(&format!("{label}.path"), path)?;
            }
            if let Some(mode) = a.output_mode.as_deref() {
                if !ALLOWED_OUTPUT_MODES.contains(&mode) {
                    return Err(format!("{label}.output_mode: unsupported output mode '{mode}'"));
                }
            }
            validate_opt_range(&format!("{label}.head_limit"), a.head_limit, 1, 1000)?;
            reject_present(label, "offset", &a.offset)?;
            reject_present(label, "limit", &a.limit)?;
            reject_payload_fields(label, a)?;
        }
        "write_file" => {
            let path = a
                .path
                .as_deref()
                .ok_or_else(|| format!("{label}: write_file requires 'path'"))?;
            validate_relative_path(&format!("{label}.path"), path)?;
            let content = a
                .content
                .as_deref()
                .ok_or_else(|| format!("{label}: write_file requires 'content'"))?;
            validate_payload(&format!("{label}.content"), content)?;
            reject_present(label, "pattern", &a.pattern)?;
            reject_present(label, "offset", &a.offset)?;
            reject_present(label, "limit", &a.limit)?;
            reject_present(label, "output_mode", &a.output_mode)?;
            reject_present(label, "head_limit", &a.head_limit)?;
            reject_present(label, "old_string", &a.old_string)?;
            reject_present(label, "new_string", &a.new_string)?;
        }
        "edit_file" => {
            let path = a
                .path
                .as_deref()
                .ok_or_else(|| format!("{label}: edit_file requires 'path'"))?;
            validate_relative_path(&format!("{label}.path"), path)?;
            let old_string = a
                .old_string
                .as_deref()
                .ok_or_else(|| format!("{label}: edit_file requires 'old_string'"))?;
            if old_string.is_empty() {
                return Err(format!("{label}: edit_file requires a non-empty 'old_string'"));
            }
            validate_payload(&format!("{label}.old_string"), old_string)?;
            let new_string = a
                .new_string
                .as_deref()
                .ok_or_else(|| format!("{label}: edit_file requires 'new_string'"))?;
            validate_payload(&format!("{label}.new_string"), new_string)?;
            reject_present(label, "pattern", &a.pattern)?;
            reject_present(label, "offset", &a.offset)?;
            reject_present(label, "limit", &a.limit)?;
            reject_present(label, "output_mode", &a.output_mode)?;
            reject_present(label, "head_limit", &a.head_limit)?;
            reject_present(label, "content", &a.content)?;
        }
        _ => unreachable!("tool allowlist checked above"),
    }
    Ok(())
}

fn validate_sha256(label: &str, raw: &str) -> Result<(), String> {
    if raw.len() != 64 || !raw.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(format!("{label}: expected a lowercase 64-character SHA-256 hex string"));
    }
    Ok(())
}

/// Strictly validate and canonicalize v1 manifest content. Unknown keys,
/// unsupported schema versions, shell/script/template fields, non-allowlisted
/// tools, malformed paths/patterns/payloads, and unbounded values are rejected.
/// Execution calls use the bounded writer+reader allowlist; acceptance checks
/// use the read-only allowlist only.
pub fn validate_trusted_manifest_content(
    content_json: &str,
) -> Result<ValidatedTrustedManifest, String> {
    if content_json.trim().is_empty() {
        return Err("manifest content must not be empty".to_string());
    }
    if content_json.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "manifest content exceeds the {MAX_CONTENT_BYTES}-byte limit"
        ));
    }
    let content: TrustedManifestContentV1 = serde_json::from_str(content_json).map_err(|e| {
        format!("manifest content is not a valid v1 trusted manifest (unknown keys, scripts, templates, and unbounded content are rejected): {e}")
    })?;

    if content.schema_version as i64 != TRUSTED_MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "unsupported manifest schema_version {}; expected {}",
            content.schema_version, TRUSTED_MANIFEST_SCHEMA_VERSION
        ));
    }
    if content.execution.is_empty() {
        return Err("manifest must declare at least one execution call".to_string());
    }
    if content.execution.len() > MAX_EXECUTION_CALLS {
        return Err(format!(
            "manifest declares more than {MAX_EXECUTION_CALLS} execution calls"
        ));
    }
    for (index, call) in content.execution.iter().enumerate() {
        validate_call_tool(
            &format!("execution[{index}]"),
            &call.tool,
            call.arguments.as_ref(),
            true,
        )?;
    }

    if content.acceptance.is_empty() {
        return Err("manifest must declare at least one acceptance criterion".to_string());
    }
    if content.acceptance.len() > MAX_ACCEPTANCE_CRITERIA {
        return Err(format!(
            "manifest declares more than {MAX_ACCEPTANCE_CRITERIA} acceptance criteria"
        ));
    }
    let mut total_checks = 0usize;
    for (criterion_id, checks) in &content.acceptance {
        uuid::Uuid::parse_str(criterion_id).map_err(|_| {
            format!(
                "acceptance criterion id '{criterion_id}' is not a stable Goal criterion UUID"
            )
        })?;
        if checks.is_empty() {
            return Err(format!(
                "acceptance criterion '{criterion_id}' has no checks"
            ));
        }
        if checks.len() > MAX_CHECKS_PER_CRITERION {
            return Err(format!(
                "acceptance criterion '{criterion_id}' has more than {MAX_CHECKS_PER_CRITERION} checks"
            ));
        }
        total_checks += checks.len();
        for (index, check) in checks.iter().enumerate() {
            validate_call_tool(
                &format!("acceptance[{criterion_id}][{index}]"),
                &check.tool,
                check.arguments.as_ref(),
                false,
            )?;
            validate_sha256(
                &format!("acceptance[{criterion_id}][{index}].expect_sha256"),
                &check.expect_sha256,
            )?;
        }
    }
    if total_checks > MAX_TOTAL_ACCEPTANCE_CHECKS {
        return Err(format!(
            "manifest declares more than {MAX_TOTAL_ACCEPTANCE_CHECKS} acceptance checks"
        ));
    }

    let canonical_json = serde_json::to_string(&content)
        .map_err(|e| format!("failed to canonicalize manifest content: {e}"))?;
    let content_hash = crate::jarvis::memory::turn::message_sha256(&canonical_json);
    let content_value = serde_json::to_value(&content)
        .map_err(|e| format!("failed to serialize manifest content: {e}"))?;

    Ok(ValidatedTrustedManifest {
        schema_version: TRUSTED_MANIFEST_SCHEMA_VERSION,
        canonical_json,
        content_hash,
        content: content_value,
    })
}

/// Require the manifest's scope Agent to be an exact, existing, enabled native
/// Agent row. A disabled or unknown Agent fails closed: no privileged fallback.
fn require_enabled_agent(conn: &Connection, agent_id: &str) -> Result<(), String> {
    let enabled: Option<i64> = conn
        .query_row("SELECT enabled FROM agents WHERE id = ?1", [agent_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| format!("failed to resolve Agent '{agent_id}': {e}"))?;
    match enabled {
        None => Err(format!("unknown Agent id: {agent_id}")),
        Some(0) => Err(format!(
            "Agent '{agent_id}' is disabled; a trusted manifest requires an enabled Agent"
        )),
        Some(_) => Ok(()),
    }
}

/// Canonicalize and validate an existing workspace root through the trusted
/// memory-scope validator. Registration is attribution only; it grants no
/// filesystem or tool authorization.
fn canonical_project_root(raw: &str) -> Result<String, String> {
    crate::jarvis::memory::scope::normalize_project_root(raw)
        .map_err(|e| format!("invalid project root: {e}"))
}

fn require_expected(
    expected_version: Option<i64>,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    let hash_present = expected_hash.map(|h| !h.trim().is_empty()).unwrap_or(false);
    if expected_version.is_none() && !hash_present {
        return Err(
            "an expected current registry version or content hash is required for this action"
                .to_string(),
        );
    }
    Ok(())
}

/// Reject a second trusted manifest that would bind the same canonical workspace
/// root + Action Registry id. `exclude_manifest_id` is the row being replaced
/// (`None` on create). The unique index is the final guard; this check yields an
/// actionable error instead of a raw constraint failure.
fn reject_conflicting_action_binding(
    conn: &Connection,
    project_root: &str,
    action_id: &str,
    exclude_manifest_id: Option<&str>,
) -> Result<(), String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT manifest_id FROM trusted_acceptance_manifests \
             WHERE project_root = ?1 AND action_id = ?2 AND manifest_id <> COALESCE(?3, '')",
            params![project_root, action_id, exclude_manifest_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(conflict) = existing {
        return Err(format!(
            "an existing trusted manifest ('{conflict}') already binds action '{action_id}' for workspace '{project_root}'; replace that manifest instead"
        ));
    }
    Ok(())
}

fn record_from_row(
    row: (
        String,
        i64,
        i64,
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
    ),
) -> Result<TrustedAcceptanceManifest, String> {
    let (
        manifest_id,
        registry_version,
        schema_version,
        content_hash,
        content_json,
        agent_id,
        project_root,
        action_id,
        created_at,
        updated_at,
    ) = row;
    let content: serde_json::Value = serde_json::from_str(&content_json).map_err(|e| {
        format!("stored trusted manifest '{manifest_id}' content is not valid JSON: {e}")
    })?;
    Ok(TrustedAcceptanceManifest {
        manifest_id,
        registry_version,
        schema_version,
        content_hash,
        content,
        agent_id,
        project_root,
        action_id,
        created_at,
        updated_at,
    })
}

fn map_manifest_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(
    String,
    i64,
    i64,
    String,
    String,
    String,
    String,
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
    ))
}

fn load_manifest(conn: &Connection, manifest_id: &str) -> Result<TrustedAcceptanceManifest, String> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {TRUSTED_MANIFEST_COLS} FROM trusted_acceptance_manifests WHERE manifest_id = ?1"
            ),
            [manifest_id],
            map_manifest_row,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("trusted manifest not found: {manifest_id}"))?;
    record_from_row(row)
}

// ── Commands ─────────────────────────────────────────────────

/// List every registered trusted acceptance manifest (newest first). Read-only;
/// an empty list is authoritative that no manifest is registered.
#[tauri::command]
pub fn list_trusted_acceptance_manifests(
    db: State<AppDb>,
) -> Result<Vec<TrustedAcceptanceManifest>, String> {
    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TRUSTED_MANIFEST_COLS} FROM trusted_acceptance_manifests ORDER BY created_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], map_manifest_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.into_iter().map(record_from_row).collect()
}

/// Register a new trusted manifest. Native mints the stable UUID plus registry
/// version 1, requires an explicit Action Registry action id that resolves to
/// exactly one active open/in_progress item whose existing approval condition is
/// satisfied, revalidates the enabled Agent and canonical workspace, and stores
/// strictly validated canonical content with its SHA-256. The action id is
/// opaque identity only; action title/description text is never consumed.
#[tauri::command]
pub fn create_trusted_acceptance_manifest(
    db: State<AppDb>,
    content_json: String,
    agent_id: String,
    project_root: String,
    action_id: String,
) -> Result<TrustedAcceptanceManifest, String> {
    let agent_id = agent_id.trim().to_string();
    if agent_id.is_empty() {
        return Err("an exact Agent id is required".to_string());
    }
    let validated = validate_trusted_manifest_content(&content_json)?;
    let project_root = canonical_project_root(&project_root)?;

    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    require_enabled_agent(&conn, &agent_id)?;
    let action_id =
        crate::commands::action_registry::resolve_bindable_action_conn(&conn, &action_id)?;
    reject_conflicting_action_binding(&conn, &project_root, &action_id, None)?;

    let manifest_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO trusted_acceptance_manifests
             (manifest_id, registry_version, schema_version, content_hash, content_json,
              agent_id, project_root, action_id, created_at, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            &manifest_id,
            validated.schema_version,
            &validated.content_hash,
            &validated.canonical_json,
            &agent_id,
            &project_root,
            &action_id,
        ],
    )
    .map_err(|e| format!("failed to register trusted manifest: {e}"))?;

    load_manifest(&conn, &manifest_id)
}

/// Replace a trusted manifest's content, Action binding, and scope binding. The
/// caller must supply the expected current registry version and/or content hash
/// plus an explicit Action Registry action id; the version/hash CAS and the
/// workspace+action uniqueness are both enforced, and the registry version
/// increments by one. A legacy row with no action binding is (re)bound here.
#[tauri::command]
pub fn replace_trusted_acceptance_manifest(
    db: State<AppDb>,
    manifest_id: String,
    expected_version: Option<i64>,
    expected_hash: Option<String>,
    content_json: String,
    agent_id: String,
    project_root: String,
    action_id: String,
) -> Result<TrustedAcceptanceManifest, String> {
    require_expected(expected_version, expected_hash.as_deref())?;
    let agent_id = agent_id.trim().to_string();
    if agent_id.is_empty() {
        return Err("an exact Agent id is required".to_string());
    }
    let validated = validate_trusted_manifest_content(&content_json)?;
    let project_root = canonical_project_root(&project_root)?;

    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    require_enabled_agent(&conn, &agent_id)?;
    let action_id =
        crate::commands::action_registry::resolve_bindable_action_conn(&conn, &action_id)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let current = tx
        .query_row(
            &format!(
                "SELECT {TRUSTED_MANIFEST_COLS} FROM trusted_acceptance_manifests WHERE manifest_id = ?1"
            ),
            [&manifest_id],
            map_manifest_row,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("trusted manifest not found: {manifest_id}"))?;
    let current = record_from_row(current)?;

    if let Some(version) = expected_version {
        if version != current.registry_version {
            return Err(format!(
                "trusted manifest changed: expected registry version {version}, current is {}",
                current.registry_version
            ));
        }
    }
    if let Some(hash) = expected_hash.as_deref() {
        if !hash.trim().is_empty() && hash != current.content_hash {
            return Err(
                "trusted manifest changed: expected content hash does not match the current record"
                    .to_string(),
            );
        }
    }
    reject_conflicting_action_binding(&tx, &project_root, &action_id, Some(&manifest_id))?;

    let affected = tx
        .execute(
            "UPDATE trusted_acceptance_manifests
             SET registry_version = registry_version + 1,
                 schema_version = ?4,
                 content_hash = ?5,
                 content_json = ?6,
                 agent_id = ?7,
                 project_root = ?8,
                 action_id = ?9,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE manifest_id = ?1 AND registry_version = ?2 AND content_hash = ?3",
            params![
                &manifest_id,
                current.registry_version,
                &current.content_hash,
                validated.schema_version,
                &validated.content_hash,
                &validated.canonical_json,
                &agent_id,
                &project_root,
                &action_id,
            ],
        )
        .map_err(|e| format!("failed to replace trusted manifest: {e}"))?;
    if affected != 1 {
        return Err(
            "trusted manifest changed while replacing; no update was applied".to_string(),
        );
    }
    tx.commit().map_err(|e| e.to_string())?;

    load_manifest(&conn, &manifest_id)
}

/// Remove a trusted manifest. The caller must supply the expected current
/// registry version and/or content hash, which are checked and guarded in the
/// delete so a concurrent change cannot be silently removed.
#[tauri::command]
pub fn remove_trusted_acceptance_manifest(
    db: State<AppDb>,
    manifest_id: String,
    expected_version: Option<i64>,
    expected_hash: Option<String>,
) -> Result<bool, String> {
    require_expected(expected_version, expected_hash.as_deref())?;

    let mut conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let current = tx
        .query_row(
            &format!(
                "SELECT {TRUSTED_MANIFEST_COLS} FROM trusted_acceptance_manifests WHERE manifest_id = ?1"
            ),
            [&manifest_id],
            map_manifest_row,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("trusted manifest not found: {manifest_id}"))?;
    let current = record_from_row(current)?;

    if let Some(version) = expected_version {
        if version != current.registry_version {
            return Err(format!(
                "trusted manifest changed: expected registry version {version}, current is {}",
                current.registry_version
            ));
        }
    }
    if let Some(hash) = expected_hash.as_deref() {
        if !hash.trim().is_empty() && hash != current.content_hash {
            return Err(
                "trusted manifest changed: expected content hash does not match the current record"
                    .to_string(),
            );
        }
    }

    let affected = tx
        .execute(
            "DELETE FROM trusted_acceptance_manifests
             WHERE manifest_id = ?1 AND registry_version = ?2 AND content_hash = ?3",
            params![&manifest_id, current.registry_version, &current.content_hash],
        )
        .map_err(|e| format!("failed to remove trusted manifest: {e}"))?;
    if affected != 1 {
        return Err(
            "trusted manifest changed while removing; nothing was deleted".to_string(),
        );
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}
