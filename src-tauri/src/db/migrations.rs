use rusqlite::Connection;

/// Run all schema migrations. Idempotent (every statement is `IF NOT EXISTS`).
///
/// NOTE (recovery): the original `run_migrations` body was lost in the WSL disk
/// loss; only `create_self_tuning_tables` survived on disk. The remaining table
/// definitions (sessions, messages, memory, cron, agents, channels, models, ...)
/// must be re-derived from the SQL in the `commands/*` modules. Tracked in
/// RECOVERY_STATUS.md.
pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    create_self_tuning_tables(conn)?;
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