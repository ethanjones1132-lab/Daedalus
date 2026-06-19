import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { Database } from "bun:sqlite";
import { SelfTuningStore } from "./store";
import { SessionOutcomeCollector } from "./collector";
import { OutcomeAnalyzer } from "./analyzer";
import { SelfTuningProposer } from "./proposer";

const TEST_DB_PATH = `test-tuning-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`;

function createTables(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_request TEXT NOT NULL,
        task_type TEXT NOT NULL,
        pipeline TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        final_output TEXT,
        user_rating INTEGER,
        duration_ms INTEGER,
        tool_calls_count INTEGER,
        token_count INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  db.run(`
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
        had_error INTEGER NOT NUL