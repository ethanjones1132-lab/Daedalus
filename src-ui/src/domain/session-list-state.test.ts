import { describe, expect, it } from 'vitest';
import { initialSessionListState, reduceSessionListState } from './session-list-state';

describe('Session list snapshot state', () => {
  it('keeps an unavailable list distinct from a successful empty list', () => {
    expect(initialSessionListState.sessions).toBeNull();
    const failed = reduceSessionListState(initialSessionListState, { type: 'failure' });
    expect(failed).toEqual({ sessions: null, loading: false, error: true });
    expect(reduceSessionListState(failed, { type: 'success', sessions: [] }))
      .toEqual({ sessions: [], loading: false, error: false });
  });

  it('retains the exact known snapshot and error until a successful retry', () => {
    const loaded = reduceSessionListState(initialSessionListState, { type: 'success', sessions: [] });
    const pending = reduceSessionListState(loaded, { type: 'pending' });
    expect(pending.sessions).toBe(loaded.sessions);
    expect(pending.loading).toBe(true);
    const failed = reduceSessionListState(pending, { type: 'failure' });
    const retrying = reduceSessionListState(failed, { type: 'pending' });
    expect(retrying).toEqual({ sessions: loaded.sessions, loading: true, error: true });
    const recovered = reduceSessionListState(retrying, { type: 'success', sessions: [] });
    expect(recovered.error).toBe(false);
    expect(recovered.loading).toBe(false);
    expect(recovered.sessions).not.toBe(loaded.sessions);
  });
});
