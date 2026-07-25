// ═══════════════════════════════════════════════════════════════
// ── Verification decision (Phase 2) — fast-paths + defer ──
// ═══════════════════════════════════════════════════════════════
// Pure decision function over a CheckResult. Decides between
// (a) a mark_verified directive for a trustworthy green tier,
// (b) a start_repair_chain directive for any failed check,
// (c) defer_to_resident for synth/none/ambiguous.
//
// The function lives in its own module so the branching stays
// testable without spinning up a LiveConductor.

import { describe, expect, test } from "bun:test";
import type { CheckResult } from "./check-runner";
import { decideVerificationDirective } from "./verification-decision";

const item = { id: "item-1" };
function result(over: Partial<CheckResult>): CheckResult {
  return {
    tier: "existing",
    ran: true,
    passed: true,
    detail: "",
    command: "run",
    durationMs: 5,
    ...over,
  };
}

describe("decideVerificationDirective", () => {
  test("existing pass → mark_verified runtime_check", () => {
    const d = decideVerificationDirective({
      check: result({}),
      item,
      runId: "r",
      remainingQueue: ["reviewer", "synthesizer"],
    });
    expect(d).toMatchObject({
      kind: "directive",
      directive: {
        type: "mark_verified",
        gradingMode: "runtime_check",
        itemId: "item-1",
      },
    });
    // reviewer is dropped from the queue (thrift)
    if (d.kind === "directive") {
      expect(d.dropReviewer).toBe(true);
    } else {
      throw new Error("expected kind=directive");
    }
  });

  test("builtin pass → mark_verified runtime_check", () => {
    const d = decideVerificationDirective({
      check: result({ tier: "builtin" }),
      item,
      runId: "r",
      remainingQueue: ["synthesizer"],
    });
    expect(d).toMatchObject({
      kind: "directive",
      directive: { type: "mark_verified", gradingMode: "runtime_check" },
    });
  });

  test("any fail → start_repair_chain with detail injected", () => {
    const d = decideVerificationDirective({
      check: result({ passed: false, detail: "AssertionError: 3 != 4" }),
      item,
      runId: "r",
      remainingQueue: ["synthesizer"],
    });
    if (d.kind !== "directive") throw new Error("expected kind=directive");
    expect(d.directive.type).toBe("start_repair_chain");
    // detail surfaces as flaggedIssues (the rewriter will see what broke)
    const issues = d.directive.flaggedIssues;
    expect(typeof issues === "string" ? issues : "").toContain("AssertionError");
  });

  test("synth pass → defer to resident judgment", () => {
    const d = decideVerificationDirective({
      check: result({ tier: "synth" }),
      item,
      runId: "r",
      remainingQueue: ["synthesizer"],
    });
    expect(d.kind).toBe("defer_to_resident");
  });

  test("none → defer to resident judgment", () => {
    const d = decideVerificationDirective({
      check: result({ tier: "none", ran: false, passed: null }),
      item,
      runId: "r",
      remainingQueue: ["synthesizer"],
    });
    expect(d.kind).toBe("defer_to_resident");
  });
});
