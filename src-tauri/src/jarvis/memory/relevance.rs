use rusqlite::Connection;

/// Find memory IDs relevant to a query using SQLite FTS5 search.
/// This replaces the old file-based scan + Ollama selection approach.
/// Falls back to LIKE search if FTS5 returns no results.
pub fn find_relevant_memories(
    conn: &Connection,
    query: &str,
    already_surfaced: &[String],
    limit: usize,
) -> Result<Vec<String>, String> {
    let query_lower = query.to_lowercase();
    let fts_expr = query_lower.trim();
    if fts_expr.is_empty() {
        return Ok(vec![]);
    }

    // Build the FTS5 query: split into terms, join with OR, add prefix matching
    let stopwords = [
        "in", "on", "at", "to", "of", "is", "it", "an", "as", "by", "if", "or", "so", "we", "he",
        "me", "my", "up", "do", "no", "us", "be", "am", "go", "so", "oh", "ah", "ex",
    ];
    let terms: Vec<&str> = fts_expr
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| s.len() >= 3 || (s.len() == 2 && !stopwords.contains(s)))
        .filter(|s| !s.is_empty())
        .take(8)
        .collect();

    if terms.is_empty() {
        return Ok(vec![]);
    }

    let fts_query: String = terms
        .iter()
        .map(|t| format!("{}*", t))
        .collect::<Vec<_>>()
        .join(" OR ");

    // Try FTS5 first
    let fts_sql = "SELECT m.id FROM memory_fts f
                   JOIN memory m ON m.id = f.id

    let rows = stmt
        .query_map([&fts_query, &(limit * 3).to_string()], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("FTS5 row mapping failed: {}", e))?;

    let mut results: Vec<String> = Vec::new();
    for row in rows {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("FTS5 row mapping failed: {}", e))?;

    let mut results: Vec<String> = Vec::new();
    for row in rows {
        match row {
            Ok(id) => {
                if !already_surfaced.contains(&id) {
                    results.push(id);
                }
            }
            Err(_) => continue,
        }
        if results.len() >= limit {
            return Ok(results);
        }
    }

    if !results.is_empty() {
        return Ok(results);
    }

    // Fallback: LIKE search for substring matches FTS5 might miss
    let pattern = format!("%{}%", fts_expr);
    let like_sql = "SELECT id FROM memory
                    WHERE status = 'active'
                      AND (title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?)
                    LIMIT ?";

    let mut stmt = conn
        .prepare(like_sql)
        .map_err(|e| format!("LIKE query failed: {}", e))?;

    let rows = stmt
        .query_map(
            [
                &pattern,
                &pattern,
                &pattern,
                &pattern,
                &(limit * 3).to_string(),
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("LIKE row mapping failed: {}", e))?;

    for row in rows {
        match row {
            Ok(id) => {
                if !already_surfaced.contains(&id) {
                    results.push(id);
                }
            }
            Err(_) => continue,
        }
        if results.len() >= limit {
            break;
        }
    }

    Ok(results)
}
