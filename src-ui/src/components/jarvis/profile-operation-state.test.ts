import { expect, it } from 'vitest';
import { reduceProfileOperation, profileOperationLocked } from './profile-operation-state';

it('holds the lock through write, reconciliation failure, and read-only retry', () => {
  let phase = reduceProfileOperation('idle', 'submit');
  expect(phase).toBe('writing');
  expect(profileOperationLocked(phase)).toBe(true);
  phase = reduceProfileOperation(phase, 'written');
  expect(phase).toBe('reconciling');
  phase = reduceProfileOperation(phase, 'read-failed');
  expect(phase).toBe('reconciliation-failed');
  expect(profileOperationLocked(phase)).toBe(true);
  expect(reduceProfileOperation(phase, 'submit')).toBe(phase);
  phase = reduceProfileOperation(phase, 'retry-read');
  expect(phase).toBe('reconciling');
  phase = reduceProfileOperation(phase, 'observed');
  expect(phase).toBe('idle');
  expect(profileOperationLocked(phase)).toBe(false);
});

it('allows another submission after write rejection but never conflicting writes', () => {
  expect(reduceProfileOperation('writing', 'submit')).toBe('writing');
  expect(reduceProfileOperation('reconciling', 'submit')).toBe('reconciling');
  const failed = reduceProfileOperation('writing', 'write-failed');
  expect(failed).toBe('write-failed');
  expect(profileOperationLocked(failed)).toBe(false);
  expect(reduceProfileOperation(failed, 'submit')).toBe('writing');
  expect(reduceProfileOperation('writing', 'observed')).toBe('writing');
});
