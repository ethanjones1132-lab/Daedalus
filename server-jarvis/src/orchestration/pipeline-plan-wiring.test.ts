import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Task C2 wired `planItemsTotal`/`planItemsRemaining` into both
 * `assessCorrectnessFloor(` call sites in pipeline.ts (the mid-loop `base`
 * signal, and the Slice D quality-push gate). The unit tests in
 * mid-loop-intervention.test.ts only prove the pure function is correct
 * given a hand-built signal — they say nothing about whether production
 * code actually populates that signal. This is a crude but real tripwire:
 * if either call site's field-forwarding is silently deleted in a future
 * edit, this test fails instead of the regression going unnoticed.
 */
describe("assessCorrectnessFloor call sites stay wired to the TaskPlan ledger", () => {
  test("every assessCorrectnessFloor( call site in pipeline.ts forwards planItemsTotal/planItemsRemaining", () => {
    const source = readFileSync(join(import.meta.dir, "pipeline.ts"), "utf8");
    const lines = source.split("\n");
    const callSiteLines: number[] = [];
    lines.forEach((line, i) => {
      if (line.includes("assessCorrectnessFloor(")) callSiteLines.push(i);
    });

    // Two known call sites: the buildMidLoopSignal `base` object, and the
    // Slice D quality-push gate. If a future edit adds a third, this still
    // enforces the invariant on it — the loop below checks every site found.
    expect(callSiteLines.length).toBeGreaterThanOrEqual(2);

    for (const lineIdx of callSiteLines) {
      // Some call sites pass a named signal variable (e.g. `assessCorrectnessFloor(base)`)
      // whose object literal — and the two ledger fields — is built a few
      // dozen lines ABOVE the call, not after it. Others pass an inline
      // object literal, where the fields appear a few lines AFTER the call.
      // Look both directions so either shape is covered by the same crude check.
      const windowStart = Math.max(0, lineIdx - 30);
      const windowEnd = lineIdx + 20;
      const window = lines.slice(windowStart, windowEnd).join("\n");
      expect(window).toContain("planItemsTotal");
      expect(window).toContain("planItemsRemaining");
    }
  });
});
