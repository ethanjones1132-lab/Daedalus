// server-jarvis/src/orchestration/stage-output.ts
// ═══════════════════════════════════════════════════════════════
// Structured pipeline stage output — replaces the ad-hoc truncated
// string concatenation that used to flow between planner/executor/
// reviewer/rewriter/synthesizer. Each stage produces a typed record
// (with an explicit `ok` flag instead of string-prefix sniffing like
// `plan.startsWith("Failed to generate plan")`), and the render*
// functions turn that record into the exact text the next stage's
// prompt needs. This is also the carry-state type used by the B-02
// conductor_replan loop (see replan.ts / replan-loop.ts) — a replan
// needs to hand the conductor summarized findings, not raw strings.
// ═══════════════════════════════════════════════════════════════

import type { ToolErrorCode } from "../tool-types";

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  is_error: boolean;
  /** Set when `is_error` is true — stable machine-readable category (see tool-types.ts). */
  error_code?: ToolErrorCode;
  duration_ms: number;
}

export interface PlannerStageOutput {
  ok: boolean;
  narrative: string;
}

export interface ExecutorStageOutput {
  ok: boolean;
  narrative: string;
  toolCalls: ToolCallRecord[];
}

export interface ReviewerStageOutput {
  ok: boolean;
  feedback: string;
  hasIssues: boolean;
}

export interface RewriterStageOutput {
  ok: boolean;
  narrative: string;
  toolCalls: ToolCallRecord[];
}

/** Accumulated state across a pipeline (or pipeline segment). */
export interface PipelineStageState {
  plan?: PlannerStageOutput;
  executor?: ExecutorStageOutput;
  reviewer?: ReviewerStageOutput;
  rewriter?: RewriterStageOutput;
}

const TOOL_OUTPUT_TRUNCATE_AT = 1000;

function renderToolCalls(toolCalls: ToolCallRecord[]): string {
  return toolCalls
    .map((call) => {
      const body = call.output.length > TOOL_OUTPUT_TRUNCATE_AT
        ? `${call.output.slice(0, TOOL_OUTPUT_TRUNCATE_AT)}... (${call.output.length - TOOL_OUTPUT_TRUNCATE_AT} more chars, truncated)`
        : call.output;
      return `<jarvis_internal_tool_result name="${call.name}">\n[Tool Call Result (${call.name})]${call.is_error ? " FAILED" : ""}: ${body}\n</jarvis_internal_tool_result>`;
    })
    .join("\n\n");
}

export function renderPlanSummary(stage: PlannerStageOutput | undefined): string {
  if (!stage) return "No planning stage executed.";
  return stage.narrative;
}

export function renderExecutorSummary(stage: ExecutorStageOutput | undefined): string {
  if (!stage) return "No execution stage executed.";
  const parts = [
    stage.narrative ? `[Executor]: ${stage.narrative}` : "",
    renderToolCalls(stage.toolCalls),
  ].filter(Boolean);
  return parts.join("\n\n");
}

export function renderReviewerSummary(stage: ReviewerStageOutput | undefined): string {
  if (!stage) return "No review stage executed.";
  return stage.feedback;
}

export function renderRewriterSummary(stage: RewriterStageOutput | undefined): string {
  if (!stage) return "No rewriting stage executed.";
  const parts = [
    stage.narrative ? `[Rewriter]: ${stage.narrative}` : "",
    renderToolCalls(stage.toolCalls),
  ].filter(Boolean);
  return parts.join("\n\n");
}
