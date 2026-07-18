import { test, expect, describe } from "bun:test";
import { ApprovalStore, type ApprovalRequestInput } from "./approval-store";

function baseInput(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    request_id: "req-1",
    tool_name: "shell_execute",
    arguments: { command: "echo ok" },
    policy_source: "tool_requires_approval",
    expires_at: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("approval-store", () => {
  // ── :memory: isolation invariant ────────────────────────────────────────
  //
  // bun:sqlite's ":memory:" is per-Database-instance, not per-path. The store
  // code mitigates this with an instance-level cache (this.memoryDb) so a
  // single store reuses its in-memory DB across multiple open() calls, but
  // two SEPARATE store instances with dbPath=":memory:" do NOT share state.
  // This test pins the actual contract so a future refactor (e.g. "share the
  // in-memory DB across all store instances" or "always open a fresh
  // in-memory DB per open()") cannot silently change isolation semantics.

  test("a single :memory: store persists across multiple open() calls", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "persist-1" }));
    store.create(baseInput({ request_id: "persist-2" }));
    expect(store.list().length).toBe(2);
    // Re-open via a fresh method call would be the failure mode the
    // this.memoryDb cache exists to prevent; get() exercises the same
    // open()-close() path that the cache guards.
    expect(store.get("persist-1")).not.toBeNull();
    expect(store.get("persist-2")).not.toBeNull();
  });

  test("two separate :memory: stores are isolated (no cross-instance state)", () => {
    const a = new ApprovalStore({ dbPath: ":memory:" });
    a.create(baseInput({ request_id: "only-in-a" }));
    const b = new ApprovalStore({ dbPath: ":memory:" });
    // b is a fresh :memory: instance — must not see a's records.
    expect(b.get("only-in-a")).toBeNull();
    expect(b.list()).toEqual([]);
  });

  // ── create() ─────────────────────────────────────────────────────────────

  test("create returns a fully-populated record with status='pending'", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    const rec = store.create(
      baseInput({ request_id: "r-create", session_id: "sess-1", surface: "chat" }),
    );
    expect(rec.request_id).toBe("r-create");
    expect(rec.tool_name).toBe("shell_execute");
    expect(rec.arg_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rec.policy_source).toBe("tool_requires_approval");
    expect(rec.status).toBe("pending");
    expect(rec.resolution).toBeUndefined();
    expect(rec.session_id).toBe("sess-1");
    expect(rec.surface).toBe("chat");
    expect(rec.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.expires_at).toBe("2026-07-19T00:00:00.000Z");
    expect(rec.resolved_at).toBeUndefined();
  });

  test("create leaves session_id/surface as undefined in the in-memory return when not provided", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    const rec = store.create(baseInput({ request_id: "r-null-mem" }));
    // The in-memory return shape uses ?? null on the way to SQLite,
    // but the returned object reflects input (undefined) directly.
    expect(rec.session_id).toBeUndefined();
    expect(rec.surface).toBeUndefined();
  });

  test("get returns a row where missing session_id/surface round-trip as null (SQLite NULL contract)", () => {
    // This is the actual bun:sqlite contract: NULL columns deserialize to
    // null, not undefined. The ApprovalRecord type is a TS lie here — the
    // field is declared optional, but the runtime value is null. The
    // registry's getRecord consumer (approval-registry.test.ts) never
    // asserts a specific shape, so the null is invisible in practice.
    // Pin the real behavior so a future "normalize null to undefined" fix
    // is a deliberate decision.
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-null-roundtrip" }));
    const fromDb = store.get("r-null-roundtrip");
    expect(fromDb).not.toBeNull();
    expect(fromDb?.session_id).toBeNull();
    expect(fromDb?.surface).toBeNull();
  });

  test("get returns null for an unknown id (SQLite miss, not undefined)", () => {
    // SQLite returns null on no-row; the type cast to `T | undefined` is
    // a lie. Pin the runtime contract.
    const store = new ApprovalStore({ dbPath: ":memory:" });
    expect(store.get("nope")).toBeNull();
  });

  test("create preserves the supplied expires_at verbatim", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    const rec = store.create(
      baseInput({ request_id: "r-exp", expires_at: "2030-01-01T12:34:56.789Z" }),
    );
    expect(rec.expires_at).toBe("2030-01-01T12:34:56.789Z");
    const fromDb = store.get("r-exp");
    expect(fromDb?.expires_at).toBe("2030-01-01T12:34:56.789Z");
  });

  test("create sets requested_at to a fresh ISO timestamp at call time", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    const before = new Date().toISOString();
    const rec = store.create(baseInput({ request_id: "r-ts" }));
    const after = new Date().toISOString();
    expect(rec.requested_at >= before).toBe(true);
    expect(rec.requested_at <= after).toBe(true);
  });

  // ── arg_hash stability (key-order invariant) ─────────────────────────────

  test("arg_hash is stable across key-order permutations of the same args", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-hash-1", arguments: { a: 1, b: 2, c: 3 } }));
    store.create(baseInput({ request_id: "r-hash-2", arguments: { c: 3, a: 1, b: 2 } }));
    store.create(baseInput({ request_id: "r-hash-3", arguments: { b: 2, c: 3, a: 1 } }));
    const a = store.get("r-hash-1");
    const b = store.get("r-hash-2");
    const c = store.get("r-hash-3");
    expect(a?.arg_hash).toBe(b?.arg_hash);
    expect(b?.arg_hash).toBe(c?.arg_hash);
  });

  test("arg_hash is stable for nested object key-order permutations", () => {
    // The hash helper uses JSON.stringify(args, sortedKeys) — that only
    // sorts the top level. The inner object's key order is preserved by
    // the sorted-keys replacer. Pin the actual behavior.
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-nest-1", arguments: { outer: { x: 1, y: 2 } } }));
    store.create(baseInput({ request_id: "r-nest-2", arguments: { outer: { y: 2, x: 1 } } }));
    const a = store.get("r-nest-1");
    const b = store.get("r-nest-2");
    expect(a?.arg_hash).toBe(b?.arg_hash);
  });

  test("arg_hash is sensitive to value changes", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-diff-1", arguments: { command: "echo ok" } }));
    store.create(baseInput({ request_id: "r-diff-2", arguments: { command: "echo fail" } }));
    const a = store.get("r-diff-1");
    const b = store.get("r-diff-2");
    expect(a?.arg_hash).not.toBe(b?.arg_hash);
  });

  test("arg_hash accepts an empty arguments object", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    const rec = store.create(baseInput({ request_id: "r-empty", arguments: {} }));
    expect(rec.arg_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("arg_hash is a 16-char hex prefix of SHA-256", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    const rec = store.create(
      baseInput({ request_id: "r-hex", arguments: { deterministic: true } }),
    );
    // The hash function: createHash('sha256').update(...).digest('hex').slice(0, 16)
    // Pin the length and character set so a future "switch to md5" or
    // "use full 64-char digest" is a deliberate change.
    expect(rec.arg_hash.length).toBe(16);
    expect(rec.arg_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  // ── resolve() ───────────────────────────────────────────────────────────

  test("resolve updates status, resolution, and resolved_at on a pending record", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-resolve-ok" }));
    const ok = store.resolve("r-resolve-ok", "approved");
    expect(ok).toBe(true);
    const rec = store.get("r-resolve-ok");
    expect(rec?.status).toBe("approved");
    expect(rec?.resolution).toBe("approved");
    expect(rec?.resolved_at).toBeDefined();
    expect(rec?.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("resolve honors the 'rejected' and 'expired' resolution values", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-rej" }));
    store.create(baseInput({ request_id: "r-exp" }));
    expect(store.resolve("r-rej", "rejected")).toBe(true);
    expect(store.resolve("r-exp", "expired")).toBe(true);
    expect(store.get("r-rej")?.status).toBe("rejected");
    expect(store.get("r-rej")?.resolution).toBe("rejected");
    expect(store.get("r-exp")?.status).toBe("expired");
    expect(store.get("r-exp")?.resolution).toBe("expired");
  });

  test("resolve on an unknown id returns false and writes nothing", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    expect(store.resolve("never-existed", "approved")).toBe(false);
    expect(store.get("never-existed")).toBeNull();
  });

  test("resolve on a non-pending record returns false (idempotency guard)", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-twice" }));
    expect(store.resolve("r-twice", "approved")).toBe(true);
    // Second resolve must NOT change the existing record — the WHERE
    // status = 'pending' clause guards against an audit trail overwrite.
    const before = store.get("r-twice");
    expect(store.resolve("r-twice", "rejected")).toBe(false);
    const after = store.get("r-twice");
    expect(after?.status).toBe("approved");
    expect(after?.resolution).toBe("approved");
    expect(after?.resolved_at).toBe(before?.resolved_at);
  });

  test("resolve on a previously-rejected record is a no-op", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "r-rej-twice" }));
    store.resolve("r-rej-twice", "rejected");
    const first = store.get("r-rej-twice");
    expect(store.resolve("r-rej-twice", "approved")).toBe(false);
    const second = store.get("r-rej-twice");
    expect(second?.status).toBe("rejected");
    expect(second?.resolution).toBe("rejected");
    expect(second?.resolved_at).toBe(first?.resolved_at);
  });

  test("resolve preserves expires_at through the update", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(
      baseInput({ request_id: "r-preserve-exp", expires_at: "2099-12-31T23:59:59.000Z" }),
    );
    expect(store.resolve("r-preserve-exp", "approved")).toBe(true);
    expect(store.get("r-preserve-exp")?.expires_at).toBe("2099-12-31T23:59:59.000Z");
  });

  // ── list() ──────────────────────────────────────────────────────────────

  test("list returns all records by default, newest first", async () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "l-1" }));
    // ensure a strictly-later requested_at on the second create
    await new Promise((r) => setTimeout(r, 5));
    store.create(baseInput({ request_id: "l-2" }));
    await new Promise((r) => setTimeout(r, 5));
    store.create(baseInput({ request_id: "l-3" }));
    const all = store.list();
    expect(all.length).toBe(3);
    expect(all.map((r) => r.request_id)).toEqual(["l-3", "l-2", "l-1"]);
  });

  test("list filters by status", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "f-1" }));
    store.create(baseInput({ request_id: "f-2" }));
    store.create(baseInput({ request_id: "f-3" }));
    store.resolve("f-2", "approved");
    const pending = store.list({ status: "pending" });
    expect(pending.length).toBe(2);
    expect(pending.map((r) => r.request_id).sort()).toEqual(["f-1", "f-3"]);
    const approved = store.list({ status: "approved" });
    expect(approved.length).toBe(1);
    expect(approved[0]?.request_id).toBe("f-2");
  });

  test("list honors limit and keeps newest-first ordering", async () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    for (let i = 0; i < 5; i++) {
      store.create(baseInput({ request_id: `lim-${i}` }));
      await new Promise((r) => setTimeout(r, 2));
    }
    const limited = store.list({ limit: 2 });
    expect(limited.length).toBe(2);
    expect(limited.map((r) => r.request_id)).toEqual(["lim-4", "lim-3"]);
  });

  test("list with no matching status returns an empty array", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "nm-1" }));
    const rejected = store.list({ status: "rejected" });
    expect(rejected).toEqual([]);
  });

  test("list filter+limit combine (status filter applied before limit)", async () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    // Use 5ms gaps so requested_at sorts strictly DESC by ISO string
    // comparison (otherwise two same-millisecond creates compare equal
    // and SQLite's rowid order takes over, which is creation order
    // not resolution order).
    store.create(baseInput({ request_id: "c-1" }));
    await new Promise((r) => setTimeout(r, 5));
    store.create(baseInput({ request_id: "c-2" }));
    await new Promise((r) => setTimeout(r, 5));
    store.create(baseInput({ request_id: "c-3" }));
    await new Promise((r) => setTimeout(r, 5));
    store.create(baseInput({ request_id: "c-4" }));
    // c-4 and c-1 are the most recent at the moment we resolve them,
    // but the requested_at is locked at create time. Resolve c-1
    // (oldest) and c-3 (mid). Newest approved row is c-3.
    store.resolve("c-1", "approved");
    store.resolve("c-3", "approved");
    const newestApproved = store.list({ status: "approved", limit: 1 });
    expect(newestApproved.length).toBe(1);
    expect(newestApproved[0]?.request_id).toBe("c-3");
  });

  test("list returns rows with NULL session_id/surface as null (not filtered out)", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "keep-null" }));
    const all = store.list();
    expect(all.length).toBe(1);
    expect(all[0]?.session_id).toBeNull();
    expect(all[0]?.surface).toBeNull();
  });

  // ── clear() ─────────────────────────────────────────────────────────────

  test("clear empties the table of all records", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "cl-1" }));
    store.create(baseInput({ request_id: "cl-2" }));
    expect(store.list().length).toBe(2);
    store.clear();
    expect(store.list().length).toBe(0);
    expect(store.get("cl-1")).toBeNull();
    expect(store.get("cl-2")).toBeNull();
  });

  test("clear on an empty table is a no-op", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    expect(() => store.clear()).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  test("clear leaves the schema intact (subsequent creates still work)", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "pre" }));
    store.clear();
    store.create(baseInput({ request_id: "post" }));
    expect(store.list().length).toBe(1);
    expect(store.list()[0]?.request_id).toBe("post");
  });

  // ── Lifecycle integration ───────────────────────────────────────────────

  test("create -> resolve -> get round-trips the full state machine", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    const created = store.create(baseInput({ request_id: "lc-1" }));
    expect(created.status).toBe("pending");
    expect(store.get("lc-1")?.status).toBe("pending");
    store.resolve("lc-1", "approved");
    const resolved = store.get("lc-1");
    expect(resolved?.status).toBe("approved");
    expect(resolved?.resolution).toBe("approved");
    expect(resolved?.resolved_at).toBeDefined();
    // expires_at must be preserved through the resolve update
    expect(resolved?.expires_at).toBe("2026-07-19T00:00:00.000Z");
  });

  test("create on a duplicate request_id throws (PRIMARY KEY constraint)", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "dup" }));
    expect(() => store.create(baseInput({ request_id: "dup" }))).toThrow();
  });

  test("status enum accepts all four documented values", () => {
    const store = new ApprovalStore({ dbPath: ":memory:" });
    store.create(baseInput({ request_id: "enum-1" }));
    store.create(baseInput({ request_id: "enum-2" }));
    store.create(baseInput({ request_id: "enum-3" }));
    store.create(baseInput({ request_id: "enum-4" }));
    store.resolve("enum-2", "approved");
    store.resolve("enum-3", "rejected");
    store.resolve("enum-4", "expired");
    // enum-1 stays pending
    const all = store.list();
    const statuses = new Set(all.map((r) => r.status));
    expect(statuses.size).toBe(4);
    expect(statuses.has("pending")).toBe(true);
    expect(statuses.has("approved")).toBe(true);
    expect(statuses.has("rejected")).toBe(true);
    expect(statuses.has("expired")).toBe(true);
  });
});
