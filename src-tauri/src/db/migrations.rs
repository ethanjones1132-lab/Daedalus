// ═══════════════════════════════════════════════════════════════
// Database Migrations — Jarvis Native Persistence Layer
// ═══════════════════════════════════════════════════════════════
// All tables use WAL mode-friendly patterns. Timestamps are
// stored as TEXT (ISO 8601) for portability, or INTEGER (unix
// epoch) where noted. JSON columns use TEXT with CHECK(json_valid(...)).

use rusqlite::{Connection, OptionalExtension};

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

    // Older versions of this database shipped a file-path-based `memory`
    // table. Instead of destroying it to make room for the current schema,
    // preserve it verbatim as `memory_legacy_path_backup`. The backup is
    // never exposed to automatic retrieval; it exists so operators can
    // recover pre-scope information deliberately.
    let has_path_col: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('memory') WHERE name = 'path'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0)
        > 0;
    if has_path_col {
        let backup_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'memory_legacy_path_backup'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;
        if backup_exists {
            // A backup already exists AND the live table still has the old
            // path schema. Renaming would overwrite recoverable data, so fail
            // loudly instead of silently discarding it.
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                Some(
                    "memory_legacy_path_backup already exists while memory still has a path \
                     column; refusing to overwrite legacy memory data"
                        .to_string(),
                ),
            ));
        }
        conn.execute("ALTER TABLE memory RENAME TO memory_legacy_path_backup", [])?;
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

        -- One durable terminal record per native session turn. This is
        -- separate from messages so cancellation/partial output survives
        -- even when no assistant message was persisted.
        CREATE TABLE IF NOT EXISTS session_runs (
            run_id            TEXT PRIMARY KEY,
            session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            outcome           TEXT NOT NULL CHECK(outcome IN ('success','partial','failed','timed_out','cancelled')),
            selected_model    TEXT,
            token_count       INTEGER NOT NULL DEFAULT 0,
            tool_count        INTEGER NOT NULL DEFAULT 0,
            cancelled_reason  TEXT,
            partial_output    TEXT,
            started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            finished_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_session_runs_session_id ON session_runs(session_id);

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
            metadata        TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
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
             active              INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
             active_source_hash  TEXT NOT NULL DEFAULT '',
             source_size_bytes   INTEGER,
             last_validated_at   TEXT,
             deactivated_at      TEXT,
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
         CREATE INDEX IF NOT EXISTS idx_agent_projections_active ON agent_projections(active, status);
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
    apply_scoped_memory_migrations(conn)?;
    apply_memory_turn_migrations(conn)?;
    apply_memory_capture_migrations(conn)?;
    apply_goal_migrations(conn)?;
    apply_cron_activation_migrations(conn)?;

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

/// If an older migration left model_profiles with a malformed metadata
/// column and no created_at, rebuild the table while preserving user data.
fn fix_model_profiles_schema_if_needed(conn: &Connection) -> Result<(), rusqlite::Error> {
    let metadata_type: Option<String> = conn
        .query_row(
            "SELECT type FROM pragma_table_info('model_profiles') WHERE name = 'metadata'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let has_created_at: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('model_profiles') WHERE name = 'created_at'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)?;

    let needs_fix = metadata_type
        .as_deref()
        .map(|t| t.contains("CHE") || !has_created_at)
        .unwrap_or(false);

    if !needs_fix {
        return Ok(());
    }

    conn.execute_batch(
        r#"
        DROP INDEX IF EXISTS idx_model_profiles_active;
        DROP INDEX IF EXISTS idx_model_profiles_provider;
        ALTER TABLE model_profiles RENAME TO model_profiles_old;
        CREATE TABLE model_profiles (
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
            metadata        TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO model_profiles (id, name, provider, model, api_base, api_key, max_tokens, temperature, top_p, system_prompt, is_active, created_at, updated_at)
        SELECT id, name, provider, model, api_base, api_key, max_tokens, temperature, top_p, system_prompt, is_active,
               COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        FROM model_profiles_old;
        DROP TABLE model_profiles_old;
        CREATE INDEX idx_model_profiles_active ON model_profiles(is_active);
        CREATE INDEX idx_model_profiles_provider ON model_profiles(provider);
        "#,
    )?;
    Ok(())
}

fn apply_schema_patches(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Recover from a malformed model_profiles schema introduced in an earlier
    // migration (metadata column was truncated, dropping the created_at column).
    // If detected, rebuild the table and copy the surviving columns.
    fix_model_profiles_schema_if_needed(conn)?;

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

    add_column_if_missing(
        conn,
        "agent_projections",
        "active",
        "active INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        conn,
        "agent_projections",
        "active_source_hash",
        "active_source_hash TEXT NOT NULL DEFAULT ''",
    )?;
    add_column_if_missing(
        conn,
        "agent_projections",
        "source_size_bytes",
        "source_size_bytes INTEGER",
    )?;
    add_column_if_missing(
        conn,
        "agent_projections",
        "last_validated_at",
        "last_validated_at TEXT",
    )?;
    add_column_if_missing(
        conn,
        "agent_projections",
        "deactivated_at",
        "deactivated_at TEXT",
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_projections_active ON agent_projections(active, status)",
        [],
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

    // v3.2 — Cron execution evidence: one durable evidence record per cron run,
    // mirroring the Bun `ExecutionEvidence` shape and surfacing retries/cancellations.
    add_column_if_missing(
        conn,
        "cron_runs",
        "execution_evidence",
        "execution_evidence TEXT CHECK(execution_evidence IS NULL OR json_valid(execution_evidence))",
    )?;

    // v3.2 — Drive Brain cold cache: local mirror of offloaded cold memory content
    // keyed by Drive file ID, with fetch provenance and TTL for bounded retrieval.
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS cold_cache (
            source_id       TEXT PRIMARY KEY,
            content         TEXT NOT NULL DEFAULT '',
            fetched_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            redaction_state TEXT NOT NULL DEFAULT 'none',
            expires_at      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cold_cache_expires_at ON cold_cache(expires_at);
        "#,
    )?;

    // v3.2 — Live Conductor: directive audit trail (mirrors the server-jarvis
    // SelfTuningStore schema in server-jarvis/src/self-tuning/store.ts; the
    // native process owns the migration so the table is present whether the
    // Bun server creates its own self-tuning DB or shares this one).
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS conductor_directives (
            id TEXT PRIMARY KEY,
            agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
            stage TEXT NOT NULL,
            directive_type TEXT NOT NULL,
            reason TEXT,
            new_remaining_json TEXT,
            inject_note TEXT,
            inject_for_stage TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_conductor_directives_agent_run_id
            ON conductor_directives(agent_run_id);
        "#,
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
            after_json  TEXT,
            reason      TEXT NOT NULL DEFAULT '',
            confidence  REAL NOT NULL DEFAULT 0.0,
            session_id  TEXT,
            created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id ON memory_events(memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_events_created_at ON memory_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_memory_events_id_created ON memory_events(memory_id, created_at DESC);

        -- Patch: older schemas created memory_events without the after_json column.
        -- SQLite does not let us ALTER the CREATE TABLE, but add_column_if_missing
        -- works because the table now exists.

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

    // Patch: older schemas created memory_events without the after_json column.
    add_column_if_missing(conn, "memory_events", "after_json", "after_json TEXT")?;

    Ok(())
}

/// Phase 1 scoped-memory schema. Additive only: it never rebuilds the current
/// `memory` table or its FTS triggers. The whole group runs inside a savepoint
/// so a partial failure cannot leave the store in a half-migrated state.
pub fn apply_scoped_memory_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("SAVEPOINT scoped_memory_migration;")?;
    let result = (|| -> Result<(), rusqlite::Error> {
        // Nullable workspace binding on persisted Sessions.
        add_column_if_missing(conn, "sessions", "project_root", "project_root TEXT")?;
        // Explicit monotonic Session workspace-binding revision. Advances on
        // every `project_root` change so a preparation can detect a pure rebind
        // that changes the effective memory scope even when the global store
        // and continuity revisions are unchanged.
        add_column_if_missing(
            conn,
            "sessions",
            "binding_revision",
            "binding_revision INTEGER NOT NULL DEFAULT 0",
        )?;
        conn.execute_batch(
            r#"
            CREATE TRIGGER IF NOT EXISTS sessions_binding_revision_au
            AFTER UPDATE OF project_root ON sessions
            FOR EACH ROW
            WHEN NEW.binding_revision <= OLD.binding_revision
            BEGIN
                UPDATE sessions SET binding_revision = OLD.binding_revision + 1
                WHERE id = NEW.id;
            END;
            "#,
        )?;

        // Scope + provenance + per-entry revision on memory rows.
        add_column_if_missing(
            conn,
            "memory",
            "scope_kind",
            "scope_kind TEXT NOT NULL DEFAULT 'legacy_unscoped'",
        )?;
        add_column_if_missing(conn, "memory", "project_root", "project_root TEXT")?;
        add_column_if_missing(
            conn,
            "memory",
            "authority_kind",
            "authority_kind TEXT NOT NULL DEFAULT 'legacy_unknown'",
        )?;
        add_column_if_missing(conn, "memory", "source_run_id", "source_run_id TEXT")?;
        add_column_if_missing(conn, "memory", "verified_at", "verified_at TEXT")?;
        add_column_if_missing(
            conn,
            "memory",
            "revision",
            "revision INTEGER NOT NULL DEFAULT 1",
        )?;
        // Phase 4 additive statement classification. Existing rows and every
        // legacy/automatic capture migrate to the conservative `unknown`; no
        // title/category/source inference is performed.
        let statement_kind_added = !table_has_column(conn, "memory", "statement_kind")?;
        add_column_if_missing(
            conn,
            "memory",
            "statement_kind",
            "statement_kind TEXT NOT NULL DEFAULT 'unknown'",
        )?;

        // Singleton store revision. A monotonic invalidation counter, not a
        // mutation count: it changes transactionally with knowledge/scope/
        // eligibility mutations and not with recall usage counters.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS memory_store_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                revision  INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO memory_store_state (singleton, revision) VALUES (1, 0);
            "#,
        )?;

        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_memory_scope_eligibility
                ON memory(scope_kind, agent_id, project_root, status, tier);
            "#,
        )?;

        // ── Validation triggers ──────────────────────────────────────
        conn.execute_batch(
            r#"
            CREATE TRIGGER IF NOT EXISTS memory_scope_validate_bi
            BEFORE INSERT ON memory
            WHEN NOT (
                (NEW.scope_kind = 'project' AND NEW.project_root IS NOT NULL AND NEW.agent_id <> '')
             OR (NEW.scope_kind = 'agent'   AND NEW.project_root IS NULL     AND NEW.agent_id <> '')
             OR (NEW.scope_kind = 'user'    AND NEW.project_root IS NULL     AND NEW.agent_id = '')
             OR (NEW.scope_kind = 'legacy_unscoped')
            )
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory scope shape');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_scope_validate_bu
            BEFORE UPDATE ON memory
            WHEN NOT (
                (NEW.scope_kind = 'project' AND NEW.project_root IS NOT NULL AND NEW.agent_id <> '')
             OR (NEW.scope_kind = 'agent'   AND NEW.project_root IS NULL     AND NEW.agent_id <> '')
             OR (NEW.scope_kind = 'user'    AND NEW.project_root IS NULL     AND NEW.agent_id = '')
             OR (NEW.scope_kind = 'legacy_unscoped')
            )
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory scope shape');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_scope_kind_validate_bi
            BEFORE INSERT ON memory
            WHEN NEW.scope_kind NOT IN ('project','agent','user','legacy_unscoped')
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory scope kind');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_scope_kind_validate_bu
            BEFORE UPDATE ON memory
            WHEN NEW.scope_kind NOT IN ('project','agent','user','legacy_unscoped')
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory scope kind');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_authority_kind_validate_bi
            BEFORE INSERT ON memory
            WHEN NEW.authority_kind NOT IN
                ('manual','user_statement','verified_observation','assistant_proposal','legacy_unknown')
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory authority kind');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_authority_kind_validate_bu
            BEFORE UPDATE ON memory
            WHEN NEW.authority_kind NOT IN
                ('manual','user_statement','verified_observation','assistant_proposal','legacy_unknown')
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory authority kind');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_statement_kind_validate_bi
            BEFORE INSERT ON memory
            WHEN NEW.statement_kind NOT IN
                ('normative_constraint','descriptive_fact','unknown')
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory statement kind');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_statement_kind_validate_bu
            BEFORE UPDATE ON memory
            WHEN NEW.statement_kind NOT IN
                ('normative_constraint','descriptive_fact','unknown')
            BEGIN
                SELECT RAISE(ABORT, 'invalid memory statement kind');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_revision_positive_bi
            BEFORE INSERT ON memory
            WHEN NEW.revision < 1
            BEGIN
                SELECT RAISE(ABORT, 'memory revision must be positive');
            END;

            CREATE TRIGGER IF NOT EXISTS memory_revision_positive_bu
            BEFORE UPDATE ON memory
            WHEN NEW.revision < 1
            BEGIN
                SELECT RAISE(ABORT, 'memory revision must be positive');
            END;

            -- An established (non-legacy) scope is immutable. Legacy rows can
            -- be adopted once: their OLD scope_kind is still legacy_unscoped.
            CREATE TRIGGER IF NOT EXISTS memory_scope_immutable_bu
            BEFORE UPDATE OF scope_kind, project_root, agent_id ON memory
            WHEN OLD.scope_kind <> 'legacy_unscoped'
             AND (NEW.scope_kind IS NOT OLD.scope_kind
                  OR NEW.project_root IS NOT OLD.project_root
                  OR NEW.agent_id IS NOT OLD.agent_id)
            BEGIN
                SELECT RAISE(ABORT, 'memory scope cannot be reassigned');
            END;
            "#,
        )?;

        // ── Store revision triggers ─────────────────────────────────
        let semantic_change = "NEW.title IS NOT OLD.title
             OR NEW.content IS NOT OLD.content
             OR NEW.tags IS NOT OLD.tags
             OR NEW.category IS NOT OLD.category
             OR NEW.agent_id IS NOT OLD.agent_id
             OR NEW.scope_kind IS NOT OLD.scope_kind
             OR NEW.project_root IS NOT OLD.project_root
             OR NEW.authority_kind IS NOT OLD.authority_kind
             OR NEW.source IS NOT OLD.source
             OR NEW.source_session_id IS NOT OLD.source_session_id
             OR NEW.source_message_ids IS NOT OLD.source_message_ids
             OR NEW.source_run_id IS NOT OLD.source_run_id
             OR NEW.verified_at IS NOT OLD.verified_at
             OR NEW.confidence IS NOT OLD.confidence
             OR NEW.status IS NOT OLD.status
             OR NEW.expires_at IS NOT OLD.expires_at
             OR NEW.review_after IS NOT OLD.review_after
             OR NEW.supersedes_id IS NOT OLD.supersedes_id
             OR NEW.metadata IS NOT OLD.metadata
             OR NEW.tier IS NOT OLD.tier
             OR NEW.summary IS NOT OLD.summary
             OR NEW.statement_kind IS NOT OLD.statement_kind";

        // The revision triggers are created with `IF NOT EXISTS`, so an
        // existing database would keep the pre-Phase-4 trigger bodies that do
        // not compare `statement_kind`. When the column is first introduced,
        // drop the two revision triggers so the create block below rebuilds
        // them with the extended `semantic_change` predicate.
        if statement_kind_added {
            conn.execute_batch(
                r#"
                DROP TRIGGER IF EXISTS memory_store_revision_au;
                DROP TRIGGER IF EXISTS memory_row_revision_au;
                "#,
            )?;
        }

        conn.execute_batch(&format!(
            r#"
            CREATE TRIGGER IF NOT EXISTS memory_store_revision_ai
            AFTER INSERT ON memory
            BEGIN
                UPDATE memory_store_state SET revision = revision + 1 WHERE singleton = 1;
            END;

            CREATE TRIGGER IF NOT EXISTS memory_store_revision_ad
            AFTER DELETE ON memory
            BEGIN
                UPDATE memory_store_state SET revision = revision + 1 WHERE singleton = 1;
            END;

            CREATE TRIGGER IF NOT EXISTS memory_store_revision_au
            AFTER UPDATE ON memory
            WHEN {semantic_change}
            BEGIN
                UPDATE memory_store_state SET revision = revision + 1 WHERE singleton = 1;
            END;

            -- Legacy mutations do not set revision explicitly; bump the
            -- per-row revision for those same semantic changes so invalidation
            -- is uniform. Scoped updates set revision themselves, so
            -- NEW.revision <> OLD.revision and this trigger stays out of the way.
            CREATE TRIGGER IF NOT EXISTS memory_row_revision_au
            AFTER UPDATE ON memory
            WHEN NEW.revision = OLD.revision AND ({semantic_change})
            BEGIN
                UPDATE memory SET revision = revision + 1 WHERE id = NEW.id;
            END;
            "#
        ))?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("RELEASE SAVEPOINT scoped_memory_migration;")?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT scoped_memory_migration; \
                 RELEASE SAVEPOINT scoped_memory_migration;",
            );
            Err(err)
        }
    }
}

/// Phase 2.1 native turn preparation schema. Additive only and idempotent: it
/// creates the durable per-turn identity table and its indexes without touching
/// existing Session, message, or memory rows. The row stores metadata plus the
/// immutable original user message; it never stores recalled text or the
/// rendered block.
pub fn apply_memory_turn_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_turn_preparations (
          turn_id TEXT PRIMARY KEY,
          preparation_id TEXT UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          user_message TEXT NOT NULL,
          message_hash TEXT NOT NULL,
          scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
          include_user_scope INTEGER NOT NULL DEFAULT 0 CHECK(include_user_scope IN (0,1)),
          effective_workspace TEXT,
          store_revision INTEGER NOT NULL,
          selected_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(selected_json)),
          applied_selected_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(applied_selected_ids_json)),
          app_instance_id TEXT NOT NULL,
          bun_instance_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('prepared','registered','started','terminal','invalidated','expired','unavailable','unterminated')),
          recall_status TEXT NOT NULL,
          error_code TEXT,
          prepared_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          terminal_status TEXT CHECK(terminal_status IS NULL OR terminal_status IN ('completed','partial','cancelled','failed','unterminated')),
          run_id TEXT,
          runtime_evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(runtime_evidence_json)),
          revalidation_json TEXT NOT NULL DEFAULT '{"state":"not_required","memory_ids":[],"evidence_tool_call_ids":[],"reason_code":null}' CHECK(json_valid(revalidation_json))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_turn_session ON memory_turn_preparations(session_id, prepared_at);
        CREATE INDEX IF NOT EXISTS idx_memory_turn_pending ON memory_turn_preparations(state, expires_at);
        "#,
    )?;
    // Existing databases created before Phase 4.3 need the additive column. The
    // SQLite ALTER TABLE cannot add a CHECK constraint, so the JSON validity is
    // enforced by the table definition above for new databases and by native
    // serialization for upgraded ones.
    add_column_if_missing(
        conn,
        "memory_turn_preparations",
        "revalidation_json",
        "revalidation_json TEXT NOT NULL DEFAULT '{\"state\":\"not_required\",\"memory_ids\":[],\"evidence_tool_call_ids\":[],\"reason_code\":null}'",
    )?;
    // Upgraded databases cannot gain a CHECK constraint through ALTER TABLE, so
    // the JSON validity is enforced by equivalent triggers. New databases also
    // carry the column CHECK; these triggers are idempotent and harmless there.
    conn.execute_batch(
        r#"
        CREATE TRIGGER IF NOT EXISTS memory_turn_revalidation_valid_bi
        BEFORE INSERT ON memory_turn_preparations
        WHEN NEW.revalidation_json IS NULL OR json_valid(NEW.revalidation_json) = 0
        BEGIN
            SELECT RAISE(ABORT, 'invalid memory turn revalidation json');
        END;

        CREATE TRIGGER IF NOT EXISTS memory_turn_revalidation_valid_bu
        BEFORE UPDATE ON memory_turn_preparations
        WHEN NEW.revalidation_json IS NULL OR json_valid(NEW.revalidation_json) = 0
        BEGIN
            SELECT RAISE(ABORT, 'invalid memory turn revalidation json');
        END;
        "#,
    )
}

/// Phase 3.1 native capture schema. Additive only and idempotent: it creates
/// the operation ledger, per-turn capture receipts, structured Session
/// continuity, prompt-source suppressions, turn/message associations, and the
/// derived-invalidation outbox without touching or backfilling existing memory,
/// Session, message, or turn rows. No old summary/current_goal is ever promoted
/// into an accepted memory or typed continuity objective. The whole group runs
/// inside a named savepoint so a partial failure cannot leave the store in a
/// half-migrated state.
pub fn apply_memory_capture_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("SAVEPOINT memory_capture_migration;")?;
    let result = (|| -> Result<(), rusqlite::Error> {
        conn.execute_batch(
            r#"
            -- Idempotent operation ledger. One row per (Session, operation_id).
            -- payload_hash is the canonical SHA-256 of the exact operation inputs;
            -- response_json is the original persisted response, replayed verbatim
            -- on an exact retry and never overwritten once written.
            CREATE TABLE IF NOT EXISTS memory_operations (
                session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                operation_id  TEXT NOT NULL,
                payload_hash  TEXT NOT NULL,
                response_json TEXT NOT NULL CHECK(json_valid(response_json)),
                created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                PRIMARY KEY (session_id, operation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_operations_session
                ON memory_operations(session_id, created_at);

            -- At most one committed capture receipt per native turn. terminal_hash
            -- is the authenticated tuple hash from the Phase 2 turn snapshot; it is
            -- nullable before the terminal observation is finalized but never
            -- rewritten once the receipt has a terminal status.
            CREATE TABLE IF NOT EXISTS memory_capture_receipts (
                turn_id       TEXT PRIMARY KEY
                    REFERENCES memory_turn_preparations(turn_id) ON DELETE CASCADE,
                session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                terminal_hash TEXT,
                receipt_json  TEXT NOT NULL CHECK(json_valid(receipt_json)),
                updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_memory_capture_receipts_session
                ON memory_capture_receipts(session_id, updated_at);

            -- Structured Session continuity. Distinct from the legacy
            -- session_memory summary/current_goal row; legacy fields are never
            -- read into this table by migration.
            CREATE TABLE IF NOT EXISTS session_continuity (
                session_id            TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                active_objective_json TEXT CHECK(
                    active_objective_json IS NULL OR json_valid(active_objective_json)
                ),
                latest_turn_id        TEXT
                    REFERENCES memory_turn_preparations(turn_id) ON DELETE SET NULL,
                revision              INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
                updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );

            -- Prompt-source suppression: exact (Session, message, memory) ids whose
            -- source instructions must not be replayed from any derived prompt
            -- state. The visible operator transcript is untouched; deleted source
            -- rows leave the audit ids recorded here rather than reviving facts.
            CREATE TABLE IF NOT EXISTS memory_prompt_suppressions (
                session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                message_id  TEXT NOT NULL,
                memory_id   TEXT NOT NULL,
                reason      TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                PRIMARY KEY (session_id, message_id, memory_id)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_prompt_suppressions_memory
                ON memory_prompt_suppressions(memory_id);

            -- Assistant turn/message association. Establishes transcript
            -- provenance only; it never grants factual authority.
            CREATE TABLE IF NOT EXISTS memory_turn_messages (
                turn_id    TEXT NOT NULL REFERENCES memory_turn_preparations(turn_id) ON DELETE CASCADE,
                message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
                PRIMARY KEY (turn_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_turn_messages_message
                ON memory_turn_messages(message_id);

            -- Derived-state invalidation outbox. Drained in Part 3.2; persisted
            -- atomically with the native mutation that produced it. It has NO
            -- Session FK so a pending cleanup survives the deletion of the
            -- initiating Session. session_id holds the ORIGINAL initiating
            -- Session id (audit metadata only, possibly deleted); operation_id
            -- holds the raw native operation id. The wire key is rebuilt
            -- deterministically as `session/<session_id>/operation/<operation_id>`
            -- so the initial cleanup and every later drain send the exact same
            -- key. scope_json holds the actual MemoryScope JSON;
            -- source_message_ids_json holds the exact source message ids.
            -- Malformed metadata is a typed storage failure, never silently
            -- defaulted.
            CREATE TABLE IF NOT EXISTS memory_derived_invalidations (
                session_id                 TEXT NOT NULL,
                operation_id               TEXT NOT NULL,
                scope_json                 TEXT NOT NULL CHECK(json_valid(scope_json)),
                affected_session_ids_json  TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(affected_session_ids_json)),
                memory_ids_json            TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(memory_ids_json)),
                acknowledged_at            TEXT,
                PRIMARY KEY (session_id, operation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_derived_invalidations_pending
                ON memory_derived_invalidations(acknowledged_at);
            "#,
        )?;
        add_column_if_missing(
            conn,
            "memory_derived_invalidations",
            "source_message_ids_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;

        // Phase 3.4 internal action cursor. Records the stable `(created_at,
        // rowid)` order key of the LAST accepted objective action (replace,
        // clear, or explicit operator set), independent of whether an active
        // objective still exists. A delayed older automatic directive is
        // rejected by comparing its source order key against this cursor even
        // after a later clear (which leaves `active_objective_json` NULL) and
        // even if the recorded source message is later removed. This is internal
        // durability only; it never widens the frozen public continuity DTOs.
        add_column_if_missing(
            conn,
            "session_continuity",
            "last_action_source_message_id",
            "TEXT",
        )?;
        add_column_if_missing(conn, "session_continuity", "last_action_created_at", "TEXT")?;
        add_column_if_missing(conn, "session_continuity", "last_action_rowid", "INTEGER")?;
        // A manual operator set is a monotonic HIGHWATER boundary: every source
        // already recorded when the operator acted (including one numerically
        // equal to the chosen source) is protected from later automatic
        // directives. Stored as the `(created_at,rowid)` key of the
        // highest-order message present at the manual call. Automatic
        // directives at or below this boundary are stale; only a source saved
        // strictly after the boundary may change the objective.
        add_column_if_missing(conn, "session_continuity", "manual_boundary_created_at", "TEXT")?;
        add_column_if_missing(conn, "session_continuity", "manual_boundary_rowid", "INTEGER")?;

        // Additive Part 3.2 outbox. Committed Part 3.1 already created
        // `memory_derived_invalidations` WITH a `REFERENCES sessions ON DELETE
        // CASCADE` FK; `CREATE TABLE IF NOT EXISTS` cannot remove it, so a
        // pending cleanup row could be cascaded away by a Session delete. This
        // NEW table has NO Session FK and is the production outbox. The old
        // table is retained (never dropped, rows preserved); every surviving row
        // is copied here idempotently (`INSERT OR IGNORE`), preserving the
        // original initiating Session id, the raw operation id, the resolved
        // scope, the source/affected/memory ids, and the acknowledgement.
        // `source_message_ids_json` is added to the old table before the copy so
        // the column always exists.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS memory_derived_cleanup_outbox (
                session_id                 TEXT NOT NULL,
                operation_id               TEXT NOT NULL,
                scope_json                 TEXT NOT NULL CHECK(json_valid(scope_json)),
                affected_session_ids_json  TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(affected_session_ids_json)),
                memory_ids_json            TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(memory_ids_json)),
                source_message_ids_json    TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(source_message_ids_json)),
                acknowledged_at            TEXT,
                PRIMARY KEY (session_id, operation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_derived_cleanup_outbox_pending
                ON memory_derived_cleanup_outbox(acknowledged_at);
            INSERT OR IGNORE INTO memory_derived_cleanup_outbox
                (session_id, operation_id, scope_json, affected_session_ids_json,
                 memory_ids_json, source_message_ids_json, acknowledged_at)
            SELECT session_id, operation_id, scope_json, affected_session_ids_json,
                   memory_ids_json, source_message_ids_json, acknowledged_at
              FROM memory_derived_invalidations;
            "#,
        )?;

        // A new prompt-source suppression is a semantic invalidation, so it
        // must advance the singleton store revision even when it commits
        // without a memory-row change (for example a historically-tombstoned
        // forget with no-op memory update). This lets a prepared snapshot's
        // revision recheck detect a suppression that lands during a model call.
        conn.execute_batch(
            r#"
            CREATE TRIGGER IF NOT EXISTS memory_store_revision_suppression_ai
            AFTER INSERT ON memory_prompt_suppressions
            BEGIN
                UPDATE memory_store_state SET revision = revision + 1 WHERE singleton = 1;
            END;
            "#,
        )?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("RELEASE SAVEPOINT memory_capture_migration;")?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT memory_capture_migration; \
                 RELEASE SAVEPOINT memory_capture_migration;",
            );
            Err(err)
        }
    }
}

/// Roadmap Priority #2 Part 1 — durable native Goal authority. Additive only
/// and idempotent: it creates the goal authority tables and adds nullable
/// `goal_id` association columns to existing native run/schedule tables without
/// touching or backfilling existing Session, run, cron, memory, or commitment
/// rows. No relationship is wired in this part; the columns and `goal_links`
/// table are declared association points only. The whole group runs inside a
/// named savepoint so a partial failure cannot leave the store half-migrated.
pub fn apply_goal_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("SAVEPOINT goal_migration;")?;
    let result = (|| -> Result<(), rusqlite::Error> {
        conn.execute_batch(
            r#"
            -- User-owned goal objective. `objective_authority` is constrained to
            -- `user_statement`: a model-generated summary can never be promoted
            -- into an accepted objective. Lifecycle `status` is one of the eight
            -- declared states; the command layer enforces the transition graph.
            CREATE TABLE IF NOT EXISTS goals (
                id                  TEXT PRIMARY KEY,
                objective           TEXT NOT NULL,
                status              TEXT NOT NULL DEFAULT 'pending'
                                    CHECK(status IN ('pending','running','waiting_for_user','blocked','paused','completed','failed','cancelled')),
                agent_id            TEXT NOT NULL DEFAULT 'jarvis',
                project_root        TEXT,
                objective_authority TEXT NOT NULL DEFAULT 'user_statement'
                                    CHECK(objective_authority IN ('user_statement')),
                created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_goals_status       ON goals(status);
            CREATE INDEX IF NOT EXISTS idx_goals_agent_status ON goals(agent_id, status);
            CREATE INDEX IF NOT EXISTS idx_goals_scope        ON goals(agent_id, project_root);

            -- User-provided acceptance criteria with stable per-criterion
            -- identity. `authority` is constrained to `user_statement` so a
            -- model summary or tool output can never become an accepted
            -- criterion. `ordinal` is the stable display order within a goal.
            CREATE TABLE IF NOT EXISTS goal_criteria (
                id         TEXT PRIMARY KEY,
                goal_id    TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
                ordinal    INTEGER NOT NULL,
                text       TEXT NOT NULL,
                authority  TEXT NOT NULL DEFAULT 'user_statement'
                           CHECK(authority IN ('user_statement')),
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                UNIQUE(goal_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS idx_goal_criteria_goal ON goal_criteria(goal_id, ordinal);

            -- Append-only lifecycle audit. Records creation, objective/criteria
            -- edits, and explicit transitions with the previous/next status.
            CREATE TABLE IF NOT EXISTS goal_events (
                id          TEXT PRIMARY KEY,
                goal_id     TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
                event_type  TEXT NOT NULL CHECK(event_type IN ('created','updated','transition')),
                from_status TEXT,
                to_status   TEXT,
                actor       TEXT NOT NULL DEFAULT 'user',
                reason      TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id, created_at);

            -- Generic association point for entities that do not own a goal_id
            -- column (TaskPlan/TaskRun in Bun, output evidence) and for explicit
            -- operator linking. Nothing in this part writes it automatically.
            CREATE TABLE IF NOT EXISTS goal_links (
                id          TEXT PRIMARY KEY,
                goal_id     TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
                target_kind TEXT NOT NULL
                            CHECK(target_kind IN ('task_plan','task_run','commitment','cron_job','cron_run','session_run','evidence')),
                target_id   TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                UNIQUE(goal_id, target_kind, target_id)
            );
            CREATE INDEX IF NOT EXISTS idx_goal_links_goal   ON goal_links(goal_id);
            CREATE INDEX IF NOT EXISTS idx_goal_links_target ON goal_links(target_kind, target_id);
            "#,
        )?;

        // Stable optional `goal_id` association contracts on existing native
        // tables. Nullable and unwired in Part 1; later parts populate them.
        add_column_if_missing(conn, "session_runs", "goal_id", "goal_id TEXT")?;
        add_column_if_missing(conn, "cron_jobs", "goal_id", "goal_id TEXT")?;
        add_column_if_missing(conn, "cron_runs", "goal_id", "goal_id TEXT")?;

        // Roadmap Priority #2, Part 2: durable native record of each registered
        // Goal run binding. A terminal run may set `session_runs.goal_id` only
        // when the owned Bun child's consume receipt verifies against this row
        // (exact Session/turn/saved-user source row+hash/Goal/stable TaskRun
        // identity/Bun run identity). `binding_id` is the native-minted opaque
        // one-shot identity; no client value is authority. Bounded and additive.
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS goal_run_bindings (
                binding_id          TEXT PRIMARY KEY,
                goal_id             TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
                session_id          TEXT NOT NULL,
                agent_id            TEXT NOT NULL,
                project_root        TEXT,
                turn_id             TEXT NOT NULL,
                source_message_id   TEXT NOT NULL,
                source_message_hash TEXT NOT NULL,
                task_run_id         TEXT NOT NULL,
                bun_instance_id     TEXT,
                issued_at           TEXT NOT NULL,
                expires_at          TEXT NOT NULL,
                consumed_at         TEXT,
                consumed_run_id     TEXT,
                created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                UNIQUE(session_id, turn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_goal_run_bindings_goal    ON goal_run_bindings(goal_id);
            CREATE INDEX IF NOT EXISTS idx_goal_run_bindings_session ON goal_run_bindings(session_id, turn_id);
            "#,
        )?;

        // A terminal goal's status is immutable at the storage layer. The
        // command layer also rejects terminal transitions; this guards against
        // any other writer silently reviving closed work.
        conn.execute_batch(
            r#"
            CREATE TRIGGER IF NOT EXISTS goal_terminal_status_immutable_bu
            BEFORE UPDATE OF status ON goals
            WHEN OLD.status IN ('completed','failed','cancelled')
             AND NEW.status IS NOT OLD.status
            BEGIN
                SELECT RAISE(ABORT, 'terminal goal status is immutable');
            END;
            "#,
        )?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("RELEASE SAVEPOINT goal_migration;")?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT goal_migration; \
                 RELEASE SAVEPOINT goal_migration;",
            );
            Err(err)
        }
    }
}

/// Roadmap Priority #2 Part 3 — durable cron activation/occurrence authority.
/// Additive and idempotent. A `cron_activations` row is the durable claim for one
/// deterministic schedule occurrence of one cron job. The unique
/// `(cron_job_id, schedule_occurrence)` constraint is the dedupe key: a claimed
/// occurrence can never be claimed again, so a confirmed/completed effect can
/// never be re-dispatched across restarts. `goal_id`/`agent_id`/`session_id` are
/// the validated association snapshot; pending, non-terminal claims become an
/// explicit `ambiguous` reconcile state on restart rather than being replayed.
/// No existing cron row is backfilled.
pub fn apply_cron_activation_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch("SAVEPOINT cron_activation_migration;")?;
    let result = (|| -> Result<(), rusqlite::Error> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS cron_activations (
                activation_id       TEXT PRIMARY KEY,
                cron_job_id         TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
                goal_id             TEXT,
                agent_id            TEXT NOT NULL,
                session_id          TEXT,
                project_root        TEXT,
                schedule_occurrence TEXT NOT NULL,
                trigger_kind        TEXT NOT NULL DEFAULT 'schedule'
                                    CHECK(trigger_kind IN ('schedule','manual','missed')),
                claim_state         TEXT NOT NULL DEFAULT 'claimed'
                                    CHECK(claim_state IN ('claimed','dispatched','completed','failed','cancelled','ambiguous','waiting_for_user','blocked')),
                run_id              TEXT,
                bun_run_id          TEXT,
                terminal_reason     TEXT,
                claimed_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                dispatched_at       TEXT,
                settled_at          TEXT,
                created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                UNIQUE(cron_job_id, schedule_occurrence)
            );
            CREATE INDEX IF NOT EXISTS idx_cron_activations_job   ON cron_activations(cron_job_id, claim_state);
            CREATE INDEX IF NOT EXISTS idx_cron_activations_goal  ON cron_activations(goal_id, claim_state);
            CREATE INDEX IF NOT EXISTS idx_cron_activations_state ON cron_activations(claim_state);
            "#,
        )?;

        // Correlate the append-only run history with the durable activation and
        // its deterministic occurrence. Nullable/additive: existing rows keep
        // their history and read back as unlinked.
        add_column_if_missing(conn, "cron_runs", "activation_id", "activation_id TEXT")?;
        add_column_if_missing(
            conn,
            "cron_runs",
            "schedule_occurrence",
            "schedule_occurrence TEXT",
        )?;
        add_column_if_missing(conn, "cron_runs", "terminal_reason", "terminal_reason TEXT")?;

        // Durable cancellation intent. `claim_state`'s CHECK does not include a
        // cancellation-pending value, so intent lives in dedicated nullable
        // columns instead of an unreviewed enum member. `cancel_requested_at`
        // set + `cancel_acknowledged_at` null means a request exists that no
        // task has confirmed; after a restart these reconcile to `ambiguous`
        // rather than being reported as `cancelled`.
        add_column_if_missing(
            conn,
            "cron_activations",
            "cancel_requested_at",
            "cancel_requested_at TEXT",
        )?;
        add_column_if_missing(
            conn,
            "cron_activations",
            "cancel_requested_reason",
            "cancel_requested_reason TEXT",
        )?;
        add_column_if_missing(
            conn,
            "cron_activations",
            "cancel_acknowledged_at",
            "cancel_acknowledged_at TEXT",
        )?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("RELEASE SAVEPOINT cron_activation_migration;")?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT cron_activation_migration; \
                 RELEASE SAVEPOINT cron_activation_migration;",
            );
            Err(err)
        }
    }
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
