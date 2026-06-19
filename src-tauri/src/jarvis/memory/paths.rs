use std::path::{Path, PathBuf};

const MEMORY_DIR: &str = ".openclaw/jarvis/memory";
const MEMORY_ENTRYPOINT: &str = "MEMORY.md";
const PROJECT_CONTEXT: &str = "JARVIS.md";

/// Get the base memory directory path
pub fn memory_base_dir() -> PathBuf {
    let home = crate::get_home_dir();
    PathBuf::from(home).join(MEMORY_DIR)
}

/// Get the MEMORY.md entrypoint path
pub fn memory_entrypoint() -> PathBuf {
    memory_base_dir().join(MEMORY_ENTRYPOINT)
}

/// Get the JARVIS.md project context path
pub fn project_context() -> PathBuf {
    memory_base_dir().join(PROJECT_CONTEXT)
}

/// Get the path for a specific memory type directory
pub fn memory_type_dir(memory_type: &str) -> PathBuf {
    memory_base_dir().join(memory_type)
}

/// Ensure the memory directory structure exists
pub fn ensure_memory_dirs() -> Result<(), String> {
    let base = memory_base_dir();
    std::fs::create_dir_all(&base).map_err(|e| format!("Failed to create memory dir: {}", e))?;

    // Create type subdirectories
    for dir in &["user", "feedback", "project", "reference"] {
        let type_dir = base.join(dir);
        std::fs::create_dir_all(&type_dir)
            .map_err(|e| format!("Failed to create {} dir: {}", e, dir))?;
    }

    Ok(())
}

/// Check if an absolute path is within the memory directory (security check)
pub fn is_memory_path(absolute_path: &Path) -> bool {
    let base = memory_base_dir();
    absolute_path.starts_with(&base)
}

/// Validate a memory file path for security
/// Rejects: relative paths, root paths, paths outside memory dir, null bytes
pub fn validate_memory_path(raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw);

    // Must be absolute
    if !path.is_absolute() {
        return None;
    }

    // Must be within memory directory
    if !is_memory_path(&path) {
        return None;
    }

    // No null bytes
    if raw.contains('\0') {
        return None;
    }

    // Must be a .md file
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }

    Some(path)
}

/// Get the relative path from memory base to a file
pub fn relative_path(file_path: &Path) -> Option<String> {
    let base = memory_base_dir();
    file_path
        .strip_prefix(base)
        .ok()
        .and_then(|p| p.to_str())
        .map(|s| s.to_string())
}
