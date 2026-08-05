/**
 * M8 seam: coordinator-route-entry pure helpers + entry orchestration parity.
 */
import { describe, expect, test } from "bun:test";
import {
  buildActivePlanContinuationRoute,
  classifyCoordinatorRouteEntry,
  deriveCoordinatorRouteSource,
  ensureOwnedPlanningOnRoute,
  resolveCoordinatorRouteEntry,
} from "./coordinator-route-entry";
import type { CoordinatorResult } from "./coordinator";
import { buildDeterministicRoute, buildShortCircuitRoute } from "./route-normalization";

describe("classifyCoordinatorRouteEntry", () => {
  test("conversational short-circuits without active-plan or model", () => {
    const d = classifyCoordinatorRouteEntry({
      message: "hey",
      taskRunLive: false,
      taskRunStatus: "completed",
      taskRunTurnCount: 1,
      activePlanItem: null,
    });
    expect(d.shortCircuit).toBe(true);
    expect(d.useActivePlanContinuation).toBe(false);
    expect(d.activePlanPipeline).toBeNull();
    expect(d.routeDecision.kind).toBe("short_circuit");
    expect(d.turnReq.requirement).toBe("conversational");
  });

  test("workspace_read is advisory (model not required)", () => {
    const d = classifyCoordinatorRouteEntry({
      message: "read src/index.ts and summarize the exports",
      taskRunLive: false,
      taskRunStatus: "completed",
      taskRunTurnCount: 1,
      activePlanItem: null,
    });
    expect(d.shortCircuit).toBe(false);
    expect(d.routeDecision.kind).toBe("deterministic_advisory");
    expect(d.turnReq.requirement).toBe("workspace_read");
  });

  test("explicit continuation of open plan item prefers continuation over advisory", () => {
    const d = classifyCoordinatorRouteEntry({
      message: "continue",
      priorRequirement: "workspace_read",
      taskRunLive: true,
      taskRunStatus: "active",
      taskRunTurnCount: 3,
      activePlanItem: {
        acceptanceChecks: [{ id: "c1", description: "ok", kind: "tool_success" }],
      },
    });
    expect(d.continuation).toBe(true);
    expect(d.shortCircuit).toBe(false);
    expect(d.useActivePlanContinuation).toBe(true);
    expect(d.activePlanPipeline).toEqual(["executor", "synthesizer"]);
    expect(d.routeDecision.kind).toBe("continuation");
  });

  test("continuation with reviewer_pass acceptance includes reviewer", () => {
    const d = classifyCoordinatorRouteEntry({
      message: "continue",
      priorRequirement: "full_execution",
      taskRunLive: true,
      taskRunStatus: "active",
      taskRunTurnCount: 2,
      activePlanItem: {
        acceptanceChecks: [{ id: "r1", description: "review", kind: "reviewer_pass" }],
      },
    });
    expect(d.useActivePlanContinuation).toBe(true);
    expect(d.activePlanPipeline).toEqual(["executor", "reviewer", "synthesizer"]);
    expect(d.routeDecision.kind).toBe("continuation");
  });

  test("full_execution without shortCircuit/continuation requires model", () => {
    const d = classifyCoordinatorRouteEntry({
      message: "implement the feature in src/foo.ts and run the tests",
      taskRunLive: false,
      taskRunStatus: "completed",
      taskRunTurnCount: 1,
      activePlanItem: null,
    });
    expect(d.shortCircuit).toBe(false);
    expect(d.useActivePlanContinuation).toBe(false);
    expect(d.routeDecision.kind).toBe("model");
    expect(d.turnReq.requirement).toBe("full_execution");
  });

  test("shortCircuit wins over active plan item presence", () => {
    // Conversational turns short-circuit; pipeline not computed.
    const d = classifyCoordinatorRouteEntry({
      message: "thanks!",
      priorRequirement: "full_execution",
      taskRunLive: true,
      taskRunStatus: "active",
      taskRunTurnCount: 4,
      activePlanItem: {
        acceptanceChecks: [{ id: "c1", description: "ok", kind: "tool_success" }],
      },
    });
    expect(d.shortCircuit).toBe(true);
    expect(d.activePlanPipeline).toBeNull();
    expect(d.routeDecision.kind).toBe("short_circuit");
  });
});

describe("buildActivePlanContinuationRoute", () => {
  test("workspace_read continuation uses research task_type and continuation_reuse", () => {
    const route = buildActivePlanContinuationRoute({
      requirement: "workspace_read",
      pipeline: ["executor", "synthesizer"],
      estimatedComplexity: "high",
    });
    expect(route.task_type).toBe("research");
    expect(route.pipeline).toEqual(["executor", "synthesizer"]);
    expect(route.topology).toBe("linear");
    expect(route.conductor_source).toBe("continuation_reuse");
    expect(route.context.estimated_complexity).toBe("high");
    expect(route.context.needs_workspace_inspection).toBe(true);
    expect(route.coordinator_rationale).toMatch(/Active plan continuation/i);
  });

  test("defaults estimated_complexity to medium and general task_type", () => {
    const route = buildActivePlanContinuationRoute({
      requirement: "full_execution",
      pipeline: ["executor", "reviewer", "synthesizer"],
    });
    expect(route.task_type).toBe("general");
    expect(route.context.estimated_complexity).toBe("medium");
  });
});

describe("ensureOwnedPlanningOnRoute", () => {
  test("attaches plan_authorship when missing", () => {
    const base = buildShortCircuitRoute("conversational");
    expect(base.plan_authorship).toBeUndefined();
    const withPlan = ensureOwnedPlanningOnRoute(base, "hey there");
    expect(withPlan.plan_authorship).toBeDefined();
    expect(withPlan.plan_items).toBeDefined();
  });

  test("preserves existing plan_authorship (no reseed)", () => {
    const base: CoordinatorResult = {
      ...buildDeterministicRoute("workspace_read"),
      plan_authorship: "planner_mediated",
      plan_items: [],
      plan_brief: {
        request: "x",
        objective: "y",
        estimatedComplexity: "medium",
        relevantMemory: [],
        failurePatterns: [],
        constraints: [],
      },
    };
    const out = ensureOwnedPlanningOnRoute(base, "read the file");
    expect(out.plan_authorship).toBe("planner_mediated");
    expect(out.plan_brief?.request).toBe("x");
  });
});

describe("deriveCoordinatorRouteSource", () => {
  test("maps each decision kind", () => {
    const sc = buildShortCircuitRoute("conversational");
    expect(
      deriveCoordinatorRouteSource({ kind: "short_circuit", route: sc }, sc),
    ).toBe("trivial_short_circuit");
    expect(
      deriveCoordinatorRouteSource({ kind: "continuation" }, sc),
    ).toBe("active_plan_continuation");
    const adv = buildDeterministicRoute("workspace_read");
    expect(
      deriveCoordinatorRouteSource({ kind: "deterministic_advisory", route: adv }, adv),
    ).toBe("deterministic");
    expect(
      deriveCoordinatorRouteSource({ kind: "model" }, { ...sc, routing_parse_fallback: true }),
    ).toBe("parse_fallback");
    expect(
      deriveCoordinatorRouteSource({ kind: "model" }, sc),
    ).toBe("model");
  });
});

describe("resolveCoordinatorRouteEntry (async orchestration parity)", () => {
  test("short_circuit never calls routeViaModel and attaches planning", async () => {
    let modelCalls = 0;
    const result = await resolveCoordinatorRouteEntry({
      message: "hey",
      taskRunLive: false,
      taskRunStatus: "completed",
      taskRunTurnCount: 1,
      activePlanItem: null,
      routeViaModel: async () => {
        modelCalls += 1;
        throw new Error("model should not be called");
      },
    });
    expect(modelCalls).toBe(0);
    expect(result.routeDecision.kind).toBe("short_circuit");
    expect(result.skippedCoordinatorModel).toBe(true);
    expect(result.coordinatorDurationMs).toBe(0);
    expect(result.routeSource).toBe("trivial_short_circuit");
    expect(result.route.pipeline).toEqual(["synthesizer"]);
    expect(result.route.plan_authorship).toBeDefined();
  });

  test("advisory workspace_read never calls routeViaModel", async () => {
    let modelCalls = 0;
    const result = await resolveCoordinatorRouteEntry({
      message: "read package.json and list dependencies",
      taskRunLive: false,
      taskRunStatus: "completed",
      taskRunTurnCount: 1,
      activePlanItem: null,
      routeViaModel: async () => {
        modelCalls += 1;
        return buildDeterministicRoute("full_execution");
      },
    });
    expect(modelCalls).toBe(0);
    expect(result.routeDecision.kind).toBe("deterministic_advisory");
    expect(result.routeSource).toBe("deterministic");
    expect(result.route.pipeline).toEqual(["executor", "synthesizer"]);
    expect(result.route.plan_authorship).toBeDefined();
  });

  test("continuation materializes pipeline without model", async () => {
    let modelCalls = 0;
    const result = await resolveCoordinatorRouteEntry({
      message: "continue",
      priorRequirement: "workspace_read",
      taskRunLive: true,
      taskRunStatus: "active",
      taskRunTurnCount: 3,
      activePlanItem: {
        acceptanceChecks: [{ id: "c1", description: "ok", kind: "tool_success" }],
      },
      activePlanItemId: "item-42",
      estimatedComplexity: "high",
      routeViaModel: async () => {
        modelCalls += 1;
        throw new Error("model should not be called");
      },
    });
    expect(modelCalls).toBe(0);
    expect(result.routeDecision.kind).toBe("continuation");
    expect(result.routeSource).toBe("active_plan_continuation");
    expect(result.route.pipeline).toEqual(["executor", "synthesizer"]);
    expect(result.route.conductor_source).toBe("continuation_reuse");
    expect(result.route.context.estimated_complexity).toBe("high");
    expect(result.skippedCoordinatorModel).toBe(true);
  });

  test("model path invokes routeViaModel and surfaces parse_fallback source", async () => {
    let modelCalls = 0;
    const modelRoute: CoordinatorResult = {
      ...buildDeterministicRoute("full_execution"),
      plan_authorship: "planner_mediated",
      plan_items: [],
      routing_parse_fallback: true,
    };
    const result = await resolveCoordinatorRouteEntry({
      message: "implement the feature in src/foo.ts and run the tests",
      taskRunLive: false,
      taskRunStatus: "completed",
      taskRunTurnCount: 1,
      activePlanItem: null,
      routeViaModel: async () => {
        modelCalls += 1;
        return modelRoute;
      },
    });
    expect(modelCalls).toBe(1);
    expect(result.routeDecision.kind).toBe("model");
    expect(result.skippedCoordinatorModel).toBe(false);
    expect(result.routeSource).toBe("parse_fallback");
    expect(result.route.plan_authorship).toBe("planner_mediated");
  });
});

describe("ensureOwnedPlanningOnRoute continuation carry", () => {
  const bareRoute = (): CoordinatorResult => ({
    task_type: "general",
    pipeline: ["synthesizer"],
    topology: "linear",
    context: {
      needs_workspace_inspection: false,
      needs_memory: true,
      estimated_complexity: "low",
    },
    coordinator_rationale: "Local conductor cold/abort; deterministic answer_only route.",
    conductor_source: "deterministic",
  });

  test("inherits unfinished items instead of authoring from the follow-up text", () => {
    const route = ensureOwnedPlanningOnRoute(bareRoute(), "continue please", {
      items: [
        { id: "pi_a2", title: "A2 parameter smoothing", dependsOn: [] },
        { id: "pi_a3", title: "A3 editor layout", dependsOn: [] },
      ],
      lastWriteTargets: ["C:\\p\\PluginProcessor.cpp"],
    });

    expect(route.plan_authorship).toBe("conductor_direct");
    expect(route.plan_items?.map((i) => i.id)).toEqual(["pi_a2", "pi_a3"]);
    expect(route.plan_items?.some((i) => i.title === "continue please")).toBe(false);
    expect(route.continuation_write_targets).toEqual(["C:\\p\\PluginProcessor.cpp"]);
  });

  test("falls back to authoring when the carry has no unfinished items", () => {
    const route = ensureOwnedPlanningOnRoute(bareRoute(), "continue please", {
      items: [],
      lastWriteTargets: [],
    });

    expect(route.plan_items?.length).toBe(1);
    expect(route.plan_items?.[0]!.title).toBe("continue please");
  });

  test("carry is ignored when the route already declares plan authorship", () => {
    const authored: CoordinatorResult = {
      ...bareRoute(),
      plan_authorship: "planner_mediated",
      plan_items: [],
    };
    const route = ensureOwnedPlanningOnRoute(authored, "continue please", {
      items: [{ id: "pi_a2", title: "A2", dependsOn: [] }],
      lastWriteTargets: [],
    });

    expect(route.plan_authorship).toBe("planner_mediated");
    expect(route.plan_items).toEqual([]);
  });
});
