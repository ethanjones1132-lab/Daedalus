import { describe, expect, it } from 'vitest';
import { initialDiscoveryState, reduceDiscoveryState } from './agent-discovery-state';

describe('Agent discovery snapshot', () => {
  it('distinguishes unknown from a successful empty scan', () => {
    expect(initialDiscoveryState.agents).toBeNull();
    const failed = reduceDiscoveryState(initialDiscoveryState, { type: 'failure' });
    expect(failed).toEqual({ agents: null, loading: false, error: true });
    expect(reduceDiscoveryState(failed, { type: 'success', agents: [] }))
      .toEqual({ agents: [], loading: false, error: false });
  });
  it('retains the snapshot and error through retry until success replaces both', () => {
    const agents = [{ id: 'coder', slug: 'coder', status: 'valid' }];
    const loaded = reduceDiscoveryState(initialDiscoveryState, { type: 'success', agents });
    const failed = reduceDiscoveryState(loaded, { type: 'failure' });
    const retrying = reduceDiscoveryState(failed, { type: 'pending' });
    expect(retrying).toEqual({ agents, loading: true, error: true });
    expect(reduceDiscoveryState(retrying, { type: 'success', agents: [] }))
      .toEqual({ agents: [], loading: false, error: false });
  });
});
