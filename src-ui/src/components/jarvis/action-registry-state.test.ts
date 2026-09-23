import { describe, expect, it } from 'vitest';
import { initialRegistryState, reduceRegistryState } from './action-registry-state';

describe('action registry snapshot state', () => {
  it('distinguishes unknown, failed, and successfully empty snapshots', () => {
    const pending = reduceRegistryState(initialRegistryState<string[]>(), { type: 'pending', requestId: 1 });
    const failed = reduceRegistryState(pending, { type: 'failure', requestId: 1 });
    expect(failed).toEqual({ snapshot: null, loading: false, error: true, requestId: 1 });
    const retry = reduceRegistryState(failed, { type: 'pending', requestId: 2 });
    expect(retry.error).toBe(true);
    expect(reduceRegistryState(retry, { type: 'success', requestId: 2, snapshot: [] }))
      .toEqual({ snapshot: [], loading: false, error: false, requestId: 2 });
  });

  it('retains a whole snapshot through failure and pending retry', () => {
    const snapshot = { summary: 1, active: ['one'], blocked: [] };
    const loaded = reduceRegistryState(
      reduceRegistryState(initialRegistryState<typeof snapshot>(), { type: 'pending', requestId: 1 }),
      { type: 'success', requestId: 1, snapshot },
    );
    const pending = reduceRegistryState(loaded, { type: 'pending', requestId: 2 });
    const failed = reduceRegistryState(pending, { type: 'failure', requestId: 2 });
    expect(failed.snapshot).toBe(snapshot);
    expect(reduceRegistryState(failed, { type: 'pending', requestId: 3 }))
      .toEqual({ snapshot, loading: true, error: true, requestId: 3 });
  });

  it('ignores superseded successes and failures without ending the latest load', () => {
    const state = reduceRegistryState(initialRegistryState<string>(), { type: 'pending', requestId: 2 });
    expect(reduceRegistryState(state, { type: 'success', requestId: 1, snapshot: 'old' })).toBe(state);
    expect(reduceRegistryState(state, { type: 'failure', requestId: 1 })).toBe(state);
    const loaded = reduceRegistryState(state, { type: 'success', requestId: 2, snapshot: 'new' });
    expect(reduceRegistryState(loaded, { type: 'success', requestId: 1, snapshot: 'old' })).toBe(loaded);
    expect(reduceRegistryState(loaded, { type: 'failure', requestId: 1 })).toBe(loaded);
  });

  it('invalidates an in-flight read without erasing a confirmed snapshot', () => {
    const snapshot = { summary: 1, active: ['one'], blocked: [] };
    const loaded = reduceRegistryState(
      reduceRegistryState(initialRegistryState<typeof snapshot>(), { type: 'pending', requestId: 1 }),
      { type: 'success', requestId: 1, snapshot },
    );
    const invalidated = reduceRegistryState(loaded, { type: 'invalidate', requestId: 2 });
    expect(invalidated).toEqual({ snapshot, loading: false, error: false, requestId: 2 });
  });
});
