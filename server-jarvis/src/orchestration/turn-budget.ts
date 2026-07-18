import type { TurnRequirement } from "./turn-requirements";

export interface TurnBudget {
  requirement: TurnRequirement;
  complexity: "low" | "medium" | "high";
  startedAt: number;
  turn_ms: number;
  finalization_reserve_ms: number;
  max_stage_attempts: number;
  stage_ms: Record<string, number>;
  deadlineAt: number;
  remainingMs(now?: number): number;
  stageRemainingMs(stage: string, now?: number): number;
  /** Cumulative stage usage (completed segments + current inflight), in ms. */
  stageUsedMs(stage: string, now?: number): number;
  canStart(stage: string, now?: number): boolean;
  /**
   * Grant extra stage time when a stage turn produced new successful
   * evidence (Task 2.4). The 2026-07-12 incident's structural starvation:
   * a 25s executor budget against a ~52s-p50 provider pool makes "read a
   * repo" impossible. Rather than blanket-raising budgets (which trades
   * away interactive latency), a stage that is demonstrably making
   * progress earns more time, up to a hard ceiling that still respects
   * the absolute turn cap. No-ops for stages without a configured budget
   * and for zero/negative progress.
   */
  extendStageOnProgress(stage: string, newEvidenceCount: number): void;
  /**
   * Mark a budgeted stage attempt as inflight. Usage accumulates only while
   * inflight (paired with endStage). Retries that re-enter before endStage
   * share the same inflight window (T1.1). Idle gaps after endStage do not
   * consume stage budget (F2 usage accounting).
   */
  beginStage(stage: string, now?: number): void;
  /**
   * Close an inflight stage attempt and add its duration to cumulative usage.
   */
  endStage(stage: string, now?: number): void;
  /**
   * Absolute wall-clock when the stage stream must be aborted.
   * undefined when the stage has no per-stage budget (synthesizer).
   */
  stageStreamDeadlineAt(stage: string, now?: number): number | undefined;
  /**
   * T1.3: Final-stream grace deadline. Once a surfaceAsAnswer stream has
   * visible tokens past deadlineAt, allow until this hard stop.
   * = min(deadlineAt, startedAt+ABSOLUTE_TURN_CAP) + FINAL_STREAM_GRACE_MS
   * but never past startedAt + ABSOLUTE_TURN_CAP + FINAL_STREAM_GRACE_MS.
   */
  finalStreamDeadlineAt(): number;
}

/** T1.3: never hard-chop a streaming synthesizer at the turn deadline. */
export const FINAL_STREAM_GRACE_MS = 30_000;

const PROGRESS_EXTENSION_MS = 20_000;      // per evidence-producing stage turn
const STAGE_EXTENSION_CEILING_MS = 90_000; // a stage may never exceed this (unforced)
const ABSOLUTE_TURN_CAP_MS = 180_000;      // default high-complexity full_execution cap
/**
 * Deep-task contract (2026-07-16 evening): any turn classified deep — a
 * deep-read request, a continuation of a deep task, or the explicit "force
 * deep read" hatch — gets a long-haul window. A ~14-file audit structurally
 * cannot fit 180s; 600s is a CEILING, not a target: turns still end the
 * moment synthesis completes, and the loop-bounding guards (replan cap,
 * reroute cap, supervision cap, executor turn limit, runway guard) are what
 * prevent pathological spend, not the clock.
 */
export const EXTENDED_DEEP_TURN_MS = 600_000;
export const EXTENDED_DEEP_EXECUTOR_MS = 420_000;
/** F5 aliases: the forced hatch now grants the same deep-task contract. */
export const FORCED_DEEP_READ_TURN_MS = EXTENDED_DEEP_TURN_MS;
export const FORCED_DEEP_READ_EXECUTOR_MS = EXTENDED_DEEP_EXECUTOR_MS;

export interface CreateTurnBudgetOptions {
  /** User said "force deep read" — extended budget + higher absolute cap. */
  forcedDeepRead?: boolean;
  /** Turn classified deep (deep-read intent or deep task-run continuation). */
  deepTask?: boolean;
}

/** Runtime starvation codes — not model failure for learning consumers. */
export const RUNTIME_STARVATION_ERROR_CODES = new Set([
  "stage_window_exhausted",
  "turn_deadline",
]);

export function isRuntimeStarvationErrorCode(code: string | null | undefined): boolean {
  return typeof code === "string" && RUNTIME_STARVATION_ERROR_CODES.has(code);
}

const BUDGETS: Record<TurnRequirement, Omit<TurnBudget, "requirement" | "complexity" | "startedAt" | "deadlineAt" | "remainingMs" | "stageRemainingMs" | "stageUsedMs" | "canStart" | "extendStageOnProgress" | "beginStage" | "endStage" | "stageStreamDeadlineAt" | "finalStreamDeadlineAt">> = {
  conversational: { turn_ms: 30_000, finalization_reserve_ms: 15_000, max_stage_attempts: 2, stage_ms: { coordinator: 15_000 } },
  answer_only: { turn_ms: 45_000, finalization_reserve_ms: 20_000, max_stage_attempts: 2, stage_ms: { coordinator: 15_000, planner: 15_000 } },
  // workspace_read's executor ceiling: 60_000 (not the original 25_000) — same
  // bug class as the full_execution planner/reviewer fix above. The agent pool's
  // DEFAULT_ORCHESTRATOR_AGENTS gives slow-start Nemotron models a
  // first_token_timeout_ms: 55_000 override; if the executor route ever resolves
  // to such a model (or any future executor-defaulted model with a similar
  // override), the static 25_000 ceiling would silently undercut it via the
  // same Math.min(requestBudgetMs, firstTokenTimeoutFor(...)) combinator. The
  // runtime caps the actual delay at remainingMs (75_000 turn budget −
  // 25_000 reserve = 50_000), so the wider ceiling just stops the override
  // being inert — it does NOT extend the turn beyond its total budget.
  workspace_read: { turn_ms: 75_000, finalization_reserve_ms: 25_000, max_stage_attempts: 2, stage_ms: { coordinator: 15_000, executor: 60_000 } },
  // planner/reviewer: 60_000 (not the original 20_000) — see the
  // 2026-07-13 finding below. full_execution's 150-180s total turn_ms
  // leaves ample room; the per-stage ceilings are independent caps bounded
  // by overall remaining time, not a strict partition of the total, so
  // this doesn't starve later stages under normal (non-Nemotron) latency.
  // reviewer's default agent (or-nemotron-ultra-free) shares the exact
  // same 55_000ms override and is currently disabled in live config (a
  // separate, already-correct "disabled models don't inherit overrides"
  // behavior — see agent-pool.test.ts), so this specific ceiling isn't
  // actively biting today. Raised proactively: it's the identical bug
  // class as planner's, and would silently recur the moment that model
  // (or any future reviewer-stage model with a similarly large override)
  // is enabled.
  // 2026-07-17: rewriter raised 30s→60s — it is the effect-gate's write-repair
  // stage on change turns and was dying at its own deadline mid-repair
  // (run_35d30e5c). Coordinator raised 15s→20s — mid-run replans share the
  // coordinator window with the initial route (usage-based), and the live
  // pool's first token alone runs 10-20s; 15s made every replan a coin flip.
  full_execution: { turn_ms: 150_000, finalization_reserve_ms: 30_000, max_stage_attempts: 2, stage_ms: { coordinator: 20_000, planner: 60_000, executor: 60_000, reviewer: 60_000, rewriter: 60_000 } },
};

// 2026-07-13 finding: agent-pool.ts's DEFAULT_ORCHESTRATOR_AGENTS gives
// nemotron-3-ultra-free (the planner/synthesizer default) a
// first_token_timeout_ms: 55_000 override specifically because it's a
// known slow-starting model — that fix shipped 2026-06-26/27 with its own
// passing regression test asserting firstTokenTimeoutFor resolves to
// 55_000. But index.ts's watchdog setup computes
// `Math.min(requestBudgetMs, firstTokenTimeoutFor(...))`, and
// requestBudgetMs is bounded by THIS file's stage_ms.planner — which was
// 20_000 for full_execution (15_000 for answer_only), both far below
// 55_000. The override's own unit test passed (it correctly resolves the
// function in isolation) while being completely inert in the actual
// end-to-end path: Math.min(20_000, 55_000) is always 20_000. Confirmed
// live via self-tuning.db: a real "create a full comprehensive
// implementation plan" (full_execution) turn failed with "First-token
// timeout (20000ms) on model=nemotron-3-ultra-free stage=planner" — the
// exact 20s value, not the intended 55s. Raised full_execution's planner
// ceiling above (to 60_000, matching firstTokenTimeoutFor's own capMs) so
// the override the pool advertises is the override that's actually
// enforced. answer_only's planner cap (15_000) is deliberately left alone:
// that tier's 45_000ms total turn budget has no room for a 55s allowance
// without starving synthesizer entirely, and it's a "fast tier" by design
// — a slow model there should fall back faster, not wait longer.

export function createTurnBudget(
  requirement: TurnRequirement,
  complexity: "low" | "medium" | "high" = "medium",
  startedAt = Date.now(),
  opts: CreateTurnBudgetOptions = {},
): TurnBudget {
  const base = BUDGETS[requirement];
  // Deep-task contract: the explicit force hatch and turns classified deep
  // (deep-read intent / deep task-run continuation) share the same
  // long-haul window.
  const extendedDeep = Boolean(opts.forcedDeepRead || opts.deepTask);
  const absolute_cap_ms = extendedDeep ? EXTENDED_DEEP_TURN_MS : ABSOLUTE_TURN_CAP_MS;
  let turn_ms = requirement === "full_execution" && complexity === "high"
    ? Math.min(180_000, base.turn_ms + 30_000)
    : base.turn_ms;
  const stage_ms = { ...base.stage_ms };
  if (extendedDeep) {
    turn_ms = EXTENDED_DEEP_TURN_MS;
    // conversational/answer_only have no executor budget — grant one too.
    stage_ms.executor = EXTENDED_DEEP_EXECUTOR_MS;
  }
  // F2: cumulative usage per stage + current inflight start (usage-based,
  // not wall-clock since first entry).
  const stageUsedAccumMs = new Map<string, number>();
  const stageInflightStart = new Map<string, number>();
  // Extended stages may start above the default 90s progress ceiling; never
  // shrink them via extendStageOnProgress, and allow growth up to absolute_cap.
  const stageExtensionCeilingMs = extendedDeep
    ? Math.max(STAGE_EXTENSION_CEILING_MS, EXTENDED_DEEP_EXECUTOR_MS)
    : STAGE_EXTENSION_CEILING_MS;

  const budget: TurnBudget = {
    requirement,
    complexity,
    startedAt,
    turn_ms,
    finalization_reserve_ms: base.finalization_reserve_ms,
    max_stage_attempts: base.max_stage_attempts,
    stage_ms,
    deadlineAt: startedAt + turn_ms,
    remainingMs(now = Date.now()) {
      return Math.max(0, this.deadlineAt - now);
    },
    stageUsedMs(stage, now = Date.now()) {
      const accumulated = stageUsedAccumMs.get(stage) ?? 0;
      const inflightStart = stageInflightStart.get(stage);
      const inflight = inflightStart !== undefined ? Math.max(0, now - inflightStart) : 0;
      return accumulated + inflight;
    },
    stageRemainingMs(stage, now = Date.now()) {
      const stageBudget = this.stage_ms[stage];
      if (stageBudget === undefined) return this.remainingMs(now);
      const used = this.stageUsedMs(stage, now);
      const stageLeft = Math.max(0, stageBudget - used);
      return Math.max(0, Math.min(stageLeft, this.remainingMs(now)));
    },
    canStart(stage, now = Date.now()) {
      if (this.remainingMs(now) <= this.finalization_reserve_ms) return false;
      return this.stage_ms[stage] === undefined || this.stageRemainingMs(stage, now) > 0;
    },
    beginStage(stage, now = Date.now()) {
      // Only for budgeted stages; synthesizer has no stage_ms entry.
      if (this.stage_ms[stage] === undefined) return;
      // Already inflight (retry without endStage) — share the window (T1.1).
      if (!stageInflightStart.has(stage)) {
        stageInflightStart.set(stage, now);
      }
    },
    endStage(stage, now = Date.now()) {
      const start = stageInflightStart.get(stage);
      if (start === undefined) return;
      stageInflightStart.delete(stage);
      const slice = Math.max(0, now - start);
      stageUsedAccumMs.set(stage, (stageUsedAccumMs.get(stage) ?? 0) + slice);
    },
    stageStreamDeadlineAt(stage, now = Date.now()) {
      const stageBudget = this.stage_ms[stage];
      if (stageBudget === undefined) return undefined;
      // Usage-based: remaining budget from *now*, not first-begin wall clock.
      return Math.min(now + this.stageRemainingMs(stage, now), this.deadlineAt);
    },
    finalStreamDeadlineAt() {
      // Grace applies past the normal turn deadline so a streaming final
      // answer is not mid-word chopped. Absolute hard stop still applies.
      const softCap = Math.min(this.deadlineAt, this.startedAt + absolute_cap_ms);
      return Math.min(
        softCap + FINAL_STREAM_GRACE_MS,
        this.startedAt + absolute_cap_ms + FINAL_STREAM_GRACE_MS,
      );
    },
    extendStageOnProgress(stage, newEvidenceCount) {
      if (newEvidenceCount <= 0) return;
      const current = this.stage_ms[stage];
      if (current === undefined) return;
      const extension = Math.min(newEvidenceCount, 3) * PROGRESS_EXTENSION_MS;
      const next = Math.min(stageExtensionCeilingMs, current + extension);
      const granted = next - current;
      if (granted <= 0) return;
      this.stage_ms[stage] = next;
      this.turn_ms = Math.min(absolute_cap_ms, this.turn_ms + granted);
      this.deadlineAt = this.startedAt + this.turn_ms;
    },
  };
  return budget;
}
