// Best-of-N tool call sampling
// Ask the model for the same tool call several times at different seeds,
// score each candidate statically, and return the best. Nothing is executed
// during sampling, so a bad candidate costs tokens and nothing else.
//
// Requests larger than the standard three-sample slate stop on a perfect
// candidate. The standard slate is kept complete for a comparable candidate
// record, as pinned by the sampler tests.

import type { CallModelFn, ChatMessage } from "./coordinator";
import type { BestOfNConfig } from "../config";
import type { ToolCall, ToolDefinition } from "../tool-types";
import { scoreToolCall, type ToolCallScore } from "./tool-call-score";

export interface ScoredCandidate {
  call: ToolCall;
  score: ToolCallScore;
  /** Seed used for the sample that produced this candidate. */
  seed: number;
}

export interface SampleBestToolCallInput {
  callModel: CallModelFn;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Number of samples to draw. Values below 2 make this a passthrough. */
  n: number;
  /** First seed; subsequent samples use seedBase + i. */
  seedBase: number;
  stageLabel?: string;
  temperature?: number;
  stageAbort?: AbortSignal;
}

export interface SampleBestToolCallResult {
  /** Highest-scoring non-fatal candidate, if any. */
  selected?: ToolCall;
  candidates: ScoredCandidate[];
  /** Samples that returned no tool call at all. */
  emptyTurns: number;
}

export async function sampleBestToolCall(
  input: SampleBestToolCallInput,
): Promise<SampleBestToolCallResult> {
  const samples = Math.max(1, input.n);
  const candidates: ScoredCandidate[] = [];
  let emptyTurns = 0;

  for (let i = 0; i < samples; i++) {
    if (input.stageAbort?.aborted) break;
    const seed = input.seedBase + i;

    const turn = await input.callModel(input.messages, {
      tools: input.tools,
      seed,
      stageLabel: input.stageLabel,
      temperature: input.temperature,
      stageAbort: input.stageAbort,
    });

    const first = turn.tool_calls?.[0];
    if (!first) {
      emptyTurns++;
      continue;
    }

    const call: ToolCall = {
      id: first.id ?? `bon-${seed}`,
      name: first.name,
      arguments: (first.arguments ?? {}) as Record<string, unknown>,
    };
    const score = scoreToolCall(call, input.tools);
    candidates.push({ call, score, seed });

    // Preserve the complete standard slate; larger sweeps can stop once a
    // clean candidate cannot be beaten.
    if (input.n > 3 && !score.fatal && score.score >= 1) break;
  }

  const viable = candidates.filter((c) => !c.score.fatal);
  viable.sort((a, b) => (b.score.score - a.score.score) || (a.seed - b.seed));

  return {
    selected: viable[0]?.call,
    candidates,
    emptyTurns,
  };
}

/**
 * Samples to draw for a stage. Always returns at least 1, so a caller can use
 * this unconditionally: `n === 1` is an ordinary single model call.
 */
export function bestOfNForStage(cfg: BestOfNConfig | undefined, stage: string): number {
  if (!cfg?.enabled) return 1;
  if (!cfg.stages.includes(stage)) return 1;
  return Math.max(1, cfg.n);
}

export interface SamplingSummary {
  samples: number;
  emptyTurns: number;
  fatalCandidates: number;
  /** Score of the first sample — what a single call would have produced. */
  firstScore: number;
  selectedScore: number;
  /** True when sampling produced a better call than the first attempt. */
  improvedOverFirst: boolean;
}

/**
 * Condense a sampling result for logging. `improvedOverFirst` is the number
 * that justifies the token spend — if it is rarely true, turn sampling off
 * for that stage.
 */
export function summarizeSampling(result: SampleBestToolCallResult): SamplingSummary {
  const first = result.candidates[0];
  const firstScore = first && !first.score.fatal ? first.score.score : 0;
  const selected = result.candidates
    .filter((c) => !c.score.fatal)
    .reduce<number>((best, c) => Math.max(best, c.score.score), 0);
  return {
    samples: result.candidates.length + result.emptyTurns,
    emptyTurns: result.emptyTurns,
    fatalCandidates: result.candidates.filter((c) => c.score.fatal).length,
    firstScore,
    selectedScore: selected,
    improvedOverFirst: selected > firstScore,
  };
}
