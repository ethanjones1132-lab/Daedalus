import { describe, expect, it } from 'vitest';
import {
  STOP_REFUSED_ALERT,
  STOP_REQUESTING_STATUS,
  STOP_RETRY_LABEL,
  STOP_UNAVAILABLE_ALERT,
  decodeStopConfirmation,
  initialStopRequestState,
  isCurrentStopRequest,
  projectStopRequest,
  reduceStopRequest,
  type StopRequestEvent,
  type StopRequestState,
} from './turn-cancellation';

function begin(state: StopRequestState, attempt: number, sessionId = 'session-1'): StopRequestState {
  return reduceStopRequest(state, { type: 'begin', attempt, sessionId });
}

function settle(
  state: StopRequestState,
  outcome: 'confirmed' | 'refused' | 'unavailable',
  attempt: number,
  sessionId = 'session-1',
): StopRequestState {
  return reduceStopRequest(state, { type: 'settle', attempt, sessionId, outcome });
}

describe('stop request state', () => {
  it('starts idle, addressed to no Session, and claims nothing', () => {
    const state = initialStopRequestState;
    expect(state).toEqual({ status: 'idle', attempt: 0, sessionId: null, reason: null });
    expect(projectStopRequest(state)).toEqual({
      phase: 'idle',
      status: null,
      alert: null,
      retry: false,
      stopDisabled: false,
    });
  });

  it('announces the pending stop and claims no outcome while the request is in flight', () => {
    const state = begin(initialStopRequestState, 1);
    expect(state.status).toBe('requesting');
    expect(state.reason).toBeNull();
    expect(projectStopRequest(state)).toEqual({
      phase: 'requesting',
      status: STOP_REQUESTING_STATUS,
      alert: null,
      retry: false,
      stopDisabled: true,
    });
  });

  it('says nothing more once the server has confirmed the stop', () => {
    const state = settle(begin(initialStopRequestState, 1), 'confirmed', 1);
    expect(state.status).toBe('idle');
    expect(state.reason).toBeNull();
    const view = projectStopRequest(state);
    expect(view.status).toBeNull();
    expect(view.alert).toBeNull();
    expect(view.retry).toBe(false);
  });

  it('reports a refusal as an unconfirmed stop, never as a stopped turn', () => {
    const state = settle(begin(initialStopRequestState, 1), 'refused', 1);
    expect(state.reason).toBe('refused');
    const view = projectStopRequest(state);
    expect(view.phase).toBe('unconfirmed');
    expect(view.alert).toBe(STOP_REFUSED_ALERT);
    expect(view.status).toBeNull();
    expect(view.retry).toBe(true);
    expect(view.stopDisabled).toBe(false);
  });

  it('distinguishes a request that could not be made from one the server refused', () => {
    const state = settle(begin(initialStopRequestState, 1), 'unavailable', 1);
    expect(state.reason).toBe('unavailable');
    expect(projectStopRequest(state).alert).toBe(STOP_UNAVAILABLE_ALERT);
  });

  it('gives the two failures different sentences', () => {
    expect(STOP_REFUSED_ALERT).not.toBe(STOP_UNAVAILABLE_ALERT);
  });

  it('names no cause in either failure sentence', () => {
    for (const sentence of [STOP_REFUSED_ALERT, STOP_UNAVAILABLE_ALERT]) {
      expect(sentence).not.toMatch(/SQLITE|Error|error:|Exception|store|session_id/);
      expect(sentence.endsWith('.')).toBe(true);
    }
    // The pending sentence is progress, not a claim, so it is elided rather
    // than punctuated the way the two failures are.
    expect(STOP_REQUESTING_STATUS).not.toMatch(/SQLITE|Error|error:|Exception|session_id/);
    expect(STOP_REQUESTING_STATUS.endsWith('…')).toBe(true);
  });

  it('lets a deliberate retry supersede an unconfirmed stop', () => {
    const refused = settle(begin(initialStopRequestState, 1), 'refused', 1);
    const retrying = begin(refused, 2);
    expect(retrying).toEqual({ status: 'requesting', attempt: 2, sessionId: 'session-1', reason: null });
    expect(projectStopRequest(retrying).alert).toBeNull();
    expect(projectStopRequest(retrying).retry).toBe(false);
  });

  it('ignores a settlement from a superseded attempt and returns the identical state', () => {
    const first = begin(initialStopRequestState, 1);
    const second = begin(first, 2);
    const late = settle(second, 'confirmed', 1);
    expect(late).toBe(second);
  });

  it('ignores a late refusal so it cannot resurrect a claim the newer attempt cleared', () => {
    const retrying = begin(settle(begin(initialStopRequestState, 1), 'refused', 1), 2);
    const confirmed = settle(retrying, 'confirmed', 2);
    const lateRefusal = settle(confirmed, 'refused', 1);
    expect(lateRefusal).toBe(confirmed);
    expect(projectStopRequest(lateRefusal).alert).toBeNull();
  });

  it('fences a settlement that belongs to a Session the view has left', () => {
    const requesting = begin(initialStopRequestState, 1, 'session-1');
    const moved = reduceStopRequest(requesting, { type: 'begin', attempt: 1, sessionId: 'session-2' });
    const stale = settle(moved, 'confirmed', 1, 'session-1');
    expect(stale).toBe(moved);
  });

  it('ignores a settlement that arrives with nothing in flight', () => {
    const idle = initialStopRequestState;
    expect(settle(idle, 'confirmed', 1)).toBe(idle);
  });

  it('clears a claim back to idle and re-arms nothing by accident', () => {
    const refused = settle(begin(initialStopRequestState, 1), 'refused', 1);
    const cleared = reduceStopRequest(refused, { type: 'clear' });
    expect(cleared).toEqual(initialStopRequestState);
    expect(projectStopRequest(cleared).alert).toBeNull();
  });

  it('returns the identical state when clearing an already idle claim', () => {
    const idle = initialStopRequestState;
    expect(reduceStopRequest(idle, { type: 'clear' })).toBe(idle);
  });

  it('never mutates the state it is given', () => {
    const frozen = Object.freeze({ ...begin(initialStopRequestState, 1) });
    expect(() => settle(frozen, 'confirmed', 1)).not.toThrow();
    expect(() => begin(frozen, 2)).not.toThrow();
    expect(() => reduceStopRequest(frozen, { type: 'clear' })).not.toThrow();
    expect(frozen).toEqual({ status: 'requesting', attempt: 1, sessionId: 'session-1', reason: null });
  });

  it('answers whether a settlement still belongs to the live request', () => {
    const requesting = begin(initialStopRequestState, 4, 'session-9');
    expect(isCurrentStopRequest(requesting, 4, 'session-9')).toBe(true);
    expect(isCurrentStopRequest(requesting, 3, 'session-9')).toBe(false);
    expect(isCurrentStopRequest(requesting, 4, 'session-8')).toBe(false);
    // An idle claim owns no request at all, so a settlement that lands after a
    // clear — a Session switch, a new turn, a new chat — is never current.
    expect(isCurrentStopRequest(initialStopRequestState, 0, null)).toBe(false);
    expect(isCurrentStopRequest(settle(begin(initialStopRequestState, 1), 'confirmed', 1), 1, 'session-1')).toBe(false);
  });

  it('replays a whole attempt sequence without leaking state between attempts', () => {
    const events: StopRequestEvent[] = [
      { type: 'begin', attempt: 1, sessionId: 'session-1' },
      { type: 'settle', attempt: 1, sessionId: 'session-1', outcome: 'unavailable' },
      { type: 'begin', attempt: 2, sessionId: 'session-1' },
      { type: 'settle', attempt: 2, sessionId: 'session-1', outcome: 'refused' },
      { type: 'begin', attempt: 3, sessionId: 'session-1' },
      { type: 'settle', attempt: 3, sessionId: 'session-1', outcome: 'confirmed' },
    ];
    const final = events.reduce(reduceStopRequest, initialStopRequestState);
    expect(projectStopRequest(final)).toEqual({
      phase: 'idle',
      status: null,
      alert: null,
      retry: false,
      stopDisabled: false,
    });
  });

  it('exposes the retry label the surface already uses for a deliberate second stop', () => {
    expect(STOP_RETRY_LABEL).toBe('Retry stop');
  });
});

describe('decoding the native stop confirmation', () => {
  it('confirms only a real boolean true', () => {
    expect(decodeStopConfirmation(true)).toBe('confirmed');
  });

  it('treats an explicit false as a refusal', () => {
    expect(decodeStopConfirmation(false)).toBe('refused');
  });

  it('treats anything that is not a boolean as a refusal rather than a confirmation', () => {
    for (const value of [undefined, null, 'true', 1, 0, {}, [], Number.NaN]) {
      expect(decodeStopConfirmation(value)).toBe('refused');
    }
  });

  it('never confirms a value it cannot read as a boolean', () => {
    expect(decodeStopConfirmation({ cancelled: true })).toBe('refused');
  });
});
