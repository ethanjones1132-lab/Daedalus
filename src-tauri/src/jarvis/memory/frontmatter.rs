use crate::jarvis::memory::types::MemoryFrontmatter;

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
