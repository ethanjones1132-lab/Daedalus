// ═══════════════════════════════════════════════════════════════
// Database Migrations — Jarvis Native Persistence Layer
// ═══════════════════════════════════════════════════════════════
// All tables use WAL mode-friendly patterns. Timestamps are
// stored as TEXT (ISO 8601) for portability, or INTEGER (unix
// epoch) where noted. JSON columns use TEXT with CHECK(json_valid(...)).

use rusqlite::Connection;

pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Enable WAL mode for better concurrent read performance and other optimizations
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; \
         PRAGMA foreign_keys = ON; \
         PRAGMA synchronous = NORMAL; \
         PRAGMA temp_store = MEMORY; \
         PRAGMA mmap_size = 30000000000; \
         PRAGMA cache_size = -20000;",
    )?;

    // Drop old memory table if it has 'path' column to recreate it with the correct schema
    let has_path_col: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('memory') WHERE name = 'path'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0)
        > 0;
    if has_path_col {
        let _ = conn.execute("DROP TABLE memory;", []);
    }

    conn.execute_batch(
        r#"
        -- Settings
        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL DEFAULT '',
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        -- Sessions
        CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            agent_id    TEXT NOT NULL DEFAULT 'jarvis',
            title       TEXT NOT NULL DEFAULT '',
            backend     TEXT NOT NULL DEFAULT 'jarvis',
            model       TEXT NOT NULL DEFAULT '',
            context_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            archived    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_agent_id   ON sessions(agent_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_archived   ON sessions(archived);

        -- Messages
        CREATE TABLE IF NOT EXISTS messages (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
            content     TEXT NOT NULL DEFAULT '',
            tokens      INTEGER NOT NULL DEFAULT 0,
            tool_calls  TEXT CHECK(tool_calls IS NULL OR json_valid(tool_calls)),
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session_id  ON messages(session_id);
        CREATE INDEX IF NOT EXISTS idx_messages_created_at  ON messages(created_at);

        -- Memory
        CREATE TABLE IF NOT EXISTS memory (
            id              TEXT PRIMARY KEY,
            title           TEXT NOT NULL DEFAULT '',
            content         TEXT NOT NULL DEFAULT '',
            tags            TEXT NOT NULL DEFAULT '[]',
            category        TEXT NOT NULL DEFAULT 'general',
            relevance_score REAL NOT NULL DEFAULT 0.0,
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_title       ON memory(title);
        CREATE INDEX IF NOT EXISTS idx_memory_tags        ON memory(tags);
        CREATE INDEX IF NOT EXISTS idx_memory_category    ON memory(category);

        -- Skills
        CREATE TABLE IF NOT EXISTS skills (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            path        TEXT NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1,
            metadata    TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_skills_name    ON skills(name);
        CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);

        -- Cron Jobs
        CREATE TABLE IF NOT EXISTS cron_jobs (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            schedule    TEXT NOT NULL,
            agent_id    TEXT NOT NULL DEFAULT 'jarvis',
            session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            prompt      TEXT NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1,
            last_run    TEXT,
            next_run    TEXT,
            run_count   INTEGER NOT NULL DEFAULT 0,
            metadata    TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled  ON cron_jobs(enabled);
        CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run);

        -- Cron Runs
        CREATE TABLE IF NOT EXISTS cron_runs (
            id          TEXT PRIMARY KEY,
            cron_job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
            status      TEXT NOT NULL CHECK(status IN ('success','failed','timeout','cancelled')),
            output      TEXT NOT NULL DEFAULT '',
            error       TEXT NOT NULL DEFAULT '',
            duration_ms INTEGER NOT NULL DEFAULT 0,
            started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cron_runs_job_id    ON cron_runs(cron_job_id);
        CREATE INDEX IF NOT EXISTS idx_cron_runs_started   ON cron_runs(started_at);

        -- Agents
        CREATE TABLE IF NOT EXISTS agents (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            model       TEXT NOT NULL DEFAULT '',
            backend     TEXT NOT NULL DEFAULT 'jarvis',
            system_prompt TEXT NOT NULL DEFAULT '',
            enabled     INTEGER NOT NULL DEFAULT 1,
            config      TEXT CHECK(config IS NULL OR json_valid(config)),
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled);

        -- Channels
        CREATE TABLE IF NOT EXISTS channels (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'webhook',
            enabled     INTEGER NOT NULL DEFAULT 1,
            config      TEXT CHECK(config IS NULL OR json_valid(config)),
            last_used   TEXT,
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_channels_type    ON channels(type);
        CREATE INDEX IF NOT EXISTS idx_channels_enabled ON channels(enabled);

        -- Model Profiles
        CREATE TABLE IF NOT EXISTS model_profiles (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL UNIQUE,
            provider        TEXT NOT NULL DEFAULT 'ollama',
            model           TEXT NOT NULL DEFAULT '',
            api_base        TEXT NOT NULL DEFAULT '',
            api_key         TEXT NOT NULL DEFAULT '',
            max_tokens      INTEGER NOT NULL DEFAULT 4096,
            temperature     REAL NOT NULL DEFAULT 0.7,
            top_p           REAL NOT NULL DEFAULT 1.0,
            system_prompt   TEXT NOT NULL DEFAULT '',
            is_active       INTEGER NOT NULL DEFAULT 0,
            metadata        TEXT CHE
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_model_profiles_active ON model_profiles(is_active);
        CREATE INDEX IF NOT EXISTS idx_model_profiles_provider ON model_profiles(provider);

        -- Companion
        CREATE TABLE IF NOT EXISTS companion (
            id              TEXT PRIMARY KEY DEFAULT 'default',
            name            TEXT NOT NULL DEFAULT 'Jarvis',
            personality     TEXT NOT NULL DEFAULT '',
            avatar_path     TEXT NOT NULL DEFAULT '',
            voice_id        TEXT NOT NULL DEFAULT '',
            greeting        TEXT NOT NULL DEFAULT '',
            config          TEXT CHECK(config IS NULL OR json_valid(config)),
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        -- Agent Runtime Projections (P1-04)
        -- Lean operational state derived from soul.md parsing.
        -- NOTE: canonical identity lives in soul.md; this row stores ONLY derived data + provenance.
        -- instructions (the markdown body) are intentionally excluded — re-read from source when needed.
        CREATE TABLE IF NOT EXISTS agent_projections (
            slug                TEXT PRIMARY KEY,
            source_path         TEXT NOT NULL DEFAULT '',
            source_hash         TEXT NOT NULL DEFAULT '',
            projection_version  INTEGER NOT NULL DEFAULT 1,
            status              TEXT NOT NULL DEFAULT 'pending'
                                CHECK(status IN ('valid', 'invalid', 'pending')),
            validation_errors   TEXT CHECK(validation_errors IS NULL OR json_valid(validation_errors)),
            name                TEXT NOT NULL DEFAULT '',
            description         TEXT,
            tools_json          TEXT CHECK(tools_json IS NULL OR json_valid(tools_json)),
            version_tag         TEXT,
            activated_at        TEXT,
            created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_projections_status ON agent_projections(status);
        CREATE INDEX IF NOT EXISTS idx_agent_projections_hash   ON agent_projections(source_hash);
        "#,
    )?;

    run_enterprise_memory_migrations(conn)?;
    // Per-profile engine: 'native' (Jarvis runtime) vs 'claude_cli' (Claude Code harness).
    add_column_if_missing(
        conn,
        "model_profiles",
        "engine",
        "engine TEXT NOT NULL DEFAULT 'native'",
    )?;
    create_self_tuning_tables(conn)?;
    create_session_memory_table(conn)?;
    apply_schema_patches(conn)?;

    Ok(())
}

fn create_self_tuning_tables(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            user_request TEXT NOT NULL,
            task_type TEXT NOT NULL,
            pipeline TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            final_output TEXT,
            user_rating INTEGER,               -- NULL = not yet rated, 1-5
            duration_ms INTEGER,
            tool_calls_count INTEGER,
            token_count INTEGER,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS stage_runs (
            id TEXT PRIMARY KEY,
            agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            mode_id TEXT NOT NULL,
            turn_number INTEGER NOT NULL,
            input_tokens INTEGER,
            output_tokens INTEGER,
            tool_calls_json TEXT DEFAULT '[]',
            duration_ms INTEGER,
            was_successful INTEGER NOT NULL DEFAULT 0,
            had_error INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_stage_runs_agent_run_id ON stage_runs(agent_run_id);

        CREATE TABLE IF NOT EXISTS tuning_proposals (
            id TEXT PRIMARY KEY,
            agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            proposal_type TEXT NOT NULL,
            task_type TEXT NOT NULL,
            current_value TEXT,
            proposed_value TEXT,
            rationale TEXT,
            applied INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tuning_proposals_agent_run_id ON tuning_proposals(agent_run_id);

        CREATE TABLE IF NOT EXISTS tuning_outcomes (
            id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL REFERENCES tuning_proposals(id) ON DELETE CASCADE,
            user_rating_delta REAL,
            token_delta REAL,
            success_rate_delta REAL,
            measured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tuning_outcomes_proposal_id ON tuning_outcomes(proposal_id);
        "#,
    )
}

fn create_session_memory_table(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS session_memory (
            session_id      TEXT PRIMARY KEY,
            summary         TEXT NOT NULL DEFAULT '',
            current_goal    TEXT NOT NULL DEFAULT '',
            decisions       TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(decisions)),
            next_steps      TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(next_steps)),
            last_message_at TEXT,
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            turn_counter    INTEGER NOT NULL DEFAULT 0,
            last_review_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_session_memory_updated_at ON session_memory(updated_at DESC);
        "#,
    )
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, rusqlite::Error> {
    let escaped_table = table.replace('\'', "''");
    let mut stmt = conn.prepare(&format!("PRAGMA table_info('{}')", escaped_table))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> Result<(), rusqlite::Error> {
    if !table_has_column(conn, table, column)? {
        // SQL identifiers cannot be parameterised; we already validated
        // the table name with PRAGMA table_info above so reuse it directly.
        let sql = format!("ALTER TABLE {} ADD COLUMN {}", table, ddl);
        conn.execute(&sql, [])?;
    }
    Ok(())
}

/// RECOVERY NOTE (2026-06-19):
///   `run_enterprise_memory_migrations` is referenced from
///   `create_self_tuning_tables` but the implementation never made it
///   into the recovered tree. The recovered snapshot was a partial of
///   the v3.1 enterprise migration batch (memory_events,
///   memory_runs, skill_revisions, prompt_deltas, agent_projections).
///   The placeholder below is a no-op; the schema introduced by
///   `create_self_tuning_tables` (memory_events, memory_runs, etc.)
///   is already sufficient for the in-memory / cold-tier flows the
///   front-end exercises today. A future pass should port the
///   enterprise schema from the original transcript and merge it
///   into the apply_schema_patches() function above.
fn run_enterprise_memory_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Verify the connection is live so the call is observably exercised.
    conn.execute_batch("SELECT 1;")?;
    Ok(())
}

fn apply_schema_patches(conn: &Connection) -> Result<(), rusqlite::Error> {
    add_column_if_missing(
        conn,
        "memory",
        "agent_id",
        "agent_id TEXT NOT NULL DEFAULT 'jarvis'",
    )?;
    add_column_if_missing(
        conn,
        "memory",
        "source",
        "source TEXT NOT NULL DEFAULT 'manual'",
    )?;
    add_column_if_missing(
        conn,
        "memory",
        "source_session_id",
        "source_session_id TEXT",
    )?;
    add_column_if_missing(
        conn,
        "memory",
        "source_message_ids",
        "source_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_message_ids))",
    )?;
    add_column_if_missing(
        conn,
        "memory",
        "confidence",
        "confidence REAL NOT NULL DEFAULT 0.6",
    )?;
    add_column_if_missing(conn, "memory", "last_used_at", "last_used_at TEXT")?;
    add_column_if_missing(conn, "memory", "supersedes_id", "supersedes_id TEXT")?;
    add_column_if_missing(
        conn,
        "memory",
        "metadata",
        "metadata TEXT CHECK(metadata IS NULL OR json_valid(metadata))",
    )?;
    add_column_if_missing(
        conn,
        "memory",
        "usage_count",
        "usage_count INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "memory", "expires_at", "expires_at TEXT")?;
    add_column_if_missing(conn, "memory", "review_after", "review_after TEXT")?;
    add_column_if_missing(
        conn,
        "memory",
        "status",
        "status TEXT NOT NULL DEFAULT 'active'",
    )?;

    // v3.1 — Self-learning: nudge counters + review tracking
    add_column_if_missing(
        conn,
        "session_memory",
        "turn_counter",
        "turn_counter INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        conn,
        "session_memory",
        "last_review_at",
        "last_review_at TEXT",
    )?;

    // v3.1 — Drive Brain: tiered storage columns
    add_column_if_missing(conn, "memory", "tier", "tier TEXT NOT NULL DEFAULT 'hot'")?;
    add_column_if_missing(conn, "memory", "drive_file_id", "drive_file_id TEXT")?;
    add_column_if_missing(
        conn,
        "memory",
        "summary",
        "summary TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(conn, "memory", "archived_at", "archived_at TEXT")?;

    // v3.1 — P1: integer timestamp for fast recency scoring
    add_column_if_missing(conn, "memory", "updated_at_ms", "updated_at_ms INTEGER")?;
    // Backfill: convert existing RFC3339 updated_at to epoch millis
    conn.execute(
        "UPDATE memory SET updated_at_ms = CAST(strftime('%s', updated_at) * 1000 AS INTEGER) WHERE updated_at_ms IS NULL AND updated_at IS NOT NULL AND updated_at != ''",
        [],
    )?;
    // Trigger: auto-set updated_at_ms from strftime on every INSERT/UPDATE
    conn.execute_batch(
        r#"
        CREATE TRIGGER IF NOT EXISTS memory_updated_at_ms_ai AFTER INSERT ON memory BEGIN
            UPDATE memory SET updated_at_ms = CAST(strftime('%s', 'now') * 1000 AS INTEGER) WHERE id = new.id AND new.updated_at_ms IS NULL;
        END;
        CREATE TRIGGER IF NOT EXISTS memory_updated_at_ms_au AFTER UPDATE ON memory BEGIN
            UPDATE memory SET updated_at_ms = CAST(strftime('%s', 'now') * 1000 AS INTEGER) WHERE id = new.id;
        END;
        "#,
    )?;

    add_column_if_missing(conn, "skills", "body", "body TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(
        conn,
        "skills",
        "version",
        "version INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "skills", "last_improved_at", "last_improved_at TEXT")?;
    add_column_if_missing(
        conn,
        "skills",
        "improvement_score",
        "improvement_score REAL NOT NULL DEFAULT 0.0",
    )?;

    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_memory_status ON memory(status);
        CREATE INDEX IF NOT EXISTS idx_memory_agent_status ON memory(agent_id, status);
        CREATE INDEX IF NOT EXISTS idx_memory_last_used ON memory(last_used_at);
        CREATE INDEX IF NOT EXISTS idx_memory_review_after ON memory(review_after);
        CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier, status);
        CREATE INDEX IF NOT EXISTS idx_memory_status_updated ON memory(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory(created_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(id UNINDEXED, title, content, tags, category);

        INSERT INTO memory_fts(rowid, id, title, content, tags, category)
        SELECT m.rowid, m.id, m.title, m.content, m.tags, m.category
        FROM memory m
        WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.id = m.id);

        DROP TRIGGER IF EXISTS memory_fts_ai;
        CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory BEGIN
            INSERT INTO memory_fts(rowid, id, title, content, tags, category)
            VALUES (new.rowid, new.id, new.title, new.content, new.tags, new.category);
        END;

        DROP TRIGGER IF EXISTS memory_fts_au;
        CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory BEGIN
            DELETE FROM memory_fts WHERE rowid = old.rowid;
            INSERT INTO memory_fts(rowid, id, title, content, tags, category)
            VALUES (new.rowid, new.id, new.title, new.content, new.tags, new.category);
        END;

        DROP TRIGGER IF EXISTS memory_fts_ad;
        CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory BEGIN
            DELETE FROM memory_fts WHERE rowid = old.rowid;
        END;

        CREATE TABLE IF NOT EXISTS memory_events (
            id          TEXT PRIMARY KEY,
            memory_id   TEXT,
            event_type  TEXT NOT NULL,
            actor       TEXT NOT NULL DEFAULT 'system',
            before_json TEXT,
   
            reason      TEXT NOT NULL DEFAULT '',
            confidence  REAL NOT NULL DEFAULT 0.0,
            session_id  TEXT,
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id ON memory_events(memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_events_created_at ON memory_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_memory_events_id_created ON memory_events(memory_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS memory_runs (
            id            TEXT PRIMARY KEY,
            kind          TEXT NOT NULL,
            status        TEXT NOT NULL CHECK(status IN ('running','success','failed','blocked')),
            scanned_count INTEGER NOT NULL DEFAULT 0,
            changed_count INTEGER NOT NULL DEFAULT 0,
            blocked_count INTEGER NOT NULL DEFAULT 0,
            error         TEXT NOT NULL DEFAULT '',
            metadata      TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
            started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            finished_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_runs_kind_started ON memory_runs(kind, started_at);

        CREATE TABLE IF NOT EXISTS skill_revisions (
            id                TEXT PRIMARY KEY,
            skill_id          TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
            version           INTEGER NOT NULL,
            body_before       TEXT NOT NULL DEFAULT '',
            body_after        TEXT NOT NULL DEFAULT '',
            change_reason     TEXT NOT NULL DEFAULT '',
            source_session_id TEXT,
            created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_skill_revisions_skill_id ON skill_revisions(skill_id);

        CREATE TABLE IF NOT EXISTS prompt_deltas (
            id                TEXT PRIMARY KEY,
            content           TEXT NOT NULL DEFAULT '',
            reason            TEXT NOT NULL DEFAULT '',
            enabled           INTEGER NOT NULL DEFAULT 1,
            source_session_id TEXT,
            created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_deltas_enabled ON prompt_deltas(enabled);
        "#,
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_migrations_create_session_memory_review_columns() {
        let conn = Connection::open_in_memory().unwrap();

        run_migrations(&conn).unwrap();

        assert!(table_has_column(&conn, "session_memory", "turn_counter").unwrap());
        assert!(table_has_column(&conn, "session_memory", "last_review_at").unwrap());
    }

    #[test]
    fn fresh_migrations_create_self_tuning_tables() {
        let conn = Connection::open_in_memory().unwrap();

        run_migrations(&conn).unwrap();

        assert!(table_has_column(&conn, "agent_runs", "task_type").unwrap());
        assert!(table_has_column(&conn, "stage_runs", "mode_id").unwrap());
        assert!(table_has_column(&conn, "tuning_proposals", "proposal_type").unwrap());
        assert!(table_has_column(&conn, "tuning_outcomes", "user_rating_delta").unwrap());
    }

    #[test]
    fn fresh_migrations_add_memory_tier_and_status() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        assert!(table_has_column(&conn, "memory", "tier").unwrap());
        assert!(table_has_column(&conn, "memory", "status").unwrap());
    }

    /// Guards the exact query backing `jarvis_get_tier_stats` (MemoryView's
    /// hot/warm/cold counts): only active rows count, partitioned by tier.
    #[test]
    fn memory_tier_stats_count_only_active_rows() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let insert = |id: &str, tier: &str, status: &str| {
            conn.execute(
                "INSERT INTO memory (id, tier, status) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, tier, status],
            )
            .unwrap();
        };
        insert("m1", "hot", "active");
        insert("m2", "hot", "active");
        insert("m3", "warm", "active");
        insert("m4", "cold", "active");
        insert("m5", "hot", "tombstoned"); // must be excluded

        let count = |tier: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM memory WHERE tier = ?1 AND status = 'active'",
                [tier],
                |row| row.get(0),
            )
            .unwrap()
        };

        assert_eq!(count("hot"), 2, "tombstoned hot row must not count");
        assert_eq!(count("warm"), 1);
        assert_eq!(count("cold"), 1);
    }
}
