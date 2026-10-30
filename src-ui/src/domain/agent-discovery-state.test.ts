import { describe, expect, it } from 'vitest';
import { initialDiscoveryState, parseDiscoveryPayload, reduceDiscoveryState } from './agent-discovery-state';

describe('Agent discovery snapshot', () => {
  it('distinguishes unknown from a successful empty scan', () => {
    expect(initialDiscoveryState.agents).toBeNull();
    const failed = reduceDiscoveryState(initialDiscoveryState, { type: 'failure' });
    expect(failed).toEqual({ agents: null, loading: false, error: true, rootVerdict: null, rootResolvedPath: null });
    expect(reduceDiscoveryState(failed, { type: 'success', agents: [] }))
      .toEqual({ agents: [], loading: false, error: false, rootVerdict: null, rootResolvedPath: null });
  });
  it('retains the snapshot and error through retry until success replaces both', () => {
    const agents = [{ id: 'coder', slug: 'coder', status: 'valid' }];
    const loaded = reduceDiscoveryState(initialDiscoveryState, { type: 'success', agents });
    const failed = reduceDiscoveryState(loaded, { type: 'failure' });
    const retrying = reduceDiscoveryState(failed, { type: 'pending' });
    expect(retrying).toEqual({ agents, loading: true, error: true, rootVerdict: null, rootResolvedPath: null });
    expect(reduceDiscoveryState(retrying, { type: 'success', agents: [] }))
      .toEqual({ agents: [], loading: false, error: false, rootVerdict: null, rootResolvedPath: null });
  });
  it('keeps the last root verdict through a failed refresh until a success states a new one', () => {
    const loaded = reduceDiscoveryState(initialDiscoveryState, {
      type: 'success',
      agents: [],
      rootVerdict: 'missing',
      rootResolvedPath: 'C:\\Agents',
    });
    const failed = reduceDiscoveryState(loaded, { type: 'failure' });
    expect(failed.agents).toEqual([]);
    expect(failed.rootVerdict).toBe('missing');
    expect(failed.rootResolvedPath).toBe('C:\\Agents');
  });
});

describe('discovery payload parsing', () => {
  it('reads the historical bare array without inventing a root verdict', () => {
    const parsed = parseDiscoveryPayload([{ id: 'coder', slug: 'coder', status: 'valid' }]);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.rootVerdict).toBeNull();
    expect(parsed.rootResolvedPath).toBeNull();
  });

  it('reads the object shape and maps the fixed reason codes onto the four verdicts', () => {
    for (const [reason, verdict] of [
      ['agents_root_ok', 'ok'],
      ['agents_root_missing', 'missing'],
      ['agents_root_unreadable', 'unreadable'],
      ['agents_root_unconfigured', 'unconfigured'],
    ] as const) {
      const parsed = parseDiscoveryPayload({ agents: [], root_state: verdict, reason_code: reason, resolved_path: 'C:\\Agents' });
      expect(parsed.rootVerdict).toBe(verdict);
      expect(parsed.rootResolvedPath).toBe('C:\\Agents');
      expect(parsed.agents).toEqual([]);
    }
  });

  it('never moulds an unrecognised reason code into a verdict, and treats a missing path as unknown', () => {
    const parsed = parseDiscoveryPayload({ agents: [], reason_code: 'agents_root_exploded', resolved_path: 'C:\\Agents' });
    expect(parsed.rootVerdict).toBeNull();
    expect(parseDiscoveryPayload({ agents: [], reason_code: 'agents_root_ok' }).rootResolvedPath).toBeNull();
  });

  it('rejects a payload that carries no agent list', () => {
    expect(() => parseDiscoveryPayload({ root_state: 'ok' })).toThrow();
    expect(() => parseDiscoveryPayload(null)).toThrow();
  });
});
