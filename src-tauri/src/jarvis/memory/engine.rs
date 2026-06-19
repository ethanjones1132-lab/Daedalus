//! Memory Engine — FTS5-powered recall, tiered storage, age decay.
//!
//! The memory engine manages memories across three tiers (hot/warm/cold),
//! provides FTS5-powered full-text recall with combined scoring (age + type + relevance),
//! and handles auto-compaction, staleness detection, and event audit trails.

use crate::jarvis::memory::types::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;

/// Core memory engine managing all memory operations.
pub struct MemoryEngine {
    data_dir: PathBuf,
    config: MemoryConfig,
}

impl MemoryEngine {
    /// Create a new MemoryEngine rooted at the given data directory.
    pub fn new(data_dir: PathBuf) -> Self {
        MemoryEngine {
            data_dir,
            config: MemoryConfig::default(),
        }
    }

    /// Create with custom configuration.
    pub fn with_config(data_dir: PathBuf, config: MemoryConfig) -> Self {
        MemoryEngine { data_dir, config }
    }

    // ─── Recall ────────────────────────────────────────────────────────────

    /// Recall relevant memories for a given query using FTS5 + combined scoring.
    pub fn recall(
        &self,
        conn: &Connection,
        query: &str,
        limit: Option<usize>,
    ) -> Result<Vec<MemoryRecord>, String> {
        let limit = limit.unwrap_or(self.config.max_results);

        // Try FTS5 search first
        let fts_results = self.search_fts(conn, query, limit * 2)?;

        // Fallback: LIKE search if FTS returns nothing
        let results = if fts_results.is_empty() {
            self.search_like(conn, query, limit * 2)?
        } else {
            fts_results
        };

        // Score and rank
        let mut scored: Vec<(MemoryRecord, f64)> = results
            .into_iter()
            .map(|record| {
                let score = self.compute_score(&record, query);
                (record, score)
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        Ok(scored.into_iter().take(limit).map(|(r, _)| r).collect())
    }

    /// FTS5 full-text search.
    fn search_fts(
        &self,
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRecord>, String> {
        let mut stmt = conn.prepare(
            "SELECT id, content, memory_type, tier, confidence, usage_count,
                    created_at, updated_at, expires_at, review_after,
                    superseded_by, drive_file_id
             FROM memory m
             JOIN memory_fts ON memory_fts.rowid = m.rowid
             WHERE memory_fts MATCH ?
               AND superseded_by IS NULL
             ORDER BY rank
             LIMIT ?",
        ).map_err(|e| format!("FTS prepare failed: {}", e))?;

        let rows = stmt.query_map(params![query, limit as i64], |row| {
            Ok(MemoryRecord {
                id: row.get(0)?,
                content: row.get(1)?,
                memory_type: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                tier: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                confidence: row.get(4)?,
                usage_count: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                expires_at: row.get(8)?,
                review_after: row.get(9)?,
                superseded_by: row.get(10)?,
                drive_file_id: row.get(11)?,
            })
        }).map_err(|e| format!("FTS query failed: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(results)
    }

    /// LIKE-based fallback search.
    fn search_like(
        &self,
        conn: &Connection,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRecord>, String> {
        let pattern = format!("%{}%", query);
        let mut stmt = conn.prepare(
            "SELECT id, content, memory_type, tier, confidence, usage_count,
                    created_at, updated_at, expires_at, review_after,
                    superseded_by, drive_file_id
             FROM memory
             WHERE content LIKE ?
               AND superseded_by IS NULL
             ORDER BY updated_at DESC
             LIMIT ?",
        ).map_err(|e| format!("LIKE prepare failed: {}", e))?;

        let rows = stmt.query_map(params![pattern, limit as i64], |row| {
            Ok(MemoryRecord {
                id: row.get(0)?,
                content: row.get(1)?,
                memory_type: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                tier: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                confidence: row.get(4)?,
                usage_count: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                expires_at: row.get(8)?,
                review_after: row.get(9)?,
                superseded_by: row.get(10)?,
                drive_file_id: row.get(11)?,
            })
        }).map_err(|e| format!("LIKE query failed: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(results)
    }

    /// Combined scoring: age + type bonus + query relevance.
    fn compute_score(&self, record: &MemoryRecord, query: &str) -> f64 {
        let age_score = self.age_score(record);
        let type_score = record.memory_type.bonus();
        let relevance = self.text_relevance(&record.content, query);

        self.config.weights.age_weight * age_score
            + self.config.weights.type_weight * type_score
            + self.config.weights.relevance_weight * relevance
    }

    /// Exponential age decay with configurable half-life.
    fn age_score(&self, record: &MemoryRecord) -> f64 {
        let now = chrono::Utc::now();
        let created = chrono::DateTime::parse_from_rfc3339(&record.created_at)
            .unwrap_or_else(|_| now.into());
        let age_days = (now - created).num_days() as f64;
        let half_life = self.config.age_half_life_days;
        (-0.693 * age_days / half_life).exp()
    }

    /// Simple text relevance: keyword overlap ratio.
    fn text_relevance(&self, content: &str, query: &str) -> f64 {
        let content_lower = content.to_lowercase();
        let query_words: Vec<&str> = query.to_lowercase().split_whitespace().collect();
        if query_words.is_empty() {
            return 0.0;
        }
        let matches = query_words.iter().filter(|w| content_lower.contains(*w)).count();
        matches as f64 / query_words.len() as f64
    }

    // ─── Store ─────────────────────────────────────────────────────────────

    /// Save a new memory or update an existing one.
    pub fn save_memory(
        &self,
        conn: &Connection,
        content: &str,
        memory_type: MemoryType,
        confidence: f64,
    ) -> Result<MemoryRecord, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let record = MemoryRecord {
            id: id.clone(),
            content: content.to_string(),
            memory_type,
            tier: MemoryTier::Hot,
            confidence,
            usage_count: 0,
            created_at: now.clone(),
            updated_at: now,
            expires_at: None,
            review_after: None,
            superseded_by: None,
            drive_file_id: None,
        };

        conn.execute(
            "INSERT INTO memory (id, content, memory_type, tier, confidence, usage_count,
                                 created_at, updated_at, expires_at, review_after,
                                 superseded_by, drive_file_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                record.id,
                record.content,
                serde_json::to_string(&record.memory_type).unwrap_or_default(),
                serde_json::to_string(&record.tier).unwrap_or_default(),
                record.confidence,
                record.usage_count,
                record.created_at,
                record.updated_at,
                record.expires_at,
                record.review_after,
                record.superseded_by,
                record.drive_file_id,
            ],
        ).map_err(|e| format!("Insert memory failed: {}", e))?;

        // Sync FTS index
        self.sync_fts(conn, &record)?;

        Ok(record)
    }

    /// Sync a single memory record into the FTS5 index.
    fn sync_fts(&self, conn: &Connection, record: &MemoryRecord) -> Result<(), String> {
        conn.execute(
            "INSERT OR REPLACE INTO memory_fts(rowid, content)
             SELECT rowid, content FROM memory WHERE id = ?",
            params![&record.id],
        ).map_err(|e| format!("FTS sync failed: {}", e))?;
        Ok(())
    }

    // ─── Tier Management ───────────────────────────────────────────────────

    /// Promote a memory to hot tier.
    pub fn promote(&self, conn: &Connection, id: &str) -> Result<(), String> {
        conn.execute(
            "UPDATE memory SET tier = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&MemoryTier::Hot).unwrap_or_default(),
                chrono::Utc::now().to_rfc3339(),
                id,
            ],
        ).map_err(|e| format!("Promote failed: {}", e))?;
        Ok(())
    }

    /// Demote a memory to cold tier and serialize to disk.
    pub fn demote(&self, conn: &Connection, id: &str) -> Result<(), String> {
        // Get the memory content
        let record: Option<MemoryRecord> = conn.query_row(
            "SELECT id, content, memory_type, tier, confidence, usage_count,
                    created_at, updated_at, expires_at, review_after,
                    superseded_by, drive_file_id
             FROM memory WHERE id = ?",
            params![id],
            |row| {
                Ok(MemoryRecord {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    memory_type: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                    tier: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                    confidence: row.get(4)?,
                    usage_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    expires_at: row.get(8)?,
                    review_after: row.get(9)?,
                    superseded_by: row.get(10)?,
                    drive_file_id: row.get(11)?,
                })
            },
        ).optional().map_err(|e| format!("Query failed: {}", e))?;

        if let Some(record) = record {
            // Write to cold file
            let cold_path = self.data_dir.join("cold").join(format!("{}.md", id));
            std::fs::create_dir_all(cold_path.parent().unwrap_or(&self.data_dir))
                .map_err(|e| format!("Create cold dir failed: {}", e))?;

            let frontmatter = crate::jarvis::memory::frontmatter::MemoryFrontmatter {
                id: record.id.clone(),
                memory_type: serde_json::to_string(&record.memory_type).unwrap_or_default(),
                tier: "cold".to_string(),
                confidence: record.confidence,
                created_at: record.created_at.clone(),
                updated_at: record.updated_at.clone(),
                expires_at: record.expires_at.clone(),
                review_after: record.review_after.clone(),
                superseded_by: record.superseded_by.clone(),
                drive_file_id: record.drive_file_id.clone(),
            };

            let cold_content = crate::jarvis::memory::frontmatter::serialize_frontmatter(
                &frontmatter,
                &record.content,
            );
            std::fs::write(&cold_path, cold_content)
                .map_err(|e| format!("Write cold file failed: {}", e))?;

            // Update tier in DB
            conn.execute(
                "UPDATE memory SET tier = ?1, drive_file_id = ?2, updated_at = ?3 WHERE id = ?4",
                params![
                    serde_json::to_string(&MemoryTier::Cold).unwrap_or_default(),
                    cold_path.to_str(),
                    chrono::Utc::now().to_rfc3339(),
                    id,
                ],
            ).map_err(|e| format!("Update tier failed: {}", e))?;
        }

        Ok(())
    }

    // ─── Housekeeping ──────────────────────────────────────────────────────

    /// Run post-turn housekeeping: update usage counts, check for stale memories.
    pub fn run_post_turn_housekeeping(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<(), String> {
        // Increment usage count for recently accessed memories
        conn.execute(
            "UPDATE memory SET usage_count = usage_count + 1, updated_at = ?1
             WHERE rowid IN (
                 SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?2
             )",
            params![chrono::Utc::now().to_rfc3339(), session_id],
        ).ok(); // Non-fatal

        // Check for stale memories (older than staleness_days in warm tier)
        if self.config.auto_compact {
            self.compact_stale(conn)?;
        }

        Ok(())
    }

    /// Move stale warm-tier memories to cold storage.
    fn compact_stale(&self, conn: &Connection) -> Result<(), String> {
        let cutoff = chrono::Utc::now()
            - chrono::Duration::days(self.config.staleness_days);

        let stale_ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM memory
                 WHERE tier = ?1
                   AND updated_at < ?2
                   AND superseded_by IS NULL",
            ).map_err(|e| format!("Prepare stale query failed: {}", e))?;

            let rows = stmt.query_map(
                params![
                    serde_json::to_string(&MemoryTier::Warm).unwrap_or_default(),
                    cutoff.to_rfc3339(),
                ],
                |row| row.get(0),
            ).map_err(|e| format!("Stale query failed: {}", e))?;

            let mut ids = Vec::new();
            for row in rows {
                ids.push(row.map_err(|e| format!("Row error: {}", e))?);
            }
            ids
        };

        for id in stale_ids {
            self.demote(conn, &id)?;
        }

        Ok(())
    }

    // ─── Search ────────────────────────────────────────────────────────────

    /// Search memories by keyword.
    pub fn search(
        &self,
        conn: &Connection,
        query: &str,
        limit: Option<usize>,
    ) -> Result<Vec<MemoryRecord>, String> {
        self.recall(conn, query, limit)
    }

    /// List all memories by tier.
    pub fn list_by_tier(
        &self,
        conn: &Connection,
        tier: MemoryTier,
    ) -> Result<Vec<MemoryRecord>, String> {
        let mut stmt = conn.prepare(
            "SELECT id, content, memory_type, tier, confidence, usage_count,
                    created_at, updated_at, expires_at, review_after,
                    superseded_by, drive_file_id
             FROM memory
             WHERE tier = ?1 AND superseded_by IS NULL
             ORDER BY updated_at DESC",
        ).map_err(|e| format!("Prepare failed: {}", e))?;

        let rows = stmt.query_map(
            params![serde_json::to_string(&tier).unwrap_or_default()],
            |row| {
                Ok(MemoryRecord {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    memory_type: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                    tier: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                    confidence: row.get(4)?,
                    usage_count: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    expires_at: row.get(8)?,
                    review_after: row.get(9)?,
                    superseded_by: row.get(10)?,
                    drive_file_id: row.get(11)?,
                })
            },
        ).map_err(|e| format!("Query failed: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_age_score_recent() {
        let engine = MemoryEngine::new(PathBuf::from("/tmp"));
        let record = MemoryRecord {
            id: "test".to_string(),
            content: "test".to_string(),
            memory_type: MemoryType::User,
            tier: MemoryTier::Hot,
            confidence: 1.0,
            usage_count: 0,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            expires_at: None,
            review_after: None,
            superseded_by: None,
            drive_file_id: None,
        };
        let score = engine.age_score(&record);
        assert!(score > 0.9, "Recent memory should have high age score");
    }

    #[test]
    fn test_age_score_old() {
        let engine = MemoryEngine::new(PathBuf::from("/tmp"));
        let old = (chrono::Utc::now() - chrono::Duration::days(90)).to_rfc3339();
        let record = MemoryRecord {
            id: "test".to_string(),
            content: "test".to_string(),
            memory_type: MemoryType::User,
            tier: MemoryTier::Hot,
            confidence: 1.0,
            usage_count: 0,
            created_at: old.clone(),
            updated_at: old,
            expires_at: None,
            review_after: None,
            superseded_by: None,
            drive_file_id: None,
        };
        let score = engine.age_score(&record);
        assert!(score < 0.1, "Old memory should have low age score");
    }

    #[test]
    fn test_text_relevance() {
        let engine = MemoryEngine::new(PathBuf::from("/tmp"));
        let score = engine.text_relevance("The quick brown fox jumps", "fox jumps");
        assert!(score > 0.5);
        let score = engine.text_relevance("Hello world", "xyz");
        assert_eq!(score, 0.0);
    }

    #[test]
    fn test_memory_type_bonus() {
        assert_eq!(MemoryType::User.bonus(), 0.3);
        assert_eq!(MemoryType::Feedback.bonus(), 0.2);
        assert_eq!(MemoryType::Project.bonus(), 0.1);
        assert_eq!(MemoryType::Reference.bonus(), 0.05);
    }

    #[test]
    fn test_recall_weights_default() {
        let weights = RecallWeights::default();
        assert_eq!(weights.age_weight, 0.4);
        assert_eq!(weights.type_weight, 0.3);
        assert_eq!(weights.relevance_weight, 0.3);
    }
}
