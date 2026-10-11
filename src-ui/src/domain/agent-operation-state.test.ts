import { describe, expect, it } from 'vitest';
import {
  agentOperationLocked,
  reconcileAgents,
  type Agent,
  type AgentOperation,
} from './agent-operation-state';

const alpha: Agent = {
  id: 'a1', name: 'Atlas', description: 'old', model: 'old-model', backend: 'jarvis',
  system_prompt: 'old prompt', enabled: true, config: null, created_at: '', updated_at: '',
};
const beta: Agent = { ...alpha, id: 'b1', name: 'Beta' };
const disabledAlpha: Agent = { ...alpha, enabled: false };
const updatedAlpha: Agent = {
  ...alpha,
  name: 'Atlas Updated',
  description: 'new',
  model: 'new-model',
  system_prompt: 'new prompt',
};

function operation(overrides: Partial<AgentOperation> = {}): AgentOperation {
  return {
    id: alpha.id,
    row: alpha,
    action: 'edit',
    phase: 'reconciling',
    after: 1,
    expected: {
      name: 'Atlas Updated',
      description: 'new',
      model: 'new-model',
      system_prompt: 'new prompt',
      enabled: true,
    },
    ...overrides,
  };
}

describe('Agent operation state', () => {
  it('locks every phase except a failed write', () => {
    expect(agentOperationLocked(operation({ phase: 'writing' }))).toBe(true);
    expect(agentOperationLocked(operation({ phase: 'reconciling' }))).toBe(true);
    expect(agentOperationLocked(operation({ phase: 'read-failed' }))).toBe(true);
    expect(agentOperationLocked(operation({ phase: 'write-failed' }))).toBe(false);
    expect(agentOperationLocked(undefined)).toBe(false);
  });

  it('does not let a read at or before the write barrier confirm a mutation', () => {
    const pending = operation({ after: 4 });
    const result = reconcileAgents([updatedAlpha], { a1: pending }, 4);
    expect(result.operations.a1).toEqual(pending);
    expect(result.rows[0]).toEqual(alpha);
    expect(result.confirmed).toEqual([]);
  });

  it('confirms identity, enablement, and deletion only from a newer matching snapshot', () => {
    const identity = reconcileAgents([updatedAlpha], { a1: operation() }, 2);
    expect(identity.operations).toEqual({});
    expect(identity.rows).toEqual([updatedAlpha]);
    expect(identity.confirmed).toEqual(['a1']);

    const enablement = reconcileAgents([disabledAlpha], {
      a1: operation({ action: 'disable', expected: { ...operation().expected, enabled: false } }),
    }, 2);
    expect(enablement.operations).toEqual({});
    expect(enablement.confirmed).toEqual(['a1']);

    const deletion = reconcileAgents([beta], {
      a1: operation({ action: 'delete', expected: { ...operation().expected } }),
    }, 2);
    expect(deletion.operations).toEqual({});
    expect(deletion.rows).toEqual([beta]);
    expect(deletion.confirmed).toEqual(['a1']);
  });

  it('retains the previous row and marks a contradictory read as failed', () => {
    const pending = operation();
    const result = reconcileAgents([alpha], { a1: pending }, 2);
    expect(result.operations.a1).toEqual({ ...pending, phase: 'read-failed' });
    expect(result.rows).toEqual([alpha]);
    expect(result.confirmed).toEqual([]);
  });

  it('clears a failed write on a fresh confirmed read without claiming success', () => {
    const failed = operation({ phase: 'write-failed', after: 1 });
    const result = reconcileAgents([alpha, beta], { a1: failed }, 2);
    expect(result.operations).toEqual({});
    expect(result.rows).toEqual([alpha, beta]);
    expect(result.confirmed).toEqual([]);
  });

  it('reconciles operations on independent Agents without coupling their locks', () => {
    const first = operation({ after: 1 });
    const second: AgentOperation = {
      id: beta.id,
      row: beta,
      action: 'enable',
      phase: 'reconciling',
      after: 1,
      expected: { ...operation().expected, enabled: true },
    };
    const result = reconcileAgents([updatedAlpha, { ...beta, enabled: false }], { a1: first, b1: second }, 2);
    expect(result.operations.b1).toEqual({ ...second, phase: 'read-failed' });
    expect(result.operations.a1).toBeUndefined();
    expect(result.rows).toEqual([updatedAlpha, beta]);
    expect(result.confirmed).toEqual(['a1']);
  });
});
