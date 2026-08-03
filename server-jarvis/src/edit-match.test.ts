import { describe, expect, test } from "bun:test";
import { applyEditMatch, locateEditMatch } from "./edit-match";

function roundTrip(content: string, oldStr: string, newStr: string): string {
  const match = locateEditMatch(content, oldStr);
  if (match.kind !== "match") throw new Error(`expected match, got ${match.kind}`);
  return applyEditMatch(content, match, newStr);
}

describe("locateEditMatch", () => {
  test("exact unique match", () => {
    const content = "line a\nreturn now > expires\nline c\n";
    const match = locateEditMatch(content, "return now > expires");
    expect(match).toMatchObject({ kind: "match", tolerant: false });
    expect(roundTrip(content, "return now > expires", "return now < expires"))
      .toBe("line a\nreturn now < expires\nline c\n");
  });

  test("exact duplicate is ambiguous", () => {
    const content = "x = 1\nx = 1\n";
    expect(locateEditMatch(content, "x = 1").kind).toBe("ambiguous");
  });

  test("genuinely absent string is not_found", () => {
    expect(locateEditMatch("a\nb\n", "totally different").kind).toBe("not_found");
  });

  // ── The 2026-07-24 tier-2B failure modes: right code, wrong whitespace ──
  test("tolerates trailing whitespace the file does not have", () => {
    const content = "def f():\n    return now > expires\n";
    // model reproduced the line WITH a trailing space; file has none → exact fails
    const match = locateEditMatch(content, "    return now > expires   ");
    expect(match).toMatchObject({ kind: "match", tolerant: true });
    expect(roundTrip(content, "    return now > expires   ", "    return now < expires"))
      .toBe("def f():\n    return now < expires\n");
  });

  test("tolerates CRLF vs LF line endings", () => {
    const content = "def f():\r\n    return now > expires\r\n";
    // model reproduced with LF; file is CRLF → exact fails
    const match = locateEditMatch(content, "def f():\n    return now > expires");
    expect(match).toMatchObject({ kind: "match", tolerant: true });
    const updated = roundTrip(content, "def f():\n    return now > expires", "def f():\n    return now < expires");
    expect(updated).toContain("return now < expires");
    expect(updated).not.toContain("return now > expires");
  });

  test("tolerates the model over-indenting the needle", () => {
    const content = "if x:\n    pass\n"; // 4-space indent in the file
    const match = locateEditMatch(content, "        pass"); // model used 8 spaces
    expect(match).toMatchObject({ kind: "match", tolerant: true });
    // replacement text is used verbatim; only the located span is swapped
    expect(roundTrip(content, "        pass", "    raise ValueError('x')"))
      .toBe("if x:\n    raise ValueError('x')\n");
  });

  test("tolerates Claude Code line-number gutters in the needle", () => {
    const content = "# Perihelion VST3\nvoid prepareToPlay() {\n  reset();\n}\n";
    const oldStr = "1\t# Perihelion VST3\n2\tvoid prepareToPlay() {";
    const match = locateEditMatch(content, oldStr);

    expect(match).toMatchObject({ kind: "match", tolerant: true });
    expect(roundTrip(content, oldStr, "# Perihelion VST3\nvoid prepareToPlay() {"))
      .toBe(content);
  });

  test("tolerant match stays unique — two trimmed-equal lines are ambiguous", () => {
    const content = "if a:\n        return x\nif b:\n    return x\n";
    // both "return x" lines differ in indent, so exact fails; trimmed they tie
    expect(locateEditMatch(content, "\treturn x").kind).toBe("ambiguous");
  });

  test("multi-line block with drifted indentation maps to the correct span", () => {
    const content = "a\n    if subtotal > 200:\n        return 0.20\n    if subtotal > 100:\n        return 0.10\nb\n";
    const oldStr = "if subtotal > 200:\n    return 0.20"; // de-indented by the model
    const updated = roundTrip(content, oldStr, "        if subtotal >= 200:\n            return 0.20");
    expect(updated).toContain("if subtotal >= 200:");
    expect(updated).toContain("if subtotal > 100:"); // the second tier left untouched
  });

  test("empty/blank needle does not match", () => {
    expect(locateEditMatch("a\nb\n", "\n  \n").kind).toBe("not_found");
  });
});
