// ═══════════════════════════════════════════════════════════════
// Project Steward — exact, read-only workspace review snapshot
// (Roadmap Priority #4, Phase 4.1, Task 1)
//
// This command turns a Session/Goal/run selector tuple into a read-only
// workspace snapshot. Identities are selectors only: every scope value is
// re-derived from the native SQLite authorities and revalidated immediately
// before success. Git is invoked directly with fixed argument arrays and no
// shell, no external diff driver, and no write flags, so the snapshot never
// mutates the workspace or the repository index. The snapshot is labelled as
// the workspace state at capture time; it is not causal proof that the
// selected run produced every change and it never marks a Goal accepted.
// ═══════════════════════════════════════════════════════════════

use crate::db::AppDb;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Bound on the whole snapshot: every Git invocation shares this deadline and
/// is polled then killed, so a hung or oversized repository cannot stall the
/// command.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Total budget for user-visible diff output (staged + unstaged + untracked).
const DIFF_MAX_BYTES: usize = 512 * 1024;
/// Bound for metadata commands (status / untracked listing / revisions).
const METADATA_MAX_BYTES: usize = 512 * 1024;
/// Bound on the number of changed paths reported, so a path-dense workspace
/// cannot grow the DTO without limit.
const MAX_CHANGED_PATHS: usize = 10_000;

// ── DTOs ─────────────────────────────────────────────────────

/// Typed snapshot state. `complete` and `partial` carry a diff; `stale` and
/// `unavailable` carry no diff so a rejected capture can never be mistaken for
/// a reviewed workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectStewardSnapshotState {
    Complete,
    Partial,
    Stale,
    Unavailable,
}

/// Read-only review snapshot for one exact Session/Goal/run tuple. `diff_sha256`
/// is the canonical lowercase SHA-256 of the exact returned `diff` bytes and is
/// present only when the state carries a diff.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectStewardWorkspaceSnapshot {
    pub session_id: String,
    pub goal_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub project_root: String,
    pub run_outcome: String,
    pub run_finished_at: Option<String>,
    pub git_head: Option<String>,
    pub git_branch: Option<String>,
    pub changed_paths: Vec<String>,
    /// True only when `changed_paths` is proven exhaustive for this capture.
    /// False whenever Git status/untracked metadata was truncated or the path
    /// cap was reached, so consumers must never treat the list as complete.
    pub changed_paths_exhaustive: bool,
    pub diff: String,
    pub diff_sha256: Option<String>,
    pub captured_at: String,
    pub state: ProjectStewardSnapshotState,
    pub reason: Option<String>,
    pub details: Vec<String>,
}

/// The revalidated native scope an exact selector tuple resolves to. It is
/// compared before and after capture so a mid-flight change is surfaced as
/// `stale` rather than attributed to the old binding.
#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedScope {
    session_id: String,
    goal_id: String,
    run_id: String,
    agent_id: String,
    project_root: String,
    binding_id: String,
    /// Persisted binding identity is part of the compared scope so any change
    /// between capture and the final reread is detected as `stale`.
    binding_agent_id: String,
    binding_project_root: String,
    binding_task_run_id: String,
    binding_bun_instance_id: String,
    run_outcome: String,
    run_finished_at: Option<String>,
}

/// Raw bounded output of one Git invocation.
struct GitCapture {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
    truncated: bool,
}

// ── Scope validation ─────────────────────────────────────────

/// Load and cross-check the exact Session, Goal, terminal run, and consumed
/// native Goal-run binding. Every missing, duplicate, unreadable, archived, or
/// conflicting row fails closed; no caller-supplied path or Agent is trusted.
fn load_verified_scope(
    conn: &rusqlite::Connection,
    session_id: &str,
    goal_id: &str,
    run_id: &str,
) -> Result<VerifiedScope, String> {
    let session: Option<(String, Option<String>, i64)> = conn
        .query_row(
            "SELECT agent_id, project_root, COALESCE(archived, 0) FROM sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("session readback unavailable: {e}"))?;
    let (session_agent, session_root, archived) =
        session.ok_or_else(|| format!("session not found: {session_id}"))?;
    if archived != 0 {
        return Err(format!("session is archived: {session_id}"));
    }

    // The native Goal authority validates the id format and fails closed on a
    // missing Goal; a terminal Goal is permitted for review.
    let goal = crate::commands::goals::load_goal_for_run_validation(conn, goal_id)?;

    if session_agent != goal.agent_id {
        return Err(format!(
            "session Agent '{}' does not match Goal Agent '{}'",
            session_agent, goal.agent_id
        ));
    }

    let session_root = match session_root {
        Some(root) if !root.trim().is_empty() => root,
        _ => return Err("session has no project workspace binding".to_string()),
    };
    let goal_root = match goal.project_root {
        Some(root) if !root.trim().is_empty() => root,
        _ => return Err("goal has no project workspace binding".to_string()),
    };

    // Re-canonicalize the persisted root and require it to still equal both
    // persisted rows. A moved/unavailable workspace fails closed rather than
    // snapshotting a path that no longer resolves.
    let canonical = crate::jarvis::memory::scope::normalize_project_root(&session_root)
        .map_err(|e| format!("session workspace is unavailable: {e}"))?;
    if canonical != session_root || canonical != goal_root {
        return Err("session and goal workspace bindings do not agree".to_string());
    }

    let run: Option<(String, Option<String>, String, Option<String>)> = conn
        .query_row(
            "SELECT session_id, goal_id, outcome, finished_at FROM session_runs WHERE run_id = ?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("session run readback unavailable: {e}"))?;
    let (run_session, run_goal, run_outcome, run_finished_at) =
        run.ok_or_else(|| format!("session run not found: {run_id}"))?;
    if run_session != session_id {
        return Err("session run belongs to a different session".to_string());
    }
    if run_goal.as_deref() != Some(goal_id) {
        return Err("session run is not associated with the requested goal".to_string());
    }
    if !matches!(
        run_outcome.as_str(),
        "success" | "partial" | "failed" | "timed_out" | "cancelled"
    ) {
        return Err(format!("session run has a non-terminal outcome: {run_outcome}"));
    }
    // A terminal run must carry a concrete, parseable finish time. A missing,
    // empty, or malformed timestamp fails closed rather than being treated as a
    // valid terminal review context.
    let run_finished_at = match run_finished_at {
        Some(value) if !value.trim().is_empty() => {
            chrono::DateTime::parse_from_rfc3339(value.trim())
                .map_err(|e| format!("session run finished_at is not RFC3339: {e}"))?;
            value
        }
        _ => return Err("session run has no terminal finished_at timestamp".to_string()),
    };

    // Exactly one consumed native binding must prove this run was linked to the
    // Goal. Zero rows is an unproven association; more than one is ambiguous.
    let mut stmt = conn
        .prepare(
            "SELECT binding_id, agent_id, project_root, task_run_id, bun_instance_id \
             FROM goal_run_bindings \
             WHERE session_id = ?1 AND goal_id = ?2 AND consumed_run_id = ?3 \
               AND consumed_at IS NOT NULL",
        )
        .map_err(|e| format!("goal run binding readback unavailable: {e}"))?;
    let bindings = stmt
        .query_map(rusqlite::params![session_id, goal_id, run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| format!("goal run binding readback unavailable: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("goal run binding readback unavailable: {e}"))?;
    let (
        binding_id,
        binding_agent_id,
        binding_project_root,
        binding_task_run_id,
        binding_bun_instance_id,
    ) = match bindings.len() {
        1 => bindings.into_iter().next().unwrap(),
        0 => return Err("no consumed native Goal-run binding exists for this run".to_string()),
        _ => return Err("multiple native Goal-run bindings match this run".to_string()),
    };
    if binding_agent_id != session_agent {
        return Err(format!(
            "native Goal-run binding Agent '{binding_agent_id}' does not match the Session/Goal Agent '{session_agent}'"
        ));
    }
    let binding_project_root = match binding_project_root {
        Some(root) if root == canonical => root,
        Some(root) => {
            return Err(format!(
                "native Goal-run binding workspace '{root}' does not match the canonical workspace"
            ))
        }
        None => return Err("native Goal-run binding has no workspace binding".to_string()),
    };
    let binding_task_run_id = binding_task_run_id.trim().to_string();
    if binding_task_run_id.is_empty() {
        return Err("native Goal-run binding has no task run identity".to_string());
    }
    let binding_bun_instance_id = binding_bun_instance_id
        .ok_or_else(|| "native Goal-run binding was not confirmed against a Bun instance".to_string())?;
    if binding_bun_instance_id.trim().is_empty() {
        return Err("native Goal-run binding has an empty Bun instance identity".to_string());
    }

    Ok(VerifiedScope {
        session_id: session_id.to_string(),
        goal_id: goal_id.to_string(),
        run_id: run_id.to_string(),
        agent_id: session_agent,
        project_root: canonical,
        binding_id,
        binding_agent_id,
        binding_project_root,
        binding_task_run_id,
        binding_bun_instance_id,
        run_outcome,
        run_finished_at: Some(run_finished_at),
    })
}

// ── Bounded read-only Git process ────────────────────────────

/// Read at most `max_bytes`, draining the rest so the child never blocks on a
/// full pipe. Returns the bounded bytes and whether more data existed.
fn read_bounded(mut reader: impl Read, max_bytes: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < max_bytes {
                    let remaining = max_bytes - buf.len();
                    let take = n.min(remaining);
                    buf.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (buf, truncated)
}

/// Run one fixed-argument Git command under the shared deadline. Stdout/stderr
/// are drained on reader threads while the child is polled; on timeout the
/// child is killed and the call fails closed. Fixed global config arguments are
/// prepended to every subcommand so a repository- or user-configured external
/// FSMonitor can never run (including for `status`), and `GIT_OPTIONAL_LOCKS=0`
/// prevents index refreshes so the call never writes to the repository.
fn run_git(
    root: &Path,
    args: &[&str],
    deadline: Instant,
    max_bytes: usize,
) -> Result<GitCapture, String> {
    // Fixed `-c` overrides precede the subcommand so both repository and user
    // configuration are overridden; these are never caller-controlled.
    let mut child = Command::new("git")
        .args(["-c", "core.fsmonitor=false"])
        .args(args.iter().copied())
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git is unavailable: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git stderr unavailable".to_string())?;

    let out_handle = std::thread::spawn(move || read_bounded(stdout, max_bytes));
    let err_handle = std::thread::spawn(move || read_bounded(stderr, max_bytes));

    let mut timed_out = false;
    let mut wait_error: Option<String> = None;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                wait_error = Some(format!("git wait failed: {e}"));
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };

    let (stdout_bytes, out_truncated) = out_handle.join().unwrap_or_else(|_| (Vec::new(), true));
    let (stderr_bytes, err_truncated) = err_handle.join().unwrap_or_else(|_| (Vec::new(), true));

    if let Some(error) = wait_error {
        return Err(error);
    }
    if timed_out {
        return Err("git snapshot timed out".to_string());
    }

    Ok(GitCapture {
        success,
        stdout: stdout_bytes,
        stderr: String::from_utf8_lossy(&stderr_bytes).trim().to_string(),
        truncated: out_truncated || err_truncated,
    })
}

// ── Path handling ────────────────────────────────────────────

/// A path parsed from raw `-z` Git bytes. `display` is a stable, injective
/// percent-encoding of the exact bytes, so a valid-UTF-8 path can never alias an
/// escaped non-UTF-8 path. `utf8` is false when the raw bytes are not valid
/// UTF-8; those paths are never used for filesystem lookup (this command never
/// reads untracked contents at all).
struct RawPath {
    display: String,
    utf8: bool,
}

impl RawPath {
    fn from_bytes(bytes: &[u8]) -> RawPath {
        RawPath {
            display: percent_encode_path(bytes),
            utf8: std::str::from_utf8(bytes).is_ok(),
        }
    }
}

/// Percent-encode the exact raw bytes. `%` is always encoded and the encoding is
/// deterministic, making the mapping injective (no lossy aliases).
fn percent_encode_path(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &byte in bytes {
        let unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

/// Split NUL-delimited output into complete fields only. A trailing fragment
/// not followed by a NUL (possible when bounded output was cut mid-path) is
/// dropped and reported so it is never emitted as an exact path.
fn terminated_fields(bytes: &[u8]) -> (Vec<&[u8]>, bool) {
    let mut fields = Vec::new();
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == 0 {
            fields.push(&bytes[start..index]);
            start = index + 1;
        }
    }
    let dropped = start < bytes.len();
    (fields, dropped)
}

/// Parse porcelain v1 `-z` output into changed paths, recording both sides of a
/// rename/copy so no affected path is dropped. Raw bytes are preserved; no
/// lossy UTF-8 substitution is ever produced. Only NUL-terminated fields are
/// treated as exact paths.
fn parse_porcelain_paths(bytes: &[u8]) -> (Vec<RawPath>, bool) {
    let (fields, dropped) = terminated_fields(bytes);
    let mut out = Vec::new();
    let mut fields = fields.into_iter().peekable();
    while let Some(field) = fields.next() {
        if field.is_empty() || field.len() < 3 {
            continue;
        }
        let status = field[0];
        out.push(RawPath::from_bytes(&field[3..]));
        if (status == b'R' || status == b'C') && fields.peek().is_some() {
            if let Some(original) = fields.next() {
                if !original.is_empty() {
                    out.push(RawPath::from_bytes(original));
                }
            }
        }
    }
    (out, dropped)
}

/// Parse NUL-separated path bytes (e.g. `git ls-files -z`) preserving raw bytes.
/// Only NUL-terminated fields are treated as exact paths.
fn parse_z_paths(bytes: &[u8]) -> (Vec<RawPath>, bool) {
    let (fields, dropped) = terminated_fields(bytes);
    let paths = fields
        .into_iter()
        .filter(|field| !field.is_empty())
        .map(RawPath::from_bytes)
        .collect();
    (paths, dropped)
}

/// Record one display path under `MAX_CHANGED_PATHS`. Echoing a path already
/// recorded is ignored; once the cap is reached the dedup set stops growing and
/// `truncated` is set so coverage is never implied to be exhaustive.
fn record_changed_path(
    changed_paths: &mut Vec<String>,
    seen: &mut HashSet<String>,
    truncated: &mut bool,
    display: String,
) {
    if seen.contains(&display) {
        return;
    }
    if changed_paths.len() >= MAX_CHANGED_PATHS {
        *truncated = true;
        return;
    }
    seen.insert(display.clone());
    changed_paths.push(display);
}

/// Extract the affected path from a Git `Binary files a/x and b/y differ` line.
fn binary_path_from_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix("Binary files ")?;
    let rest = rest.strip_suffix(" differ").unwrap_or(rest);
    let (first, second) = rest.split_once(" and ")?;
    let chosen = if second.trim() == "/dev/null" {
        first.trim()
    } else {
        second.trim()
    };
    let path = chosen
        .strip_prefix("a/")
        .or_else(|| chosen.strip_prefix("b/"))
        .unwrap_or(chosen);
    Some(path.to_string())
}

/// Append one bounded Git diff capture to the running diff, honouring the total
/// byte budget and recording truncation as a partial detail.
fn append_diff(
    diff: &mut String,
    remaining: &mut usize,
    cap: &GitCapture,
    label: &str,
    partial: &mut bool,
    details: &mut Vec<String>,
) {
    if cap.truncated {
        *partial = true;
        details.push(format!("{label} exceeded the 512 KiB diff output limit"));
    }
    if std::str::from_utf8(&cap.stdout).is_err() {
        *partial = true;
        details.push(format!(
            "{label} contains non-UTF-8 bytes; it is shown with replacement characters and is not a complete representation"
        ));
    }
    let text = String::from_utf8_lossy(&cap.stdout);
    let bytes = text.as_bytes();
    if bytes.len() > *remaining {
        let take = *remaining;
        diff.push_str(&String::from_utf8_lossy(&bytes[..take]));
        *remaining = 0;
        *partial = true;
        details.push(format!("{label} was truncated at the total diff limit"));
    } else {
        diff.push_str(&text);
        *remaining -= bytes.len();
    }
}

// ── Snapshot constructors ────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn snapshot_captured(
    scope: &VerifiedScope,
    head: String,
    branch: Option<String>,
    changed_paths: Vec<String>,
    changed_paths_exhaustive: bool,
    diff: String,
    partial: bool,
    details: Vec<String>,
) -> ProjectStewardWorkspaceSnapshot {
    let diff_sha256 = Some(crate::jarvis::memory::turn::message_sha256(&diff));
    ProjectStewardWorkspaceSnapshot {
        session_id: scope.session_id.clone(),
        goal_id: scope.goal_id.clone(),
        run_id: scope.run_id.clone(),
        agent_id: scope.agent_id.clone(),
        project_root: scope.project_root.clone(),
        run_outcome: scope.run_outcome.clone(),
        run_finished_at: scope.run_finished_at.clone(),
        git_head: Some(head),
        git_branch: branch,
        changed_paths,
        changed_paths_exhaustive,
        diff,
        diff_sha256,
        captured_at: now_iso(),
        state: if partial {
            ProjectStewardSnapshotState::Partial
        } else {
            ProjectStewardSnapshotState::Complete
        },
        reason: if partial {
            Some("workspace snapshot is partial; see details for affected paths".to_string())
        } else {
            None
        },
        details,
    }
}

fn snapshot_unavailable(
    scope: &VerifiedScope,
    reason: &str,
    details: Vec<String>,
) -> ProjectStewardWorkspaceSnapshot {
    ProjectStewardWorkspaceSnapshot {
        session_id: scope.session_id.clone(),
        goal_id: scope.goal_id.clone(),
        run_id: scope.run_id.clone(),
        agent_id: scope.agent_id.clone(),
        project_root: scope.project_root.clone(),
        run_outcome: scope.run_outcome.clone(),
        run_finished_at: scope.run_finished_at.clone(),
        git_head: None,
        git_branch: None,
        changed_paths: Vec::new(),
        changed_paths_exhaustive: false,
        diff: String::new(),
        diff_sha256: None,
        captured_at: now_iso(),
        state: ProjectStewardSnapshotState::Unavailable,
        reason: Some(reason.to_string()),
        details,
    }
}

fn snapshot_stale(scope: &VerifiedScope, reason: &str) -> ProjectStewardWorkspaceSnapshot {
    ProjectStewardWorkspaceSnapshot {
        session_id: scope.session_id.clone(),
        goal_id: scope.goal_id.clone(),
        run_id: scope.run_id.clone(),
        agent_id: scope.agent_id.clone(),
        project_root: scope.project_root.clone(),
        run_outcome: scope.run_outcome.clone(),
        run_finished_at: scope.run_finished_at.clone(),
        git_head: None,
        git_branch: None,
        changed_paths: Vec::new(),
        changed_paths_exhaustive: false,
        diff: String::new(),
        diff_sha256: None,
        captured_at: now_iso(),
        state: ProjectStewardSnapshotState::Stale,
        reason: Some(reason.to_string()),
        details: Vec::new(),
    }
}

// ── Snapshot orchestration ───────────────────────────────────

/// Raw Git observations for the bound workspace, shared by the first pass and
/// the coherence reread. `unstaged_budget` records the exact byte budget used
/// for the unstaged diff so the reread can reuse it.
struct RawReads {
    head: GitCapture,
    branch: GitCapture,
    status: GitCapture,
    untracked: GitCapture,
    staged: GitCapture,
    unstaged: GitCapture,
    unstaged_budget: usize,
}

/// Run the full fixed-argument read set against `root`. Every command uses the
/// same fixed config, output bounds, and the shared deadline. On the reread,
/// `unstaged_budget` is the first pass's value so both passes apply the
/// identical diff byte budget. Any spawn error or deadline exhaustion is an
/// `Err`; a non-success exit is returned in the capture for the caller to judge.
fn run_reads(
    root: &Path,
    deadline: Instant,
    staged_budget: usize,
    unstaged_budget: Option<usize>,
) -> Result<RawReads, String> {
    let head = run_git(root, &["rev-parse", "HEAD"], deadline, METADATA_MAX_BYTES)?;
    let branch = run_git(
        root,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        deadline,
        METADATA_MAX_BYTES,
    )?;
    let status = run_git(
        root,
        &["status", "--porcelain=v1", "-z"],
        deadline,
        METADATA_MAX_BYTES,
    )?;
    let untracked = run_git(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        deadline,
        METADATA_MAX_BYTES,
    )?;
    let staged = run_git(
        root,
        &["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv"],
        deadline,
        staged_budget,
    )?;
    let unstaged_budget = match unstaged_budget {
        Some(value) => value,
        None => DIFF_MAX_BYTES.saturating_sub(String::from_utf8_lossy(&staged.stdout).len()),
    };
    let unstaged = run_git(
        root,
        &["diff", "--no-color", "--no-ext-diff", "--no-textconv"],
        deadline,
        unstaged_budget,
    )?;
    Ok(RawReads {
        head,
        branch,
        status,
        untracked,
        staged,
        unstaged,
        unstaged_budget,
    })
}

/// Exact comparison of one Git observation: success, truncation, and stdout
/// bytes. stderr text is not part of the workspace observation.
fn capture_eq(first: &GitCapture, second: &GitCapture) -> bool {
    first.success == second.success
        && first.truncated == second.truncated
        && first.stdout == second.stdout
}

/// True only when every reread observation is byte-identical to the first pass.
fn reads_coherent(first: &RawReads, second: &RawReads) -> bool {
    capture_eq(&first.head, &second.head)
        && capture_eq(&first.branch, &second.branch)
        && capture_eq(&first.status, &second.status)
        && capture_eq(&first.untracked, &second.untracked)
        && capture_eq(&first.staged, &second.staged)
        && capture_eq(&first.unstaged, &second.unstaged)
}

fn capture_snapshot(
    db: &AppDb,
    session_id: &str,
    goal_id: &str,
    run_id: &str,
) -> Result<ProjectStewardWorkspaceSnapshot, String> {
    if session_id.is_empty() || goal_id.is_empty() || run_id.is_empty() {
        return Err("session, goal, and run identity are required".to_string());
    }

    let scope = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        load_verified_scope(&conn, session_id, goal_id, run_id)?
    };

    let root = std::path::PathBuf::from(&scope.project_root);
    let deadline = Instant::now() + GIT_TIMEOUT;

    // Git's own toplevel must resolve to the exact bound workspace. No caller
    // path and no model-provided path is ever passed to Git.
    let toplevel = match run_git(
        &root,
        &["rev-parse", "--show-toplevel"],
        deadline,
        METADATA_MAX_BYTES,
    ) {
        Ok(cap) if cap.success => String::from_utf8_lossy(&cap.stdout).trim().to_string(),
        Ok(_) => {
            return Ok(snapshot_unavailable(
                &scope,
                "workspace is not a readable Git repository",
                Vec::new(),
            ))
        }
        Err(error) => return Ok(snapshot_unavailable(&scope, &error, Vec::new())),
    };
    let toplevel_canon = match crate::jarvis::memory::scope::normalize_project_root(&toplevel) {
        Ok(canon) => canon,
        Err(error) => {
            return Ok(snapshot_unavailable(
                &scope,
                &format!("workspace root is unavailable: {error}"),
                Vec::new(),
            ))
        }
    };
    if toplevel_canon != scope.project_root {
        return Ok(snapshot_unavailable(
            &scope,
            "Git workspace root does not match the bound Session/Goal workspace",
            vec![toplevel_canon],
        ));
    }

    // First pass: the full fixed-argument read set within the shared deadline.
    let reads = match run_reads(&root, deadline, DIFF_MAX_BYTES, None) {
        Ok(reads) => reads,
        Err(error) => return Ok(snapshot_unavailable(&scope, &error, Vec::new())),
    };
    if !reads.head.success {
        return Ok(snapshot_unavailable(
            &scope,
            &format!("Git HEAD is unavailable: {}", reads.head.stderr),
            Vec::new(),
        ));
    }
    if !reads.status.success {
        return Ok(snapshot_unavailable(
            &scope,
            &format!("Git status failed: {}", reads.status.stderr),
            Vec::new(),
        ));
    }
    if !reads.untracked.success {
        return Ok(snapshot_unavailable(
            &scope,
            &format!("Git untracked listing failed: {}", reads.untracked.stderr),
            Vec::new(),
        ));
    }
    if !reads.staged.success {
        return Ok(snapshot_unavailable(
            &scope,
            &format!("staged diff failed: {}", reads.staged.stderr),
            Vec::new(),
        ));
    }
    if !reads.unstaged.success {
        return Ok(snapshot_unavailable(
            &scope,
            &format!("unstaged diff failed: {}", reads.unstaged.stderr),
            Vec::new(),
        ));
    }

    let head = String::from_utf8_lossy(&reads.head.stdout).trim().to_string();

    let mut details: Vec<String> = Vec::new();
    let mut partial = false;

    let branch = if reads.branch.success {
        Some(String::from_utf8_lossy(&reads.branch.stdout).trim().to_string())
    } else {
        partial = true;
        details.push("Git branch could not be read".to_string());
        None
    };

    // Path coverage is proven exhaustive only when no metadata command was
    // truncated and the path cap was never reached. `changed_paths` is a
    // display-only list: raw path bytes are never used for filesystem lookup.
    let mut changed_paths: Vec<String> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut paths_truncated = false;
    let mut lossy_paths = false;

    if reads.status.truncated {
        partial = true;
        paths_truncated = true;
        details.push(
            "Git status output was truncated at the collection limit; the changed path list is not exhaustive"
                .to_string(),
        );
    }
    let (status_paths, status_fragment_dropped) = parse_porcelain_paths(&reads.status.stdout);
    if status_fragment_dropped {
        partial = true;
        paths_truncated = true;
        details.push(
            "Git status output ended with a non-NUL-terminated path fragment that was not treated as an exact path"
                .to_string(),
        );
    }
    for path in status_paths {
        if !path.utf8 {
            lossy_paths = true;
        }
        record_changed_path(
            &mut changed_paths,
            &mut seen_paths,
            &mut paths_truncated,
            path.display,
        );
    }

    if reads.untracked.truncated {
        partial = true;
        paths_truncated = true;
        details.push(
            "Git untracked listing was truncated at the collection limit; the changed path list is not exhaustive"
                .to_string(),
        );
    }
    let (untracked_paths, untracked_fragment_dropped) = parse_z_paths(&reads.untracked.stdout);
    if untracked_fragment_dropped {
        partial = true;
        paths_truncated = true;
        details.push(
            "Git untracked listing ended with a non-NUL-terminated path fragment that was not treated as an exact path"
                .to_string(),
        );
    }

    let mut diff = String::new();
    let mut remaining = DIFF_MAX_BYTES;
    append_diff(
        &mut diff,
        &mut remaining,
        &reads.staged,
        "staged tracked diff",
        &mut partial,
        &mut details,
    );
    append_diff(
        &mut diff,
        &mut remaining,
        &reads.unstaged,
        "unstaged tracked diff",
        &mut partial,
        &mut details,
    );

    // Untracked contents are never read. A race-safe no-follow open for every
    // path component is not portable with the current dependencies, so the
    // snapshot lists the exact untracked paths and reports partial instead of
    // risking a read outside the bound root or through a symlink.
    for path in &untracked_paths {
        if !path.utf8 {
            lossy_paths = true;
        }
        record_changed_path(
            &mut changed_paths,
            &mut seen_paths,
            &mut paths_truncated,
            path.display.clone(),
        );
    }
    if !untracked_paths.is_empty() {
        partial = true;
        details.push(format!(
            "{} untracked path(s) listed without reading contents; untracked file contents are omitted for filesystem safety",
            untracked_paths.len()
        ));
    }

    if lossy_paths {
        partial = true;
        details.push(
            "one or more paths are not valid UTF-8; their names are shown as stable percent-escaped byte strings"
                .to_string(),
        );
    }

    let binary_paths: Vec<String> = diff
        .lines()
        .filter(|line| line.starts_with("Binary files "))
        .filter_map(binary_path_from_line)
        .collect();
    for path in binary_paths {
        partial = true;
        details.push(format!("binary change is not fully represented: {path}"));
        record_changed_path(
            &mut changed_paths,
            &mut seen_paths,
            &mut paths_truncated,
            path,
        );
    }

    if paths_truncated {
        partial = true;
    }

    changed_paths.sort();

    // Coherence reread immediately before success: re-observe the same fixed
    // read set and require exact agreement. A failed read, an exhausted
    // deadline, or any changed observation returns `stale` with no diff, hash,
    // or path output, so a returned snapshot's revision and patch cannot
    // disagree. The first pass's unstaged diff budget is reused.
    let rereads = match run_reads(&root, deadline, DIFF_MAX_BYTES, Some(reads.unstaged_budget)) {
        Ok(rereads) => rereads,
        Err(_) => {
            return Ok(snapshot_stale(
                &scope,
                "Git snapshot could not be re-read coherently within the deadline",
            ))
        }
    };
    if !reads_coherent(&reads, &rereads) {
        return Ok(snapshot_stale(
            &scope,
            "Git HEAD, branch, status, untracked, or diff observations changed between reads",
        ));
    }

    // Final authority reread immediately before success: if the Session, Goal,
    // run, or consumed binding moved while Git ran, discard the diff.
    let recheck = {
        let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
        load_verified_scope(&conn, session_id, goal_id, run_id)
    };
    match recheck {
        Ok(after) if after == scope => {}
        _ => {
            return Ok(snapshot_stale(
                &scope,
                "session, goal, or run binding changed while the snapshot was captured",
            ))
        }
    }

    Ok(snapshot_captured(
        &scope,
        head,
        branch,
        changed_paths,
        !paths_truncated,
        diff,
        partial,
        details,
    ))
}

// ── Command ──────────────────────────────────────────────────

/// Read-only Project Steward workspace snapshot for one exact Session/Goal/run
/// tuple. The command derives all scope from SQLite and never mutates the
/// workspace, repository index, or Goal state.
#[tauri::command]
pub async fn project_steward_workspace_snapshot(
    app: tauri::AppHandle,
    session_id: String,
    goal_id: String,
    run_id: String,
) -> Result<ProjectStewardWorkspaceSnapshot, String> {
    let session_id = session_id.trim().to_string();
    let goal_id = goal_id.trim().to_string();
    let run_id = run_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<AppDb>();
        capture_snapshot(db.inner(), &session_id, &goal_id, &run_id)
    })
    .await
    .map_err(|error| format!("project steward snapshot join error: {error}"))?
}
