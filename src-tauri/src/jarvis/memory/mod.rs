pub mod engine;
pub mod frontmatter;
pub mod paths;
pub mod types;

// Legacy file-based modules kept for `learning.rs` (research output only).
// These are NOT used for memory persistence — all persistence goes through `engine`.
// scanner.rs and relevance.rs have been removed; all search/recall uses engine's FTS5 path.

use crate::jarvis::memory::types::*;

/// Build the memory system prompt section.
/// This is injected into the Claude CLI system prompt.
pub fn build_memory_prompt(_query: &str) -> Result<String, String> {
    let mut sections: Vec<String> = Vec::new();

    let instructions = format!(
        r#"# Memory System

You have a persistent, SQLite-backed memory system.
Your memories are stored in a database and managed through the UI.

{}
"#,
        TYPES_SECTION.join("\n")
    );
    sections.push(instructions);
    sections.push(HOW_TO_SAVE.join("\n"));
    sections.push(WHEN_TO_ACCESS.join("\n"));
    sections.push(TRUSTING_RECALL.join("\n"));

    Ok(sections.join("\n\n"))
}

/// Load relevant memory entries for injection into context.
/// Queries SQLite for memories matching the query, returns formatted context.
/// Takes a DB connection reference — caller must hold the lock.
pub fn load_relevant_memories(
    conn: &rusqlite::Connection,
    query: &str,
    max_files: usize,
) -> Result<String, String> {
    let recalls = engine::recall_memories(
        conn,
        query,
        max_files.min(5),
        false, // don't mark as used — this is a pre-turn load
    )?;

    if recalls.is_empty() {
        return Ok(String::new());
    }

    let mut lines = Vec::new();
    for recall in recalls {
        let m = recall.memory;
        lines.push(format!(
            "- id={} category={} score={:.2}: {} - {}",
            m.id,
            m.category,
            recall.score,
            m.title,
            crate::jarvis::memory::engine::truncate(&m.content, 400)
        ));
    }
    Ok(lines.join("\n"))
}
