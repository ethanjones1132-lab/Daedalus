import { stripReasoningFromText } from "../reasoning";
import { truncateToTokenBudget } from "./context-budget";
import type { PipelineStageState } from "./stage-output";
import {
  isDuplicateToolDeflection,
  renderExecutorSummary,
  renderPlanSummary,
  renderReviewerSummary,
  renderRewriterSummary,
} from "./stage-output";

export interface SynthesizerParts {
  plan?: string;
  executorSummary?: string;
  reviewerFeedback?: string;
  rewriterSummary?: string;
}

const SKIP_SENTINELS = new Set<string>([
  "No planning stage executed.",
  "No execution stage executed.",
  "No review stage executed.",
  "No rewriting stage executed.",
  "No execution stage executed. Planner and reviewer ran speculatively without tool execution.",
]);

function clean(value: string | undefined): string {
  if (!value) return "";
  return stripReasoningFromText(value).trim();
}

function isMeaningful(value: string): boolean {
  return value.length > 0 && !SKIP_SENTINELS.has(value);
}

export function buildSynthesizerContext(
  request: string,
  parts: SynthesizerParts,
  executionVerification = "",
): string {
  const sections: string[] = [`User Request: ${truncateToTokenBudget(request, 1_000)}`];

  const plan = truncateToTokenBudget(clean(parts.plan), 700);
  // T1.5: prioritize final executor findings over raw tool logs within the
  // same 2600-token budget (reorder — findings first when the summary has a
  // "Findings:" / "Result:" style tail; otherwise keep full executor block).
  const executor = truncateToTokenBudget(prioritizeExecutorFindings(clean(parts.executorSummary)), 2_600);
  const review = truncateToTokenBudget(clean(parts.reviewerFeedback), 500);
  const rewrite = truncateToTokenBudget(clean(parts.rewriterSummary), 800);

  // Verification is authoritative and must survive truncation, so place it
  // immediately after the user request rather than behind verbose stage text.
  if (isMeaningful(clean(executionVerification))) sections.push(truncateToTokenBudget(clean(executionVerification), 700));

  // Prefer executor evidence before plan for workspace_read-style turns so
  // the synthesizer sees findings first within the total budget.
  if (isMeaningful(executor)) sections.push(`Executor Activity:\n${executor}`);
  if (isMeaningful(plan)) sections.push(`Original Plan:\n${plan}`);
  if (isMeaningful(review)) sections.push(`Reviewer Feedback:\n${review}`);
  if (isMeaningful(rewrite)) sections.push(`Rewriter Activity:\n${rewrite}`);
  return truncateToTokenBudget(sections.join("\n\n"), 6_000);
}

function buildExecutedToolLedger(state: PipelineStageState): string {
  const calls = [
    ...(state.executor?.toolCalls ?? []),
    ...(state.rewriter?.toolCalls ?? []),
  ];
  if (calls.length === 0) return "";
  const rows = calls.map((call, index) => {
    const status = isDuplicateToolDeflection(call)
      ? "DEFLECTED (not executed again)"
      : call.is_error
        ? `FAILED${call.error_code ? ` (${call.error_code})` : ""}`
        : "SUCCEEDED";
    return `${index + 1}. ${call.name} ${JSON.stringify(call.arguments)} — ${status}`;
  });
  return [
    "Executed Tool Ledger (authoritative)",
    "Only entries in this ledger actually executed. A user request, plan, or narrative is not execution evidence; never claim any other tool or file was inspected.",
    ...rows,
  ].join("\n");
}

/** Prefer trailing findings/result blocks over leading raw tool-call logs. */
function prioritizeExecutorFindings(summary: string): string {
  if (!summary) return summary;
  // If the summary already looks findings-first, leave it alone.
  if (/^(Findings|Result|Summary|Answer)\b/i.test(summary.trim())) return summary;
  // Split on a findings-style heading if present and put it first.
  const match = summary.match(/\n(?:#{1,3}\s*)?(Findings|Result|Summary|Answer)\b[:\s]/i);
  if (!match || match.index === undefined) return summary;
  const findings = summary.slice(match.index).trim();
  const prefix = summary.slice(0, match.index).trim();
  if (!findings) return summary;
  // Findings first; keep a truncated prefix of raw logs after.
  return prefix ? `${findings}\n\n---\nTool log (truncated):\n${prefix}` : findings;
}

/**
 * Structured-state variant of `buildSynthesizerContext`. Renders each stage's
 * typed output through stage-output.ts and delegates to the existing
 * string-based builder so the `SKIP_SENTINELS` filtering stays in one place.
 */
export function buildSynthesizerContextFromStageState(
  request: string,
  state: PipelineStageState,
  executionVerification = "",
): string {
  const ledger = buildExecutedToolLedger(state);
  const verification = [ledger, executionVerification].filter((part) => part.trim()).join("\n\n");
  return buildSynthesizerContext(request, {
    plan: renderPlanSummary(state.plan),
    executorSummary: renderExecutorSummary(state.executor),
    reviewerFeedback: renderReviewerSummary(state.reviewer),
    rewriterSummary: renderRewriterSummary(state.rewriter),
  }, verification);
}
