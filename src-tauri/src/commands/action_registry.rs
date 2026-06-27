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
    pub updated_at: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tmp(name: &str, body: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ar_test_{}_{}", std::process::id(), name));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("active.json");
        std::fs::write(&f, body).unwrap();
        f
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
}
