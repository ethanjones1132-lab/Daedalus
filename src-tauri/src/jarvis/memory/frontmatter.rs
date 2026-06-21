use crate::jarvis::memory::types::MemoryFrontmatter;
use crate::jarvis::memory::types::MemoryType;

/// Parse YAML frontmatter from a markdown file.
/// Frontmatter is delimited by `---` at the start and end.
/// Returns the parsed frontmatter and the body content.
pub fn parse_frontmatter(content: &str) -> (MemoryFrontmatter, String) {
    let trimmed = content.trim();

    if !trimmed.starts_with("---") {
        return (MemoryFrontmatter::default(), trimmed.to_string());
    }

    // Find the closing ---
    let after_open = &trimmed[3..];
    let Some(close_pos) = after_open.find("\n---") else {
        return (MemoryFrontmatter::default(), trimmed.to_string());
    };

    let frontmatter_str = &after_open[..close_pos];
    let body = &after_open[close_pos + 4..]; // Skip past \n---

    let frontmatter = parse_yaml_frontmatter(frontmatter_str);
    (frontmatter, body.trim().to_string())
}

fn parse_yaml_frontmatter(yaml_str: &str) -> MemoryFrontmatter {
    let mut frontmatter = MemoryFrontmatter::default();

    // Simple YAML parsing for the fields we need
    for line in yaml_str.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            let value = value.trim().trim_matches('"').trim_matches('\'');

            match key {
                "title" => frontmatter.title = value.to_string(),
                "category" => frontmatter.category = value.to_string(),
                "tags" => {
                    frontmatter.tags = value
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
                "confidence" => {
                    if let Ok(v) = value.parse::<f64>() {
                        frontmatter.confidence = v;
                    }
                }
                "memory_type" | "type" => {
                    if let Some(mt) = MemoryType::from_str(value) {
                        frontmatter.memory_type = mt;
                    }
                }
                "source" => frontmatter.source = value.to_string(),
                "agent_id" => frontmatter.agent_id = value.to_string(),
                "supersedes_id" => frontmatter.supersedes_id = Some(value.to_string()),
                "status" => frontmatter.status = value.to_string(),
                _ => { /* ignore unknown keys */ }
            }
        }
    }

    frontmatter
}

/// Serialize a frontmatter block back to text. Used when writing memories
/// as markdown files (e.g. for the cold-tier Drive archive).
pub fn serialize_frontmatter(fm: &MemoryFrontmatter) -> String {
    let mut out = String::from("---\n");
    if !fm.title.is_empty() {
        out.push_str(&format!("title: {}\n", fm.title));
    }
    if !fm.category.is_empty() {
        out.push_str(&format!("category: {}\n", fm.category));
    }
    if !fm.tags.is_empty() {
        out.push_str(&format!("tags: {}\n", fm.tags.join(", ")));
    }
    out.push_str(&format!("confidence: {}\n", fm.confidence));
    out.push_str(&format!("memory_type: {}\n", fm.memory_type.as_str()));
    if !fm.source.is_empty() {
        out.push_str(&format!("source: {}\n", fm.source));
    }
    if !fm.agent_id.is_empty() {
        out.push_str(&format!("agent_id: {}\n", fm.agent_id));
    }
    if let Some(ref sup) = fm.supersedes_id {
        out.push_str(&format!("supersedes_id: {}\n", sup));
    }
    if !fm.status.is_empty() {
        out.push_str(&format!("status: {}\n", fm.status));
    }
    out.push_str("---\n");
    out
}
