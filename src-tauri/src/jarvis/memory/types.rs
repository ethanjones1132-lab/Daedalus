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

impl std::fmt::Display for Memor