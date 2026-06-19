import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  recallMemories,
  formatMemoryBlock,
  sanitizeFtsQuery,
} from "./memory-recall";

// Mirror the production schema (db/migrations.rs): the `memory` table plus the
// `memory_fts` FTS5 virtual table kept in sync by an AFTER INSERT trigger.
function seedDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE memory (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'general',
      relevance_score REAL NOT NULL DEFAULT 0.0,
      agent_id TEXT NOT NULL DEFAULT 'jarvis',
      status TEXT NOT NULL DEFAULT 'active',
      updated_at_ms INTEGER
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, title, content, tags, category);
    CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, id, title, content, tags, category)
      VALUES (new.rowid, new.id, new.title, new.content, new.tags, new.category);
    END;
  `);
  return db;
}

function insert(db: Database, m: { id: string; title: string; content: string; relevance_score?: number; agent_id?: string; status?: string }) {
  db.run(
    `INSERT INTO memory (id, title, content, relevance_score, agent_id, status, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.title, m.content, m.relevance_score ?? 0, m.agent_id ?? "jarvis", m.status ?? "active", Date.now()],
  );
}

describe("sanitizeFtsQuery", () => {
  test("drops short tokens and punctuation, ORs the rest", () => {
    const q = sanitizeFtsQuery("Deploy the Tauri app!");
    expect(q).toContain("deploy");
    expect(q).toContain("tauri");
    expect(q).toContain("app");
    expect(q).toContain(" OR ");
    expect(q).not.toContain("the"); // stopword / short
    expect(q).not.toContain("!");
  });

  test("returns empty string when nothing usable remains", () => {
    expect(sanitizeFtsQuery("a is to")).toBe("");
    expect(sanitizeFtsQuery("")).toBe("");
  });
});

describe("recallMemories", () => {
  test("returns the most relevant memories, newest-matching first, honoring limit", () => {
    const db = seedDb();
    insert(db, { id: "1", title: "Tauri deploy", content: "How to deploy the tauri desktop app to windows" });
    insert(db, { id: "2", title: "Cooking", content: "How to bake sourdough bread" });
    insert(db, { id: "3", title: "Tauri build", content: "tauri build pipeline notes", relevance_score: 0.2 });

    const rows = recallMemories(db, "deploy the tauri app", { limit: 2 });
    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("1");
    expect(ids).not.toContain("2"); // unrelated, must not surface
    db.close();
  });

  test("returns [] when nothing matches", () => {
    const db = seedDb();
    insert(db, { id: "1", title: "Cooking", content: "sourdough bread" });
    expect(recallMemories(db, "kubernetes helm charts")).toEqual([]);
    db.close();
  });

  test("excludes non-active and other-agent memories", () => {
    const db = seedDb();
    insert(db, { id: "1", title: "Tauri", content: "tauri deploy notes", status: "archived" });
    insert(db, { id: "2", title: "Tauri", content: "tauri deploy notes", agent_id: "other" });
    expect(recallMemories(db, "tauri deploy")).toEqual([]);
    db.close();
  });
});

describe("formatMemoryBlock", () => {
  test("empty rows produce empty string", () => {
    expect(formatMemoryBlock([])).toBe("");
  });

  test("renders a titled bullet block", () => {
    const block = formatMemoryBlock([
      { id: "1", title: "Writable path", content: "use the /home view", relevance_score: 0, rank: -1 },
    ]);
    expect(block).toContain("[Relevant memories]");
    expect(block).toContain("Writable path");
    expect(block).toContain("use the /home view");
  });
});
