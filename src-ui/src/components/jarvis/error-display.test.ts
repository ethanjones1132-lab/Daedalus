import { describe, expect, it } from 'vitest';
import { errorDisplayForCode } from './error-display';

describe('errorDisplayForCode', () => {
  it('returns a friendly amber label + actionable hint for turn_deadline_exceeded', () => {
    const display = errorDisplayForCode('turn_deadline_exceeded');
    expect(display.label).toBe('turn deadline');
    expect(display.pillVariant).toBe('warn');
    expect(display.hint).toBeTruthy();
    // The hint should mention retry, since the model was not actually broken —
    // the turn simply took longer than the configured per-turn budget.
    expect(display.hint?.toLowerCase()).toContain('retry');
  });

  it('returns a red label + switch-backend hint for first_token_timeout', () => {
    const display = errorDisplayForCode('first_token_timeout');
    expect(display.label).toBe('first-token timeout');
    expect(display.pillVariant).toBe('error');
    expect(display.hint).toBeTruthy();
  });

  it('returns a red label + switch-backend hint for stream_idle_timeout', () => {
    const display = errorDisplayForCode('stream_idle_timeout');
    expect(display.label).toBe('stream stalled');
    expect(display.pillVariant).toBe('error');
    expect(display.hint).toBeTruthy();
  });

  it('returns a warn label + retry hint for visible_progress_timeout', () => {
    const display = errorDisplayForCode('visible_progress_timeout');
    expect(display.label).toBe('no visible progress');
    expect(display.pillVariant).toBe('warn');
    expect(display.hint).toBeTruthy();
  });

  it('falls back to a generic error label for unknown codes', () => {
    const display = errorDisplayForCode('some-unknown-code');
    expect(display.label).toBe('error');
    expect(display.pillVariant).toBe('error');
    // Unknown codes do not get a hint — the raw server message is the only
    // information we have, and a misleading hint would be worse than none.
    expect(display.hint).toBeUndefined();
  });

  it('returns a warn (not error) variant for turn_deadline_exceeded — this is the key UX call', () => {
    // A turn deadline is a soft failure: the model was producing output, it
    // just took too long. Surfacing it as a hard red error makes the user
    // think the model is broken when really it was just slow. Warn amber
    // communicates "soft stop, try again" without the alarm of a red pill.
    const display = errorDisplayForCode('turn_deadline_exceeded');
    expect(display.pillVariant).not.toBe('error');
  });
});
