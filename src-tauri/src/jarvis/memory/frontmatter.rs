//! YAML frontmatter parsing for memory cold-storage files.
//!
//! Memories in the cold tier are serialized as Markdown files with YAML
//! frontmatter metadata. This module handles parsing and serializing
//! that frontmatter.

use serde::{Deserialize, Serialize};

/// Frontmatter metadata stored in cold-tier memory files.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryFrontmatter {
    pub id: String,
    pub memory_type: String,
    pub tier: String,
    pub confidence: f64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drive_file_id: Option<String>,
}

/// Parse YAML frontmatter from a cold-tier memory file.
///
/// Files are expected to be delimited by `---` markers:
/// ```text
/// ---
/// id: abc-123
/// memory_type: user
/// tier: cold
/// ...
/// ---
/// Actual memory content here...
/// ```
pub fn parse_frontmatter(content: &str) -> Result<(MemoryFrontmatter, String), String> {
    let trimmed = content.trim();

    if !trimmed.starts_with("---") {
        return Err("File does not start with YAML frontmatter delimiter".to_string());
    }

    // Find the closing ---
    let after_first = &trimmed[3..];
    let Some(end_idx) = after_first.find("\n---") else {
        return Err("No closing YAML frontmatter delimiter found".to_string());
    };

    let yaml_str = &after_first[..end_idx];
    let body = after_first[end_idx + 4..].trim();

    let frontmatter: MemoryFrontmatter = serde_yaml::from_str(yaml_str)
        .map_err(|e| format!("Failed to parse YAML frontmatter: {}", e))?;

    Ok((frontmatter, body.to_string()))
}

/// Serialize a memory record into cold-tier file format.
pub fn serialize_frontmatter(frontmatter: &MemoryFrontmatter, body: &str) -> String {
    let yaml = serde_yaml::to_string(frontmatter).unwrap_or_default();
    format!("---\n{}---\n\n{}", yaml.trim_end(), body)
}

/// Extract just the frontmatter section from a file.
pub fn extract_frontmatter_section(content: &str) -> Option<&str> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return None;
    }
    let after_first = &trimmed[3..];
    after_first.find("\n---").map(|idx| &after_first[..idx])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_frontmatter_basic() {
        let input = "---\nid: test-001\nmemory_type: user\ntier: cold\nconfidence: 0.8\ncreated_at: 2026-06-16T00:00:00Z\nupdated_at: 2026-06-16T00:00:00Z\n---\n\nThis is a test memory.";
        let (fm, body) = parse_frontmatter(input).unwrap();
        assert_eq!(fm.id, "test-001");
        assert_eq!(fm.memory_type, "user");
        assert_eq!(fm.confidence, 0.8);
        assert_eq!(body, "This is a test memory.");
    }

    #[test]
    fn test_parse_frontmatter_with_optional_fields() {
        let input = "---\nid: test-002\nmemory_type: feedback\ntier: cold\nconfidence: 0.5\ncreated_at: 2026-06-16T00:00:00Z\nupdated_at: 2026-06-16T00:00:00Z\nexpires_at: 2026-09-16T00:00:00Z\n---\n\nFeedback memory content.";
        let (fm, body) = parse_frontmatter(input).unwrap();
        assert_eq!(fm.id, "test-002");
        assert!(fm.expires_at.is_some());
        assert_eq!(body, "Feedback memory content.");
    }

    #[test]
    fn test_serialize_roundtrip() {
        let fm = MemoryFrontmatter {
            id: "test-003".to_string(),
            memory_type: "project".to_string(),
            tier: "cold".to_string(),
            confidence: 0.9,
            created_at: "2026-06-16T00:00:00Z".to_string(),
            updated_at: "2026-06-16T00:00:00Z".to_string(),
            expires_at: None,
            review_after: None,
            superseded_by: None,
            drive_file_id: None,
        };
        let serialized = serialize_frontmatter(&fm, "Project memory content.");
        let (parsed, body) = parse_frontmatter(&serialized).unwrap();
        assert_eq!(parsed.id, "test-003");
        assert_eq!(body, "Project memory content.");
    }

    #[test]
    fn test_extract_frontmatter_section() {
        let input = "---\nid: test-004\n---\n\nBody here.";
        let section = extract_frontmatter_section(input).unwrap();
        assert!(section.contains("id: test-004"));
    }
}
