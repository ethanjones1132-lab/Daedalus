export const STREAM_INCOMPLETE_CODE = 'stream_incomplete';
export const STREAM_INCOMPLETE_MESSAGE = 'Jarvis stream ended before a terminal frame. Retry the turn.';

export type StreamTerminalFrame = 'result' | 'error' | 'cancelled' | null;
export type StreamTermination = 'success' | 'failed' | 'timed_out' | 'cancelled' | 'unterminated';

export function classifyStreamTermination({
  terminalFrame,
  inactivityTimedOut,
  aborted,
  stopRequested,
}: {
  terminalFrame: StreamTerminalFrame;
  inactivityTimedOut: boolean;
  aborted: boolean;
  stopRequested: boolean;
}): StreamTermination {
  if (terminalFrame === 'result') return 'success';
  if (terminalFrame === 'error') return 'failed';
  if (terminalFrame === 'cancelled') return 'cancelled';
  if (inactivityTimedOut) return 'timed_out';
  if (aborted || stopRequested) return 'cancelled';
  return 'unterminated';
}
