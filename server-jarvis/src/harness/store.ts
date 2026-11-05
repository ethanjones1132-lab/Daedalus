import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join, posix, win32 } from "path";
import { homedir } from "os";
import { manifestHash, validateManifest, type HarnessManifest } from "./manifest";

const MAX_OUTPUT_BYTES = 64 * 1024;

const HARNESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS harness_manifests (
    project_root TEXT NOT NULL,
    id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    revision INTEGER NOT NULL,
    manifest_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_root, id)
  );
  CREATE TABLE IF NOT EXISTS harness_manifest_revisions (
    project_root TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    manifest_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_root, manifest_id, revision)
  );
  CREATE TABLE IF NOT EXISTS harness_runs (
    id TEXT PRIMARY KEY,
    project_root TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_harness_runs_project ON harness_runs(project_root, created_at);
  CREATE TABLE IF NOT EXISTS harness_rounds (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES harness_runs(id),
    round_number INTEGER NOT NULL,
    counter_vector_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, round_number)
  );
  CREATE TABLE IF NOT EXISTS harness_sensor_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES harness_runs(id),
    round_id TEXT NOT NULL REFERENCES harness_rounds(id),
    sensor_id TEXT NOT NULL,
    status TEXT NOT NULL,
    counter INTEGER,
    exit_code INTEGER,
    stdout TEXT NOT NULL,
    stdout_truncated INTEGER NOT NULL,
    stderr TEXT NOT NULL,
    stderr_truncated INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS harness_approvals (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL,
    project_root TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    decision TEXT NOT NULL,
    decided_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_harness_approvals_binding
    ON harness_approvals(command_id, project_root, manifest_hash, decided_at);
  CREATE TABLE IF NOT EXISTS harness_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES harness_runs(id),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

function serverStateDbPath(): string {
  const path = join(homedir(), ".openclaw", "jarvis", "server-state.db");
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* best effort */ }
  return path;
}

function boundedOutput(output: string): { value: string; truncated: boolean } {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return { value: output, truncated: false };
  return { value: bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"), truncated: true };
}

function now(): string { return new Date().toISOString(); }
function newId(): string { return crypto.randomUUID(); }
function isCanonicalRoot(root: string): boolean {
  if (!root || root.trim() !== root || root.split(/[\\/]+/).some((part) => part === "." || part === "..")) return false;
  return (posix.isAbsolute(root) && !root.includes("\\") && posix.normalize(root) === root) ||
    (win32.isAbsolute(root) && win32.normalize(root) === root);
}

export interface HarnessStoreOptions { dbPath?: string }
export interface SavedManifest { manifest: HarnessManifest; revision: number; manifest_hash: string }
export interface HarnessRunInput {
  id?: string;
  project_root: string;
  manifest_id: string;
  manifest_hash: string;
  status?: string;
}
export interface HarnessRun {
  id: string;
  project_root: string;
  manifest_id: string;
  manifest_hash: string;
  status: string;
  created_at: string;
  rounds: HarnessRound[];
  events: HarnessEvent[];
}
export interface HarnessRoundInput {
  id?: string;
  run_id: string;
  round_number: number;
  counter_vector: Record<string, number | null | "not_applicable">;
}
export interface HarnessRound extends Omit<HarnessRoundInput, "id"> { id: string; created_at: string; sensor_results: HarnessSensorResult[] }
export interface HarnessSensorResultInput {
  id?: string;
  run_id: string;
  round_id: string;
  sensor_id: string;
  status: "passed" | "failed" | "not_applicable";
  counter?: number | null;
  exit_code?: number | null;
  stdout: string;
  stderr: string;
}
export interface HarnessSensorResult extends Omit<HarnessSensorResultInput, "id" | "stdout" | "stderr"> {
  id: string; stdout: string; stdout_truncated: boolean; stderr: string; stderr_truncated: boolean; created_at: string;
}
export interface HarnessApprovalInput {
  command_id: string;
  project_root: string;
  manifest_hash: string;
  decision: "approved" | "denied";
  decided_at?: string;
}
export interface HarnessApproval extends HarnessApprovalInput { id: string; decided_at: string }
export interface HarnessEventInput { id?: string; run_id: string; event_type: string; payload: unknown }
export interface HarnessEvent { id: string; run_id: string; event_type: string; payload: unknown; created_at: string }

/** Durable app-owned manifest and append-only run evidence store. */
export class HarnessStore {
  private readonly dbPath: string;
  private memoryDb: Database | null = null;

  constructor(options: HarnessStoreOptions = {}) { this.dbPath = options.dbPath ?? serverStateDbPath(); }

  private open(): Database {
    if (this.dbPath === ":memory:") {
      if (!this.memoryDb) {
        const db = new Database(":memory:");
        db.exec(HARNESS_SCHEMA);
        db.close = () => {};
        this.memoryDb = db;
      }
      return this.memoryDb;
    }
    const db = new Database(this.dbPath, { create: true });
    db.exec(HARNESS_SCHEMA);
    return db;
  }

  saveManifest(manifest: HarnessManifest, expectedRevision: number): SavedManifest {
    const checked = validateManifest(manifest);
    if (!checked.ok) throw new Error(`Invalid harness manifest: ${checked.errors.join("; ")}`);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("expectedRevision must be a non-negative integer");
    const value = checked.manifest;
    const hash = manifestHash(value);
    const json = JSON.stringify(value);
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const current = db.query(
        "SELECT revision FROM harness_manifests WHERE project_root = ? AND id = ?",
      ).get(value.project_root, value.id) as { revision: number } | null;
      const revision = current?.revision ?? 0;
      if (revision !== expectedRevision) throw new Error(`Stale manifest revision: expected ${expectedRevision}, current ${revision}`);
      const nextRevision = revision + 1;
      const timestamp = now();
      db.prepare(`INSERT INTO harness_manifests (project_root, id, purpose, revision, manifest_hash, manifest_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_root, id) DO UPDATE SET purpose=excluded.purpose, revision=excluded.revision,
          manifest_hash=excluded.manifest_hash, manifest_json=excluded.manifest_json, updated_at=excluded.updated_at`)
        .run(value.project_root, value.id, value.purpose, nextRevision, hash, json, timestamp);
      db.prepare(`INSERT INTO harness_manifest_revisions (project_root, manifest_id, revision, manifest_hash, manifest_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(value.project_root, value.id, nextRevision, hash, json, timestamp);
      db.exec("COMMIT");
      return { manifest: value, revision: nextRevision, manifest_hash: hash };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    } finally { db.close(); }
  }

  getManifest(projectRoot: string, id: string): SavedManifest | undefined {
    const db = this.open();
    try {
      const row = db.query("SELECT revision, manifest_hash, manifest_json FROM harness_manifests WHERE project_root = ? AND id = ?")
        .get(projectRoot, id) as { revision: number; manifest_hash: string; manifest_json: string } | null;
      if (!row) return undefined;
      return { revision: row.revision, manifest_hash: row.manifest_hash, manifest: JSON.parse(row.manifest_json) as HarnessManifest };
    } finally { db.close(); }
  }

  listManifests(projectRoot: string): SavedManifest[] {
    const db = this.open();
    try {
      const rows = db.query("SELECT revision, manifest_hash, manifest_json FROM harness_manifests WHERE project_root = ? ORDER BY id")
        .all(projectRoot) as Array<{ revision: number; manifest_hash: string; manifest_json: string }>;
      return rows.map((row) => ({ revision: row.revision, manifest_hash: row.manifest_hash, manifest: JSON.parse(row.manifest_json) as HarnessManifest }));
    } finally { db.close(); }
  }

  createRun(input: HarnessRunInput): HarnessRun {
    if (!isCanonicalRoot(input.project_root)) throw new Error("project_root must be an absolute canonical path");
    const db = this.open();
    const run = { ...input, id: input.id ?? newId(), status: input.status ?? "running", created_at: now() };
    try {
      db.prepare("INSERT INTO harness_runs (id, project_root, manifest_id, manifest_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(run.id, run.project_root, run.manifest_id, run.manifest_hash, run.status, run.created_at);
      return { ...run, rounds: [], events: [] };
    } finally { db.close(); }
  }

  appendRound(input: HarnessRoundInput): HarnessRound {
    if (!Number.isInteger(input.round_number) || input.round_number < 1) throw new Error("round_number must be a positive integer");
    const round = { ...input, id: input.id ?? newId(), created_at: now() };
    const db = this.open();
    try {
      db.prepare("INSERT INTO harness_rounds (id, run_id, round_number, counter_vector_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(round.id, round.run_id, round.round_number, JSON.stringify(round.counter_vector), round.created_at);
      return { ...round, sensor_results: [] };
    } finally { db.close(); }
  }

  appendSensorResult(input: HarnessSensorResultInput): HarnessSensorResult {
    const stdout = boundedOutput(input.stdout);
    const stderr = boundedOutput(input.stderr);
    const result: HarnessSensorResult = {
      ...input, id: input.id ?? newId(), stdout: stdout.value, stdout_truncated: stdout.truncated,
      stderr: stderr.value, stderr_truncated: stderr.truncated, created_at: now(),
    };
    const db = this.open();
    try {
      db.prepare(`INSERT INTO harness_sensor_results
        (id, run_id, round_id, sensor_id, status, counter, exit_code, stdout, stdout_truncated, stderr, stderr_truncated, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(result.id, result.run_id, result.round_id, result.sensor_id, result.status, result.counter ?? null,
          result.exit_code ?? null, result.stdout, Number(result.stdout_truncated), result.stderr, Number(result.stderr_truncated), result.created_at);
      return result;
    } finally { db.close(); }
  }

  recordApproval(input: HarnessApprovalInput): HarnessApproval {
    if (!isCanonicalRoot(input.project_root)) throw new Error("project_root must be an absolute canonical path");
    const approval = { ...input, id: newId(), decided_at: input.decided_at ?? now() };
    const db = this.open();
    try {
      db.prepare("INSERT INTO harness_approvals (id, command_id, project_root, manifest_hash, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(approval.id, approval.command_id, approval.project_root, approval.manifest_hash, approval.decision, approval.decided_at);
      return approval;
    } finally { db.close(); }
  }

  findApproval(commandId: string, projectRoot: string, hash: string): HarnessApproval | undefined {
    if (!isCanonicalRoot(projectRoot)) return undefined;
    const db = this.open();
    try {
      const row = db.query(`SELECT id, command_id, project_root, manifest_hash, decision, decided_at FROM harness_approvals
        WHERE command_id = ? AND project_root = ? AND manifest_hash = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1`)
        .get(commandId, projectRoot, hash) as HarnessApproval | null;
      return row ?? undefined;
    } finally { db.close(); }
  }

  appendEvent(input: HarnessEventInput): HarnessEvent {
    const event = { id: input.id ?? newId(), run_id: input.run_id, event_type: input.event_type, payload: input.payload, created_at: now() };
    const db = this.open();
    try {
      db.prepare("INSERT INTO harness_events (id, run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(event.id, event.run_id, event.event_type, JSON.stringify(event.payload) ?? "null", event.created_at);
      return event;
    } finally { db.close(); }
  }

  listRuns(projectRoot: string): HarnessRun[] {
    const db = this.open();
    try {
      const rows = db.query("SELECT id FROM harness_runs WHERE project_root = ? ORDER BY created_at DESC, rowid DESC").all(projectRoot) as Array<{ id: string }>;
      return rows.map(({ id }) => this.getRun(id)!).filter(Boolean);
    } finally { db.close(); }
  }

  getRun(id: string): HarnessRun | undefined {
    const db = this.open();
    try {
      const row = db.query("SELECT id, project_root, manifest_id, manifest_hash, status, created_at FROM harness_runs WHERE id = ?")
        .get(id) as Omit<HarnessRun, "rounds" | "events"> | null;
      if (!row) return undefined;
      const rounds = db.query("SELECT id, run_id, round_number, counter_vector_json, created_at FROM harness_rounds WHERE run_id = ? ORDER BY round_number")
        .all(id) as Array<{ id: string; run_id: string; round_number: number; counter_vector_json: string; created_at: string }>;
      const sensorRows = db.query("SELECT * FROM harness_sensor_results WHERE run_id = ? ORDER BY created_at, rowid").all(id) as Array<Record<string, unknown>>;
      const results: HarnessSensorResult[] = sensorRows.map((result) => ({
        id: String(result.id), run_id: String(result.run_id), round_id: String(result.round_id), sensor_id: String(result.sensor_id),
        status: result.status as HarnessSensorResult["status"], counter: result.counter as number | null,
        exit_code: result.exit_code as number | null, stdout: String(result.stdout), stdout_truncated: Boolean(result.stdout_truncated),
        stderr: String(result.stderr), stderr_truncated: Boolean(result.stderr_truncated), created_at: String(result.created_at),
      }));
      const events = db.query("SELECT id, run_id, event_type, payload_json, created_at FROM harness_events WHERE run_id = ? ORDER BY created_at, rowid")
        .all(id) as Array<{ id: string; run_id: string; event_type: string; payload_json: string; created_at: string }>;
      return {
        ...row,
        rounds: rounds.map((round) => ({ id: round.id, run_id: round.run_id, round_number: round.round_number,
          counter_vector: JSON.parse(round.counter_vector_json) as HarnessRoundInput["counter_vector"], created_at: round.created_at,
          sensor_results: results.filter((result) => result.round_id === round.id) })),
        events: events.map((event) => ({ id: event.id, run_id: event.run_id, event_type: event.event_type,
          payload: JSON.parse(event.payload_json) as unknown, created_at: event.created_at })),
      };
    } finally { db.close(); }
  }
}
