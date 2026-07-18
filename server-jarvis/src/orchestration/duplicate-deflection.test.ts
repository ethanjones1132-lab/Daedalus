// 2026-07-18 live incident: the executor legitimately re-read a file to
// compose an edit, got a 500-char preview + lecture, and reported
// "duplicate read-call restriction" as the reason no write happened. A
// repeated identical read now REPLAYS the full cached output (still marked
// with the deflection marker so it earns no evidence credit — the actual
// purpose of the 2026-07-12 repetition guard).
import { describe, expect, test } from "bun:test";
import { duplicateToolCallDeflection } from "./pipeline";
import { isDuplicateToolDeflection } from "./stage-output";

const bigOutput = Array.from({ length: 400 }, (_, i) => `${i + 1} | line ${i + 1}`).join("\n");

describe("duplicateToolCallDeflection", () => {
  test("replays the FULL cached output, not a preview", () => {
    const result = duplicateToolCallDeflection(
      { id: "c1", name: "read_file", arguments: { path: "x.cpp" } },
      bigOutput,
    );
    expect(result.is_error).toBe(false);
    expect(result.output).toContain(`line 400`);
    expect(result.output.length).toBeGreaterThan(bigOutput.length);
  });

  test("replay keeps the deflection marker so it earns no evidence credit", () => {
    const result = duplicateToolCallDeflection(
      { id: "c2", name: "read_file", arguments: { path: "x.cpp" } },
      bigOutput,
    );
    expect(isDuplicateToolDeflection({ output: result.output })).toBe(true);
  });

  test("with no cached output, still deflects with redirect guidance", () => {
    const result = duplicateToolCallDeflection(
      { id: "c3", name: "glob", arguments: { pattern: "*" } },
      undefined,
    );
    expect(isDuplicateToolDeflection({ output: result.output })).toBe(true);
    expect(result.output).toContain("NEW target");
  });
});
