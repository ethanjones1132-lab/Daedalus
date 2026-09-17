import { describe, expect, it } from 'vitest';
import { initialBindingState, reduceBindingState } from './agent-binding-state';

describe('Agent binding snapshots', () => {
  it('distinguishes unknown from successful empty bindings', () => {
    expect(initialBindingState.bound).toBeNull();
    const failed = reduceBindingState(initialBindingState, { type: 'failure', error: 'read' });
    expect(failed.bound).toBeNull();
    expect(failed.phase).toBe('failed');
    expect(reduceBindingState(failed, { type: 'success', ids: [] })).toEqual({
      bound: [], phase: 'ready', error: null,
    });
  });
  it('retains the last retrieved snapshot through writes, reads, and failures until reconciliation succeeds', () => {
    const ready = reduceBindingState(initialBindingState, { type: 'success', ids: ['c1'] });
    const writing = reduceBindingState(ready, { type: 'pending', phase: 'updating' });
    expect(writing.bound).toEqual(['c1']);
    const failed = reduceBindingState(writing, { type: 'failure', error: 'write' });
    const retrying = reduceBindingState(failed, { type: 'pending', phase: 'loading' });
    expect(retrying).toEqual({ bound: ['c1'], phase: 'loading', error: 'write' });
    const readFailed = reduceBindingState(retrying, { type: 'failure', error: 'read' });
    expect(readFailed.bound).toEqual(['c1']);
    expect(reduceBindingState(readFailed, { type: 'success', ids: [] })).toEqual({
      bound: [], phase: 'ready', error: null,
    });
    expect(ready).toEqual({ bound: ['c1'], phase: 'ready', error: null });
  });
});
