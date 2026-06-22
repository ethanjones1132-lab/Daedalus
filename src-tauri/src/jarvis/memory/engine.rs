use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const RECALL_LIMIT: usize = 5;
const RECALL_CANDIDATE_LIMIT: usize = 30;
const MAX_MEMORY_CONTENT_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub tags: String,
    pub category: String,
    pub created_at: String,
    pub updated_at: String,
    pub relevance_score: f64,
    pub agent_id: String,
    pub source: String,
    pub source_session_id: Option<String>,
    pub source_message_ids: String,
    pub confidence: f64,
    pub last_used_at: Option<String>,
    pub usage_count: i64,
    pub expires_at: Option<String>,
    pub review_after: Option<String>,
    pub status: String,
    pub supersedes_id: Option<String>,
    pub metadata: Option<String>,
    // v3.1 — Drive Brain: tiered storage
    pub tier: String,                  // "hot" | "warm" | "cold"
    pub drive_file_id: Option<String>, // Google Drive file ID when archived
    pub summary: String,               // Lightweight summary for warm/cold tiers
    pub archived_at: Option<String>,   // When this was archived to Drive
    // v3.1 — P1: integer epoch millis for fast recency scoring (avoids RFC3339 parsing per candidate)
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecall {
    pub memory: MemoryEntry,
    pub score: f64,
    pub matched_terms: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEvent {
    pub id: String,
    pub memory_id: Option<String>,
    pub event_type: String,
    pub actor: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub reason: String,
    pub confidence: f64,
    pub session_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRun {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub scanned_count: i64,
    pub changed_count: i64,
    pub blocked_count: i64,
    pub error: String,
    pub metadata: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMemory {
    pub session_id: String,
    pub summary: String,
    pub current_goal: String,
    pub decisions: String,
    pub next_steps: String,
    pub last_message_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRevision {
    pub id: String,
    pub skill_id: String,
    pub version: i64,
    pub body_before: String,
    pub body_after: String,
    pub change_reason: String,
    pub source_session_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct MemoryWrite {
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub category: String,
    pub source: String,
    pub source_session_id: Option<String>,
    pub source_message_ids: Vec<String>,
    pub confidence: f64,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
struct SafetyBlock {
    reason: String,
}

pub fn list_memories(conn: &Connection) -> Result<Vec<MemoryEntry>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM memory ORDER BY status ASC, updated_at DESC",
            memory_columns()
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], memory_from_row)
        .map_err(|e| e.to_string())?;
    collect_memories(rows)
}

pub fn read_memory(conn: &Connection, id: &str) -> Result<MemoryEntry, String> {
    conn.query_row(
        &format!("SELECT {} FROM memory WHERE id = ?", memory_columns()),
        [id],
        memory_from_row,
    )
    .map_err(|e| format!("Memory not found: {}", e))
}

pub fn save_manual_memory(
    conn: &Connection,
    title: String,
    content: String,
    tags: Vec<String>,
    category: String,
) -> Result<MemoryEntry, String> {
    create_or_merge_memory(
        conn,
        MemoryWrite {
            title,
            content,
            tags,
            category,
            source: "manual".to_string(),
            source_session_id: None,
            source_message_ids: vec![],
            confidence: 0.9,
            metadata: json!({"source": "manual"}),
        },
        "user",
        "Manual memory save",
    )
}

pub fn update_manual_memory(
    conn: &Connection,
    id: String,
    title: String,
    content: String,
    tags: Vec<String>,
    category: String,
) -> Result<MemoryEntry, String> {
    validate_memory_payload(&title, &content, &category).map_err(|b| b.reason)?;
    let before = read_memory(conn, &id)?;
    let now = now();
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "UPDATE memory
         SET title = ?, content = ?, tags = ?, category = ?, updated_at = ?,
             relevance_score = 0.0, confidence = MAX(confidence, 0.9), status = 'active'
         WHERE id = ?",
        params![&title, &content, &tags_json, &category, &now, &id],
    )
    .map_err(|e| format!("Failed to update memory: {}", e))?;
    let after = read_memory(conn, &id)?;
    write_memory_event(
        conn,
        Some(&id),
        "update",
        "user",
        Some(json!(before)),
        Some(json!(after.clone())),
        "Manual memory update",
        after.confidence,
        None,
    )?;
    Ok(after)
}

pub fn tombstone_memory(
    conn: &Connection,
    id: &str,
    actor: &str,
    reason: &str,
    session_id: Option<&str>,
    supersedes_id: Option<&str>,
) -> Result<bool, String> {
    let before = match read_memory(conn, id) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    let now = now();
    conn.execute(
        "UPDATE memory
         SET status = 'tombstoned', updated_at = ?, supersedes_id = COALESCE(?, supersedes_id)
         WHERE id = ?",
        params![&now, supersedes_id, id],
    )
    .map_err(|e| format!("Failed to tombstone memory: {}", e))?;
    let after = read_memory(conn, id)?;
    write_memory_event(
        conn,
        Some(id),
        "tombstone",
        actor,
        Some(json!(before)),
        Some(json!(after)),
        reason,
        1.0,
        session_id,
    )?;
    Ok(true)
}

pub fn restore_memory(conn: &Connection, id: &str) -> Result<bool, String> {
    let before = match read_memory(conn, id) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    let now = now();
    conn.execute(
        "UPDATE memory SET status = 'active', updated_at = ?, supersedes_id = NULL WHERE id = ?",
        params![&now, id],
    )
    .map_err(|e| format!("Failed to restore memory: {}", e))?;
    let after = read_memory(conn, id)?;
    write_memory_event(
        conn,
        Some(id),
        "restore",
        "user",
        Some(json!(before)),
        Some(json!(after)),
        "Manual memory restore",
        1.0,
        None,
    )?;
    Ok(true)
}

pub fn search_memories(conn: &Connection, query: &str) -> Result<Vec<MemoryEntry>, String> {
    // Try FTS5 first for better relevance, fall back to LIKE for substring matches
    let fts_results = fts_candidates(conn, query).unwrap_or_default();
    if !fts_results.is_empty() {
        let mut results: Vec<_> = fts_results
            .into_iter()
            .filter(|m| m.status == "active")
            .collect();
        results.truncate(20);
        return Ok(results);
    }
    // Fallback: LIKE search for substring matches FTS5 might miss
    let pattern = format!("%{}%", query.trim());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM memory
             WHERE status = 'active'
               AND (title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?)
             ORDER BY updated_at DESC
             LIMIT 20",
            memory_columns()
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![&pattern, &pattern, &pattern, &pattern],
            memory_from_row,
        )
        .map_err(|e| e.to_string())?;
    collect_memories(rows)
}

pub fn recall_memories(
    conn: &Connection,
    query: &str,
    limit: usize,
    mark_used: bool,
) -> Result<Vec<MemoryRecall>, String> {
    let terms = query_terms(query);
    let mut candidates = fts_candidates(conn, query).unwrap_or_default();
    if candidates.is_empty() {
        candidates = like_candidates(conn, query)?;
    }

    let mut recalls: Vec<MemoryRecall> = candidates
        .into_iter()
        .filter(|m| m.status == "active")
        .map(|memory| {
            let (score, matched_terms) = score_memory(&memory, &terms);
            MemoryRecall {
                memory,
                score,
                matched_terms,
            }
        })
        .filter(|r| query.trim().is_empty() || r.score > 0.05)
        .collect();

    recalls.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    recalls.truncate(limit.max(1).min(RECALL_LIMIT));

    if mark_used {
        let ts = now();
        for recall in &recalls {
            conn.execute(
                "UPDATE memory
                 SET last_used_at = ?, usage_count = usage_count + 1,
                     relevance_score = MAX(relevance_score, ?)
                 WHERE id = ?",
                params![&ts, recall.score, &recall.memory.id],
            )
            .map_err(|e| format!("Failed to mark memory recall: {}", e))?;
            write_memory_event(
                conn,
                Some(&recall.memory.id),
                "recall",
                "memory_engine",
                None,
                Some(json!({
                    "query": truncate(query, 240),
                    "score": recall.score,
                    "matched_terms": recall.matched_terms,
                })),
                "Pre-turn memory recall",
                recall.score,
                None,
            )?;
        }
    }

    Ok(recalls)
}

pub fn build_turn_memory_context(
    conn: &Connection,
    session_id: &str,
    query: &str,
) -> Result<Option<String>, String> {
    // v3.1 — Drive Brain: only load hot + warm memories into context
    // Cold memories require explicit recall_cold_memory() call
    let recalls = recall_memories(conn, query, RECALL_LIMIT, true)?;
    // Filter out cold tier from auto-recall
    let recalls: Vec<_> = recalls
        .into_iter()
        .filter(|r| r.memory.tier != "cold")
        .collect();
    let session_memory = get_session_memory(conn, session_id)?;
    let prompt_deltas = active_prompt_deltas(conn)?;

    if recalls.is_empty() && session_memory.is_none() && prompt_deltas.is_empty() {
        return Ok(None);
    }

    // Context budget: max ~4000 chars for memory context section
    // Prioritize by score, truncate lowest-scoring items first
    const CONTEXT_BUDGET: usize = 4000;
    const PROMPT_DELTA_BUDGET: usize = 1200;
    const SESSION_MEMORY_BUDGET: usize = 1200;
    const MEMORY_ITEM_BUDGET: usize = 600;

    let mut lines = vec![
        "Jarvis Memory Context".to_string(),
        "Use this as durable background context. Treat stale project/reference facts as hints to verify against the current workspace before acting.".to_string(),
    ];

    // Prompt deltas first (highest priority — active self-improvements)
    if !prompt_deltas.is_empty() {
        lines.push("\nSelf-improvement prompt deltas:".to_string());
        let mut delta_chars = 0;
        for delta in &prompt_deltas {
            if delta_chars >= PROMPT_DELTA_BUDGET {
                break;
            }
            let truncated = truncate(delta, 300);
            lines.push(format!("- {}", truncated));
            delta_chars += truncated.len() + 2;
        }
    }

    // Session memory (medium priority)
    if let Some(sm) = session_memory {
        lines.push("\nCurrent session memory:".to_string());
        let mut session_chars = 0;
        if !sm.current_goal.trim().is_empty() {
            let entry = format!("- Goal: {}", truncate(&sm.current_goal, 200));
            session_chars += entry.len();
            lines.push(entry);
        }
        if !sm.summary.trim().is_empty() {
            let budget = SESSION_MEMORY_BUDGET.saturating_sub(session_chars);
            if budget > 50 {
                let entry = format!("- Summary: {}", truncate(&sm.summary, budget));
                session_chars += entry.len();
                lines.push(entry);
            }
        }
        if sm.decisions != "[]" && session_chars < SESSION_MEMORY_BUDGET {
            let budget = SESSION_MEMORY_BUDGET.saturating_sub(session_chars);
            if budget > 50 {
                lines.push(format!("- Decisions: {}", truncate(&sm.decisions, budget)));
            }
        }
        if sm.next_steps != "[]" && session_chars < SESSION_MEMORY_BUDGET {
            let budget = SESSION_MEMORY_BUDGET.saturating_sub(session_chars);
            if budget > 50 {
                lines.push(format!(
                    "- Next steps: {}",
                    truncate(&sm.next_steps, budget)
                ));
            }
        }
    }

    // Durable memories (scored, budget-aware)
    if !recalls.is_empty() {
        lines.push("\nRelevant durable memories:".to_string());
        let mut memory_chars = 0;
        for recall in &recalls {
            if memory_chars >= CONTEXT_BUDGET {
                break;
            }
            let memory = &recall.memory;
            // Use summary for warm tier, full content for hot
            let content = if memory.tier == "warm" {
                if memory.summary.is_empty() {
                    truncate(&memory.content, 150)
                } else {
                    memory.summary.clone()
                }
            } else {
                truncate(&memory.content, MEMORY_ITEM_BUDGET)
            };
            let entry = format!(
                "- id={} category={} confidence={:.2} updated={} score={:.2}: {} - {}",
                memory.id,
                memory.category,
                memory.confidence,
                memory.updated_at,
                recall.score,
                memory.title,
                content
            );
            memory_chars += entry.len() + 1;
            lines.push(entry);
        }
    }

    Ok(Some(lines.join("\n")))
}

pub fn run_post_turn_housekeeping(
    conn: &Connection,
    session_id: &str,
    user_message: &str,
    assistant_text: &str,
) -> Result<MemoryRun, String> {
    let run_id = start_run(conn, "post_turn")?;
    let mut scanned_count = 2;
    let mut changed_count = 0;
    let mut blocked_count = 0;

    let result = (|| -> Result<(), String> {
        changed_count += handle_forget_requests(conn, session_id, user_message)?;
        let (changed, blocked) = handle_memory_extraction(conn, session_id, user_message)?;
        changed_count += changed;
        blocked_count += blocked;

        update_session_memory_from_turn(conn, session_id, user_message, assistant_text)?;
        changed_count += 1;

        let (skill_changed, skill_blocked) =
            maybe_apply_skill_improvement(conn, session_id, user_message)?;
        changed_count += skill_changed;
        blocked_count += skill_blocked;

        let maybe_changed = maybe_run_light_consolidation(conn)?;
        changed_count += maybe_changed;
        scanned_count += 1;

        // v3.1 — Drive Brain: age memories between tiers
        let (hot_to_warm, warm_to_cold) = run_tier_management(conn)?;
        changed_count += hot_to_warm + warm_to_cold;
        scanned_count += hot_to_warm + warm_to_cold;

        // v3.1 — Prune old events if table exceeds 1000 rows
        prune_old_events(conn)?;

        Ok(())
    })();

    match result {
        Ok(()) => finish_run(
            conn,
            &run_id,
            "success",
            scanned_count,
            changed_count,
            blocked_count,
            "",
        ),
        Err(err) => finish_run(
            conn,
            &run_id,
            "failed",
            scanned_count,
            changed_count,
            blocked_count,
            &err,
        ),
    }
}

pub fn consolidate_memories(conn: &Connection) -> Result<MemoryRun, String> {
    let run_id = start_run(conn, "consolidation")?;
    let result = (|| -> Result<(i64, i64), String> {
        let memories = active_memories(conn)?;
        let scanned_count = memories.len() as i64;

        // Early exit: nothing to consolidate
        if memories.len() <= 1 {
            return Ok((scanned_count, 0));
        }

        let mut changed_count = 0;
        let mut seen: Vec<MemoryEntry> = Vec::new();

        for memory in memories {
            if let Some(existing) = seen
                .iter()
                .find(|m| memories_are_duplicates(m, &memory))
                .cloned()
            {
                let reason = format!("Consolidated duplicate memory into {}", existing.id);
                if tombstone_memory(
                    conn,
                    &memory.id,
                    "auto_dream",
                    &reason,
                    memory.source_session_id.as_deref(),
                    Some(&existing.id),
                )? {
                    changed_count += 1;
                }
                continue;
            }

            if memory.review_after.is_none() {
                let review_after = default_review_after(&memory.category);
                conn.execute(
                    "UPDATE memory SET review_after = ?, updated_at = ? WHERE id = ?",
                    params![&review_after, &now(), &memory.id],
                )
                .map_err(|e| format!("Failed to set review date: {}", e))?;
                changed_count += 1;
            }
            seen.push(memory);
        }

        Ok((scanned_count, changed_count))
    })();

    match result {
        Ok((scanned_count, changed_count)) => finish_run(
            conn,
            &run_id,
            "success",
            scanned_count,
            changed_count,
            0,
            "",
        ),
        Err(err) => finish_run(conn, &run_id, "failed", 0, 0, 0, &err),
    }
}

pub fn update_session_memory_from_messages(
    conn: &Connection,
    session_id: &str,
    messages: &[(String, String)],
    compacted_summary: Option<&str>,
) -> Result<(), String> {
    let last_user = messages
        .iter()
        .rev()
        .find(|(role, _)| role == "user")
        .map(|(_, content)| truncate(content, 240))
        .unwrap_or_default();
    let last_assistant = messages
        .iter()
        .rev()
        .find(|(role, _)| role == "assistant")
        .map(|(_, content)| truncate(content, 360))
        .unwrap_or_default();
    let summary = compacted_summary
        .map(|s| truncate(s, 1800))
        .unwrap_or_else(|| {
            format!(
                "Recent exchange: user asked '{}'; assistant answered '{}'.",
                last_user, last_assistant
            )
        });
    upsert_session_memory(conn, session_id, &summary, &last_user, vec![], vec![])
}

pub fn list_memory_events(
    conn: &Connection,
    memory_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemoryEvent>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let sql = if memory_id.is_some() {
        "SELECT id, memory_id, event_type, actor, before_json, after_json, reason, confidence, session_id, created_at
         FROM memory_events WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?"
    } else {
        "SELECT id, memory_id, event_type, actor, before_json, after_json, reason, confidence, session_id, created_at
         FROM memory_events ORDER BY created_at DESC LIMIT ?"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = if let Some(id) = memory_id {
        stmt.query_map(params![id, limit], memory_event_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(params![limit], memory_event_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}

pub fn list_memory_runs(
    conn: &Connection,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemoryRun>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let sql = if kind.is_some() {
        "SELECT id, kind, status, scanned_count, changed_count, blocked_count, error, metadata, started_at, finished_at
         FROM memory_runs WHERE kind = ? ORDER BY started_at DESC LIMIT ?"
    } else {
        "SELECT id, kind, status, scanned_count, changed_count, blocked_count, error, metadata, started_at, finished_at
         FROM memory_runs ORDER BY started_at DESC LIMIT ?"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = if let Some(kind) = kind {
        stmt.query_map(params![kind, limit], memory_run_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(params![limit], memory_run_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}

pub fn list_skill_revisions(
    conn: &Connection,
    skill_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SkillRevision>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let sql = if skill_id.is_some() {
        "SELECT id, skill_id, version, body_before, body_after, change_reason, source_session_id, created_at
         FROM skill_revisions WHERE skill_id = ? ORDER BY created_at DESC LIMIT ?"
    } else {
        "SELECT id, skill_id, version, body_before, body_after, change_reason, source_session_id, created_at
         FROM skill_revisions ORDER BY created_at DESC LIMIT ?"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = if let Some(skill_id) = skill_id {
        stmt.query_map(params![skill_id, limit], skill_revision_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map(params![limit], skill_revision_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}

pub fn restore_skill_revision(conn: &Connection, revision_id: &str) -> Result<bool, String> {
    let revision = conn
        .query_row(
            "SELECT id, skill_id, version, body_before, body_after, change_reason, source_session_id, created_at
             FROM skill_revisions WHERE id = ?",
            [revision_id],
            skill_revision_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(revision) = revision else {
        return Ok(false);
    };

    let now = now();
    let current: Option<(String, i64)> = conn
        .query_row(
            "SELECT body, version FROM skills WHERE id = ?",
            [&revision.skill_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((current_body, current_version)) = current else {
        return Ok(false);
    };

    let new_version = current_version + 1;
    conn.execute(
        "INSERT INTO skill_revisions
         (id, skill_id, version, body_before, body_after, change_reason, source_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
        params![
            uuid::Uuid::new_v4().to_string(),
            &revision.skill_id,
            new_version,
            current_body,
            &revision.body_before,
            format!("Rollback to revision {}", revision.id),
            &now,
        ],
    )
    .map_err(|e| format!("Failed to record skill rollback: {}", e))?;
    conn.execute(
        "UPDATE skills
         SET body = ?, version = ?, updated_at = ?, last_improved_at = ?
         WHERE id = ?",
        params![
            &revision.body_before,
            new_version,
            &now,
            &now,
            &revision.skill_id
        ],
    )
    .map_err(|e| format!("Failed to restore skill revision: {}", e))?;
    Ok(true)
}

pub(crate) fn create_or_merge_memory(
    conn: &Connection,
    write: MemoryWrite,
    actor: &str,
    reason: &str,
) -> Result<MemoryEntry, String> {
    if let Err(block) = validate_memory_payload(&write.title, &write.content, &write.category) {
        write_memory_event(
            conn,
            None,
            "blocked",
            actor,
            None,
            Some(json!({
                "title": write.title,
                "category": write.category,
                "reason": block.reason,
            })),
            "Blocked unsafe memory write",
            0.0,
            write.source_session_id.as_deref(),
        )?;
        return Err(block.reason);
    }

    if let Some(existing) =
        find_similar_memory(conn, &write.title, &write.content, &write.category)?
    {
        let mut merged = existing.content.clone();
        if !merged
            .to_lowercase()
            .contains(&write.content.to_lowercase())
        {
            merged.push_str("\n\nUpdate ");
            merged.push_str(&Utc::now().format("%Y-%m-%d").to_string());
            merged.push_str(": ");
            merged.push_str(&write.content);
        }
        let mut tags = parse_tags(&existing.tags);
        for tag in &write.tags {
            if !tags.iter().any(|t| t == tag) {
                tags.push(tag.clone());
            }
        }
        let before = existing.clone();
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        let now = now();
        conn.execute(
            "UPDATE memory
             SET content = ?, tags = ?, confidence = MAX(confidence, ?), updated_at = ?, status = 'active'
             WHERE id = ?",
            params![&merged, &tags_json, write.confidence, &now, &existing.id],
        )
        .map_err(|e| format!("Failed to merge memory: {}", e))?;
        let after = read_memory(conn, &existing.id)?;
        write_memory_event(
            conn,
            Some(&existing.id),
            "merge",
            actor,
            Some(json!(before)),
            Some(json!(after.clone())),
            reason,
            after.confidence,
            write.source_session_id.as_deref(),
        )?;
        return Ok(after);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now();
    let tags_json = serde_json::to_string(&write.tags).unwrap_or_else(|_| "[]".to_string());
    let source_message_ids =
        serde_json::to_string(&write.source_message_ids).unwrap_or_else(|_| "[]".to_string());
    let metadata = serde_json::to_string(&write.metadata).ok();
    let review_after = default_review_after(&write.category);
    conn.execute(
        "INSERT INTO memory
         (id, title, content, tags, category, relevance_score, created_at, updated_at,
          agent_id, source, source_session_id, source_message_ids, confidence, last_used_at,
          usage_count, expires_at, review_after, status, supersedes_id, metadata)
         VALUES (?, ?, ?, ?, ?, 0.0, ?, ?, 'jarvis', ?, ?, ?, ?, NULL, 0, NULL, ?, 'active', NULL, ?)",
        params![
            &id,
            &write.title,
            &write.content,
            &tags_json,
            &write.category,
            &now,
            &now,
            &write.source,
            &write.source_session_id,
            &source_message_ids,
            write.confidence,
            &review_after,
            &metadata,
        ],
    )
    .map_err(|e| format!("Failed to create memory: {}", e))?;
    let memory = read_memory(conn, &id)?;
    write_memory_event(
        conn,
        Some(&id),
        "create",
        actor,
        None,
        Some(json!(memory.clone())),
        reason,
        memory.confidence,
        write.source_session_id.as_deref(),
    )?;
    Ok(memory)
}

fn handle_forget_requests(
    conn: &Connection,
    session_id: &str,
    user_message: &str,
) -> Result<i64, String> {
    let Some(target) = extract_marker_payload(
        user_message,
        &[
            "forget that",
            "forget this",
            "forget:",
            "please forget",
            "remove memory",
        ],
    ) else {
        return Ok(0);
    };
    let recalls = recall_memories(conn, &target, 3, false)?;
    let mut changed = 0;
    for recall in recalls.into_iter().filter(|r| r.score > 0.12).take(3) {
        if tombstone_memory(
            conn,
            &recall.memory.id,
            "memory_engine",
            &format!("User requested forgetting: {}", truncate(&target, 180)),
            Some(session_id),
            None,
        )? {
            changed += 1;
        }
    }
    Ok(changed)
}

fn handle_memory_extraction(
    conn: &Connection,
    session_id: &str,
    user_message: &str,
) -> Result<(i64, i64), String> {
    let mut changed = 0;
    let mut blocked = 0;

    let explicit = extract_marker_payload(
        user_message,
        &[
            "remember that",
            "remember this:",
            "remember this",
            "remember:",
            "please remember",
            "save this memory:",
        ],
    );
    if let Some(content) = explicit {
        match create_or_merge_memory(
            conn,
            MemoryWrite {
                title: title_from_content(&content),
                content,
                tags: vec!["auto".to_string(), "explicit".to_string()],
                category: "user".to_string(),
                source: "explicit".to_string(),
                source_session_id: Some(session_id.to_string()),
                source_message_ids: vec![],
                confidence: 0.98,
                metadata: json!({"extractor": "deterministic", "kind": "explicit"}),
            },
            "memory_engine",
            "Explicit user remember request",
        ) {
            Ok(_) => changed += 1,
            Err(_) => blocked += 1,
        }
    }

    if looks_like_reusable_feedback(user_message) {
        let category = if looks_project_scoped(user_message) {
            "project"
        } else {
            "feedback"
        };
        match create_or_merge_memory(
            conn,
            MemoryWrite {
                title: title_from_content(user_message),
                content: truncate(user_message, 1200),
                tags: vec!["auto".to_string(), "preference".to_string()],
                category: category.to_string(),
                source: "auto_extract".to_string(),
                source_session_id: Some(session_id.to_string()),
                source_message_ids: vec![],
                confidence: 0.78,
                metadata: json!({"extractor": "deterministic", "kind": "feedback"}),
            },
            "memory_engine",
            "Detected reusable user preference or correction",
        ) {
            Ok(_) => changed += 1,
            Err(_) => blocked += 1,
        }
    }

    Ok((changed, blocked))
}

fn maybe_apply_skill_improvement(
    conn: &Connection,
    session_id: &str,
    user_message: &str,
) -> Result<(i64, i64), String> {
    if !looks_like_reusable_feedback(user_message) {
        return Ok((0, 0));
    }

    let user_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user'",
            [session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let immediate = user_message.to_lowercase().contains("always")
        || user_message.to_lowercase().contains("from now on")
        || user_message.to_lowercase().contains("when i ask")
        || user_message.to_lowercase().contains("do not")
        || user_message.to_lowercase().contains("don't");
    if !immediate && user_count % 5 != 0 {
        return Ok((0, 0));
    }

    let skill_name = if user_message.to_lowercase().contains("remember")
        || user_message.to_lowercase().contains("memory")
    {
        "remember"
    } else {
        "jarvis-collaboration"
    };
    ensure_skill(conn, skill_name)?;
    let change = format!("- {}", truncate(user_message.trim(), 500));
    if validate_skill_change(&change).is_err() {
        write_memory_event(
            conn,
            None,
            "blocked_skill_improvement",
            "skill_improver",
            None,
            Some(json!({"skill": skill_name, "change": change})),
            "Blocked unsafe skill improvement",
            0.0,
            Some(session_id),
        )?;
        return Ok((0, 1));
    }
    let changed = apply_skill_improvement(
        conn,
        skill_name,
        &change,
        "Automatic reusable preference/process improvement",
        Some(session_id),
    )?;
    Ok((changed as i64, 0))
}

fn apply_skill_improvement(
    conn: &Connection,
    skill_name: &str,
    change: &str,
    reason: &str,
    source_session_id: Option<&str>,
) -> Result<bool, String> {
    let row: Option<(String, String, String, i64)> = conn
        .query_row(
            "SELECT id, description, body, version FROM skills WHERE name = ?",
            [skill_name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((skill_id, description, body, version)) = row else {
        return Ok(false);
    };
    if body.contains(change) {
        return Ok(false);
    }

    let base = if body.trim().is_empty() {
        format!("# {}\n\n{}\n", skill_name, description)
    } else {
        body.clone()
    };
    let next_body = if base.contains("## Auto Improvements") {
        format!("{}\n{}", base.trim_end(), change)
    } else {
        format!("{}\n\n## Auto Improvements\n{}", base.trim_end(), change)
    };
    let next_version = version + 1;
    let now = now();

    conn.execute(
        "INSERT INTO skill_revisions
         (id, skill_id, version, body_before, body_after, change_reason, source_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            uuid::Uuid::new_v4().to_string(),
            &skill_id,
            next_version,
            &body,
            &next_body,
            reason,
            source_session_id,
            &now,
        ],
    )
    .map_err(|e| format!("Failed to save skill revision: {}", e))?;
    conn.execute(
        "UPDATE skills
         SET body = ?, version = ?, updated_at = ?, last_improved_at = ?,
             improvement_score = improvement_score + 1.0
         WHERE id = ?",
        params![&next_body, next_version, &now, &now, &skill_id],
    )
    .map_err(|e| format!("Failed to update skill: {}", e))?;
    write_memory_event(
        conn,
        None,
        "skill_improvement",
        "skill_improver",
        Some(json!({"skill": skill_name, "version": version})),
        Some(json!({"skill": skill_name, "version": next_version, "change": change})),
        reason,
        0.8,
        source_session_id,
    )?;
    Ok(true)
}

fn update_session_memory_from_turn(
    conn: &Connection,
    session_id: &str,
    user_message: &str,
    assistant_text: &str,
) -> Result<(), String> {
    let existing = get_session_memory(conn, session_id)?;
    let mut bullets = existing
        .as_ref()
        .map(|m| m.summary.lines().map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_default();
    bullets.push(format!(
        "- {} user: {}; assistant: {}",
        Utc::now().format("%Y-%m-%d %H:%M"),
        truncate(user_message, 220),
        truncate(assistant_text, 280)
    ));
    // Keep last 12 bullets, but also enforce a total size cap (5000 chars)
    // to prevent unbounded growth in long sessions
    if bullets.len() > 12 {
        bullets = bullets[bullets.len() - 12..].to_vec();
    }
    // Additional size cap: if total exceeds 5000 chars, trim oldest bullets
    let mut summary = bullets.join("\n");
    while summary.len() > 5000 && bullets.len() > 1 {
        bullets.remove(0);
        summary = bullets.join("\n");
    }
    let current_goal = truncate(user_message, 260);
    let decisions = if contains_any(
        user_message,
        &["decided", "decision", "we will", "let's use"],
    ) {
        vec![truncate(user_message, 240)]
    } else {
        vec![]
    };
    let next_steps = if assistant_text.to_lowercase().contains("next") {
        vec![truncate(assistant_text, 240)]
    } else {
        vec![]
    };
    upsert_session_memory(
        conn,
        session_id,
        &summary,
        &current_goal,
        decisions,
        next_steps,
    )
}

fn upsert_session_memory(
    conn: &Connection,
    session_id: &str,
    summary: &str,
    current_goal: &str,
    decisions: Vec<String>,
    next_steps: Vec<String>,
) -> Result<(), String> {
    let now = now();
    let decisions_json = serde_json::to_string(&decisions).unwrap_or_else(|_| "[]".to_string());
    let next_steps_json = serde_json::to_string(&next_steps).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO session_memory
         (session_id, summary, current_goal, decisions, next_steps, last_message_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
             summary = excluded.summary,
             current_goal = excluded.current_goal,
             decisions = CASE WHEN excluded.decisions != '[]' THEN excluded.decisions ELSE session_memory.decisions END,
             next_steps = CASE WHEN excluded.next_steps != '[]' THEN excluded.next_steps ELSE session_memory.next_steps END,
             last_message_at = excluded.last_message_at,
             updated_at = excluded.updated_at",
        params![
            session_id,
            summary,
            current_goal,
            &decisions_json,
            &next_steps_json,
            &now,
            &now,
        ],
    )
    .map_err(|e| format!("Failed to update session memory: {}", e))?;
    Ok(())
}

fn maybe_run_light_consolidation(conn: &Connection) -> Result<i64, String> {
    let latest: Option<String> = conn
        .query_row(
            "SELECT finished_at FROM memory_runs
             WHERE kind = 'consolidation' AND status = 'success'
             ORDER BY finished_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(ts) = latest {
        if let Ok(dt) = DateTime::parse_from_rfc3339(&ts) {
            if Utc::now()
                .signed_duration_since(dt.with_timezone(&Utc))
                .num_hours()
                < 24
            {
                return Ok(0);
            }
        }
    }
    Ok(consolidate_memories(conn)?.changed_count)
}

fn start_run(conn: &Connection, kind: &str) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO memory_runs
         (id, kind, status, scanned_count, changed_count, blocked_count, started_at)
         VALUES (?, ?, 'running', 0, 0, 0, ?)",
        params![&id, kind, &now()],
    )
    .map_err(|e| format!("Failed to start memory run: {}", e))?;
    Ok(id)
}

fn finish_run(
    conn: &Connection,
    id: &str,
    status: &str,
    scanned_count: i64,
    changed_count: i64,
    blocked_count: i64,
    error: &str,
) -> Result<MemoryRun, String> {
    let finished_at = now();
    conn.execute(
        "UPDATE memory_runs
         SET status = ?, scanned_count = ?, changed_count = ?, blocked_count = ?,
             error = ?, finished_at = ?
         WHERE id = ?",
        params![
            status,
            scanned_count,
            changed_count,
            blocked_count,
            error,
            &finished_at,
            id,
        ],
    )
    .map_err(|e| format!("Failed to finish memory run: {}", e))?;
    conn.query_row(
        "SELECT id, kind, status, scanned_count, changed_count, blocked_count, error, metadata, started_at, finished_at
         FROM memory_runs WHERE id = ?",
        [id],
        memory_run_from_row,
    )
    .map_err(|e| e.to_string())
}

fn write_memory_event(
    conn: &Connection,
    memory_id: Option<&str>,
    event_type: &str,
    actor: &str,
    before_json: Option<Value>,
    after_json: Option<Value>,
    reason: &str,
    confidence: f64,
    session_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO memory_events
         (id, memory_id, event_type, actor, before_json, after_json, reason, confidence, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            uuid::Uuid::new_v4().to_string(),
            memory_id,
            event_type,
            actor,
            before_json.map(|v| v.to_string()),
            after_json.map(|v| v.to_string()),
            reason,
            confidence,
            session_id,
            now(),
        ],
    )
    .map_err(|e| format!("Failed to write memory event: {}", e))?;
    Ok(())
}

fn fts_candidates(conn: &Connection, query: &str) -> Result<Vec<MemoryEntry>, String> {
    let Some(expr) = fts_expr(query) else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM memory_fts f
             JOIN memory m ON m.id = f.id
             WHERE memory_fts MATCH ? AND m.status = 'active'
             LIMIT ?",
            prefixed_memory_columns("m")
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![expr, RECALL_CANDIDATE_LIMIT as i64],
            memory_from_row,
        )
        .map_err(|e| e.to_string())?;
    collect_memories(rows)
}

fn like_candidates(conn: &Connection, query: &str) -> Result<Vec<MemoryEntry>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let pattern = format!("%{}%", query.trim());
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM memory
             WHERE status = 'active'
               AND (title LIKE ? OR content LIKE ? OR tags LIKE ? OR category LIKE ?)
             ORDER BY updated_at DESC
             LIMIT ?",
            memory_columns()
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![
                &pattern,
                &pattern,
                &pattern,
                &pattern,
                RECALL_CANDIDATE_LIMIT as i64
            ],
            memory_from_row,
        )
        .map_err(|e| e.to_string())?;
    collect_memories(rows)
}

fn active_memories(conn: &Connection) -> Result<Vec<MemoryEntry>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM memory WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?",
            memory_columns()
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([RECALL_CANDIDATE_LIMIT as i64], memory_from_row)
        .map_err(|e| e.to_string())?;
    collect_memories(rows)
}

fn find_similar_memory(
    conn: &Connection,
    title: &str,
    content: &str,
    category: &str,
) -> Result<Option<MemoryEntry>, String> {
    // Fast path: use FTS5 for merge detection instead of LIKE scan
    let candidates = fts_candidates(conn, title).unwrap_or_default();
    let candidates = if candidates.is_empty() {
        like_candidates(conn, title)?
    } else {
        candidates
    };
    let normalized_title = normalize_key(title);
    let normalized_content = normalize_key(&truncate(content, 160));
    Ok(candidates.into_iter().find(|m| {
        m.category == category
            && (normalize_key(&m.title) == normalized_title
                || normalize_key(&truncate(&m.content, 160)) == normalized_content)
    }))
}

fn get_session_memory(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionMemory>, String> {
    conn.query_row(
        "SELECT session_id, summary, current_goal, decisions, next_steps, last_message_at, updated_at
         FROM session_memory WHERE session_id = ?",
        [session_id],
        |row| {
            Ok(SessionMemory {
                session_id: row.get(0)?,
                summary: row.get(1)?,
                current_goal: row.get(2)?,
                decisions: row.get(3)?,
                next_steps: row.get(4)?,
                last_message_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn active_prompt_deltas(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT content FROM prompt_deltas
             WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 5",
        )
        .map_err(|e| e.to_string())?;
    let collected: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(collected)
}

fn validate_memory_payload(title: &str, content: &str, category: &str) -> Result<(), SafetyBlock> {
    let allowed = ["general", "user", "feedback", "project", "reference"];
    if !allowed.contains(&category) {
        return Err(SafetyBlock {
            reason: format!("Unsupported memory category '{}'", category),
        });
    }
    if title.trim().is_empty() || content.trim().is_empty() {
        return Err(SafetyBlock {
            reason: "Memory title and content are required".to_string(),
        });
    }
    if content.len() > MAX_MEMORY_CONTENT_BYTES {
        return Err(SafetyBlock {
            reason: "Memory content exceeds safe durable-memory size limit".to_string(),
        });
    }

    let text = format!("{} {}", title, content).to_lowercase();
    let secret_markers = [
        "api_key",
        "apikey",
        "secret_key",
        "access_token",
        "refresh_token",
        "authorization: bearer",
        "password=",
        "password:",
        "private key",
        "-----begin",
        "ghp_",
        "xoxb-",
        "sk-",
    ];
    if contains_any(&text, &secret_markers) {
        return Err(SafetyBlock {
            reason: "Blocked possible secret or credential".to_string(),
        });
    }
    let role_markers = text.matches("\nuser:").count()
        + text.matches("\nassistant:").count()
        + text.matches("[user]").count()
        + text.matches("[assistant]").count();
    if role_markers >= 3 {
        return Err(SafetyBlock {
            reason: "Blocked raw transcript-style memory".to_string(),
        });
    }
    Ok(())
}

fn validate_skill_change(change: &str) -> Result<(), SafetyBlock> {
    validate_memory_payload("skill improvement", change, "feedback")
}

fn score_memory(memory: &MemoryEntry, terms: &[String]) -> (f64, Vec<String>) {
    // Fast path: score fields separately, short-circuit on title match
    let title_lower = memory.title.to_lowercase();
    let tags_lower = memory.tags.to_lowercase();
    let category_lower = memory.category.to_lowercase();

    let mut matched = Vec::new();
    let mut title_hits = 0u32;
    let mut body_hits = 0u32;

    for term in terms {
        if title_lower.contains(term) {
            title_hits += 1;
            matched.push(term.clone());
        } else if tags_lower.contains(term) || category_lower.contains(term) {
            body_hits += 1;
            matched.push(term.clone());
        } else if memory.content.len() < MAX_MEMORY_CONTENT_BYTES
            && memory.content.to_lowercase().contains(term)
        {
            body_hits += 1;
            matched.push(term.clone());
        }
    }

    let _overlap = if terms.is_empty() {
        0.15
    } else {
        matched.len() as f64 / terms.len().max(1) as f64
    };

    // Title matches are worth 3x body matches
    let weighted_overlap = if terms.is_empty() {
        0.15
    } else {
        let title_score = (title_hits as f64 / terms.len().max(1) as f64) * 0.6;
        let body_score = (body_hits as f64 / terms.len().max(1) as f64) * 0.4;
        title_score + body_score
    };

    let category_boost = match memory.category.as_str() {
        "user" => 0.25,
        "feedback" => 0.22,
        "project" => 0.18,
        "reference" => 0.12,
        _ => 0.08,
    };
    let recency = recency_score_ms(memory.updated_at_ms);
    let usage = ((memory.usage_count.max(0) + 1) as f64).ln() * 0.04;
    let confidence = memory.confidence.clamp(0.0, 1.0) * 0.22;
    let relevance = memory.relevance_score.clamp(0.0, 1.0) * 0.18;

    (
        weighted_overlap * 0.45 + category_boost + recency * 0.1 + usage + confidence + relevance,
        matched,
    )
}

fn recency_score_ms(updated_at_ms: i64) -> f64 {
    if updated_at_ms <= 0 {
        return 0.0;
    }
    let now_ms = Utc::now().timestamp_millis();
    let age_ms = now_ms.saturating_sub(updated_at_ms);
    let age_days = age_ms / (24 * 3600 * 1000);
    match age_days {
        d if d <= 7 => 1.0,
        d if d <= 30 => 0.7,
        d if d <= 90 => 0.35,
        _ => 0.1,
    }
}

fn default_review_after(category: &str) -> String {
    let days = match category {
        "user" | "feedback" => 365,
        "project" => 90,
        "reference" => 30,
        _ => 120,
    };
    (Utc::now() + ChronoDuration::days(days)).to_rfc3339()
}

fn memories_are_duplicates(a: &MemoryEntry, b: &MemoryEntry) -> bool {
    if a.id == b.id || a.category != b.category {
        return false;
    }
    normalize_key(&a.title) == normalize_key(&b.title)
        || normalize_key(&truncate(&a.content, 160)) == normalize_key(&truncate(&b.content, 160))
}

fn looks_like_reusable_feedback(input: &str) -> bool {
    let lower = input.to_lowercase();
    contains_any(
        &lower,
        &[
            // Original signals
            "i prefer",
            "please always",
            "always ",
            "from now on",
            "do not ",
            "don't ",
            "you should",
            "when i ask",
            "remember that",
            "remember this",
            "stop ",
            "instead of",
            // v3.1 — Expanded frustration/correction signals
            "stop doing",
            "don't do",
            "never do",
            "you always",
            "you never",
            "i hate",
            "i don't like",
            "too verbose",
            "too long",
            "too short",
            "be more",
            "be less",
            "just give me",
            "just do ",
            "just show",
            "no, ",
            "wrong",
            "incorrect",
            "that's not right",
            "that is not right",
            "try again",
            "do it again",
            "redo",
            "fix this",
            "fix that",
            "change this",
            "change that",
            "update this",
            "update that",
            "actually,",
            "actually ",
            "i meant",
            "i mean ",
            "what i meant",
            "not what i asked",
            "that's not what i",
            "that is not what i",
            "you misunderstood",
            "misunderstood",
            "no no",
            "no, no",
            "wrong format",
            "bad format",
            "wrong style",
            "different style",
            "different format",
            "like this:",
            "like this,",
            "for example:",
            "for example,",
            "e.g.,",
            "such as ",
            "make it ",
            "turn it into",
            "convert this",
            "rewrite this",
            "rephrase",
            "simplify",
            "shorten this",
            "expand this",
            "add more",
            "remove the",
            "delete the",
            "get rid of",
        ],
    )
}

fn looks_project_scoped(input: &str) -> bool {
    let lower = input.to_lowercase();
    contains_any(
        &lower,
        &[
            "this project",
            "this repo",
            "in this app",
            "we use",
            "convention",
        ],
    )
}

fn ensure_skill(conn: &Connection, name: &str) -> Result<(), String> {
    let exists: i64 = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM skills WHERE name = ?)",
            [name],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if exists != 0 {
        return Ok(());
    }
    let description = if name == "jarvis-collaboration" {
        "Reusable collaboration preferences learned from user feedback"
    } else {
        "Automatically created skill"
    };
    let metadata = json!({"category": "workflow", "source": "auto"}).to_string();
    conn.execute(
        "INSERT INTO skills
         (id, name, description, path, enabled, metadata, body, version, created_at, updated_at)
         VALUES (?, ?, ?, '', 1, ?, '', 1, ?, ?)",
        params![name, name, description, metadata, now(), now()],
    )
    .map_err(|e| format!("Failed to create skill '{}': {}", name, e))?;
    Ok(())
}

fn extract_marker_payload(input: &str, markers: &[&str]) -> Option<String> {
    let lower = input.to_lowercase();
    for marker in markers {
        if let Some(pos) = lower.find(marker) {
            let start = pos + marker.len();
            let payload = input[start..]
                .trim_start_matches(|c: char| c == ':' || c == '-' || c.is_whitespace())
                .trim();
            if !payload.is_empty() {
                return Some(truncate(payload, 1200));
            }
        }
    }
    None
}

fn title_from_content(content: &str) -> String {
    let mut words: Vec<&str> = content.split_whitespace().take(8).collect();
    if words.is_empty() {
        return "Untitled memory".to_string();
    }
    let mut title = words.join(" ");
    if title.len() > 80 {
        title.truncate(80);
    }
    if title.ends_with('.') || title.ends_with(',') {
        title.pop();
    }
    words.clear();
    title
}

fn query_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    query
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(|s| s.to_lowercase())
        .filter(|s| s.len() >= 3)
        .filter(|s| seen.insert(s.clone()))
        .take(12)
        .collect()
}

fn fts_expr(query: &str) -> Option<String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        None
    } else {
        Some(
            terms
                .into_iter()
                .take(8)
                .map(|term| format!("{}*", term))
                .collect::<Vec<_>>()
                .join(" OR "),
        )
    }
}

fn parse_tags(tags: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(tags).unwrap_or_default()
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn normalize_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || c.is_ascii_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn truncate(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let mut out = input
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push_str("...");
    out
}

/// Prune old memory_events if table exceeds MAX_EVENTS rows.
/// Keeps the most recent MAX_EVENTS rows to prevent unbounded growth.
const MAX_EVENTS: i64 = 1000;
fn prune_old_events(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_events", [], |r| r.get(0))
        .unwrap_or(0);
    if count > MAX_EVENTS {
        conn.execute(
            "DELETE FROM memory_events WHERE id NOT IN (
                SELECT id FROM memory_events ORDER BY created_at DESC LIMIT ?
            )",
            params![MAX_EVENTS],
        )
        .map_err(|e| format!("Failed to prune events: {}", e))?;
        // Also run PRAGMA optimize periodically to keep query planner stats fresh
        let _ = conn.execute("PRAGMA optimize", []);
    }
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn memory_columns() -> &'static str {
    "id, title, content, tags, category, created_at, updated_at, relevance_score,
     agent_id, source, source_session_id, source_message_ids, confidence, last_used_at,
     usage_count, expires_at, review_after, status, supersedes_id, metadata,
     tier, drive_file_id, summary, archived_at, updated_at_ms"
}

fn prefixed_memory_columns(prefix: &str) -> String {
    memory_columns()
        .split(',')
        .map(|col| format!("{}.{}", prefix, col.trim()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn memory_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntry> {
    Ok(MemoryEntry {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        tags: row.get(3)?,
        category: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        relevance_score: row.get(7).unwrap_or(0.0),
        agent_id: row.get(8).unwrap_or_else(|_| "jarvis".to_string()),
        source: row.get(9).unwrap_or_else(|_| "manual".to_string()),
        source_session_id: row.get(10).ok(),
        source_message_ids: row.get(11).unwrap_or_else(|_| "[]".to_string()),
        confidence: row.get(12).unwrap_or(0.6),
        last_used_at: row.get(13).ok(),
        usage_count: row.get(14).unwrap_or(0),
        expires_at: row.get(15).ok(),
        review_after: row.get(16).ok(),
        status: row.get(17).unwrap_or_else(|_| "active".to_string()),
        supersedes_id: row.get(18).ok(),
        metadata: row.get(19).ok(),
        // v3.1 — Drive Brain tiered storage (columns 20-23)
        tier: row.get(20).unwrap_or_else(|_| "hot".to_string()),
        drive_file_id: row.get(21).ok(),
        summary: row.get(22).unwrap_or_default(),
        archived_at: row.get(23).ok(),
        // v3.1 — P1: integer timestamp for fast recency scoring
        updated_at_ms: row.get(24).unwrap_or_else(|_| {
            // Fallback: parse RFC3339 updated_at (column 6) and convert
            row.get::<_, String>(6)
                .ok()
                .and_then(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|dt| dt.timestamp_millis())
                })
                .unwrap_or(0)
        }),
    })
}

fn collect_memories<F>(rows: rusqlite::MappedRows<'_, F>) -> Result<Vec<MemoryEntry>, String>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntry>,
{
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn memory_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEvent> {
    Ok(MemoryEvent {
        id: row.get(0)?,
        memory_id: row.get(1)?,
        event_type: row.get(2)?,
        actor: row.get(3)?,
        before_json: row.get(4)?,
        after_json: row.get(5)?,
        reason: row.get(6)?,
        confidence: row.get(7)?,
        session_id: row.get(8)?,
        created_at: row.get(9)?,
    })
}

fn memory_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRun> {
    Ok(MemoryRun {
        id: row.get(0)?,
        kind: row.get(1)?,
        status: row.get(2)?,
        scanned_count: row.get(3)?,
        changed_count: row.get(4)?,
        blocked_count: row.get(5)?,
        error: row.get(6)?,
        metadata: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
    })
}

fn skill_revision_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillRevision> {
    Ok(SkillRevision {
        id: row.get(0)?,
        skill_id: row.get(1)?,
        version: row.get(2)?,
        body_before: row.get(3)?,
        body_after: row.get(4)?,
        change_reason: row.get(5)?,
        source_session_id: row.get(6)?,
        created_at: row.get(7)?,
    })
}

// ═══════════════════════════════════════════════════════════════
// ── v3.1 Self-Learning: Nudge Counters + Deferred LLM Review ─
// ═══════════════════════════════════════════════════════════════

/// Increment the turn counter for a session. Returns the new counter value
/// and whether a deferred LLM review should be triggered.
pub fn increment_review_counter(
    conn: &Connection,
    session_id: &str,
    review_interval: i64,
) -> Result<(i64, bool), String> {
    let now_str = now();
    conn.execute(
        "UPDATE session_memory SET turn_counter = turn_counter + 1, updated_at = ? WHERE session_id = ?",
        params![&now_str, session_id],
    ).map_err(|e| format!("Failed to increment review counter: {}", e))?;

    let counter: i64 = conn
        .query_row(
            "SELECT COALESCE(turn_counter, 0) FROM session_memory WHERE session_id = ?",
            [session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let should_review = review_interval > 0 && counter % review_interval == 0;
    Ok((counter, should_review))
}

/// Record that a review was completed for this session.
pub fn mark_review_completed(conn: &Connection, session_id: &str) -> Result<(), String> {
    let now_str = now();
    conn.execute(
        "UPDATE session_memory SET last_review_at = ?, updated_at = ? WHERE session_id = ?",
        params![&now_str, &now_str, session_id],
    )
    .map_err(|e| format!("Failed to mark review completed: {}", e))?;
    Ok(())
}

/// Apply results from a deferred LLM review. Takes the JSON-serialized
/// review output and creates/updates memories and skills.
/// `review_json` format: {"memories": [{"title", "content", "category"}], "skill_updates": [{"skill_name", "change"}]}
pub fn apply_deferred_review(
    conn: &Connection,
    session_id: &str,
    review_json: &str,
) -> Result<(i64, i64), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(review_json).map_err(|e| format!("Invalid review JSON: {}", e))?;

    let mut mem_changed = 0;
    let mut skill_changed = 0;

    if let Some(memories) = parsed.get("memories").and_then(|v| v.as_array()) {
        for mem in memories {
            let title = mem
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Auto-review memory");
            let content = mem.get("content").and_then(|v| v.as_str());
            let category = mem
                .get("category")
                .and_then(|v| v.as_str())
                .unwrap_or("general");
            let Some(content) = content else {
                continue;
            };

            let write = MemoryWrite {
                title: title.to_string(),
                content: content.to_string(),
                tags: vec!["auto".to_string(), "auto_review".to_string()],
                category: category.to_string(),
                source: "auto_review".to_string(),
                source_session_id: Some(session_id.to_string()),
                source_message_ids: vec![],
                confidence: 0.7,
                metadata: json!({"extractor": "deferred_llm_review"}),
            };
            match create_or_merge_memory(conn, write, "deferred_review", "Deferred LLM review") {
                Ok(_) => mem_changed += 1,
                Err(e) => eprintln!("[review] Memory creation blocked: {}", e),
            }
        }
    }

    if let Some(updates) = parsed.get("skill_updates").and_then(|v| v.as_array()) {
        for update in updates {
            let skill_name = update.get("skill_name").and_then(|v| v.as_str());
            let change = update.get("change").and_then(|v| v.as_str());
            let (Some(skill_name), Some(change)) = (skill_name, change) else {
                continue;
            };

            match apply_skill_improvement(
                conn,
                skill_name,
                &format!("- {}", change),
                "Deferred LLM review",
                Some(session_id),
            ) {
                Ok(true) => skill_changed += 1,
                Ok(false) => {} // duplicate, already present
                Err(e) => eprintln!("[review] Skill improvement blocked: {}", e),
            }
        }
    }

    mark_review_completed(conn, session_id)?;
    Ok((mem_changed, skill_changed))
}

/// Session-end flush: commit any pending state. Called when a session
/// ends (/new, app shutdown, context compression).
pub fn commit_session_end(conn: &Connection, session_id: &str) -> Result<(), String> {
    // Force a final consolidation pass
    let _ = consolidate_memories(conn);
    // Reset counter so next session starts fresh
    conn.execute(
        "UPDATE session_memory SET turn_counter = 0, updated_at = ? WHERE session_id = ?",
        params![now(), session_id],
    )
    .map_err(|e| format!("Failed to reset counter on session end: {}", e))?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// ── v3.1 Drive Brain: Tiered Memory Management ────────────────
// ═══════════════════════════════════════════════════════════════

/// Age thresholds (in days) for memory tiers.
/// Hot: <14 days (full content in SQLite, always in context)
/// Warm: 14-56 days (summary in SQLite, full content archived to Drive)
/// Cold: >56 days (minimal stub in SQLite, full content only on Drive)
const HOT_THRESHOLD_DAYS: i64 = 14;
const WARM_THRESHOLD_DAYS: i64 = 56;

/// Run tier management: age memories from hot → warm → cold.
/// Called during post-turn housekeeping and session-end flush.
/// Returns (hot→warm count, warm→cold count).
pub fn run_tier_management(conn: &Connection) -> Result<(i64, i64), String> {
    let now_str = now();

    // Check if we ran tier management recently (within 24h)
    let last_run: Option<String> = conn
        .query_row(
            "SELECT finished_at FROM memory_runs WHERE kind = 'tier_mgmt' AND status = 'success' ORDER BY finished_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(ts) = last_run {
        if let Ok(dt) = DateTime::parse_from_rfc3339(&ts) {
            if Utc::now()
                .signed_duration_since(dt.with_timezone(&Utc))
                .num_hours()
                < 24
            {
                return Ok((0, 0));
            }
        }
    }

    let run_id = start_run(conn, "tier_mgmt")?;
    let mut hot_to_warm = 0;
    let mut warm_to_cold = 0;

    let result = (|| -> Result<(), String> {
        // HOT → WARM: memories older than 14 days, still hot
        let warm_candidates: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare(
                    &format!("SELECT id, content FROM memory WHERE tier = 'hot' AND status = 'active' AND updated_at < datetime('now', '-{} days') LIMIT 50", HOT_THRESHOLD_DAYS)
                )
                .map_err(|e| e.to_string())?;
            let collected: Vec<(String, String)> = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            collected
        };
        for (id, content) in &warm_candidates {
            let summary = truncate(content, 200);
            conn.execute(
                "UPDATE memory SET tier = 'warm', summary = ?, updated_at = ? WHERE id = ?",
                params![summary, now_str, id],
            )
            .map_err(|e| format!("Failed to tier {}: {}", id, e))?;
            hot_to_warm += 1;
        }

        // WARM → COLD: memories older than 56 days, still warm
        let cold_candidates: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    &format!("SELECT id FROM memory WHERE tier = 'warm' AND status = 'active' AND updated_at < datetime('now', '-{} days') LIMIT 50", WARM_THRESHOLD_DAYS)
                )
                .map_err(|e| e.to_string())?;
            let collected: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            collected
        };
        for id in &cold_candidates {
            conn.execute(
                "UPDATE memory SET tier = 'cold', content = '', updated_at = ? WHERE id = ?",
                params![now_str, id],
            )
            .map_err(|e| format!("Failed to cold-tier {}: {}", id, e))?;
            // Free up the content blob — it should already be on Drive
            warm_to_cold += 1;
        }

        Ok(())
    })();

    match result {
        Ok(()) => {
            let _ = finish_run(
                conn,
                &run_id,
                "success",
                hot_to_warm + warm_to_cold,
                hot_to_warm,
                warm_to_cold,
                "",
            );
            Ok((hot_to_warm, warm_to_cold))
        }
        Err(err) => {
            let _ = finish_run(
                conn,
                &run_id,
                "failed",
                hot_to_warm + warm_to_cold,
                hot_to_warm,
                warm_to_cold,
                &err,
            );
            Err(err)
        }
    }
}

/// List memories by tier, with optional category filter.
pub fn list_memories_by_tier(
    conn: &Connection,
    tier: &str,
    category: Option<&str>,
    limit: i64,
) -> Result<Vec<MemoryEntry>, String> {
    let sql = match category {
        Some(_cat) => format!(
            "SELECT {} FROM memory WHERE tier = ? AND category = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?",
            memory_columns()
        ),
        None => format!(
            "SELECT {} FROM memory WHERE tier = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?",
            memory_columns()
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match category {
        Some(_cat) => stmt
            .query_map(params![tier, _cat, limit], memory_from_row)
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(params![tier, limit], memory_from_row)
            .map_err(|e| e.to_string())?,
    };
    collect_memories(rows)
}

/// Get tier statistics: count per tier.
pub fn get_tier_stats(conn: &Connection) -> Result<serde_json::Value, String> {
    let hot: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory WHERE tier = 'hot' AND status = 'active'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let warm: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory WHERE tier = 'warm' AND status = 'active'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let cold: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory WHERE tier = 'cold' AND status = 'active'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let tombstoned: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory WHERE status = 'tombstoned'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(serde_json::json!({
        "hot": hot, "warm": warm, "cold": cold, "tombstoned": tombstoned,
        "total": hot + warm + cold + tombstoned
    }))
}

/// Recall a cold memory by fetching its full content from Drive.
/// Returns the content if drive_file_id is set, or None if not yet archived.
pub fn recall_cold_memory(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let (tier, drive_file_id, content): (String, Option<String>, String) = conn
        .query_row(
            "SELECT tier, drive_file_id, content FROM memory WHERE id = ?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("Memory not found: {}", e))?;

    match tier.as_str() {
        "hot" | "warm" => Ok(Some(content)),
        "cold" => {
            if let Some(_fid) = drive_file_id {
                // TODO Phase 2: fetch from Drive API
                Ok(None) // Placeholder — will be implemented with Drive integration
            } else {
                Ok(None) // No Drive file yet
            }
        }
        _ => Ok(None),
    }
}

/// Serialize a memory entry to markdown for Drive archival.
pub fn memory_to_markdown(entry: &MemoryEntry) -> String {
    let tags: Vec<String> = serde_json::from_str(&entry.tags).unwrap_or_default();
    let tag_str = if tags.is_empty() {
        "[]".to_string()
    } else {
        tags.join(", ")
    };
    format!(
        "---\nid: {}\ntitle: {}\ncategory: {}\ntags: [{}]\nsource: {}\nconfidence: {:.2}\ncreated_at: {}\nupdated_at: {}\ntier: {}\nstatus: {}\n---\n\n{}\n",
        entry.id, entry.title, entry.category, tag_str, entry.source,
        entry.confidence, entry.created_at, entry.updated_at, entry.tier,
        entry.status, entry.content
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_secret_like_memory() {
        let result = validate_memory_payload("token", "api_key = sk-secret", "user");
        assert!(result.is_err());
    }

    #[test]
    fn blocks_raw_transcript_memory() {
        let result = validate_memory_payload(
            "transcript",
            "\nuser: hello\nassistant: hi\nuser: save this\nassistant: ok",
            "reference",
        );
        assert!(result.is_err());
    }

    #[test]
    fn allows_normal_preference_memory() {
        let result = validate_memory_payload(
            "Prefer concise updates",
            "The user prefers concise progress updates during long tasks.",
            "feedback",
        );
        assert!(result.is_ok());
    }

    #[test]
    fn scoring_rewards_term_overlap() {
        let memory = MemoryEntry {
            id: "m1".into(),
            title: "Rust memory extraction".into(),
            content: "Use SQLite and audit logs for memory extraction.".into(),
            tags: "[\"rust\",\"memory\"]".into(),
            category: "project".into(),
            created_at: now(),
            updated_at: now(),
            relevance_score: 0.0,
            agent_id: "jarvis".into(),
            source: "manual".into(),
            source_session_id: None,
            source_message_ids: "[]".into(),
            confidence: 0.9,
            last_used_at: None,
            usage_count: 0,
            expires_at: None,
            review_after: None,
            status: "active".into(),
            supersedes_id: None,
            metadata: None,
            tier: "hot".into(),
            drive_file_id: None,
            summary: String::new(),
            archived_at: None,
            updated_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        let (score, matched) = score_memory(&memory, &query_terms("rust memory"));
        assert!(score > 0.5);
        assert_eq!(matched.len(), 2);
    }
}
