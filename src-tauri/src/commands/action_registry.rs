// Action Registry — file-backed cross-project action summary for Jarvis UI

use crate::commands::load_jarvis_config;
use crate::db::AppDb;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRegistrySummary {
    pub active: usize,
    pub blocked: usize,
    pub done: usize,
    pub pending_approvals: usize,
    pub escalated: usize,
    pub alerts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionEvidence {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryAction {
    pub id: String,
    pub project: String,
    pub source_system: String,
    pub source_area: String,
    pub priority: String,
    pub risk_level: String,
    pub category: String,
    pub action_type: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub owner: String,
    pub approval_required: bool,
    #[serde(default)]
    pub approval_status: Option<String>,
    #[serde(default)]
    pub next_due: Option<String>,
    #[serde(default)]
    pub escalated: Option<bool>,
    #[serde(default)]
    pub escalation_note: Option<String>,
    #[serde(default)]
    pub execution_evidence: Option<ExecutionEvidence>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionDispatchOutcome {
    pub status: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRegistryBucket {
    pub bucket: String,
    pub actions: Vec<RegistryAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRegistryAlert {
    pub id: String,
    pub kind: String,
    pub severity: String,
    pub title: String,
    pub message: String,
    #[serde(default)]
    pub action_id: Option<String>,
    #[serde(default)]
    pub count: Option<usize>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotificationsFile {
    alerts: Vec<ActionRegistryAlert>,
}

fn registry_root(db: &AppDb) -> Result<PathBuf, String> {
    let config = load_jarvis_config(db)?;
    Ok(resolve_repo_root(&config.jarvis_path)
        .join("workspace")
        .join("action-registry"))
}

/// Resolve the home-base repo root (the dir that contains `workspace/action-registry`).
///
/// The action-registry data lives in the dev tree, but the app may be launched from
/// anywhere (e.g. a copy of the exe on the Desktop), so we must not rely on the process
/// CWD. Resolution order, first hit wins:
///   1. an explicit configured `jarvis_path` (if it exists on disk),
///   2. the `JARVIS_HOME` environment variable,
///   3. an upward walk from the current directory looking for `workspace/action-registry`,
///   4. the compile-time repo root (`<crate>/..`), which is correct for this build,
///   5. the current directory as a last resort.
fn resolve_repo_root(configured: &str) -> PathBuf {
    let has_registry = |p: &Path| p.join("workspace").join("action-registry").is_dir();

    let configured = configured.trim();
    if !configured.is_empty() {
        let p = PathBuf::from(configured);
        if p.is_dir() {
            return p;
        }
    }

    if let Ok(env_home) = std::env::var("JARVIS_HOME") {
        let p = PathBuf::from(env_home);
        if p.is_dir() {
            return p;
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut cur: Option<&Path> = Some(cwd.as_path());
        while let Some(dir) = cur {
            if has_registry(dir) {
                return dir.to_path_buf();
            }
            cur = dir.parent();
        }
    }

    // `CARGO_MANIFEST_DIR` is `<repo>/src-tauri`; its parent is the repo root.
    if let Some(repo) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        if has_registry(repo) {
            return repo.to_path_buf();
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Read an action bucket file. Tolerant of both the `{ "actions": [...] }` object
/// shape written by the Python adapter and a bare `[...]` array; a missing file is
/// an empty bucket, not an error. Individual rows that fail to match `RegistryAction`
/// are skipped rather than failing the whole read.
fn read_bucket(path: &Path) -> Result<Vec<RegistryAction>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))?;

    let rows = match parsed {
        serde_json::Value::Array(rows) => rows,
        serde_json::Value::Object(mut map) => match map.remove("actions") {
            Some(serde_json::Value::Array(rows)) => rows,
            _ => vec![],
        },
        _ => vec![],
    };

    Ok(rows
        .into_iter()
        .filter_map(|value| serde_json::from_value::<RegistryAction>(value).ok())
        .collect())
}

fn read_alerts(path: &Path) -> Vec<ActionRegistryAlert> {
    if !path.exists() {
        return vec![];
    }
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    serde_json::from_str::<NotificationsFile>(&raw)
        .map(|f| f.alerts)
        .unwrap_or_default()
}

pub fn dispatch_approved_action(
    db: &AppDb,
    action_id: String,
) -> Result<ActionDispatchOutcome, String> {
    let root = registry_root(db)?;
    let data_dir = root.join("data");
    let active_path = data_dir.join("active.json");
    let done_path = data_dir.join("done.json");

    let active = read_bucket(&active_path)?;
    if let Some(action) = active.iter().find(|action| action.id == action_id) {
        if !matches!(action.status.as_str(), "open" | "in_progress") {
            return Err(format!("Action '{}' is not executable", action_id));
        }

        if action.approval_required {
            match action.approval_status.as_deref() {
                Some("approved") | Some("waived") => {}
                _ => {
                    return Err(format!(
                        "Action '{}' requires approval before dispatch",
                        action_id
                    ))
                }
            }
        }

        return Ok(ActionDispatchOutcome {
            status: "unavailable".to_string(),
            code: "verification_manifest_missing".to_string(),
        });
    }

    let done = read_bucket(&done_path)?;
    if done.iter().any(|action| action.id == action_id) {
        return Err(format!("Action '{}' is already completed", action_id));
    }

    Err(format!("Action '{}' not found in active bucket", action_id))
}

#[tauri::command]
pub fn dispatch_action(db: State<AppDb>, action_id: String) -> Result<ActionDispatchOutcome, String> {
    dispatch_approved_action(db.inner(), action_id)
}

/// Resolve exactly one active `open`/`in_progress` Action Registry item that
/// already satisfies the same approval condition `dispatch_approved_action`
/// enforces, for trusted-manifest binding, and return its exact id as opaque
/// identity. Only identity, status, and existing approval metadata are read;
/// the action title, description, and any other text are never consumed or
/// trusted. This writes nothing.
///
/// Callers that already hold the SQLite lock pass the connection so this never
/// re-enters the mutex. Fail-closed: a missing, duplicated, non-active, or
/// approval-ambiguous/unavailable action is rejected with an actionable error
/// rather than inferring approval.
pub fn resolve_bindable_action_conn(
    conn: &rusqlite::Connection,
    action_id: &str,
) -> Result<String, String> {
    let action_id = action_id.trim();
    if action_id.is_empty() {
        return Err("an exact Action Registry action id is required".to_string());
    }
    let config = crate::commands::settings::load_jarvis_config_conn(conn)?;
    let root = resolve_repo_root(&config.jarvis_path)
        .join("workspace")
        .join("action-registry");
    let active = read_bucket(&root.join("data").join("active.json"))
        .map_err(|e| format!("could not read the active Action Registry bucket: {e}"))?;

    let matches: Vec<&RegistryAction> = active.iter().filter(|action| action.id == action_id).collect();
    if matches.is_empty() {
        return Err(format!(
            "action '{action_id}' is not present in the active Action Registry bucket; binding requires exactly one active open/in_progress action"
        ));
    }
    if matches.len() > 1 {
        return Err(format!(
            "action '{action_id}' is ambiguous: {} active entries share that id",
            matches.len()
        ));
    }
    let action = matches[0];
    if !matches!(action.status.as_str(), "open" | "in_progress") {
        return Err(format!(
            "action '{action_id}' is not bindable: status is '{}' (only open/in_progress are allowed)",
            action.status
        ));
    }
    if action.approval_required {
        match action.approval_status.as_deref() {
            Some("approved") | Some("waived") => {}
            Some(other) => {
                return Err(format!(
                    "action '{action_id}' is not approved: approval status is '{other}'"
                ));
            }
            None => {
                return Err(format!(
                    "action '{action_id}' requires approval but its approval metadata is unavailable; binding is refused rather than inferring approval"
                ));
            }
        }
    }

    Ok(action.id.clone())
}

/// Return bucket counts and alert totals for the action registry dashboard.
#[tauri::command]
pub fn get_action_registry_summary(db: State<AppDb>) -> Result<ActionRegistrySummary, String> {
    let root = registry_root(db.inner())?;
    let data = root.join("data");
    let active = read_bucket(&data.join("active.json"))?;
    let blocked = read_bucket(&data.join("blocked.json"))?;
    let done = read_bucket(&data.join("done.json"))?;
    let alerts = read_alerts(&data.join("notifications.json"));

    let pending_approvals = active
        .iter()
        .chain(blocked.iter())
        .filter(|a| {
            a.approval_required
                && a.approval_status
                    .as_deref()
                    .map(|s| s != "approved" && s != "waived")
                    .unwrap_or(true)
        })
        .count();
    let escalated = active
        .iter()
        .filter(|a| a.escalated.unwrap_or(false))
        .count();

    Ok(ActionRegistrySummary {
        active: active.len(),
        blocked: blocked.len(),
        done: done.len(),
        pending_approvals,
        escalated,
        alerts: alerts.len(),
    })
}

/// Return all actions for a bucket (`active`, `blocked`, or `done`).
#[tauri::command]
pub fn get_action_registry_bucket(
    db: State<AppDb>,
    bucket: String,
) -> Result<ActionRegistryBucket, String> {
    let allowed = ["active", "blocked", "done"];
    if !allowed.contains(&bucket.as_str()) {
        return Err(format!("unknown bucket: {bucket}"));
    }
    let root = registry_root(db.inner())?;
    let actions = read_bucket(&root.join("data").join(format!("{bucket}.json")))?;
    Ok(ActionRegistryBucket { bucket, actions })
}

/// Return current notification alerts generated by the registry sync loop.
#[tauri::command]
pub fn get_action_registry_alerts(db: State<AppDb>) -> Result<Vec<ActionRegistryAlert>, String> {
    let root = registry_root(db.inner())?;
    Ok(read_alerts(&root.join("data").join("notifications.json")))
}

/// Run adapter sync via Python CLI and emit UI alerts when new notifications appear.
#[tauri::command]
pub fn sync_action_registry(app: AppHandle, db: State<AppDb>) -> Result<serde_json::Value, String> {
    let root = registry_root(db.inner())?;
    let output = std::process::Command::new("python3")
        .current_dir(&root)
        .env("PYTHONPATH", "src")
        .args(["-m", "action_registry", "sync", "--root"])
        .arg(root.to_string_lossy().to_string())
        .output()
        .map_err(|e| format!("failed to spawn sync: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("sync failed: {stderr}{stdout}"));
    }

    let payload: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("invalid sync output: {e}"))?;

    let alerts = read_alerts(&root.join("data").join("notifications.json"));
    if !alerts.is_empty() {
        let _ = app.emit("action-registry://alerts", &alerts);
    }

    Ok(payload)
}

/// Update the approval status of an action in the registry.
#[tauri::command]
pub fn update_action_approval(
    app: AppHandle,
    db: State<AppDb>,
    action_id: String,
    status: String,
) -> Result<bool, String> {
    let root = registry_root(db.inner())?;
    let data_dir = root.join("data");

    let mut found = false;
    let buckets = ["active", "blocked", "done"];

    for bucket in &buckets {
        let path = data_dir.join(format!("{bucket}.json"));
        if !path.exists() {
            continue;
        }

        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("failed to read bucket {bucket}: {e}"))?;

        let mut payload: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("failed to parse bucket {bucket}: {e}"))?;

        if let Some(actions) = payload.get_mut("actions").and_then(|a| a.as_array_mut()) {
            for action in actions {
                if action.get("id").and_then(|id| id.as_str()) == Some(&action_id) {
                    action["approval_status"] = serde_json::Value::String(status.clone());
                    action["updated_at"] = serde_json::Value::String(
                        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                    );
                    found = true;
                    break;
                }
            }
        }

        if found {
            let updated_raw = serde_json::to_string_pretty(&payload)
                .map_err(|e| format!("failed to serialize updated bucket {bucket}: {e}"))?;
            fs::write(&path, updated_raw)
                .map_err(|e| format!("failed to write updated bucket {bucket}: {e}"))?;
            break;
        }
    }

    if !found {
        return Err(format!(
            "Action with ID '{}' not found in any bucket.",
            action_id
        ));
    }

    // Run a sync to regenerate notifications/alerts automatically and emit the new alerts
    let _ = sync_action_registry(app, db);

    Ok(true)
}

// ── Trusted terminal delivery (Roadmap Priority #2, Part 4) ──

/// Bounded proof that one Action Registry action is terminally done. Only
/// identity/status/evidence fields are read; the action's other JSON fields are
/// preserved untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRegistryTerminalProof {
    pub action_id: String,
    pub done_present: bool,
    pub active_absent: bool,
    pub run_id: String,
    pub acceptance_result: String,
}

fn data_dir(db: &AppDb) -> Result<PathBuf, String> {
    Ok(registry_root(db)?.join("data"))
}

/// Parse a bucket file into `{ "actions": [...] }`, tolerating a bare array.
/// A missing file is an authoritative empty bucket.
fn read_bucket_value(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::json!({ "actions": [] }));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {}", path.display(), e))?;
    match parsed {
        serde_json::Value::Array(actions) => Ok(serde_json::json!({ "actions": actions })),
        serde_json::Value::Object(mut map) => {
            if !map.contains_key("actions") {
                map.insert("actions".to_string(), serde_json::Value::Array(vec![]));
            }
            Ok(serde_json::Value::Object(map))
        }
        _ => Err(format!("bucket {} has an unsupported shape", path.display())),
    }
}

/// Write a bucket via a temp file + rename so a partial write cannot corrupt it.
fn write_bucket_value(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value)
        .map_err(|e| format!("serialize {}: {}", path.display(), e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename {}: {}", tmp.display(), e))?;
    Ok(())
}

fn find_action<'a>(value: &'a serde_json::Value, action_id: &str) -> Option<&'a serde_json::Value> {
    value
        .get("actions")
        .and_then(|a| a.as_array())
        .and_then(|actions| {
            actions
                .iter()
                .find(|a| a.get("id").and_then(|id| id.as_str()) == Some(action_id))
        })
}

fn proof_for(value: &serde_json::Value, action_id: &str) -> Option<ActionRegistryTerminalProof> {
    let action = find_action(value, action_id)?;
    let run_id = action
        .get("execution_evidence")
        .and_then(|e| e.get("run_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let acceptance_result = action
        .get("execution_evidence")
        .and_then(|e| e.get("acceptance_result"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(ActionRegistryTerminalProof {
        action_id: action_id.to_string(),
        done_present: true,
        active_absent: false,
        run_id,
        acceptance_result,
    })
}

/// After all trusted acceptance checks pass, mark exactly one Action Registry
/// action terminally done. The exact existing action object is moved to the
/// `done` bucket with its unknown JSON fields preserved; `status` and the
/// runtime execution/acceptance evidence are updated. Both files are then
/// re-read: the done row must be present exactly once with the expected
/// evidence, and the action must be absent from `active`. Any mismatch returns
/// an error (the caller persists an ambiguous/pending state and never claims
/// terminal).
pub fn finalize_action_registry_done(
    db: &AppDb,
    action_id: &str,
    evidence: &serde_json::Value,
) -> Result<ActionRegistryTerminalProof, String> {
    let dir = data_dir(db)?;
    let active_path = dir.join("active.json");
    let done_path = dir.join("done.json");

    let mut active = read_bucket_value(&active_path)?;
    let mut done = read_bucket_value(&done_path)?;

    if find_action(&done, action_id).is_some() {
        // Idempotent: already terminal. Confirm active is clear.
        let active_absent = find_action(&active, action_id).is_none();
        if !active_absent {
            return Err(format!(
                "action '{action_id}' is present in both done and active; reconciliation required"
            ));
        }
        let mut proof = proof_for(&done, action_id)
            .ok_or_else(|| format!("done row for '{action_id}' is malformed"))?;
        proof.active_absent = true;
        return Ok(proof);
    }

    let action = find_action(&active, action_id)
        .ok_or_else(|| format!("action '{action_id}' is not present in the active bucket"))?
        .clone();
    let status = action
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if !matches!(status, "open" | "in_progress") {
        return Err(format!(
            "action '{action_id}' is not terminally deliverable: status is '{status}'"
        ));
    }

    // Build the terminal object from the exact existing action so unknown fields
    // are preserved; only status/evidence/timestamp are overwritten.
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut terminal = action;
    terminal["status"] = serde_json::Value::String("done".to_string());
    terminal["updated_at"] = serde_json::Value::String(now);
    terminal["execution_evidence"] = evidence.clone();
    terminal["acceptance_evidence"] = evidence.clone();

    // Move: append/replace in done, remove from active.
    {
        let arr = done
            .get_mut("actions")
            .and_then(|a| a.as_array_mut())
            .ok_or_else(|| "done bucket is malformed".to_string())?;
        arr.retain(|a| a.get("id").and_then(|id| id.as_str()) != Some(action_id));
        arr.push(terminal);
    }
    {
        let arr = active
            .get_mut("actions")
            .and_then(|a| a.as_array_mut())
            .ok_or_else(|| "active bucket is malformed".to_string())?;
        arr.retain(|a| a.get("id").and_then(|id| id.as_str()) != Some(action_id));
    }

    // Write done before active so an interruption cannot leave a done action
    // still active.
    write_bucket_value(&done_path, &done)?;
    write_bucket_value(&active_path, &active)?;

    // Exact readback.
    let done_after = read_bucket_value(&done_path)?;
    let active_after = read_bucket_value(&active_path)?;
    let done_matches = done_after
        .get("actions")
        .and_then(|a| a.as_array())
        .map(|actions| {
            actions
                .iter()
                .filter(|a| a.get("id").and_then(|id| id.as_str()) == Some(action_id))
                .count()
        })
        == Some(1);
    let active_absent = find_action(&active_after, action_id).is_none();
    if !done_matches || !active_absent {
        return Err(format!(
            "action '{action_id}' terminal write could not be confirmed; reconciliation required"
        ));
    }
    let mut proof = proof_for(&done_after, action_id)
        .ok_or_else(|| format!("done row for '{action_id}' is missing after write"))?;
    proof.active_absent = true;
    Ok(proof)
}

/// Read back an already-terminal action row exactly (idempotent reconciliation).
pub fn verify_action_registry_done(
    db: &AppDb,
    action_id: &str,
) -> Result<ActionRegistryTerminalProof, String> {
    let dir = data_dir(db)?;
    let done = read_bucket_value(&dir.join("done.json"))?;
    let active = read_bucket_value(&dir.join("active.json"))?;
    let mut proof = proof_for(&done, action_id)
        .ok_or_else(|| format!("action '{action_id}' is not in the done bucket"))?;
    proof.active_absent = find_action(&active, action_id).is_none();
    if !proof.active_absent {
        return Err(format!(
            "action '{action_id}' is still present in the active bucket"
        ));
    }
    Ok(proof)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tmp(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ar_test_{}_{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("active.json");
        std::fs::write(&f, body).unwrap();
        f
    }

    fn tmp_db_with_jarvis_path(jarvis_path: &Path) -> AppDb {
        let dir = std::env::temp_dir().join(format!(
            "ar_db_test_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AppDb::new(&dir).unwrap();
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('jarvis_path', ?)",
            [jarvis_path.to_string_lossy().to_string()],
        )
        .unwrap();
        drop(conn);
        db
    }

    const ROW: &str = r#"{"id":"a1","project":"p","source_system":"s","source_area":"a",
        "priority":"P1","risk_level":"low","category":"c","action_type":"t","title":"T",
        "description":"D","status":"open","owner":"o","approval_required":false,
        "updated_at":"2026-06-22"}"#;

    #[test]
    fn read_bucket_parses_object_without_bucket_field() {
        // Regression: the Python adapter writes `{ "actions": [...] }` with no top-level
        // `bucket` key. The old struct-typed parse required `bucket` and errored, leaving
        // the Actions view empty/broken.
        let f = write_tmp("obj", &format!(r#"{{"actions":[{ROW}]}}"#));
        let actions = read_bucket(&f).expect("object with actions[] must parse");
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "a1");
        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    #[test]
    fn read_bucket_parses_bare_array() {
        let f = write_tmp("arr", &format!(r#"[{ROW}]"#));
        let actions = read_bucket(&f).expect("bare array must parse");
        assert_eq!(actions.len(), 1);
        let _ = std::fs::remove_dir_all(f.parent().unwrap());
    }

    #[test]
    fn read_bucket_missing_file_is_empty() {
        let actions = read_bucket(Path::new("does-not-exist-xyz.json")).unwrap();
        assert!(actions.is_empty());
    }

    #[test]
    fn approved_action_without_verification_manifest_is_unavailable_without_mutation() {
        let root = std::env::temp_dir().join(format!(
            "ar_dispatch_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let data = root.join("workspace").join("action-registry").join("data");
        std::fs::create_dir_all(&data).unwrap();
        let active_path = data.join("active.json");
        std::fs::write(&active_path, format!(r#"{{"actions":[{ROW}]}}"#)).unwrap();
        let before = std::fs::read(&active_path).unwrap();

        let db = tmp_db_with_jarvis_path(&root);
        let outcome = dispatch_approved_action(&db, "a1".to_string()).unwrap();
        let payload = serde_json::to_value(&outcome).unwrap();
        assert_eq!(payload.get("status").and_then(|v| v.as_str()), Some("unavailable"));
        assert_eq!(payload.get("code").and_then(|v| v.as_str()), Some("verification_manifest_missing"));
        assert_eq!(std::fs::read(&active_path).unwrap(), before);
        assert!(!data.join("done.json").exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(db.db_path.parent().unwrap());
    }

    #[test]
    fn dispatch_rejects_non_executable_action_without_mutation() {
        let root = std::env::temp_dir().join(format!(
            "ar_dispatch_non_executable_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let data = root.join("workspace").join("action-registry").join("data");
        std::fs::create_dir_all(&data).unwrap();
        let active_path = data.join("active.json");
        let row = ROW.replace("\"status\":\"open\"", "\"status\":\"cancelled\"");
        std::fs::write(&active_path, format!(r#"{{"actions":[{row}]}}"#)).unwrap();
        let before = std::fs::read(&active_path).unwrap();

        let db = tmp_db_with_jarvis_path(&root);
        let err = dispatch_approved_action(&db, "a1".to_string()).unwrap_err();
        assert!(err.contains("not executable"));
        assert_eq!(std::fs::read(&active_path).unwrap(), before);
        assert!(!data.join("done.json").exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(db.db_path.parent().unwrap());
    }

    #[test]
    fn dispatch_does_not_return_forged_evidence_as_confirmation() {
        let root = std::env::temp_dir().join(format!(
            "ar_dispatch_forged_evidence_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let data = root.join("workspace").join("action-registry").join("data");
        std::fs::create_dir_all(&data).unwrap();
        let active_path = data.join("active.json");
        let row = ROW.replace(
            "\"approval_required\":false",
            "\"approval_required\":false,\"execution_evidence\":{\"run_id\":\"forged\",\"status\":\"verified\"}",
        );
        std::fs::write(&active_path, format!(r#"{{"actions":[{row}]}}"#)).unwrap();
        let before = std::fs::read(&active_path).unwrap();

        let db = tmp_db_with_jarvis_path(&root);
        let outcome = dispatch_approved_action(&db, "a1".to_string()).unwrap();
        let payload = serde_json::to_value(&outcome).unwrap();
        assert_eq!(payload.get("status").and_then(|v| v.as_str()), Some("unavailable"));
        assert_eq!(std::fs::read(&active_path).unwrap(), before);
        assert!(!data.join("done.json").exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(db.db_path.parent().unwrap());
    }

    #[test]
    fn dispatch_rejects_unapproved_required_action() {
        let root = std::env::temp_dir().join(format!(
            "ar_dispatch_unapproved_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let data = root.join("workspace").join("action-registry").join("data");
        std::fs::create_dir_all(&data).unwrap();
        let row = r#"{"id":"a2","project":"p","source_system":"s","source_area":"a",
            "priority":"P1","risk_level":"low","category":"c","action_type":"t","title":"T",
            "description":"D","status":"open","owner":"o","approval_required":true,
            "approval_status":"pending","updated_at":"2026-06-22"}"#;
        let active_path = data.join("active.json");
        std::fs::write(
            &active_path,
            format!(r#"{{"actions":[{row}]}}"#),
        )
        .unwrap();
        let before = std::fs::read(&active_path).unwrap();

        let db = tmp_db_with_jarvis_path(&root);
        let err = dispatch_approved_action(&db, "a2".to_string()).unwrap_err();
        assert!(err.contains("requires approval"));
        assert_eq!(std::fs::read(&active_path).unwrap(), before);
        assert!(!data.join("done.json").exists());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(db.db_path.parent().unwrap());
    }
}
