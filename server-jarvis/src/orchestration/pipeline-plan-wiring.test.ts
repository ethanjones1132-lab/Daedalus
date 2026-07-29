import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The TaskPlan ledger has exactly one correct home in pipeline.ts, and one
 * place it must never go back to.
 *
 * IT BELONGS in the `buildMidLoopSignal` `base` object: that signal feeds
 * `decideMidLoopIntervention`, whose remaining-work reflex injects the
 * "N items still unverified" push that holds the executor open, and whose
 * budget guard converts an unfinishable remainder into a named partial.
 *
 * IT MUST NOT go into the Slice D `assessCorrectnessFloor(` gate. That gate
 * asks "is correctness met so the quality push can unlock?" — a `false` there
 * REMOVES supervision. Feeding it the ledger (2026-07-29, Tasks C1/C2)
 * inverted the intent: a partially-drained ledger disabled the only pressure
 * still active after the first write. Live run_da68c50b (5 of 6 items
 * outstanding) issued zero quality pushes where pre-change run_7e6b590f
 * issued two. Task C3 moved the ledger out of the floor and into its own
 * reflex.
 *
 * The pure-function tests in mid-loop-intervention.test.ts prove the reflex
 * behaves correctly given a hand-built signal; they say nothing about whether
 * production code populates that signal, or about where it must not be
 * populated. This crude source tripwire covers both directions.
 */
describe("TaskPlan ledger stays wired to the mid-loop signal, not the correctness floor", () => {
  const source = readFileSync(join(import.meta.dir, "pipeline.ts"), "utf8");
  const lines = source.split("\n");

  test("the mid-loop base signal still forwards plan and read-loop counters", () => {
    const baseSignalIdx = lines.findIndex((line) =>
      line.includes("const base: MidLoopSignal = {"),
    );
    expect(baseSignalIdx).toBeGreaterThan(-1);

    // The object literal runs for a few dozen lines after its opening.
    const window = lines.slice(baseSignalIdx, baseSignalIdx + 40).join("\n");
    expect(window).toContain("planItemsTotal");
    expect(window).toContain("planItemsRemaining");
    expect(window).toContain("totalSuccessfulReads");
  });

  test("no assessCorrectnessFloor( call site forwards the ledger", () => {
    const callSiteLines: number[] = [];
    lines.forEach((line, i) => {
      if (line.includes("assessCorrectnessFloor(")) callSiteLines.push(i);
    });
    expect(callSiteLines.length).toBeGreaterThanOrEqual(1);

    for (const lineIdx of callSiteLines) {
      // Only look FORWARD: an inline object literal passed to the floor starts
      // on the call line. Looking backward would pick up the unrelated `base`
      // literal above and produce a false failure.
      const literal = lines.slice(lineIdx, lineIdx + 20).join("\n");
      // A bare `assessCorrectnessFloor(base)`-style call passes a variable and
      // has no literal of its own to inspect; the check below is a no-op for
      // those, and meaningful for the inline-literal sites.
      expect(literal).not.toContain("planItemsTotal:");
      expect(literal).not.toContain("planItemsRemaining:");
    }
  });
});
