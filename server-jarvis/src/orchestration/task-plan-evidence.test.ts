import { describe, expect, test } from "bun:test";
import { buildTaskPlanGrounding, evaluateTaskPlanAcceptance } from "./task-plan-evidence";

const item = (kind: string) => ({
  id: "pi_a1",
  title: "Implement A1",
  dependsOn: [],
  acceptanceChecks: [{ id: "ac_a1", description: "A1 done", kind }],
  status: "active" as const,
  repairCycleCount: 0,
});

describe("evaluateTaskPlanAcceptance", () => {
  test("reviewer intent without a write does not verify a write item", () => {
    const grounding = buildTaskPlanGrounding({
      writeIntent: true,
      reviewerAccepted: true,
      toolCalls: [{ name: "read_file", arguments: { path: "PLAN.md" }, output: "A1", is_error: false, duration_ms: 1 }],
    });
    expect(evaluateTaskPlanAcceptance(item("reviewer_pass"), grounding)).toEqual({
      accepted: false,
      unmet: ["ac_a1:write_evidence_required"],
    });
  });

  test("diff_match requires a successful mutation", () => {
    const grounding = buildTaskPlanGrounding({
      writeIntent: true,
      reviewerAccepted: false,
      toolCalls: [{ name: "edit_file", arguments: { path: "a.cpp" }, output: "ok", is_error: false, duration_ms: 2 }],
    });
    expect(evaluateTaskPlanAcceptance(item("diff_match"), grounding).accepted).toBe(true);
  });

  test("test_pass requires a real passing check", () => {
    const grounding = buildTaskPlanGrounding({
      writeIntent: true,
      reviewerAccepted: true,
      toolCalls: [{ name: "write_file", arguments: { path: "a.cpp" }, output: "ok", is_error: false, duration_ms: 2 }],
      checkResult: { tier: "none", ran: false, passed: null, detail: "", command: "", durationMs: 0 },
    });
    expect(evaluateTaskPlanAcceptance(item("test_pass"), grounding).accepted).toBe(false);
  });

  test("manual checks cannot be autonomously verified", () => {
    const grounding = buildTaskPlanGrounding({ writeIntent: false, reviewerAccepted: true, toolCalls: [] });
    expect(evaluateTaskPlanAcceptance(item("manual"), grounding).unmet).toEqual(["ac_a1:manual_check_required"]);
  });
});
