// server-jarvis/src/orchestration/replan.ts
// ═══════════════════════════════════════════════════════════════
// B-02 (Track B, Conductor Recursive Self-Selection): the actual
// re-invocation behavior for the `conductor_replan` meta decision.
// See docs/issues/post-phase-4-conductor-evolution.md B-02.
// ═══════════════════════════════════════════════════════════════

import type { CoordinatorResult, StageName } from "./coordinator";
import type { PipelineStageState } from "./stage-output";
import {
  renderExecutorSummary,
  renderPlanSummary,
  renderReviewerSummary,
  renderRewriterSummary,
} from "./stage-output";

/**
 * Split a coordinator's raw pipeline into ordered stage-name segments at each
 * `conductor_replan` marker. `re-enter:<stage>` entries collapse to their
 * target stage (matching `Coordinator.executablePipeline`); nulls and empty
 * segments (e.g. two replan markers back to back) are dropped. A pipeline
 * with no `conductor_replan` marker returns exactly one segment.
 *
 * If every step is dropped (empty pipeline, or a pipeline consisting only of
 * `conductor_replan` markers), returns a single `["synthesizer"]` segment
 * rather than an empty list, so callers can always assume at least one
 * non-empty segment.
 */
export function splitPipelineAtReplan(pipeline: CoordinatorResult["pipeline"]): StageName[][] {
  const segments: StageName[][] = [[]];
  for (const step of pipeline) {
    if (!step) continue;
    if (step === "conductor_replan") {
      segments.push([]);
      continue;
    }
    const stage = step.startsWith("re-enter:") ? step.slice("re-enter:".length) : step;
    segments[segments.length - 1].push(stage as StageName);
  }
  const nonEmpty = segments.filter((segment) => segment.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : [["synthesizer"]];
}

/**
 * Build the mid-pipeline replan request text sent back to the conductor.
 * Feeds SUMMARIZED stage outputs — never raw tool trajectories — per B-02's
 * "enforce intra-workflow isolation" acceptance note.
 */
export function buildReplanRequest(
  originalRequest: string,
  state: PipelineStageState,
  remainingStages: StageName[],
): string {
  const parts = [
    `[MID-PIPELINE REPLAN] Original request:\n${originalRequest}`,
    `Plan so far:\n${renderPlanSummary(state.plan)}`,
    `Executor findings so far:\n${renderExecutorSummary(state.executor)}`,
    state.reviewer ? `Reviewer feedback so far:\n${renderReviewerSummary(state.reviewer)}` : "",
    state.rewriter ? `Rewriter activity so far:\n${renderRewriterSummary(state.rewriter)}` : "",
    remainingStages.length > 0
      ? `Stages the previous route still had queued after this replan point: ${remainingStages.join(", ")}`
      : "No stages were queued after this replan point — re-derive from scratch.",
    "The current plan has proven wrong or incomplete given what was just discovered. Re-derive worker_instructions (and pipeline/shared_context if the stage list itself must change) for the remaining work.",
  ].filter(Boolean);
  return parts.join("\n\n");
}
