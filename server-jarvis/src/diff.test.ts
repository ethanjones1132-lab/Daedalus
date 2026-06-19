import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { buildUnifiedDiff, applyUnifiedPatch } from "./diff";

describe("applyUnifiedPatch", () => {
  test("applies a clean unified diff and returns the new content", () => {
    const original = "line1\nline2\nline3\n";
    const modified = "line1\nLINE2\nline3\n";
    const patch = createTwoFilesPatch("f.txt", "f.txt", original, modified);
    const r = applyUnifiedPatch(original, patch);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(modified);
  });

  test("returns ok:false when the patch context does not match", () => {
    const patch = createTwoFilesPatch("f.txt", "f.txt", "line1\nline2\nline3\n", "line1\nLINE2\nline3\n");
    const r = applyUnifiedPatch("completely different content\n", patch);
    expect(r.ok).toBe(false);
    expect(r.content).toBeUndefined();
  });
});

describe("buildUnifiedDiff", () => {
  test("reports changed=false for identical content", () => {
    const d = buildUnifiedDiff("a\nb\nc\n", "a\nb\nc\n", "f.txt");
    expect(d.changed).toBe(false);
    expect(d.additions).toBe(0);
    expect(d.deletions).toBe(0);
  });

  test("captures a single-line modification as one add + one delete", () => {
    const d = buildUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.txt");
    expect(d.changed).toBe(true);
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.path).toBe("f.txt");
    // The hunk lines preserve the +/- markers for UI rendering.
    const text = d.hunks.flatMap((h) => h.lines).join("\n");
    expect(text).toContain("-b");
    expect(text).toContain("+B");
  });

  test("counts pure additions (new file from empty)", () => {
    const d = buildUnifiedDiff("", "one\ntwo\n", "new.txt");
    expect(d.changed).toBe(true);
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(0);
  });

  test("counts pure deletions", () => {
    const d = buildUnifiedDiff("one\ntwo\nthree\n", "one\nthree\n", "del.txt");
    expect(d.changed).toBe(true);
    expect(d.deletions).toBe(1);
    expect(d.additions).toBe(0);
  });
});
