/**
 * Bound no-tool executor turns and deduplicate semantic write pressure.
 *
 * Live runs spent minutes on executor turns that emitted prose with zero tools
 * (~49% of turns). This policy allows at most one strong-model retry on a
 * write-intent no-tool turn, then stops partial with `executor_no_tool`.
 * Semantic pressure notes (write effect, plan remainder, etc.) are claimed
 * once per logical agent run so reroutes cannot re-inject the same text.
 */

export type ExecutorProgressDecision = "continue" | "retry_strong" | "stop_partial";

export interface ExecutorProgressInput {
  writeIntent: boolean;
  emittedToolCalls: boolean;
  successfulWrites: number;
  /** Count of consecutive write-intent turns with zero tool calls (and no write progress). */
  consecutiveNoToolTurns: number;
  stageRemainingMs: number;
  /** True once any model tool call has landed in this executor stage. */
  anyToolCallThisStage?: boolean;
  /** Total executor turns this stage that emitted no tool call. */
  noToolTurns?: number;
  /** Total executor turns this stage. */
  executorTurns?: number;
}

/** Minimum stage budget remaining required for a strong-model no-tool retry. */
export const NO_TOOL_RETRY_BUDGET_FLOOR_MS = 20_000;

/**
 * Ratio bound for INTERLEAVED prose turns.
 *
 * The consecutive-streak rule below cannot see the observed failure: measured
 * over the 8-run window after the completion-integrity merge, executor no-tool
 * turns were 42.9% against a <=10% target, arriving as tool/prose/tool/prose.
 * Any tool call resets the streak, so the streak never reaches 2 — and
 * `pipeline.ts` additionally short-circuited the whole policy once a single
 * tool call had landed in the stage.
 *
 * Discrimination matters here: a READ SPIRAL is a mostly-tool stage, so its
 * no-tool ratio stays low and it still reaches the effect gate, which is what
 * that short-circuit was protecting. Only a mostly-prose, zero-write stage
 * trips this.
 */
export const NO_TOOL_RATIO_CEILING = 0.5;
export const NO_TOOL_RATIO_MIN_TURNS = 6;

/**
 * Decide whether the executor loop should keep going, retry once on a
 * different strong model, or stop with a typed partial.
 *
 * - Read-only / already-mutated turns: continue (prose end is fine).
 * - First no-tool write turn with budget: retry_strong.
 * - Second consecutive no-tool (or budget too low for retry): stop_partial.
 * - Any real tool call resets the streak (caller sets consecutiveNoToolTurns=0).
 */
export function decideExecutorProgress(input: ExecutorProgressInput): ExecutorProgressDecision {
  if (!input.writeIntent) return "continue";
  if (input.emittedToolCalls || input.successfulWrites > 0) return "continue";
  // Interleaved-prose bound. Evaluated BEFORE the `anyToolCallThisStage`
  // exemption below, because that exemption is exactly what let an
  // alternating tool/prose stage run unbounded.
  const executorTurns = input.executorTurns ?? 0;
  const noToolTurns = input.noToolTurns ?? 0;
  if (
    executorTurns >= NO_TOOL_RATIO_MIN_TURNS
    && noToolTurns / executorTurns >= NO_TOOL_RATIO_CEILING
  ) {
    return "stop_partial";
  }
  // A stage that has produced real tool calls still reaches the effect gate so
  // failed tools and read spirals are handled there, not truncated here.
  if (input.anyToolCallThisStage) return "continue";
  if (input.consecutiveNoToolTurns <= 0) return "continue";
  if (
    input.consecutiveNoToolTurns === 1
    && input.stageRemainingMs > NO_TOOL_RETRY_BUDGET_FLOOR_MS
  ) {
    return "retry_strong";
  }
  return "stop_partial";
}

export type SemanticPressure =
  | "workspace_evidence"
  | "write_effect"
  | "plan_remainder"
  | "quality_after_correctness";

/**
 * One claim per key per logical agent run. Pass through segment/replan options
 * so pre-mid-loop effect-gate pressure and resident mid-loop force_write share
 * a single `write_effect` slot.
 */
export class SemanticPressureBudget {
  private readonly claimed = new Set<SemanticPressure>();

  /** Returns true only on the first claim of `key` for this run. */
  claim(key: SemanticPressure): boolean {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  /** Whether `key` has already been claimed. */
  has(key: SemanticPressure): boolean {
    return this.claimed.has(key);
  }
}

/** Directive type recorded when a duplicate semantic pressure inject is suppressed. */
export const SEMANTIC_PRESSURE_SUPPRESSED = "semantic_pressure_suppressed";
