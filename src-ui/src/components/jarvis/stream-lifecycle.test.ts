import { describe, expect, it } from 'vitest';
import {
  classifyStreamTermination,
  STREAM_INCOMPLETE_CODE,
  STREAM_INCOMPLETE_MESSAGE,
} from './stream-lifecycle';

describe('Session stream terminal lifecycle', () => {
  it.each([
    ['result', 'success'],
    ['error', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('classifies an authoritative %s frame as %s', (terminalFrame, expected) => {
    expect(classifyStreamTermination({
      terminalFrame,
      inactivityTimedOut: false,
      aborted: false,
      stopRequested: false,
    })).toBe(expected);
  });

  it('classifies an unterminated EOF as non-success', () => {
    expect(classifyStreamTermination({
      terminalFrame: null,
      inactivityTimedOut: false,
      aborted: false,
      stopRequested: false,
    })).toBe('unterminated');
    expect(STREAM_INCOMPLETE_CODE).toBe('stream_incomplete');
    expect(STREAM_INCOMPLETE_MESSAGE).toContain('before a terminal frame');
  });

  it('keeps inactivity and deliberate aborts distinct from an incomplete EOF', () => {
    expect(classifyStreamTermination({
      terminalFrame: null,
      inactivityTimedOut: true,
      aborted: false,
      stopRequested: false,
    })).toBe('timed_out');
    expect(classifyStreamTermination({
      terminalFrame: null,
      inactivityTimedOut: false,
      aborted: true,
      stopRequested: false,
    })).toBe('cancelled');
    expect(classifyStreamTermination({
      terminalFrame: null,
      inactivityTimedOut: false,
      aborted: false,
      stopRequested: true,
    })).toBe('cancelled');
  });
});
