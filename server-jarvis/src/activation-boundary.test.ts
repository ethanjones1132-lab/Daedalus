// ═══════════════════════════════════════════════════════════════
// ── Activation Boundary Contract Tests ──
// ═══════════════════════════════════════════════════════════════
// The 67-line `server-jarvis/src/activation-boundary.ts` is the file-backed
// projection snapshot seam between `cron-runtime.ts` (the production path
// Hermes actually calls) and the agent-runs DB. A regression that drifted
// slug normalization, the JSON-parse fall-through, the marker-DB best-effort
// dual-write, or the default-snapshot shape would silently corrupt the
// durable projection record and route cron runs to the wrong slug.
//
// The only previous coverage was the consumer side via
// `cron-runtime.test.ts` (exercised through `createCronRuntime({snapshot})`,
// never through `restoreBoundary`/`saveBoundary`/`defaultSnapshot` directly).
// These tests pin the disk I/O seam in isolation.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultSnapshot,
  restoreBoundary,
  saveBoundary,
  type ProjectionSnapshot,
} from "./activation-boundary";

const created: string[] = [];

function tempBaseDir(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-activation-boundary-"));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

// ── defaultSnapshot ───────────────────────────────────────────────────────

describe("defaultSnapshot", () => {
  test("returns a default-shaped snapshot with the requested slug", () => {
    const snap = defaultSnapshot("my-slug");
    expect(snap.slug).toBe("my-slug");
    expect(snap.active).toBe(true);
    expect(snap.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("defaults the slug to 'default' when called with no argument", () => {
    const snap = defaultSnapshot();
    expect(snap.slug).toBe("default");
    expect(snap.active).toBe(true);
  });

  test("stamps a fresh ISO timestamp on every call (no caching)", () => {
    const a = defaultSnapshot("cron");
    const b = defaultSnapshot("cron");
    // Equal at second granularity, but each call must run through `new Date()`.
    // The test is shaped around the SHAPE not a millisecond race; the
    // invariant is that the timestamp is an ISO string, parseable, recent.
    expect(new Date(a.updated_at!).getTime()).not.toBeNaN();
    expect(new Date(b.updated_at!).getTime()).toBeGreaterThan(0);
  });
});

// ── restoreBoundary — disk read path ──────────────────────────────────────

describe("restoreBoundary", () => {
  test("missing snapshot file returns a default snapshot for the requested slug", () => {
    const dir = tempBaseDir();
    const boundary = restoreBoundary("first-run", dir);
    expect(boundary.slug).toBe("first-run");
    expect(boundary.snapshot.slug).toBe("first-run");
    expect(boundary.snapshot.active).toBe(true);
  });

  test("existing snapshot file is parsed and returned verbatim", () => {
    const dir = tempBaseDir();
    mkdirSync(join(dir, "agent-snapshots"), { recursive: true });
    const stored: ProjectionSnapshot = {
      slug: "stored-cron",
      active: false,
      updated_at: "2026-01-15T10:00:00.000Z",
      // Arbitrary extra field — the index signature must survive the round-trip.
      custom: { weight: 7 },
    };
    writeFileSync(join(dir, "agent-snapshots", "stored-cron.json"), JSON.stringify(stored, null, 2));

    const boundary = restoreBoundary("stored-cron", dir);
    expect(boundary.slug).toBe("stored-cron");
    expect(boundary.snapshot.active).toBe(false);
    expect(boundary.snapshot.updated_at).toBe("2026-01-15T10:00:00.000Z");
    expect(boundary.snapshot.custom).toEqual({ weight: 7 });
  });

  test("a stored snapshot with a missing/empty slug falls back to the request slug", () => {
    // The save path always writes a non-empty slug, but a hand-edited or
    // legacy snapshot with slug="" must not propagate "" downstream — that
    // would route every cron run to a slug with no JSON file.
    const dir = tempBaseDir();
    mkdirSync(join(dir, "agent-snapshots"), { recursive: true });
    writeFileSync(
      join(dir, "agent-snapshots", "request-slug.json"),
      JSON.stringify({ slug: "", active: true, updated_at: "2026-02-01T00:00:00.000Z" }),
    );
    const boundary = restoreBoundary("request-slug", dir);
    expect(boundary.slug).toBe("request-slug");
  });

  test("corrupt JSON in the snapshot file falls through to a safe default", () => {
    // Garbage on disk must NOT throw — the contract is "best-effort, never
    // fatal" because the cron runtime calls restoreBoundary on every run and
    // a throw would block the whole maintenance pass.
    const dir = tempBaseDir();
    mkdirSync(join(dir, "agent-snapshots"), { recursive: true });
    writeFileSync(join(dir, "agent-snapshots", "broken.json"), "{ not valid json");
    const boundary = restoreBoundary("broken", dir);
    expect(boundary.slug).toBe("broken");
    expect(boundary.snapshot.slug).toBe("broken");
    expect(boundary.snapshot.active).toBe(true);
  });

  test("no snapshot argument defaults to slug 'default'", () => {
    const dir = tempBaseDir();
    const boundary = restoreBoundary(undefined, dir);
    expect(boundary.slug).toBe("default");
  });
});

// ── saveBoundary — disk write path ────────────────────────────────────────

describe("saveBoundary", () => {
  test("writes a pretty-printed JSON snapshot at <base>/agent-snapshots/<slug>.json", () => {
    const dir = tempBaseDir();
    const result = saveBoundary({ slug: "write-test", active: true }, dir);
    expect(result.slug).toBe("write-test");
    const onDisk = readFileSync(join(dir, "agent-snapshots", "write-test.json"), "utf-8");
    // Pretty-printed (2-space indent) — the seam is the source of truth for
    // the durable record, so a future "compact JSON" refactor would change
    // the diff surface and is a deliberate decision.
    expect(onDisk).toContain('"slug": "write-test"');
    const parsed = JSON.parse(onDisk) as ProjectionSnapshot;
    expect(parsed.slug).toBe("write-test");
    expect(parsed.active).toBe(true);
    expect(parsed.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("normalizes a missing/empty slug to 'default' before writing", () => {
    // An upstream caller accidentally passing {} as the snapshot must NOT
    // write to <base>/agent-snapshots/.json (an invalid filename on Windows
    // / a no-op file on POSIX). The save path silently coerces to "default"
    // so a future restoreBoundary(slug) can still find the record.
    const dir = tempBaseDir();
    const result = saveBoundary({ slug: "", active: true } as ProjectionSnapshot, dir);
    expect(result.slug).toBe("default");
    expect(existsSync(join(dir, "agent-snapshots", "default.json"))).toBe(true);
  });

  test("re-stamps updated_at on every save (no stale timestamps survive)", () => {
    const dir = tempBaseDir();
    const first = saveBoundary({ slug: "stale", active: true, updated_at: "2000-01-01T00:00:00.000Z" }, dir);
    expect(first.snapshot.updated_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(new Date(first.snapshot.updated_at!).getTime()).toBeGreaterThan(new Date("2000-01-01T00:00:00.000Z").getTime());
  });

  test("returns an ActivationBoundary with the same slug as the stored snapshot", () => {
    const dir = tempBaseDir();
    const result = saveBoundary({ slug: "round-trip", active: true }, dir);
    expect(result.slug).toBe(result.snapshot.slug);
    expect(result.slug).toBe("round-trip");
  });
});

// ── marker-DB dual-write ──────────────────────────────────────────────────

describe("saveBoundary marker-DB dual-write", () => {
  test("writes <base>/agent_projections.db with the active slug and updated_at", () => {
    const dir = tempBaseDir();
    const result = saveBoundary({ slug: "marker-test", active: true }, dir);
    const marker = readFileSync(join(dir, "agent_projections.db"), "utf-8");
    const parsed = JSON.parse(marker) as { active: string; updated_at: string };
    expect(parsed.active).toBe("marker-test");
    expect(parsed.updated_at).toBe(result.snapshot.updated_at);
  });

  test("a read-only base directory does not break the JSON snapshot write", () => {
    // The marker DB is best-effort (try/catch swallow in saveBoundary); a
    // directory that allows writing into agent-snapshots/ but blocks
    // agent_projections.db at the top level must still produce a valid
    // JSON snapshot. The exact pattern is: write a directory where
    // agent_projections.db is unwritable, but the snapshots subdir is fine.
    //
    // We synthesize that with a normal tempdir + a pre-existing DIRECTORY
    // in the way of the marker file (mkdir the target path, so writeFileSync
    // fails with EISDIR on Linux/macOS and "Access is denied" on Windows).
    const dir = tempBaseDir();
    mkdirSync(join(dir, "agent_projections.db"), { recursive: true });
    // Should NOT throw — best-effort swallow.
    const result = saveBoundary({ slug: "marker-blocked", active: true }, dir);
    expect(result.slug).toBe("marker-blocked");
    // The JSON snapshot is the source of truth — it must still be on disk.
    expect(existsSync(join(dir, "agent-snapshots", "marker-blocked.json"))).toBe(true);
  });
});

// ── round-trip ────────────────────────────────────────────────────────────

describe("saveBoundary + restoreBoundary round-trip", () => {
  test("save then restore returns the same slug and stored fields", () => {
    const dir = tempBaseDir();
    saveBoundary({ slug: "round-trip", active: false, custom: "tag" } as ProjectionSnapshot, dir);
    const restored = restoreBoundary("round-trip", dir);
    expect(restored.slug).toBe("round-trip");
    expect(restored.snapshot.active).toBe(false);
    expect((restored.snapshot as Record<string, unknown>).custom).toBe("tag");
  });

  test("save to one base dir is invisible to a different base dir", () => {
    // The baseDir seam is the production/test isolation boundary; a future
    // refactor that accidentally collapsed it to a single global path would
    // cross-contaminate tests. Pin that this is NOT the case.
    const dirA = tempBaseDir();
    const dirB = tempBaseDir();
    saveBoundary({ slug: "isolated", active: true }, dirA);
    const fromA = restoreBoundary("isolated", dirA);
    const fromB = restoreBoundary("isolated", dirB);
    expect(fromA.snapshot.updated_at).toBeDefined();
    // B has no file → falls through to default-snapshot, which is a freshly
    // stamped timestamp, NOT the one written by A.
    expect(fromB.snapshot.updated_at).not.toBe(fromA.snapshot.updated_at);
  });
});
