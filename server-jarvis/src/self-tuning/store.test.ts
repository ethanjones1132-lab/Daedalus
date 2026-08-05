import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SelfTuningStore } from "./store";

/**
 * 2026-08-05 live incident: the deployed runtime logged
 *   `SelfTuningStore: open failed: SQLiteError: no such column: stage_run_id`
 * and recorded ZERO telemetry for an entire session â€” no agent_runs, no
 * stage_runs, no reward. Every downstream measurement (Phase A exit criterion,
 * Phase B reward, replay harness, benchmark) reads this store, so the whole
 * evidence layer was dark in the shipped build.
 *
 * Cause: `CREATE INDEX ... ON model_attributions(stage_run_id)` sat in the base
 * schema block, which runs BEFORE the guarded ALTER that adds the column. On a
 * fresh database `CREATE TABLE` includes the column so the index succeeds; on a
 * PRE-EXISTING database `CREATE TABLE IF NOT EXISTS` is a no-op, the column is
 * absent, and the unguarded index throws â€” taking the entire schema exec down.
 *
 * The existing suite could never catch this: every other test opens `:memory:`
 * or a fresh file. These tests open a database created with an OLDER schema,
 * which is the only shape that reproduces it.
 */
describe("schema migrations apply to a pre-existing database", () => {
  function withLegacyDb(fn: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-legacy-db-"));
    const path = join(dir, "self-tuning.db");
    try {
      // Minimal pre-Task-1 shape: model_attributions WITHOUT stage_run_id.
      const seed = new Database(path, { create: true });
      seed.exec(`
        CREATE TABLE agent_runs (
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
        CREATE TABLE model_attributions (
          id TEXT PRIMARY KEY,
          agent_run_id TEXT NOT NULL,
          stage_id TEXT NOT NULL,
          agent_id TEXT,
          provider TEXT NOT NULL,
          model_id TEXT NOT NULL,
          was_successful INTEGER NOT NULL DEFAULT 0,
          had_error INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          first_token_ms INTEGER,
          fallback_used INTEGER NOT NULL DEFAULT 0,
          escalation_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);
      seed.close();
      fn(path);
    } finally {
      // Windows keeps the file handle while the store's connection is open;
      // teardown must never mask the assertion under test.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* temp dir reaped by the OS */ }
    }
  }

  test("opens a legacy database without throwing", () => {
    withLegacyDb((path) => {
      const store = new SelfTuningStore(path);
      expect(() =>
        store.insertAgentRun({
          id: "run_legacy",
          session_id: "sess_legacy",
          user_request: "req",
          task_type: "refactor",
          pipeline: JSON.stringify(["executor"]),
        completed: 0,
        }),
      ).not.toThrow();
    });
  });

  test("adds stage_run_id to a pre-existing model_attributions table", () => {
    withLegacyDb((path) => {
      const store = new SelfTuningStore(path);
      store.insertAgentRun({
        id: "run_legacy",
        session_id: "sess_legacy",
        user_request: "req",
        task_type: "refactor",
        pipeline: JSON.stringify(["executor"]),
        completed: 0,
      });
      store.insertModelAttribution({
        id: "attr_legacy",
        agent_run_id: "run_legacy",
        stage_id: "executor",
        stage_run_id: "stage_legacy",
        provider: "openrouter",
        model_id: "m",
        was_successful: 1,
        had_error: 0,
        fallback_used: 0,
      });

      const probe = new Database(path, { readonly: true });
      const cols = probe.query(`PRAGMA table_info(model_attributions)`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("stage_run_id");
      const row = probe
        .query(`SELECT stage_run_id FROM model_attributions WHERE id='attr_legacy'`)
        .get() as { stage_run_id: string } | null;
      expect(row?.stage_run_id).toBe("stage_legacy");
      probe.close();
    });
  });

  test("writes telemetry that downstream measurement can actually read", () => {
    withLegacyDb((path) => {
      const store = new SelfTuningStore(path);
      store.insertAgentRun({
        id: "run_legacy",
        session_id: "sess_legacy",
        user_request: "req",
        task_type: "refactor",
        pipeline: JSON.stringify(["executor"]),
        completed: 0,
      });

      const probe = new Database(path, { readonly: true });
      const n = probe.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number };
      expect(n.c).toBe(1);
      probe.close();
    });
  });
});

describe("model_attributions carry a stage_run_id", () => {
  test("attribution links to exactly one stage row", () => {
    const store = new SelfTuningStore(":memory:");
    store.insertAgentRun({
      id: "run_1",
      session_id: "sess_1",
      user_request: "req",
      task_type: "refactor",
      pipeline: JSON.stringify(["executor"]),
      completed: 0,
    });
    const stageId = "stage_abc";
    store.insertStageRun({
      id: stageId,
      agent_run_id: "run_1",
      mode_id: "executor",
      turn_number: 1,
      input_tokens: 10,
      output_tokens: 10,
      tool_calls_json: "[]",
      duration_ms: 100,
      was_successful: 1,
      had_error: 0,
    });
    store.insertModelAttribution({
      id: "attr_1",
      agent_run_id: "run_1",
      stage_id: "executor",
      stage_run_id: stageId,
      agent_id: "a",
      provider: "openrouter",
      model_id: "m",
      was_successful: 1,
      had_error: 0,
      duration_ms: 100,
      fallback_used: 0,
    });
    const rows = store.getModelAttributions("run_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage_run_id).toBe(stageId);
  });
});

describe("SelfTuningStore recent stage attributions", () => {
  test("returns newest-first rows for a stage since a cutoff and respects the limit", () => {
    const store = new SelfTuningStore(":memory:");
    const insertedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `attr-${i}`;
      insertedIds.push(id);
      store.insertModelAttribution({
        id,
        agent_run_id: `run-${i}`,
        stage_id: "coordinator",
        provider: "opencode_go",
        model_id: "deepseek-v4-flash",
        was_successful: i % 2 === 0 ? 1 : 0,
        had_error: i % 2 === 0 ? 0 : 1,
        fallback_used: 0,
      });
    }
    store.insertModelAttribution({
      id: "attr-other-stage",
      agent_run_id: "run-other-stage",
      stage_id: "executor",
      provider: "opencode_go",
      model_id: "deepseek-v4-flash",
      was_successful: 1,
      had_error: 0,
      fallback_used: 0,
    });

    const rows = store.getRecentStageAttributions("coordinator", "1970-01-01T00:00:00.000Z", 3);
    const futureRows = store.getRecentStageAttributions("coordinator", "2999-01-01T00:00:00.000Z", 3);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.stage_id)).toEqual(["coordinator", "coordinator", "coordinator"]);
    expect(rows.map((row) => row.id)).toEqual(insertedIds.slice(-3).reverse());
    expect(futureRows).toEqual([]);
  });
});

describe("SelfTuningStore delegate write scoreboard", () => {
  test("upserts, reads, and clears delegate write scoreboard rows", () => {
    const store = new SelfTuningStore(":memory:");
    expect(store.getAllDelegateWriteScoreboard()).toEqual([]);

    store.upsertDelegateWriteScoreboard({
      model: "minimax-m3",
      attempts: 123,
      verifiedWrites: 118,
      benched: false,
    });
    store.upsertDelegateWriteScoreboard({
      model: "cohere/north-mini-code:free",
      attempts: 3,
      verifiedWrites: 0,
      benched: true,
    });

    const all = store.getAllDelegateWriteScoreboard();
    expect(all).toHaveLength(2);
    expect(store.getDelegateWriteScoreboardRow("minimax-m3")).toMatchObject({
      model: "minimax-m3",
      attempts: 123,
      verified_writes: 118,
      benched: 0,
    });
    expect(store.getDelegateWriteScoreboardRow("cohere/north-mini-code:free")?.benched).toBe(1);

    store.upsertDelegateWriteScoreboard({
      model: "minimax-m3",
      attempts: 124,
      verifiedWrites: 119,
      benched: false,
    });
    expect(store.getDelegateWriteScoreboardRow("minimax-m3")?.attempts).toBe(124);

    store.clearDelegateWriteScoreboard();
    expect(store.getAllDelegateWriteScoreboard()).toEqual([]);
  });
});

describe("SelfTuningStore conductor outcome summaries", () => {
  test("aggregates recent task and pipeline outcomes in SQLite", () => {
    const store = new SelfTuningStore(":memory:");
    const insert = (index: number, taskType: string, pipeline: string[], outcome: string) => {
      const runId = `conductor-summary-run-${index}`;
      store.insertAgentRun({
        id: runId,
        session_id: "conductor-summary-session",
        user_request: "fixture",
        task_type: taskType,
        pipeline: JSON.stringify(pipeline),
        completed: 1,
      });
      store.insertConductorRun({
        id: `conductor-summary-${index}`,
        agent_run_id: runId,
        session_id: "conductor-summary-session",
        routing_json: "{}",
        conductor_source: "local",
        task_type: taskType,
        topology: "linear",
        pipeline_json: JSON.stringify(pipeline),
        normalized_pipeline_json: JSON.stringify(pipeline),
        run_outcome: outcome,
      });
    };

    insert(1, "debug", ["planner", "executor", "synthesizer"], "success");
    insert(2, "debug", ["planner", "executor", "synthesizer"], "success");
    insert(3, "debug", ["planner", "executor", "synthesizer"], "failed");
    insert(4, "refactor", ["executor", "reviewer", "synthesizer"], "success");

    const summaries = store.getRecentConductorOutcomeSummaries(7, 3);
    expect(summaries[0]).toMatchObject({
      task_type: "debug",
      pipeline_shape: JSON.stringify(["planner", "executor", "synthesizer"]),
      sample_count: 3,
      success_count: 2,
    });
    expect(Number(summaries[0]!.success_rate)).toBeCloseTo(2 / 3, 5);
    expect(summaries.some((summary) => summary.task_type === "refactor")).toBe(true);
  });
});

