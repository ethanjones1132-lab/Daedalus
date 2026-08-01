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
// The CLI (`scripts/benchmark-conductor-completion.ts`) loads SQLite and
// prints these metrics; unit tests feed hand-built fixtures.

import type { ConductorDirectiveRow, StageRun } from "../self-tuning/store";

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
 */
const DELEGATE_MARKER_TOOL = "delegate_cleanup";

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

function runHasWriteIntent(fixture: ConductorPerformanceFixture): boolean {
  const calls = fixture.stageRuns.flatMap((s) => parseToolCalls(s.tool_calls_json));
  return calls.some(
    (c) => c.name === DELEGATE_MARKER_TOOL || (c.name && WRITE_EFFECT_TOOLS.has(c.name)),
  );
}

function isDelegateRun(fixture: ConductorPerformanceFixture): boolean {
  const calls = fixture.stageRuns.flatMap((s) => parseToolCalls(s.tool_calls_json));
  return calls.some((c) => c.name === DELEGATE_MARKER_TOOL);
}

/**
 * A delegate fixture is "verified" when a successful write-effect tool appears
 * in the same stage row as `delegate_cleanup` (the primary write path, not a
 * later native fallback).
 */
function isDelegateVerifiedWrite(fixture: ConductorPerformanceFixture): boolean {
  for (const stage of fixture.stageRuns) {
    const calls = parseToolCalls(stage.tool_calls_json);
    if (!calls.some((c) => c.name === DELEGATE_MARKER_TOOL)) continue;
    const wroteInRow = calls.some(
      (c) => c.name && WRITE_EFFECT_TOOLS.has(c.name) && c.is_error !== true,
    );
    if (wroteInRow) return true;
  }
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
