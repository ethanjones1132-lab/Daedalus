import { describe, expect, test } from "bun:test";
import { TodoStore, type TodoItem, type TodoRecord } from "./todo-store";

function newStore(): TodoStore {
  return new TodoStore({ dbPath: ":memory:" });
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe("TodoStore constructor", () => {
  test("creates an in-memory store with an empty list when no items have been written", () => {
    const store = newStore();
    expect(store.list()).toEqual([]);
  });

  test("the in-memory store is shared across `list()` calls on the same instance (no per-call DB recreation)", () => {
    const store = newStore();
    store.write([{ id: "a", text: "first" }]);
    const second = store.list();
    // Pinned because the open() path uses a `this.memoryDb` field and stubs
    // `db.close` so the in-memory DB survives across calls. If someone "fixes"
    // the per-call `db.close` for the in-memory branch, this assertion catches
    // it before the suite is silently broken in two halves.
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe("a");
  });
});

describe("TodoStore.write — id handling", () => {
  test("uses an explicit id verbatim (no transformation)", () => {
    const store = newStore();
    const [record] = store.write([{ id: "task-42", text: "do the thing" }]);
    expect(record?.id).toBe("task-42");
    expect(store.get?.("task-42")).toBeUndefined(); // no .get on TodoStore (intentional surface)
    expect(store.list()[0]?.id).toBe("task-42");
  });

  test("generates a UUID when id is omitted", () => {
    const store = newStore();
    const [record] = store.write([{ text: "no id supplied" }]);
    expect(record?.id).toBeTruthy();
    // UUID v4 shape (8-4-4-4-12 hex)
    expect(record?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates a UUID when id is the empty string (trim() empty-check branches to UUID)", () => {
    const store = newStore();
    const [record] = store.write([{ id: "", text: "blank id" }]);
    expect(record?.id).not.toBe("");
    expect(record?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates a UUID when id is whitespace-only (trim() empty-check branches to UUID)", () => {
    const store = newStore();
    const [record] = store.write([{ id: "   ", text: "whitespace id" }]);
    expect(record?.id?.trim()).not.toBe("   ");
    expect(record?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("trims surrounding whitespace on a supplied id and stores the trimmed value", () => {
    const store = newStore();
    const [record] = store.write([{ id: "  trim-me  ", text: "x" }]);
    expect(record?.id).toBe("trim-me");
    expect(store.list()[0]?.id).toBe("trim-me");
  });
});

describe("TodoStore.write — upsert semantics on duplicate id", () => {
  test("updating the same id keeps the original created_at and bumps updated_at", async () => {
    const store = newStore();
    store.write([{ id: "dup", text: "first" }]);
    const first = store.list()[0]!;
    // ISO-8601 timestamps at millisecond resolution — the second write must
    // land at a strictly later `updated_at` than the first. The constructor's
    // `new Date().toISOString()` can produce equal strings if the two writes
    // happen inside the same millisecond, so sleep one tick first.
    await new Promise((r) => setTimeout(r, 5));
    store.write([{ id: "dup", text: "second" }]);
    const second = store.list()[0]!;

    expect(second.text).toBe("second");
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at >= first.updated_at).toBe(true);
  });

  test("the `write` return value reports the new state, not the prior row", async () => {
    const store = newStore();
    const [first] = store.write([{ id: "dup", text: "v1" }]);
    // Deterministically straddle a millisecond boundary: before the RETURNING
    // fix, the upsert preserved created_at in the DB but the RETURN value
    // carried a fresh timestamp — a flake that only fired under suite load.
    await new Promise((r) => setTimeout(r, 5));
    const [second] = store.write([{ id: "dup", text: "v2" }]);
    expect(first?.text).toBe("v1");
    expect(second?.text).toBe("v2");
    expect(second?.created_at).toBe(first?.created_at);
  });

  test("a write that includes a previously-unseen id does not disturb other rows", () => {
    const store = newStore();
    store.write([{ id: "a", text: "A" }]);
    store.write([{ id: "b", text: "B" }]);
    expect(store.list().map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  test("batched write of a mixed list — some ids already present, some new — upserts each correctly", () => {
    const store = newStore();
    store.write([
      { id: "a", text: "A v1" },
      { id: "b", text: "B v1" },
    ]);
    const written: TodoRecord[] = store.write([
      { id: "a", text: "A v2" },
      { id: "c", text: "C v1" },
    ]);
    expect(written).toHaveLength(2);
    expect(written[0]?.text).toBe("A v2");
    expect(written[1]?.text).toBe("C v1");
    const byId = new Map(store.list().map((r) => [r.id, r.text] as const));
    expect(byId.get("a")).toBe("A v2");
    expect(byId.get("b")).toBe("B v1");
    expect(byId.get("c")).toBe("C v1");
  });
});

describe("TodoStore.write — text and status coercion", () => {
  test("`text: undefined` is coerced to an empty string, not stored as null/undefined", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: undefined as unknown as string }]);
    expect(record?.text).toBe("");
    expect(store.list()[0]?.text).toBe("");
  });

  test("`text: null` is coerced to an empty string", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: null as unknown as string }]);
    expect(record?.text).toBe("");
  });

  test("`text: 42` is coerced via String() to '42'", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: 42 as unknown as string }]);
    expect(record?.text).toBe("42");
  });

  test("`status: undefined` defaults to 'pending'", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: "y" }]);
    expect(record?.status).toBe("pending");
  });

  test("`status: 'in_progress'` round-trips verbatim (the schema does not validate against an enum)", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: "y", status: "in_progress" }]);
    expect(record?.status).toBe("in_progress");
    expect(store.list()[0]?.status).toBe("in_progress");
  });
});

describe("TodoStore.write — source and session_id precedence", () => {
  test("opts.source wins over item.source when both are supplied", () => {
    const store = newStore();
    const [record] = store.write(
      [{ id: "x", text: "y", source: "item-source" }],
      { source: "opts-source" },
    );
    expect(record?.source).toBe("opts-source");
  });

  test("item.source is used when opts.source is not supplied", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: "y", source: "from-item" }]);
    expect(record?.source).toBe("from-item");
  });

  test("source is undefined when neither opts nor item supply one (stored as NULL)", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: "y" }]);
    expect(record?.source).toBeUndefined();
  });

  test("session_id is bound to the write opts, not the item", () => {
    const store = newStore();
    const records = store.write(
      [{ id: "a", text: "A" }, { id: "b", text: "B" }],
      { session_id: "sess-1" },
    );
    expect(records.every((r) => r.session_id === "sess-1")).toBe(true);
  });

  test("session_id is undefined when opts omits it (stored as NULL)", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: "y" }]);
    expect(record?.session_id).toBeUndefined();
  });

  test("upserting an id with a previously-stored source keeps the source on COALESCE(null, old)", () => {
    // The ON CONFLICT clause uses `COALESCE(excluded.source, todos.source)` so
    // a re-write that omits source preserves the old one. Pinned because a
    // naive `SET source = excluded.source` would silently blank it.
    const store = newStore();
    store.write([{ id: "x", text: "v1", source: "keep-me" }]);
    store.write([{ id: "x", text: "v2" }]);
    const row = store.list().find((r) => r.id === "x");
    expect(row?.source).toBe("keep-me");
  });

  test("upserting an id with a previously-stored session_id keeps it on COALESCE(null, old)", () => {
    const store = newStore();
    store.write([{ id: "x", text: "v1" }], { session_id: "keep-me" });
    store.write([{ id: "x", text: "v2" }]);
    const row = store.list().find((r) => r.id === "x");
    expect(row?.session_id).toBe("keep-me");
  });
});

describe("TodoStore.write — timestamps", () => {
  test("created_at and updated_at are populated with ISO-8601 timestamps at write time", () => {
    const store = newStore();
    const before = new Date().toISOString();
    const [record] = store.write([{ id: "x", text: "y" }]);
    const after = new Date().toISOString();
    expect(record?.created_at).toMatch(ISO_RE);
    expect(record?.updated_at).toMatch(ISO_RE);
    // The two timestamps are equal for a fresh insert — pinned to lock the
    // "fresh row has equal created_at and updated_at" invariant in place.
    expect(record?.created_at).toBe(record?.updated_at);
    expect(record!.created_at >= before).toBe(true);
    expect(record!.created_at <= after).toBe(true);
  });
});

describe("TodoStore.list — filter and ordering", () => {
  test("returns rows ordered by `updated_at DESC` so the most-recently-touched row is first", async () => {
    const store = newStore();
    store.write([{ id: "old", text: "old" }]);
    await new Promise((r) => setTimeout(r, 5));
    store.write([{ id: "mid", text: "mid" }]);
    await new Promise((r) => setTimeout(r, 5));
    store.write([{ id: "new", text: "new" }]);
    const order = store.list().map((r) => r.id);
    expect(order[0]).toBe("new");
    expect(order[1]).toBe("mid");
    expect(order[2]).toBe("old");
  });

  test("status filter returns only rows with the matching status", () => {
    const store = newStore();
    store.write([{ id: "a", text: "A", status: "pending" }]);
    store.write([{ id: "b", text: "B", status: "in_progress" }]);
    store.write([{ id: "c", text: "C", status: "pending" }]);
    const pending = store.list({ status: "pending" });
    expect(pending.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  test("session_id filter returns only rows with the matching session_id", () => {
    const store = newStore();
    store.write([{ id: "a", text: "A" }], { session_id: "sess-1" });
    store.write([{ id: "b", text: "B" }], { session_id: "sess-2" });
    store.write([{ id: "c", text: "C" }], { session_id: "sess-1" });
    const sess1 = store.list({ session_id: "sess-1" });
    expect(sess1.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  test("status + session_id filters combine with AND", () => {
    const store = newStore();
    store.write([{ id: "a", text: "A", status: "pending" }], { session_id: "sess-1" });
    store.write([{ id: "b", text: "B", status: "done" }], { session_id: "sess-1" });
    store.write([{ id: "c", text: "C", status: "pending" }], { session_id: "sess-2" });
    const rows = store.list({ status: "pending", session_id: "sess-1" });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  test("`limit` caps the number of returned rows", () => {
    const store = newStore();
    for (let i = 0; i < 5; i++) {
      store.write([{ id: `t${i}`, text: `T${i}` }]);
    }
    expect(store.list({ limit: 2 })).toHaveLength(2);
  });

  test("`limit` is applied AFTER ordering, so the first N rows are the most-recently-touched", async () => {
    const store = newStore();
    store.write([{ id: "old", text: "old" }]);
    await new Promise((r) => setTimeout(r, 5));
    store.write([{ id: "new", text: "new" }]);
    const limited = store.list({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.id).toBe("new");
  });

  test("`limit: 0` (falsy) is not applied as LIMIT 0 — the falsy guard skips the clause", () => {
    // The implementation checks `if (filter.limit)` before appending LIMIT.
    // Pinned because a naive `LIMIT ?` with `0` would return zero rows, and a
    // future "use the parameter even when 0" refactor would silently break
    // any caller that has been treating `limit: undefined` as "no limit".
    const store = newStore();
    store.write([{ id: "a", text: "A" }]);
    store.write([{ id: "b", text: "B" }]);
    const rows = store.list({ limit: 0 });
    expect(rows).toHaveLength(2);
  });

  test("`status: ''` (falsy) is treated as no status filter", () => {
    const store = newStore();
    store.write([{ id: "a", text: "A", status: "pending" }]);
    store.write([{ id: "b", text: "B", status: "done" }]);
    const rows = store.list({ status: "" });
    expect(rows).toHaveLength(2);
  });
});

describe("TodoStore.clear", () => {
  test("removes every row from the store", () => {
    const store = newStore();
    store.write([{ id: "a", text: "A" }]);
    store.write([{ id: "b", text: "B" }]);
    store.write([{ id: "c", text: "C" }]);
    expect(store.list()).toHaveLength(3);
    store.clear();
    expect(store.list()).toEqual([]);
  });

  test("clear is idempotent — calling on an empty store is a no-op", () => {
    const store = newStore();
    store.clear();
    expect(store.list()).toEqual([]);
  });

  test("the store remains usable for writes after a clear", () => {
    const store = newStore();
    store.write([{ id: "a", text: "A" }]);
    store.clear();
    store.write([{ id: "b", text: "B" }]);
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("b");
  });
});

describe("TodoStore — schema invariants", () => {
  test("a fresh in-memory store has the documented schema columns and indices", () => {
    // The in-memory store reuses `this.memoryDb` and stubs `db.close` so the
    // schema is created exactly once. Pinned so a refactor that splits the
    // open() path doesn't accidentally double-`CREATE` the index and error
    // out, or skip the schema entirely on the second call.
    const store = newStore();
    const r = (store as unknown as { open: () => unknown }).open() as {
      query: (sql: string) => { all: () => unknown[] };
    };
    const cols = r.query("PRAGMA table_info(todos)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ["created_at", "id", "session_id", "source", "status", "text", "updated_at"],
    );
  });
});

describe("TodoRecord shape", () => {
  test("every record exposes id / text / status / created_at / updated_at at minimum", () => {
    const store = newStore();
    const [record] = store.write([{ id: "x", text: "y" }]);
    const required = ["id", "text", "status", "created_at", "updated_at"];
    for (const key of required) {
      expect(record).toHaveProperty(key);
    }
  });

  test("the public TodoItem shape permits partial items (id, status, source are all optional)", () => {
    // Compile-time-ish pin via `as TodoItem` — if the TodoItem interface ever
    // tightens (e.g. id becomes required), this is the call site that breaks
    // for a downstream consumer that supplies `{ text: 'only text' }`.
    const item: TodoItem = { text: "only text" };
    const store = newStore();
    const [record] = store.write([item]);
    expect(record?.text).toBe("only text");
    expect(record?.status).toBe("pending");
  });
});
