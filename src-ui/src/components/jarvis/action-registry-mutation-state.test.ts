import { describe, expect, it } from 'vitest';
import {
  registryMutationConfirmed,
  registryMutationLocked,
  startRegistryMutation,
  transitionRegistryMutation,
} from './action-registry-mutation-state';

const alpha = { id: 'alpha', approval_status: 'approved' };
const blocked = { id: 'blocked', approval_status: 'waived' };
const snapshot = { active: [alpha], blocked: [blocked] };

 describe('action registry mutation state', () => {
  it('serializes write, readback, and read-only recovery phases', () => {
    let mutation = startRegistryMutation('approve', 'alpha');
    expect(mutation.phase).toBe('writing');
    expect(registryMutationLocked(mutation)).toBe(true);
    mutation = transitionRegistryMutation(mutation, 'write-succeeded')!;
    expect(mutation.phase).toBe('reconciling');
    mutation = transitionRegistryMutation(mutation, 'read-failed')!;
    expect(mutation.phase).toBe('read-failed');
    expect(registryMutationLocked(mutation)).toBe(true);
    mutation = transitionRegistryMutation(mutation, 'retry-read')!;
    expect(mutation.phase).toBe('reconciling');
    expect(transitionRegistryMutation(mutation, 'read-succeeded')).toBeNull();
  });

  it('releases a failed write for an explicit retry without treating it as confirmed', () => {
    const failed = transitionRegistryMutation(startRegistryMutation('dispatch', 'alpha'), 'write-failed')!;
    expect(failed.phase).toBe('write-failed');
    expect(registryMutationLocked(failed)).toBe(false);
    const retried = startRegistryMutation(failed.kind, failed.id);
    expect(retried.phase).toBe('writing');
    expect(registryMutationLocked(retried)).toBe(true);
  });

  it('confirms approval from either bucket and dispatch only after the active row disappears', () => {
    expect(registryMutationConfirmed(startRegistryMutation('sync'), snapshot)).toBe(true);
    expect(registryMutationConfirmed(startRegistryMutation('approve', 'alpha'), snapshot)).toBe(true);
    expect(registryMutationConfirmed(startRegistryMutation('waive', 'blocked'), snapshot)).toBe(true);
    expect(registryMutationConfirmed(startRegistryMutation('approve', 'alpha'), { active: [], blocked: [{ id: 'alpha', approval_status: 'pending' }] })).toBe(false);
    expect(registryMutationConfirmed(startRegistryMutation('dispatch', 'alpha'), snapshot)).toBe(false);
    expect(registryMutationConfirmed(startRegistryMutation('dispatch', 'alpha'), { active: [], blocked: [] })).toBe(true);
  });
});
