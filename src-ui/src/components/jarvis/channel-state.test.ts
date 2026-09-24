import { describe, expect, it } from 'vitest';
import { canVerifyChannel, channelId, channelLocked, isConfiguredChannel, isConnected, reconcileChannels, type ChannelOperation } from './channel-state';
const row = { id: 'a', connected: false, config: { connected: false } };
const connected = { ...row, config: { connected: true } };
const operation = (patch: Partial<ChannelOperation<typeof row>> = {}): ChannelOperation<typeof row> => ({
  row, action: 'connect', phase: 'reconciling', after: 2, ...patch,
});
describe('channel provisioning contract', () => {
  it('accepts only a configured Discord destination as verifiable', () => {
    const discord = { id: 'd', type: 'discord', connected: false, config: { channel_id: '123' } };
    expect(channelId(discord)).toBe('123');
    expect(isConfiguredChannel(discord)).toBe(true);
    expect(canVerifyChannel(discord)).toBe(true);
    expect(channelId({ ...discord, config: { channel_id: '  ' } })).toBe('');
    expect(canVerifyChannel({ ...discord, type: 'webhook' })).toBe(false);
    expect(canVerifyChannel({ ...discord, config: null })).toBe(false);
  });
});
describe('channel reconciliation', () => {
  it('preserves connection flag interpretation without inferring delivery', () => {
    expect(isConnected(row)).toBe(false);
    expect(isConnected(connected)).toBe(true);
    expect(isConnected({ connected: true, config: null })).toBe(true);
    expect(isConnected({ connected: false, config: { connected: 'true' } })).toBe(false);
  });
  it('locks all phases except rejected writes', () => {
    expect(channelLocked(undefined)).toBe(false);
    for (const phase of ['writing', 'reconciling', 'read-failed'] as const) expect(channelLocked(operation({ phase }))).toBe(true);
    expect(channelLocked(operation({ phase: 'write-failed' }))).toBe(false);
    expect(channelLocked(operation({ phase: 'verification-failed' }))).toBe(false);
  });
  it('retains pending rows even when a snapshot omits or changes them', () => {
    for (const snapshot of [[], [connected]]) {
      expect(reconcileChannels(snapshot, { a: operation({ phase: 'writing' }) }, 3).rows).toEqual([row]);
    }
  });
  it('requires a post-settlement snapshot to unlock', () => {
    const op = operation();
    expect(reconcileChannels([connected], { a: op }, 2)).toEqual({ rows: [row], operations: { a: op } });
    expect(reconcileChannels([connected], { a: op }, 3)).toEqual({ rows: [connected], operations: {} });
  });
  it('keeps contradictory or missing connection observations locked for read-only recovery', () => {
    for (const snapshot of [[], [row]]) {
      const result = reconcileChannels(snapshot, { a: operation() }, 3);
      expect(result.rows).toEqual([row]);
      expect(result.operations.a.phase).toBe('read-failed');
    }
    const result = reconcileChannels([connected], { a: operation({ row: connected, action: 'disconnect' }) }, 3);
    expect(result.operations.a.phase).toBe('read-failed');
    expect(reconcileChannels([row], { a: result.operations.a }, 4).operations).toEqual({});
  });
  it('reconciles deletion only when absent and leaves independent operations intact', () => {
    const other = { ...row, id: 'b' };
    const ops = { a: operation({ action: 'remove' }), b: operation({ row: other, phase: 'writing' }) };
    expect(reconcileChannels([row], ops, 3).operations.a.phase).toBe('read-failed');
    expect(reconcileChannels([], ops, 3)).toEqual({ rows: [other], operations: { b: ops.b } });
  });
  it('allows a fresh read after a rejected write without crediting it as a successful write', () => {
    const op = operation({ phase: 'write-failed' });
    expect(reconcileChannels([connected], { a: op }, 3)).toEqual({ rows: [connected], operations: {} });
  });
  it('clears a rejected verification on a later read without treating it as connected', () => {
    const op = operation({ phase: 'verification-failed' });
    expect(reconcileChannels([row], { a: op }, 3)).toEqual({ rows: [row], operations: {} });
  });
});
