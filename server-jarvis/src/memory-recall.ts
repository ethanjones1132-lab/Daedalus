// ─── Memory auto-recall ──────────────────────────────────────────────────────
// Before each chat turn we run a lightweight FTS5 query against the user's
// message and surface the top-N most relevant active memories as a system
// context block. This connects the (previously CRUD-only) memory store to the
// live chat path so the model can "remember" prior facts without the user
// having to re-state them.
//
// The query lives in the same `jarvis.db` SQLite file the rest of the server
// uses, via the existing `memory_fts` FTS5 virtual table + sync triggers
// (see src-tauri/src/db/migrations.rs).

import { Database } from "bun:sqlite";

export interface RecalledMemory {
  id: string;
  title: string;
  content: string;
  relevance_score: number;
  rank: number;
}

// Common English function words that add noise to an FTS query. Kept small and
// intentional — FTS5 already handles ranking, this just trims obvious filler.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
  "her", "was", "one", "our", "out", "has", "him", "his", "how", "man", "new",
  "now", "old", "see", "two", "way", "who", "did", "get", "may", "use", "this",
  "that", "with", "from", "have", "what", "your", "they", "will", "would",
  "there", "their", "about", "which", "when", "make", "like", "into", "than",
  "then", "them", "some", "could", "should",
]);

/**
 * Turn a free-text message into a safe FTS5 MATCH expression: lowercase,
 * strip non-alphanumerics, drop short/stopword tokens, OR the rest together.
 * Returns "" when nothing usable remains (caller should skip the query).
 */
export function sanitizeFtsQuery(message: string): string {
  const tokens = (message || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const unique = [...new Set(tokens)].slice(0, 12);
  return unique.join(" OR ");
}

/**
 * Query the `memory`/`memory_fts` tables for memories relevant to `message`.
 * Ranked by FTS bm25 relevance, boosted by the memory's own relevance_score
 * and a small recency bonus. Never throws — returns [] on any error.
 */
export function recallMemories(
  db: Database,
  message: string,
  opts: { limit?: number; agentId?: string; recencyWindowMs?: number } = {},
): RecalledMemory[] {
  const limit = opts.limit ?? 3;
  const agentId = opts.agentId ?? "jarvis";
  const query = sanitizeFtsQuery(message);
  if (!query) return [];

  const recencyThreshold = Date.now() - (opts.recencyWindowMs ?? 7 * 24 * 60 * 60 * 1000);

  try {
    // bm25() returns a negative score where more-negative = better match, so we
    // negate it to make "larger = better" and add the other positive signals.
    return db
      .query(
        `SELECT m.id AS id, m.title AS title, m.content AS content,
                m.relevance_score AS relevance_score, bm25(memory_fts) AS rank
         FROM memory_fts
         JOIN memory m ON m.id = memory_fts.id
         WHERE memory_fts MATCH ?
           AND m.status = 'active'
           AND m.agent_id = ?
         ORDER BY ((-bm25(memory_fts)) + m.relevance_score
                   + (CASE WHEN m.updated_at_ms > ? THEN 0.5 ELSE 0 END)) DESC
         LIMIT ?`,
      )
      .all(query, agentId, recencyThreshold, limit) as RecalledMemory[];
  } catch {
    return [];
  }
}

/**
 * Render recalled memories as a compact system-context block. Content is
 * collapsed to a single line and truncated so a few memories can't blow the
 * context budget. Returns "" for no rows.
 */
export function formatMemoryBlock(rows: RecalledMemory[], maxContentChars = 400): string {
  if (!rows.length) return "";
  const items = rows.map((r) => {
    const collapsed = (r.content || "").replace(/\s+/g, " ").trim();
    const content = collapsed.length > maxContentChars
      ? collapsed.slice(0, maxContentChars) + "…"
      : collapsed;
    const title = r.title?.trim() ? `${r.title.trim()}: ` : "";
    return `- ${title}${content}`;
  });
  return `[Relevant memories]\n${items.join("\n")}`;
}

/**
 * Open `dbPath` read-only, recall memories for `message`, and return both the
 * raw rows and a ready-to-inject system block. Safe to call on every turn:
 * returns empty results if the path is missing or any error occurs.
 */
export function recallForMessage(
  dbPath: string | null | undefined,
  message: string,
  opts: { limit?: number; agentId?: string } = {},
): { rows: RecalledMemory[]; block: string } {
  if (!dbPath) return { rows: [], block: "" };
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = recallMemories(db, message, opts);
    return { rows, block: formatMemoryBlock(rows) };
  } catch {
    return { rows: [], block: "" };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}
