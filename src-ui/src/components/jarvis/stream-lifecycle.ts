export const STREAM_INCOMPLETE_CODE = 'stream_incomplete';
export const STREAM_INCOMPLETE_MESSAGE = 'Jarvis stream ended before a terminal frame. Retry the turn.';
export const PARTIAL_OUTPUT_LIMIT = 500;

export const STREAM_TIMEOUT_CODES = new Set([
  'stage_timeout',
  'first_token_timeout',
  'stream_idle_timeout',
  'visible_progress_timeout',
  'turn_deadline_exceeded',
]);

export type StreamTerminalFrame = 'result' | 'error' | 'cancelled' | null;
export type StreamTermination = 'success' | 'partial' | 'failed' | 'timed_out' | 'cancelled' | 'unterminated';
export type StreamTerminalOutcome = Exclude<StreamTermination, 'unterminated'>;

export interface DecodedStreamTerminal {
  frame: Exclude<StreamTerminalFrame, null>;
  outcome: StreamTerminalOutcome;
  code?: string;
  text: string;
  hardError: boolean;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function decodeResultFrame(frame: unknown): DecodedStreamTerminal {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    return { frame: 'result', outcome: 'failed', code: 'inference_failed', text: '', hardError: true };
  }
  const value = frame as Record<string, unknown>;
  const text = stringValue(value.result) ?? stringValue(value.content) ?? '';
  const code = stringValue(value.code);
  const hasSubtype = Object.prototype.hasOwnProperty.call(value, 'subtype');
  const subtype = typeof value.subtype === 'string' ? value.subtype : undefined;

  if (value.is_error === true) {
    return { frame: 'result', outcome: 'failed', code: code ?? 'inference_failed', text, hardError: true };
  }
  if (value.is_error !== undefined && typeof value.is_error !== 'boolean') {
    return { frame: 'result', outcome: 'failed', code: code ?? 'inference_failed', text, hardError: true };
  }
  if (code && STREAM_TIMEOUT_CODES.has(code)) {
    return { frame: 'result', outcome: 'timed_out', code, text, hardError: false };
  }
  if (!hasSubtype) {
    return { frame: 'result', outcome: 'success', text, hardError: false };
  }
  if (subtype === 'success') {
    return { frame: 'result', outcome: 'success', text, hardError: false };
  }
  if (subtype === 'partial') {
    return { frame: 'result', outcome: 'partial', code: code ?? 'inference_partial', text, hardError: false };
  }
  if (subtype === 'error') {
    return { frame: 'result', outcome: 'failed', code: code ?? 'inference_failed', text, hardError: true };
  }
  return { frame: 'result', outcome: 'failed', code: code ?? 'inference_failed', text, hardError: true };
}

export function acceptFirstTerminal<T>(current: T | null, next: T): T | null {
  return current ?? next;
}

export function boundedPartialOutput(text: string): string | undefined {
  return text ? text.slice(0, PARTIAL_OUTPUT_LIMIT) : undefined;
}

export function classifyStreamTermination({
  terminalFrame,
  terminalOutcome,
  inactivityTimedOut,
  aborted,
  stopRequested,
}: {
  terminalFrame: StreamTerminalFrame;
  terminalOutcome?: StreamTerminalOutcome | null;
  inactivityTimedOut: boolean;
  aborted: boolean;
  stopRequested: boolean;
}): StreamTermination {
  if (terminalOutcome) return terminalOutcome;
  if (terminalFrame === 'result') return 'success';
  if (terminalFrame === 'error') return 'failed';
  if (terminalFrame === 'cancelled') return 'cancelled';
  if (inactivityTimedOut) return 'timed_out';
  if (aborted || stopRequested) return 'cancelled';
  return 'unterminated';
}
