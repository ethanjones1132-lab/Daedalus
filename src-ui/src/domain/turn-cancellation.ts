// ═══════════════════════════════════════════════════════════════
// ── turn-cancellation — one owner for "did the stop happen?" ──
//
// The chat Stop control used to decide what had happened from local state.
// It set a flag, tore down its own SSE reader, cleared the streaming
// indicator, and reported the turn as `cancelled` whether or not the server
// had agreed — a `false` from `cancel_chat_stream` and a rejected request both
// produced the same "stopped" surface, and the durable run record said
// `client_abort` even when the server had confirmed the cancel. It also fired
// the same cancellation twice, once as a raw `fetch` to `/chat/cancel` and
// once through Native, and nothing stopped a second Stop click from asking
// again.
//
// This module is the whole of the claim. It records the one outstanding stop
// request, fences every settlement against the attempt and the Session it was
// issued for, and projects fixed copy that never names a cause: a native
// message is not the operator's to read. It carries no error value at all —
// the outcome is a small closed vocabulary, so there is nowhere for one to
// leak in from.
//
// The vocabulary is two words because that is what the platform can actually
// tell the UI. `cancel_chat_stream` returns `body.cancelled` as a boolean and
// collapses a missing or non-boolean field to `false`
// (`src-tauri/src/commands/jarvis_commands.rs:222-226`), so a response this
// build cannot read as a confirmation is a refusal, not a third case.
// ═══════════════════════════════════════════════════════════════

export type StopRequestStatus = 'idle' | 'requesting' | 'unconfirmed';

/** Why a stop could not be confirmed, in the platform's own two words. */
export type StopUnconfirmedReason = 'refused' | 'unavailable';

/** What the one outstanding request turned out to be. */
export type StopOutcome = 'confirmed' | StopUnconfirmedReason;

export interface StopRequestState {
  readonly status: StopRequestStatus;
  /** Attempt id of the newest request. Monotonic per mounted view. */
  readonly attempt: number;
  /** The Session the newest request was issued against. */
  readonly sessionId: string | null;
  readonly reason: StopUnconfirmedReason | null;
}

export type StopRequestEvent =
  | { type: 'begin'; attempt: number; sessionId: string }
  | { type: 'settle'; attempt: number; sessionId: string; outcome: StopOutcome }
  | { type: 'clear' };

export const initialStopRequestState: StopRequestState = {
  status: 'idle',
  attempt: 0,
  sessionId: null,
  reason: null,
};

/**
 * The pending sentence. A request in flight makes no claim about the turn's
 * fate, so this is the only thing on screen while it waits.
 */
export const STOP_REQUESTING_STATUS = 'Stopping Session turn…';

/**
 * The server answered and did not stop the turn. `cancelled: false` means the
 * registry held no live stream for this Session, which happens both when the
 * turn is already over and when it is still producing an answer. The claim
 * stops at what the boolean proves, and says why the turn was kept: its answer
 * may still arrive.
 */
export const STOP_REFUSED_ALERT =
  'Could not stop this turn. The server did not stop it, so this turn has not been stopped and its answer may still arrive.';

/**
 * The request could not be made at all. Same consequence, different fact: the
 * UI never reached a verdict, so it says so instead of implying one.
 */
export const STOP_UNAVAILABLE_ALERT =
  'Could not reach the server to stop this turn. It has not been stopped, and its answer may still arrive.';

/** The label a deliberate second attempt carries, as Hermes's Stop does. */
export const STOP_RETRY_LABEL = 'Retry stop';

export function decodeStopConfirmation(value: unknown): StopOutcome {
  return value === true ? 'confirmed' : 'refused';
}

export function reduceStopRequest(
  state: StopRequestState,
  event: StopRequestEvent,
): StopRequestState {
  if (event.type === 'clear') {
    if (
      state.status === 'idle'
      && state.reason === null
      && state.attempt === 0
      && state.sessionId === null
    ) {
      return state;
    }
    return initialStopRequestState;
  }
  if (event.type === 'begin') {
    return { status: 'requesting', attempt: event.attempt, sessionId: event.sessionId, reason: null };
  }
  // A settlement belongs to exactly one attempt of exactly one Session. A
  // late answer — a superseded retry, or a Session the view has already left —
  // is dropped outright, and the identical state object is returned so a
  // caller can see it changed nothing.
  if (
    state.status !== 'requesting'
    || state.attempt !== event.attempt
    || state.sessionId !== event.sessionId
  ) {
    return state;
  }
  if (event.outcome === 'confirmed') {
    return { status: 'idle', attempt: state.attempt, sessionId: state.sessionId, reason: null };
  }
  return {
    status: 'unconfirmed',
    attempt: state.attempt,
    sessionId: state.sessionId,
    reason: event.outcome,
  };
}

export function isCurrentStopRequest(
  state: StopRequestState,
  attempt: number,
  sessionId: string | null,
): boolean {
  return state.status === 'requesting'
    && state.attempt === attempt
    && state.sessionId === sessionId;
}

export interface StopRequestView {
  readonly phase: StopRequestStatus;
  /** Announced progress sentence, or null. */
  readonly status: string | null;
  /** Announced failure sentence, or null. */
  readonly alert: string | null;
  /** Whether the operator is being offered a deliberate second attempt. */
  readonly retry: boolean;
  /** Whether the Stop control must refuse further input. */
  readonly stopDisabled: boolean;
}

export function projectStopRequest(state: StopRequestState): StopRequestView {
  if (state.status === 'requesting') {
    return {
      phase: 'requesting',
      status: STOP_REQUESTING_STATUS,
      alert: null,
      retry: false,
      stopDisabled: true,
    };
  }
  if (state.status === 'unconfirmed') {
    return {
      phase: 'unconfirmed',
      status: null,
      alert: state.reason === 'unavailable' ? STOP_UNAVAILABLE_ALERT : STOP_REFUSED_ALERT,
      retry: true,
      stopDisabled: false,
    };
  }
  return {
    phase: 'idle',
    status: null,
    alert: null,
    retry: false,
    stopDisabled: false,
  };
}
