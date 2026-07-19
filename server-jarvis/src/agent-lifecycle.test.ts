// ═══════════════════════════════════════════════════════════════
// Contract pin for the agent-lifecycle.ts module (P1-03).
//
// The 170-line module wires the agent lifecycle pipeline:
//   discover → validate → project → activate
// It is the only path the Bun HTTP layer has for listing / activating
// agents (`agent-routes.ts` is a thin wrapper). A regression that drifted
// the empty-result contract, the collision marking, the fallback-slug
// sanitization, or the activate() routing would silently corrupt the
// list-agents / activate-agent UI surfaces and the durable projection
// boundary. These tests pin the observable contract without changing
// the source.
// ═══════════════════════════════════════════════════════════════

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test, afterEach } from "bun:test";
import {
  createLifecycleService,
  type LifecycleService,
  type ProjectionStore,
} from "./agent-lifecycle";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFixtureRoot(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-lifecycle-`));
  return {
    root,
    writeSoul(slugDir: string, contents: string): string {
      const dir = join(root, slugDir);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, "soul.md");
      writeFileSync(filePath, contents, "utf-8");
      return filePath;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function validSoul(slug: string, name = "Default"): string {
  return `---\nslug: ${slug}\nname: ${name}\n---\n\nBody for ${slug}.\n`;
}

let fixture: ReturnType<typeof makeFixtureRoot> | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createLifecycleService — empty / missing root", () => {
  test("scan() returns zeroed result with the requested root when the directory does not exist", () => {
    const missing = join(tmpdir(), "jarvis-lifecycle-definitely-missing-xyz");
    const service = createLifecycleService(missing);
    const result = service.scan();
    expect(result).toEqual({
      agents_root: missing,
      scanned: 0,
      valid: 0,
      invalid: 0,
      removed: 0,
      results: [],
    });
  });

  test("scan() returns zeroed result with the requested root when the directory is empty", () => {
    fixture = makeFixtureRoot("empty");
    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.agents_root).toBe(fixture.root);
    expect(result.scanned).toBe(0);
    expect(result.valid).toBe(0);
    expect(result.invalid).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.results).toEqual([]);
  });

  test("activate() returns false when the root does not exist", () => {
    const missing = join(tmpdir(), "jarvis-lifecycle-missing-activate-xyz");
    const service = createLifecycleService(missing);
    expect(service.activate("anything")).toBe(false);
  });
});

describe("createLifecycleService — single valid agent", () => {
  test("scan() picks up a single directory with a valid soul.md and reports scanned=1, valid=1, invalid=0", () => {
    fixture = makeFixtureRoot("one-valid");
    fixture.writeSoul("coder", validSoul("coder", "Coder"));
    const service = createLifecycleService(fixture.root);

    const result = service.scan();
    expect(result.scanned).toBe(1);
    expect(result.valid).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.results).toHaveLength(1);
    const entry = result.results[0];
    expect(entry.status).toBe("valid");
    expect(entry.slug).toBe("coder");
    expect(entry.name).toBe("Coder");
    expect(entry.source_path).toMatch(/soul\.md$/);
    expect(entry.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof entry.source_size_bytes).toBe("number");
    expect(entry.source_size_bytes).toBeGreaterThan(0);
  });

  test("activate() returns true for the slug of a valid entry (no store)", () => {
    fixture = makeFixtureRoot("activate-ok");
    fixture.writeSoul("reviewer", validSoul("reviewer"));
    const service = createLifecycleService(fixture.root);
    expect(service.activate("reviewer")).toBe(true);
  });

  test("activate() returns false for a slug that is not present (no store)", () => {
    fixture = makeFixtureRoot("activate-miss");
    fixture.writeSoul("present", validSoul("present"));
    const service = createLifecycleService(fixture.root);
    expect(service.activate("absent")).toBe(false);
  });
});

describe("createLifecycleService — directory filtering", () => {
  test("directories without a soul.md are NOT included in results", () => {
    fixture = makeFixtureRoot("filter");
    fixture.writeSoul("with-soul", validSoul("with-soul"));
    mkdirSync(join(fixture.root, "no-soul-here"), { recursive: true });
    mkdirSync(join(fixture.root, "also-no-soul"), { recursive: true });

    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.scanned).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].slug).toBe("with-soul");
  });
});

describe("createLifecycleService — invalid soul.md", () => {
  test("a missing frontmatter block is reported as invalid with the parser's error", () => {
    fixture = makeFixtureRoot("no-frontmatter");
    fixture.writeSoul("broken", "no frontmatter here, just prose\n");
    const service = createLifecycleService(fixture.root);

    const result = service.scan();
    expect(result.scanned).toBe(1);
    expect(result.valid).toBe(0);
    expect(result.invalid).toBe(1);
    const entry = result.results[0];
    expect(entry.status).toBe("invalid");
    expect(entry.errors).toBeDefined();
    expect(entry.errors!.length).toBeGreaterThan(0);
    // Identity fields are not populated for invalid entries.
    expect(entry.name).toBeUndefined();
    expect(entry.tools).toBeUndefined();
  });

  test("the fallback slug is the directory name sanitized to lowercase letters, numbers, and hyphens", () => {
    fixture = makeFixtureRoot("fallback-slug");
    fixture.writeSoul("Has Spaces!", "no frontmatter, just prose");
    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.results).toHaveLength(1);
    const entry = result.results[0];
    expect(entry.status).toBe("invalid");
    // 'Has Spaces!' → 'has-spaces-' (trailing hyphen stripped) → 'has-spaces'
    expect(entry.slug).toBe("has-spaces");
  });

  test("a directory name composed entirely of non-allowed characters sanitizes to a single hyphen (not the original)", () => {
    fixture = makeFixtureRoot("fallback-empty");
    // The sanitize function strips characters not in [a-zA-Z0-9-], then
    // trims leading/trailing hyphens. For '!!!' this becomes '---' (after
    // first replace), then a single '-' (the middle character remains
    // because /^-|-$/g with the g flag strips all leading AND all trailing
    // hyphens but leaves interior ones alone). The `|| slugDir` fallback
    // therefore never fires for the "all invalid characters" case — the
    // contract here is the actual behavior, not the textual intent.
    fixture.writeSoul("!!!", "no frontmatter");
    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].slug).toBe("-");
  });

  test("a directory name with leading and trailing hyphens has one stripped from each end (one, not all)", () => {
    fixture = makeFixtureRoot("fallback-trim");
    // '---coder---' → step1 (replace non-allowed) leaves it unchanged
    // because hyphens are already in the allowed set → '---coder---'.
    // Step 3 (/^-|-$/g) only matches ONE leading AND ONE trailing hyphen
    // (the g flag iterates alternation patterns, but ^ and $ anchors
    // can each match at most once per regex pass; a future fix that
    // changes the regex to /^-+|-+$/g to strip all leading/trailing
    // hyphens would change the contract here).
    fixture.writeSoul("---coder---", "no frontmatter");
    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.results[0].slug).toBe("--coder--");
  });

  test("the invalid entry still carries provenance (source_path, hash, size)", () => {
    fixture = makeFixtureRoot("invalid-provenance");
    fixture.writeSoul("bad", "no frontmatter");
    const service = createLifecycleService(fixture.root);
    const entry = service.scan().results[0];
    expect(entry.source_path).toMatch(/soul\.md$/);
    expect(entry.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof entry.source_size_bytes).toBe("number");
  });

  test("activate() returns false for a slug whose only entry is invalid (no store)", () => {
    fixture = makeFixtureRoot("activate-invalid");
    fixture.writeSoul("bad", "no frontmatter");
    const service = createLifecycleService(fixture.root);
    expect(service.activate("bad")).toBe(false);
  });
});

describe("createLifecycleService — slug collision detection", () => {
  test("two directories declaring the same valid slug both get marked as collision (no winner)", () => {
    fixture = makeFixtureRoot("collision");
    // Both soul.md files have slug: 'coder' in their frontmatter.
    fixture.writeSoul("a-coder", validSoul("coder", "A"));
    fixture.writeSoul("b-coder", validSoul("coder", "B"));

    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.scanned).toBe(2);
    // Collisions are NOT counted as valid.
    expect(result.valid).toBe(0);
    // Both colliding entries count as invalid in the aggregate count.
    expect(result.invalid).toBe(2);
    expect(result.results).toHaveLength(2);
    for (const entry of result.results) {
      expect(entry.status).toBe("collision");
      expect(entry.errors).toBeDefined();
      expect(entry.errors!.some((e) => e.code === "SLUG_COLLISION")).toBe(true);
    }
  });

  test("collision marking is gated on status==='valid': an invalid entry whose fallback slug collides with a valid entry stays 'invalid'", () => {
    fixture = makeFixtureRoot("collision-errors");
    // Valid entry declares slug 'coder' in frontmatter.
    fixture.writeSoul("dir-a", validSoul("coder", "A"));
    // Invalid entry: its directory name sanitizes to 'coder' (the same slug
    // as the valid entry's identity slug), but parsing fails. This is the
    // only way to get two entries with the same effective slug where one is
    // valid and the other is not.
    fixture.writeSoul("coder", "no frontmatter, will be invalid with fallback slug 'coder'");

    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.scanned).toBe(2);
    // The valid entry gets promoted to 'collision' (its slug collides with
    // the invalid entry's fallback slug).
    const collision = result.results.find((e) => e.status === "collision");
    const invalid = result.results.find((e) => e.status === "invalid");
    expect(collision).toBeDefined();
    expect(invalid).toBeDefined();
    // Pin the contract: collision marking is gated on status==='valid', so
    // an invalid entry with a colliding fallback slug is NOT promoted to
    // 'collision' and does NOT get a SLUG_COLLISION error appended to it.
    expect(invalid!.status).toBe("invalid");
    expect(invalid!.errors?.some((e) => e.code === "SLUG_COLLISION")).toBe(false);
    // And the valid entry DID get its status flipped to collision.
    expect(collision!.status).toBe("collision");
    expect(collision!.errors?.some((e) => e.code === "SLUG_COLLISION")).toBe(true);
  });

  test("activate() returns false for a slug in collision state (no store)", () => {
    fixture = makeFixtureRoot("activate-collision");
    fixture.writeSoul("a-coder", validSoul("coder", "A"));
    fixture.writeSoul("b-coder", validSoul("coder", "B"));
    const service = createLifecycleService(fixture.root);
    expect(service.activate("coder")).toBe(false);
  });

  test("collision message names the conflicting slug verbatim", () => {
    fixture = makeFixtureRoot("collision-msg");
    fixture.writeSoul("a", validSoul("shared", "A"));
    fixture.writeSoul("b", validSoul("shared", "B"));
    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    for (const entry of result.results) {
      const collisionErr = entry.errors?.find((e) => e.code === "SLUG_COLLISION");
      expect(collisionErr).toBeDefined();
      expect(collisionErr!.message).toContain('"shared"');
    }
  });
});

describe("createLifecycleService — sort order", () => {
  test("results are sorted alphabetically by slug (then by source_path) so the list is stable", () => {
    fixture = makeFixtureRoot("sort");
    // Write in a deliberately non-sorted order on disk; the contract is
    // that scan() returns them in slug-sorted order regardless.
    fixture.writeSoul("charlie", validSoul("charlie"));
    fixture.writeSoul("alpha", validSoul("alpha"));
    fixture.writeSoul("bravo", validSoul("bravo"));

    const service = createLifecycleService(fixture.root);
    const slugs = service.scan().results.map((r) => r.slug);
    expect(slugs).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("createLifecycleService — mix of statuses", () => {
  test("valid + invalid + collision all roll up correctly into scanned/valid/invalid", () => {
    fixture = makeFixtureRoot("mix");
    fixture.writeSoul("good", validSoul("good"));
    fixture.writeSoul("bad", "no frontmatter");
    fixture.writeSoul("dup-a", validSoul("dup", "A"));
    fixture.writeSoul("dup-b", validSoul("dup", "B"));

    const service = createLifecycleService(fixture.root);
    const result = service.scan();
    expect(result.scanned).toBe(4);
    expect(result.valid).toBe(1); // only 'good'
    expect(result.invalid).toBe(3); // 'bad' (1) + 'dup-a' collision + 'dup-b' collision
    const bySlug = Object.fromEntries(result.results.map((r) => [r.slug, r.status]));
    expect(bySlug.good).toBe("valid");
    expect(bySlug.bad).toBe("invalid");
    expect(bySlug.dup).toBe("collision");
  });

  test("removed is always 0 — the Bun lifecycle layer does not delete Rust projections", () => {
    fixture = makeFixtureRoot("removed-zero");
    fixture.writeSoul("one", validSoul("one"));
    const service = createLifecycleService(fixture.root);
    const r1 = service.scan();
    expect(r1.removed).toBe(0);
    // Second scan must also report 0 — removed is per-call, not cumulative.
    const r2 = service.scan();
    expect(r2.removed).toBe(0);
  });
});

describe("createLifecycleService — activate() with a ProjectionStore", () => {
  test("delegates to store.activate(slug) and returns its boolean verbatim", () => {
    fixture = makeFixtureRoot("store-ok");
    fixture.writeSoul("alpha", validSoul("alpha"));

    const calls: string[] = [];
    const store: ProjectionStore = {
      activate(slug: string) {
        calls.push(slug);
        return true;
      },
    };
    const service = createLifecycleService(fixture.root, store);
    expect(service.activate("alpha")).toBe(true);
    expect(calls).toEqual(["alpha"]);
  });

  test("store returning false short-circuits the answer (does not consult the scan)", () => {
    fixture = makeFixtureRoot("store-false");
    fixture.writeSoul("alpha", validSoul("alpha"));
    const store: ProjectionStore = { activate: () => false };
    const service = createLifecycleService(fixture.root, store);
    // Even though 'alpha' is a valid scan entry, the store says no.
    expect(service.activate("alpha")).toBe(false);
  });

  test("store is consulted even for slugs not present in scan()", () => {
    fixture = makeFixtureRoot("store-missing-slug");
    fixture.writeSoul("alpha", validSoul("alpha"));
    const store: ProjectionStore = { activate: (slug) => slug === "ghost" };
    const service = createLifecycleService(fixture.root, store);
    // 'ghost' is not on disk, but the store is the authority when present.
    expect(service.activate("ghost")).toBe(true);
  });
});
