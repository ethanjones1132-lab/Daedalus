import { describe, test, expect } from "bun:test";
import { normalizeRoute } from "./route-normalization";
import type { CoordinatorResult } from "./coordinator";

function decision(pipeline: CoordinatorResult["pipeline"], topology: CoordinatorResult["topology"] = "linear"): CoordinatorResult {
  return {
    task_type: "general",
    pipeline,
    topology,
    context: { needs_workspace_inspection: false, needs_memory: true, estimated_complexity: "low" },
    coordinator_rationale: "test",
  };
}

describe("normalizeRoute", () => {
  test("workspace_read: model synthesizer-only is UPGRADED to executor+synthesizer read-only", () => {
    // The exact bug: "read this file" routed to synthesizer-only → no output.
    const r = normalizeRoute(decision(["synthesizer"]), "workspace_read", "model");
    expect(r.pipeline).toEqual(["executor", "synthesizer"]);
    expect(r.profile).toBe("read_only");
    expect(r.topology).toBe("linear");
    expect(r.route_source).toBe("invariant_override");
    expect(r.override_reason).toBeDefined();
  });

  test("workspace_read: invalid-JSON fallback (synthesizer-only) still gets executor", () => {
    // defaultRoute() returns ["synthesizer"]; normalization must still add tools.
    const r = normalizeRoute(decision(["synthesizer"]), "workspace_read", "parse_fallback");
    expect(r.pipeline).toEqual(["executor", "synthesizer"]);
    expect(r.profile).toBe("read_only");
  });

  test("workspace_read: all-null pipeline rebuilt as executor+synthesizer", () => {
    const r = normalizeRoute(decision([null, null]), "workspace_read", "model");
    expect(r.pipeline).toEqual(["executor", "synthesizer"]);
    expect(r.profile).toBe("read_only");
  });

  test("workspace_read: rewriter (a mutation stage) is stripped", () => {
    const r = normalizeRoute(decision(["executor", "rewriter", "synthesizer"]), "workspace_read", "model");
    expect(r.pipeline).toEqual(["executor", "synthesizer"]);
    expect(r.profile).toBe("read_only");
  });

  test("full_execution: ensures a reviewed executor route with full profile", () => {
    const r = normalizeRoute(decision(["executor", "synthesizer"]), "full_execution", "model");
    expect(r.pipeline).toEqual(["executor", "reviewer", "synthesizer"]);
    expect(r.profile).toBe("full");
    expect(r.topology).toBe("linear");
  });

  test("full_execution: keeps planner and rewriter when the model included them", () => {
    const r = normalizeRoute(decision(["planner", "executor", "reviewer", "rewriter", "synthesizer"]), "full_execution", "model");
    expect(r.pipeline).toEqual(["planner", "executor", "reviewer", "rewriter", "synthesizer"]);
    expect(r.profile).toBe("full");
  });

  test("conversational: stripped to synthesizer-only, no tools", () => {
    const r = normalizeRoute(decision(["planner", "executor", "synthesizer"]), "conversational", "trivial_short_circuit");
    expect(r.pipeline).toEqual(["synthesizer"]);
    expect(r.profile).toBe("none");
  });

  test("answer_only: synthesizer-only stays synthesizer-only", () => {
    const r = normalizeRoute(decision(["synthesizer"]), "answer_only", "model");
    expect(r.pipeline).toEqual(["synthesizer"]);
    // executor not required; profile is read_only (only matters if executor present)
    expect(r.profile).toBe("read_only");
  });

  test("answer_only: a model that opted into executor is capped to read-only", () => {
    const r = normalizeRoute(decision(["executor", "synthesizer"]), "answer_only", "model");
    expect(r.pipeline).toEqual(["executor", "synthesizer"]);
    expect(r.profile).toBe("read_only");
  });

  test("always ends with exactly one synthesizer", () => {
    const r = normalizeRoute(decision(["synthesizer", "synthesizer"]), "full_execution", "model");
    expect(r.pipeline.filter((s) => s === "synthesizer")).toHaveLength(1);
    expect(r.pipeline[r.pipeline.length - 1]).toBe("synthesizer");
  });

  test("canonical stage ordering is enforced regardless of model order", () => {
    const r = normalizeRoute(decision(["synthesizer", "reviewer", "executor", "planner"]), "full_execution", "model");
    expect(r.pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
  });

  test("a satisfying model route is left intact (route_source stays 'model')", () => {
    const r = normalizeRoute(decision(["executor", "synthesizer"]), "workspace_read", "model");
    expect(r.pipeline).toEqual(["executor", "synthesizer"]);
    expect(r.route_source).toBe("model");
    expect(r.override_reason).toBeUndefined();
  });
});
