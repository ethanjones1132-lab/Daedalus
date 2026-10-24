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
import { StageAbortedError } from "./stage-abort-link";
import { scoreToolCall, type ToolCallScore } from "./tool-call-score";

export interface ScoredCandidate {
  call: ToolCall;
  score: ToolCallScore;
  /** Seed used for the sample that produced this candidate. */
  seed: number;
  /** Original streamed turn, retained so the executor keeps its normal response contract. */
  response: Awaited<ReturnType<CallModelFn>>;
  /** Stage-run attribution row for this sample, when the caller supplies one. */
  stageRunId?: string;
}

type CallOptions = NonNullable<Parameters<CallModelFn>[1]>;

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
  /** Forward the executor call contract while replacing only the sample seed. */
  callOptions?: CallOptions;
}

export interface SampleBestToolCallResult {
  /** Highest-scoring non-fatal candidate, if any. */
  selected?: ToolCall;
  selectedCandidate?: ScoredCandidate;
  candidates: ScoredCandidate[];
  /** Samples that returned no tool call at all. */
  emptyTurns: number;
  /** First no-tool turn (or the first turn with its rejected calls removed) for safe fallback. */
  fallbackResponse?: Awaited<ReturnType<CallModelFn>>;
  fallbackStageRunId?: string;
  /** Static score of sample zero; null means it returned no tool call. */
  firstAttemptScore?: ToolCallScore | null;
}

export async function sampleBestToolCall(
  input: SampleBestToolCallInput,
): Promise<SampleBestToolCallResult> {
  const samples = Math.max(1, input.n);
  const candidates: ScoredCandidate[] = [];
  let emptyTurns = 0;
  let fallbackResponse: Awaited<ReturnType<CallModelFn>> | undefined;
  let fallbackStageRunId: string | undefined;
  let firstAttemptScore: ToolCallScore | null | undefined;

  for (let i = 0; i < samples; i++) {
    if (input.stageAbort?.aborted) break;
    const seed = input.seedBase + i;
    const sampleOptions = input.callOptions;
    const stageRunId = typeof sampleOptions?.stageRunId === "string"
      ? sampleOptions.stageRunId
      : undefined;

    const turn = await input.callModel(input.messages, {
      ...sampleOptions,
      tools: input.tools,
      seed,
      stageLabel: input.stageLabel ?? sampleOptions?.stageLabel,
      temperature: input.temperature ?? sampleOptions?.temperature,
      stageAbort: input.stageAbort ?? sampleOptions?.stageAbort,
      // Candidate prose is speculative. Only the winning turn is published by
      // the executor after scoring, so never stream discarded text to users.
      onChunk: undefined,
    });

    const calls = turn.tool_calls ?? [];
    const first = calls[0];
    if (calls.length === 0) {
      emptyTurns++;
      if (i === 0) firstAttemptScore = null;
      if (i === 0 || !fallbackResponse?.content) {
        fallbackResponse = turn;
        fallbackStageRunId = stageRunId;
      }
      continue;
    }

    if (i === 0 && !fallbackResponse) {
      fallbackResponse = { ...turn, tool_calls: undefined };
      fallbackStageRunId = stageRunId;
    }

    const normalizedCalls: ToolCall[] = calls.map((candidate, callIndex) => ({
      id: candidate.id ?? `bon-${seed}-${callIndex}`,
      name: candidate.name,
      arguments: (candidate.arguments ?? {}) as Record<string, unknown>,
    }));
    const call = normalizedCalls[0]!;
    const callScores = normalizedCalls.map((candidate) => scoreToolCall(candidate, input.tools));
    const score = {
      score: Math.min(...callScores.map((candidateScore) => candidateScore.score)),
      fatal: callScores.some((candidateScore) => candidateScore.fatal),
      reasons: callScores.flatMap((candidateScore, callIndex) =>
        candidateScore.reasons.map((reason) => `tool call ${callIndex + 1}: ${reason}`),
      ),
    };
    if (i === 0) firstAttemptScore = score;
    candidates.push({ call, score, seed, response: turn, stageRunId });

    // Preserve the complete standard slate; larger sweeps can stop once a
    // clean candidate cannot be beaten.
    if (input.n > 3 && !score.fatal && score.score >= 1) break;
  }

  if (input.stageAbort?.aborted) {
    throw new StageAbortedError(input.stageLabel ?? input.callOptions?.stageLabel ?? "executor");
  }

  const viable = candidates.filter((c) => !c.score.fatal);
  viable.sort((a, b) => (b.score.score - a.score.score) || (a.seed - b.seed));
  const selectedCandidate = viable[0];

  return {
    selected: selectedCandidate?.call,
    selectedCandidate,
    candidates,
    emptyTurns,
    fallbackResponse,
    fallbackStageRunId,
    firstAttemptScore,
  };
}

/**
 * Samples to draw for a stage. Always returns at least 1, so a caller can use
 * this unconditionally: `n === 1` is an ordinary single model call.
 */
export function bestOfNForStage(cfg: BestOfNConfig | undefined, stage: string): number {
  if (!cfg?.enabled) return 1;
  if (!cfg.stages.includes(stage)) return 1;
  return Number.isFinite(cfg.n) ? Math.max(1, Math.floor(cfg.n)) : 1;
}

export interface CallModelWithBestOfNInput extends Omit<SampleBestToolCallInput, "n"> {
  config: BestOfNConfig | undefined;
  stage: string;
}

export interface CallModelWithBestOfNResult {
  response: Awaited<ReturnType<CallModelFn>>;
  selectedCandidate?: ScoredCandidate;
  sampling?: SampleBestToolCallResult;
}

/**
 * Apply the stage config at the call boundary. Disabled and unlisted stages
 * remain a literal one-call passthrough; configured stages return the original
 * winning model turn so downstream tool dispatch remains unchanged.
 */
export async function callModelWithBestOfN(
  input: CallModelWithBestOfNInput,
): Promise<CallModelWithBestOfNResult> {
  const n = bestOfNForStage(input.config, input.stage);
  if (n <= 1) {
    return {
      response: await input.callModel(input.messages, {
        ...input.callOptions,
        tools: input.tools,
      }),
    };
  }

  const sampling = await sampleBestToolCall({
    ...input,
    n,
    stageLabel: input.stageLabel ?? input.stage,
  });
  return {
    response: sampling.selectedCandidate?.response
      ?? sampling.fallbackResponse
      ?? { content: "" },
    selectedCandidate: sampling.selectedCandidate,
    sampling,
  };
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
  const firstAttempt = result.candidates.slice().sort((a, b) => a.seed - b.seed)[0];
  const firstScore = result.firstAttemptScore === null
    ? 0
    : result.firstAttemptScore
      ? (result.firstAttemptScore.fatal ? 0 : result.firstAttemptScore.score)
      : (firstAttempt && !firstAttempt.score.fatal ? firstAttempt.score.score : 0);
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
