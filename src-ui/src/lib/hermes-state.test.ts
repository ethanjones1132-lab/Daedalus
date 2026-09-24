import { describe, expect, it } from 'vitest';
import { isHermesTurnEventForSession, normalizeHermesState } from './hermes-state';

describe('Hermes state boundaries', () => {
  it('normalizes native lifecycle values and fails closed on unknown values', () => {
    expect(normalizeHermesState('cold')).toBe('cold');
    expect(normalizeHermesState('starting')).toBe('starting');
    expect(normalizeHermesState('ready')).toBe('ready');
    expect(normalizeHermesState('draining')).toBe('draining');
    expect(normalizeHermesState('crashed')).toBe('unavailable');
    expect(normalizeHermesState('unknown')).toBe('unavailable');
    expect(normalizeHermesState(null)).toBe('unavailable');
  });

  it('requires exact non-empty Session ownership for turn events', () => {
    expect(isHermesTurnEventForSession('session-1', 'session-1', 'session-1')).toBe(true);
    expect(isHermesTurnEventForSession(null, 'session-1', 'session-1')).toBe(false);
    expect(isHermesTurnEventForSession('session-2', 'session-1', 'session-1')).toBe(false);
    expect(isHermesTurnEventForSession('session-1', '', 'session-1')).toBe(false);
    expect(isHermesTurnEventForSession('session-1', 'session-1', null)).toBe(false);
  });
});
