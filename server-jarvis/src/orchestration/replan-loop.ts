// server-jarvis/src/orchestration/replan-loop.ts
// ═══════════════════════════════════════════════════════════════
// B-02 (Track B, Conductor Recursive Self-Selection): runs a pipeline
// that contains one or more `conductor_replan` meta-decisions.
// See docs/issues/post-phase-4-conductor-evolution.md B-02.
// ═══════════════════════════════════════════════════════════════

import type { Coordinator, CoordinatorResult, CoordinatorRouteOptions, StageName } from "./coordinator";
import type { PipelineExecuteOptions, PipelineExecutor, PipelineOutcome, PipelineProgressState, PipelineResult, PipelineSegmentResult } from "./pipeline";
import type { TurnRequirement } from "./turn-requirements";
import { normalizeRoute } from "./route-normalization";
import { splitPipelineAtReplan, buildReplanRequest } from "./replan";
import type { PipelineStageState } from "./stage-output";

/**
 * A stage counts as "completed" once its carry-state slot is populated by an
 * earlier segment. `synthesizer` has no carry-state slot (it's terminal, and
 * `executeSegment` only runs it when explicitly requested), so it is never
 * treated as already completed.
 */
function isStageCompleted(stage: StageName, carry: PipelineStageState): boolean {
  switch (stage) {
    case "planner":
      return carry.plan !== undefined;
    case "executor":
      return carry.executor !== undefined;
    case "reviewer":
      return carry.reviewer !== undefined;
    case "rewriter":
      return carry.rewriter !== undefined;
    case "synthesizer":
      return false;
    default:
      return false;
  }
}

export interface ReplanLoopArgs {
  contextMessage: string;
  initialDecision: CoordinatorResult;
  turnRequirement: TurnRequirement;
  coordinator: Coordinator;
  routeOptions: CoordinatorRouteOptions;
  executor: PipelineExecutor;
  agentRunId: string;
  onStateChange: (state: PipelineProgressState) => void;
  baseOptions: PipelineExecuteOptions;
  maxReplans: number;
}

/**
 * Executes up to the first `conductor_replan` marker, re-invokes the
 * conductor with summarized stage outputs, and continues with the revised
 * route — bounded by `maxReplans`. Once the budget is exhausted, runs the
 * remaining normalized pipeline to completion instead of replanning again,
 * so a turn can never hang on an unbounded replan loop.
 *
 * `turnRequirement` is fixed for the whole turn (it's derived from the raw
 * user message, which doesn't change mid-turn), so re-deriving the execution
 * profile from it on every iteration guarantees a `read_only` turn can never
 * escalate to `full` no matter what the replanned decision asks for.
 */
export async function runPipelineWithReplanning(args: ReplanLoopArgs): Promise<PipelineResult> {
  let decision = args.initialDecision;
  let carry: PipelineStageState = {};
  let replans = 0;

  while (true) {
    const normalized = normalizeRoute(decision, args.turnRequirement, "model");
    const hasReplanMarker = decision.pipeline.includes("conductor_replan");
    const budgetExhausted = replans >= args.maxReplans;

    if (!hasReplanMarker || budgetExhausted) {
      // `normalizeRoute` assumes it is normalizing a FRESH pipeline (its
      // required-stage invariants, e.g. "workspace_read always includes
      // executor", exist to stop the very first route from collapsing to
      // synthesizer-only). Mid-loop, a stage in `normalized.pipeline` may
      // already have run in an earlier segment and be sitting in `carry` —
      // re-running it here would silently overwrite that carried state and
      // double-invoke the stage. Drop anything already completed so each
      // stage in the whole replan run executes at most once.
      const remainingPipeline = normalized.pipeline.filter((stage) => !isStageCompleted(stage, carry));
      const segment = await args.executor.executeSegment(
        args.contextMessage,
        remainingPipeline,
        args.agentRunId,
        args.onStateChange,
        {
          ...args.baseOptions,
          topology: normalized.topology,
          executionProfile: normalized.profile,
          workerInstructions: decision.worker_instructions ?? args.baseOptions.workerInstructions,
          sharedContext: decision.shared_context ?? args.baseOptions.sharedContext,
        },
        carry,
      );
      return finalizeSegment(segment);
    }

    const segments = splitPipelineAtReplan(decision.pipeline);
    const firstSegmentStages = segments[0] ?? [];
    args.onStateChange({ stage: "conductor_replan", status: "running", output: "Re-planning remaining stages…" });

    const segment = await args.executor.executeSegment(
      args.contextMessage,
      firstSegmentStages,
      args.agentRunId,
      args.onStateChange,
      {
        ...args.baseOptions,
        topology: "linear",
        executionProfile: normalized.profile,
        workerInstructions: decision.worker_instructions ?? args.baseOptions.workerInstructions,
        sharedContext: decision.shared_context ?? args.baseOptions.sharedContext,
      },
      carry,
    );
    carry = segment.state;

    const remainingStagesHint = segments.slice(1).flat();
    const replanRequestText = buildReplanRequest(args.contextMessage, carry, remainingStagesHint);
    decision = await args.coordinator.route(replanRequestText, args.routeOptions);
    replans += 1;
    args.onStateChange({ stage: "conductor_replan", status: "done", output: decision.coordinator_rationale });
  }
}

function finalizeSegment(segment: PipelineSegmentResult): PipelineResult {
  const upstreamDegraded = Boolean(
    (segment.state.plan && !segment.state.plan.ok) || (segment.state.executor && !segment.state.executor.ok),
  );

  if (segment.synthesizerAnswer === undefined) {
    return {
      answer: segment.state.plan ? segment.state.plan.narrative : "No planning stage executed.",
      recursion_depth: 0,
      outcome: upstreamDegraded ? "degraded" : "success",
      error_code: upstreamDegraded ? "upstream_stage_failed" : undefined,
    };
  }

  let outcome: PipelineOutcome;
  let errorCode: string | undefined;
  if (segment.synthesizerFatalError) {
    outcome = "failed";
    errorCode = "stage_error";
  } else if (segment.synthesizerEmptyCompletion) {
    outcome = "failed";
    errorCode = "empty_completion";
  } else if (upstreamDegraded) {
    outcome = "degraded";
    errorCode = "upstream_stage_failed";
  } else {
    outcome = "success";
  }

  return {
    answer: segment.synthesizerEmptyCompletion ? "" : (segment.synthesizerAnswer as string),
    error: segment.synthesizerFatalError,
    recursion_depth: 0,
    outcome,
    error_code: errorCode,
  };
}
