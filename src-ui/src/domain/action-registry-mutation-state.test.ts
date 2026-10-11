import { describe, expect, it } from 'vitest';
import {
  isRegistryDispatchUnavailable,
  isVerifiedRegistryDispatchEvidence,
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

  it('confirms approval from either bucket and dispatch only after complete evidence and disappearance', () => {
    expect(registryMutationConfirmed(startRegistryMutation('sync'), snapshot)).toBe(true);
    expect(registryMutationConfirmed(startRegistryMutation('approve', 'alpha'), snapshot)).toBe(true);
    expect(registryMutationConfirmed(startRegistryMutation('waive', 'blocked'), snapshot)).toBe(true);
    expect(registryMutationConfirmed(startRegistryMutation('approve', 'alpha'), { active: [], blocked: [{ id: 'alpha', approval_status: 'pending' }] })).toBe(false);
    expect(registryMutationConfirmed(startRegistryMutation('dispatch', 'alpha'), snapshot)).toBe(false);
    expect(registryMutationConfirmed(startRegistryMutation('dispatch', 'alpha'), { active: [], blocked: [] })).toBe(false);
    expect(registryMutationConfirmed(startRegistryMutation('dispatch', 'alpha'), { active: [], blocked: [] }, { run_id: 'run-alpha', status: 'verified', acceptance_result: 'passed' })).toBe(true);
  });

  it('rejects incomplete dispatch evidence and recognizes the fixed unavailable outcome', () => {
    expect(isVerifiedRegistryDispatchEvidence({})).toBe(false);
    expect(isVerifiedRegistryDispatchEvidence({ status: 'verified' })).toBe(false);
    expect(isVerifiedRegistryDispatchEvidence({ run_id: 'run-alpha', status: 'failed', acceptance_result: 'failed' })).toBe(false);
    expect(isVerifiedRegistryDispatchEvidence({ run_id: 'run-alpha', status: 'verified', acceptance_result: 'passed' })).toBe(true);
    expect(isRegistryDispatchUnavailable({ status: 'unavailable', code: 'verification_manifest_missing' })).toBe(true);
    expect(isRegistryDispatchUnavailable({ status: 'unavailable' })).toBe(false);
  });

  it('routes unavailable dispatch into read-only recovery without releasing the mutation lock', () => {
    let mutation = startRegistryMutation('dispatch', 'alpha');
    mutation = transitionRegistryMutation(mutation, 'dispatch-unavailable')!;
    expect(mutation.phase).toBe('unavailable');
    expect(mutation.unavailable).toBe(true);
    expect(registryMutationLocked(mutation)).toBe(true);
    mutation = transitionRegistryMutation(mutation, 'retry-read')!;
    expect(mutation.phase).toBe('reconciling');
    expect(mutation.unavailable).toBe(true);
    expect(registryMutationLocked(mutation)).toBe(true);
  });
});
