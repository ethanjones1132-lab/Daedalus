import type { ModelAttribution, StageRun } from "../self-tuning/store";

export interface TurnMetricSummary {
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  tool_calls: number;
  stage_duration_ms: number;
  failed_attempts: number;
  fallback_successes: number;
}

function countToolCalls(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function summarizeTurnMetrics(input: {
  stages: StageRun[];
  attributions: ModelAttribution[];
}): TurnMetricSummary {
  const tokens_in = input.stages.reduce((sum, stage) => sum + (stage.input_tokens ?? 0), 0);
  const tokens_out = input.stages.reduce((sum, stage) => sum + (stage.output_tokens ?? 0), 0);
  return {
    tokens_in,
    tokens_out,
    tokens_total: tokens_in + tokens_out,
    tool_calls: input.stages.reduce((sum, stage) => sum + countToolCalls(stage.tool_calls_json), 0),
    stage_duration_ms: input.stages.reduce((sum, stage) => sum + (stage.duration_ms ?? 0), 0),
    failed_attempts: input.attributions.filter((attempt) => attempt.had_error === 1).length,
    fallback_successes: input.attributions.filter(
      (attempt) => attempt.fallback_used === 1 && attempt.was_successful === 1,
    ).length,
  };
}
