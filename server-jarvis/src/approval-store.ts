// ═══════════════════════════════════════════════════════════════
// ── Durable Approval Store ──
// ═══════════════════════════════════════════════════════════════
// Persisted audit record for every tool-approval request. Survives Bun
// restart so policy decisions can be reviewed and replayed.

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface ApprovalRecord {
  request_id: string;
  tool_name: string;
  arg_hash: string;
  policy_source: string;
  status: "pending" | "approved" | "rejected" | "expired";
  resolution?: "approved" | "rejected" | "expired";
  session_id?: string;
  surface?: string;
  requested_at: string;
  expires_at: string;
  resolved_at?: string;
}

export interface ApprovalRequestInput {
  request_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  policy_source: string;
  session_id?: string;
  surface?: string;
  expires_at: string;
}

const APPROVAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS approval_records (
    request_id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    arg_hash TEXT NOT NULL,
    policy_source TEXT NOT NULL,
    status TEXT NOT NULL,
    resolution TEXT,
    session_id TEXT,
    surface TEXT,
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approval_records_status ON approval_records(status);
  CREATE INDEX IF NOT EXISTS idx_approval_records_requested_at ON approval_records(requested_at);
`;

function serverStateDbPath(): string {
  const p = join(homedir(), ".openclaw", "jarvis", "server-state.db");
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* best effort */ }
  return p;
}

function hashArgs(args: Record<string, unknown>): string {
  const stable = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export interface ApprovalStoreOptions {
  dbPath?: string;
}

export class ApprovalStore {
  private dbPath: string;
  private memoryDb: Database | null = null;

  constructor(opts: ApprovalStoreOptions = {}) {
    this.dbPath = opts.dbPath ?? serverStateDbPath();
  }

  private open(): Database {
    if (this.dbPath === ":memory:") {
      if (!this.memoryDb) {
        const db = new Database(":memory:");
        db.exec(APPROVAL_SCHEMA);
        db.close = () => {}; // keep the in-memory DB alive across calls
        this.memoryDb = db;
      }
      return this.memoryDb;
    }
    const db = new Database(this.dbPath, { create: true });
    db.exec(APPROVAL_SCHEMA);
    return db;
  }

  create(input: ApprovalRequestInput): ApprovalRecord {
    const db = this.open();
    try {
      const record: ApprovalRecord = {
        request_id: input.request_id,
        tool_name: input.tool_name,
        arg_hash: hashArgs(input.arguments),
        policy_source: input.policy_source,
        status: "pending",
        session_id: input.session_id,
        surface: input.surface,
        requested_at: new Date().toISOString(),
        expires_at: input.expires_at,
      };
      db.prepare(
        `INSERT INTO approval_records
         (request_id, tool_name, arg_hash, policy_source, status, session_id, surface, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.request_id,
        record.tool_name,
        record.arg_hash,
        record.policy_source,
        record.status,
        record.session_id ?? null,
        record.surface ?? null,
        record.requested_at,
        record.expires_at,
      );
      return record;
    } finally {
      db.close();
    }
  }

  resolve(requestId: string, resolution: "approved" | "rejected" | "expired"): boolean {
    const db = this.open();
    try {
      const result = db.prepare(
        `UPDATE approval_records
         SET status = ?, resolution = ?, resolved_at = ?
         WHERE request_id = ? AND status = 'pending'`
      ).run(resolution, resolution, new Date().toISOString(), requestId);
      return result.changes > 0;
    } finally {
      db.close();
    }
  }

  get(requestId: string): ApprovalRecord | undefined {
    const db = this.open();
    try {
      const row = db.query("SELECT * FROM approval_records WHERE request_id = ?").get(requestId) as
        | ApprovalRecord
        | undefined;
      return row;
    } finally {
      db.close();
    }
  }

  list(filter?: { status?: ApprovalRecord["status"]; limit?: number }): ApprovalRecord[] {
    const db = this.open();
    try {
      let sql = "SELECT * FROM approval_records";
      const params: (string | number)[] = [];
      if (filter?.status) {
        sql += " WHERE status = ?";
        params.push(filter.status);
      }
      sql += " ORDER BY requested_at DESC";
      if (filter?.limit) {
        sql += " LIMIT ?";
        params.push(filter.limit);
      }
      return db.query(sql).all(...params) as ApprovalRecord[];
    } finally {
      db.close();
    }
  }

  clear(): void {
    const db = this.open();
    try {
      db.exec("DELETE FROM approval_records");
    } finally {
      db.close();
    }
  }
}
