import { describe, expect, it } from 'vitest';
import {
  initialRegistryState,
  parseActionRegistryAlerts,
  reduceRegistryState,
  type ActionRegistryAlert,
} from './action-registry-state';

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

const alert: ActionRegistryAlert = {
  id: 'escalated-action-1',
  kind: 'escalation',
  severity: 'high',
  title: 'Escalated action',
  message: 'P0 action escalated',
  action_id: 'action-1',
  count: null,
  created_at: '2026-09-24T01:00:00',
};

describe('Action Registry alert resource state', () => {
  it('validates the Native alert contract without turning malformed data into an empty ledger', () => {
    expect(parseActionRegistryAlerts([alert])).toEqual([alert]);
    expect(parseActionRegistryAlerts([{ ...alert, count: 2, action_id: null }])).toEqual([
      { ...alert, count: 2, action_id: null },
    ]);
    expect(() => parseActionRegistryAlerts({ alerts: [alert] })).toThrow();
    expect(() => parseActionRegistryAlerts([{ ...alert, created_at: null }])).toThrow();
    expect(() => parseActionRegistryAlerts([{ ...alert, count: -1 }])).toThrow();
    expect(() => parseActionRegistryAlerts([{ ...alert, action_id: 7 }])).toThrow();
  });

  it('distinguishes pending, successful empty, failure, and read-only retry', () => {
    const pending = reduceRegistryState(
      initialRegistryState<ActionRegistryAlert[]>(),
      { type: 'pending', requestId: 1 },
    );
    const failed = reduceRegistryState(pending, { type: 'failure', requestId: 1 });
    expect(failed).toEqual({ snapshot: null, loading: false, error: true, requestId: 1 });
    const retry = reduceRegistryState(failed, { type: 'pending', requestId: 2 });
    expect(retry).toEqual({ snapshot: null, loading: true, error: true, requestId: 2 });
    expect(reduceRegistryState(retry, { type: 'success', requestId: 2, snapshot: [] }))
      .toEqual({ snapshot: [], loading: false, error: false, requestId: 2 });
  });

  it('retains loaded alerts through refresh failure and ignores obsolete completions', () => {
    const loaded = reduceRegistryState(
      reduceRegistryState(initialRegistryState<ActionRegistryAlert[]>(), { type: 'pending', requestId: 1 }),
      { type: 'success', requestId: 1, snapshot: [alert] },
    );
    const pending = reduceRegistryState(loaded, { type: 'pending', requestId: 2 });
    const failed = reduceRegistryState(pending, { type: 'failure', requestId: 2 });
    expect(failed.snapshot).toEqual([alert]);
    expect(failed.error).toBe(true);

    const latest = reduceRegistryState(failed, {
      type: 'success',
      requestId: 3,
      snapshot: [{ ...alert, id: 'latest', title: 'Latest alert' }],
    });
    expect(reduceRegistryState(latest, {
      type: 'success',
      requestId: 2,
      snapshot: [{ ...alert, id: 'obsolete', title: 'Obsolete alert' }],
    })).toBe(latest);
    expect(reduceRegistryState(latest, { type: 'failure', requestId: 1 })).toBe(latest);
  });
});
