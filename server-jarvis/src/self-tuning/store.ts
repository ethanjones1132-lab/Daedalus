import { Database, SQLQueryBindings } from "bun:sqlite";
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

/** Auditable directive emitted by the optional live conductor. */
export interface ConductorDirectiveRow {
  id: string;
  agent_run_id: string;
  stage: string;
  directive_type: string;
  reason?: string;
  new_remaining_json?: string;
  inject_note?: string;
  inject_for_stage?: string;
  created_at?: string;
}

/** Phase 4: conductor routing decision paired with eventual pipeline outcome. */
export interface ConductorRun {
  id: string;
  agent_run_id: string;
  session_id: string;
  routing_json: string;
  conductor_source: string;
  conductor_model?: string;
  task_type: string;
  topology: string;
  pipeline_json: string;
  normalized_pipeline_json?: string;
  route_source?: string;
  run_outcome?: string;
  created_at?: string;
}

/** Phase 4: worker instruction variant → stage outcome. */
export interface WorkerInstructionOutcome {
  id: string;
  agent_run_id: string;
  stage_id: string;
  instruction_hash: string;
  instruction_variant: string;
  instruction_text?: string;
  was_successful: number;
  had_error: number;
  created_at?: string;
}

/** Phase 4: model/provider attribution per pipeline stage. */
export interface ModelAttribution {
  id: string;
  agent_run_id: string;
  stage_id: string;
  agent_id?: string;
  provider: string;
  model_id: string;
  was_successful: number;
  had_error: number;
  duration_ms?: number;
  /** Wall time from request dispatch to first semantic stream progress. */
  first_token_ms?: number;
  fallback_used: number;
  created_at?: string;
}

/** Phase 4: multi-turn trajectory for future GRPO training. */
export interface TrajectorySnapshot {
  id: string;
  agent_run_id: string;
  session_id: string;
  snapshot_json: string;
  created_at?: string;
}

/** Phase 4: rolling agent performance aggregates. */
export interface AgentPerformanceRow {
  agent_id: string;
  stage_id: string;
  task_type: string;
  success_count: number;
  failure_count: number;
  total_duration_ms: number;
  sample_count: number;
  last_updated?: string;
}

/** Phase 4: instruction variant bandit stats. */
export interface InstructionVariantRow {
  variant_id: string;
  stage_id: string;
  task_type: string;
  success_count: number;
  failure_count: number;
  sample_count: number;
  last_updated?: string;
}

/**
 * B-04: per-replan telemetry row. One row is written every time the
 * `conductor_replan` loop re-invokes the conductor mid-pipeline. Survives
 * restart so a "did the conductor start thrashing?" question can be answered
 * with a single SQL query, not a log scrape. The `capped` column marks
 * whether the loop terminated because of the per-turn budget (`"per_turn"`)
 * or the per-session budget (`"per_session"`); empty string means the loop
 * completed normally without hitting a cap.
 */
export interface ReplanEvent {
  id: string;
  agent_run_id: string;
  session_id: string;
  /** 1-indexed position of THIS replan within its turn (1, 2, 3, ...). */
  replan_index: number;
  /** Coordinator's rationale, truncated to a sane bound for the DB. */
  rationale: string;
  /** JSON-encoded array of stages the conductor returned. */
  revised_pipeline: string;
  /** Comma-separated keys of the `worker_instructions` map, e.g. "executor,reviewer". */
  revised_worker_instructions_keys: string;
  /** Outcome of the segment that was just executed before this replan. */
  segment_outcome: string;
  /** "" (no cap hit) | "per_turn" | "per_session". */
  capped: string;
  created_at?: string;
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
  CREATE INDEX IF NOT EXISTS idx_conductor_directives_agent_run_id ON conductor_directives(agent_run_id);
  CREATE TABLE IF NOT EXISTS conductor_runs (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    routing_json TEXT NOT NULL,
    conductor_source TEXT NOT NULL,
    conductor_model TEXT,
    task_type TEXT NOT NULL,
    topology TEXT NOT NULL,
    pipeline_json TEXT NOT NULL,
    normalized_pipeline_json TEXT,
    route_source TEXT,
    run_outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conductor_runs_agent_run_id ON conductor_runs(agent_run_id);
  CREATE TABLE IF NOT EXISTS worker_instruction_outcomes (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    stage_id TEXT NOT NULL,
    instruction_hash TEXT NOT NULL,
    instruction_variant TEXT NOT NULL,
    instruction_text TEXT,
    was_successful INTEGER NOT NULL DEFAULT 0,
    had_error INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_worker_instruction_outcomes_agent_run_id ON worker_instruction_outcomes(agent_run_id);
  CREATE TABLE IF NOT EXISTS model_attributions (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    stage_id TEXT NOT NULL,
    agent_id TEXT,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    was_successful INTEGER NOT NULL DEFAULT 0,
    had_error INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    first_token_ms INTEGER,
    fallback_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_model_attributions_agent_run_id ON model_attributions(agent_run_id);
  CREATE TABLE IF NOT EXISTS trajectory_snapshots (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trajectory_snapshots_agent_run_id ON trajectory_snapshots(agent_run_id);
  CREATE TABLE IF NOT EXISTS agent_performance (
    agent_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    total_duration_ms INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (agent_id, stage_id, task_type)
  );
  CREATE TABLE IF NOT EXISTS instruction_variant_stats (
    variant_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (variant_id, stage_id, task_type)
  );
  CREATE TABLE IF NOT EXISTS replan_events (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    replan_index INTEGER NOT NULL,
    rationale TEXT NOT NULL,
    revised_pipeline TEXT NOT NULL,
    revised_worker_instructions_keys TEXT NOT NULL,
    segment_outcome TEXT NOT NULL,
    capped TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_replan_events_session_id ON replan_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_replan_events_agent_run_id ON replan_events(agent_run_id);
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
      // 2026-07-13 finding: several orchestration.test.ts cases construct
      // PipelineExecutor with a ConductorWiring object ({ bus, live }, no
      // `.collector` field) or with `undefined` for the collector arg. Both
      // fall through to the default `new SelfTuningStore()` (no override),
      // which then wrote straight into the REAL production self-tuning.db
      // on every `bun test` run — confirmed via sentinel agent_run_ids
      // "run-abort"/"run-record-1" (no parent agent_runs row) polluting
      // production data and inflating apparent stage error rates in any
      // aggregate diagnosis. `bun test` sets NODE_ENV=test automatically
      // (verified empirically), so a caller with no EXPLICIT override
      // during a test run gets a safe, fully-functional in-memory DB
      // instead — this is a systemic guard, not a per-call-site patch, so
      // it protects every future test that makes the same mistake too. An
      // explicit dbPathOverride (including passing ":memory:" directly,
      // handled by the next branch) always wins over this guard.
      if (!this.dbPathOverride && process.env.NODE_ENV === "test") {
        if (!this.cachedDb) {
          const db = new Database(":memory:");
          db.exec(SELF_TUNING_SCHEMA);
          db.close = () => {};
          this.cachedDb = db;
        }
        return this.cachedDb;
      }
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
        // Task 4.2: state the resolved sink once per process. The 2026-07-12
        // re-audit initially declared this collector "dark" because it
        // queried the vestigial June-era stage_runs tables in jarvis.db —
        // production telemetry actually lives here. One log line makes the
        // real sink discoverable from the server log instead of forensics.
        console.log(`[SelfTuningStore] telemetry sink: ${dbPath}`);
        db.exec(SELF_TUNING_SCHEMA);
        // Guarded migration: add the `outcome` column to pre-existing agent_runs
        // tables (CREATE TABLE IF NOT EXISTS won't ALTER an existing table). The
        // duplicate-column error on an already-migrated DB is expected and ignored.
        try {
          db.exec(`ALTER TABLE agent_runs ADD COLUMN outcome TEXT`);
        } catch { /* column already exists */ }
        try {
          db.exec(`ALTER TABLE model_attributions ADD COLUMN first_token_ms INTEGER`);
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

  /** Runs matching any of `taskTypes` with `created_at` in `[startIsoInclusive, endIsoExclusive)`.
   *  Backs the D5 "performance since promotion" panel — see `computeCandidatePerformance`
   *  in `intelligence/skill-promotion.ts`, which supplies this as its `fetchRuns` callback. */
  getAgentRunsForTaskTypesInWindow(
    taskTypes: string[],
    startIsoInclusive: string,
    endIsoExclusive: string,
  ): AgentRun[] {
    const db = this.getDb();
    if (!db || taskTypes.length === 0) return [];
    try {
      const placeholders = taskTypes.map(() => "?").join(",");
      return db
        .query(
          `SELECT * FROM agent_runs WHERE task_type IN (${placeholders}) AND created_at >= ? AND created_at < ? ORDER BY created_at ASC`,
        )
        .all(...taskTypes, startIsoInclusive, endIsoExclusive) as AgentRun[];
    } catch (e) {
      console.error("[SelfTuningStore] getAgentRunsForTaskTypesInWindow failed:", e);
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

  insertConductorRun(run: ConductorRun): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO conductor_runs (id, agent_run_id, session_id, routing_json, conductor_source, conductor_model, task_type, topology, pipeline_json, normalized_pipeline_json, route_source, run_outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.agent_run_id,
        run.session_id,
        run.routing_json,
        run.conductor_source,
        run.conductor_model ?? null,
        run.task_type,
        run.topology,
        run.pipeline_json,
        run.normalized_pipeline_json ?? null,
        run.route_source ?? null,
        run.run_outcome ?? null,
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertConductorRun failed:", e);
    } finally {
      db.close();
    }
  }

  insertConductorDirective(directive: ConductorDirectiveRow): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO conductor_directives
          (id, agent_run_id, stage, directive_type, reason, new_remaining_json, inject_note, inject_for_stage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        directive.id,
        directive.agent_run_id,
        directive.stage,
        directive.directive_type,
        directive.reason ?? null,
        directive.new_remaining_json ?? null,
        directive.inject_note ?? null,
        directive.inject_for_stage ?? null,
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertConductorDirective failed:", e);
    } finally {
      db.close();
    }
  }

  updateConductorRun(id: string, updates: Partial<ConductorRun>): void {
    const db = this.getDb();
    if (!db) return;
    try {
      const keys = Object.keys(updates);
      if (keys.length === 0) return;
      const setClause = keys.map((k) => `${k} = ?`).join(", ");
      const params = keys.map((k) => (updates as Record<string, unknown>)[k]);
      params.push(id);
      db.prepare(`UPDATE conductor_runs SET ${setClause} WHERE id = ?`).run(...(params as unknown as SQLQueryBindings[]));
    } catch (e) {
      console.error("[SelfTuningStore] updateConductorRun failed:", e);
    } finally {
      db.close();
    }
  }

  insertWorkerInstructionOutcome(row: WorkerInstructionOutcome): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO worker_instruction_outcomes (id, agent_run_id, stage_id, instruction_hash, instruction_variant, instruction_text, was_successful, had_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.agent_run_id,
        row.stage_id,
        row.instruction_hash,
        row.instruction_variant,
        row.instruction_text ?? null,
        row.was_successful,
        row.had_error,
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertWorkerInstructionOutcome failed:", e);
    } finally {
      db.close();
    }
  }

  insertModelAttribution(row: ModelAttribution): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO model_attributions (id, agent_run_id, stage_id, agent_id, provider, model_id, was_successful, had_error, duration_ms, first_token_ms, fallback_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.agent_run_id,
        row.stage_id,
        row.agent_id ?? null,
        row.provider,
        row.model_id,
        row.was_successful,
        row.had_error,
        row.duration_ms ?? null,
        row.first_token_ms ?? null,
        row.fallback_used,
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertModelAttribution failed:", e);
    } finally {
      db.close();
    }
  }

  insertTrajectorySnapshot(snapshot: TrajectorySnapshot): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO trajectory_snapshots (id, agent_run_id, session_id, snapshot_json)
         VALUES (?, ?, ?, ?)`,
      ).run(snapshot.id, snapshot.agent_run_id, snapshot.session_id, snapshot.snapshot_json);
    } catch (e) {
      console.error("[SelfTuningStore] insertTrajectorySnapshot failed:", e);
    } finally {
      db.close();
    }
  }

  pruneTrajectorySnapshots(maxRows: number): void {
    const db = this.getDb();
    if (!db) return;
    try {
      const count = (db.query("SELECT COUNT(*) as c FROM trajectory_snapshots").get() as { c: number }).c;
      if (count <= maxRows) return;
      const excess = count - maxRows;
      db.prepare(
        `DELETE FROM trajectory_snapshots WHERE id IN (
          SELECT id FROM trajectory_snapshots ORDER BY created_at ASC LIMIT ?
        )`,
      ).run(excess);
    } catch (e) {
      console.error("[SelfTuningStore] pruneTrajectorySnapshots failed:", e);
    } finally {
      db.close();
    }
  }

  upsertAgentPerformance(
    agentId: string,
    stageId: string,
    taskType: string,
    success: boolean,
    durationMs: number,
  ): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO agent_performance (agent_id, stage_id, task_type, success_count, failure_count, total_duration_ms, sample_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(agent_id, stage_id, task_type) DO UPDATE SET
           success_count = success_count + excluded.success_count,
           failure_count = failure_count + excluded.failure_count,
           total_duration_ms = total_duration_ms + excluded.total_duration_ms,
           sample_count = sample_count + 1,
           last_updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(
        agentId,
        stageId,
        taskType,
        success ? 1 : 0,
        success ? 0 : 1,
        durationMs,
      );
    } catch (e) {
      console.error("[SelfTuningStore] upsertAgentPerformance failed:", e);
    } finally {
      db.close();
    }
  }

  upsertInstructionVariantStats(
    variantId: string,
    stageId: string,
    taskType: string,
    success: boolean,
  ): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO instruction_variant_stats (variant_id, stage_id, task_type, success_count, failure_count, sample_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(variant_id, stage_id, task_type) DO UPDATE SET
           success_count = success_count + excluded.success_count,
           failure_count = failure_count + excluded.failure_count,
           sample_count = sample_count + 1,
           last_updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(variantId, stageId, taskType, success ? 1 : 0, success ? 0 : 1);
    } catch (e) {
      console.error("[SelfTuningStore] upsertInstructionVariantStats failed:", e);
    } finally {
      db.close();
    }
  }

  getAgentPerformance(taskType?: string): AgentPerformanceRow[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      if (taskType) {
        return db.query("SELECT * FROM agent_performance WHERE task_type = ?").all(taskType) as AgentPerformanceRow[];
      }
      return db.query("SELECT * FROM agent_performance").all() as AgentPerformanceRow[];
    } catch (e) {
      console.error("[SelfTuningStore] getAgentPerformance failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getInstructionVariantStats(taskType?: string): InstructionVariantRow[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      if (taskType) {
        return db.query("SELECT * FROM instruction_variant_stats WHERE task_type = ?").all(taskType) as InstructionVariantRow[];
      }
      return db.query("SELECT * FROM instruction_variant_stats").all() as InstructionVariantRow[];
    } catch (e) {
      console.error("[SelfTuningStore] getInstructionVariantStats failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getConductorRuns(agentRunId?: string): ConductorRun[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      if (agentRunId) {
        return db.query("SELECT * FROM conductor_runs WHERE agent_run_id = ?").all(agentRunId) as ConductorRun[];
      }
      return db.query("SELECT * FROM conductor_runs ORDER BY created_at DESC").all() as ConductorRun[];
    } catch (e) {
      console.error("[SelfTuningStore] getConductorRuns failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getConductorDirectives(agentRunId: string): ConductorDirectiveRow[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query(
        "SELECT * FROM conductor_directives WHERE agent_run_id = ? ORDER BY created_at ASC",
      ).all(agentRunId) as ConductorDirectiveRow[];
    } catch (e) {
      console.error("[SelfTuningStore] getConductorDirectives failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getModelAttributions(agentRunId: string): ModelAttribution[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query("SELECT * FROM model_attributions WHERE agent_run_id = ?").all(agentRunId) as ModelAttribution[];
    } catch (e) {
      console.error("[SelfTuningStore] getModelAttributions failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  getTrajectorySnapshots(limit = 50): TrajectorySnapshot[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query("SELECT * FROM trajectory_snapshots ORDER BY created_at DESC LIMIT ?").all(limit) as TrajectorySnapshot[];
    } catch (e) {
      console.error("[SelfTuningStore] getTrajectorySnapshots failed:", e);
      return [];
    } finally {
      db.close();
    }
  }

  // B-04: replan telemetry. One row per `conductor_replan` re-invocation.
  // Insert errors are logged and swallowed (telemetry must never break a turn).
  insertReplanEvent(ev: ReplanEvent): void {
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO replan_events (id, agent_run_id, session_id, replan_index, rationale, revised_pipeline, revised_worker_instructions_keys, segment_outcome, capped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ev.id,
        ev.agent_run_id,
        ev.session_id,
        ev.replan_index,
        ev.rationale,
        ev.revised_pipeline,
        ev.revised_worker_instructions_keys,
        ev.segment_outcome,
        ev.capped ?? "",
      );
    } catch (e) {
      console.error("[SelfTuningStore] insertReplanEvent failed:", e);
    } finally {
      db.close();
    }
  }

  getReplanEventsForSession(sessionId: string): ReplanEvent[] {
    const db = this.getDb();
    if (!db) return [];
    try {
      return db.query("SELECT * FROM replan_events WHERE session_id = ? ORDER BY created_at ASC, replan_index ASC").all(sessionId) as ReplanEvent[];
    } catch (e) {
      console.error("[SelfTuningStore] getReplanEventsForSession failed:", e);
      return [];
    } finally {
      db.close();
    }
  }
}
