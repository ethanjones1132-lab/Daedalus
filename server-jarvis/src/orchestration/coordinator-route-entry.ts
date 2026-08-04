// ═══════════════════════════════════════════════════════════════
// Coordinator route entry — shortCircuit / continuation / advisory / model
// ═══════════════════════════════════════════════════════════════
// M8 seam extract from index.ts — further splits: tool dispatch, budget,
// delegate handoff, provider transport
//
// Packages the turn's first routing boundary: classify the raw message,
// decide whether Coordinator.route (local-first / API) is required, materialize
// non-model routes, and ensure plan ownership is attached. Downstream steps
// (forced deep-read, lean continuation, normalizeRoute, budget reconcile)
// remain in the orchestrator caller.

import type { Complexity, CoordinatorResult, StageName } from "./coordinator";
import {
  activePlanContinuationPipeline,
  type ActivePlanContinuationInput,
} from "./active-plan-route";
import {
  resolveCoordinatorRouteDecision,
  type CoordinatorRouteDecision,
  type RouteSource,
} from "./route-normalization";
import { attachOwnedPlanning } from "./runtime-loop";
import {
  resolveTurnRequirement,
  shouldShortCircuitCoordinator,
  type TurnRequirement,
  type TurnRequirementResult,
} from "./turn-requirements";

/** Inputs that fully determine the pure decision tree for one turn. */
export interface CoordinatorRouteEntryClassifyInput {
  message: string;
  priorRequirement?: TurnRequirement;
  /** True when a non-terminal TaskRun is live for this session. */
  taskRunLive: boolean;
  taskRunStatus: string;
  taskRunTurnCount: number;
  activePlanItem: ActivePlanContinuationInput["activeItem"];
}

/** Pure classification result before any model call or route materialization. */
export interface CoordinatorRouteEntryDecision {
  continuation: boolean;
  turnReq: TurnRequirementResult;
  shortCircuit: boolean;
  activePlanPipeline: StageName[] | null;
  useActivePlanContinuation: boolean;
  routeDecision: CoordinatorRouteDecision;
}

/**
 * Pure: classify turn requirement + decide shortCircuit / continuation /
 * advisory / model. No I/O, no logging.
 */
export function classifyCoordinatorRouteEntry(
  input: CoordinatorRouteEntryClassifyInput,
): CoordinatorRouteEntryDecision {
  const { continuation, result: turnReq } = resolveTurnRequirement(
    input.message,
    input.priorRequirement,
    input.taskRunLive,
  );
  const shortCircuit = shouldShortCircuitCoordinator(
    input.message,
    turnReq,
    continuation,
  );
  const activePlanPipeline = !shortCircuit
    ? activePlanContinuationPipeline({
        explicitContinuation: continuation,
        status: input.taskRunStatus,
        turnCount: input.taskRunTurnCount,
        activeItem: input.activePlanItem,
      })
    : null;
  const useActivePlanContinuation =
    Array.isArray(activePlanPipeline) && activePlanPipeline.length > 0;
  const routeDecision = resolveCoordinatorRouteDecision({
    shortCircuit,
    shortCircuitKind:
      turnReq.requirement === "conversational" ? "conversational" : "answer_only",
    useActivePlanContinuation,
    requirement: turnReq.requirement,
  });
  return {
    continuation,
    turnReq,
    shortCircuit,
    activePlanPipeline,
    useActivePlanContinuation,
    routeDecision,
  };
}

/**
 * Pure: build the CoordinatorResult for an active-plan continuation fast path.
 * Caller must only invoke when `activePlanPipeline` is non-empty.
 */
export function buildActivePlanContinuationRoute(input: {
  requirement: TurnRequirement;
  pipeline: StageName[];
  estimatedComplexity?: Complexity;
}): CoordinatorResult {
  return {
    task_type: input.requirement === "workspace_read" ? "research" : "general",
    pipeline: input.pipeline,
    topology: "linear",
    context: {
      needs_workspace_inspection: true,
      needs_memory: false,
      estimated_complexity: input.estimatedComplexity ?? "medium",
    },
    coordinator_rationale:
      "Active plan continuation: resume open TaskPlan item without Coordinator/Planner.",
    conductor_source: "continuation_reuse",
  };
}

/**
 * Pure: attach owned planning when the route skipped Coordinator.route
 * (or the model omitted plan_authorship). Preserves existing fields when present.
 */
export function ensureOwnedPlanningOnRoute(
  route: CoordinatorResult,
  message: string,
): CoordinatorResult {
  if (route.plan_authorship) return route;
  const planning = attachOwnedPlanning(
    message,
    route.context?.estimated_complexity ?? "low",
    { taskType: route.task_type },
  );
  return {
    ...route,
    plan_authorship: planning.plan_authorship,
    plan_items: planning.plan_items,
    plan_brief: planning.plan_brief,
  };
}

/**
 * Pure: map routeDecision (+ parse fallback) to the telemetry RouteSource
 * used by normalizeRoute / logging.
 */
export function deriveCoordinatorRouteSource(
  routeDecision: CoordinatorRouteDecision,
  route: CoordinatorResult,
): RouteSource {
  if (routeDecision.kind === "short_circuit") return "trivial_short_circuit";
  if (routeDecision.kind === "continuation") return "active_plan_continuation";
  if (routeDecision.kind === "deterministic_advisory") return "deterministic";
  if (route.routing_parse_fallback) return "parse_fallback";
  return "model";
}

export interface ResolveCoordinatorRouteEntryInput extends CoordinatorRouteEntryClassifyInput {
  /** Estimated complexity for active-plan continuation route context. */
  estimatedComplexity?: Complexity;
  /**
   * Invoked only when the decision tree requires a model-backed route
   * (local-first PersistentConductor / API via Coordinator.route).
   */
  routeViaModel: () => Promise<CoordinatorResult>;
  /** Optional item id for continuation log line. */
  activePlanItemId?: string;
}

export interface CoordinatorRouteEntryResult extends CoordinatorRouteEntryDecision {
  route: CoordinatorResult;
  skippedCoordinatorModel: boolean;
  coordinatorDurationMs: number;
  routeSource: RouteSource;
}

/**
 * Orchestrate the route entry: classify → materialize or call model → ensure
 * plan ownership → derive routeSource. Logging mirrors prior index.ts behavior.
 */
export async function resolveCoordinatorRouteEntry(
  input: ResolveCoordinatorRouteEntryInput,
): Promise<CoordinatorRouteEntryResult> {
  const classified = classifyCoordinatorRouteEntry(input);
  const { routeDecision, turnReq, activePlanPipeline } = classified;

  const coordinatorStartedAt = Date.now();
  let route: CoordinatorResult;

  if (routeDecision.kind === "short_circuit") {
    route = routeDecision.route;
  } else if (routeDecision.kind === "continuation" && activePlanPipeline) {
    // Never re-run Planner for an already-expanded plan; reviewer only
    // when acceptance requires reviewer_pass (see activePlanContinuationPipeline).
    route = buildActivePlanContinuationRoute({
      requirement: turnReq.requirement,
      pipeline: activePlanPipeline,
      estimatedComplexity: input.estimatedComplexity,
    });
    console.log(
      `[Jarvis Orchestrator] active plan continuation: ${activePlanPipeline.join("->")} ` +
        `(item=${input.activePlanItemId ?? "?"} status=${input.taskRunStatus} turn=${input.taskRunTurnCount})`,
    );
  } else if (routeDecision.kind === "deterministic_advisory") {
    console.log(
      `[Jarvis Orchestrator] M3 advisory skip: deterministic ${turnReq.requirement} route ` +
        `(coordinator model not called)`,
    );
    route = routeDecision.route;
  } else {
    route = await input.routeViaModel();
  }

  const skippedCoordinatorModel = routeDecision.kind !== "model";
  const coordinatorDurationMs = skippedCoordinatorModel
    ? 0
    : Date.now() - coordinatorStartedAt;

  // Owned-runtime-loop: short-circuit / deterministic routes skip
  // Coordinator.route, so attach planning ownership here when missing.
  route = ensureOwnedPlanningOnRoute(route, input.message);

  const routeSource = deriveCoordinatorRouteSource(routeDecision, route);

  return {
    ...classified,
    route,
    skippedCoordinatorModel,
    coordinatorDurationMs,
    routeSource,
  };
}
