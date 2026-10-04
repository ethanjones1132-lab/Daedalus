// ═══════════════════════════════════════════════════════════════
// Memory Scope — canonical Agent/project identity resolution
// ═══════════════════════════════════════════════════════════════
//
// Agent identity always comes from the persisted Session row. Project scope
// is an explicit, validated workspace binding and is separate from filesystem
// authorization. Callers never supply their own Agent ownership.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Component, Path};

use super::contracts::{MemoryError, MemoryScope, ScopeSelector, WritableScopeKind};

/// Read `(agent_id, project_root)` for a Session, failing closed when the
/// Session does not exist or has no usable Agent identity.
fn session_owner(conn: &Connection, session_id: &str) -> Result<(String, Option<String>), MemoryError> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT agent_id, project_root FROM sessions WHERE id = ?",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(MemoryError::from)?;
    let (agent_id, project_root) = row.ok_or_else(|| {
        MemoryError::session_not_found("Session not found")
    })?;
    if agent_id.trim().is_empty() {
        return Err(MemoryError::invalid_scope(
            "Persisted Session has no Agent identity",
        ));
    }
    Ok((agent_id, project_root))
}

#[cfg(windows)]
fn canonical_to_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    stripped.replace('/', "\\")
}

#[cfg(not(windows))]
fn canonical_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// Canonicalize and validate a project workspace root.
///
/// Rejects empty, NUL-containing, home-relative, relative, parent-traversal,
/// and filesystem-root paths. A directory whose *name* merely contains `..`
/// is permitted. Missing/unreadable roots fail as `workspace_unavailable`.
pub fn normalize_project_root(raw: &str) -> Result<String, MemoryError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(MemoryError::invalid_path("Project root must not be empty"));
    }
    if trimmed.contains('\0') {
        return Err(MemoryError::invalid_path("Project root contains NUL"));
    }
    if trimmed.starts_with('~') {
        return Err(MemoryError::invalid_path(
            "Project root must not be home-relative",
        ));
    }

    let path = Path::new(trimmed);
    if path.is_relative() {
        return Err(MemoryError::invalid_path(
            "Project root must be an absolute path",
        ));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(MemoryError::invalid_path(
            "Project root must not contain parent traversal",
        ));
    }

    let canonical = std::fs::canonicalize(path).map_err(|_| {
        MemoryError::workspace_unavailable("Project workspace is unavailable")
    })?;
    if !canonical.is_dir() {
        return Err(MemoryError::invalid_path(
            "Project root must be an existing directory",
        ));
    }
    if canonical.parent().is_none() {
        return Err(MemoryError::invalid_path(
            "The filesystem root cannot be a project binding",
        ));
    }

    Ok(canonical_to_string(&canonical))
}

/// Explicitly bind (or unbind) a Session's workspace. Binding is an operator
/// action, not a filesystem grant, and never moves existing memory records.
pub fn bind_session_workspace(
    conn: &Connection,
    session_id: &str,
    root: Option<&str>,
) -> Result<MemoryScope, MemoryError> {
    let (agent_id, _) = session_owner(conn, session_id)?;
    match root {
        Some(raw) => {
            let canonical = normalize_project_root(raw)?;
            conn.execute(
                "UPDATE sessions SET project_root = ? WHERE id = ?",
                params![&canonical, session_id],
            )
            .map_err(MemoryError::from)?;
            Ok(MemoryScope::project(agent_id, canonical))
        }
        None => {
            conn.execute(
                "UPDATE sessions SET project_root = NULL WHERE id = ?",
                params![session_id],
            )
            .map_err(MemoryError::from)?;
            Ok(MemoryScope::agent(agent_id))
        }
    }
}

/// Resolve the effective read scope for a Session. A persisted project binding
/// is revalidated on every resolution and fails closed when unavailable.
pub fn resolve_session_memory_scope(
    conn: &Connection,
    session_id: &str,
) -> Result<MemoryScope, MemoryError> {
    let (agent_id, bound_root) = session_owner(conn, session_id)?;
    match bound_root {
        Some(root) => {
            let canonical = normalize_project_root(&root)?;
            Ok(MemoryScope::project(agent_id, canonical))
        }
        None => Ok(MemoryScope::agent(agent_id)),
    }
}

/// Resolve the scope a write should land in. Project selection requires an
/// explicit binding; an unbound Session cannot request project writes. User
/// scope is never a fallback.
pub fn resolve_write_scope(
    conn: &Connection,
    session_id: &str,
    selector: &ScopeSelector,
) -> Result<MemoryScope, MemoryError> {
    let (agent_id, bound_root) = session_owner(conn, session_id)?;
    match selector.kind {
        WritableScopeKind::Project => match bound_root {
            Some(root) => {
                let canonical = normalize_project_root(&root)?;
                Ok(MemoryScope::project(agent_id, canonical))
            }
            None => Err(MemoryError::invalid_scope(
                "Session has no project binding; bind a workspace before requesting project scope",
            )),
        },
        WritableScopeKind::Agent => Ok(MemoryScope::agent(agent_id)),
        WritableScopeKind::User => Ok(MemoryScope::user()),
    }
}
