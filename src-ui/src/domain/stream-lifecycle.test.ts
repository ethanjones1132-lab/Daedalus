import { describe, expect, it } from 'vitest';
import {
  acceptFirstTerminal,
  classifyStreamTermination,
  decodeResultFrame,
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

  it('decodes explicit success and legacy results without a subtype', () => {
    expect(decodeResultFrame({ type: 'result', subtype: 'success', result: 'done' })).toMatchObject({
      frame: 'result',
      outcome: 'success',
      text: 'done',
      hardError: false,
    });
    expect(decodeResultFrame({ type: 'result', result: 'legacy' })).toMatchObject({
      frame: 'result',
      outcome: 'success',
      text: 'legacy',
      hardError: false,
    });
  });

  it('decodes timeout results with their server-reported code', () => {
    expect(decodeResultFrame({ type: 'result', code: 'stage_timeout', content: 'slow' })).toMatchObject({
      outcome: 'timed_out',
      code: 'stage_timeout',
      text: 'slow',
      hardError: false,
    });
  });

  it('keeps a reported partial reason and never invents one', () => {
    // Audit item 2: the client used to synthesise `inference_partial` for every
    // partial result that carried no code, then render it as if the server had
    // recorded that reason. A partial turn stays partial; an unreported reason
    // stays unreported.
    expect(decodeResultFrame({
      type: 'result',
      subtype: 'partial',
      code: 'upstream_stage_failed',
      result: 'useful',
    })).toEqual({
      frame: 'result',
      outcome: 'partial',
      code: 'upstream_stage_failed',
      text: 'useful',
      hardError: false,
    });

    const unreported = decodeResultFrame({ type: 'result', subtype: 'partial', result: 'useful' });
    expect(unreported.outcome).toBe('partial');
    expect(unreported.text).toBe('useful');
    expect(unreported.hardError).toBe(false);
    expect(unreported.code).toBeUndefined();
  });

  it('gives is_error precedence and rejects explicit unknown result subtypes', () => {
    expect(decodeResultFrame({
      type: 'result',
      subtype: 'partial',
      code: 'stage_timeout',
      is_error: true,
      result: 'failed',
    })).toMatchObject({
      outcome: 'failed',
      code: 'stage_timeout',
      hardError: true,
    });
    expect(decodeResultFrame({ type: 'result', subtype: 'error', code: 'provider_failed' })).toMatchObject({
      outcome: 'failed',
      code: 'provider_failed',
      hardError: true,
    });
    expect(decodeResultFrame({ type: 'result', subtype: 'mystery' })).toMatchObject({
      outcome: 'failed',
      code: 'inference_failed',
      hardError: true,
    });
    expect(decodeResultFrame({ type: 'result', subtype: '' })).toMatchObject({
      outcome: 'failed',
      code: 'inference_failed',
      hardError: true,
    });
    expect(decodeResultFrame(null)).toMatchObject({
      outcome: 'failed',
      code: 'inference_failed',
      hardError: true,
    });
  });

  it('accepts only the first terminal decision', () => {
    const partial = decodeResultFrame({ type: 'result', subtype: 'partial', result: 'partial' });
    const success = decodeResultFrame({ type: 'result', subtype: 'success', result: 'success' });
    expect(acceptFirstTerminal(null, partial)).toBe(partial);
    expect(acceptFirstTerminal(partial, success)).toBe(partial);
    expect(classifyStreamTermination({
      terminalFrame: partial.frame,
      terminalOutcome: partial.outcome,
      inactivityTimedOut: true,
      aborted: false,
      stopRequested: false,
    })).toBe('partial');
  });
});
