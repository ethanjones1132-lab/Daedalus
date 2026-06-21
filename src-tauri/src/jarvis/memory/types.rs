use serde::{Deserialize, Serialize};

// ═══════════════════════════════════════════════════════════════
// ── Memory Type Enum ──
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    User,
    Feedback,
    Project,
    Reference,
}

impl MemoryType {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryType::User => "user",
            MemoryType::Feedback => "feedback",
            MemoryType::Project => "project",
            MemoryType::Reference => "reference",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "user" => Some(MemoryType::User),
            "feedback" => Some(MemoryType::Feedback),
            "project" => Some(MemoryType::Project),
            "reference" => Some(MemoryType::Reference),
            _ => None,
        }
    }
}

impl Default for MemoryType {
    fn default() -> Self {
        MemoryType::Reference
    }
}

impl std::fmt::Display for MemoryType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// ═══════════════════════════════════════════════════════════════
// ── Memory Frontmatter ──
// ═══════════════════════════════════════════════════════════════
//
// RECOVERY NOTE (2026-06-19):
//   The MemoryFrontmatter struct was referenced by jarvis/memory/frontmatter.rs
//   but never defined in the recovered tree. The fields below are the minimum
//   needed to satisfy every consumer: the YAML parser in frontmatter.rs, the
//   cold-tier Drive archive in engine.rs (supersedes_id / source / agent_id
//   round-trip), and the learning research code (memory_type as a typed enum).
//   New optional fields should be added with `#[serde(default)]` to preserve
//   forward-compatibility with on-disk markdown files.
//

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryFrontmatter {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub memory_type: MemoryType,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_id: Option<String>,
    #[serde(default = "default_status")]
    pub status: String,
}

fn default_confidence() -> f64 {
    0.5
}

fn default_status() -> String {
    "active".to_string()
}

impl Default for MemoryFrontmatter {
    fn default() -> Self {
        Self {
            title: String::new(),
            category: String::new(),
            tags: Vec::new(),
            confidence: default_confidence(),
            memory_type: MemoryType::default(),
            source: String::new(),
            agent_id: String::new(),
            supersedes_id: None,
            status: default_status(),
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// ── Prompt sections ──
// ═══════════════════════════════════════════════════════════════
//
// These string constants are consumed by build_memory_prompt() in mod.rs.
// They were declared in the recovered tree as `TYPES_SECTION`, `HOW_TO_SAVE`,
// `WHEN_TO_ACCESS`, and `TRUSTING_RECALL` in mod.rs's `use crate::jarvis::memory::types::*;`.
// Re-declared here so the wildcard import resolves.

pub const TYPES_SECTION: &[&str] = &[
    "## Memory Categories",
    "- **user**: explicit facts the user has stated about themselves, their environment, or their preferences.",
    "- **feedback**: corrections, preferences, or guidance the user has given about how the agent should behave.",
    "- **project**: ongoing work, decisions, and context tied to a specific project or agent.",
    "- **reference**: external knowledge, conventions, or documentation that the agent should remember between sessions.",
];

pub const HOW_TO_SAVE: &[&str] = &[
    "## How to Save",
    "Call the `memory_save` command with a concise title, the body content, a category, and a list of tags. The system stores the entry in SQLite, indexes it in FTS5 for recall, and emits a memory event.",
    "Prefer one memory per idea. If a fact supersedes an older one, save the new one with `supersedes_id` set so the old entry is tombstoned instead of duplicated.",
];

pub const WHEN_TO_ACCESS: &[&str] = &[
    "## When to Access",
    "Run `memory_recall_preview` whenever the user references something they have previously said, asks a question that depends on prior context, or when the task would otherwise require re-deriving information you could have remembered.",
    "Do not run recall speculatively for every turn — only when the user-visible benefit outweighs the latency.",
];

pub const TRUSTING_RECALL: &[&str] = &[
    "## Trusting Recall",
    "Recall scores combine lexical match (FTS5), recency (updated_at_ms), and confidence. A score >= 0.7 is a strong match; treat anything below 0.4 as a hint, not a fact.",
    "If a recalled memory contradicts the user's current statement, surface the conflict to the user rather than silently preferring the recall.",
];
