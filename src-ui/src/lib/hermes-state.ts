export type HermesLifecycleState = 'cold' | 'starting' | 'ready' | 'draining' | 'unavailable';

export const HERMES_UNAVAILABLE_REASON = 'Hermes Bridge is unavailable.';
export const HERMES_START_FAILED_REASON = 'Could not start Hermes Bridge.';
export const HERMES_STOP_FAILED_REASON = 'Could not stop the Hermes turn.';
export const HERMES_TURN_FAILED = 'Hermes turn failed.';
export const HERMES_SUBMIT_FAILED_REASON = 'Could not submit the Hermes prompt.';
export const HERMES_TURN_STOPPED = 'Session turn stopped.';

export function normalizeHermesState(value: unknown): HermesLifecycleState {
  if (value === 'cold' || value === 'starting' || value === 'ready' || value === 'draining') {
    return value;
  }
  return 'unavailable';
}

export function isHermesTurnEventForSession(
  eventSessionId: string | null,
  activeSessionId: string,
  turnSessionId: string | null,
): boolean {
  return Boolean(
    eventSessionId
      && activeSessionId
      && turnSessionId
      && eventSessionId === activeSessionId
      && eventSessionId === turnSessionId,
  );
}
