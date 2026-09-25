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
// This module owns the linking rules only. It is deliberately turn-agnostic:
// it takes no Session/turn signal, so it is structurally incapable of aborting
// the active-stream lease, and a stage abort settles as `stage_aborted` rather
// than as a cancellation, timeout, or turn deadline.

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
