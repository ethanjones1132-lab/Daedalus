// server-jarvis/src/orchestration/replan-telemetry.ts
// ═══════════════════════════════════════════════════════════════
// B-04 (Track B, Conductor Recursive Self-Selection): per-replan
// telemetry and per-session replan budget. B-02 added a per-TURN
// cap (`orchestrator.max_conductor_replans`); this module adds the
// matching per-SESSION cap (`orchestrator.max_conductor_replans_per_session`)
// so a long-lived session can't slowly accumulate replan spend across
// many turns, plus a persistent `replan_events` row per re-invocation
// so "did the conductor start thrashing?" is answerable with SQL.
// See docs/issues/post-phase-4-conductor-evolution.md B-04.
// ═══════════════════════════════════════════════════════════════

import type { CoordinatorResult } from "./coordinator";
import type { PipelineStageState } from "./stage-output";
import type { ReplanEvent } from "../self-tuning/store";
import { SelfTuningStore } from "../self-tuning/store";

/**
 * Bound on the rationale text we persist. The conductor's
 * `coordinator_rationale` is free-form prose and can be a few KB
 * on a chatty model; the telemetry column is for grep-ability, not
 * full-text search, so 500 chars is plenty.
 */
const RATIONALE_MAX = 500;

export type ReplanCapKind = "" | "per_turn" | "per_session";

export interface RecordReplanInput {
  sessionId: string;
  agentRunId: string;
  /** 1-indexed position of THIS replan within the calling turn. */
  replanIndex: number;
  /** Why the segment that just ran was insufficient; the conductor's own words. */
  rationale: string;
  /** The decision the conductor returned for the next segment. */
  revised: CoordinatorResult;
  /** Outcome of the segment that just ran (e.g. "success" | "degraded" | "failed"). */
  segmentOutcome: string;
  /** Which cap, if any, was the binding constraint that stopped the loop. */
  cap: ReplanCapKind;
}

export interface SessionReplanCounterOptions {
  /** Per-session cumulative cap. The effective per-turn cap is the min of
   *  this and the caller's per-turn `maxReplans`, so the smaller of the two
   *  wins. Must be `>= 0`. */
  maxPerSession: number;
  /** Optional store for persistent telemetry. When omitted (or DB open fails)
   *  the counter still works in-process; replan events are simply not
   *  persisted. Tests pass `null` to keep the DB out of the picture. */
  store?: SelfTuningStore | null;
}

/**
 * In-process, per-session cumulative counter for `conductor_replan`
 * re-invocations. Constructed once at server boot and shared across
 * every `runPipelineWithReplanning` call. The counter is purely additive:
 * `record()` increments, `used()` reads, `clearSession()` resets one
 * session (called from the existing session-reset path in index.ts).
 *
 * Why an in-process map and not just an SQL counter?  A single
 * `runPipelineWithReplanning` call may invoke the conductor several
 * times in a row; the counter needs to be hot-path cheap. We do
 * mirror writes to the DB for long-term visibility, but the budget
 * decision itself uses the in-memory number, not a SQL count.
 */
export class SessionReplanCounter {
  private readonly usedBySession = new Map<string, number>();
  private readonly maxPerSession: number;
  private readonly store: SelfTuningStore | null;

  constructor(opts: SessionReplanCounterOptions) {
    this.maxPerSession = Math.max(0, opts.maxPerSession);
    this.store = opts.store ?? null;
  }

  /** How many replans this session has spent so far. */
  used(sessionId: string): number {
    return this.usedBySession.get(sessionId) ?? 0;
  }

  /** How many replans this session may still spend. Never negative. */
  remaining(sessionId: string): number {
    return Math.max(0, this.maxPerSession - this.used(sessionId));
  }

  /**
   * Effective per-turn replan cap for the next `runPipelineWithReplanning`
   * call: the smaller of the caller's per-turn `maxReplans` and the
   * session's configured `maxPerSession` cap (NOT `remaining`, because
   * the loop body checks `replans >= perTurnCap` and we want "max=2"
   * to mean "up to 2 replans in this turn", not "up to 2 MINUS what's
   * already used in earlier turns of the same session"). The session's
   * `remaining()` is checked separately as a `sessionCapHit` signal so
   * an already-exhausted session can never run a single extra replan.
   */
  effectivePerTurnCap(sessionId: string, callerPerTurnMax: number): number {
    return Math.max(0, Math.min(callerPerTurnMax, this.maxPerSession));
  }

  /**
   * Record a single replan event. Increments the in-memory counter and,
   * if a store is configured, persists a `replan_events` row. The DB
   * write is best-effort: any error is logged by the store and never
   * rethrown, so a flaky DB cannot turn a successful replan into a
   * turn-aborting error.
   *
   * Returns the next `replan_index` (i.e. `used(sessionId)` AFTER the
   * increment) so the caller can put the same value in any in-process
   * event payload it broadcasts.
   */
  record(input: RecordReplanInput): number {
    const next = (this.usedBySession.get(input.sessionId) ?? 0) + 1;
    this.usedBySession.set(input.sessionId, next);

    if (this.store) {
      const workerKeys = input.revised.worker_instructions
        ? Object.keys(input.revised.worker_instructions).sort().join(",")
        : "";
      const ev: ReplanEvent = {
        id: `replan-${input.agentRunId}-${next}`,
        agent_run_id: input.agentRunId,
        session_id: input.sessionId,
        replan_index: next,
        rationale: truncate(input.rationale, RATIONALE_MAX),
        revised_pipeline: JSON.stringify(input.revised.pipeline ?? []),
        revised_worker_instructions_keys: workerKeys,
        segment_outcome: input.segmentOutcome,
        capped: input.cap,
      };
      this.store.insertReplanEvent(ev);
    }

    return next;
  }

  /**
   * Reset the counter for a single session. Called from the existing
   * session-reset path (the `POST /sessions/:sid/interaction` reset
   * handler in index.ts line 3099) so a user-initiated "new session"
   * frees up the replan budget. No-op if the session is unknown.
   */
  clearSession(sessionId: string): void {
    this.usedBySession.delete(sessionId);
  }

  /**
   * For tests / diagnostics: total replans across all live sessions.
   * Not used by the runtime itself.
   */
  totalUsed(): number {
    let sum = 0;
    for (const v of this.usedBySession.values()) sum += v;
    return sum;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/**
 * Coarse outcome classification for a finished pipeline segment, used
 * as the `segment_outcome` field on `ReplanEvent`. Matches the
 * `PipelineOutcome` type in pipeline.ts ("success" | "degraded" |
 * "failed") but is computed locally from the carry state so this
 * module doesn't have to import the executor just to label an event.
 */
export function segmentOutcomeFromCarry(carry: PipelineStageState): string {
  const planBad = carry.plan ? !carry.plan.ok : false;
  const execBad = carry.executor ? !carry.executor.ok : false;
  if (planBad || execBad) return "degraded";
  return "success";
}
