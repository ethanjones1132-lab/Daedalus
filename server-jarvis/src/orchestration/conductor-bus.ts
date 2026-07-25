import type { StageName } from "./coordinator"

// ---------------------------------------------------------------------------
// Event types published BY pipeline stages
// ---------------------------------------------------------------------------

export type StageEvent =
  | { type: "stage_started"; stage: StageName; model: string; runId: string }
  | { type: "stage_token"; stage: StageName; textDelta: string; cumulativeLen: number }
  | { type: "tool_call_started"; stage: StageName; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; stage: StageName; name: string; isError: boolean; summary: string }
  | { type: "stage_completed"; stage: StageName; output: string; tokens: number; durationMs: number }
  | { type: "stage_failed"; stage: StageName; error: string }

// ---------------------------------------------------------------------------
// Directive types emitted BY the conductor
// ---------------------------------------------------------------------------

/**
 * Directives emitted by LiveConductor.afterStage (and owned-runtime-loop helpers).
 *
 * Runtime-loop extensions (Task 5):
 * - mark_verified: item graded sufficient — ledger mark-off + advance
 * - escalate_reviewer: local grade capacity exceeded — send to Reviewer
 * - start_repair_chain: Reviewer insufficient — deterministic Rewriter→Executor→Reviewer
 *   (no further Conductor re-decision between those stages)
 * - block_item: consecutive-failure / repair-cycle backstop
 */
export type ConductorDirective =
  | { type: "continue" }
  | { type: "abort_stage"; stage: StageName; reason: string }
  | { type: "reroute"; newRemaining: StageName[]; reason: string }
  | { type: "inject_context"; forStage: StageName; note: string; reason: string }
  | {
      type: "mark_verified";
      itemId: string;
      evidenceRef: string;
      evidenceSummary?: string;
      gradingMode: "conductor_direct_diff" | "reviewer_mediated";
      reason: string;
    }
  | {
      type: "escalate_reviewer";
      itemId?: string;
      reason: string;
      /** Remaining queue to place after reviewer when re-routing. */
      newRemaining?: StageName[];
    }
  | {
      type: "start_repair_chain";
      itemId?: string;
      reason: string;
      flaggedIssues?: string;
      /** Deterministic stages: rewriter → executor → reviewer [→ synthesizer…] */
      newRemaining: StageName[];
    }
  | {
      type: "block_item";
      itemId: string;
      reason: string;
    }

// ---------------------------------------------------------------------------
// Internal throttle state per stage
// ---------------------------------------------------------------------------

interface TokenThrottleSlot {
  timer: ReturnType<typeof setTimeout>
  accumulatedDelta: string
  cumulativeLen: number
}

// ---------------------------------------------------------------------------
// ConductorBus
// ---------------------------------------------------------------------------

export class ConductorBus {
  private handlers: Array<(event: StageEvent) => void> = []
  private abortHandles: Map<StageName, AbortController> = new Map()
  private throttleMap: Map<StageName, TokenThrottleSlot> = new Map()
  private cleared = false

  private static readonly TOKEN_INTERVAL_MS = 250

  // -------------------------------------------------------------------------
  // Subscribe / publish
  // -------------------------------------------------------------------------

  /**
   * Subscribe to all stage events.
   * Returns an unsubscribe function — call it to remove this handler.
   */
  subscribe(handler: (event: StageEvent) => void): () => void {
    if (this.cleared) {
      console.warn("[ConductorBus] subscribe() called after clear() — this is likely a lifecycle bug")
    }
    this.handlers.push(handler)
    return () => {
      const idx = this.handlers.indexOf(handler)
      if (idx !== -1) this.handlers.splice(idx, 1)
    }
  }

  /**
   * Publish a stage event to all subscribers synchronously.
   * Errors thrown by individual handlers are caught and logged; they never
   * propagate back to the publisher.
   */
  publish(event: StageEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch (err) {
        console.error("[ConductorBus] handler error:", err)
      }
    }
  }

  /**
   * Coalesced publish for stage_token events.
   * Accumulates textDelta values over a 250 ms window, then fires a single
   * event per stage when the timer fires.  The emitted event carries the
   * concatenated delta and the most-recent cumulativeLen.
   */
  publishThrottled(event: StageEvent & { type: "stage_token" }): void {
    const existing = this.throttleMap.get(event.stage)

    if (existing) {
      // Accumulate into the current window
      existing.accumulatedDelta += event.textDelta
      existing.cumulativeLen = event.cumulativeLen
    } else {
      // Open a new window and schedule the flush
      const stage = event.stage  // extract before closure
      const slot: TokenThrottleSlot = {
        timer: setTimeout(() => {
          this.flushTokenSlot(stage)
        }, ConductorBus.TOKEN_INTERVAL_MS),
        accumulatedDelta: event.textDelta,
        cumulativeLen: event.cumulativeLen,
      }
      this.throttleMap.set(event.stage, slot)
    }
  }

  private flushTokenSlot(stage: StageName): void {
    const slot = this.throttleMap.get(stage)
    if (!slot) return
    this.throttleMap.delete(stage)

    this.publish({
      type: "stage_token",
      stage,
      textDelta: slot.accumulatedDelta,
      cumulativeLen: slot.cumulativeLen,
    })
  }

  // -------------------------------------------------------------------------
  // Abort handle registry
  // -------------------------------------------------------------------------

  /**
   * Register an AbortController so the conductor can cancel a stage mid-run.
   */
  registerAbortHandle(stage: StageName, ctrl: AbortController): void {
    this.abortHandles.set(stage, ctrl)
  }

  /**
   * Fire the AbortController registered for a stage.
   * Warns and no-ops if none is registered.
   */
  resolveAbort(stage: StageName): void {
    const ctrl = this.abortHandles.get(stage)
    if (!ctrl) {
      console.warn(`[ConductorBus] resolveAbort called for unregistered stage: ${stage}`)
      return
    }
    ctrl.abort()
    this.abortHandles.delete(stage)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Remove all subscribers and abort handles, and flush any pending throttle
   * timers.  Call at the end of each pipeline turn.
   */
  clear(): void {
    const handlersToFlush = this.handlers  // capture before blanking
    this.handlers = []                      // blank immediately so no new publishes reach old handlers
    this.cleared = true
    this.abortHandles.clear()

    // Flush + cancel all pending token timers using captured handlers directly
    for (const [stage, slot] of this.throttleMap) {
      clearTimeout(slot.timer)
      if (slot.accumulatedDelta) {
        const event: StageEvent = {
          type: "stage_token",
          stage,
          textDelta: slot.accumulatedDelta,
          cumulativeLen: slot.cumulativeLen,
        }
        for (const h of handlersToFlush) {
          try { h(event) } catch {}
        }
      }
    }
    this.throttleMap.clear()
  }
}
