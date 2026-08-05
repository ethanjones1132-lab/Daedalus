import { describe, expect, test } from "bun:test";
import {
  applyRepairedEdit,
  repairEditPair,
  repairMultiEditPairs,
  stripLineNumberGutter,
} from "./edit-contract";

describe("stripLineNumberGutter", () => {
  test("strips read_file gutter", () => {
    expect(stripLineNumberGutter("     2 |   return 1;")).toBe("  return 1;");
  });
});

describe("repairEditPair", () => {
  test("exact unique match needs no repair", () => {
    const content = "hello world\n";
    const r = repairEditPair(content, "hello", "hi");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(false);
    expect(r.matchKind).toBe("exact");
    expect(applyRepairedEdit(content, r)).toBe("hi world\n");
  });

  test("repairs trailing-whitespace drift (tolerant)", () => {
    const content = "def f():\n    return now > expires\n";
    const r = repairEditPair(content, "    return now > expires   ", "    return now < expires");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.matchKind).toBe("tolerant");
    expect(r.old_string).toBe("    return now > expires");
    expect(applyRepairedEdit(content, r)).toBe("def f():\n    return now < expires\n");
  });

  test("repairs read_file gutter paste", () => {
    const content = "function a() {\n  return 1;\n}\n";
    const r = repairEditPair(content, "     2 |   return 1;", "     2 |   return 2;");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matchKind).toBe("gutter");
    expect(r.new_string).toBe("  return 2;");
    expect(applyRepairedEdit(content, r)).toBe("function a() {\n  return 2;\n}\n");
  });

  test("missing string → not_found", () => {
    expect(repairEditPair("alpha beta", "gamma", "delta")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("duplicate exact match → ambiguous", () => {
    expect(repairEditPair("hello hello", "hello", "hi")).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  test("noop when old equals new after match", () => {
    expect(repairEditPair("hello world", "hello", "hello")).toEqual({
      ok: false,
      reason: "noop",
    });
  });
});

describe("repairMultiEditPairs", () => {
  test("applies sequential repairs; skips missing", () => {
    const content = "a\nb\nc\n";
    const { content: next, applied, items } = repairMultiEditPairs(content, [
      { old_string: "a", new_string: "A" },
      { old_string: "missing", new_string: "x" },
      { old_string: "b", new_string: "B" },
    ]);
    expect(applied).toBe(2);
    expect(next).toBe("A\nB\nc\n");
    expect(items[1]?.skipped).toBe("not_found");
  });
});
