// server-jarvis/src/orchestration/instruction-binding.test.ts
// Contract for the pure decision that binds an instruction to the worker it
// was sent to. Written before `instruction-binding.ts` exists.
import { describe, expect, test } from "bun:test";
import {
  resolveSegmentInstructions,
  sentInstructionMatchesSelection,
  unselectedInstructionVariant,
} from "./instruction-binding";
import { hashInstruction } from "./worker-prompt";

describe("resolveSegmentInstructions", () => {
  test("an unrevised decision never resurrects its own raw instructions", () => {
    // The A/B selector already arbitrated the initial route: a baseline pick
    // is expressed by the stage being absent from the selected set. Re-reading
    // the same decision's `worker_instructions` would send the Conductor's text
    // to a worker whose outcome is attributed to the baseline arm.
    const resolved = resolveSegmentInstructions({
      decisionInstructions: { executor: "Conductor text for the executor." },
      selectedInstructions: undefined,
      decisionRevised: false,
    });
    expect(resolved.instructions).toBeUndefined();
    expect(resolved.revised).toBe(false);
  });

  test("an unrevised decision sends the selected set verbatim", () => {
    const selected = { executor: "Selected executor text." };
    const resolved = resolveSegmentInstructions({
      decisionInstructions: { executor: "Conductor text for the executor." },
      selectedInstructions: selected,
      decisionRevised: false,
    });
    expect(resolved.instructions).toBe(selected);
    expect(resolved.revised).toBe(false);
  });

  test("a revised decision keeps replan authority over the selected set", () => {
    const revised = { reviewer: "Focus on the new schema." };
    const resolved = resolveSegmentInstructions({
      decisionInstructions: revised,
      selectedInstructions: { executor: "Selected executor text." },
      decisionRevised: true,
    });
    expect(resolved.instructions).toBe(revised);
    expect(resolved.revised).toBe(true);
  });

  test("a revised decision that carries no instructions falls back to the selection unrevised", () => {
    const selected = { executor: "Selected executor text." };
    const resolved = resolveSegmentInstructions({
      decisionInstructions: undefined,
      selectedInstructions: selected,
      decisionRevised: true,
    });
    expect(resolved.instructions).toBe(selected);
    // The worker still received exactly what the selector chose, so the turn's
    // A/B arm attribution is still true and must not be withheld.
    expect(resolved.revised).toBe(false);
  });

  test("an unrevised decision with neither source sends nothing", () => {
    const resolved = resolveSegmentInstructions({
      decisionInstructions: undefined,
      selectedInstructions: undefined,
      decisionRevised: false,
    });
    expect(resolved.instructions).toBeUndefined();
    expect(resolved.revised).toBe(false);
  });
});

describe("sentInstructionMatchesSelection", () => {
  test("identical text matches", () => {
    expect(sentInstructionMatchesSelection("Do the thing.", "Do the thing.")).toBe(true);
  });

  test("surrounding whitespace does not create a false mismatch", () => {
    expect(sentInstructionMatchesSelection("  Do the thing.  ", "Do the thing.")).toBe(true);
  });

  test("a baseline pick with no sent text matches an absent selection", () => {
    expect(sentInstructionMatchesSelection(undefined, undefined)).toBe(true);
    expect(sentInstructionMatchesSelection(undefined, "   ")).toBe(true);
  });

  test("conductor text sent to a baseline arm does not match", () => {
    expect(sentInstructionMatchesSelection(undefined, "Conductor text.")).toBe(false);
  });

  test("revised text does not match the selected text", () => {
    expect(sentInstructionMatchesSelection("Original.", "Revised after the replan.")).toBe(false);
  });

  test("an absent selection with sent text is a mismatch", () => {
    expect(sentInstructionMatchesSelection(undefined, "Conductor text.")).toBe(false);
  });
});

describe("unselectedInstructionVariant", () => {
  test("is a stable label that cannot collide with an A/B arm key", () => {
    const label = unselectedInstructionVariant("Revised after the replan.");
    expect(label).toBe(`unselected:${hashInstruction("Revised after the replan.")}`);
    // The selector only ever reads `conductor:<hash>` and `baseline`, so this
    // provenance label can never be picked up as a comparable arm.
    expect(label.startsWith("conductor:")).toBe(false);
    expect(label).not.toBe("baseline");
  });
});
