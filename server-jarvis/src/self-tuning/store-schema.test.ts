import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, sep } from "path";
import { SELF_TUNING_SCHEMA_VERSION, SelfTuningStore } from "./store";

/**
 * DS-29 (2026-10-21 startup audit) regressions.
 *
 * Before this slice, `getDb()` ran the 25 additive `ALTER TABLE ... ADD COLUMN`
 * statements for the telemetry DB on *every* fresh process, each wrapped in an
 * unconditional `catch {}`. On an already-current file all 25 threw "duplicate
 * column name" and were swallowed, so:
 *   - the same 25 failing statements ran on every boot,
 *   - a genuine migration failure (locked DB, full disk, corrupt schema) was
 *     indistinguishable from "the column is already there", and
 *   - the only per-process guard was a module-level `Set` keyed by the literal
 *     path string, which does nothing across processes.
 *
 * These tests are deterministic SQLite behaviour tests: temp files only, no
 * sleeps, no wall-clock assertions, no production paths.
 *
 * A second "fresh process" is simulated by opening the *same file* through a
 * different literal path spelling (`dir/./file`). `schemaEnsuredPaths` is keyed
 * on the raw string, so that spelling misses the Set exactly as a new process
 * would, while SQLite still opens the same database. If the alias were somehow
 * normalised the schema log line would be missing and the assertions below fail
 * loudly rather than passing vacuously.
 */

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  agent_runs: [
    "outcome",
    "verified_via",
    "check_tier",
    "check_declined_reason",
    "reward_score",
    "reward_json",
  ],
  model_attributions: ["first_token_ms", "escalation_id", "stage_run_id"],
  conductor_directives: ["decision_source", "escalation_id"],
  stage_runs: ["stop_reason", "partial_error_code", "diagnostic_json", "failure_detail"],
  conductor_runs: ["latency_ms"],
  tuning_proposals: [
    "applied_at",
    "baseline_success_rate",
    "pre_apply_run_count",
    "pre_apply_run_ids",
  ],
  tuning_outcomes: ["measured", "baseline", "improved", "sample_n", "notes"],
};

/** The 25 additive columns the old unconditional ALTER block guaranteed. */
const REQUIRED_COLUMN_COUNT = Object.values(REQUIRED_COLUMNS).reduce(
  (total, columns) => total + columns.length,
  0,
);

function withTempDb(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-telemetry-schema-"));
  try {
    fn(join(dir, "self-tuning.db"));
  } finally {
    // Windows keeps handles briefly after a rolled-back migration; the native
    // rmSync retry options exist exactly for that. Teardown never masks an
    // assertion failure above.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch { /* temp dir is reaped by the OS */ }
  }
}

/** Same file, different literal path: misses the per-process Set like a new process. */
function freshProcessPath(path: string): string {
  return `${dirname(path)}${sep}.${sep}${basename(path)}`;
}

function readOnly<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function schemaVersion(path: string): number {
  return readOnly(path, (db) => {
    const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
    return Number(row?.user_version ?? 0);
  });
}

function columnNames(path: string, table: string): string[] {
  return readOnly(path, (db) => {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  });
}

function indexNames(path: string): string[] {
  return readOnly(path, (db) => {
    const rows = db
      .query(`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`)
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  });
}

interface CapturedOutput<T> {
  result: T;
  logs: string[];
  errors: string[];
  alters: string[];
}

/** Capture actual SQL attempts and the store's migration diagnostics. */
function captureOutput<T>(fn: () => T): CapturedOutput<T> {
  const logs: string[] = [];
  const errors: string[] = [];
  const alters: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExec = Database.prototype.exec;
  Database.prototype.exec = function (this: Database, ...args: Parameters<typeof originalExec>) {
    if (/\bALTER\s+TABLE\b/i.test(args[0])) alters.push(args[0]);
    return originalExec.apply(this, args);
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), logs, errors, alters };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    Database.prototype.exec = originalExec;
  }
}

/**
 * Supplemental migration counter. Actual ALTER attempts are observed separately
 * so a swallowed duplicate statement cannot masquerade as zero work.
 */
function reportedApplied(logs: string[]): number {
  const line = logs.find((entry) => entry.includes("[SelfTuningStore] schema ready"));
  expect(line).toBeDefined();
  const match = /applied=(\d+)/.exec(line ?? "");
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

function insertRun(store: SelfTuningStore, id: string): boolean {
  return store.insertAgentRun({
    id,
    session_id: "sess-schema-migration",
    user_request: "schema migration regression",
    task_type: "general",
    pipeline: JSON.stringify(["executor"]),
    completed: 1,
  });
}

const LEGACY_AGENT_RUNS_COLUMNS: readonly string[] = [
  "id TEXT PRIMARY KEY",
  "session_id TEXT NOT NULL",
  "user_request TEXT NOT NULL",
  "task_type TEXT NOT NULL",
  "pipeline TEXT NOT NULL",
  "completed INTEGER NOT NULL DEFAULT 0",
  "final_output TEXT",
  "user_rating INTEGER",
  "duration_ms INTEGER",
  "tool_calls_count INTEGER",
  "token_count INTEGER",
  "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
];

/**
 * v0 telemetry shape: the seven tables the additive migration touches, all
 * missing every column the migration adds. `partial` pre-adds three of them
 * (`outcome`, `verified_via`, `stage_run_id`), which is what an interrupted or
 * hand-fixed upgrade looks like.
 */
function legacyTelemetrySchema(options: { partial?: boolean } = {}): string {
  const agentRunsExtra = options.partial
    ? ",\n    outcome TEXT,\n    verified_via TEXT"
    : "";
  const attributionsExtra = options.partial ? ",\n    stage_run_id TEXT" : "";
  return `
    CREATE TABLE agent_runs (
      ${LEGACY_AGENT_RUNS_COLUMNS.join(",\n      ")}${agentRunsExtra}
    );
    CREATE TABLE stage_runs (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT NOT NULL,
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
      fallback_used INTEGER NOT NULL DEFAULT 0${attributionsExtra},
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE conductor_directives (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      directive_type TEXT NOT NULL,
      reason TEXT,
      new_remaining_json TEXT,
      inject_note TEXT,
      inject_for_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE conductor_runs (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT NOT NULL,
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
    CREATE TABLE tuning_proposals (
      id TEXT PRIMARY KEY,
      agent_run_id TEXT NOT NULL,
      proposal_type TEXT NOT NULL,
      task_type TEXT NOT NULL,
      current_value TEXT,
      proposed_value TEXT,
      rationale TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE tuning_outcomes (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      user_rating_delta REAL,
      token_delta REAL,
      success_rate_delta REAL,
      measured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `;
}

function seedLegacyDb(path: string, options: { partial?: boolean } = {}): void {
  const db = new Database(path, { create: true });
  try {
    db.exec(legacyTelemetrySchema(options));
    db.exec(`
      INSERT INTO agent_runs (id, session_id, user_request, task_type, pipeline, completed)
        VALUES ('run-seeded-before-upgrade', 'sess-legacy', 'legacy row', 'general', '["executor"]', 1);
      INSERT INTO model_attributions (id, agent_run_id, stage_id, provider, model_id, was_successful, had_error, fallback_used)
        VALUES ('attr-seeded-before-upgrade', 'run-seeded-before-upgrade', 'executor', 'openrouter', 'm', 1, 0, 0);
    `);
  } finally {
    db.close();
  }
}

function expectRequiredColumns(path: string): void {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    expect(columnNames(path, table)).toEqual(expect.arrayContaining([...columns]));
  }
}

describe("versioned telemetry schema migration", () => {
  test("a fresh file is stamped once and a later open applies zero ALTERs", () => {
    withTempDb((path) => {
      const first = new SelfTuningStore(path);
      const firstOpen = captureOutput(() => insertRun(first, "run-fresh-1"));
      expect(firstOpen.result).toBe(true);
      // A fresh file is created by SELF_TUNING_SCHEMA with every column already
      // present, so nothing needs ALTERing - but the version must be stamped, or
      // the next process re-runs the old 25 ALTER attempts.
      expect(reportedApplied(firstOpen.logs)).toBe(0);
      expect(firstOpen.alters).toEqual([]);
      expect(firstOpen.errors).toEqual([]);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);
      expectRequiredColumns(path);

      capabilityCheck(path);

      // Fresh-process equivalent: same file, path spelling the per-process Set
      // has never seen, so schema work actually runs again.
      const second = new SelfTuningStore(freshProcessPath(path));
      const secondOpen = captureOutput(() => insertRun(second, "run-fresh-2"));
      expect(secondOpen.result).toBe(true);
      expect(reportedApplied(secondOpen.logs)).toBe(0);
      expect(secondOpen.alters).toEqual([]);
      expect(secondOpen.errors).toEqual([]);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);

      const ids = readOnly(path, (db) =>
        (db.query("SELECT id FROM agent_runs ORDER BY id").all() as Array<{ id: string }>).map(
          (row) => row.id,
        ),
      );
      expect(ids).toEqual(["run-fresh-1", "run-fresh-2"]);
    });
  });

  test("a legacy v0 file upgrades once, keeps its rows, and is stamped", () => {
    withTempDb((path) => {
      seedLegacyDb(path);
      expect(schemaVersion(path)).toBe(0);

      const store = new SelfTuningStore(path);
      const upgrade = captureOutput(() => insertRun(store, "run-after-upgrade"));
      expect(upgrade.result).toBe(true);
      expect(upgrade.errors).toEqual([]);
      // Every one of the 25 required columns was genuinely absent.
      expect(REQUIRED_COLUMN_COUNT).toBe(25);
      expect(reportedApplied(upgrade.logs)).toBe(REQUIRED_COLUMN_COUNT);
      expect(upgrade.alters).toHaveLength(REQUIRED_COLUMN_COUNT);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);
      expectRequiredColumns(path);

      // The stage_run_id index can only exist if it was created after the
      // column: on this fixture the column did not exist when the file opened.
      expect(indexNames(path)).toContain("idx_model_attributions_stage_run_id");

      const probe = new Database(path);
      try {
        const seeded = probe
          .query("SELECT id, completed FROM agent_runs WHERE id='run-seeded-before-upgrade'")
          .get() as { id: string; completed: number } | null;
        expect(seeded).toEqual({ id: "run-seeded-before-upgrade", completed: 1 });
        const attributions = probe
          .query("SELECT COUNT(*) c FROM model_attributions WHERE id='attr-seeded-before-upgrade'")
          .get() as { c: number };
        expect(attributions.c).toBe(1);
        // Columns that arrived through the migration are writable through the
        // public path (the DS-29 index/column ordering incident's exact shape).
        probe
          .query(
            "UPDATE model_attributions SET stage_run_id='stage-upgraded' WHERE id='attr-seeded-before-upgrade'",
          )
          .run();
      } finally {
        probe.close();
      }

      // Second fresh process: no ALTER is attempted, the version does not move,
      // and the row written before it is still readable through the store.
      const second = new SelfTuningStore(freshProcessPath(path));
      const reopen = captureOutput(() => insertRun(second, "run-after-reopen"));
      expect(reopen.result).toBe(true);
      expect(reopen.errors).toEqual([]);
      expect(reportedApplied(reopen.logs)).toBe(0);
      expect(reopen.alters).toEqual([]);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);

      const rows = readOnly(path, (db) =>
        (db.query("SELECT id FROM agent_runs ORDER BY id").all() as Array<{ id: string }>).map(
          (row) => row.id,
        ),
      );
      expect(rows).toEqual([
        "run-after-reopen",
        "run-after-upgrade",
        "run-seeded-before-upgrade",
      ]);
      const attribution = readOnly(path, (db) =>
        db
          .query(
            "SELECT stage_run_id FROM model_attributions WHERE id='attr-seeded-before-upgrade'",
          )
          .get() as { stage_run_id: string | null } | null,
      );
      expect(attribution?.stage_run_id).toBe("stage-upgraded");
    });
  });

  test("a partially migrated v0 file only adds the columns that are missing", () => {
    withTempDb((path) => {
      seedLegacyDb(path, { partial: true });

      const store = new SelfTuningStore(path);
      const upgrade = captureOutput(() => insertRun(store, "run-partial-upgrade"));
      expect(upgrade.result).toBe(true);
      expect(upgrade.errors).toEqual([]);
      // outcome, verified_via and stage_run_id were already present.
      expect(reportedApplied(upgrade.logs)).toBe(REQUIRED_COLUMN_COUNT - 3);
      expect(upgrade.alters).toHaveLength(REQUIRED_COLUMN_COUNT - 3);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);
      expectRequiredColumns(path);

      const seeded = readOnly(path, (db) =>
        db
          .query("SELECT session_id FROM agent_runs WHERE id='run-seeded-before-upgrade'")
          .get() as { session_id: string } | null,
      );
      expect(seeded?.session_id).toBe("sess-legacy");

      const reopen = captureOutput(() => insertRun(store, "run-partial-second-call"));
      expect(reopen.result).toBe(true);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);
    });
  });

  test("a fully migrated v0 file is stamped without touching its columns", () => {
    withTempDb((path) => {
      // Build a v1-shaped file with the migration itself, then reset the marker
      // to 0: the exact "fully migrated but unversioned" upgrade shape.
      expect(insertRun(new SelfTuningStore(path), "run-pre-stamp")).toBe(true);
      const reset = new Database(path);
      try {
        reset.exec("PRAGMA user_version = 0");
      } finally {
        reset.close();
      }
      expect(schemaVersion(path)).toBe(0);

      const second = new SelfTuningStore(freshProcessPath(path));
      const stamp = captureOutput(() => insertRun(second, "run-stamped"));
      expect(stamp.result).toBe(true);
      expect(stamp.errors).toEqual([]);
      // Introspection, not a caught duplicate-column error: nothing to alter.
      expect(reportedApplied(stamp.logs)).toBe(0);
      expect(stamp.alters).toEqual([]);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);
      expectRequiredColumns(path);
    });
  });

  test("an up-to-date file is never re-ALTERed (the v1 marker is authoritative)", () => {
    withTempDb((path) => {
      expect(insertRun(new SelfTuningStore(path), "run-before-probe")).toBe(true);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);

      // Probe: an already-migrated column is renamed away behind the store's
      // back. Re-running the legacy ADD COLUMN block would silently add
      // `reward_score` back (the old swallow-the-duplicate behaviour); a
      // version-gated migration leaves the file alone.
      const probe = new Database(path);
      try {
        probe.exec("ALTER TABLE agent_runs RENAME COLUMN reward_score TO reward_score_prior");
      } finally {
        probe.close();
      }

      const second = new SelfTuningStore(freshProcessPath(path));
      const reopen = captureOutput(() => insertRun(second, "run-after-probe"));
      expect(reopen.result).toBe(true);
      expect(reopen.errors).toEqual([]);
      expect(reportedApplied(reopen.logs)).toBe(0);
      const columns = columnNames(path, "agent_runs");
      expect(columns).toContain("reward_score_prior");
      expect(columns).not.toContain("reward_score");
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);
    });
  });

  test("a newer/foreign schema version is never overwritten", () => {
    withTempDb((path) => {
      expect(insertRun(new SelfTuningStore(path), "run-before-foreign-version")).toBe(true);
      const foreign = new Database(path);
      try {
        foreign.exec("PRAGMA user_version = 7");
        foreign.exec("ALTER TABLE agent_runs RENAME COLUMN reward_json TO reward_json_future");
      } finally {
        foreign.close();
      }

      const second = new SelfTuningStore(freshProcessPath(path));
      const reopen = captureOutput(() => insertRun(second, "run-after-foreign-version"));
      expect(reopen.result).toBe(true);
      expect(reopen.errors).toEqual([]);
      expect(schemaVersion(path)).toBe(7);
      const columns = columnNames(path, "agent_runs");
      expect(columns).toContain("reward_json_future");
      expect(columns).not.toContain("reward_json");
    });
  });

  test("a failed second ALTER rolls back earlier columns and base schema creation", () => {
    withTempDb((path) => {
      seedLegacyDb(path);
      const originalExec = Database.prototype.exec;
      let failed: CapturedOutput<boolean>;
      Database.prototype.exec = function (this: Database, ...args: Parameters<typeof originalExec>) {
        if (/ALTER TABLE agent_runs ADD COLUMN verified_via/i.test(args[0])) {
          throw new Error("injected schema write failure");
        }
        return originalExec.apply(this, args);
      };
      const store = new SelfTuningStore(path);
      try {
        failed = captureOutput(() => insertRun(store, "run-aborted-upgrade"));
      } finally {
        Database.prototype.exec = originalExec;
      }
      expect(failed.result).toBe(false);
      expect(failed.errors.join("\n")).toContain("injected schema write failure");
      expect(failed.alters).toHaveLength(2);
      expect(schemaVersion(path)).toBe(0);
      expect(columnNames(path, "agent_runs")).not.toContain("outcome");
      expect(readOnly(path, (db) => db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='trajectory_snapshots'",
      ).get())).toBeNull();
      const retried = captureOutput(() => insertRun(store, "run-recovered-upgrade"));
      expect(retried.result).toBe(true);
      expect(retried.alters).toHaveLength(REQUIRED_COLUMN_COUNT);
      expectRequiredColumns(path);
    });
  });

  test("a genuine migration failure marks nothing, rolls back, and recovers on retry", () => {
    withTempDb((path) => {
      // v0 agent_runs already at SQLite's column ceiling (SQLITE_MAX_COLUMN,
      // 2000): the first required ADD COLUMN now fails for a real reason
      // ("too many columns"), not because the column is already present. This
      // is the failure class the old `catch {}` swallowed.
      const fillerCount = 2000 - LEGACY_AGENT_RUNS_COLUMNS.length;
      const fillers = Array.from({ length: fillerCount }, (_, index) => `filler_${index} TEXT`);
      const seed = new Database(path, { create: true });
      try {
        seed.exec(`CREATE TABLE agent_runs (${[...LEGACY_AGENT_RUNS_COLUMNS, ...fillers].join(",\n")});`);
        seed.exec(`
          INSERT INTO agent_runs (id, session_id, user_request, task_type, pipeline, completed)
            VALUES ('run-seeded-before-failure', 'sess-failure', 'pre-existing row', 'general', '["executor"]', 1);
        `);
      } finally {
        seed.close();
      }

      const store = new SelfTuningStore(path);
      const failed = captureOutput(() => insertRun(store, "run-during-failure"));
      // Public fail-closed contract is unchanged: the write reports false and
      // the failure is logged, never retried into a silent success.
      expect(failed.result).toBe(false);
      expect(failed.errors.join("\n")).toContain("[SelfTuningStore] open failed");
      expect(failed.logs.some((line) => line.includes("schema ready"))).toBe(false);
      // Nothing was marked: the version is still 0 and no partial DDL survived
      // the rollback.
      expect(schemaVersion(path)).toBe(0);
      expect(columnNames(path, "agent_runs")).not.toContain("outcome");
      expect(columnNames(path, "agent_runs")).toHaveLength(2000);

      // Repair the real cause, then open again through the SAME store instance:
      // a failed migration must not leave a schemaEnsuredPaths entry, so this
      // call re-runs the migration and succeeds.
      const repair = new Database(path);
      try {
        for (let index = 0; index < REQUIRED_COLUMNS.agent_runs!.length; index++) {
          repair.exec(`ALTER TABLE agent_runs DROP COLUMN filler_${index}`);
        }
      } finally {
        repair.close();
      }

      const retried = captureOutput(() => insertRun(store, "run-after-retry"));
      expect(retried.result).toBe(true);
      expect(retried.errors).toEqual([]);
      expect(reportedApplied(retried.logs)).toBe(REQUIRED_COLUMNS.agent_runs!.length);
      expect(schemaVersion(path)).toBe(SELF_TUNING_SCHEMA_VERSION);
      expectRequiredColumns(path);

      const ids = readOnly(path, (db) =>
        (db.query("SELECT id FROM agent_runs ORDER BY id").all() as Array<{ id: string }>).map(
          (row) => row.id,
        ),
      );
      expect(ids).toEqual(["run-after-retry", "run-seeded-before-failure"]);
    });
  });
});

/**
 * Sanity helper used by the fresh-file case: the columns really are there and
 * writable, so `applied=0` is "already current", never "nothing happened".
 */
function capabilityCheck(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      INSERT INTO stage_runs (id, agent_run_id, mode_id, turn_number, was_successful, had_error)
        VALUES ('stage-fresh', 'run-fresh-1', 'executor', 1, 1, 0);
      INSERT INTO model_attributions (id, agent_run_id, stage_id, provider, model_id, was_successful, had_error, fallback_used, stage_run_id)
        VALUES ('attr-fresh', 'run-fresh-1', 'executor', 'openrouter', 'm', 1, 0, 0, 'stage-fresh');
    `);
  } finally {
    db.close();
  }
}
