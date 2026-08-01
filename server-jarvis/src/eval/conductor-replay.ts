// ═══════════════════════════════════════════════════════════════
// ── Conductor replay — layer 1: invariant checks over stored runs ──
// ═══════════════════════════════════════════════════════════════
//
// `self-tuning.db` accumulates a complete record of every orchestrated turn:
// the stage sequence, each stage's tool calls, and every conductor directive
// including the verbatim text of any note injected into the executor
// transcript. Until now that record was effectively write-only — the
// self-tuner reads narrow slices of it and nothing else does.
//
// That gap has a measurable cost. On 2026-07-31 two production defects were
// diagnosed by deploying instrumented builds and reading server logs, a loop
// costing minutes per iteration plus a ~400k-token live turn per attempt.
// BOTH defects were already sitting in the database:
//
//   - the same plan-remainder note stored 56x byte-identical under one
//     agent_run_id (`conductor_directives.inject_note`)
//   - a stage-output placeholder, "No planning stage executed.", embedded in
//     a model-facing instruction
//
// A query would have surfaced either in milliseconds. This module turns that
// query into a standing gate: pure predicates over stored rows, no network, no
// model calls, no deploy. It is the offline half of the conductor iteration
// loop — the half that makes a change measurable before it ships.
//
// Scope note: these are INVARIANT checks, not a counterfactual simulator.
// Replaying a different routing decision cannot tell us what the executor
// would then have done, because that behaviour is not reproducible offline.
// What this can do is assert properties that must hold on any healthy run,
// and catch a regression the moment it appears in the trace record.

import type { ConductorDirectiveRow, StageRun } from "../self-tuning/store";

/** A single stored turn, assembled from the tables keyed by agent_run_id. */
export interface ReplayRun {
  agentRunId: string;
  taskType?: string;
  /** success | partial | failed | degraded, when the run reached a verdict. */
  outcome?: string | null;
  stageRuns: StageRun[];
  directives: ConductorDirectiveRow[];
}

export type ReplayRule =
  | "repeated_nudge"
  | "placeholder_in_note"
  | "stage_deadline_exceeded"
  | "noop_executor_turns"
  | "turn_cap_saturation";

export interface ReplayViolation {
  rule: ReplayRule;
  agentRunId: string;
  severity: "high" | "medium";
  /** Human-readable, already truncated for terminal output. */
  detail: string;
  /** Occurrences behind this violation (repeat count, turn count, …). */
  count: number;
}

export interface ReplayThresholds {
  /** Max times one note text may be injected into a single run. */
  maxIdenticalNudges: number;
  /** Fraction of executor turns that may produce no tool call. */
  maxNoopExecutorRatio: number;
  /** Executor turns required before the no-op ratio is meaningful. */
  minExecutorTurnsForRatio: number;
  /** Consecutive segments ending exactly at the cap before flagging. */
  maxSegmentsAtTurnCap: number;
  /** Turn number treated as the executor loop ceiling (modes.ts full+write). */
  executorTurnCap: number;
}

/**
 * Deliberately set at the edge of observed-healthy behaviour rather than at
 * the observed-pathological values, so a regression trips the gate well before
 * it reaches the severity seen in run_2c46d082 (56 repeats, 76% no-op turns).
 */
export const DEFAULT_REPLAY_THRESHOLDS: ReplayThresholds = {
  maxIdenticalNudges: 2,
  maxNoopExecutorRatio: 0.5,
  minExecutorTurnsForRatio: 4,
  maxSegmentsAtTurnCap: 2,
  executorTurnCap: 12,
};

/**
 * Rendering placeholders emitted by `stage-output.ts` when a stage did not
 * run. Any of these reaching a model-facing note means the model was handed a
 * null to act on. Kept as substrings because notes embed them mid-sentence.
 */
const STAGE_PLACEHOLDERS = [
  "No planning stage executed.",
  "No execution stage executed.",
  "No review stage executed.",
  "No rewriting stage executed.",
];

const STAGE_DEADLINE_MARKER = "Stage deadline exceeded";

function truncate(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function parseToolCallCount(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    // A row we cannot parse is not evidence of a no-op; treat it as active so
    // a serialization change can never manufacture a spin finding.
    return 1;
  }
}

/**
 * Executor turn numbers restart at 1 for each segment (a reroute or replan
 * re-enters the stage with a fresh budget). Split on the restart so segment
 * length can be measured — three segments that each ran to exactly the cap is
 * the signature of a loop being held open rather than completing.
 */
function executorSegmentLengths(stageRuns: StageRun[]): number[] {
  const lengths: number[] = [];
  let current = 0;
  let previousTurn = 0;
  for (const run of stageRuns) {
    if (run.mode_id !== "executor") continue;
    const turn = run.turn_number ?? 0;
    if (turn <= previousTurn && current > 0) {
      lengths.push(current);
      current = 0;
    }
    current += 1;
    previousTurn = turn;
  }
  if (current > 0) lengths.push(current);
  return lengths;
}

function checkRepeatedNudges(run: ReplayRun, t: ReplayThresholds): ReplayViolation[] {
  const counts = new Map<string, number>();
  for (const directive of run.directives) {
    const note = directive.inject_note?.trim();
    if (!note) continue;
    counts.set(note, (counts.get(note) ?? 0) + 1);
  }
  const out: ReplayViolation[] = [];
  for (const [note, count] of counts) {
    if (count <= t.maxIdenticalNudges) continue;
    out.push({
      rule: "repeated_nudge",
      agentRunId: run.agentRunId,
      severity: "high",
      count,
      detail: `note injected ${count}x byte-identical: "${truncate(note, 90)}"`,
    });
  }
  return out;
}

function checkPlaceholderNotes(run: ReplayRun): ReplayViolation[] {
  const out: ReplayViolation[] = [];
  const seen = new Set<string>();
  for (const directive of run.directives) {
    const note = directive.inject_note;
    if (!note) continue;
    const hit = STAGE_PLACEHOLDERS.find((p) => note.includes(p));
    if (!hit || seen.has(hit)) continue;
    seen.add(hit);
    out.push({
      rule: "placeholder_in_note",
      agentRunId: run.agentRunId,
      severity: "high",
      count: 1,
      detail: `model-facing note contains the stage placeholder "${hit}" — the model was told to act on a null`,
    });
  }
  return out;
}

function checkStageDeadlines(run: ReplayRun): ReplayViolation[] {
  const out: ReplayViolation[] = [];
  for (const stage of run.stageRuns) {
    const message = stage.error_message ?? "";
    if (!message.includes(STAGE_DEADLINE_MARKER)) continue;
    out.push({
      rule: "stage_deadline_exceeded",
      agentRunId: run.agentRunId,
      severity: "high",
      count: 1,
      detail: `stage=${stage.mode_id} died on its own deadline after ${stage.duration_ms ?? "?"}ms — the stage produced nothing`,
    });
  }
  return out;
}

function checkNoopExecutorTurns(run: ReplayRun, t: ReplayThresholds): ReplayViolation[] {
  const executorRuns = run.stageRuns.filter((s) => s.mode_id === "executor");
  if (executorRuns.length < t.minExecutorTurnsForRatio) return [];
  const noop = executorRuns.filter((s) => parseToolCallCount(s.tool_calls_json) === 0);
  const ratio = noop.length / executorRuns.length;
  if (ratio <= t.maxNoopExecutorRatio) return [];
  const wastedMs = noop.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
  return [{
    rule: "noop_executor_turns",
    agentRunId: run.agentRunId,
    severity: "high",
    count: noop.length,
    detail:
      `${noop.length}/${executorRuns.length} executor turns made no tool call ` +
      `(${Math.round(ratio * 100)}%), costing ${Math.round(wastedMs / 1000)}s of model round-trips`,
  }];
}

function checkTurnCapSaturation(run: ReplayRun, t: ReplayThresholds): ReplayViolation[] {
  const atCap = executorSegmentLengths(run.stageRuns).filter((n) => n >= t.executorTurnCap);
  if (atCap.length <= t.maxSegmentsAtTurnCap) return [];
  return [{
    rule: "turn_cap_saturation",
    agentRunId: run.agentRunId,
    severity: "medium",
    count: atCap.length,
    detail:
      `${atCap.length} executor segments each ran to the ${t.executorTurnCap}-turn cap without ` +
      "exiting naturally — the loop is being held open, not completing",
  }];
}

/** Every invariant, evaluated against one stored run. Pure. */
export function checkReplayInvariants(
  run: ReplayRun,
  thresholds: ReplayThresholds = DEFAULT_REPLAY_THRESHOLDS,
): ReplayViolation[] {
  return [
    ...checkRepeatedNudges(run, thresholds),
    ...checkPlaceholderNotes(run),
    ...checkStageDeadlines(run),
    ...checkNoopExecutorTurns(run, thresholds),
    ...checkTurnCapSaturation(run, thresholds),
  ];
}

export interface ReplayRuleSummary {
  rule: ReplayRule;
  severity: "high" | "medium";
  violations: number;
  affectedRuns: number;
  /** Worst single occurrence, for the report headline. */
  worstDetail: string;
}

export interface ReplaySummary {
  totalViolations: number;
  byRule: ReplayRuleSummary[];
}

/** Group violations for reporting: severity first, then volume. */
export function summarizeViolations(violations: ReplayViolation[]): ReplaySummary {
  const grouped = new Map<ReplayRule, ReplayViolation[]>();
  for (const violation of violations) {
    const bucket = grouped.get(violation.rule) ?? [];
    bucket.push(violation);
    grouped.set(violation.rule, bucket);
  }
  const byRule: ReplayRuleSummary[] = [...grouped.entries()].map(([rule, items]) => {
    const worst = [...items].sort((a, b) => b.count - a.count)[0]!;
    return {
      rule,
      severity: worst.severity,
      violations: items.length,
      affectedRuns: new Set(items.map((i) => i.agentRunId)).size,
      worstDetail: worst.detail,
    };
  });
  byRule.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    return b.violations - a.violations;
  });
  return { totalViolations: violations.length, byRule };
}
