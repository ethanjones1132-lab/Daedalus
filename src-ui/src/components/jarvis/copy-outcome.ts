// ═══════════════════════════════════════════════════════════════
// ── copy-outcome — did the clipboard actually take the text? ──
//
// Four controls in this app copy to the clipboard. Two of them kept the outcome
// as a fact and announced a refusal (`RecordIdBadge`, the `MarkdownView` code
// block): the caught value never reached the surface, and a fixed sentence
// rendered beside the control that made the attempt. The other two did not —
// the hand-rolled `MarkdownRenderer` swallowed a rejection into
// `setCopied(false)`, and the Jarvis transcript's icon-only per-message control
// logged it and changed nothing. A success label that reverts after 1.5s is the
// same pixels as a control that did nothing, so a refused copy and a click that
// was missed were one observation, and the operator's next move was to click
// again.
//
// This module is the whole of that claim, in the shape `theme-choice.ts`
// established: an attempt-fenced reducer, and a projection into fixed copy that
// no caught value can reach.
//
// Three facts about a write are kept apart on purpose, because collapsing them
// is the bug this replaces:
//
// - `attempted` — the write was issued. Nothing is known yet.
// - `settled`   — it came back, one way or the other.
// - `confirmed` — it came back resolved.
//
// A claim is also about *text*: a `Copied` label or a refusal sentence refers to
// the content that was on screen when the control was clicked, so a change of
// content retires the claim and re-fences any write still in flight for it.
// ═══════════════════════════════════════════════════════════════

export const COPY_FAILED_COPY = 'Could not copy the message to clipboard.';
/** The timeout every copy control in this app already used for its label. */
export const COPY_SUCCESS_TIMEOUT_MS = 1500;

export type CopyPhase = 'idle' | 'copying' | 'copied' | 'failed';

export interface CopyOutcomeState {
  /** Monotonic id of the claim on screen. Never decreases, so a settlement
   *  belonging to a superseded attempt cannot be mistaken for the current one. */
  attempt: number;
  /** The attempt a write was actually issued for, or 0 when none was. */
  issued: number;
  /** The attempt `phase` describes, or 0 when no attempt has come back. */
  settled: number;
  phase: CopyPhase;
}

export type CopyOutcomeEvent =
  | { type: 'reset'; attempt: number }
  | { type: 'attempt'; attempt: number }
  | { type: 'confirmed'; attempt: number }
  | { type: 'failed'; attempt: number }
  | { type: 'expired'; attempt: number };

export interface CopyOutcomeView {
  phase: CopyPhase;
  /** True only while a confirmed write is still announcing itself. */
  copied: boolean;
  /** True while a refusal is on screen. */
  failed: boolean;
  /** One fixed sentence, or null when there is nothing to say. */
  message: string | null;
  attempted: boolean;
  settled: boolean;
  confirmed: boolean;
}

export function initialCopyOutcome(): CopyOutcomeState {
  return { attempt: 0, issued: 0, settled: 0, phase: 'idle' };
}

export function reduceCopyOutcome(
  state: CopyOutcomeState,
  event: CopyOutcomeEvent,
): CopyOutcomeState {
  switch (event.type) {
    case 'reset': {
      // The text this control would copy has changed, so any claim about it is
      // retired. With no claim on screen and no write in flight there is nothing
      // to invalidate and nothing to fence, so the state is left alone — which is
      // also what keeps a mount from re-rendering for no reason.
      if (event.attempt <= state.attempt) return state;
      if (state.phase === 'idle' && state.issued === 0 && state.settled === 0) return state;
      return { attempt: event.attempt, issued: 0, settled: 0, phase: 'idle' };
    }

    case 'attempt':
      // One counter serves every direction, so a settlement that lands after a
      // newer click is dropped whether it is a confirmation or a refusal: a late
      // refusal must not raise an alarm about a click the operator has replaced.
      if (event.attempt <= state.attempt) return state;
      return { attempt: event.attempt, issued: event.attempt, settled: 0, phase: 'copying' };

    case 'confirmed':
    case 'failed':
      if (event.attempt !== state.attempt) return state;
      return {
        ...state,
        settled: event.attempt,
        phase: event.type === 'confirmed' ? 'copied' : 'failed',
      };

    case 'expired':
      // A timer from a superseded attempt must not clear a newer success, and an
      // expiry that was never preceded by a confirmed write is not news.
      if (event.attempt !== state.attempt || state.phase !== 'copied') return state;
      return { ...state, phase: 'idle' };
  }
}

export function projectCopyOutcome(state: CopyOutcomeState): CopyOutcomeView {
  const copied = state.phase === 'copied';
  const failed = state.phase === 'failed';
  return {
    phase: state.phase,
    copied,
    failed,
    // Exactly one sentence exists, it names no cause, and it is on screen only
    // while a refusal is. A write in flight says nothing, and a success that has
    // expired says nothing: the operator already read it.
    message: failed ? COPY_FAILED_COPY : null,
    attempted: state.issued > 0,
    settled: state.settled > 0,
    // A write that came back resolved stays confirmed after its label expires —
    // the text did reach the clipboard. A write that has not come back yet, or
    // that was refused, is not confirmed.
    confirmed: state.settled > 0 && state.phase !== 'failed',
  };
}
