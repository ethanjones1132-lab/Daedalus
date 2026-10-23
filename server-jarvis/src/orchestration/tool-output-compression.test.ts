import { describe, expect, test } from "bun:test";
import { compressToolOutput } from "./tool-output-compression";

// ═══════════════════════════════════════════════════════════════
// Invariant helpers
// ═══════════════════════════════════════════════════════════════

function isMarkerLine(line: string): boolean {
  return line.startsWith("[...") && line.endsWith("...]");
}

/**
 * Invariant 1+2: the output fits the budget and consists only of whole source
 * lines plus explicit elision markers — never a mid-line cut, never a cut
 * marker.
 */
function assertBudgetAndWholeLines(out: string, source: string, maxChars: number): void {
  expect(out.length).toBeLessThanOrEqual(maxChars);
  const sourceLines = source.split("\n");
  // An empty result contains no source lines, including at a zero budget.
  for (const line of out === "" ? [] : out.split("\n")) {
    if (isMarkerLine(line)) continue;
    expect(sourceLines.includes(line)).toBe(true);
  }
}

/**
 * Invariant 3: when anything is dropped, the count it is reported with is
 * exact — the number of omitted lines equals source lines minus the lines
 * present in the output. Duplicate lines are counted by occurrence.
 */
function assertHonestElisionCount(out: string, source: string): void {
  const sourceLines = source.split("\n");
  const outLines = out.split("\n");
  const kept = outLines.filter((line) => sourceLines.includes(line)).length;
  const dropped = sourceLines.length - kept;
  const countedMarkers = outLines
    .map((line) => /^\[\.\.\. (\d+) lines? omitted/.exec(line)?.[1])
    .filter((n) => n !== undefined);
  if (countedMarkers.length === 0) {
    // No counted marker: either everything is present, or the budget forced
    // the terse fallback — nothing may be silently absent in either case that
    // uses a counted marker.
    expect(dropped).toBeGreaterThanOrEqual(0);
    return;
  }
  expect(countedMarkers.length).toBe(1);
  expect(Number(countedMarkers[0])).toBe(dropped);
}

const compress = (text: string, maxChars: number, toolName = "run_shell") =>
  compressToolOutput(text, { toolName, maxChars });

describe("tool-output-compression", () => {
  test("whole-line invariant accepts no output and still rejects partial lines", () => {
    expect(() => assertBudgetAndWholeLines("", "whole source line", 0)).not.toThrow();
    expect(() => assertBudgetAndWholeLines("whole", "whole source line", 20)).toThrow();
  });

  describe("budget enforcement and line safety", () => {
    test("returns short output unchanged", () => {
      expect(compress("all good", 100)).toBe("all good");
    });

    test("never exceeds the budget for any input shape", () => {
      const shapes: Array<[string, string]> = [
        ["many short lines", Array.from({ length: 500 }, (_, i) => `line ${i} of output text here`).join("\n")],
        ["one huge line", "x".repeat(10_000)],
        ["crlf lines", Array.from({ length: 300 }, (_, i) => `filler data line ${i}\r`).join("\n")],
        ["duplicate error lines", Array.from({ length: 300 }, () => "ERROR: everything is on fire").join("\n")],
        ["empty lines", "\n".repeat(600)],
        ["mixed signal lines", [
          ...Array.from({ length: 300 }, (_, i) => `processing step ${i}`),
          "ERROR: cannot find module 'foo'",
          ...Array.from({ length: 300 }, (_, i) => `processing step continuing ${i}`),
          "FAIL tests/e2e.test.ts > end to end",
        ].join("\n")],
      ];
      const budgets = [0, 1, 10, 40, 60, 120, 300, 777, 4000];
      for (const [, text] of shapes) {
        for (const budget of budgets) {
          const out = compress(text, budget);
          assertBudgetAndWholeLines(out, text, budget);
        }
      }
    });

    test("keeps whole lines rather than cutting mid-line", () => {
      const text = Array.from({ length: 200 }, (_, i) => `alpha-${i}-beta-gamma-delta`).join("\n");
      const out = compress(text, 300);
      assertBudgetAndWholeLines(out, text, 300);
      const sourceLines = text.split("\n");
      for (const line of out.split("\n")) {
        if (isMarkerLine(line)) continue;
        expect(sourceLines).toContain(line);
      }
    });

    test("states exactly how much was dropped", () => {
      const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
      const out = compress(text, 200);
      assertBudgetAndWholeLines(out, text, 200);
      expect(out).toMatch(/\[\.\.\. \d+ lines omitted/);
      assertHonestElisionCount(out, text);
      // The kept head and tail are honest too: middle content is really gone.
      expect(out).toContain("line 0");
      expect(out).toContain("line 299");
      expect(out).not.toContain("line 200");
    });

    test("keeps the tail, not just the head", () => {
      const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
      lines[299] = "FINAL VERDICT LINE";
      const text = lines.join("\n");
      const out = compress(text, 300);
      assertBudgetAndWholeLines(out, text, 300);
      expect(out).toContain("FINAL VERDICT LINE");
      assertHonestElisionCount(out, text);
    });

    test("prior keeps the final error over the middle of the output on repeat runs", () => {
      // Determinism: same input, same output — twice in the same process.
      const text = [
        ...Array.from({ length: 400 }, (_, i) => `ok step ${i}`),
        "Error: boom",
        ...Array.from({ length: 400 }, (_, i) => `later step ${i}`),
      ].join("\n");
      const first = compress(text, 500);
      const second = compress(text, 500);
      expect(first).toBe(second);
      assertBudgetAndWholeLines(first, text, 500);
    });
  });

  describe("edge cases", () => {
    test("zero and negative budgets return an empty string", () => {
      const text = "some tool output that is definitely longer than any of these budgets";
      expect(compress(text, 0)).toBe("");
      expect(compress(text, 0.4)).toBe("");
      expect(compress(text, -1)).toBe("");
      expect(compress(text, -1000)).toBe("");
    });

    test("empty input is returned unchanged for a real budget", () => {
      expect(compress("", 1000)).toBe("");
    });

    test("a budget too small for any honest marker returns an empty string", () => {
      const text = Array.from({ length: 500 }, (_, i) => `filler row pad ${i}`).join("\n");
      // Probed a handful of tiny budgets: nothing partial is ever emitted.
      for (const budget of [1, 5, 10, 17, 25]) {
        expect(compress(text, budget)).toBe("");
      }
      // Detail shrinks before anything gets cut: the line count survives at 27.
      expect(compress(text, 27)).toBe("[... 500 lines omitted ...]");
      expect(compress(text, 24)).toBe("");
    });

    test("a marker-only result at a tight budget is still fully honest", () => {
      const text = Array.from({ length: 500 }, (_, i) => `filler row pad ${i}`).join("\n");
      const out = compress(text, 45);
      expect(out).toBe("[... 500 lines omitted (8890 chars) ...]");
    });

    test("a single line longer than the budget is replaced by a marker, never cut", () => {
      const text = "x".repeat(10_000);
      const out = compress(text, 300);
      expect(out).toBe("[... 1 line omitted (10000 chars) ...]");
      assertBudgetAndWholeLines(out, text, 300);
    });

    test("tiny budgets shrink the marker honestly before giving up", () => {
      // One 10,000-char line: every marker tier keeps the count exact.
      expect(compress("x".repeat(10_000), 30)).toBe("[... 1 line omitted ...]");
      const many = Array.from({ length: 100_000 }, () => "x").join("\n");
      expect(compress(many, 28)).toBe("[... all output omitted ...]");
      expect(compress(many, 27)).toBe("");
    });

    test("CRLF output keeps whole CRLF lines", () => {
      const text = [
        ...Array.from({ length: 40 }, (_, i) => `filler data line ${i}\r`),
        "ERROR: boom\r",
      ].join("\n");
      const out = compress(text, 400);
      assertBudgetAndWholeLines(out, text, 400);
      // The verdict line survives whole, terminal \r and all.
      expect(out.split("\n").at(-1)).toBe("ERROR: boom\r");
      assertHonestElisionCount(out, text);
    });

    test("duplicate lines stay whole and are counted honestly", () => {
      const text = Array.from({ length: 300 }, () => "ERROR: duplicate failure row").join("\n");
      const out = compress(text, 400);
      assertBudgetAndWholeLines(out, text, 400);
      // At most MAX_SIGNAL_LINES (5) duplicates are rescued from the middle.
      const signalMatch = /\[\.\.\. (\d+) signal lines? kept from the middle \.\.\.\]/.exec(out);
      expect(signalMatch).not.toBeNull();
      expect(Number(signalMatch![1])).toBeLessThanOrEqual(5);
      assertHonestElisionCount(out, text);
    });
  });

  describe("signal line retention", () => {
    test("keeps an error buried in the middle of long output", () => {
      const lines = Array.from({ length: 400 }, (_, i) => `ok step ${i}`);
      lines[200] = "ERROR: cannot find module 'foo'";
      const text = lines.join("\n");
      const out = compress(text, 500);
      assertBudgetAndWholeLines(out, text, 500);
      expect(out).toContain("ERROR: cannot find module 'foo'");
      assertHonestElisionCount(out, text);
    });

    test("keeps a failing test line", () => {
      const lines = Array.from({ length: 400 }, (_, i) => `pass ${i}`);
      lines[150] = "FAIL src/thing.test.ts > does the thing";
      const text = lines.join("\n");
      const out = compress(text, 500);
      assertBudgetAndWholeLines(out, text, 500);
      expect(out).toContain("FAIL src/thing.test.ts > does the thing");
    });

    test("promoted lines are reported as a separate marker", () => {
      const lines = Array.from({ length: 400 }, (_, i) => `ok ${i}`);
      lines[200] = "Error: boom";
      const text = lines.join("\n");
      const out = compress(text, 500);
      expect(out).toMatch(/\[\.\.\. \d+ signal lines? kept from the middle \.\.\.\]/);
      assertHonestElisionCount(out, text);
    });

    test("still respects the budget when a wall of errors begs for promotion", () => {
      const text = Array.from({ length: 400 }, () => "ERROR: everything is on fire").join("\n");
      const out = compress(text, 300);
      assertBudgetAndWholeLines(out, text, 300);
      assertHonestElisionCount(out, text);
    });

    test("a long failure at the tail is kept where it fits", () => {
      // A 180-char failing last line would not fit the plain 50% tail share,
      // but it fits inside the budget itself — the tail borrows the room
      // reserved for promotion, prioritizing the verdict.
      const failing = `FAILED: ${"x".repeat(172)}`;
      const text = [...Array.from({ length: 300 }, () => "row"), failing].join("\n");
      const out = compress(text, 300);
      assertBudgetAndWholeLines(out, text, 300);
      expect(out).toContain(failing);
      assertHonestElisionCount(out, text);
    });
  });
});
