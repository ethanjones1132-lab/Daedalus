import { stripReasoningFromText } from "../reasoning";

export interface SynthesizerParts {
  plan?: string;
  executorSummary?: string;
  reviewerFeedback?: string;
  rewriterSummary?: string;
}

const SKIP_SENTINELS = new Set<string>([
  "",
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

export function buildSynthesizerContext(request: string, parts: SynthesizerParts): string {
  const sections: string[] = [`User Request: ${request}`];

  const plan = clean(parts.plan);
  const exec = clean(parts.executorSummary);
  const review = clean(parts.reviewerFeedback);
  const rewrite = clean(parts.rewriterSummary);

  if (isMeaningful(plan)) sections.push(`Original Plan:\n${plan}`);
  if (isMeaningful(exec)) sections.push(`Executor Activity:\n${exec}`);
  if (isMeaningful(review)) sections.push(`Reviewer Feedback:\n${review}`);
  if (isMeaningful(rewrite)) sections.push(`Rewriter Activity:\n${rewrite}`);

  return sections.join("\n\n");
}
