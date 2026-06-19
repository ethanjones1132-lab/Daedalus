use crate::jarvis::memory::frontmatter::parse_frontmatter;
use crate::jarvis::memory::types::MemoryHeader;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

const MAX_MEMORY_FILES: usize = 200;
const FRONTMATTER_MAX_BYTES: usize = 2048; // Only read first 2KB for frontmatter

/// Scan a memory directory for .md files, read their frontmatter, and return
/// a header list sorted newest-first (capped at MAX_MEMORY_FILES).
pub fn scan_memory_files(memory_dir: &Path) -> Result<Vec<MemoryHeader>, String> {
    if !memory_dir.exists() {
        return Ok(vec![]);
    }

    let entries =
        fs::read_dir(memory_dir).map_err(|e| format!("Failed to read memory dir: {}", e))?;

    let mut headers = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        // Only process .md files, skip MEMORY.md and JARVIS.md
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let filename = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");

        if filename == "MEMORY" || filename == "JARVIS" {
            continue;
        }

        // Read frontmatter
        match fs::read_to_string(&path) {
            Ok(content) => {
                let frontmatter_content = if content.len() > FRONTMATTER_MAX_BYTES {
   