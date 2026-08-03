// ═══════════════════════════════════════════════════════════════
// ── Conductor performance — release metrics over stored runs ──
// ═══════════════════════════════════════════════════════════════
//
// Pure aggregation over the same self-tuning rows the layer-1 replay harness
// reads. No network, no model calls, no deploy. Produces the release-gate
// numbers from the 2026-08-01 completion-integrity plan:
//
//   - executor no-tool ratio ≤ 10%
//   - delegate verified-write rate ≥ 80% (once ≥5 delegate fixtures exist)
//   - zero unverified successes (success + write intent + check_tier none)
//   - zero false-complete runs (success that declares incomplete progress)
//   - zero duplicate write-pressure runs (write-effect note injected >1×)
//
// Delegate identity (W2.1): primary signal is model_attributions.provider
// === "claude_cli"; legacy delegate_cleanup is a fallback. Verified writes
// must land on the *delegate stage row* — a later native-fallback executor
// write does not count (no same-run write fallback).
//
// The CLI (`scripts/benchmark-conductor-completion.ts`) loads SQLite and
// prints these metrics; unit tests feed hand-built fixtures.

import type { ConductorDirectiveRow, ModelAttribution, StageRun } from "../self-tuning/store";

/** One stored turn, assembled from the tables keyed by agent_run_id. */
export interface ConductorPerformanceFixture {
  agentRunId: string;
  taskType?: string;
  /** success | partial | failed | degraded, when the run reached a verdict. */
  outcome?: string | null;
  /** agent_runs.final_output — used by false-complete detection. */
  finalOutput?: string | null;
  /** agent_runs.verified_via. */
  verifiedVia?: string | null;
  /** agent_runs.check_tier (builtin/existing/none/…). */
  checkTier?: string | null;
  stageRuns: StageRun[];
  directives: ConductorDirectiveRow[];
  /**
   * model_attributions for this run. Primary signal for delegate detection:
   * provider === "claude_cli" (pipeline records this for the Claude delegate path).
   * Optional so older hand fixtures / partial loaders still work via cleanup fallback.
   */
  modelAttributions?: ModelAttribution[];
}

export interface ConductorPerformanceThresholds {
  maxExecutorNoToolRatio: number;
  minDelegateVerifiedWriteRate: number;
  maxUnverifiedSuccesses: number;
  maxFalseCompleteRuns: number;
  maxDuplicateWritePressureRuns: number;
}

export const RELEASE_THRESHOLDS: ConductorPerformanceThresholds = {
  maxExecutorNoToolRatio: 0.1,
  minDelegateVerifiedWriteRate: 0.8,
  maxUnverifiedSuccesses: 0,
  maxFalseCompleteRuns: 0,
  maxDuplicateWritePressureRuns: 0,
};

/** Minimum delegate fixtures before the verified-write rate is a hard gate. */
export const MIN_DELEGATE_SAMPLE = 5;

export type DelegateGate = "pass" | "fail" | "insufficient_sample" | "not_applicable";

export type GateFailureCode =
  | "executor_no_tool_ratio"
  | "delegate_verified_write_rate"
  | "unverified_successes"
  | "false_complete_runs"
  | "duplicate_write_pressure_runs";

export interface ConductorPerformanceSummary {
  runs: number;
  executorTurns: number;
  executorNoToolTurns: number;
  /** 0 when there are no executor turns. */
  executorNoToolRatio: number;
  delegateRuns: number;
  delegateVerifiedWrites: number;
  /**
   * Verified delegate writes / delegate runs. 0 when there are no delegate
   * fixtures (not null — keeps toMatchObject stable).
   */
  delegateVerifiedWriteRate: number;
  unverifiedSuccesses: number;
  falseCompleteRuns: number;
  duplicateWritePressureRuns: number;
  /** Whether every hard release threshold passes (delegate soft below sample). */
  meetsReleaseGate: boolean;
  gateFailures: GateFailureCode[];
  /** Delegate-rate gate status; insufficient_sample when N < MIN_DELEGATE_SAMPLE. */
  delegateGate: DelegateGate;
}

/** Tools whose successful call actually mutates a file. */
const WRITE_EFFECT_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

/**
 * Emitted only on the delegate path, which `delegateEligibility` gates on
 * `writeEffectRequired` — so seeing it is proof a write was expected.
 * Kept as a secondary/fallback signal; primary is model_attributions.provider.
 */
const DELEGATE_MARKER_TOOL = "delegate_cleanup";

/**
 * Pipeline records this provider on model_attributions for Claude-CLI
 * delegate stages (see pipeline.ts). Present on good-era (07-25) minimax runs
 * that rarely emitted delegate_cleanup.
 */
const DELEGATE_PROVIDER = "claude_cli";

/**
 * Task 1 incomplete-language backstop — same family as conductor-replay and
 * task-run so a "success" that admits incompleteness is a false complete.
 */
const INCOMPLETE_PROGRESS_PATTERN =
  /\b(?:incomplete|unfinished|cut short|partial(?:ly)?|could not be (?:confirmed|completed|applied|written|verified)|not (?:yet )?(?:been )?(?:applied|completed|confirmed|written|started)|not yet complete|was not (?:applied|modified|updated|written)|remains? (?:unchanged|unmodified|unapplied|to be)|more (?:files|work|evidence)|still (?:need|needs|needed|remains?|pending)|not enough evidence|could not gather|unable to complete|remaining work)\b/i;

interface ParsedToolCall {
  name?: string;
  is_error?: boolean;
  output?: unknown;
}

function parseToolCalls(raw: string | undefined): ParsedToolCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ParsedToolCall[]) : [];
  } catch {
    return [];
  }
}

function parseToolCallCount(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    // Unparseable is not evidence of a no-op (matches conductor-replay).
    return 1;
  }
}

function isWritePressureNote(note: string | undefined | null): boolean {
  if (!note) return false;
  return (
    note.includes("CHANGE request")
    && (note.includes("write tools") || note.includes("write tool"))
  );
}

function stageHasSuccessfulWrite(stage: StageRun): boolean {
  const calls = parseToolCalls(stage.tool_calls_json);
  return calls.some(
    (c) => c.name && WRITE_EFFECT_TOOLS.has(c.name) && c.is_error !== true,
  );
}

function stageHasDelegateCleanup(stage: StageRun): boolean {
  return parseToolCalls(stage.tool_calls_json).some((c) => c.name === DELEGATE_MARKER_TOOL);
}

/** Pipeline persists { delegate_request_id, ... } on Claude-delegate stage rows. */
function stageHasDelegateDiagnostic(stage: StageRun): boolean {
  const raw = stage.diagnostic_json;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return false;
    return typeof parsed.delegate_request_id === "string"
      || Object.keys(parsed).some((k) => k.startsWith("delegate_"));
  } catch {
    return raw.includes("delegate_request_id");
  }
}

function claudeCliAttributions(fixture: ConductorPerformanceFixture): ModelAttribution[] {
  return (fixture.modelAttributions ?? []).filter((a) => a.provider === DELEGATE_PROVIDER);
}

/**
 * Earliest executor stage by turn_number (then created_at). Used as the
 * attribution-only delegate-stage proxy when cleanup/diagnostic markers are
 * absent (good-era minimax rows).
 */
function firstExecutorStage(stages: readonly StageRun[]): StageRun | undefined {
  const executors = stages.filter((s) => s.mode_id === "executor");
  if (executors.length === 0) return undefined;
  return [...executors].sort((a, b) => {
    if (a.turn_number !== b.turn_number) return a.turn_number - b.turn_number;
    const ac = a.created_at ?? "";
    const bc = b.created_at ?? "";
    if (ac < bc) return -1;
    if (ac > bc) return 1;
    return 0;
  })[0];
}

function runHasWriteIntent(fixture: ConductorPerformanceFixture): boolean {
  const calls = fixture.stageRuns.flatMap((s) => parseToolCalls(s.tool_calls_json));
  return calls.some(
    (c) => c.name === DELEGATE_MARKER_TOOL || (c.name && WRITE_EFFECT_TOOLS.has(c.name)),
  );
}

/**
 * Primary: any model_attributions row with provider === "claude_cli".
 * Fallback: legacy `delegate_cleanup` tool marker (sparse in good-era data).
 */
function isDelegateRun(fixture: ConductorPerformanceFixture): boolean {
  if (claudeCliAttributions(fixture).length > 0) return true;
  return fixture.stageRuns.some(stageHasDelegateCleanup);
}

/**
 * A delegate fixture is "verified" only when a successful write-effect tool
 * lands on the *delegate stage row* — never a later native-fallback write.
 *
 * Identification of that row (in order):
 *   1. Any stage with `delegate_cleanup` → write must be in that same row.
 *   2. Else, attributed stages (`mode_id` ∈ claude_cli attribution stage_ids)
 *      with diagnostic_json marking the Claude delegate → write in that row.
 *   3. Else (attribution-only / good-era): the first executor stage
 *      (min turn_number) among stages whose mode_id is attributed — write
 *      must be there. Later executor stages are treated as native fallback.
 *
 * There is intentionally no "any write in the run" fallback.
 */
function isDelegateVerifiedWrite(fixture: ConductorPerformanceFixture): boolean {
  // (1) Cleanup marker: same-row write only.
  for (const stage of fixture.stageRuns) {
    if (stageHasDelegateCleanup(stage) && stageHasSuccessfulWrite(stage)) return true;
  }

  const attrs = claudeCliAttributions(fixture);
  if (attrs.length === 0) return false;

  const attributedStageIds = new Set(attrs.map((a) => a.stage_id));
  const attributedStages = fixture.stageRuns.filter((s) => attributedStageIds.has(s.mode_id));

  // (2) Diagnostic-marked delegate stage rows.
  for (const stage of attributedStages) {
    if (stageHasDelegateDiagnostic(stage) && stageHasSuccessfulWrite(stage)) return true;
  }

  // (3) Attribution-only: only the first executor stage can be the delegate.
  // Later executor stages are assumed native fallback and must not credit.
  const first = firstExecutorStage(attributedStages);
  if (first && stageHasSuccessfulWrite(first)) return true;

  return false;
}

function isUnverifiedSuccess(fixture: ConductorPerformanceFixture): boolean {
  if (fixture.outcome !== "success") return false;
  if (!runHasWriteIntent(fixture)) return false;
  const tier = fixture.checkTier ?? null;
  return !tier || tier === "none";
}

function isFalseComplete(fixture: ConductorPerformanceFixture): boolean {
  if (fixture.outcome !== "success") return false;
  const answer = (fixture.finalOutput ?? "").trim();
  return Boolean(answer && INCOMPLETE_PROGRESS_PATTERN.test(answer));
}

function hasDuplicateWritePressure(fixture: ConductorPerformanceFixture): boolean {
  let count = 0;
  for (const d of fixture.directives) {
    if (isWritePressureNote(d.inject_note)) count += 1;
  }
  return count > 1;
}

export function summarizeConductorPerformance(
  fixtures: readonly ConductorPerformanceFixture[],
  thresholds: ConductorPerformanceThresholds = RELEASE_THRESHOLDS,
): ConductorPerformanceSummary {
  let executorTurns = 0;
  let executorNoToolTurns = 0;
  let delegateRuns = 0;
  let delegateVerifiedWrites = 0;
  let unverifiedSuccesses = 0;
  let falseCompleteRuns = 0;
  let duplicateWritePressureRuns = 0;

  for (const fixture of fixtures) {
    const executorStages = fixture.stageRuns.filter((s) => s.mode_id === "executor");
    for (const s of executorStages) {
      executorTurns += 1;
      if (parseToolCallCount(s.tool_calls_json) === 0) executorNoToolTurns += 1;
    }

    if (isDelegateRun(fixture)) {
      delegateRuns += 1;
      if (isDelegateVerifiedWrite(fixture)) delegateVerifiedWrites += 1;
    }

    if (isUnverifiedSuccess(fixture)) unverifiedSuccesses += 1;
    if (isFalseComplete(fixture)) falseCompleteRuns += 1;
    if (hasDuplicateWritePressure(fixture)) duplicateWritePressureRuns += 1;
  }

  const executorNoToolRatio = executorTurns === 0 ? 0 : executorNoToolTurns / executorTurns;
  const delegateVerifiedWriteRate =
    delegateRuns === 0 ? 0 : delegateVerifiedWrites / delegateRuns;

  let delegateGate: DelegateGate;
  if (delegateRuns === 0) {
    delegateGate = "not_applicable";
  } else if (delegateRuns < MIN_DELEGATE_SAMPLE) {
    delegateGate = "insufficient_sample";
  } else if (delegateVerifiedWriteRate >= thresholds.minDelegateVerifiedWriteRate) {
    delegateGate = "pass";
  } else {
    delegateGate = "fail";
  }

  const gateFailures: GateFailureCode[] = [];
  if (executorNoToolRatio > thresholds.maxExecutorNoToolRatio) {
    gateFailures.push("executor_no_tool_ratio");
  }
  if (delegateGate === "fail") {
    gateFailures.push("delegate_verified_write_rate");
  }
  if (unverifiedSuccesses > thresholds.maxUnverifiedSuccesses) {
    gateFailures.push("unverified_successes");
  }
  if (falseCompleteRuns > thresholds.maxFalseCompleteRuns) {
    gateFailures.push("false_complete_runs");
  }
  if (duplicateWritePressureRuns > thresholds.maxDuplicateWritePressureRuns) {
    gateFailures.push("duplicate_write_pressure_runs");
  }

  return {
    runs: fixtures.length,
    executorTurns,
    executorNoToolTurns,
    executorNoToolRatio,
    delegateRuns,
    delegateVerifiedWrites,
    delegateVerifiedWriteRate,
    unverifiedSuccesses,
    falseCompleteRuns,
    duplicateWritePressureRuns,
    meetsReleaseGate: gateFailures.length === 0,
    gateFailures,
    delegateGate,
  };
}

/** Convenience for callers that already hold a summary. */
export function meetsReleaseGate(
  summary: ConductorPerformanceSummary,
  _thresholds: ConductorPerformanceThresholds = RELEASE_THRESHOLDS,
): boolean {
  return summary.meetsReleaseGate;
}
