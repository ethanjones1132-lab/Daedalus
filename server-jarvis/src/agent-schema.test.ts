import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { describe, expect, test, afterEach } from "bun:test";
import { parseSoulFile } from "./agent-schema";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFixtureRoot(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-soul-`));
  return {
    root,
    writeSoul(slug: string, contents: string): string {
      const dir = join(root, slug);
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

let fixture: ReturnType<typeof makeFixtureRoot> | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

function writeAndParse(slug: string, contents: string) {
  const filePath = fixture!.writeSoul(slug, contents);
  return { filePath, result: parseSoulFile(filePath) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("parseSoulFile — provenance", () => {
  test("populates source_path, sha256 source_hash, and utf-8 source_size_bytes on a valid file", () => {
    fixture = makeFixtureRoot("prov-ok");
    const body = "# Hello\n\nDo the thing.\n";
    const filePath = fixture.writeSoul("coder", `---\nslug: coder\nname: Coder\n---\n\n${body}`);

    const { result } = writeAndParse("coder", `---\nslug: coder\nname: Coder\n---\n\n${body}`);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.provenance.source_path).toBe(filePath);
    expect(result.provenance.source_hash).toMatch(/^[a-f0-9]{64}$/);
    // The hash must match a direct sha256 of the on-disk content.
    const onDisk = readFileSync(filePath, "utf-8");
    const expectedHash = createHash("sha256").update(onDisk).digest("hex");
    expect(result.provenance.source_hash).toBe(expectedHash);
    expect(result.provenance.source_size_bytes).toBe(Buffer.byteLength(onDisk, "utf-8"));
  });

  test("still populates provenance when parsing fails (so operators can attribute errors to a file)", () => {
    fixture = makeFixtureRoot("prov-fail");
    // No frontmatter at all — must fail, but provenance must still be there.
    const { filePath, result } = writeAndParse("broken", "no frontmatter here, just prose\n");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.provenance.source_path).toBe(filePath);
    expect(result.provenance.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provenance.source_size_bytes).toBeGreaterThan(0);
  });
});

describe("parseSoulFile — happy path", () => {
  test("extracts slug, name, description, version, tools, and trimmed instructions", () => {
    fixture = makeFixtureRoot("happy");
    const { result } = writeAndParse(
      "coder",
      `---
slug: coder
name: "Coder"
description: Writes and reviews code
version: "1.0.0"
tools:
  - bash
  - read_file
---

# Heading

Body line 1.
  Body line 2 (with leading spaces trimmed).
`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity).toEqual({
      slug: "coder",
      name: "Coder",
      description: "Writes and reviews code",
      version: "1.0.0",
      tools: ["bash", "read_file"],
      instructions: "# Heading\n\nBody line 1.\n  Body line 2 (with leading spaces trimmed).",
    });
  });

  test("omits optional fields (description/version/tools) when absent", () => {
    fixture = makeFixtureRoot("minimal");
    const { result } = writeAndParse(
      "minimal",
      `---\nslug: minimal\nname: Minimal\n---\n\nbody`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity).toEqual({
      slug: "minimal",
      name: "Minimal",
      instructions: "body",
    });
    // Confirm the optional keys are NOT present on the object (not even undefined).
    expect("description" in result.identity).toBe(false);
    expect("version" in result.identity).toBe(false);
    expect("tools" in result.identity).toBe(false);
  });

  test("accepts an inline `tools: [a, b]` array in addition to the list form", () => {
    fixture = makeFixtureRoot("inline-tools");
    const { result } = writeAndParse(
      "inline",
      `---\nslug: inline\nname: Inline\ntools: [bash, read_file, glob]\n---\n\nbody`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity.tools).toEqual(["bash", "read_file", "glob"]);
  });

  test("preserves the frontmatter on disk as a verbatim frontmatter (--- ... ---) block", () => {
    fixture = makeFixtureRoot("frontmatter-shape");
    const { filePath } = writeAndParse(
      "shape",
      `---\nslug: shape\nname: Shape\n---\n\nbody content`,
    );
    const raw = readFileSync(filePath, "utf-8");
    // Sanity: the helper must have actually consumed the leading `---` line.
    expect(raw.startsWith("---\n")).toBe(true);
    // The first closing `---` must appear before the body.
    const closeIdx = raw.indexOf("\n---\n");
    expect(closeIdx).toBeGreaterThan(4);
  });
});

describe("parseSoulFile — frontmatter errors", () => {
  test("returns ok:false with MISSING_REQUIRED_FIELD/field:frontmatter when the frontmatter block is missing", () => {
    fixture = makeFixtureRoot("no-fm");
    const { result } = writeAndParse("nofm", "no frontmatter here, just prose\n");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: "MISSING_REQUIRED_FIELD",
      field: "frontmatter",
    });
  });

  test("flags an UNKNOWN_KEY error for any frontmatter key outside the allowlist", () => {
    fixture = makeFixtureRoot("unknown-key");
    const { result } = writeAndParse(
      "weird",
      `---\nslug: weird\nname: Weird\nmood: cheerful\n---\n\nbody`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("UNKNOWN_KEY");
    const moodErr = result.errors.find((e) => e.field === "mood");
    expect(moodErr).toBeDefined();
    expect(moodErr!.code).toBe("UNKNOWN_KEY");
    expect(moodErr!.message).toContain("mood");
  });

  test("flags every runtime-state field as RUNTIME_STATE_FIELD (not just the first one)", () => {
    fixture = makeFixtureRoot("runtime-state");
    const { result } = writeAndParse(
      "dirty",
      [
        `---`,
        `slug: dirty`,
        `name: Dirty`,
        `active: true`,
        `status: ready`,
        `memory: x`,
        `happiness: 9`,
      ].join("\n") + `\n---\n\nbody`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const runtimeErrors = result.errors.filter((e) => e.code === "RUNTIME_STATE_FIELD");
    // active + status + memory + happiness are all in the runtime-state denylist
    expect(runtimeErrors.length).toBeGreaterThanOrEqual(4);
    const fields = runtimeErrors.map((e) => e.field).sort();
    expect(fields).toContain("active");
    expect(fields).toContain("status");
    expect(fields).toContain("memory");
    expect(fields).toContain("happiness");
  });
});

describe("parseSoulFile — required fields and slug format", () => {
  test("flags MISSING_REQUIRED_FIELD for slug when omitted", () => {
    fixture = makeFixtureRoot("no-slug");
    const { result } = writeAndParse(
      "no-slug",
      `---\nname: Has Name\n---\n\nbody`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const slugErr = result.errors.find((e) => e.field === "slug");
    expect(slugErr).toBeDefined();
    expect(slugErr!.code).toBe("MISSING_REQUIRED_FIELD");
  });

  test("flags MISSING_REQUIRED_FIELD for name when omitted", () => {
    fixture = makeFixtureRoot("no-name");
    const { result } = writeAndParse(
      "no-name",
      `---\nslug: has-slug\n---\n\nbody`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const nameErr = result.errors.find((e) => e.field === "name");
    expect(nameErr).toBeDefined();
    expect(nameErr!.code).toBe("MISSING_REQUIRED_FIELD");
  });

  test("flags INVALID_TYPE for an uppercase or otherwise malformed slug", () => {
    fixture = makeFixtureRoot("bad-slug");
    // Leading hyphen violates ^[a-z0-9][a-z0-9-]*$
    const { result: r1 } = writeAndParse("a", `---\nslug: "-bad"\nname: x\n---\n\nbody`);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      const slugErr = r1.errors.find((e) => e.field === "slug");
      expect(slugErr?.code).toBe("INVALID_TYPE");
    }

    // Uppercase letter violates the regex
    const { result: r2 } = writeAndParse("b", `---\nslug: "BadSlug"\nname: x\n---\n\nbody`);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      const slugErr = r2.errors.find((e) => e.field === "slug");
      expect(slugErr?.code).toBe("INVALID_TYPE");
    }
  });

  test("accepts a slug that matches the canonical regex", () => {
    fixture = makeFixtureRoot("good-slug");
    const { result } = writeAndParse(
      "ok",
      `---\nslug: "ok-123"\nname: OK\n---\n\nbody`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity.slug).toBe("ok-123");
  });

  test("flags MISSING_REQUIRED_FIELD for instructions when the body is empty/whitespace", () => {
    fixture = makeFixtureRoot("empty-body");
    const { result } = writeAndParse(
      "empty",
      `---\nslug: empty\nname: Empty\n---\n\n   \n`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const instrErr = result.errors.find((e) => e.field === "instructions");
    expect(instrErr).toBeDefined();
    expect(instrErr!.code).toBe("MISSING_REQUIRED_FIELD");
  });
});

describe("parseSoulFile — INVALID_TYPE for non-string scalars and bad tools", () => {
  test("flags INVALID_TYPE when description is a list (not a string)", () => {
    fixture = makeFixtureRoot("bad-desc");
    const { result } = writeAndParse(
      "x",
      [
        `---`,
        `slug: x`,
        `name: x`,
        `description:`,
        `  - a`,
        `  - b`,
      ].join("\n") + `\n---\n\nbody`,
    );
    // description became an array (list-form) — must be flagged as INVALID_TYPE
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const descErr = result.errors.find((e) => e.field === "description");
    expect(descErr?.code).toBe("INVALID_TYPE");
  });

  test("flags INVALID_TYPE when tools is a single string instead of a list", () => {
    fixture = makeFixtureRoot("bad-tools");
    // tools: bash (no list markers, no inline brackets) → scalar string
    const { result } = writeAndParse(
      "x",
      `---\nslug: x\nname: x\ntools: bash\n---\n\nbody`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const toolsErr = result.errors.find((e) => e.field === "tools");
    expect(toolsErr?.code).toBe("INVALID_TYPE");
    expect(toolsErr?.message).toContain("string array");
  });
});

describe("parseSoulFile — scalar parsing edge cases", () => {
  test("trims whitespace from scalar string values", () => {
    fixture = makeFixtureRoot("trim-scalar");
    const { result } = writeAndParse(
      "trim",
      `---\nslug: trim\nname: "  Padded Name  "\n---\n\nbody`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity.name).toBe("Padded Name");
  });

  test("parses single-quoted scalars the same as double-quoted", () => {
    fixture = makeFixtureRoot("single-quote");
    const { result } = writeAndParse(
      "sq",
      `---\nslug: sq\nname: 'Single Quoted'\n---\n\nbody`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity.name).toBe("Single Quoted");
  });

  test("ignores # comment lines in the frontmatter", () => {
    fixture = makeFixtureRoot("comments");
    const { result } = writeAndParse(
      "c",
      [
        `---`,
        `# leading comment`,
        `slug: c`,
        `# inline comment`,
        `name: C`,
      ].join("\n") + `\n---\n\nbody`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.identity.slug).toBe("c");
    expect(result.identity.name).toBe("C");
  });
});

describe("parseSoulFile — error envelope", () => {
  test("returns a ValidationError array with one of the four documented error codes", () => {
    fixture = makeFixtureRoot("envelope");
    const { result } = writeAndParse(
      "e",
      `---\nslug: -bad\nname: E\nunknown_field: x\n---\n\nbody`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const codes = new Set(result.errors.map((e) => e.code));
    // Must contain at least one of the four documented codes.
    const allowed: Array<typeof result.errors[number]["code"]> = [
      "MISSING_REQUIRED_FIELD",
      "INVALID_TYPE",
      "UNKNOWN_KEY",
      "RUNTIME_STATE_FIELD",
    ];
    for (const code of codes) {
      expect(allowed).toContain(code);
    }
  });

  test("every error has a non-empty message (operator-debuggable)", () => {
    fixture = makeFixtureRoot("msg-shape");
    const { result } = writeAndParse(
      "m",
      `---\nslug: -bad\nname: M\n---\n\nbody`,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    for (const err of result.errors) {
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});
