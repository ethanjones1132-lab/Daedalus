import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

export interface AgentRun {
  id: string;
  session_id: string;
  user_request: string;
  task_type: string;
  pipeline: string; // JSON string array
  completed: number;
  final_output?: string;
  user_rating?: number;
  duration_ms?: number;
  tool_calls_count?: number;
  token_count?: number;
  /**
   * Truthful run outcome: "success" | "degraded" | "failed". Distinct from
   * `completed` (which only marks that the run finished). Added via a guarded
   * ALTER in getDb() so existing DBs gain the column without a full migration.
   */
  outcome?: string;
  created_at?: string;
}

export interface StageRun {
  id: string;
  agent_run_id: string;
  mode_id: string;
  turn_number: number;
  input_tokens?: number;
  output_tokens?: number;
  tool_calls_json?: string;
  duration_ms?: number;
  was_successful: number;
  had_error: number;
  error_message?: string;
  created_at?: string;
}

export interface TuningProposal {
  id: string;
  agent_run_id: string;
  proposal_type: string;
  task_type: string;
  current_value?: string;
  proposed_value?: string;
  rationale?: string;
  applied: number;
  created_at?: string;
}

export interface TuningOutcome {
  id: string;
  proposal_id: string;
  user_rating_delta?: number;
  token_delta?: number;
  success_rate_delta?: number;
  measured_at?: string;
}

function getWindowsHome(): string | null {
  try {
    const raw = execSync("cmd.exe /c echo %USERPROFILE%", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const trimmed = raw.trim();
    if (trimmed && trimmed.match(/^[a-zA-Z]:\\/)) {
      const drive = trimmed[0].toLowerCase();
      const path = trimmed.slice(2).replace(/\\/g, "/");
      return `/mnt/${drive}${path}`;
    }
  } catch (e) {
    // Fail silently
  }
  return null;
}

export function locateJarvisDb(): string | null {
  const winHome = getWindowsHome();
  const candidates: string[] = [];
  const user = homedir().split("/").pop() || "ethan";

  if (winHome) {
    candidates.push(join(winHome, ".local", "share", "com.jarvis.desktop", "jarvis.db"));
    candidates.push(join(winHome, "AppData", "Local", "com.jarvis.desktop", "jarvis.db"));
    candidates.push(join(winHome, ".openclaw", "jarvis", "memory", "jarvis.db"));
  }

  candidates.push(`/mnt/c/Users/${user}/.local/share/com.jarvis.desktop/jarvis.db`);
  candidates.push(`/mnt/c/Users/${user}/AppData/Local/com.jarvis.desktop/jarvis.db`);
  candidates.push(`/mnt/c/Users/${user}/.openclaw/jarvis/memory/jarvis.db`);

  candidates.push(join(homedir(), ".local", "share", "com.jarvis.desktop", "jarvis.db"));
  candidates.push(join(homedir(), ".openclaw", "jarvis", "memory", "jarvis.db"));
  candidates.push(join(homedir(), ".openclaw", "jarvis", "jarvis.db"));
  candidates.push(join(homedir(), "jarvis.db"));

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return null;
}

// Self-tuning telemetry lives in its OWN Bun-native SQLite DB (WSL ext4), NOT the shared
// Windows jarvis.db. That DB is held open by the native Rust process in WAL mode; a second
// opener reaching it over the /mnt/c 9p mount cannot coordinate the -shm shared-memory file
// across the Win/WSL boundary, which throws SQLITE_IOERR ("disk I/O error") on every write.
// Rust only *creates* these tables (migrations) and never reads them, so keeping the data
// server-side is safe. Schema mirrors src-tauri/src/db/migrations.rs::create_self_tuning_tables.
const SELF_TUNING_SCHEMA = `
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
    outcome TEXT,
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
`;

const schemaEnsuredPaths = new Set<string>();

/** Dedicated, WSL-native self-tuning DB path (parent dir created lazily). */
export function selfTuningDbPath(): string {
  const p = join(homedir(), ".openclaw", "jarvis", "self-tuning.db");
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* best effort */ }
  return p;
}

export class SelfTuningStore {
  private cachedDb: Database | null = null;

  constructor(private dbPathOverride?: string) {}

  private getDb(): Database | null {
    try {
      if (this.dbPathOverride === ":memory:") {
        if (!this.cachedDb) {
          const db = new Database(":memory:");
          db.exec(SELF_TUNING_SCHEMA);
          db.close = () => {}; // Make close a no-op so the in-memory DB stays alive
          this.cachedDb = db;
        }
        return this.cachedDb;
      }
      // Default to the dedicated, WSL-native self-tuning DB (see SELF_TUNING_SCHEMA note).
      const dbPath = this.dbPathOverride || selfTuningDbPath();
      const db = new Database(dbPath, { create: true });
      if (!schemaEnsuredPaths.has(dbPath)) {
        db.exec(SELF_TUNING_SCHEMA);
        // Guarded migration: add the `outcome` column to pre-existing agent_runs
        // tables (CREATE TABLE IF NOT EXISTS won't ALTER an existing table). The
        // duplicate-column error on an already-migrated DB is expected and ignored.
        try {
          db.exec(`ALTER TABLE agent_runs ADD COLUMN outcome TEXT`);
        } catch { /* column already exists */ }
        schemaEnsuredPaths.add(dbPath);
      }
      return db;
    } catch (e) {
      console.error("[SelfTuningStore] open failed:", e);
      return null;
    }
  }

  insertAgentRun(run: AgentRun): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO agent_runs (id, session_id, user_request, task_type, pipeline, completed, final_output, user_rating, duration_ms, tool_calls_count, token_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        run.id,
        run.session_id,
        run.user_request,
        run.task_type,
        run.pipeline,
        run.completed,
        run.final_output ?? null,
        run.user_rating ?? null,
        run.duration_ms ?? null,
        run.tool_calls_count ?? null,
        run.token_count ?? null
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertAgentRun failed:", e);
    } finally {
      db.close();
    }
  }

  updateAgentRun(runId: string, updates: Partial<AgentRun>): void {
    const db = this.getDb();
    if (!db) return;
    try {
      const keys = Object.keys(updates);
      if (keys.length === 0) return;
      const setClause = keys.map((k) => `${k} = ?`).join(", ");
      const params = keys.map((k) => (updates as any)[k]);
      params.push(runId);
      db.prepare(`UPDATE agent_runs SET ${setClause} WHERE id = ?`).run(...params);
    } catch (e) {
      console.error("[SelfTuningStore] updateAgentRun failed:", e);
    } finally {
      db.close();
    }
  }

  insertStageRun(stage: StageRun): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO stage_runs (id, agent_run_id, mode_id, turn_number, input_tokens, output_tokens, tool_calls_json, duration_ms, was_successful, had_error, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        stage.id,
        stage.agent_run_id,
        stage.mode_id,
        stage.turn_number,
        stage.input_tokens ?? null,
        stage.output_tokens ?? null,
        stage.tool_calls_json ?? "[]",
        stage.duration_ms ?? null,
        stage.was_successful,
        stage.had_error,
        stage.error_message ?? null
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertStageRun failed:", e);
    } finally {
      db.close();
    }
  }

  insertTuningProposal(prop: TuningProposal): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO tuning_proposals (id, agent_run_id, proposal_type, task_type, current_value, proposed_value, rationale, applied)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        prop.id,
        prop.agent_run_id,
        prop.proposal_type,
        prop.task_type,
        prop.current_value ?? null,
        prop.proposed_value ?? null,
        prop.rationale ?? null,
        prop.applied
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertTuningProposal failed:", e);
    } finally {
      db.close();
    }
  }

  insertTuningOutcome(outcome: TuningOutcome): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO tuning_outcomes (id, proposal_id, user_rating_delta, token_delta, success_rate_delta)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        outcome.id,
        outcome.proposal_id,
        outcome.user_rating_delta ?? null,
        outcome.token_delta ?? null,
        outcome.success_rate_delta ?? null
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertTuningOutcome failed:", e);
    } finally {
      db.close();
    }
  }

  getAgentRuns(): AgentRun[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query("SELECT * FROM agent_runs ORDER BY created_at DESC").all() as AgentRun[];
    } catch (e) {
      console.error("[SelfTuningStore] getAgentRuns failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getStageRuns(agentRunId: string): StageRun[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query("SELECT * FROM stage_runs WHERE agent_run_id = ? ORDER BY turn_number ASC").all(agentRunId) as StageRun[];
    } catch (e) {
      console.error("[SelfTuningStore] getStageRuns failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getPendingProposals(): TuningProposal[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query("SELECT * FROM tuning_proposals WHERE applied = 0 ORDER BY created_at DESC").all() as TuningProposal[];
    } catch (e) {
      console.error("[SelfTuningStore] getPendingProposals failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getAppliedProposals(): TuningProposal[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query("SELECT * FROM tuning_proposals WHERE applied = 1 ORDER BY created_at DESC").all() as TuningProposal[];
    } catch (e) {
      console.error("[SelfTuningStore] getAppliedProposals failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  applyTuningProposal(id: string): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare("UPDATE tuning_proposals SET applied = 1 WHERE id = ?").run(id);
    } catch (e) {
      console.error("[SelfTuningStore] applyTuningProposal failed:", e);
    } finally {
      db.close();
    }
  }

  updateUserRating(runId: string, rating: number): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare("UPDATE agent_runs SET user_rating = ? WHERE id = ?").run(rating, runId);
    } catch (e) {
      console.error("[SelfTuningStore] updateUserRating failed:", e);
    } finally {
      db.close();
    }
  }
}
