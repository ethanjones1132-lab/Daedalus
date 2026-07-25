import { describe, expect, test } from "bun:test";
import { decideVerificationDirective } from "./verification-decision";
import type { CheckResult } from "./check-runner";

const item = { id: "item-1" };
function result(over: Partial<CheckResult>): CheckResult {
  return { tier: "existing", ran: true, passed: true, detail: "", command: "run", durationMs: 5, ...over };
}

describe("decideVerificationDirective", () => {
  test("existing pass → mark_verified runtime_check", () => {
    const d = decideVerificationDirective({ check: result({}), item, runId: "r", remainingQueue: ["reviewer", "synthesizer"] });
    expect(d).toMatchObject({ kind: "directive", directive: { type: "mark_verified", gradingMode: "runtime_check", itemId: "item-1" } });
    // reviewer is dropped from the queue (thrift)
    expect((d as any).dropReviewer).toBe(true);
  });

  test("builtin pass → mark_verified runtime_check", () => {
    const d = decideVerificationDirective({ check: result({ tier: "builtin" }), item, runId: "r", remainingQueue: ["synthesizer"] });
    expect(d).toMatchObject({ kind: "directive", directive: { type: "mark_verified", gradingMode: "runtime_check" } });
  });

  test("any fail → start_repair_chain with detail injected", () => {
    const d = decideVerificationDirective({
      check: result({ passed: false, detail: "AssertionError: 3 != 4" }),
      item, runId: "r", remainingQueue: ["synthesizer"],
    });
    expect(d).toMatchObject({ kind: "directive", directive: { type: "start_repair_chain" } });
    expect((d as any).directive.flaggedIssues).toContain("AssertionError");
  });

  test("synth pass → defer to resident judgment", () => {
    const d = decideVerificationDirective({ check: result({ tier: "synth" }), item, runId: "r", remainingQueue: ["synthesizer"] });
    expect(d.kind).toBe("defer_to_resident");
  });

  test("none → defer to resident judgment", () => {
    const d = decideVerificationDirective({ check: result({ tier: "none", ran: false, passed: null }), item, runId: "r", remainingQueue: ["synthesizer"] });
    expect(d.kind).toBe("defer_to_resident");
  });
});
