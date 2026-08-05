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

export const DUPLICATE_TOOL_DEFLECTION_MARKER = "[duplicate call deflected]";

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  is_error: boolean;
  /** Set when `is_error` is true — stable machine-readable category (see tool-types.ts). */
  error_code?: ToolErrorCode;
  duration_ms: number;
}

export function isDuplicateToolDeflection(call: Pick<ToolCallRecord, "output">): boolean {
  return call.output.trimStart().startsWith(DUPLICATE_TOOL_DEFLECTION_MARKER);
}

export interface PlannerStageOutput {
  ok: boolean;
  narrative: string;
}

/** Bounded, sanitized Claude-delegate process diagnostics for stage_runs. */
export interface DelegateStageDiagnostics {
  delegate_request_id?: string;
  auth_mode?: string;
  base_url?: string;
  exit_code?: number | null;
  stderr_tail?: string;
  /** Newest ≤4096 chars of raw stdout (incl. non-JSON), secrets scrubbed. */
  stdout_tail?: string;
}

export interface ExecutorStageOutput {
  ok: boolean;
  narrative: string;
  toolCalls: ToolCallRecord[];
  /** Why execution stopped when `ok` is false. */
  terminalStatus?: "completed" | "failed" | "timed_out" | "cancelled" | "partial";
  /** Stable reason used by replanning and telemetry. */
  errorCode?: string;
  /**
   * Underlying exception text for a typed failure (e.g. snapshot EMFILE).
   * Bounded; never put this on SSE or final_output — stage_runs.failure_detail only.
   */
  failureDetail?: string;
  /** Actual provider/model used by the final native candidate, for bounded escalation. */
  modelKey?: string;
  /**
   * Persistable Claude-delegate process diagnostics (request id, exit code,
   * sanitized stderr tail). Never put this on SSE or final_output.
   */
  diagnostics?: DelegateStageDiagnostics;
}

export interface ReviewerStageOutput {
  ok: boolean;
  feedback: string;
  hasIssues: boolean;
}

export type ReviewerVerdict = "accept" | "reject" | "unknown";

/** Parse the reviewer's leading verdict per prompts/modes/reviewer.md. */
export function parseReviewerVerdict(feedback: string): ReviewerVerdict {
  const head = feedback.trimStart().slice(0, 200).toUpperCase();
  if (/^\**\s*ACCEPT\b/.test(head)) return "accept";
  if (/^\**\s*REJECT\b/.test(head)) return "reject";
  if (/\bREJECT\b/.test(head) && !/\bACCEPT\b/.test(head)) return "reject";
  if (/\bACCEPT\b/.test(head) && !/\bREJECT\b/.test(head)) return "accept";
  return "unknown";
}

export interface RewriterStageOutput {
  ok: boolean;
  narrative: string;
  toolCalls: ToolCallRecord[];
  terminalStatus?: "completed" | "failed" | "timed_out" | "cancelled" | "partial";
  errorCode?: string;
}

/** Accumulated state across a pipeline (or pipeline segment). */
export interface PipelineStageState {
  plan?: PlannerStageOutput;
  executor?: ExecutorStageOutput;
  reviewer?: ReviewerStageOutput;
  rewriter?: RewriterStageOutput;
}

/**
 * A model-only stage that resolves with no meaningful visible content has
 * failed, even when the provider returned HTTP 200. Keeping this predicate at
 * the stage-output boundary prevents empty completions from being recorded as
 * successful work by the self-tuning collector.
 */
export function isEmptyStageOutput(content: string | null | undefined): boolean {
  return !content || content.trim().length === 0;
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

/**
 * The "no stage ran" strings the render helpers below emit. They are rendering
 * placeholders, NOT content: anything that formats one into a model-facing
 * instruction is telling the model to act on a null. `synth-context.ts` keeps
 * its own (broader) SKIP_SENTINELS set for the synthesizer path; this one is
 * scoped to exactly what the renderers here produce, which is what callers
 * downstream of `renderPlanSummary` et al. actually receive.
 */
const STAGE_SUMMARY_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "No planning stage executed.",
  "No execution stage executed.",
  "No review stage executed.",
  "No rewriting stage executed.",
]);

/** True when a rendered stage summary is a "stage did not run" placeholder. */
export function isStageSummaryPlaceholder(summary: string | undefined): boolean {
  return summary !== undefined && STAGE_SUMMARY_PLACEHOLDERS.has(summary.trim());
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
