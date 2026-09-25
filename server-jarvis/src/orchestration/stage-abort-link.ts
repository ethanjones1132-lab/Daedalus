// Stage-local cancellation boundary for the live inference transport.
//
// `CallModelFn` hands the pipeline a per-stage `stageAbort` signal
// (coordinator.ts) so a live-Conductor `abort_stage` directive can stop one
// stage during M3 overlap without cancelling the Session turn. Until now the
// live transport in index.ts registered only the turn-wide `streamAbort`, so a
// stage abort was observed by nobody: the provider request and body reader kept
// running, and when the request eventually failed the transport reported it as
// a timeout — a stage the Conductor had already ordered to stop was recorded as
// a slow model.
//
// This module owns the stage-local abort boundary: the rules for linking the
// signal to transport work, and the rules for deciding why an attempt stopped.
// It is deliberately turn-agnostic: it takes no Session/turn signal it can
// cancel, so it is structurally incapable of aborting the active-stream lease,
// and a stage abort settles as `stage_aborted` rather than as a cancellation,
// timeout, or turn deadline.

import { registerAbortHandler } from "../stream-control";

/** Abort reason stamped on transport work cancelled by a stage abort. */
export const STAGE_ABORTED_ABORT_REASON = "Stage aborted by Conductor";

/** Stable, telemetry-friendly code for a stage-local abort. */
export const STAGE_ABORTED_CODE = "stage_aborted";

/** Raised by the transport when a stage abort ended the current attempt. */
export class StageAbortedError extends Error {
  readonly code = STAGE_ABORTED_CODE;

  constructor(readonly stage: string) {
    super(`Stage aborted: ${stage}`);
    this.name = "StageAbortedError";
  }
}

export function isStageAbortedError(error: unknown): boolean {
  if (error instanceof StageAbortedError) return true;
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code === STAGE_ABORTED_CODE;
}

export type CallAbortCause = "stage_aborted" | "turn_cancelled" | "turn_deadline" | "request_timeout";

/**
 * Decide why a provider attempt stopped, from the signals that can end it.
 *
 * Precedence is deliberate: a stage abort is the Conductor's explicit decision
 * for this stage, so it wins over a racing turn cancellation or a reached turn
 * deadline and must never be re-reported as a timeout.
 */
export function classifyCallAbort(options: {
  stageAbort?: AbortSignal;
  turnAbort: AbortSignal;
  turnDeadlineReached: boolean;
}): CallAbortCause | null {
  if (options.stageAbort?.aborted) return "stage_aborted";
  if (options.turnAbort.aborted) return "turn_cancelled";
  if (options.turnDeadlineReached) return "turn_deadline";
  return null;
}

export interface StageAbortTransportLink {
  /** Abort the in-flight request and stop the body reader, once. */
  abort(): void;
  /** Detach the stage listener. Idempotent. */
  cleanup(): void;
}

/**
 * How one stage attempt ended, as the code *around* the attempt sees it.
 * `in_flight` means nothing stopped it: a real model outcome to cascade from
 * and to attribute. The other two are operator/Conductor stops.
 */
export type StageSettlement = "in_flight" | "stage_aborted" | "turn_cancelled";

export interface StageSettlementDecision {
  settlement: StageSettlement;
  /** Somebody deliberately stopped this stage — the Conductor or the operator. */
  stopped: boolean;
  /** A stopped attempt must not spend another provider call on a fallback. */
  mayAdvanceFallback: boolean;
  /** A stopped attempt must not be scored against the model that served it. */
  mayRecordModelAttribution: boolean;
}

/**
 * Decide how a stage attempt settled, once, for every consumer downstream of it.
 *
 * The transport settles the *attempt*; the fallback cascade and the model
 * attribution around it are separate code that used to consult only the
 * turn-wide signal. A stage the Conductor had already ordered to stop could
 * therefore still advance the cascade onto another model, and the stopped
 * attempt was then recorded as a `http_error` against a model that never had
 * the chance to fail. One settlement feeds both, so the two cannot disagree.
 *
 * `error` is consulted as well as the signals: a `StageAbortedError` is
 * authoritative on its own, so a lost signal reference cannot let a stopped
 * attempt back into the cascade. An ordinary transport failure reports
 * `in_flight`, which keeps it fallback-eligible exactly as before.
 */
export function settleStageAttempt(options: {
  stageAbort?: AbortSignal;
  turnAbort: AbortSignal;
  error?: unknown;
}): StageSettlementDecision {
  const settlement: StageSettlement = options.stageAbort?.aborted
    ? "stage_aborted"
    : isStageAbortedError(options.error)
      ? "stage_aborted"
      : options.turnAbort.aborted
        ? "turn_cancelled"
        : "in_flight";
  const stopped = settlement !== "in_flight";
  return { settlement, stopped, mayAdvanceFallback: !stopped, mayRecordModelAttribution: !stopped };
}

/** What one settled attempt is allowed to say about itself afterwards. */
export interface StageOutcomePublication {
  /** Persist this attempt's stage/model attribution for self-tuning. */
  recordStageAttribution: boolean;
  /**
   * Publish this attempt as the turn's model — the coordinator-stage row, the
   * routing-parse strike, and the turn's own provider/model telemetry all read
   * that one projection.
   */
  publishTurnModel: boolean;
  /** One bounded operator line explaining a dropped outcome, else null. */
  warning: string | null;
}

/**
 * Decide whether a settled attempt's outcome may be published to learning and
 * telemetry, and say once why it was dropped.
 *
 * `settleStageAttempt` decides *why an attempt stopped*; this decides what
 * survives that. A stage the Conductor ordered to stop produces no model
 * outcome, even when the read loop broke on a `done` read that the abort turned
 * into a clean finish: the pipeline discards that answer, so persisting a
 * `was_successful` row for it would credit a model for work nobody received,
 * and naming it as the turn's model would attribute the turn to a stage the
 * operator was told had stopped.
 *
 * `warning` is deliberately non-null only for a Conductor stop, and only once
 * per attempt: the transport logs it from the single `finally` that already
 * settles every attempt, so a suppressed success and a suppressed failure are
 * both explained exactly once and an operator cancellation stays as quiet as it
 * was before.
 */
export function decideStageOutcomePublication(options: {
  stage: string;
  settlement: StageSettlementDecision;
  attemptSucceeded: boolean;
}): StageOutcomePublication {
  const { stage, settlement, attemptSucceeded } = options;
  if (!settlement.stopped) {
    return { recordStageAttribution: true, publishTurnModel: true, warning: null };
  }
  const discarded = attemptSucceeded ? "discarded a completed model outcome; " : "";
  return {
    recordStageAttribution: settlement.mayRecordModelAttribution,
    publishTurnModel: settlement.mayRecordModelAttribution,
    warning:
      settlement.settlement === "stage_aborted"
        ? `stage=${stage} settled as ${STAGE_ABORTED_CODE} (Conductor stop) — ${discarded}no model attribution recorded`
        : null,
  };
}

/**
 * Bind one stage signal to the transport work that stage owns: the pending
 * provider request and, once headers have arrived, its body reader.
 *
 * Returns a link so the caller can detach it. Absent `stageAbort` is inert, and
 * a signal that has already fired settles the attempt immediately — a stage
 * aborted while the pipeline was still building the request must not send it.
 */
export function linkStageAbortToTransport(options: {
  stage: string;
  stageAbort?: AbortSignal;
  request?: AbortController;
  cancelReader?: (reason?: unknown) => void;
}): StageAbortTransportLink {
  const { request, cancelReader } = options;
  const signal = options.stageAbort;
  let settled = false;

  const abort = () => {
    if (settled) return;
    settled = true;
    if (request && !request.signal.aborted) request.abort(STAGE_ABORTED_ABORT_REASON);
    if (cancelReader) void cancelReader(STAGE_ABORTED_ABORT_REASON);
  };

  if (!signal) {
    return { abort, cleanup: () => {} };
  }

  const detach = registerAbortHandler(signal, abort);
  return { abort, cleanup: detach };
}
