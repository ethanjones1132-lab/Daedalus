import { loadPrompt } from "./prompt-loader";
import { defaultCapabilityIndex } from "../tool-capabilities-default";
import { deriveEvidenceTaskKind } from "./turn-requirements";
import { injectToolGuidelines } from "./tool-guidelines";
import { checkWrittenFilesSyntax, renderSyntaxIssues, type SyntaxIssue } from "./syntax-gate";
import { renderRunIssues, runWrittenCodeGate, type RunGateResult } from "./run-gate";
import { BUILTIN_MODES, executorTurnLimit, getToolsForMode } from "./modes";
import { toolResultModelText, type ToolRuntime, type ExecutionContext } from "../tool-runtime";
import type { CallModelFn, ChatMessage } from "./router";
import type { SharedContextHints, StageName, WorkerInstructions } from "./coordinator";
import type { SessionMemory } from "./session-memory";
import { resolveStagePrompt, stagePromptFile } from "./worker-prompt";
import type { ToolCall, ToolDefinition, ToolResult } from "../tool-types";
import { outcomeCollector } from "../self-tuning/mod";
import type { StageRun } from "../self-tuning/store";
import { countTokens } from "../tokens";
import type { ConductorBus, ConductorDirective } from "./conductor-bus";
import type { ConductorStageEvidence, LiveConductor } from "./conductor";
import { buildSynthesizerContext, buildSynthesizerContextFromStageState } from "./synth-context";
import { detectDeferralStall, DEFERRAL_STALL_NUDGE } from "./synthesizer-deferral";
import { applyEffectGate, buildWriteEffectNudge, evaluateEffectGate, hasRepeatedWriteFailureWithoutEffect, isTerminalNoWriteEffect, mostReadSuccessfulFile, shouldPressWriteEffect, WRITE_EFFECT_NUDGE, WRITE_EFFECT_TOOLS, type EffectGateReport } from "./effect-gate";
import { normalizeRemainingStages, type ExecutionProfile } from "./route-normalization";
import { hasWriteIntent, type TurnRequirement } from "./turn-requirements";
import type { TurnBudget } from "./turn-budget";
import type { PipelineStageState, PlannerStageOutput, ExecutorStageOutput, ReviewerStageOutput, RewriterStageOutput, ToolCallRecord } from "./stage-output";
import {
  DUPLICATE_TOOL_DEFLECTION_MARKER,
  isDuplicateToolDeflection,
  isEmptyStageOutput,
  parseReviewerVerdict,
  renderExecutorSummary,
  renderPlanSummary,
  renderReviewerSummary,
  renderRewriterSummary,
} from "./stage-output";
import {
  alreadyReadSourceKeys,
  assessWorkspaceEvidence,
  DEEP_READ_MIN_CONTENT_READS,
  evidenceFailure,
  extractSourceReadCandidates,
  isDeepReadRequest,
  parseListingEntryNames,
  turnNeedsWorkspaceEvidence,
  workspaceReadScopeViolation,
  type WorkspaceReadScope,
} from "./evidence-sufficiency";
import { substituteToolCall } from "../tool-heal";
import {
  enforceTranscriptBudget,
  EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS,
  EXECUTOR_TOOL_RESULT_CONTEXT_CHARS,
  EXECUTOR_TRANSCRIPT_BUDGET_TOKENS,
  WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS,
  WRITE_TURN_TRANSCRIPT_BUDGET_TOKENS,
  REWRITER_TOOL_RESULT_CONTEXT_CHARS,
  REWRITER_TRANSCRIPT_BUDGET_TOKENS,
  truncateToTokenBudget,
} from "./context-budget";
import { prepareToolResultForContext } from "../tool-result-truncation";
import { findExistingWorkspacePath } from "./workspace-affinity";
import { join } from "path";
import { canApplyConductorReroute, rejectReroute } from "./reroute-policy";
import {
  markPlanItemBlocked,
  resolveDeepReadIntent,
  type TaskRunContract,
  type TaskRunDepth,
} from "./task-run";
import {
  applyInsufficientVerdict,
  applyReviewerAccept,
  applySufficientVerdict,
  decideRepairChain,
  mergeRepairChainIntoRemaining,
  seedTaskPlanFromPlannerProposal,
  type OwnedPlanningAttachment,
} from "./runtime-loop";
import { resolveAllowedRoots } from "../fs-scope";
import {
  ClaudeDelegateAvailabilityCache,
  DelegateHealth,
  delegateEligibility,
  nodeDelegateProcessFactory,
  nodeDelegateSnapshotFactory,
  runClaudeDelegate,
  type RunClaudeDelegateInput,
} from "./claude-delegate";
import type { JarvisConfig } from "../config";

/**
 * The slice of the outcome collector the pipeline depends on. Injecting this
 * (rather than importing the global singleton) lets tests pass an in-memory
 * collector so `bun test` can never pollute the production self-tuning DB.
 */
export interface StageRunRecorder {
  recordStageRun(stage: StageRun): void;
  recordModelAttribution?(row: {
    id: string;
    agent_run_id: string;
    stage_id: string;
    agent_id?: string;
    provider: string;
    model_id: string;
    was_successful: number;
    had_error: number;
    duration_ms?: number;
    first_token_ms?: number;
    fallback_used: number;
  }): void;
}

export interface ExecutorDelegateRuntime {
  availability: { isAvailable(config: JarvisConfig): Promise<boolean> };
  health?: Pick<DelegateHealth, "isAvailable">;
  run(input: Omit<RunClaudeDelegateInput, "health" | "snapshotFactory" | "processFactory"> & {
    onTextDelta?: (text: string) => void;
    onToolUse?: (record: ToolCallRecord) => void;
  }): Promise<ExecutorStageOutput>;
}

const productionDelegateHealth = new DelegateHealth();
export const productionExecutorDelegateRuntime: ExecutorDelegateRuntime = {
  availability: new ClaudeDelegateAvailabilityCache(),
  health: productionDelegateHealth,
  run: (input) => runClaudeDelegate({
    ...input,
    health: productionDelegateHealth,
    snapshotFactory: nodeDelegateSnapshotFactory,
    processFactory: nodeDelegateProcessFactory,
  }),
};

export interface ConductorWiring {
  bus: ConductorBus;
  live: LiveConductor;
  /** Optional collector override; defaults to the global outcome collector. */
  collector?: StageRunRecorder;
  /**
   * After a Claude delegate exits (and releases the GPU), re-warm the local
   * conductor model so the next turn does not hit cold_start_warming. Fire-and-
   * forget; failures are non-fatal.
   */
  reWarmLocalConductor?: () => void;
}

export interface PipelineProgressState {
  stage: "planner" | "executor" | "reviewer" | "rewriter" | "synthesizer" | "conductor_replan";
  status: StageTerminalStatus | "running" | "done";
  output?: string;
  detail?: string;
}

export type StageTerminalStatus = "completed" | "failed" | "timed_out" | "cancelled" | "partial";

export type PipelineTopology = "linear" | "speculative_parallel" | "speculative_cascade" | "recursive";

export interface PipelineExecuteOptions {
  topology?: PipelineTopology;
  maxRecursionDepth?: number;
  /**
   * B-03: starting recursion depth when this `execute()` is itself a
   * recursive re-entry from `applyRecursiveCritique`. The inner pipeline
   * reads `result.recursion_depth ?? 0` to check against the depth cap, so
   * passing the current depth through ensures the shared budget counts
   * ALL re-entries on a turn (planner + executor + conductor_replan),
   * not just the ones inside any single `execute()` call.
   */
  initialRecursionDepth?: number;
  onRecursion?: (event: PipelineRecursionEvent) => void | Promise<void>;
  onDirective?: (directive: ConductorDirective, stage: StageName) => void | Promise<void>;
  /**
   * Least-authority tool profile for the executor/rewriter stages. Set by the
   * route-normalization layer from the turn's capability class. Defaults to
   * `full` so legacy callers are unaffected.
   */
  executionProfile?: ExecutionProfile;
  /** Conductor-generated per-stage instructions; falls back to static prompts when absent. */
  workerInstructions?: WorkerInstructions;
  /** Cross-turn context hints to inject into worker prompts. */
  sharedContext?: SharedContextHints;
  /** Inter-workflow session memory for tool-cache recording and read short-circuit. */
  sessionMemory?: SessionMemory;
  /** Absolute filesystem roots granted by raw user messages for this Session. */
  sessionGrants?: string[];
  /** Promoted distilled skills block for planner/executor injection. */
  distilledSkillsBlock?: string;
  /**
   * Deterministic capability requirement for the raw current turn. The index
   * activation boundary passes the classifier result here so PipelineExecutor
   * can enforce evidence invariants without reclassifying history-augmented
   * request text.
   */
  turnRequirement?: TurnRequirement;
  /** Maximum automatic full-profile review -> rewrite repair rounds. */
  maxReviewRepairRounds?: number;
  /** Raw current user message used for write-intent decisions. */
  rawMessage?: string;
  /**
   * The live turn budget (Task 2.4). When present, the executor reports
   * evidence progress after each turn so a demonstrably-progressing stage
   * earns extra time instead of being starved by the static per-stage
   * budget (25s executor vs a ~52s-p50 free-tier provider pool).
   */
  turnBudget?: TurnBudget;
  /** Replan-loop sets false after caps are exhausted so final synthesis runs. */
  allowMidRunReplan?: boolean;
  /** Effect-gate recovery is deliberately one-shot even when other replans remain. */
  allowEffectGateReplan?: boolean;
  /**
   * 2026-07-18: sticky write intent inherited from the session's active task
   * run. Keeps the executor's write contract, the effect gate, and the
   * file-scale visibility caps armed on mid-task follow-ups ("re-execute",
   * "continue") whose own text names no mutation.
   */
  taskRunWriteIntent?: boolean;
  /** Coordinator-estimated route complexity, used for depth-scaled executor limits. */
  estimatedComplexity?: "low" | "medium" | "high";
  /** Provider/model keys excluded by a bounded alternate-brain executor retry. */
  modelExclusions?: string[];
  /** Internal one-shot guard for high-complexity executor escalation. */
  executorRetryUsed?: boolean;
  /** Persisted task-run depth inherited by terse continuation turns. */
  taskRunDepth?: TaskRunDepth;
  /** Trivial short-circuit turns should use the fastest synthesizer tier. */
  preferFastSynthesizer?: boolean;
  /** Evidence from a previous executor segment being explicitly re-entered. */
  priorToolCalls?: ToolCallRecord[];
  /** Hard user-authored least-authority contract for bounded workspace reads. */
  workspaceReadScope?: WorkspaceReadScope;
  /**
   * Owned-runtime-loop (Task 5): mutable TaskPlan ledger for this turn.
   * Pipeline applies mark_verified / repair-chain / planner-seed mutations
   * and writes back via onTaskPlanUpdate when provided.
   */
  taskRunContract?: TaskRunContract;
  /** Called whenever the pipeline mutates the TaskPlan ledger. */
  onTaskPlanUpdate?: (contract: TaskRunContract) => void;
  /** Planning ownership metadata from Coordinator intake. */
  ownedPlanning?: OwnedPlanningAttachment;
  /** Request-wide cancellation (Stop, disconnect, or supersession). */
  turnAbort?: AbortSignal;
}

// Derived from the capability taxonomy. READ_CACHE_TOOLS is `cacheable`
// (output may be replayed from the per-turn cache); READ_ONLY_TOOLS here is
// `parallel_safe` — the non-mutating batchable set, which is a DIFFERENT
// predicate from modes.ts READ_ONLY_TOOLS (the read_only profile security
// allowlist). Naming both explicitly is the point of the taxonomy.
const READ_CACHE_TOOLS = defaultCapabilityIndex().cacheable;
const READ_ONLY_TOOLS = defaultCapabilityIndex().parallelSafe;
const PIPELINE_TOOL_RESULT_NOTE =
  "Result recorded in full for verification. Re-run the tool with a narrower target if you need the elided middle.";

/**
 * Split a turn's tool calls into dispatch batches (Task 3.1): consecutive
 * read-only calls form one concurrent batch; any write/side-effect call is
 * its own serial barrier, preserving the model's intended ordering for
 * mutations. A model that emits five read_file calls in one turn previously
 * paid five sequential waits.
 */
export function partitionToolCalls<T extends { name: string }>(calls: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const call of calls) {
    if (READ_ONLY_TOOLS.has(call.name)) {
      current.push(call);
    } else {
      if (current.length) batches.push(current);
      batches.push([call]);
      current = [];
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function duplicateToolCallKey(call: Pick<ToolCall, "name" | "arguments">): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

// 2026-07-18: a repeated identical read now REPLAYS the full cached output
// instead of a 500-char preview + lecture. The live incident executor
// legitimately needed the file again to compose an edit, got the lecture,
// and reported "duplicate read-call restriction" as the reason no write
// happened. Serving the cache costs zero tool time, the deflection marker
// still excludes the replay from evidence accounting (so repeat-loops earn
// no progress credit — the 2026-07-12 repetition guard's actual purpose),
// and the per-result context cap bounds what reaches the transcript.
export function duplicateToolCallDeflection(call: ToolCall, firstOutput: string | undefined): ToolResult {
  const previous = firstOutput && firstOutput.trim().length > 0
    ? ` Serving the cached result of that identical call below — do not repeat it again; use offset/limit or a new target for anything more.\n${firstOutput}`
    : "\nchoose a NEW target instead of repeating the same read-only call.";
  return {
    call_id: call.id,
    name: call.name,
    output:
      `${DUPLICATE_TOOL_DEFLECTION_MARKER} ${call.name} was already called with these exact arguments in this executor stage.` +
      previous,
    is_error: false,
    duration_ms: 0,
  };
}

const ANCHOR_FILES = ["package.json", "README.md", "readme.md", "Cargo.toml", "pyproject.toml", "tsconfig.json", "app.json", "go.mod"];

/**
 * Pick which anchor files (from a fixed allowlist of common project-root
 * manifests/docs) actually exist in a directory listing, capped at 5. Used
 * by the deep-read preflight (Task 2.2) to seed the executor with real file
 * contents instead of relying on a weak model to choose the right reads
 * under a tight turn budget.
 */
export function selectAnchorFiles(listingEntries: string[]): string[] {
  const files = new Set(listingEntries.map((e) => e.replace(/[\\/]+$/, "").trim()));
  return ANCHOR_FILES.filter((a) => files.has(a)).slice(0, 5);
}

// parseListingEntryNames lives in evidence-sufficiency.ts (shared with F8
// floor-completion candidate harvest); re-exported for local call sites above.

/**
 * Deterministic, zero-model-cost final answer composed from the evidence a
 * run actually gathered. Used when the synthesizer ends empty or dies at a
 * deadline: shipping the grounded digest beats shipping "(no output)". Live
 * motivation (2026-07-16 PM, session f458849c): three consecutive turns did
 * real tool work — file reads, listings, reviewer feedback — then told the
 * user a transient model issue produced nothing.
 */
export function composeEvidenceFallbackAnswer(state: PipelineStageState): string {
  const calls = (state.executor?.toolCalls ?? []).filter(
    (c) => !c.is_error && c.output.trim().length > 0 && !isDuplicateToolDeflection(c),
  );
  if (calls.length === 0) return "";
  const reads = calls.filter((c) => c.name === "read_file" || c.name === "grep");
  const listings = calls.filter((c) => c.name === "list_directory" || c.name === "glob");
  const other = calls.filter((c) => !reads.includes(c) && !listings.includes(c));
  const target = (c: ToolCallRecord): string => {
    const args = c.arguments as Record<string, unknown> | undefined;
    if (typeof args?.path === "string") return args.path;
    if (typeof args?.pattern === "string") return args.pattern;
    return JSON.stringify(c.arguments ?? {});
  };
  const lines: string[] = [
    "The synthesis model produced no final answer this turn, so here is the evidence that was actually gathered, unsummarized:",
    "",
  ];
  for (const call of reads.slice(0, 6)) {
    lines.push(`### ${call.name}: \`${target(call)}\``, "", "```", call.output.slice(0, 1_500), "```", "");
  }
  if (listings.length > 0) {
    lines.push(
      `**Directories inspected:** ${listings.slice(0, 8).map((c) => `\`${target(c)}\``).join(", ")}`,
      "",
    );
  }
  for (const call of other.slice(0, 3)) {
    lines.push(`**${call.name}** \`${target(call)}\`: ${call.output.slice(0, 300)}`, "");
  }
  const reviewerNotes = state.reviewer?.feedback?.trim();
  if (reviewerNotes && reviewerNotes !== "No review stage executed.") {
    lines.push(`**Reviewer notes:** ${reviewerNotes.slice(0, 600)}`, "");
  }
  lines.push("_Runtime-composed digest (no synthesizer output). A follow-up request continues from this evidence._");
  return lines.join("\n");
}

/**
 * Runway a synthesizer start needs beyond the finalization reserve to
 * survive one stalled first attempt (~leash window) plus one real fallback
 * completion (~25-30s warm). Live basis: session 10cf071d — synthesis
 * starting with 28-40s died three turns in a row; the one turn where it got
 * ~60s+ (run 6b4ab013) produced a full answer.
 */
export const SYNTHESIS_RUNWAY_MS = 30_000;

/**
 * True when the segment loop should stop starting non-synthesizer stages and
 * jump to synthesis: a synthesizer is queued, there is evidence worth
 * synthesizing, and the remaining turn budget is inside the danger zone
 * (finalization reserve + one stall's worth of runway). Pure for testability.
 */
export function shouldCutToSynthesis(args: {
  wantsSynthesizer: boolean;
  hasEvidence: boolean;
  remainingMs: number | undefined;
  reserveMs: number | undefined;
}): boolean {
  if (!args.wantsSynthesizer || !args.hasEvidence) return false;
  if (args.remainingMs === undefined || args.reserveMs === undefined) return false;
  return args.remainingMs <= args.reserveMs + SYNTHESIS_RUNWAY_MS;
}

export function successfulWriteKeys(calls: ToolCallRecord[]): Set<string> {
  return new Set(
    calls
      .filter((call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name))
      .map((call) => `${call.name}:${JSON.stringify(call.arguments)}`),
  );
}

export function addedWriteProgress(before: Set<string>, after: Set<string>): boolean {
  for (const key of after) {
    if (!before.has(key)) return true;
  }
  return false;
}

function isStageTimeout(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
  return /timeout/i.test(name) || /(?:first-token|stream idle|visible-progress|request) timeout/i.test(errText(error));
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return { signal: undefined, dispose: () => {} };
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function parseStreamedToolCall(raw: any): ToolCall {
  const name = raw?.function?.name ?? raw?.name ?? "";
  let args: Record<string, unknown> = {};
  const rawArgs = raw?.function?.arguments ?? raw?.arguments;
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  }
  return {
    id: raw?.id ?? `call_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}

/**
 * Recursion re-enter targets. The critic (recursion-critique.md) may now
 * decide to re-enter any of: `planner` (re-plan with a synthesized brief),
 * `executor` (re-execute / verify / repair), or `conductor_replan` (defer the
 * revision to the conductor's own mid-pipeline replan path — surfaces as a
 * typed event so the SSE relay can render the recurse decision, and the
 * existing `runPipelineWithReplanning` budget applies because the planner
 * re-entry triggers a fresh `coordinator.route()` via the normal route).
 *
 * Track B B-03 (post-phase-4 conductor evolution).
 */
export type RecursionReenterStage = "planner" | "executor" | "conductor_replan";

export interface PipelineRecursionEvent {
  depth: number;
  status: "critique" | "reenter" | "max_depth" | "done" | "failed";
  reenter_stage?: RecursionReenterStage;
  critique?: string;
}

/**
 * Result of a pipeline run. `answer` is the text to surface; `error` is set
 * only when that text is a failure notice rather than a real answer (e.g. the
 * synthesizer threw on a hard auth/network error). Callers MUST check `error`
 * and surface it as an error frame — otherwise a turn-fatal failure looks like
 * a successful (but nonsensical) response, which is exactly how an invalid
 * OpenRouter key used to present as a silent stall.
 */
/**
 * Outcome classification for a pipeline run.
 *   success  — produced a non-empty, validated answer.
 *   degraded — produced an answer but a stage failed / was repaired / empty-and-
 *              recovered along the way (the user still gets a real answer).
 *   failed   — no usable answer (hard error, or every model returned empty).
 */
export type PipelineOutcome = "success" | "degraded" | "failed" | "partial";

export interface PipelineResult {
  answer: string;
  error?: string;
  /** Terminal request cancellation; production maps this to StreamCancelledError. */
  cancelled?: boolean;
  recursion_depth?: number;
  /** Truthful run outcome. Absent is treated as "success" by legacy callers. */
  outcome?: PipelineOutcome;
  /** Machine-readable failure reason (e.g. "empty_completion", "auth_401"). */
  error_code?: string;
  /**
   * Successful/failed tool calls from the final segment's executor stage, if
   * one ran this turn. Populated so callers (the cross-turn no-progress
   * guard in orchestration/repetition-guard.ts) can tell whether a turn
   * gathered any new evidence without re-deriving it from stage state.
   * Undefined/absent when the executor stage never ran (e.g. a
   * conversational turn that only hit the synthesizer, or a speculative
   * topology that has no ToolCallRecord[] to report).
   */
  toolCalls?: ToolCallRecord[];
  /** T2.5: recursive critique asked for conductor replan. */
  replanRequested?: PipelineSegmentResult["replanRequested"];
}

/**
 * Result of running a bounded slice of the pipeline (one or more stages from
 * `{planner, executor, reviewer, rewriter, synthesizer}`). Carries the typed
 * `PipelineStageState` forward so a B-02 replan loop can hand the conductor
 * real findings, not truncated strings. Synthesizer outputs are populated
 * only when `"synthesizer"` was in the segment's `stages` list.
 */
export interface PipelineSegmentResult {
  state: PipelineStageState;
  synthesizerAnswer?: string;
  synthesizerFatalError?: string;
  /** Precise code for a pre-synthesis runtime fence such as missing evidence. */
  fatalErrorCode?: string;
  synthesizerEmptyCompletion?: boolean;
  effectGate?: EffectGateReport;
  partialStage?: { stage: StageName; errorCode: string };
  /**
   * T2.4: mid-run replan request. When set, the replan-loop wrapper should
   * re-route via the conductor (if caps allow) instead of synthesizing.
   */
  replanRequested?: {
    trigger: "reviewer_reject" | "evidence_insufficient" | "executor_hard_failure" | "effect_gate_failure" | "recursive_critique";
    detail: string;
  };
}

/**
 * Safe error-to-string. Thrown values are not always `Error` instances — a
 * streaming/parse path can `throw` a non-Error (or even `undefined`), and a
 * bare `e.message` then crashes the catch block itself with a confusing
 * "undefined is not an object (evaluating 'e.message')" that masks the real
 * failure. Always funnel caught values through this.
 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

/**
 * Turn a raw model/transport error into a user-readable one-liner. Hard auth
 * and quota failures are the common turn-killers and deserve an actionable hint
 * instead of a bare `API 401: {...}` dump.
 */
/** F3: map runtime budget errors onto stage_runs.partial_error_code. */
export function partialErrorCodeForThrowable(error: unknown): "stage_window_exhausted" | "turn_deadline" | null {
  const name = String((error as { name?: unknown } | null | undefined)?.name ?? "");
  if (name === "StageBudgetExhaustedError" || name === "StageDeadlineExceededError") {
    return "stage_window_exhausted";
  }
  if (name === "TurnDeadlineExceededError") return "turn_deadline";
  const msg = errText(error);
  if (/stage budget exhausted|stage deadline exceeded/i.test(msg)) return "stage_window_exhausted";
  if (/total turn deadline/i.test(msg)) return "turn_deadline";
  return null;
}

export function describePipelineError(raw: string): string {
  const msg = raw || "Unknown error";
  if (/\b401\b/.test(msg) || /unauthor/i.test(msg) || /user not found/i.test(msg) || /invalid api key/i.test(msg)) {
    return "Authentication failed (401): the inference provider rejected the API key. Check your OpenRouter API key in Settings.";
  }
  if (/\b403\b/.test(msg) || /forbidden/i.test(msg)) {
    return "Access denied (403): the API key lacks permission for this model. Check your provider plan or model access.";
  }
  if (/\b429\b/.test(msg) || /rate limit/i.test(msg) || /quota/i.test(msg)) {
    return "Rate limited or out of quota (429): the provider is throttling requests or your credit is exhausted. Try again shortly.";
  }
  if (/\b5\d\d\b/.test(msg) || /bad gateway/i.test(msg) || /unavailable/i.test(msg)) {
    return `The inference provider returned a server error. ${msg}`;
  }
  // First-token / inter-token stalls (index.ts's FirstTokenTimeoutError and the
  // stream-idle watchdog) are a hung model, not a user mistake — the bare
  // "First-token timeout (30000ms) on model=..." text read like a crash to
  // operators. Keep the raw message in parens so the detail isn't lost.
  if (/visible output or tool-call progress/i.test(msg)) {
    return `The model kept producing hidden reasoning but made no visible answer or tool-call progress, so I stopped the stalled stage. Try again — the router can pick a different model. (${msg})`;
  }
  if (/total turn deadline|turn_deadline_exceeded/i.test(msg)) {
    return `The server-authoritative turn deadline expired before Jarvis could finish. The turn was stopped cleanly instead of stalling indefinitely. (${msg})`;
  }
  // F3: stage usage budget exhausted while the turn still has time — distinct
  // from total-turn deadline so operators do not chase a false 180s cap.
  if (/stage budget exhausted/i.test(msg)) {
    return `A stage used its full time budget while the overall turn still had time remaining. The runtime stopped that stage cleanly rather than mislabeling a turn deadline. (${msg})`;
  }
  if (/first-token timeout|stream idle timeout/i.test(msg)) {
    return `The answering model stalled before responding, so I aborted it. Try again — the router will pick a different model. (${msg})`;
  }
  // Intra-stream decoding-loop degeneration (index.ts's DegenerateStreamError,
  // driven by stream-degeneration.ts's periodic tail check). A stage-level
  // catch (e.g. the synthesizer) absorbs this the same way it absorbs a
  // first-token/stream-idle timeout, so it needs the same friendly rewrite
  // instead of the bare "Degenerate stream detected on model=..." text.
  if (/degenerate stream detected/i.test(msg)) {
    return `The model got stuck repeating the same phrase instead of producing a real answer, so I stopped the stalled generation. Try again — the router can pick a different model. (${msg})`;
  }
  return msg;
}

function stageSystemPrompt(
  stage: StageName,
  options: PipelineExecuteOptions & { pendingInjections?: Map<StageName, string[]> },
  stageTools: ToolDefinition[] | "host_provided" = [],
): string {
  const skillsBlock = stage === "planner" || stage === "executor"
    ? options.distilledSkillsBlock
    : undefined;
  const injectedNotes = options.pendingInjections?.get(stage);
  // Prompt truth: render the `{{TOOL_GUIDELINES}}` marker (if present) from the
  // exact tools this stage will be given, before conductor/shared-context
  // wrapping. A prompt without the marker is untouched.
  const basePrompt = injectToolGuidelines(loadPrompt(stagePromptFile(stage)), stageTools);
  return resolveStagePrompt(
    stage,
    basePrompt,
    options.workerInstructions,
    options.sharedContext,
    skillsBlock,
    injectedNotes,
  );
}

export class PipelineExecutor {
  private collector: StageRunRecorder;
  private conductor?: ConductorWiring;
  /** One delegate process maximum per logical agent run, including replans. */
  private delegateAttemptedRuns = new Set<string>();

  constructor(
    private callModel: CallModelFn,
    private runtime: ToolRuntime,
    private ctx: ExecutionContext,
    // Injected so tests can supply an in-memory collector. Defaults to the
    // global production singleton for the live runtime. The conductor wiring
    // is deliberately accepted in this slot too for backwards compatibility
    // with the staged live-conductor work; both paths are opt-in.
    collectorOrConductor: StageRunRecorder | ConductorWiring = outcomeCollector,
    private delegateRuntime?: ExecutorDelegateRuntime,
  ) {
    if ("recordStageRun" in collectorOrConductor) {
      this.collector = collectorOrConductor;
    } else {
      this.collector = collectorOrConductor.collector ?? outcomeCollector;
      this.conductor = collectorOrConductor;
    }
  }

  private evidenceRoots(options: PipelineExecuteOptions): string[] {
    return resolveAllowedRoots(this.ctx.config, {
      workspaceOverride: this.ctx.workspace_path,
      sessionGrants: options.sessionGrants ?? this.ctx.session_grants,
    });
  }

  private registerStageAbort(stage: StageName): AbortSignal | undefined {
    if (!this.conductor) return undefined;
    const controller = new AbortController();
    this.conductor.bus.registerAbortHandle(stage, controller);
    return controller.signal;
  }

  private publishStageToken(stage: StageName, chunk: string): void {
    this.conductor?.bus.publishThrottled({
      type: "stage_token",
      stage,
      textDelta: chunk,
      cumulativeLen: chunk.length,
    });
  }

  /**
   * Run live-conductor afterStage and apply abort / inject / reroute effects.
   * T2.2/T2.3: returns the directive so executeSegment can mutate its work queue
   * and pendingInjections. Still fires onDirective + audit for UI/telemetry.
   */
  /** Request/workspace context for planner supervision — never assess against "". */
  private plannerConductorEvidence(
    request: string,
    options: PipelineExecuteOptions,
  ): ConductorStageEvidence {
    return {
      request: options.rawMessage ?? request,
      workspaceRoot: this.ctx.workspace_path || this.ctx.config.jarvis_path || process.cwd(),
      workspaceRoots: this.evidenceRoots(options),
    };
  }

  private async afterConductorStage(
    stage: StageName,
    outcome: "completed" | "failed",
    output: string,
    agentRunId: string,
    options: PipelineExecuteOptions & {
      pendingInjections?: Map<StageName, string[]>;
      /** Mutable remaining work queue for T2.2 reroute application. */
      workQueue?: StageName[];
      /** Reroute apply counter; max 1 per segment. */
      reroutesApplied?: { n: number };
      maxReroutesPerSegment?: number;
    },
    remainingQueue: StageName[],
    evidence?: ConductorStageEvidence,
  ): Promise<ConductorDirective | null> {
    if (!this.conductor) return null;
    let directive: ConductorDirective;
    try {
      // The executor owns the real stage ordering; pass the actual remaining
      // queue so the conductor can avoid work when a stage completed cleanly.
      directive = await this.conductor.live.afterStage(stage, outcome, output, remainingQueue, evidence);
    } catch {
      return null;
    }

    if (directive.type === "abort_stage") {
      this.conductor.bus.resolveAbort(directive.stage);
    }

    // T2.3: apply inject_context into request-scoped pendingInjections.
    if (directive.type === "inject_context" && options.pendingInjections) {
      const list = options.pendingInjections.get(directive.forStage) ?? [];
      if (list.length < 3) {
        list.push(directive.note.slice(0, 600));
        options.pendingInjections.set(directive.forStage, list);
      }
    }

    // F1: deterministic admission before any queue mutation. Model may still
    // *request* an illegal reroute; the runtime refuses and audits it.
    if (directive.type === "reroute") {
      const rejection = rejectReroute({
        triggerStage: stage,
        triggerOutcome: outcome,
        newRemaining: directive.newRemaining,
        reason: directive.reason ?? "",
      });
      if (rejection) {
        console.warn(
          `[Pipeline] reroute rejected after ${stage}: ${rejection} ` +
          `(reason=${(directive.reason ?? "").slice(0, 160)})`,
        );
        const rejected: ConductorDirective = { type: "continue" };
        await options.onDirective?.(rejected, stage);
        const rejectAudit = this.collector as StageRunRecorder & {
          recordDirective?: (row: {
            id: string;
            agent_run_id: string;
            stage: string;
            directive_type: string;
            reason?: string;
            new_remaining_json?: string;
            inject_note?: string;
            inject_for_stage?: string;
          }) => void;
        };
        rejectAudit.recordDirective?.({
          id: `dir_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          stage,
          directive_type: "reroute_rejected",
          reason: `${rejection}: ${directive.reason ?? ""}`.slice(0, 500),
          new_remaining_json: JSON.stringify(directive.newRemaining),
        });
        return rejected;
      }
    }

    // T2.2: apply reroute to the mutable work queue (bounded per segment).
    if (directive.type === "reroute" && options.workQueue) {
      const applied = options.reroutesApplied?.n ?? 0;
      if (!canApplyConductorReroute(applied, options.maxReroutesPerSegment)) {
        console.warn(`[Pipeline] reroute limit reached after ${stage}`);
      } else {
        const requirement = options.turnRequirement ?? "full_execution";
        const normalized = normalizeRemainingStages(directive.newRemaining, requirement, stage);
        if (normalized) {
          options.workQueue.length = 0;
          options.workQueue.push(...normalized);
          if (options.reroutesApplied) options.reroutesApplied.n += 1;
          console.log(`[Pipeline] reroute applied after ${stage}: ${normalized.join("->")}`);
        } else {
          console.warn(`[Pipeline] reroute rejected after ${stage}: empty/invalid remaining`);
        }
      }
    }

    // Owned-runtime-loop (Task 5): apply ledger + queue effects for the
    // extended directive set. Repair-chain stages are injected deterministically
    // — no further Conductor re-decision between Rewriter and Executor.
    if (directive.type === "mark_verified" && options.taskRunContract) {
      try {
        const next = applySufficientVerdict(options.taskRunContract, {
          itemId: directive.itemId,
          gradingMode: directive.gradingMode,
          evidence: {
            ref: directive.evidenceRef,
            summary: directive.evidenceSummary,
          },
        });
        options.taskRunContract = next;
        options.onTaskPlanUpdate?.(next);
        this.conductor?.live.setPlanContext(next);
      } catch (e) {
        console.warn(
          `[Pipeline] mark_verified failed for ${directive.itemId}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (directive.type === "start_repair_chain") {
      if (options.taskRunContract && directive.itemId) {
        try {
          const { contract, decision } = applyInsufficientVerdict(options.taskRunContract, {
            itemId: directive.itemId,
            flaggedIssues: directive.flaggedIssues ?? directive.reason,
            maxRepairCycles: options.maxReviewRepairRounds,
            consecutiveFailures: this.conductor?.live.getConsecutiveToolErrors?.() ?? 0,
          });
          options.taskRunContract = contract;
          options.onTaskPlanUpdate?.(contract);
          this.conductor?.live.setPlanContext(contract);
          if (decision.backstop) {
            console.warn(`[Pipeline] repair-chain backstop for ${directive.itemId}: ${decision.reason}`);
          }
        } catch (e) {
          console.warn(
            `[Pipeline] start_repair_chain ledger update failed: ` +
            `${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (options.workQueue && directive.newRemaining.length > 0) {
        const requirement = options.turnRequirement ?? "full_execution";
        const normalized = normalizeRemainingStages(directive.newRemaining, requirement, stage);
        if (normalized) {
          options.workQueue.length = 0;
          options.workQueue.push(...normalized);
          console.log(
            `[Pipeline] automatic repair chain after ${stage} (no conductor re-decision): ` +
            `${normalized.join("->")}`,
          );
        }
      }
    }

    if (directive.type === "escalate_reviewer" && options.workQueue && directive.newRemaining) {
      const requirement = options.turnRequirement ?? "full_execution";
      const normalized = normalizeRemainingStages(directive.newRemaining, requirement, stage);
      if (normalized) {
        options.workQueue.length = 0;
        options.workQueue.push(...normalized);
        console.log(`[Pipeline] escalate_reviewer after ${stage}: ${normalized.join("->")}`);
      }
    }

    if (directive.type === "block_item" && options.taskRunContract) {
      try {
        const next = markPlanItemBlocked(
          options.taskRunContract,
          directive.itemId,
          directive.reason,
        );
        options.taskRunContract = next;
        options.onTaskPlanUpdate?.(next);
        this.conductor?.live.setPlanContext(next);
      } catch (e) {
        console.warn(
          `[Pipeline] block_item failed for ${directive.itemId}: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Emit even "continue" so the UI/metrics can distinguish an active
    // supervisory decision from a conductor that never ran.
    await options.onDirective?.(directive, stage);
    const audit = this.collector as StageRunRecorder & {
      recordDirective?: (row: {
        id: string;
        agent_run_id: string;
        stage: string;
        directive_type: string;
        reason?: string;
        new_remaining_json?: string;
        inject_note?: string;
        inject_for_stage?: string;
      }) => void;
    };
    const remainingJson =
      directive.type === "reroute" ||
      directive.type === "start_repair_chain" ||
      directive.type === "escalate_reviewer"
        ? JSON.stringify(
            "newRemaining" in directive ? directive.newRemaining : undefined,
          )
        : undefined;
    audit.recordDirective?.({
      id: `dir_${crypto.randomUUID()}`,
      agent_run_id: agentRunId,
      stage,
      directive_type: directive.type,
      reason: "reason" in directive ? directive.reason : undefined,
      new_remaining_json: remainingJson,
      inject_note: directive.type === "inject_context" ? directive.note : undefined,
      inject_for_stage: directive.type === "inject_context" ? directive.forStage : undefined,
    });
    return directive;
  }

  /**
   * Dispatch a turn's tool calls with read-parallelism (Task 3.1): read-only
   * batches run concurrently via Promise.all; writes stay serial barriers in
   * model order. `record` is invoked once per call in the original batch
   * order (deterministic tool_call_id pairing regardless of completion
   * order), after that call's batch has fully settled.
   */
  private async dispatchToolCalls(
    stage: "executor" | "rewriter",
    rawToolCalls: any[],
    options: PipelineExecuteOptions,
    record: (raw: any, call: ToolCall, result: ToolResult) => Promise<void> | void,
    duplicateReadOnlyOutputs?: Map<string, string>,
  ): Promise<void> {
    const parsed = rawToolCalls.map((raw) => {
      const call = parseStreamedToolCall(raw);
      return { raw, call, name: call.name };
    });
    const readOnlyOutputCache = duplicateReadOnlyOutputs;
    const cacheInvalidatingTools = new Set([
      ...WRITE_EFFECT_TOOLS,
      ...this.runtime.listTools()
        .filter((tool) => tool.dangerous)
        .map((tool) => tool.function.name),
    ]);
    for (const batch of partitionToolCalls(parsed)) {
      const settled = await Promise.all(
        batch.map(async (entry) => {
          if (readOnlyOutputCache !== undefined && READ_ONLY_TOOLS.has(entry.call.name)) {
            const duplicateKey = duplicateToolCallKey(entry.call);
            if (readOnlyOutputCache.has(duplicateKey)) {
              return {
                entry,
                result: duplicateToolCallDeflection(entry.call, readOnlyOutputCache.get(duplicateKey)),
                duplicateKey,
                deflected: true,
              };
            }
            readOnlyOutputCache.set(duplicateKey, "");
            const result = await this.runToolCall(entry.raw, options);
            readOnlyOutputCache.set(duplicateKey, toolResultModelText(result));
            return { entry, result, duplicateKey, deflected: false };
          }
          const result = await this.runToolCall(entry.raw, options);
          return { entry, result, duplicateKey: undefined, deflected: false };
        }),
      );
      for (const { entry, result } of settled) {
        this.conductor?.live.onToolResult(
          stage,
          entry.call.name,
          result.is_error,
          toolResultModelText(result).slice(0, 500),
        );
        await record(entry.raw, entry.call, result);
      }
      if (readOnlyOutputCache && settled.some(({ entry, deflected }) => !deflected && cacheInvalidatingTools.has(entry.call.name))) {
        readOnlyOutputCache.clear();
      }
    }
  }

  private async runToolCall(raw: any, options: PipelineExecuteOptions): Promise<ToolResult> {
    const call = parseStreamedToolCall(raw);
    const sessionId = this.ctx.session_id;
    const memory = options.sessionMemory;

    const scopeViolation = workspaceReadScopeViolation(call, options.workspaceReadScope);
    if (scopeViolation) {
      return {
        call_id: call.id,
        name: call.name,
        output: `Scope denied: ${scopeViolation}`,
        is_error: true,
        error: scopeViolation,
        error_code: "policy_denied",
        duration_ms: 0,
      };
    }

    if (memory && sessionId && READ_CACHE_TOOLS.has(call.name)) {
      const cached = memory.lookupCachedToolResult(
        sessionId,
        call.name,
        call.arguments,
        this.ctx.workspace_path,
      );
      if (cached) {
        return {
          call_id: call.id,
          name: call.name,
          output: cached,
          is_error: false,
          duration_ms: 0,
        };
      }
    }

    const result = await this.runtime.execute(call, this.ctx);
    if (memory && sessionId) {
      memory.recordToolResult({
        sessionId,
        toolName: call.name,
        args: call.arguments,
        result,
        workspacePath: this.ctx.workspace_path,
      });
    }
    return result;
  }

  private async runPlannerStage(
    request: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    remainingQueue: StageName[],
  ): Promise<PlannerStageOutput> {
    onStateChange({ stage: "planner", status: "running" });
    const plannerPrompt = stageSystemPrompt("planner", options);
    const startTime = Date.now();
    try {
      const plannerMessages = [
        { role: "system", content: plannerPrompt },
        { role: "user", content: request },
      ] as ChatMessage[];
      const plannerOptions = {
        temperature: BUILTIN_MODES.planner.temperature,
        max_tokens: BUILTIN_MODES.planner.max_tokens,
        stream: true,
        stageLabel: "planner",
        complexity: options.estimatedComplexity,
        advanceOnEmpty: true,
        suppressActivity: true,
        stageAbort: this.registerStageAbort("planner"),
        onChunk: (chunk: string) => {
          onStateChange({ stage: "planner", status: "running", output: chunk });
          this.publishStageToken("planner", chunk);
        },
      };
      let resp = await this.callModel(plannerMessages, plannerOptions);
      // Planner resilience: one fresh callModel invocation lets stage-health
      // cooldowns steer the retry to another candidate. A second empty result
      // degrades to executor-without-plan below; it never requests a replan.
      if (isEmptyStageOutput(resp.content)) {
        resp = await this.callModel(plannerMessages, plannerOptions);
      }
      const narrative = resp.content;
      if (isEmptyStageOutput(narrative)) {
        const errorMessage = "empty_completion";
        onStateChange({ stage: "planner", status: "failed", output: errorMessage });
        // Two empty planner callModel invocations are terminal for this stage.
        // Do not expose this failure to live-conductor queue mutation: a
        // re-enter:planner directive would create a third planner attempt and
        // consume reroute accounting instead of degrading to executor-without-plan.
        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "planner",
          turn_number: 1,
          input_tokens: Math.round((plannerPrompt.length + request.length) / 4),
          output_tokens: 0,
          tool_calls_json: "[]",
          duration_ms: Date.now() - startTime,
          was_successful: 0,
          had_error: 1,
          error_message: errorMessage,
        });
        return { ok: false, narrative: "Failed to generate plan: the planner model returned an empty completion." };
      }
      onStateChange({ stage: "planner", status: "completed", output: narrative });
      await this.afterConductorStage(
        "planner",
        "completed",
        narrative,
        agentRunId,
        options,
        remainingQueue,
        this.plannerConductorEvidence(request, options),
      );

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "planner",
        turn_number: 1,
        input_tokens: Math.round((plannerPrompt.length + request.length) / 4),
        output_tokens: countTokens(narrative),
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 1,
        had_error: 0,
      });
      return { ok: true, narrative };
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "planner", status: "failed", output: message });
      await this.afterConductorStage(
        "planner",
        "failed",
        message,
        agentRunId,
        options,
        remainingQueue,
        this.plannerConductorEvidence(request, options),
      );

      const starvationCode = partialErrorCodeForThrowable(e);
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "planner",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
        stop_reason: starvationCode,
        partial_error_code: starvationCode,
      });
      return { ok: false, narrative: `Failed to generate plan: ${message}` };
    }
  }

  private async runExecutorStage(
    request: string,
    planSummary: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
    remainingQueue: StageName[],
  ): Promise<ExecutorStageOutput> {
    onStateChange({ stage: "executor", status: "running" });
    const priorToolCalls = options.priorToolCalls ?? [];
    const toolCalls: ToolCallRecord[] = [...priorToolCalls];
    const duplicateReadOnlyOutputs = new Map<string, string>();
    for (const call of priorToolCalls) {
      if (
        READ_ONLY_TOOLS.has(call.name) &&
        !call.is_error &&
        call.output.trim().length > 0 &&
        !isDuplicateToolDeflection(call)
      ) {
        duplicateReadOnlyOutputs.set(duplicateToolCallKey(call), call.output);
      }
    }
    const narratives: string[] = [];
    let lastModelKey: string | undefined;
    let turnCount = 0;
    let executorDone = false;
    let workspaceEvidenceNudgeCount = 0;
    let evidenceCountAtLastNudge = 0;
    let writeEffectNudgeCount = 0;
    let repeatedWriteFailureReached = false;
    const intentText = options.rawMessage ?? request;
    const requiresWorkspaceEvidence = turnNeedsWorkspaceEvidence(options.turnRequirement, intentText);
    // 2026-07-17 incident: on live write turns the executor read files and
    // then narrated the change as prose — nothing in the loop demanded an
    // actual mutation (the only nudge was the READ-evidence rubric). Write
    // turns now carry an explicit in-loop write contract. 2026-07-18: the
    // task run's sticky write intent counts too, so "re-execute"/"continue"
    // follow-ups of an implementation task keep the contract even though the
    // follow-up text names no mutation.
    const requiresWriteEffect = profile === "full" &&
      (hasWriteIntent(intentText) || options.taskRunWriteIntent === true);
    // Write turns get file-scale visibility (see context-budget.ts): a model
    // cannot compose a correct edit for code it never saw.
    const toolResultContextChars = requiresWriteEffect
      ? WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS
      : EXECUTOR_TOOL_RESULT_CONTEXT_CHARS;
    const transcriptBudgetTokens = requiresWriteEffect
      ? WRITE_TURN_TRANSCRIPT_BUDGET_TOKENS
      : EXECUTOR_TRANSCRIPT_BUDGET_TOKENS;
    const toolResultNote = requiresWriteEffect
      ? "Call read_file again with offset/limit to view the elided lines BEFORE composing any edit."
      : PIPELINE_TOOL_RESULT_NOTE;
    const successfulWriteCount = () =>
      toolCalls.filter((call) => !call.is_error && WRITE_EFFECT_TOOLS.has(call.name)).length;
    const deepReadRequest = resolveDeepReadIntent(intentText, options.taskRunDepth);
    const executorPrompt = stageSystemPrompt(
      "executor",
      options,
      getToolsForMode("executor", this.runtime.listTools(), profile),
    );
    const executorEvidence = (): ConductorStageEvidence => ({
      toolCalls,
      request: options.rawMessage ?? request,
      workerInstruction: options.workerInstructions?.executor,
      workspaceRoot: this.ctx.workspace_path || this.ctx.config.jarvis_path || process.cwd(),
      workspaceRoots: this.evidenceRoots(options),
      writeIntent: requiresWriteEffect,
    });
    const executorMessages: ChatMessage[] = [
      { role: "system", content: executorPrompt },
      { role: "user", content: `User Request: ${request}\n\nPlan:\n${planSummary}` }
    ];
    if (priorToolCalls.length > 0) {
      const carriedEvidence = truncateToTokenBudget(
        priorToolCalls
          .filter((call) => !call.is_error && !isDuplicateToolDeflection(call))
          .map((call) => `- ${call.name} ${JSON.stringify(call.arguments)}\n${call.output.slice(0, 1200)}`)
          .join("\n\n"),
        3_000,
      );
      if (carriedEvidence.trim()) {
        executorMessages.push({
          role: "user",
          content:
            `[Runtime carried evidence] These results came from an earlier executor segment. ` +
            `Reuse them; do not rediscover the same targets.\n${carriedEvidence}`,
        });
      }
    }
    if (requiresWorkspaceEvidence && deepReadRequest) {
      executorMessages.push({
        role: "user",
        content:
          `[Runtime depth target] Deep-read workspace evidence is required: read at least ${DEEP_READ_MIN_CONTENT_READS} distinct source files before ending the stage; listings/manifests do not count; never repeat a call.`,
      });
    }
    if (requiresWriteEffect) {
      executorMessages.push({
        role: "user",
        content:
          "[Runtime write contract] This is a CHANGE request. The stage is complete only after at least one successful write_file / edit_file / multi_edit / apply_patch call. Read what you need first, then APPLY the change with a tool call and read the file back to verify — code or diffs written as prose do not modify any file.",
      });
    }
    const maxTurns = executorTurnLimit(profile, {
      deepRead: deepReadRequest,
      writeIntent: requiresWriteEffect,
      complexity: options.estimatedComplexity,
    });
    let executorTurn = 0;
    const successfulEvidenceCount = () => toolCalls
      .filter((call) => !call.is_error && call.output.trim().length > 0 && !isDuplicateToolDeflection(call))
      .length;
    const stageCalls = () => toolCalls.slice(priorToolCalls.length);
    const duplicateReadDeflectionCount = () => stageCalls()
      .filter((call) => READ_ONLY_TOOLS.has(call.name) && isDuplicateToolDeflection(call))
      .length;
    const distinctSuccessfulReadCount = () => new Set(
      stageCalls()
        .filter((call) => READ_ONLY_TOOLS.has(call.name) && !call.is_error && call.output.trim().length > 0 && !isDuplicateToolDeflection(call))
        .map((call) => duplicateToolCallKey(call)),
    ).size;
    const mostReadTarget = () => mostReadSuccessfulFile(stageCalls()) ?? "the requested workspace file";
    const availableWriteTools = getToolsForMode("executor", this.runtime.listTools(), profile)
      .map((tool) => tool.function.name)
      .filter((name) => WRITE_EFFECT_TOOLS.has(name));

    const runDelegate = async (nativeNoWrite: boolean): Promise<ExecutorStageOutput | undefined> => {
      const delegateRuntime = this.delegateRuntime;
      if (!delegateRuntime || this.delegateAttemptedRuns.has(agentRunId)) return undefined;
      const allowedRoots = this.evidenceRoots(options);
      const eligibility = delegateEligibility({
        config: this.ctx.config,
        profile,
        writeEffectRequired: requiresWriteEffect,
        nativeNoWrite,
        healthAvailable: delegateRuntime.health?.isAvailable() ?? true,
        allowedRoots,
      });
      if (!eligibility.eligible) {
        return undefined;
      }
      let available = false;
      try {
        available = await delegateRuntime.availability.isAvailable(this.ctx.config);
      } catch {
        // Availability is an optimization boundary, not a reason to fail the
        // native executor. A later replan may probe again because no delegate
        // process was launched.
        return undefined;
      }
      if (!available) return undefined;

      const delegateStart = Date.now();
      const stageId = `stage_${crypto.randomUUID()}`;
      // Do not feed the native executor TOOL_GUIDELINES (canonical names like
      // write_file) into the stock Claude CLI — the CLI already describes its
      // own stock tools (Write/Edit). Teaching both vocabularies is what made
      // the model emit write_file and get policy_denied (F1 / 2026-07-21).
      //
      // "host_provided" (not `[]`): `[]` renders "this stage has no tools
      // available", which is FALSE for the delegate and directly contradicted
      // executor.md's own "You have ALL available tools" opening line plus the
      // tool-by-name behavioral guidance right below it. Every observed
      // delegate_no_write failure showed the model reading a file and then
      // stopping without writing — consistent with a model told it had no
      // write capability (2026-07-21 delegate-reliability investigation).
      const delegateSystemPrompt = stageSystemPrompt("executor", options, "host_provided");
      const prompt = [
        delegateSystemPrompt,
        `User Request: ${request}`,
        `Plan:\n${planSummary}`,
        "[Runtime write contract] This is a CHANGE request. The stage is complete only after you actually invoke a file-writing tool (your environment's Write/Edit or equivalent) and it succeeds — describing the change in your response text does NOT modify any file. Read what you need first, then CALL the write/edit tool now, then read the file back to verify.",
      ].join("\n\n");
      const combinedAbort = combineAbortSignals(
        this.registerStageAbort("executor"),
        options.turnAbort,
      );
      this.delegateAttemptedRuns.add(agentRunId);
      let delegated: ExecutorStageOutput;
      try {
        delegated = await delegateRuntime.run({
          config: this.ctx.config,
          prompt,
          sessionId: this.ctx.session_id ?? `delegate_${crypto.randomUUID()}`,
          allowedRoots,
          stageRemainingMs: options.turnBudget?.stageRemainingMs("executor")
            ?? this.ctx.config.claude_cli.delegate.timeout_ms,
          profile,
          writeEffectRequired: requiresWriteEffect,
          nativeNoWrite,
          signal: combinedAbort.signal,
          onTextDelta: (chunk) => {
            onStateChange({ stage: "executor", status: "running", output: chunk });
            this.publishStageToken("executor", chunk);
          },
          onToolUse: (record) => {
            onStateChange({
              stage: "executor",
              status: "running",
              output: `\n[Tool Executed: ${record.name}]\n`,
              detail: `tool:${record.name}`,
            });
          },
        });
      } catch (error) {
        const cancelled = combinedAbort.signal?.aborted === true;
        delegated = {
          ok: false,
          narrative: cancelled
            ? "Claude delegate cancelled."
            : `Claude delegate integration failed: ${errText(error)}`,
          terminalStatus: cancelled ? "cancelled" : "failed",
          errorCode: cancelled ? "delegate_aborted" : "delegate_integration_error",
          toolCalls: [],
        };
      } finally {
        combinedAbort.dispose();
        // Delegate unload frees GPU VRAM; re-warm the local conductor so the
        // next turn does not sit in the multi-minute cold window (F2).
        try {
          this.conductor?.reWarmLocalConductor?.();
        } catch {
          // Fire-and-forget; re-warm is best-effort.
        }
      }
      const cleanupUnconfirmed = delegated.errorCode === "delegate_cleanup_unconfirmed"
        || delegated.toolCalls.some((call) => call.name === "delegate_cleanup" && call.is_error);
      // Normalize safety-critical process state before telemetry so persisted
      // rows and the public executor result describe the same terminal fact.
      if (cleanupUnconfirmed) {
        delegated = {
          ...delegated,
          ok: false,
          terminalStatus: "failed",
          errorCode: "delegate_cleanup_unconfirmed",
        };
      }
      const hasVerifiedWrite = delegated.toolCalls.some(
        (call) => WRITE_EFFECT_TOOLS.has(call.name) && !call.is_error,
      );
      // Filesystem evidence is ground truth. If a delegate mutates the
      // workspace and only then times out/cancels, falling back to native can
      // duplicate a non-idempotent write. A verified write therefore closes
      // the executor stage regardless of the process's later terminal status.
      const cancelled = delegated.terminalStatus === "cancelled";
      const accepted = hasVerifiedWrite && !cleanupUnconfirmed;
      const stageSucceeded = accepted && !cancelled;
      const willRunNativeFallback = !accepted && !cancelled && !cleanupUnconfirmed;
      const downgradeCode = cleanupUnconfirmed
        ? "delegate_cleanup_unconfirmed"
        : delegated.errorCode
          ?? (cancelled ? "delegate_aborted" : hasVerifiedWrite ? undefined : "delegate_no_write");
      this.collector.recordStageRun({
        id: stageId,
        agent_run_id: agentRunId,
        mode_id: "executor",
        turn_number: 1,
        input_tokens: Math.round(prompt.length / 4),
        output_tokens: countTokens(delegated.narrative),
        tool_calls_json: JSON.stringify(delegated.toolCalls),
        duration_ms: Date.now() - delegateStart,
        was_successful: stageSucceeded ? 1 : 0,
        had_error: stageSucceeded ? 0 : 1,
        error_message: stageSucceeded ? undefined : downgradeCode,
        stop_reason: stageSucceeded ? "completed" : delegated.terminalStatus,
        partial_error_code: stageSucceeded ? undefined : downgradeCode,
      });
      this.collector.recordModelAttribution?.({
        id: `attr_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        stage_id: stageId,
        agent_id: "claude_delegate",
        provider: "claude_cli",
        model_id: this.ctx.config.claude_cli.delegate.model.trim()
          || this.ctx.config.claude_cli.model?.trim()
          || "claude_cli",
        was_successful: stageSucceeded ? 1 : 0,
        had_error: stageSucceeded ? 0 : 1,
        duration_ms: Date.now() - delegateStart,
        fallback_used: nativeNoWrite || willRunNativeFallback ? 1 : 0,
      });

      toolCalls.push(...delegated.toolCalls);
      if (cleanupUnconfirmed) {
        const unsafeOutput: ExecutorStageOutput = { ...delegated, toolCalls };
        onStateChange({
          stage: "executor",
          status: "failed",
          output: delegated.narrative,
          detail: "delegate_cleanup_unconfirmed",
        });
        return unsafeOutput;
      }
      if (cancelled) {
        const cancelledOutput: ExecutorStageOutput = { ...delegated, toolCalls };
        onStateChange({
          stage: "executor",
          status: "cancelled",
          output: delegated.narrative,
          detail: delegated.errorCode,
        });
        return cancelledOutput;
      }
      if (!accepted) {
        onStateChange({
          stage: "executor",
          status: "running",
          output: delegated.narrative,
          detail: `delegate_fallback:${downgradeCode ?? "delegate_failed"}`,
        });
        const carried = delegated.toolCalls
          .map((call) => `- ${call.name} ${JSON.stringify(call.arguments)}\n${call.output}`)
          .join("\n\n");
        for (const call of delegated.toolCalls) {
          if (
            READ_ONLY_TOOLS.has(call.name)
            && !call.is_error
            && call.output.trim().length > 0
            && !isDuplicateToolDeflection(call)
          ) {
            duplicateReadOnlyOutputs.set(duplicateToolCallKey(call), call.output);
          }
        }
        executorMessages.push({
          role: "user",
          content: `[Runtime delegate evidence] The delegate did not produce a verified write. Preserve this evidence and make one native attempt; do not delegate again.\n${carried}`,
        });
        return undefined;
      }

      const acceptedOutput: ExecutorStageOutput = {
        ...delegated,
        ok: true,
        terminalStatus: "completed",
        errorCode: undefined,
        toolCalls,
      };
      onStateChange({ stage: "executor", status: "completed", output: delegated.narrative });
      await this.afterConductorStage(
        "executor", "completed", delegated.narrative, agentRunId, options, remainingQueue, executorEvidence(),
      );
      return acceptedOutput;
    };

    if (
      this.delegateRuntime
      && this.ctx.config.claude_cli?.delegate?.policy === "delegate_first"
    ) {
      const delegated = await runDelegate(false);
      if (delegated) return delegated;
    }

    // Explicit bounded-read fast path. The user has already chosen the exact
    // filesystem authority, so a free-form executor model can add no useful
    // discovery and can only widen scope. Execute the root listing + concrete
    // allowlist deterministically, then hand that canonical ledger directly to
    // the synthesizer. This removes multiple model round-trips and makes the
    // runtime, not prompt obedience, the scope enforcement boundary.
    if (options.workspaceReadScope?.explicit) {
      const scopedStart = Date.now();
      const scope = options.workspaceReadScope;
      const workspaceRoot = scope.workspaceRoot ||
        this.ctx.workspace_path || this.ctx.config.jarvis_path || process.cwd();
      const startIdx = toolCalls.length;
      let rootListingOutput = "";

      const executeScoped = async (call: ToolCall): Promise<ToolResult> => {
        const result = await this.runToolCall(call, options);
        const output = toolResultModelText(result);
        toolCalls.push({
          name: call.name,
          arguments: call.arguments,
          output,
          is_error: result.is_error,
          error_code: result.error_code,
          duration_ms: result.duration_ms ?? 0,
        });
        onStateChange({
          stage: "executor",
          status: "running",
          output: `\n[Tool Executed: ${call.name}]\n`,
          detail: `tool:${call.name}`,
        });
        return result;
      };

      if (scope.allowRootListing) {
        const listResult = await executeScoped({
          id: `call_${crypto.randomUUID()}`,
          name: "list_directory",
          arguments: { path: workspaceRoot },
        });
        rootListingOutput = toolResultModelText(listResult);
      }

      for (const allowedPath of scope.allowedPaths) {
        const basename = allowedPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
        const optionalAndAbsent = scope.optionalPaths.includes(allowedPath)
          && rootListingOutput.trim().length > 0
          && !rootListingOutput.toLowerCase().includes(basename);
        if (optionalAndAbsent) continue;
        const resolvedPath = /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(allowedPath)
          ? allowedPath
          : join(workspaceRoot, allowedPath);
        await executeScoped({
          id: `call_${crypto.randomUUID()}`,
          name: "read_file",
          arguments: { path: resolvedPath },
        });
      }

      const scopedCalls = toolCalls.slice(startIdx);
      const assessment = assessWorkspaceEvidence(
        toolCalls,
        intentText,
        workspaceRoot,
        {},
        deriveEvidenceTaskKind(options.rawMessage ?? intentText),
      );
      const ledger = scopedCalls
        .map((call) => `- ${call.name} ${JSON.stringify(call.arguments)}: ${call.is_error ? "FAILED" : "SUCCEEDED"}`)
        .join("\n");
      const narrative = [
        "Deterministic explicit-scope execution complete.",
        "Only the calls in this executed-tool ledger ran; requested or planned files outside it were not inspected:",
        ledger || "- No tools executed.",
        `Scope result: ${assessment.reason}.`,
      ].join("\n");
      const firstError = scopedCalls.find((call) => call.is_error);
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "executor",
        turn_number: 1,
        input_tokens: 0,
        output_tokens: countTokens(narrative),
        tool_calls_json: JSON.stringify(scopedCalls.map((call) => ({ name: call.name, arguments: call.arguments }))),
        duration_ms: Date.now() - scopedStart,
        was_successful: assessment.sufficient && !firstError ? 1 : 0,
        had_error: assessment.sufficient && !firstError ? 0 : 1,
        error_message: firstError?.output ?? (assessment.sufficient ? undefined : assessment.reason),
      });

      if (!assessment.sufficient) {
        const failure = evidenceFailure(assessment);
        onStateChange({ stage: "executor", status: "failed", output: failure.message, detail: "explicit_scope_incomplete" });
        await this.afterConductorStage("executor", "failed", narrative, agentRunId, options, remainingQueue, executorEvidence());
        return { ok: false, narrative: failure.message, toolCalls };
      }

      onStateChange({ stage: "executor", status: "completed", output: narrative, detail: "explicit_scope_complete" });
      await this.afterConductorStage("executor", "completed", narrative, agentRunId, options, remainingQueue, executorEvidence());
      return { ok: true, narrative, toolCalls };
    }

    // Git/SHA requests are deterministic read-only metadata requests. Some
    // text-protocol providers decline to emit a tool block even after the
    // runtime advertises one, so seed the executor with the constrained
    // capability's real result. This is still scoped to workspace_read and
    // never falls back to arbitrary shell execution.
    if (
      requiresWorkspaceEvidence
      && /\b(git|sha|commit|branch|dirty)\b/i.test(request)
      && this.runtime.listTools().some((tool) => tool.function.name === "git_metadata")
    ) {
      const preflightCall: ToolCall = {
        id: `call_${crypto.randomUUID()}`,
        name: "git_metadata",
        arguments: { include: ["head", "branch", "dirty"] },
      };
      const preflightResult = await this.runToolCall(preflightCall, options);
      const preflightOutput = toolResultModelText(preflightResult);
      toolCalls.push({
        name: preflightCall.name,
        arguments: preflightCall.arguments,
        output: preflightOutput,
        is_error: preflightResult.is_error,
        error_code: preflightResult.error_code,
        duration_ms: preflightResult.duration_ms ?? 0,
      });
      executorMessages.push({
        role: "user",
        content: `[Runtime preflight: git_metadata]\n${prepareToolResultForContext(preflightOutput, EXECUTOR_TOOL_RESULT_CONTEXT_CHARS, PIPELINE_TOOL_RESULT_NOTE).context}\nUse this exact metadata in your answer; do not claim the tool is unavailable.`,
      });
      onStateChange({
        stage: "executor",
        status: "running",
        output: "\n[Tool Executed: git_metadata]\n",
        detail: "tool:git_metadata",
      });
    }

    // Task 2.2: deep-read requests (e.g. "comprehensively diagnose this
    // repo") are the upstream cause of the 2026-07-12 incident -- a weak
    // executor model, under a tight turn-budget clock, chose a single
    // top-level list_directory and then narrated prose instead of reading
    // real files. Task 2.1 already fenced the downstream symptom (a lone
    // list_directory no longer satisfies evidence sufficiency for these
    // requests); this seeds the executor's conversation with a real
    // directory listing plus a few anchor files already read, so the model
    // starts grounded instead of needing to choose the right tool sequence
    // itself.
    if (
      requiresWorkspaceEvidence
      && deepReadRequest
      && this.runtime.listTools().some((tool) => tool.function.name === "list_directory")
    ) {
      // Mirrors fs-scope.ts's effectiveWorkspaceRoot() fallback chain so the
      // preflight always has a real root to join anchor paths against, even
      // when the caller's ExecutionContext omits workspace_path (it's
      // optional -- tool handlers themselves fall back the same way).
      const preflightRoot =
        findExistingWorkspacePath(request) || this.ctx.workspace_path || this.ctx.config.jarvis_path || process.cwd();
      const listCall: ToolCall = {
        id: `call_${crypto.randomUUID()}`,
        name: "list_directory",
        arguments: { path: preflightRoot },
      };
      const listResult = await this.runToolCall(listCall, options);
      const listOutput = toolResultModelText(listResult);
      toolCalls.push({
        name: listCall.name,
        arguments: listCall.arguments,
        output: listOutput,
        is_error: listResult.is_error,
        error_code: listResult.error_code,
        duration_ms: listResult.duration_ms ?? 0,
      });
      executorMessages.push({
        role: "user",
        content: `[Runtime preflight: list_directory]\n${prepareToolResultForContext(listOutput, EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS, PIPELINE_TOOL_RESULT_NOTE).context}`,
      });
      onStateChange({
        stage: "executor",
        status: "running",
        output: "\n[Tool Executed: list_directory]\n",
        detail: "tool:list_directory",
      });

      // A failed listing must never block the turn -- record it and fall
      // through to the normal executor loop rather than attempting anchor
      // reads against a root that couldn't even be listed.
      if (!listResult.is_error) {
        const anchors = selectAnchorFiles(parseListingEntryNames(listOutput));
        for (const anchor of anchors) {
          const anchorPath = join(preflightRoot, anchor);
          const readCall: ToolCall = {
            id: `call_${crypto.randomUUID()}`,
            name: "read_file",
            arguments: { path: anchorPath },
          };
          // Each anchor read tolerates its own failure (e.g. a permissions
          // error on one file) -- record it and continue to the next anchor
          // instead of aborting the whole preflight.
          const readResult = await this.runToolCall(readCall, options);
          const readOutput = toolResultModelText(readResult);
          toolCalls.push({
            name: readCall.name,
            arguments: readCall.arguments,
            output: readOutput,
            is_error: readResult.is_error,
            error_code: readResult.error_code,
            duration_ms: readResult.duration_ms ?? 0,
          });
          executorMessages.push({
            role: "user",
            content: `[Runtime preflight: read_file ${anchor}]\n${prepareToolResultForContext(readOutput, EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS, PIPELINE_TOOL_RESULT_NOTE).context}`,
          });
          onStateChange({
            stage: "executor",
            status: "running",
            output: "\n[Tool Executed: read_file]\n",
            detail: "tool:read_file",
          });
        }

        // F4: if anchors were only manifests/docs (0 floor-countable source
        // reads), list one src/lib/app directory and read its first source file
        // so preflight contributes ≥1 deep-read floor count.
        const preflightAssessment = assessWorkspaceEvidence(
          toolCalls,
          intentText,
          preflightRoot,
          {},
          deriveEvidenceTaskKind(options.rawMessage ?? intentText),
        );
        if (deepReadRequest && preflightAssessment.contentReads === 0) {
          const rootEntries = parseListingEntryNames(listOutput);
          const nestedDir = rootEntries.find((entry) =>
            /^(src|lib|app)[\\/]*$/i.test(entry.replace(/[\\/]+$/, "")),
          );
          if (nestedDir) {
            const nestedPath = join(preflightRoot, nestedDir.replace(/[\\/]+$/, ""));
            const nestedListCall: ToolCall = {
              id: `call_${crypto.randomUUID()}`,
              name: "list_directory",
              arguments: { path: nestedPath },
            };
            const nestedListResult = await this.runToolCall(nestedListCall, options);
            const nestedListOutput = toolResultModelText(nestedListResult);
            toolCalls.push({
              name: nestedListCall.name,
              arguments: nestedListCall.arguments,
              output: nestedListOutput,
              is_error: nestedListResult.is_error,
              error_code: nestedListResult.error_code,
              duration_ms: nestedListResult.duration_ms ?? 0,
            });
            executorMessages.push({
              role: "user",
              content: `[Runtime preflight: list_directory ${nestedDir}]\n${prepareToolResultForContext(nestedListOutput, EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS, PIPELINE_TOOL_RESULT_NOTE).context}`,
            });
            onStateChange({
              stage: "executor",
              status: "running",
              output: "\n[Tool Executed: list_directory]\n",
              detail: "tool:list_directory",
            });
            if (!nestedListResult.is_error) {
              const firstSource = parseListingEntryNames(nestedListOutput).find((entry) => {
                const base = entry.split(/[\\/]/).pop() ?? entry;
                const dot = base.lastIndexOf(".");
                if (dot <= 0) return false;
                return [
                  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".kt", ".swift",
                ].includes(base.slice(dot).toLowerCase());
              });
              if (firstSource) {
                const sourcePath = join(nestedPath, firstSource);
                const sourceRead: ToolCall = {
                  id: `call_${crypto.randomUUID()}`,
                  name: "read_file",
                  arguments: { path: sourcePath },
                };
                const sourceResult = await this.runToolCall(sourceRead, options);
                const sourceOutput = toolResultModelText(sourceResult);
                toolCalls.push({
                  name: sourceRead.name,
                  arguments: sourceRead.arguments,
                  output: sourceOutput,
                  is_error: sourceResult.is_error,
                  error_code: sourceResult.error_code,
                  duration_ms: sourceResult.duration_ms ?? 0,
                });
                executorMessages.push({
                  role: "user",
                  content: `[Runtime preflight: read_file ${firstSource}]\n${prepareToolResultForContext(sourceOutput, EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS, PIPELINE_TOOL_RESULT_NOTE).context}`,
                });
                onStateChange({
                  stage: "executor",
                  status: "running",
                  output: "\n[Tool Executed: read_file]\n",
                  detail: "tool:read_file",
                });
              }
            }
          }
        }

        executorMessages.push({
          role: "user",
          content:
            "[Runtime preflight] The listing and anchor files above are already read. Continue by reading the specific source files needed to answer; do not re-list the root.",
        });
      }
    }

    try {
      while (!executorDone && turnCount < maxTurns) {
        turnCount++;
        executorTurn++;
        const turnStartTime = Date.now();
        const turnStartIdx = toolCalls.length;
        let response: any;

        try {
          const transcriptBudget = enforceTranscriptBudget(executorMessages, transcriptBudgetTokens);
          if (transcriptBudget.evicted > 0) {
            onStateChange({
              stage: "executor",
              status: "running",
              detail: `context_evicted:${transcriptBudget.evicted}`,
            });
          }
          const inputTokens = transcriptBudget.inputTokens;
          response = await this.callModel(executorMessages, {
            temperature: BUILTIN_MODES.executor.temperature,
            // Write turns may emit a whole-file write_file payload; the 4096
            // default truncates anything past ~16KB of content (2026-07-18).
            max_tokens: requiresWriteEffect ? 8192 : BUILTIN_MODES.executor.max_tokens,
            tools: getToolsForMode("executor", this.runtime.listTools(), profile),
            stream: true,
            stageLabel: "executor",
            complexity: options.estimatedComplexity,
            preferStrongModel: options.executorRetryUsed === true,
            excludeModels: options.modelExclusions,
            suppressActivity: true,
            stageAbort: this.registerStageAbort("executor"),
            onChunk: (chunk) => {
              onStateChange({ stage: "executor", status: "running", output: chunk });
              this.publishStageToken("executor", chunk);
            }
          });
          if (response?._provider && response?._modelUsed) {
            lastModelKey = `${response._provider}:${response._modelUsed}`;
          }

          executorMessages.push({ role: "assistant", content: response.content, tool_calls: response.tool_calls });
          if (response.content) narratives.push(response.content);

          const emittedToolCalls = Boolean(response.tool_calls && response.tool_calls.length > 0);
          if (emittedToolCalls) {
            await this.dispatchToolCalls("executor", response.tool_calls, options, async (tc, call, toolResult) => {
              toolCalls.push({
                name: call.name,
                arguments: call.arguments,
                output: toolResultModelText(toolResult),
                is_error: toolResult.is_error,
                error_code: toolResult.error_code,
                duration_ms: toolResult.duration_ms ?? 0,
              });
              executorMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: tc.name,
                content: prepareToolResultForContext(
                  toolResultModelText(toolResult),
                  toolResultContextChars,
                  toolResultNote,
                ).context,
              });
              onStateChange({
                stage: "executor",
                status: "running",
                output: `\n[Tool Executed: ${tc.name}]\n`
              });
              // Task 2.3: when a failed call has an unambiguous correct
              // alternative (read_file on a directory -> list_directory),
              // execute the substitute immediately instead of spending a
              // full model round-trip on the healing hint. The original
              // failed call stays recorded above so evidence accounting
              // and telemetry still see the model's actual behavior.
              if (toolResult.is_error) {
                const sub = substituteToolCall(call.name, call.arguments, toolResultModelText(toolResult));
                if (sub) {
                  const subCall: ToolCall = {
                    id: `call_${crypto.randomUUID()}`,
                    name: sub.name,
                    arguments: sub.arguments,
                  };
                  const subResult = await this.runToolCall(subCall, options);
                  const subOutput = toolResultModelText(subResult);
                  toolCalls.push({
                    name: subCall.name,
                    arguments: subCall.arguments,
                    output: subOutput,
                    is_error: subResult.is_error,
                    error_code: subResult.error_code,
                    duration_ms: subResult.duration_ms ?? 0,
                  });
                  executorMessages.push({
                    role: "user",
                    content: `[Runtime substitution] ${sub.note}:\n${prepareToolResultForContext(subOutput, toolResultContextChars, toolResultNote).context}`,
                  });
                  onStateChange({
                    stage: "executor",
                    status: "running",
                    output: `\n[Tool Substituted: ${sub.name}]\n`,
                    detail: `tool:${sub.name}`,
                  });
                }
              }
            }, duplicateReadOnlyOutputs);
          }

          // Task 2.4: a turn that added new successful evidence earns the
          // executor more budget (bounded inside extendStageOnProgress), so
          // a deep read on a slow provider isn't cut off mid-progress while
          // a stalled executor still hits the original tight deadline.
          const evidenceAddedThisTurn = toolCalls
            .slice(turnStartIdx)
            .filter((call) => !call.is_error && call.output.trim().length > 0 && !isDuplicateToolDeflection(call))
            .length;
          options.turnBudget?.extendStageOnProgress("executor", evidenceAddedThisTurn);

          // A first failed mutation remains recoverable inside this executor
          // loop. A second verified failure with zero successful mutations is
          // the bounded honesty fence: stop spending model turns and let the
          // segment return the typed no-write outcome before replan/review.
          repeatedWriteFailureReached = hasRepeatedWriteFailureWithoutEffect(
            toolCalls,
            requiresWriteEffect,
          );
          if (repeatedWriteFailureReached) {
            executorDone = true;
            narratives.push(
              "Execution stopped after two failed mutation attempts with zero successful file mutations.",
            );
          }

          // A workspace-evidence stage is not grounded merely because an
          // executor model produced prose. Give it a bounded repair nudge.
          // The first nudge can fire on zero evidence; the second only fires
          // after the previous nudge produced new successful evidence, so a
          // refusing model cannot spin indefinitely.
          const assessmentAfterTurn = assessWorkspaceEvidence(
            toolCalls,
            intentText,
            this.evidenceRoots(options),
            {},
            deriveEvidenceTaskKind(options.rawMessage ?? intentText),
          );
          let workspaceEvidenceNudgeSentThisTurn = false;
          if (
            requiresWorkspaceEvidence &&
            !assessmentAfterTurn.sufficient &&
            workspaceEvidenceNudgeCount < 2 &&
            turnCount < maxTurns
          ) {
            const evidenceNow = successfulEvidenceCount();
            const mayNudge =
              workspaceEvidenceNudgeCount === 0 ||
              evidenceNow > evidenceCountAtLastNudge;
            if (mayNudge) {
              workspaceEvidenceNudgeCount++;
              evidenceCountAtLastNudge = evidenceNow;
              workspaceEvidenceNudgeSentThisTurn = true;
              executorMessages.push({
                role: "user",
                content:
                  `Workspace evidence is required for this turn. ${assessmentAfterTurn.reason}. Call the relevant read-only workspace tools (read_file, list_directory, glob, or grep) and ground your findings in their results before answering.` +
                  (requiresWriteEffect
                    ? " This is ALSO a change request: after reading, apply the requested change with write_file/edit_file/multi_edit/apply_patch."
                    : ""),
              });
            }
          }

          // Write pressure (2026-07-17): the model is about to end a
          // full-profile change turn with zero successful mutations. Press it
          // (bounded) to actually call a write tool instead of accepting the
          // prose ending — but never into a nearly-exhausted stage window.
          let writeEffectNudgeSentThisTurn = false;
          if (
            !repeatedWriteFailureReached &&
            (options.turnBudget?.stageRemainingMs("executor") ?? Number.POSITIVE_INFINITY) > 8_000 &&
            shouldPressWriteEffect({
              writeIntent: requiresWriteEffect,
              profile,
              successfulWrites: successfulWriteCount(),
              toolCallsEmitted: emittedToolCalls,
              duplicateReadDeflections: duplicateReadDeflectionCount(),
              distinctSuccessfulReads: distinctSuccessfulReadCount(),
              nudgesSent: writeEffectNudgeCount,
              turnCount,
              maxTurns,
            })
          ) {
            writeEffectNudgeCount++;
            writeEffectNudgeSentThisTurn = true;
            executorMessages.push({
              role: "user",
              content: emittedToolCalls
                ? buildWriteEffectNudge(availableWriteTools, mostReadTarget())
                : WRITE_EFFECT_NUDGE,
            });
          }

          if (!emittedToolCalls && !workspaceEvidenceNudgeSentThisTurn && !writeEffectNudgeSentThisTurn) {
            executorDone = true;
          }

          const turnToolErrors = toolCalls.slice(turnStartIdx).filter((call) => call.is_error);
          // This row represents the model/tool-call turn, not the final
          // workspace-evidence verdict. A successful read is not a model error
          // merely because the deep-read floor still needs another file.
          const turnHadToolError = turnToolErrors.length > 0;
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "executor",
            turn_number: executorTurn,
            input_tokens: inputTokens,
            output_tokens: countTokens(response?.content || ""),
            tool_calls_json: JSON.stringify(response?.tool_calls || []),
            duration_ms: Date.now() - turnStartTime,
            was_successful: turnHadToolError ? 0 : 1,
            had_error: turnHadToolError ? 1 : 0,
            error_message: turnToolErrors[0]
              ? `${turnToolErrors[0].name}: ${(turnToolErrors[0].output || "").slice(0, 200)}`
              : undefined,
          });
        } catch (err: any) {
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "executor",
            turn_number: executorTurn,
            tool_calls_json: "[]",
            duration_ms: Date.now() - turnStartTime,
            was_successful: 0,
            had_error: 1,
            error_message: errText(err),
          });
          if (isStageTimeout(err) && successfulEvidenceCount() > 0) {
            executorDone = true;
            narratives.push(
              `Executor request timed out after gathering ${successfulEvidenceCount()} successful evidence result(s); continuing with gathered evidence.`,
            );
            break;
          }
          throw err;
        }
      }

      const narrative = narratives.join("\n\n");
      const workspaceRoot =
        this.ctx.workspace_path || this.ctx.config.jarvis_path || process.cwd();

      // F8: deterministic floor-completion — when the model stopped short of
      // the deep-read floor, read plan-named + listing-derived source files
      // without another replan cycle.
      if (requiresWorkspaceEvidence && deepReadRequest && executorDone) {
        let floorAssessment = assessWorkspaceEvidence(
          toolCalls,
          intentText,
          this.evidenceRoots(options),
          {},
          deriveEvidenceTaskKind(options.rawMessage ?? intentText),
        );
        if (!floorAssessment.sufficient) {
          const already = alreadyReadSourceKeys(toolCalls, workspaceRoot);
          const listingCalls = toolCalls.filter(
            (call) => call.name === "list_directory" && !call.is_error && call.output.trim().length > 0,
          );
          const planText = [
            planSummary,
            options.workerInstructions?.executor ?? "",
            options.rawMessage ?? request,
          ].join("\n");
          const candidates = extractSourceReadCandidates(
            planText,
            listingCalls,
            workspaceRoot,
            already,
          );
          const toRead = Math.min(
            4,
            Math.max(0, DEEP_READ_MIN_CONTENT_READS - floorAssessment.contentReads + 1),
          );
          let completed = 0;
          for (const candidate of candidates) {
            if (completed >= toRead) break;
            if (
              options.turnBudget &&
              options.turnBudget.stageRemainingMs("executor") <= 5_000
            ) {
              break;
            }
            const readCall: ToolCall = {
              id: `call_${crypto.randomUUID()}`,
              name: "read_file",
              arguments: { path: candidate },
            };
            const readResult = await this.runToolCall(readCall, options);
            const readOutput = toolResultModelText(readResult);
            toolCalls.push({
              name: readCall.name,
              arguments: readCall.arguments,
              output: readOutput,
              is_error: readResult.is_error,
              error_code: readResult.error_code,
              duration_ms: readResult.duration_ms ?? 0,
            });
            executorMessages.push({
              role: "user",
              content: `[Runtime floor-completion: read_file ${candidate}]\n${prepareToolResultForContext(readOutput, EXECUTOR_PREFLIGHT_RESULT_CONTEXT_CHARS, PIPELINE_TOOL_RESULT_NOTE).context}`,
            });
            onStateChange({
              stage: "executor",
              status: "running",
              output: "\n[Tool Executed: read_file]\n",
              detail: "tool:read_file",
            });
            if (!readResult.is_error && readOutput.trim().length > 0) completed += 1;
          }
        }
      }

      // Escalation deliberately runs only after the native executor has
      // completed one bounded pass with zero successful mutations. Whether
      // the delegate succeeds or fails, this stage never bounces back into a
      // second native pass.
      if (
        this.delegateRuntime
        && this.ctx.config.claude_cli?.delegate?.policy === "escalation"
        && successfulWriteCount() === 0
      ) {
        const delegated = await runDelegate(true);
        if (delegated) return delegated;
      }

      const finalAssessment = assessWorkspaceEvidence(
        toolCalls,
        intentText,
        this.evidenceRoots(options),
        {},
        deriveEvidenceTaskKind(options.rawMessage ?? intentText),
      );
      if (repeatedWriteFailureReached) {
        const message = "Repeated write attempts failed; zero file mutations succeeded.";
        const failedNarrative = [narrative, message].filter(Boolean).join("\n\n");
        onStateChange({
          stage: "executor",
          status: "failed",
          output: message,
          detail: "effect_gate_no_write_effect",
        });
        await this.afterConductorStage(
          "executor",
          "failed",
          failedNarrative,
          agentRunId,
          options,
          remainingQueue,
          executorEvidence(),
        );
        return {
          ok: false,
          narrative: failedNarrative,
          toolCalls,
          terminalStatus: "failed",
          errorCode: "effect_gate_no_write_effect",
          modelKey: lastModelKey,
        };
      }
      if (!executorDone) {
        const message =
          `Executor reached its ${maxTurns}-turn tool-call limit while work was still in progress. ` +
          "The stage is incomplete and must be replanned or resumed before claiming completion.";
        const incompleteNarrative = [narrative, message].filter(Boolean).join("\n\n");
        onStateChange({
          stage: "executor",
          status: "partial",
          output: message,
          detail: "executor_turn_limit",
        });
        await this.afterConductorStage(
          "executor",
          "failed",
          incompleteNarrative,
          agentRunId,
          options,
          remainingQueue,
          executorEvidence(),
        );
        return {
          ok: false,
          narrative: incompleteNarrative,
          toolCalls,
          terminalStatus: "partial",
          errorCode: "executor_turn_limit",
          modelKey: lastModelKey,
        };
      }
      if (requiresWorkspaceEvidence && !finalAssessment.sufficient) {
        const failure = evidenceFailure(finalAssessment);
        onStateChange({ stage: "executor", status: "failed", output: failure.message });
        await this.afterConductorStage(
          "executor",
          "completed",
          narrative || failure.message,
          agentRunId,
          options,
          remainingQueue,
          executorEvidence(),
        );
        return { ok: false, narrative: failure.message, toolCalls, modelKey: lastModelKey };
      }
      onStateChange({ stage: "executor", status: "completed", output: narrative });
      await this.afterConductorStage("executor", "completed", narrative, agentRunId, options, remainingQueue, executorEvidence());
      return { ok: true, narrative, toolCalls, modelKey: lastModelKey };
    } catch (e: any) {
      if (
        this.delegateRuntime
        && this.ctx.config.claude_cli?.delegate?.policy === "escalation"
        && successfulWriteCount() === 0
      ) {
        const delegated = await runDelegate(true);
        if (delegated) return delegated;
      }
      if (isStageTimeout(e) && successfulEvidenceCount() === 0) {
        throw e;
      }
      const message = errText(e);
      onStateChange({ stage: "executor", status: "failed", output: message });
      await this.afterConductorStage("executor", "failed", message, agentRunId, options, remainingQueue, executorEvidence());
      return { ok: false, narrative: `Executor failed: ${message}`, toolCalls, modelKey: lastModelKey };
    }
  }

  private async runRewriterStage(
    request: string,
    reviewerFeedback: string,
    executorSummary: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
    remainingQueue: StageName[] = [],
  ): Promise<RewriterStageOutput> {
    const rewriterPrompt = stageSystemPrompt(
      "rewriter",
      options,
      getToolsForMode("rewriter", this.runtime.listTools(), profile),
    );
    const boundedReviewerFeedback = truncateToTokenBudget(reviewerFeedback, 2_000);
    const boundedExecutorSummary = truncateToTokenBudget(executorSummary, 3_000);
    const rewriterMessages: ChatMessage[] = [
      { role: "system", content: rewriterPrompt },
      {
        role: "user",
        content: `User Request: ${truncateToTokenBudget(request, 1_000)}\n\nReviewer Feedback:\n${boundedReviewerFeedback}\n\nExecutor Activity:\n${boundedExecutorSummary}`
      }
    ];
    const toolCalls: ToolCallRecord[] = [];
    const narratives: string[] = [];
    let rewriterDone = false;
    let rewriterTurn = 0;
    const maxRewriterTurns = BUILTIN_MODES.rewriter.max_turns;
    // The rewriter is the write-REPAIR stage: on write turns it needs the
    // same file-scale visibility as the executor (2026-07-18 — see
    // context-budget.ts) or it cannot compose the edit it was invoked to make.
    const rewriterWriteTurn = profile === "full" &&
      (hasWriteIntent(options.rawMessage ?? request) || options.taskRunWriteIntent === true);
    const rewriterResultContextChars = rewriterWriteTurn
      ? WRITE_TURN_TOOL_RESULT_CONTEXT_CHARS
      : REWRITER_TOOL_RESULT_CONTEXT_CHARS;
    const rewriterTranscriptBudget = rewriterWriteTurn
      ? WRITE_TURN_TRANSCRIPT_BUDGET_TOKENS
      : REWRITER_TRANSCRIPT_BUDGET_TOKENS;
    const rewriterResultNote = rewriterWriteTurn
      ? "Call read_file again with offset/limit to view the elided lines BEFORE composing any edit."
      : PIPELINE_TOOL_RESULT_NOTE;

    try {
      while (!rewriterDone && rewriterTurn < maxRewriterTurns) {
        rewriterTurn++;
        const rewStartTime = Date.now();
        const turnStartIdx = toolCalls.length;
        let rewriteResp: any;

        try {
          const transcriptBudget = enforceTranscriptBudget(rewriterMessages, rewriterTranscriptBudget);
          if (transcriptBudget.evicted > 0) {
            onStateChange({
              stage: "rewriter",
              status: "running",
              detail: `context_evicted:${transcriptBudget.evicted}`,
            });
          }
          const inputTokens = transcriptBudget.inputTokens;
          rewriteResp = await this.callModel(rewriterMessages, {
            temperature: BUILTIN_MODES.rewriter.temperature,
            max_tokens: rewriterWriteTurn ? 8192 : BUILTIN_MODES.rewriter.max_tokens,
            tools: getToolsForMode("rewriter", this.runtime.listTools(), profile),
            stream: true,
            stageLabel: "rewriter",
            complexity: options.estimatedComplexity,
            advanceOnEmpty: true,
            stageAbort: this.registerStageAbort("rewriter"),
            suppressActivity: true,
            onChunk: (chunk) => {
              onStateChange({ stage: "rewriter", status: "running", output: chunk });
            }
          });

          const hasRewriteToolCalls = Array.isArray(rewriteResp.tool_calls) && rewriteResp.tool_calls.length > 0;
          if (isEmptyStageOutput(rewriteResp.content) && !hasRewriteToolCalls) {
            const errorMessage = "empty_completion";
            onStateChange({ stage: "rewriter", status: "failed", output: errorMessage });
            await this.afterConductorStage("rewriter", "failed", errorMessage, agentRunId, options, []);
            this.collector.recordStageRun({
              id: `stage_${crypto.randomUUID()}`,
              agent_run_id: agentRunId,
              mode_id: "rewriter",
              turn_number: rewriterTurn,
              input_tokens: inputTokens,
              output_tokens: 0,
              tool_calls_json: "[]",
              duration_ms: Date.now() - rewStartTime,
              was_successful: 0,
              had_error: 1,
              error_message: errorMessage,
            });
            return {
              ok: false,
              narrative: errorMessage,
              toolCalls,
              terminalStatus: "failed",
              errorCode: errorMessage,
            };
          }
          rewriterMessages.push({ role: "assistant", content: rewriteResp.content, tool_calls: rewriteResp.tool_calls });
          if (rewriteResp.content) narratives.push(rewriteResp.content);

          if (rewriteResp.tool_calls && rewriteResp.tool_calls.length > 0) {
            await this.dispatchToolCalls("rewriter", rewriteResp.tool_calls, options, (tc, call, toolResult) => {
              toolCalls.push({
                name: call.name,
                arguments: call.arguments,
                output: toolResultModelText(toolResult),
                is_error: toolResult.is_error,
                error_code: toolResult.error_code,
                duration_ms: toolResult.duration_ms ?? 0,
              });
              rewriterMessages.push({
                role: "tool",
                tool_call_id: tc.id,
                name: tc.name,
                content: prepareToolResultForContext(
                  toolResultModelText(toolResult),
                  rewriterResultContextChars,
                  rewriterResultNote,
                ).context,
              });
              onStateChange({
                stage: "rewriter",
                status: "running",
                output: `\n[Tool Executed: ${tc.name}]\n`
              });
            });
          } else {
            rewriterDone = true;
          }

          const turnToolErrors = toolCalls.slice(turnStartIdx).filter((call) => call.is_error);
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "rewriter",
            turn_number: rewriterTurn,
            input_tokens: inputTokens,
            output_tokens: countTokens(rewriteResp?.content || ""),
            tool_calls_json: JSON.stringify(rewriteResp?.tool_calls || []),
            duration_ms: Date.now() - rewStartTime,
            was_successful: turnToolErrors.length === 0 ? 1 : 0,
            had_error: turnToolErrors.length === 0 ? 0 : 1,
            error_message: turnToolErrors[0]
              ? `${turnToolErrors[0].name}: ${(turnToolErrors[0].output || "").slice(0, 200)}`
              : undefined,
          });
        } catch (err: any) {
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "rewriter",
            turn_number: rewriterTurn,
            tool_calls_json: "[]",
            duration_ms: Date.now() - rewStartTime,
            was_successful: 0,
            had_error: 1,
            error_message: errText(err),
          });
          throw err;
        }
      }

      const narrative = narratives.join("\n\n");
      onStateChange({ stage: "rewriter", status: "completed", output: narrative });
      return { ok: true, narrative, toolCalls };
    } catch (e: any) {
      // NOTE (intentional, reviewed change from pre-extraction behavior): before
      // this refactor, a rewriter-turn failure rethrew out of the inline rewrite
      // block and was caught by the outer reviewer-loop catch, which mislabeled
      // it as a "reviewer" failure (wrong onStateChange stage, a duplicate
      // mode_id:"reviewer" telemetry row) and aborted the review/rewrite loop
      // immediately. Catching it here instead gives correct stage attribution
      // and lets the loop continue past a transient rewriter failure.
      const message = errText(e);
      const timedOut = isStageTimeout(e);
      onStateChange({
        stage: "rewriter",
        status: timedOut ? "timed_out" : "failed",
        output: message,
        detail: timedOut ? "stage_timeout" : undefined,
      });
      return {
        ok: false,
        narrative: message,
        toolCalls,
        terminalStatus: timedOut ? "timed_out" : "failed",
        errorCode: timedOut ? "stage_timeout" : "stage_error",
      };
    }
  }

  /**
   * Test seam for the post-write syntax gate. Defaults to the real parse-check;
   * overridable so the "syntax error reopens the repair loop" wiring can be
   * unit-tested without spawning a compiler on real files.
   */
  protected async gateWrittenSyntax(toolCalls: ToolCallRecord[]): Promise<SyntaxIssue[]> {
    return checkWrittenFilesSyntax(toolCalls);
  }

  /** Test seam for the post-write run gate; disabled only by its config kill switch. */
  protected async gateWrittenRun(
    toolCalls: ToolCallRecord[],
    request: string,
    planSummary: string,
  ): Promise<RunGateResult> {
    if (!this.ctx.config?.tools || this.ctx.config.tools.run_gate === false) {
      return { status: "skipped", reason: "tools.run_gate disabled", issues: [] };
    }
    const root = this.evidenceRoots({})[0]
      || this.ctx.workspace_path
      || this.ctx.config.jarvis_path
      || process.cwd();
    return runWrittenCodeGate(toolCalls, request, planSummary, { root });
  }

  private async runReviewerRewriterLoop(
    request: string,
    planSummary: string,
    executorSummary: string,
    executorToolCalls: ToolCallRecord[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    profile: ExecutionProfile,
    remainingQueue: StageName[] = [],
  ): Promise<{ reviewer: ReviewerStageOutput; rewriter?: RewriterStageOutput }> {
    const reviewerPrompt = stageSystemPrompt(
      "reviewer",
      options,
      getToolsForMode("reviewer", this.runtime.listTools(), profile),
    );
    const boundedRequest = truncateToTokenBudget(request, 1_000);
    const boundedPlanSummary = truncateToTokenBudget(planSummary, 1_000);
    const boundedExecutorSummary = truncateToTokenBudget(executorSummary, 3_000);
    const configuredRepairRounds = Number(options.maxReviewRepairRounds ?? 1);
    const maxRepairRounds = Number.isFinite(configuredRepairRounds)
      ? Math.min(2, Math.max(0, Math.floor(configuredRepairRounds)))
      : 1;
    let reviewCount = 0;
    let repairs = 0;
    let hasPendingIssues = true;
    let reviewerFeedback = "No review stage executed.";
    let reviewerOk = true;
    let rewriterOutput: RewriterStageOutput | undefined;
    let rewriterSummaryForPrompt = "No rewriting stage executed.";
    const writeIntentForTurn = hasWriteIntent(options.rawMessage ?? request);

    while (hasPendingIssues) {
      reviewCount++;
      onStateChange({ stage: "reviewer", status: "running", output: `\nReview Turn ${reviewCount}...\n` });
      const revStartTime = Date.now();
      // Deterministic syntax gate (2026-07-21 benchmark): parse-check the files
      // this turn wrote so a non-parsing file forces a repair even when the
      // reviewer model returns empty or a false ACCEPT.
      const syntaxIssues = await this.gateWrittenSyntax([
        ...executorToolCalls,
        ...(rewriterOutput?.toolCalls ?? []),
      ]);
      const writtenToolCalls = [
        ...executorToolCalls,
        ...(rewriterOutput?.toolCalls ?? []),
      ];
      const runGate = syntaxIssues.length === 0
        ? await this.gateWrittenRun(writtenToolCalls, request, planSummary)
        : { status: "skipped", reason: "syntax gate failed", issues: [] } satisfies RunGateResult;
      const deterministicGateFeedback = [
        renderSyntaxIssues(syntaxIssues),
        renderRunIssues(runGate),
      ].filter(Boolean).join("\n\n");

      try {
        const reviewerMessages = [
          { role: "system", content: reviewerPrompt },
          {
            role: "user",
            content: `User Request: ${boundedRequest}\n\nOriginal Plan:\n${boundedPlanSummary}\n\nExecutor Activity:\n${boundedExecutorSummary}\n\nRewriter Activity:\n${truncateToTokenBudget(rewriterSummaryForPrompt, 1_000)}\n\nDeterministic verification evidence:\n${deterministicGateFeedback || "Syntax and run gates produced no deterministic failures."}`
          }
        ] as ChatMessage[];
        const reviewerOptions = {
          temperature: BUILTIN_MODES.reviewer.temperature,
          max_tokens: BUILTIN_MODES.reviewer.max_tokens,
          stream: true,
          stageLabel: "reviewer" as const,
          complexity: options.estimatedComplexity,
          advanceOnEmpty: true,
          suppressActivity: true,
          onChunk: (chunk: string) => {
            onStateChange({ stage: "reviewer", status: "running", output: chunk });
          }
        };
        let reviewerResp = await this.callModel(reviewerMessages, reviewerOptions);
        // Reviewer resilience (mirrors the planner retry above): reasoning
        // models sometimes burn the whole budget in the thinking channel and
        // emit empty visible content. One fresh callModel invocation lets
        // stage-health cooldowns steer the retry to another candidate before an
        // empty verdict silently skips the review gate.
        if (isEmptyStageOutput(reviewerResp.content)) {
          reviewerResp = await this.callModel(reviewerMessages, reviewerOptions);
        }

        reviewerFeedback = reviewerResp.content;
        if (isEmptyStageOutput(reviewerFeedback) && deterministicGateFeedback.length === 0) {
          const errorMessage = "empty_completion";
          reviewerOk = false;
          hasPendingIssues = false;
          onStateChange({ stage: "reviewer", status: "failed", output: errorMessage });
          await this.afterConductorStage("reviewer", "failed", errorMessage, agentRunId, options, []);
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "reviewer",
            turn_number: reviewCount,
            input_tokens: Math.round((reviewerPrompt.length + boundedRequest.length + boundedPlanSummary.length + boundedExecutorSummary.length + truncateToTokenBudget(rewriterSummaryForPrompt, 1_000).length) / 4),
            output_tokens: 0,
            tool_calls_json: "[]",
            duration_ms: Date.now() - revStartTime,
            was_successful: 0,
            had_error: 1,
            error_message: errorMessage,
          });
          break;
        }
        if (isEmptyStageOutput(reviewerFeedback)) {
          // A deterministic gate found a real defect; drive the repair from its
          // evidence rather than shipping a broken or unverified file.
          reviewerFeedback = deterministicGateFeedback;
        }
        onStateChange({ stage: "reviewer", status: "completed", output: reviewerFeedback });

        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "reviewer",
          turn_number: reviewCount,
          input_tokens: Math.round((reviewerPrompt.length + boundedRequest.length + boundedPlanSummary.length + boundedExecutorSummary.length + truncateToTokenBudget(rewriterSummaryForPrompt, 1_000).length) / 4),
          output_tokens: countTokens(reviewerFeedback),
          tool_calls_json: "[]",
          duration_ms: Date.now() - revStartTime,
          was_successful: 1,
          had_error: 0,
        });

        // NOTE (found during extraction, not changed): this mirrors existing
        // behavior exactly — the rewriter can run whenever the reviewer flags
        // issues, even on a pipeline that didn't request the "rewriter" stage.
        // The gate below deliberately suppresses repair on non-write turns.
        hasPendingIssues = this.hasIssues(reviewerFeedback);
        if (syntaxIssues.length > 0) {
          // A non-parsing written file ALWAYS reopens the repair loop, whatever
          // the reviewer model concluded, and feeds it the parse error.
          if (!reviewerFeedback.includes("SYNTAX ERROR")) {
            reviewerFeedback = renderSyntaxIssues(syntaxIssues) + "\n\n" + reviewerFeedback;
          }
          hasPendingIssues = true;
        }
        if (runGate.issues.length > 0) {
          if (!reviewerFeedback.includes("run gate failed")) {
            reviewerFeedback = renderRunIssues(runGate) + "\n\n" + reviewerFeedback;
          }
          hasPendingIssues = true;
        }
        if (!hasPendingIssues || profile !== "full" || !writeIntentForTurn || repairs >= maxRepairRounds) {
          break;
        }

        const beforeWrites = successfulWriteKeys([
          ...executorToolCalls,
          ...(rewriterOutput?.toolCalls ?? []),
        ]);
        repairs++;
        onStateChange({ stage: "rewriter", status: "running", output: `\nReviewer flagged issues. Rewriting...\n` });
        rewriterOutput = await this.runRewriterStage(request, reviewerFeedback, executorSummary, agentRunId, onStateChange, options, profile, remainingQueue);
        rewriterSummaryForPrompt = renderRewriterSummary(rewriterOutput);
        const afterWrites = successfulWriteKeys([
          ...executorToolCalls,
          ...(rewriterOutput.toolCalls ?? []),
        ]);
        if (!addedWriteProgress(beforeWrites, afterWrites)) {
          hasPendingIssues = true;
          break;
        }
      } catch (e: any) {
        const message = errText(e);
        onStateChange({ stage: "reviewer", status: "failed", output: message });
        hasPendingIssues = false;
        reviewerOk = false;

        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "reviewer",
          turn_number: reviewCount,
          tool_calls_json: "[]",
          duration_ms: Date.now() - revStartTime,
          was_successful: 0,
          had_error: 1,
          error_message: message,
        });
      }
    }

    return {
      reviewer: { ok: reviewerOk, feedback: reviewerFeedback, hasIssues: this.hasIssues(reviewerFeedback) },
      rewriter: rewriterOutput,
    };
  }

  /**
   * Synthesizer stage — produces the user-visible answer from accumulated
   * pipeline state. Behavior is identical to the previous inline synthesizer
   * block in `execute()`: same prompts, same telemetry, same empty-completion
   * fence, same throw-handled fallback. Extracted so `executeSegment()` (and
   * the B-02 replan loop) can call it with already-built `PipelineStageState`.
   *
   * Returns `{ answer, fatalError?, emptyCompletion }` so the caller can
   * classify the run outcome (success / degraded / failed) without
   * string-prefix sniffing.
   */
  private async runSynthesizerStage(
    request: string,
    state: PipelineStageState,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    executionVerification = "",
    remainingQueue: StageName[] = [],
  ): Promise<{ answer: string; fatalError?: string; emptyCompletion: boolean; partialErrorCode?: string }> {
    onStateChange({ stage: "synthesizer", status: "running" });
    const synthesizerPrompt = stageSystemPrompt("synthesizer", options);
    const synthStartTime = Date.now();
    const contextText = buildSynthesizerContextFromStageState(request, state, executionVerification);
    let streamedAnswer = "";
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        { role: "user", content: contextText }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES.synthesizer.temperature,
        max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
        stream: true,
        stageLabel: "synthesizer",
        complexity: options.estimatedComplexity,
        cascadeTier: options.preferFastSynthesizer ? "cheap" : undefined,
        surfaceAsAnswer: true,
        stageAbort: this.registerStageAbort("synthesizer"),
        onChunk: (chunk) => {
          streamedAnswer += chunk;
          onStateChange({ stage: "synthesizer", status: "running", output: chunk });
          this.publishStageToken("synthesizer", chunk);
        }
      }) as {
        content?: string;
        _finishReason?: string | null;
        _stopReason?: string | null;
        _truncated?: boolean;
      };
      const finalAnswer = resp.content ?? "";
      // T0.1/T0.2: provider finish_reason / stop_reason from callModel.
      const stopReason = typeof resp._stopReason === "string" ? resp._stopReason : null;
      const truncated = resp._truncated === true;

      // Semantic emptiness is a FAILURE, not a success. A 200-OK with empty
      // visible content (free-tier zero-token completion, model spent its
      // budget on reasoning, etc.) previously recorded was_successful:1 with
      // output_tokens:0 — poisoning the self-tuning signal and surfacing a
      // blank turn. Record it as a failed stage; the caller still shows the
      // friendly "try again" notice (we leave `fatalError` unset so it is not
      // an error banner) but the run outcome is truthfully failed.
      if (!finalAnswer.trim()) {
        onStateChange({ stage: "synthesizer", status: "failed", output: "(empty completion)" });
        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "synthesizer",
          turn_number: 1,
          input_tokens: Math.round((synthesizerPrompt.length + contextText.length) / 4),
          output_tokens: 0,
          tool_calls_json: "[]",
          duration_ms: Date.now() - synthStartTime,
          was_successful: 0,
          had_error: 1,
          error_message: "empty_completion",
          stop_reason: stopReason,
        });
        // The empty-completion cascade-advance inside callModel already walked
        // past empty models (surfaceAsAnswer). If everything still came back
        // empty, ship the deterministic evidence digest instead of nothing —
        // the stage row above stays truthful about the model failure.
        const salvage = composeEvidenceFallbackAnswer(state);
        if (salvage) {
          onStateChange({ stage: "synthesizer", status: "completed", output: salvage });
          await this.afterConductorStage("synthesizer", "completed", salvage, agentRunId, options, remainingQueue);
          return { answer: salvage, emptyCompletion: false, partialErrorCode: "empty_completion_salvaged" };
        }
        return { answer: "", emptyCompletion: true };
      }

      // T1.4: finish_reason === "length" ⇒ one bounded synthesizer auto-continuation
      // when ≥15s remain to the final grace deadline. Exactly one follow-up; if
      // the continuation also caps ⇒ token_cap, no loop.
      const finishReason = typeof resp._finishReason === "string" ? resp._finishReason : null;
      const isLengthCap = truncated && (stopReason === "length" || finishReason === "length");
      if (isLengthCap) {
        const graceLeftMs = options.turnBudget
          ? Math.max(0, options.turnBudget.finalStreamDeadlineAt() - Date.now())
          : 30_000;
        // Always record the first (capped) attempt.
        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "synthesizer",
          turn_number: 1,
          input_tokens: Math.round((synthesizerPrompt.length + contextText.length) / 4),
          output_tokens: countTokens(finalAnswer),
          tool_calls_json: "[]",
          duration_ms: Date.now() - synthStartTime,
          was_successful: 0,
          had_error: 0,
          stop_reason: "length",
          partial_error_code: "token_cap",
        });
        if (graceLeftMs < 15_000) {
          onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });
          await this.afterConductorStage("synthesizer", "completed", finalAnswer, agentRunId, options, remainingQueue);
          return { answer: finalAnswer, emptyCompletion: false, partialErrorCode: "token_cap" };
        }
        console.warn(`[Pipeline] synthesizer hit token length — one continuation (grace_left_ms=${graceLeftMs})`);
        try {
          const continuationStartTime = Date.now();
          const continuationNudge = "Continue exactly where you stopped. Do not repeat prior text.";
          const contResp = await this.callModel([
            { role: "system", content: synthesizerPrompt },
            { role: "user", content: contextText },
            { role: "assistant", content: finalAnswer },
            { role: "user", content: continuationNudge },
          ] as ChatMessage[], {
            temperature: BUILTIN_MODES.synthesizer.temperature,
            max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
            stream: true,
            stageLabel: "synthesizer",
            complexity: options.estimatedComplexity,
            cascadeTier: options.preferFastSynthesizer ? "cheap" : undefined,
            surfaceAsAnswer: true,
            stageAbort: this.registerStageAbort("synthesizer"),
            onChunk: (chunk) => {
              streamedAnswer += chunk;
              onStateChange({ stage: "synthesizer", status: "running", output: chunk });
              this.publishStageToken("synthesizer", chunk);
            },
          }) as {
            content?: string;
            _finishReason?: string | null;
            _stopReason?: string | null;
            _truncated?: boolean;
          };
          const contText = contResp.content ?? "";
          const combined = contText.trim() ? finalAnswer + contText : finalAnswer;
          const contTruncated = contResp._truncated === true;
          const contStop = typeof contResp._stopReason === "string" ? contResp._stopReason : null;
          const contLength = contTruncated && (contStop === "length" || contResp._finishReason === "length");
          this.collector.recordStageRun({
            id: `stage_${crypto.randomUUID()}`,
            agent_run_id: agentRunId,
            mode_id: "synthesizer",
            turn_number: 2,
            input_tokens: countTokens(
              `${synthesizerPrompt}\n${contextText}\n${finalAnswer}\n${continuationNudge}`,
            ),
            output_tokens: countTokens(contText),
            tool_calls_json: "[]",
            duration_ms: Date.now() - continuationStartTime,
            was_successful: contTruncated ? 0 : 1,
            had_error: 0,
            stop_reason: "length_continuation",
            partial_error_code: contLength ? "token_cap" : (contTruncated ? "stream_cut" : null),
          });
          onStateChange({ stage: "synthesizer", status: "completed", output: combined });
          await this.afterConductorStage("synthesizer", "completed", combined, agentRunId, options, remainingQueue);
          if (contLength || contTruncated) {
            return {
              answer: combined,
              emptyCompletion: false,
              partialErrorCode: contLength ? "token_cap" : "stream_cut",
            };
          }
          return { answer: combined, emptyCompletion: false };
        } catch (contErr) {
          console.warn(`[Pipeline] length continuation failed: ${errText(contErr)}`);
          onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });
          await this.afterConductorStage("synthesizer", "completed", finalAnswer, agentRunId, options, remainingQueue);
          return { answer: finalAnswer, emptyCompletion: false, partialErrorCode: "token_cap" };
        }
      }

      // T0.2 / T1.3: clean HTTP return but truncated stream (provider_cut /
      // content_filter / other) — ship the partial answer with honest
      // partialErrorCode so agent_runs.outcome can be "partial", not success.
      // (length case handled above.)
      if (truncated) {
        const partialErrorCode =
          stopReason === "turn_deadline" || stopReason === "stage_deadline" ? "stage_timeout"
            : "stream_cut";
        onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });
        await this.afterConductorStage("synthesizer", "completed", finalAnswer, agentRunId, options, remainingQueue);
        this.collector.recordStageRun({
          id: `stage_${crypto.randomUUID()}`,
          agent_run_id: agentRunId,
          mode_id: "synthesizer",
          turn_number: 1,
          input_tokens: Math.round((synthesizerPrompt.length + contextText.length) / 4),
          output_tokens: countTokens(finalAnswer),
          tool_calls_json: "[]",
          duration_ms: Date.now() - synthStartTime,
          was_successful: 0,
          had_error: 0,
          stop_reason: stopReason,
          partial_error_code: partialErrorCode,
        });
        return { answer: finalAnswer, emptyCompletion: false, partialErrorCode };
      }

      // T1.5: deferral-stall detection + one corrective retry.
      let answerToShip = finalAnswer;
      let deferralRetried = false;
      if (detectDeferralStall(finalAnswer)) {
        const remainingMs = typeof (options as { turnBudgetRemainingMs?: () => number }).turnBudgetRemainingMs === "function"
          ? (options as { turnBudgetRemainingMs: () => number }).turnBudgetRemainingMs()
          : 30_000;
        if (remainingMs >= 20_000) {
          deferralRetried = true;
          console.warn(`[Pipeline] synthesizer deferral stall detected — one corrective retry`);
          try {
            const retryResp = await this.callModel([
              { role: "system", content: `${synthesizerPrompt}\n\n${DEFERRAL_STALL_NUDGE}` },
              { role: "user", content: contextText },
              { role: "assistant", content: finalAnswer },
              { role: "user", content: "Continue: deliver the actual answer now. No stand-by narration." },
            ] as ChatMessage[], {
              temperature: BUILTIN_MODES.synthesizer.temperature,
              max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
              stream: true,
              stageLabel: "synthesizer",
              complexity: options.estimatedComplexity,
              cascadeTier: options.preferFastSynthesizer ? "cheap" : undefined,
              surfaceAsAnswer: true,
              stageAbort: this.registerStageAbort("synthesizer"),
              onChunk: (chunk) => {
                streamedAnswer += chunk;
                onStateChange({ stage: "synthesizer", status: "running", output: chunk });
                this.publishStageToken("synthesizer", chunk);
              },
            }) as { content?: string; _truncated?: boolean; _stopReason?: string | null };
            const retryAnswer = retryResp.content ?? "";
            if (retryAnswer.trim() && !detectDeferralStall(retryAnswer)) {
              answerToShip = retryAnswer;
            } else if (detectDeferralStall(retryAnswer) || !retryAnswer.trim()) {
              this.collector.recordStageRun({
                id: `stage_${crypto.randomUUID()}`,
                agent_run_id: agentRunId,
                mode_id: "synthesizer",
                turn_number: 2,
                tool_calls_json: "[]",
                duration_ms: Date.now() - synthStartTime,
                was_successful: 0,
                had_error: 1,
                error_message: "deferral_stall",
                stop_reason: stopReason,
              });
              return { answer: "", fatalError: "Synthesizer deferred without delivering an answer.", emptyCompletion: false };
            }
          } catch (retryErr) {
            console.warn(`[Pipeline] deferral retry failed: ${errText(retryErr)}`);
          }
        }
      }

      onStateChange({ stage: "synthesizer", status: "completed", output: answerToShip });
      await this.afterConductorStage("synthesizer", "completed", answerToShip, agentRunId, options, remainingQueue);
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: deferralRetried ? 2 : 1,
        input_tokens: Math.round((synthesizerPrompt.length + contextText.length) / 4),
        output_tokens: countTokens(answerToShip),
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 1,
        had_error: 0,
        stop_reason: stopReason ?? "stop",
      });
      return { answer: answerToShip, emptyCompletion: false };
    } catch (e: any) {
      const message = errText(e);
      onStateChange({ stage: "synthesizer", status: "failed", output: message });
      await this.afterConductorStage("synthesizer", "failed", message, agentRunId, options, remainingQueue);
      const hasPartialDeadlineAnswer =
        e?.name === "TurnDeadlineExceededError" && streamedAnswer.trim().length > 0;
      const fatalError = describePipelineError(message);
      const starvationCode = partialErrorCodeForThrowable(e);
      const deadlineStopReason =
        e?.name === "TurnDeadlineExceededError" ? "turn_deadline"
          : e?.name === "StageDeadlineExceededError" || e?.name === "StageBudgetExhaustedError"
            ? "stage_deadline"
            : null;
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
        stop_reason: deadlineStopReason ?? starvationCode,
        partial_error_code: starvationCode
          ?? (deadlineStopReason === "turn_deadline"
            ? "turn_deadline"
            : (hasPartialDeadlineAnswer ? "stage_timeout" : null)),
      });
      // `answer` must never carry the raw failure text — 20 historical runs
      // (pre-2026-07-04) shipped "Synthesis failed: ..." as the literal chat
      // bubble because this catch block returned it as the answer. The real
      // failure travels via `fatalError` (-> PipelineResult.error), which
      // index.ts's error branch turns into an SSE error frame instead of
      // prose (see `if (result.error) ... session.finish(result.error, {
      // isError: true })`).
      // Deadline/starvation deaths with no streamed prose still have the
      // run's gathered evidence in `state` — composing a digest costs zero
      // model time even at the deadline, so the user gets grounded content
      // instead of "(no output: turn_deadline)".
      const deadlineSalvage = hasPartialDeadlineAnswer ? streamedAnswer : composeEvidenceFallbackAnswer(state);
      if (deadlineStopReason === "turn_deadline" || starvationCode === "turn_deadline") {
        return {
          answer: deadlineSalvage,
          emptyCompletion: false,
          partialErrorCode: "turn_deadline",
        };
      }
      if (starvationCode === "stage_window_exhausted") {
        return {
          answer: deadlineSalvage,
          emptyCompletion: false,
          partialErrorCode: "stage_window_exhausted",
        };
      }
      if (hasPartialDeadlineAnswer) {
        return { answer: streamedAnswer, emptyCompletion: false, partialErrorCode: "stage_timeout" };
      }
      return { answer: "", fatalError, emptyCompletion: false };
    }
  }

  /**
   * Run a bounded slice of {planner, executor, reviewer, rewriter, synthesizer}
   * against a `carry`-forward state. Used directly by `execute()`'s linear
   * branch (with the full pipeline as `stages`) and by the B-02 replan loop
   * (`replan-loop.ts`) to run one segment between `conductor_replan` markers.
   * Synthesizer only runs if `"synthesizer"` is in `stages` — a non-terminal
   * segment stops right after reviewer/rewriter so the replan loop can
   * re-invoke the conductor with the accumulated state.
   */
  async executeSegment(
    request: string,
    stages: StageName[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    carry: PipelineStageState = {},
  ): Promise<PipelineSegmentResult> {
    const state: PipelineStageState = { ...carry };
    const profile: ExecutionProfile = options.executionProfile ?? "full";
    const intentText = options.rawMessage ?? request;
    const requiresWorkspaceEvidence = turnNeedsWorkspaceEvidence(options.turnRequirement, intentText);
    // T2.1: ordered work queue (behavior-preserving vs if-ladder; enables T2.2 reroute).
    const workQueue: StageName[] = stages.filter(
      (s): s is StageName =>
        s === "planner" || s === "executor" || s === "reviewer" || s === "rewriter" || s === "synthesizer",
    );
    const wantsSynthesizer = stages.includes("synthesizer");
    // After shift, workQueue is exactly the remaining stages.
    const remainingNow = (): StageName[] => workQueue.slice();
    let partialStage: PipelineSegmentResult["partialStage"];
    let replanRequested: PipelineSegmentResult["replanRequested"];
    const pendingInjections = new Map<StageName, string[]>();
    const reroutesApplied = { n: 0 };
    const opts = {
      ...options,
      pendingInjections,
      workQueue,
      reroutesApplied,
      maxReroutesPerSegment: 3,
    };

    // Drain the queue. Synthesizer is a barrier: effect-gate + evidence fence
    // run when we hit it (or after the queue drains if it was never present).
    while (workQueue.length > 0) {
      const stage = workQueue.shift()!;
      // Synthesis runway guard (2026-07-16 evening, session 10cf071d): every
      // 180s-ceiling turn spent down to ~the finalization reserve on
      // replan/review ceremony and started synthesis with 28-40s left — one
      // provider stall from death. Once evidence exists, stop starting
      // non-synthesizer stages while there is still enough runway for a
      // stalled first attempt plus one fallback completion.
      if (
        stage !== "synthesizer" &&
        shouldCutToSynthesis({
          wantsSynthesizer,
          hasEvidence: (state.executor?.toolCalls?.length ?? 0) > 0,
          // Tolerate partial TurnBudget stubs (tests inject extend-only fakes).
          remainingMs: typeof options.turnBudget?.remainingMs === "function"
            ? options.turnBudget.remainingMs()
            : undefined,
          reserveMs: options.turnBudget?.finalization_reserve_ms,
        })
      ) {
        console.warn(
          `[Pipeline] synthesis runway guard: skipping ${[stage, ...workQueue].join("->")} ` +
          `with ${options.turnBudget?.remainingMs()}ms of turn budget left`,
        );
        onStateChange({
          stage: "synthesizer",
          status: "running",
          detail: "runway_guard_cut",
        });
        break;
      }
      if (stage === "planner") {
        state.plan = await this.runPlannerStage(request, agentRunId, onStateChange, opts, remainingNow());
        // Owned-runtime-loop: complex path — Conductor validates Planner
        // decomposition and persists TaskPlan ledger before dispatch.
        if (
          state.plan?.ok &&
          opts.ownedPlanning?.plan_authorship === "planner_mediated" &&
          opts.taskRunContract
        ) {
          try {
            const seeded = seedTaskPlanFromPlannerProposal(
              opts.taskRunContract,
              state.plan.narrative,
              opts.ownedPlanning.plan_brief,
            );
            opts.taskRunContract = seeded.contract;
            opts.onTaskPlanUpdate?.(seeded.contract);
            this.conductor?.live.setPlanContext(seeded.contract);
            console.log(
              `[Pipeline] planner_mediated TaskPlan seeded (${seeded.items.length} items): ${seeded.notes}`,
            );
          } catch (e) {
            console.warn(
              `[Pipeline] planner_mediated TaskPlan seed failed: ` +
              `${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        continue;
      }
      if (stage === "executor") {
        const executorOptions = {
          ...opts,
          priorToolCalls: state.executor?.toolCalls ?? opts.priorToolCalls,
        };
        state.executor = await this.runExecutorStage(
          request, renderPlanSummary(state.plan), agentRunId, onStateChange, executorOptions, profile, remainingNow(),
        );
        // P2.3: a high-complexity CHANGE gets one alternate strong executor
        // only when deterministic verification says candidate one failed.
        // The retry starts from the current workspace, carries no stale model
        // transcript, and excludes the actual first provider/model key so the
        // pool must choose a different brain while retaining its cooldown and
        // cost-tier policy.
        if (
          state.executor
          && profile === "full"
          && options.estimatedComplexity === "high"
          && hasWriteIntent(intentText)
          && options.executorRetryUsed !== true
          && this.ctx.config.orchestrator?.high_complexity_executor_retry !== false
          && state.executor.modelKey
        ) {
          const candidateOne = state.executor;
          const candidateSyntax = await this.gateWrittenSyntax(candidateOne.toolCalls);
          const candidateRun = candidateSyntax.length === 0
            ? await this.gateWrittenRun(candidateOne.toolCalls, request, renderPlanSummary(state.plan))
            : { status: "skipped", reason: "syntax gate failed", issues: [] } satisfies RunGateResult;
          const candidateEffect = evaluateEffectGate({
            profile,
            executor: candidateOne,
            request: intentText,
            assumeWriteIntent: options.taskRunWriteIntent,
            contentEffects: this.ctx.write_effects,
          });
          const gateFailure = candidateSyntax.length > 0
            || candidateRun.issues.length > 0
            || candidateEffect.verdict === "no_write_effect";
          if (gateFailure) {
            const firstModelKey = candidateOne.modelKey!;
            onStateChange({
              stage: "executor",
              status: "running",
              detail: `high_complexity_retry:${firstModelKey}`,
            });
            const alternateOptions = {
              ...opts,
              priorToolCalls: [],
              modelExclusions: [firstModelKey],
              executorRetryUsed: true,
            };
            const candidateTwo = await this.runExecutorStage(
              request,
              renderPlanSummary(state.plan),
              agentRunId,
              onStateChange,
              alternateOptions,
              profile,
              remainingNow(),
            );
            state.executor = {
              ...candidateTwo,
              narrative: [candidateOne.narrative, "[Alternate executor candidate]", candidateTwo.narrative]
                .filter(Boolean)
                .join("\n\n"),
              toolCalls: [...candidateOne.toolCalls, ...candidateTwo.toolCalls],
            };
          }
        }
        if (state.executor.terminalStatus === "cancelled") {
          return { state, partialStage };
        }
        if (state.executor.errorCode === "delegate_cleanup_unconfirmed") {
          return { state, partialStage };
        }
        if (state.executor.errorCode === "effect_gate_no_write_effect") {
          const effectGate = evaluateEffectGate({
            profile,
            executor: state.executor,
            rewriter: state.rewriter,
            request: intentText,
            assumeWriteIntent: options.taskRunWriteIntent,
            contentEffects: this.ctx.write_effects,
          });
          return { state, effectGate, partialStage };
        }
        // T2.4: hard executor failure (non-workspace_read) → replan pre-synthesizer.
        // workspace_read falls through to the evidence fence for precise codes.
        if (
          state.executor &&
          state.executor.ok === false &&
          wantsSynthesizer &&
          options.allowMidRunReplan !== false &&
          !requiresWorkspaceEvidence
        ) {
          replanRequested = {
            trigger: "executor_hard_failure",
            detail: state.executor.narrative?.slice(0, 400) || "executor failed",
          };
          return { state, replanRequested, partialStage };
        }
        continue;
      }
      if (stage === "reviewer") {
        const { reviewer, rewriter } = await this.runReviewerRewriterLoop(
          request, renderPlanSummary(state.plan), renderExecutorSummary(state.executor), state.executor?.toolCalls ?? [],
          agentRunId, onStateChange, opts, profile, remainingNow(),
        );
        state.reviewer = reviewer;
        if (rewriter) {
          state.rewriter = rewriter;
          if (rewriter.terminalStatus === "timed_out") {
            partialStage = { stage: "rewriter", errorCode: rewriter.errorCode ?? "stage_timeout" };
          }
        }
        // Owned-runtime-loop (Task 5): on Reviewer insufficient, fire the
        // automatic Reviewer→Rewriter→Executor chain WITHOUT a Conductor
        // re-decision (no coordinator.route / conductor_replan). The older
        // mid-run replan path remains only when the repair-chain backstop
        // trips and allowMidRunReplan is still true — infrastructure may
        // still replan after backstop, but the chain itself is deterministic.
        const writeIntentForRepair = hasWriteIntent(intentText) || options.taskRunWriteIntent === true;
        const activeItem = opts.taskRunContract?.plan
          ? opts.taskRunContract.plan.items.find(
              (i) => i.id === opts.taskRunContract?.plan?.activeItemId,
            )
          : undefined;
        // runReviewerRewriterLoop already consumes up to maxReviewRepairRounds
        // of Reviewer→Rewriter cycles. Count a completed rewriter pass against
        // the same budget so we do not immediately re-enter executor/reviewer
        // and double-run gates. Remaining budget > 0 → inject Executor (and
        // Rewriter only if the loop skipped it) without a Conductor re-decision.
        const loopRepairsUsed = rewriter ? 1 : 0;
        const ledgerCycles = activeItem?.repairCycleCount ?? 0;
        const repairDecision = decideRepairChain({
          reviewerHasIssues: Boolean(reviewer?.hasIssues),
          writeIntent: writeIntentForRepair,
          profile,
          repairCycleCount: ledgerCycles + loopRepairsUsed,
          maxRepairCycles: options.maxReviewRepairRounds ?? 1,
          consecutiveFailures: this.conductor?.live.getConsecutiveToolErrors?.() ?? 0,
        });
        if (repairDecision.fire) {
          // Loop already ran Rewriter → only re-queue Executor then Reviewer.
          // Loop skipped Rewriter → full Rewriter→Executor→Reviewer chain.
          const chainStages = rewriter
            ? (["executor", "reviewer"] as StageName[])
            : repairDecision.stages;
          const chainRemaining = mergeRepairChainIntoRemaining(
            remainingNow().length > 0 ? remainingNow() : (wantsSynthesizer ? ["synthesizer"] : []),
            chainStages,
          );
          // Mutate the segment's live queue (opts.workQueue === workQueue).
          workQueue.length = 0;
          workQueue.push(...chainRemaining);
          if (opts.taskRunContract && activeItem) {
            try {
              const applied = applyInsufficientVerdict(opts.taskRunContract, {
                itemId: activeItem.id,
                flaggedIssues: reviewer.feedback?.slice(0, 400) || "reviewer rejected",
                maxRepairCycles: options.maxReviewRepairRounds ?? 1,
                consecutiveFailures: this.conductor?.live.getConsecutiveToolErrors?.() ?? 0,
              });
              opts.taskRunContract = applied.contract;
              opts.onTaskPlanUpdate?.(applied.contract);
              this.conductor?.live.setPlanContext(applied.contract);
            } catch (e) {
              console.warn(
                `[Pipeline] repair-chain ledger update failed: ` +
                `${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          console.log(
            `[Pipeline] automatic repair chain (no conductor re-decision): ${chainRemaining.join("->")}`,
          );
          continue;
        }
        // Budget already consumed by the in-loop rewriter (or backstop): fall
        // through to synthesizer. Mid-run replan remains only for true
        // backstop with remaining replan budget — not for ordinary exhausted
        // repair rounds (those already applied fixes; synthesizer should speak).
        const reviewerReplanEligible = writeIntentForRepair
          || (options.turnRequirement === "full_execution" && requiresWorkspaceEvidence);
        if (
          reviewer?.hasIssues &&
          repairDecision.backstop &&
          loopRepairsUsed === 0 &&
          wantsSynthesizer &&
          options.allowMidRunReplan !== false &&
          profile === "full" &&
          reviewerReplanEligible
        ) {
          replanRequested = {
            trigger: "reviewer_reject",
            detail: reviewer.feedback?.slice(0, 400) || "reviewer rejected",
          };
          return { state, replanRequested, partialStage };
        }
        // Reviewer accept with active plan item → mark verified (reviewer_mediated).
        if (
          reviewer &&
          !reviewer.hasIssues &&
          reviewer.ok &&
          opts.taskRunContract &&
          activeItem
        ) {
          try {
            const next = applyReviewerAccept(opts.taskRunContract, activeItem.id, {
              ref: `${agentRunId}:reviewer:${activeItem.id}`,
              summary: reviewer.feedback?.slice(0, 240),
            });
            opts.taskRunContract = next;
            opts.onTaskPlanUpdate?.(next);
            this.conductor?.live.setPlanContext(next);
          } catch (e) {
            console.warn(
              `[Pipeline] reviewer accept mark-verified failed: ` +
              `${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        continue;
      }
      if (stage === "rewriter") {
        if (!state.rewriter && state.executor) {
          state.rewriter = await this.runRewriterStage(
            request,
            "Standalone rewriter pass from queue.",
            renderExecutorSummary(state.executor),
            agentRunId,
            onStateChange,
            opts,
            profile,
          );
        }
        continue;
      }
      if (stage === "synthesizer") {
        break; // effect-gate + evidence fence + synth below
      }
    }

    const turnWriteIntent = hasWriteIntent(intentText) || options.taskRunWriteIntent === true;
    let effectGate = evaluateEffectGate({
      profile,
      executor: state.executor,
      rewriter: state.rewriter,
      request: intentText,
      assumeWriteIntent: options.taskRunWriteIntent,
      contentEffects: this.ctx.write_effects,
    });
    if (
      effectGate.verdict === "no_write_effect" &&
      profile === "full" &&
      (options.maxReviewRepairRounds ?? 1) > 0 &&
      turnWriteIntent &&
      state.executor &&
      !state.rewriter
    ) {
      onStateChange({ stage: "rewriter", status: "running", output: "\nNo write effect detected. Repairing before synthesis...\n" });
      state.rewriter = await this.runRewriterStage(
        request,
        [
          effectGate.synthesizerNotice,
          "",
          "Repair requirement: this is a change request and the executor produced zero successful file mutations. Apply the missing requested write/edit now, then verify the changed file.",
        ].join("\n"),
        renderExecutorSummary(state.executor),
        agentRunId,
        onStateChange,
        opts,
        profile,
      );
      effectGate = evaluateEffectGate({
        profile,
        executor: state.executor,
        rewriter: state.rewriter,
        request: intentText,
        assumeWriteIntent: options.taskRunWriteIntent,
        contentEffects: this.ctx.write_effects,
      });
      if (state.rewriter.terminalStatus === "timed_out") {
        partialStage = { stage: "rewriter", errorCode: state.rewriter.errorCode ?? "stage_timeout" };
      }
    }

    if (isTerminalNoWriteEffect(effectGate)) {
      return { state, effectGate, partialStage };
    }

    // A reviewer/rewriter pass that still produced no requested mutation is
    // not terminal success. Give the conductor one bounded chance to route a
    // fresh executor pass; the replan wrapper disables this branch once caps
    // are exhausted so final synthesis can truthfully report the failure.
    if (
      effectGate.verdict === "no_write_effect" &&
      !partialStage &&
      wantsSynthesizer &&
      options.allowMidRunReplan !== false &&
      options.allowEffectGateReplan === true &&
      profile === "full" &&
      turnWriteIntent
    ) {
      replanRequested = {
        trigger: "effect_gate_failure",
        detail: "No successful file mutation was produced after execution and repair.",
      };
      return { state, effectGate, replanRequested, partialStage };
    }

    if (!wantsSynthesizer) {
      return { state, effectGate, partialStage, replanRequested };
    }

    const preSynthAssessment = assessWorkspaceEvidence(
      state.executor?.toolCalls,
      intentText,
      this.evidenceRoots(options),
      {},
      deriveEvidenceTaskKind(options.rawMessage ?? intentText),
    );
    if (requiresWorkspaceEvidence && !preSynthAssessment.sufficient) {
      const failure = evidenceFailure(preSynthAssessment);
      // T2.4: evidence fence still requests replan (first refusal-free top-up).
      if (options.allowMidRunReplan !== false) {
        replanRequested = {
          trigger: "evidence_insufficient",
          detail: failure.message,
        };
      }
      // F6: refusal is reserved for *zero* evidence. Partial evidence synthesizes
      // with an explicit disclosure notice instead of a canned fatal refuse.
      if (preSynthAssessment.contentReads + preSynthAssessment.listings === 0) {
        return {
          state,
          synthesizerAnswer: "",
          synthesizerFatalError: failure.message,
          synthesizerEmptyCompletion: false,
          fatalErrorCode: failure.code,
          effectGate,
          partialStage,
          replanRequested,
        };
      }
      effectGate = {
        ...effectGate,
        synthesizerNotice: [
          effectGate.synthesizerNotice,
          `Evidence disclosure requirement: workspace evidence is INCOMPLETE (${preSynthAssessment.reason}). ` +
          `State plainly which files you actually read, answer only from them, and name what remains unread.`,
        ].filter(Boolean).join("\n"),
      };
    }

    const synth = await this.runSynthesizerStage(
      request,
      state,
      agentRunId,
      onStateChange,
      opts,
      effectGate.synthesizerNotice,
      [],
    );
    if (synth.partialErrorCode) {
      partialStage = { stage: "synthesizer", errorCode: synth.partialErrorCode };
    }
    return {
      state,
      synthesizerAnswer: synth.answer,
      synthesizerFatalError: synth.fatalError,
      synthesizerEmptyCompletion: synth.emptyCompletion,
      effectGate,
      partialStage,
      replanRequested,
    };
  }

  async execute(
    request: string,
    pipeline: string[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions = {}
  ): Promise<PipelineResult> {
    // Content observations belong to this logical turn. Replans and repair
    // segments intentionally share the same array so the final gate can see
    // every native write attempt made before synthesis.
    this.ctx.write_effects = [];
    const requiresWorkspaceEvidence = turnNeedsWorkspaceEvidence(options.turnRequirement, options.rawMessage ?? request);
    if (!requiresWorkspaceEvidence && this.canRunSpeculativeParallel(pipeline, options.topology)) {
      return this.executeSpeculativeParallel(request, pipeline, agentRunId, onStateChange, options);
    }
    if (!requiresWorkspaceEvidence && this.canRunSpeculativeCascade(pipeline, options.topology)) {
      return this.executeSpeculativeCascade(request, agentRunId, onStateChange, options);
    }

    // Linear branch — delegate the full pipeline to executeSegment(). All
    // stage ordering, telemetry, empty-completion fencing, and review/rewrite
    // looping live inside the segment helper, so the B-02 replan loop can
    // run the same code with a partial stages list.
    const segment = await this.executeSegment(
      request, pipeline as StageName[], agentRunId, onStateChange, options,
    );
    const { state } = segment;

    // Keep the evidence invariant authoritative even for direct/non-normalized
    // callers that omit the synthesizer stage. The normal activation boundary
    // always appends a synthesizer, but PipelineExecutor is also reused by tests
    // and replan slices and must not return a planner sentinel as a repo answer.
    // F6: if the segment already synthesized a grounded partial answer from
    // incomplete evidence, do not wipe it — only refuse zero-evidence turns
    // (or partial turns that never produced a synthesizer answer).
    const executeAssessment = assessWorkspaceEvidence(
      state.executor?.toolCalls,
      options.rawMessage ?? request,
      this.evidenceRoots(options),
      {},
      deriveEvidenceTaskKind(options.rawMessage ?? request),
    );
    if (requiresWorkspaceEvidence && !executeAssessment.sufficient) {
      const failure = evidenceFailure(executeAssessment);
      const zeroEvidence =
        executeAssessment.contentReads + executeAssessment.listings === 0;
      const synthesizedPartial =
        !zeroEvidence &&
        !segment.synthesizerFatalError &&
        Boolean(segment.synthesizerAnswer?.trim());
      if (!synthesizedPartial) {
        return {
          answer: "",
          error: failure.message,
          recursion_depth: 0,
          outcome: "failed",
          error_code: failure.code,
          toolCalls: state.executor?.toolCalls,
        };
      }
    }

    // Truthful run outcome. A failed synthesizer (threw OR empty) is `failed`.
    // A run whose answer came through but an upstream stage failed is `degraded`.
    const upstreamDegraded = Boolean(
      (state.plan && !state.plan.ok) || (state.executor && !state.executor.ok),
    );

    if (segment.synthesizerAnswer === undefined) {
      const gated = applyEffectGate(
        upstreamDegraded ? "degraded" : "success",
        upstreamDegraded ? "upstream_stage_failed" : undefined,
        segment.effectGate ?? evaluateEffectGate({
          profile: options.executionProfile ?? "full",
          executor: state.executor,
          rewriter: state.rewriter,
          contentEffects: this.ctx.write_effects,
        }),
      );
      // No synthesizer in this pipeline: fall back to the last completed phase.
      return {
        answer: state.plan ? renderPlanSummary(state.plan) : "No planning stage executed.",
        recursion_depth: 0,
        outcome: gated.outcome,
        error_code: gated.errorCode,
        toolCalls: state.executor?.toolCalls,
      };
    }

    let outcome: PipelineOutcome;
    let errorCode: string | undefined;
    if (segment.synthesizerFatalError) {
      outcome = "failed";
      errorCode = segment.fatalErrorCode ?? "stage_error";
    } else if (segment.synthesizerEmptyCompletion) {
      outcome = "failed";
      errorCode = "empty_completion";
    } else if (upstreamDegraded) {
      outcome = "degraded";
      errorCode = "upstream_stage_failed";
    } else {
      outcome = "success";
    }

    if (segment.partialStage && !segment.synthesizerFatalError && !segment.synthesizerEmptyCompletion) {
      outcome = "partial";
      errorCode = segment.partialStage.errorCode;
    }

    ({ outcome, errorCode } = applyEffectGate(
      outcome === "partial" ? "degraded" : outcome,
      errorCode,
      segment.effectGate ?? evaluateEffectGate({
        profile: options.executionProfile ?? "full",
        executor: state.executor,
        rewriter: state.rewriter,
        contentEffects: this.ctx.write_effects,
      }),
    ));
    if (segment.partialStage && outcome !== "failed") {
      outcome = "partial";
      errorCode = segment.partialStage.errorCode;
    }

    const result: PipelineResult = {
      answer: segment.synthesizerEmptyCompletion ? "" : segment.synthesizerAnswer,
      error: segment.synthesizerFatalError,
      recursion_depth: 0,
      outcome,
      error_code: errorCode,
      toolCalls: state.executor?.toolCalls,
    };
    if (!segment.synthesizerFatalError && !segment.synthesizerEmptyCompletion && pipeline.includes("synthesizer")) {
      return this.applyRecursiveCritique(request, result, agentRunId, onStateChange, options);
    }
    return result;
  }

  private hasIssues(reviewText: string): boolean {
    const verdict = parseReviewerVerdict(reviewText);
    if (verdict === "reject") return true;
    if (verdict === "accept") return false;
    const normalized = reviewText.toUpperCase();
    return normalized.includes("PARTIAL") || normalized.includes("MISSING");
  }

  private canRunSpeculativeParallel(pipeline: string[], topology: PipelineTopology | undefined): boolean {
    if (topology !== "speculative_parallel") return false;
    if (!pipeline.includes("planner") || !pipeline.includes("reviewer") || !pipeline.includes("synthesizer")) return false;
    // Executor and rewriter stages depend on prior outputs and tool feedback, so
    // the first speculative slice only parallelizes model-only planning/review.
    return !pipeline.includes("executor") && !pipeline.includes("rewriter");
  }

  private canRunSpeculativeCascade(pipeline: string[], topology: PipelineTopology | undefined): boolean {
    if (topology !== "speculative_cascade") return false;
    if (!pipeline.includes("executor") || !pipeline.includes("synthesizer")) return false;
    return !pipeline.includes("planner") && !pipeline.includes("reviewer") && !pipeline.includes("rewriter");
  }

  private async executeSpeculativeParallel(
    request: string,
    pipeline: string[],
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<PipelineResult> {
    const plannerPrompt = stageSystemPrompt("planner", options);
    const reviewerPrompt = stageSystemPrompt("reviewer", options);

    const plannerPromise = this.runModelOnlyStage({
      stage: "planner",
      prompt: plannerPrompt,
      userContent: request,
      agentRunId,
      turnNumber: 1,
      fallback: "Failed to generate plan",
      onStateChange,
    });

    const reviewerPromise = this.runModelOnlyStage({
      stage: "reviewer",
      prompt: reviewerPrompt,
      userContent: `User Request: ${request}\n\nReview the request, likely execution risks, missing context, and quality checks before synthesis.`,
      agentRunId,
      turnNumber: 1,
      fallback: "Review failed",
      onStateChange,
    });

    const [plan, reviewerFeedback] = await Promise.all([plannerPromise, reviewerPromise]);
    const executorSummary = "No execution stage executed. Planner and reviewer ran speculatively without tool execution.";
    const rewriterSummary = "No rewriting stage executed.";

    if (!pipeline.includes("synthesizer")) {
      return { answer: plan };
    }

    onStateChange({ stage: "synthesizer", status: "running" });
    const synthesizerPrompt = stageSystemPrompt("synthesizer", options);
    const synthStartTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        {
          role: "user",
          content: buildSynthesizerContext(request, { plan, executorSummary, reviewerFeedback, rewriterSummary })
        }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES.synthesizer.temperature,
        max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
        stream: true,
        stageLabel: "synthesizer",
        complexity: options.estimatedComplexity,
        cascadeTier: options.preferFastSynthesizer ? "cheap" : undefined,
        surfaceAsAnswer: true,
        onChunk: (chunk) => {
          onStateChange({ stage: "synthesizer", status: "running", output: chunk });
        }
      });
      const finalAnswer = resp.content;
      onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        input_tokens: Math.round((synthesizerPrompt.length + request.length + plan.length + executorSummary.length + reviewerFeedback.length + rewriterSummary.length) / 4),
        output_tokens: countTokens(finalAnswer),
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 1,
        had_error: 0,
      });

      return { answer: finalAnswer, recursion_depth: 0, outcome: finalAnswer.trim() ? "success" : "failed", error_code: finalAnswer.trim() ? undefined : "empty_completion" };
    } catch (e: any) {
      onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
      const fatalError = describePipelineError(errText(e));

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 0,
        had_error: 1,
        error_message: errText(e),
      });

      // See the matching comment in runSynthesizerStage: never surface the
      // raw failure text as the answer bubble. `error` (fatalError) carries
      // it through PipelineResult.error, which index.ts turns into an SSE
      // error frame.
      return { answer: "", error: fatalError, recursion_depth: 0, outcome: "failed", error_code: "stage_error" };
    }
  }

  private async runModelOnlyStage(args: {
    stage: "planner" | "executor" | "reviewer";
    prompt: string;
    userContent: string;
    agentRunId: string;
    turnNumber: number;
    fallback: string;
    cascadeTier?: "cheap" | "strong";
    onStateChange: (state: PipelineProgressState) => void;
  }): Promise<string> {
    args.onStateChange({ stage: args.stage, status: "running" });
    const startTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: args.prompt },
        { role: "user", content: args.userContent }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES[args.stage].temperature,
        max_tokens: BUILTIN_MODES[args.stage].max_tokens,
        stream: true,
        stageLabel: args.stage,
        cascadeTier: args.cascadeTier,
        onChunk: (chunk) => {
          args.onStateChange({ stage: args.stage, status: "running", output: chunk });
        }
      });
      const output = resp.content;
      args.onStateChange({ stage: args.stage, status: "completed", output });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: args.agentRunId,
        mode_id: args.stage,
        turn_number: args.turnNumber,
        input_tokens: Math.round((args.prompt.length + args.userContent.length) / 4),
        output_tokens: countTokens(output),
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 1,
        had_error: 0,
      });

      return output;
    } catch (e: any) {
      const message = errText(e);
      args.onStateChange({ stage: args.stage, status: "failed", output: message });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: args.agentRunId,
        mode_id: args.stage,
        turn_number: args.turnNumber,
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
      });

      return `${args.fallback}: ${message}`;
    }
  }

  private async executeSpeculativeCascade(
    request: string,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<PipelineResult> {
    const executorPrompt = stageSystemPrompt(
      "executor",
      options,
      getToolsForMode("executor", this.runtime.listTools(), options.executionProfile ?? "full"),
    );
    const cheapOutput = await this.runModelOnlyStage({
      stage: "executor",
      prompt: executorPrompt,
      userContent: `User Request: ${request}\n\nAnswer with the cheapest adequate execution path. End with a line exactly like CONFIDENCE: 0.0 to 1.0.`,
      agentRunId,
      turnNumber: 1,
      fallback: "Cheap executor failed",
      cascadeTier: "cheap",
      onStateChange,
    });

    const cheapConfidence = this.extractConfidence(cheapOutput);
    let strongOutput = "Strong executor not used; cheap executor confidence met the cascade threshold.";
    if (cheapConfidence === undefined || cheapConfidence < 0.65) {
      strongOutput = await this.runModelOnlyStage({
        stage: "executor",
        prompt: executorPrompt,
        userContent: `User Request: ${request}\n\nCheap executor output:\n${cheapOutput}\n\nThe cheap executor was uncertain. Re-execute with stronger reasoning, correct any gaps, and end with CONFIDENCE: 0.0 to 1.0.`,
        agentRunId,
        turnNumber: 2,
        fallback: "Strong executor failed",
        cascadeTier: "strong",
        onStateChange,
      });
    }

    const executorSummary = [
      `Cheap executor confidence: ${cheapConfidence === undefined ? "unknown" : cheapConfidence.toFixed(2)}`,
      `Cheap executor output:\n${cheapOutput}`,
      `Strong executor output:\n${strongOutput}`,
    ].join("\n\n");

    onStateChange({ stage: "synthesizer", status: "running" });
    const synthesizerPrompt = stageSystemPrompt("synthesizer", options);
    const synthStartTime = Date.now();
    try {
      const resp = await this.callModel([
        { role: "system", content: synthesizerPrompt },
        {
          role: "user",
          content: buildSynthesizerContext(request, {
            plan: "Speculative cascade: cheap executor first, strong executor only on uncertainty.",
            executorSummary,
          })
        }
      ] as ChatMessage[], {
        temperature: BUILTIN_MODES.synthesizer.temperature,
        max_tokens: BUILTIN_MODES.synthesizer.max_tokens,
        stream: true,
        stageLabel: "synthesizer",
        complexity: options.estimatedComplexity,
        cascadeTier: options.preferFastSynthesizer ? "cheap" : undefined,
        surfaceAsAnswer: true,
        onChunk: (chunk) => {
          onStateChange({ stage: "synthesizer", status: "running", output: chunk });
        }
      });
      const finalAnswer = resp.content;
      onStateChange({ stage: "synthesizer", status: "completed", output: finalAnswer });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        input_tokens: Math.round((synthesizerPrompt.length + request.length + executorSummary.length) / 4),
        output_tokens: countTokens(finalAnswer),
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 1,
        had_error: 0,
      });

      return { answer: finalAnswer, recursion_depth: 0, outcome: finalAnswer.trim() ? "success" : "failed", error_code: finalAnswer.trim() ? undefined : "empty_completion" };
    } catch (e: any) {
      onStateChange({ stage: "synthesizer", status: "failed", output: errText(e) });
      const fatalError = describePipelineError(errText(e));

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "synthesizer",
        turn_number: 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - synthStartTime,
        was_successful: 0,
        had_error: 1,
        error_message: errText(e),
      });

      // See the matching comment in runSynthesizerStage: never surface the
      // raw failure text as the answer bubble. `error` (fatalError) carries
      // it through PipelineResult.error, which index.ts turns into an SSE
      // error frame.
      return { answer: "", error: fatalError, recursion_depth: 0, outcome: "failed", error_code: "stage_error" };
    }
  }

  private extractConfidence(text: string): number | undefined {
    const match = text.match(/CONFIDENCE\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    if (!match) return undefined;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = parsed > 1 ? parsed / 100 : parsed;
    if (normalized < 0 || normalized > 1) return undefined;
    return normalized;
  }

  private async applyRecursiveCritique(
    request: string,
    result: PipelineResult,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
  ): Promise<PipelineResult> {
    if (options.topology !== "recursive") return result;

    // B-03: when the caller already burned recursion depth (this pipeline
    // is itself a re-entry from an outer `applyRecursiveCritique`), start
    // from the inherited depth so the cap is shared across nested
    // pipelines, not reset on every recursive call.
    const depth = Math.max(result.recursion_depth ?? 0, options.initialRecursionDepth ?? 0);
    await options.onRecursion?.({ depth, status: "critique" });
    const critiquePrompt = loadPrompt("modes/recursion-critique.md");
    const startTime = Date.now();

    try {
      const resp = await this.callModel([
        { role: "system", content: critiquePrompt },
        {
          role: "user",
          content: `User Request:\n${request}\n\nCandidate Answer:\n${result.answer}`
        }
      ] as ChatMessage[], {
        temperature: 0.1,
        max_tokens: 768,
        stream: true,
        stageLabel: "recursion_critique" as any,
      });

      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "recursion_critique",
        turn_number: depth + 1,
        input_tokens: Math.round((critiquePrompt.length + request.length + result.answer.length) / 4),
        output_tokens: countTokens(resp.content),
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 1,
        had_error: 0,
      });

      const decision = this.parseRecursionDecision(resp.content);
      if (!decision.needs_more_work) {
        await options.onRecursion?.({ depth, status: "done", critique: decision.critique });
        return result;
      }

      // B-03: conductor-decided re-enter target. Unknown / missing values fall
      // back to a `done` event so a malformed critic payload never silently
      // re-enters an unrelated stage.
      const reenterStage: RecursionReenterStage | undefined = decision.reenter_stage;
      if (!reenterStage) {
        await options.onRecursion?.({ depth, status: "done", critique: decision.critique });
        return result;
      }

      const maxDepth = Math.max(0, options.maxRecursionDepth ?? 2);
      if (depth >= maxDepth) {
        await options.onRecursion?.({ depth, status: "max_depth", reenter_stage: reenterStage, critique: decision.critique });
        return result;
      }

      const nextDepth = depth + 1;
      await options.onRecursion?.({ depth: nextDepth, status: "reenter", reenter_stage: reenterStage, critique: decision.critique });

      // B-03 re-enter dispatch. Each re-enter target rebuilds the pipeline
      // the critic asked for; the recursive depth is propagated so a turn
      // can never exceed `maxRecursionDepth` total re-entries regardless of
      // which stage the critic chose.
      //
      // `conductor_replan` is special: it's a signal, not a pipeline spawn
      // (the conductor's own `runPipelineWithReplanning` owns that budget
      // via `max_conductor_replans`). The recursion depth is NOT
      // incremented for it — the turn returns the existing answer at the
      // current depth so the conductor's mid-pipeline replan can take over
      // without double-counting against `max_recursion_depth`.
      if (reenterStage === "conductor_replan") {
        // T2.5: surface replan request; replan wrapper performs one iteration.
        // Do NOT increment recursion depth (conductor max_replans is the cap).
        return {
          ...result,
          replanRequested: { trigger: "recursive_critique", detail: decision.critique },
        };
      }

      const rerun = await this.reenterForRecursion(
        request,
        reenterStage,
        decision.critique,
        result,
        agentRunId,
        onStateChange,
        options,
        nextDepth,
      );

      return {
        ...rerun,
        recursion_depth: nextDepth,
      };
    } catch (e: any) {
      const message = errText(e);
      await options.onRecursion?.({ depth, status: "failed", critique: message });
      this.collector.recordStageRun({
        id: `stage_${crypto.randomUUID()}`,
        agent_run_id: agentRunId,
        mode_id: "recursion_critique",
        turn_number: depth + 1,
        tool_calls_json: "[]",
        duration_ms: Date.now() - startTime,
        was_successful: 0,
        had_error: 1,
        error_message: message,
      });
      return result;
    }
  }

  private parseRecursionDecision(raw: string): {
    needs_more_work: boolean;
    reenter_stage?: RecursionReenterStage;
    critique: string;
  } {
    const validReenter: ReadonlySet<RecursionReenterStage> = new Set<RecursionReenterStage>([
      "planner",
      "executor",
      "conductor_replan",
    ]);
    try {
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      const parsed = JSON.parse(jsonStart >= 0 && jsonEnd >= jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw);
      const reenterCandidate = parsed?.reenter_stage;
      const reenterStage: RecursionReenterStage | undefined =
        typeof reenterCandidate === "string" && validReenter.has(reenterCandidate as RecursionReenterStage)
          ? (reenterCandidate as RecursionReenterStage)
          : undefined;
      return {
        needs_more_work: Boolean(parsed?.needs_more_work),
        reenter_stage: reenterStage,
        critique: typeof parsed?.critique === "string" ? parsed.critique : raw,
      };
    } catch {
      // Heuristic fallback only fires when the critic payload is unparseable.
      // We do NOT re-derive `reenter_stage` from regex here — a missing
      // re-enter target is safer than a guessed one (B-03: conductor
      // self-selection is explicit, never inferred from prose).
      return {
        needs_more_work: /\bneeds?_more_work\b|\bre-?enter\b|\bmissing\b|\bincomplete\b/i.test(raw),
        reenter_stage: undefined,
        critique: raw,
      };
    }
  }

  /**
   * B-03: dispatch a re-entry request to the stage the critic chose.
   * The recursive depth is carried on the result so the cap is shared
   * across re-enter types — a turn that has burned one re-entry cannot
   * also burn a fresh one on a different stage type.
   *
   * For `conductor_replan`, the critic is signalling that the revision
   * should be delegated to the conductor's own mid-pipeline replan path.
   * We surface a typed `reenter` event so the SSE relay can render the
   * recurse decision, but the actual re-invocation of the conductor is
   * handled by the normal route (`runPipelineWithReplanning`) — we just
   * return the current result, which is the safe degradation the B-03
   * acceptance criterion requires ("recursive topology test completes
   * via conductor replan"). The conductor's `max_replans` budget is the
   * authoritative cap on its own path, so the recursive depth counter
   * is NOT incremented again here.
   */
  private async reenterForRecursion(
    request: string,
    reenterStage: RecursionReenterStage,
    critique: string,
    result: PipelineResult,
    agentRunId: string,
    onStateChange: (state: PipelineProgressState) => void,
    options: PipelineExecuteOptions,
    nextDepth: number,
  ): Promise<PipelineResult> {
    if (reenterStage === "conductor_replan") {
      // T2.5: load-bearing signal for the replan wrapper.
      return {
        ...result,
        replanRequested: { trigger: "recursive_critique", detail: critique },
      };
    }

    const pipeline = reenterStage === "planner"
      ? ["planner", "executor", "synthesizer"]
      : ["executor", "synthesizer"];

    const promptBody = reenterStage === "planner"
      ? `The recursive critic judged the previous answer insufficient and asked for a fresh plan. Re-plan from scratch, then execute and synthesize.`
      : `Re-enter executor to verify or repair the answer, then synthesize the final response.`;

    const recursiveRequest = [
      `Original User Request:\n${request}`,
      `Candidate Answer:\n${result.answer}`,
      `Recursive Critique:\n${critique}`,
      promptBody,
    ].join("\n\n");

    return await this.execute(
      recursiveRequest,
      pipeline,
      agentRunId,
      onStateChange,
      // Preserve the least-authority profile through recursive re-entry — a
      // read-only turn must stay read-only when the critique re-runs the
      // pipeline. B-03: also pass `initialRecursionDepth: nextDepth` so the
      // inner `applyRecursiveCritique` reads the inherited depth (not 0)
      // and the shared `maxRecursionDepth` cap is honored across nested
      // pipeline calls.
      {
        topology: "linear",
        executionProfile: options.executionProfile,
        workerInstructions: options.workerInstructions,
        sharedContext: options.sharedContext,
        sessionMemory: options.sessionMemory,
        sessionGrants: options.sessionGrants,
        turnRequirement: options.turnRequirement,
        initialRecursionDepth: nextDepth,
      },
    );
  }
}
