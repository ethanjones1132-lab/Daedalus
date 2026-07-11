// ═══════════════════════════════════════════════════════════════
// ── Durable Todo Store ──
// ═══════════════════════════════════════════════════════════════
// Persisted task list for the meta-bundle. Survives Bun restart and is
// shared across surfaces (chat, cron, agent) through the same runtime.

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface TodoItem {
  id: string;
  text: string;
  status?: string;
  source?: string;
}

export interface TodoRecord {
  id: string;
  text: string;
  status: string;
  source?: string;
  session_id?: string;
  created_at: string;
  updated_at: string;
}

export interface TodoStoreOptions {
  dbPath?: string;
}

export interface TodoListFilter {
  status?: string;
  session_id?: string;
  limit?: number;
}

const TODO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
  CREATE INDEX IF NOT EXISTS idx_todos_updated_at ON todos(updated_at);
`;

function serverStateDbPath(): string {
  const p = join(homedir(), ".openclaw", "jarvis", "server-state.db");
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* best effort */ }
  return p;
}

export class TodoStore {
  private dbPath: string;
  private memoryDb: Database | null = null;

  constructor(opts: TodoStoreOptions = {}) {
    this.dbPath = opts.dbPath ?? serverStateDbPath();
  }

  private open(): Database {
    if (this.dbPath === ":memory:") {
      if (!this.memoryDb) {
        const db = new Database(":memory:");
        db.exec(TODO_SCHEMA);
        db.close = () => {};
        this.memoryDb = db;
      }
      return this.memoryDb;
    }
    const db = new Database(this.dbPath, { create: true });
    db.exec(TODO_SCHEMA);
    return db;
  }

  write(items: TodoItem[], opts: { session_id?: string; source?: string } = {}): TodoRecord[] {
    const db = this.open();
    const now = new Date().toISOString();
    try {
      const records: TodoRecord[] = [];
      for (const item of items) {
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : crypto.randomUUID();
        const record: TodoRecord = {
          id,
          text: String(item.text ?? ""),
          status: String(item.status ?? "pending"),
          source: opts.source ?? item.source,
          session_id: opts.session_id,
          created_at: now,
          updated_at: now,
        };
        db.prepare(
          `INSERT INTO todos (id, text, status, source, session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             text = excluded.text,
             status = excluded.status,
             source = COALESCE(excluded.source, todos.source),
             session_id = COALESCE(excluded.session_id, todos.session_id),
             updated_at = excluded.updated_at`
        ).run(
          record.id,
          record.text,
          record.status,
          record.source ?? null,
          record.session_id ?? null,
          record.created_at,
          record.updated_at,
        );
        records.push(record);
      }
      return records;
    } finally {
      db.close();
    }
  }

  list(filter: TodoListFilter = {}): TodoRecord[] {
    const db = this.open();
    try {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (filter.status) {
        conditions.push("status = ?");
        params.push(filter.status);
      }
      if (filter.session_id) {
        conditions.push("session_id = ?");
        params.push(filter.session_id);
      }
      let sql = "SELECT * FROM todos";
      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }
      sql += " ORDER BY updated_at DESC";
      if (filter.limit) {
        sql += " LIMIT ?";
        params.push(filter.limit);
      }
      return db.query(sql).all(...params) as TodoRecord[];
    } finally {
      db.close();
    }
  }

  clear(): void {
    const db = this.open();
    try {
      db.exec("DELETE FROM todos");
    } finally {
      db.close();
    }
  }
}
