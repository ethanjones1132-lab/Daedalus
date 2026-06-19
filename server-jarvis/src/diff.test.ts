import { describe, expect, test } from "bun:test";
import { buildUnifiedDiff } from "./diff";

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
