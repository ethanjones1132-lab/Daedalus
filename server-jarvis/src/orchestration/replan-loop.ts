// server-jarvis/src/orchestration/replan-loop.ts
// ═══════════════════════════════════════════════════════════════
// B-02 (Track B, Conductor Recursive Self-Selection): runs a pipeline
// that contains one or more `conductor_replan` meta-decisions.
// B-04: persists per-replan telemetry and enforces a per-session
// cumulative cap alongside the existing per-turn cap. See
// docs/issues/post-phase-4-conductor-evolution.md B-02 / B-04.
// ═══════════════════════════════════════════════════════════════

import type { Coordinator, CoordinatorResult, CoordinatorRouteOptions, StageName } from "./coordinator";
import type { PipelineExecuteOptions, PipelineExecutor, PipelineOutcome, PipelineProgressState, PipelineResult, PipelineSegmentResult } from "./pipeline";
import type { TurnRequirement } from "./turn-requirements";
import { normalizeRoute } from "./route-normalization";
import { splitPipelineAtReplan, buildReplanRequest } from "./replan";
import type { PipelineStageState } from "./stage-output";
import type { SessionReplanCounter, ReplanCapKind } from "./replan-telemetry";
import { segmentOutcomeFromCarry } from "./replan-telemetry";

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
  /**
   * B-04: session-scoped counter for per-session replan caps and
   * persistent telemetry. Optional — when omitted the loop falls
   * back to the B-02 per-turn cap alone (no session cap, no DB
   * writes). Pass `null` explicitly to skip the per-session cap
   * but still allow `sessionId` to be omitted (no telemetry).
   */
  sessionCounter?: SessionReplanCounter | null;
  /** B-04: session id for the per-session cap and telemetry. Required
   *  when `sessionCounter` is supplied. */
  sessionId?: string;
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
 *
 * B-04: when `sessionCounter` + `sessionId` are supplied, the effective
 * per-turn cap is `min(callerMaxReplans, sessionCounter.remaining(sessionId))`
 * and every successful re-invocation is recorded as a `ReplanEvent`. When
 * the session cap is the binding constraint, the final `PipelineResult`
 * carries `error_code: "session_replan_cap_exceeded"` so the failure mode
 * is observable in metrics even though the turn still returns an answer
 * (graceful degradation — never an aborted turn).
 */
export async function runPipelineWithReplanning(args: ReplanLoopArgs): Promise<PipelineResult> {
  let decision = args.initialDecision;
  let carry: PipelineStageState = {};
  let replans = 0;
  // B-04: track the per-turn and per-session caps independently so we can
  // tag the final result with the right `error_code` when the session cap
  // is the binding constraint.
  let perTurnCap = args.maxReplans;
  let sessionCapHit = false;

  while (true) {
    const normalized = normalizeRoute(decision, args.turnRequirement, "model");
    const hasReplanMarker = decision.pipeline.includes("conductor_replan");
    // B-04: when a session counter is in play, the per-turn cap is the
    // min of the caller's per-turn cap and the session's remaining budget.
    // Recomputed every iteration so an earlier loop in the same turn
    // (or a parallel turn on the same session) can never leak capacity.
    if (args.sessionCounter && args.sessionId) {
      perTurnCap = args.sessionCounter.effectivePerTurnCap(args.sessionId, args.maxReplans);
    }
    const perTurnExhausted = replans >= perTurnCap;
    // B-04: a session-cap hit that beats the per-turn cap is recorded for
    // the final result tag, but the loop still continues normally to run
    // the remaining pipeline. The session cap is checked here in
    // addition to the per-turn cap so a turn that re-runs the loop body
    // (a re-plan that returns another re-plan) is bounded by it.
    if (args.sessionCounter && args.sessionId && args.sessionCounter.remaining(args.sessionId) === 0) {
      sessionCapHit = true;
    }
    const budgetExhausted = perTurnExhausted || sessionCapHit;

    if (!hasReplanMarker || budgetExhausted) {
      // `normalizeRoute` assumes it is normalizing a FRESH pipeline (its
      // required-stage invariants, e.g. "workspace_read always includes
      // executor", exist to stop the very first route from collapsing to
      // synthesizer-only). Mid-loop, a stage in `normalized.pipeline` may
      // already have run in an earlier segment and be sitting in `carry` —
      // re-running it here would silently overwrite that carried state and
      // double-invoke the stage. Drop anything already completed so each
      // stage in the whole replan run executes at most once — UNLESS the
      // post-replan decision explicitly re-requested that stage (plainly or
      // via `re-enter:<stage>`), e.g. the coordinator decided the earlier
      // executor pass was wrong and wants it redone with new instructions.
      // Explicit presence in the model's own decision always wins over
      // carry-presence; only a stage that's both already-done AND never
      // asked for again gets filtered as a spurious `normalizeRoute`
      // re-injection.
      const explicitlyRequested = new Set(splitPipelineAtReplan(decision.pipeline).flat());
      const remainingPipeline = normalized.pipeline.filter(
        (stage) => explicitlyRequested.has(stage) || !isStageCompleted(stage, carry),
      );
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
      return finalizeSegment(segment, sessionCapHit);
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

    // B-04: record this replan BEFORE incrementing the local counter so
    // the recorded `replan_index` matches the value the counter just
    // produced. `record()` returns that new index; we also bump the local
    // `replans` counter to drive the loop's per-turn guard. The cap tag
    // we pass is "" (no cap hit) here — we only tag "per_turn" /
    // "per_session" when the loop actually terminates because of that
    // cap on a FUTURE iteration (or the final-result path that runs
    // through `finalizeSegment`).
    if (args.sessionCounter && args.sessionId) {
      const capTag: ReplanCapKind = replans + 1 >= args.maxReplans ? "per_turn" : "";
      args.sessionCounter.record({
        sessionId: args.sessionId,
        agentRunId: args.agentRunId,
        replanIndex: 0, // overwritten by counter with the real index
        rationale: decision.coordinator_rationale ?? "",
        revised: decision,
        segmentOutcome: segmentOutcomeFromCarry(segment.state),
        cap: capTag,
      });
    }
    replans += 1;
    args.onStateChange({ stage: "conductor_replan", status: "done", output: decision.coordinator_rationale });
  }
}

function finalizeSegment(segment: PipelineSegmentResult, sessionCapHit: boolean): PipelineResult {
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

  // B-04: a session-cap exhaustion is a soft signal, not a stage failure.
  // It only adds the `session_replan_cap_exceeded` tag if the rest of the
  // pipeline produced a real answer — a degenerate synthesizer answer
  // keeps its own `error_code` (empty_completion / stage_error / etc.) so
  // we don't double-tag or mask a real failure.
  if (sessionCapHit && !errorCode) {
    errorCode = "session_replan_cap_exceeded";
  }

  return {
    answer: segment.synthesizerEmptyCompletion ? "" : (segment.synthesizerAnswer as string),
    error: segment.synthesizerFatalError,
    recursion_depth: 0,
    outcome,
    error_code: errorCode,
  };
}
