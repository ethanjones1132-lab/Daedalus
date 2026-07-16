import { describe, test, expect } from "bun:test";
import { buildDeterministicRoute, buildShortCircuitRoute, normalizeRemainingStages, normalizeRoute, reconcileRouteWithBudget } from "./route-normalization";
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

describe("buildShortCircuitRoute", () => {
  test("builds a canonical observable synthesizer-only route", () => {
    expect(buildShortCircuitRoute("answer_only")).toEqual({
      task_type: "general",
      pipeline: ["synthesizer"],
      topology: "linear",
      context: {
        needs_workspace_inspection: false,
        needs_memory: true,
        estimated_complexity: "low",
      },
      coordinator_rationale: "Deterministic simple-turn short circuit: direct synthesizer answer.",
      conductor_source: "trivial",
    });
  });
});

describe("buildDeterministicRoute (T1.2)", () => {
  test.each([
    ["conversational", ["synthesizer"]],
    ["answer_only", ["synthesizer"]],
    ["workspace_read", ["executor", "synthesizer"]],
    ["full_execution", ["planner", "executor", "reviewer", "synthesizer"]],
  ] as const)("maps %s to its canonical deterministic pipeline", (requirement, pipeline) => {
    expect(buildDeterministicRoute(requirement).pipeline).toEqual(pipeline);
  });

  test("workspace_read produces executor+synthesizer read-only after normalize", () => {
    const r = buildDeterministicRoute("workspace_read");
    expect(r.pipeline).toEqual(["executor", "synthesizer"]);
    expect(r.conductor_source).toBe("deterministic");
    const n = normalizeRoute(r, "workspace_read", "deterministic");
    expect(n.pipeline).toEqual(["executor", "synthesizer"]);
    expect(n.profile).toBe("read_only");
  });
});

describe("normalizeRemainingStages (T2.2)", () => {
  test("accepts a valid remaining queue", () => {
    expect(normalizeRemainingStages(["executor", "synthesizer"], "workspace_read", "planner"))
      .toEqual(["executor", "synthesizer"]);
  });

  test("rejects empty remaining", () => {
    expect(normalizeRemainingStages([], "workspace_read", "executor")).toBeNull();
  });

  test("strips escalation stages on workspace_read", () => {
    expect(normalizeRemainingStages(["rewriter", "synthesizer"], "workspace_read", "executor"))
      .toEqual(["synthesizer"]);
  });

  test("maps re-enter and keeps required stages for full_execution", () => {
    const r = normalizeRemainingStages(
      ["re-enter:executor", "conductor_replan", "synthesizer"],
      "full_execution",
      "planner",
    );
    expect(r).toEqual(["executor", "reviewer", "synthesizer"]);
  });

  test("preserves explicit re-entry of the current stage while dropping plain echoes", () => {
    expect(
      normalizeRemainingStages(["re-enter:executor", "synthesizer"], "full_execution", "executor"),
    ).toEqual(["executor", "reviewer", "synthesizer"]);

    expect(
      normalizeRemainingStages(["executor", "synthesizer"], "full_execution", "executor"),
    ).toEqual(["reviewer", "synthesizer"]);
  });
});

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

  test("workspace_read: planner and reviewer are stripped to the minimal read route", () => {
    const r = normalizeRoute(
      decision(["planner", "executor", "reviewer", "synthesizer"]),
      "workspace_read",
      "model",
    );
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

  // ── Track B / B-01: conductor_replan decision type ────────────────────
  // B-01 acceptance: normalizeRoute preserves conductor_replan in
  // original_pipeline (telemetry) but strips it from the executable stage
  // list. The meta decision is a signal to re-invoke the local persistent
  // conductor, not a worker to schedule.
  test("B-01: conductor_replan is preserved in original_pipeline and stripped from executable stages", () => {
    // Use `answer_only` so the required stages set is just {synthesizer} —
    // this keeps the test focused on the meta-decision filtering without
    // confounding the expected pipeline with capability-class invariants.
    const r = normalizeRoute(
      decision(["planner", "executor", "conductor_replan", "synthesizer"]),
      "answer_only",
      "model",
    );
    // The meta decision lives on the original wire (B-02 can intercept it).
    expect(r.original_pipeline).toEqual(["planner", "executor", "conductor_replan", "synthesizer"]);
    // The executable stage list contains only the model-emitted worker
    // stages (planner + executor) plus the canonical synthesizer suffix.
    // The meta decision never leaks into execution.
    expect(r.pipeline).toContain("planner");
    expect(r.pipeline).toContain("executor");
    expect(r.pipeline).toContain("synthesizer");
    expect(r.pipeline).not.toContain("conductor_replan");
  });

  test("B-01: conductor_replan alongside re-enter:executor keeps both in original_pipeline", () => {
    // A model that wants to replan via the conductor AND re-enter executor
    // (e.g. after a replan decides the executor needs another pass). Both
    // meta decisions must survive normalization; the re-enter:executor
    // maps to the executor stage and is deduplicated by the Set-based
    // include block.
    const r = normalizeRoute(
      decision(["planner", "executor", "conductor_replan", "re-enter:executor", "synthesizer"]),
      "answer_only",
      "model",
    );
    expect(r.original_pipeline).toEqual([
      "planner",
      "executor",
      "conductor_replan",
      "re-enter:executor",
      "synthesizer",
    ]);
    expect(r.pipeline).toContain("executor");
    expect(r.pipeline).toContain("synthesizer");
    expect(r.pipeline).not.toContain("conductor_replan");
  });

  test("B-01: a pipeline of only conductor_replan still resolves to synthesizer", () => {
    // Defensive normalization: a model that emits ONLY the meta decision
    // must still produce a usable pipeline so the user gets an answer.
    const r = normalizeRoute(decision(["conductor_replan"]), "answer_only", "model");
    expect(r.original_pipeline).toEqual(["conductor_replan"]);
    expect(r.pipeline).toEqual(["synthesizer"]);
    expect(r.profile).toBe("read_only");
  });
});

describe("reconcileRouteWithBudget", () => {
  test("an answer_only budget sheds reviewer then planner", () => {
    const { pipeline, dropped } = reconcileRouteWithBudget(
      ["planner", "executor", "reviewer", "synthesizer"],
      45_000,
      20_000,
      4_000,
    );
    expect(pipeline).toEqual(["executor", "synthesizer"]);
    expect(dropped).toEqual(["reviewer", "planner"]);
  });

  test("a full_execution budget keeps the full pipeline", () => {
    const { pipeline, dropped } = reconcileRouteWithBudget(
      ["planner", "executor", "reviewer", "synthesizer"],
      150_000,
      30_000,
      4_000,
    );
    expect(pipeline).toEqual(["planner", "executor", "reviewer", "synthesizer"]);
    expect(dropped).toEqual([]);
  });

  test("executor and synthesizer are never dropped", () => {
    const { pipeline } = reconcileRouteWithBudget(["executor", "synthesizer"], 20_000, 15_000, 4_000);
    expect(pipeline).toEqual(["executor", "synthesizer"]);
  });
});
