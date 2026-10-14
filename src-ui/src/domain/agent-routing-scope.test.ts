import { describe, expect, it } from 'vitest';
import {
  AGENT_RECORD_FIELD_BASIS,
  AGENT_RECORD_SCOPE,
  NO_MODEL_LABEL,
  decodeAgentModelLabel,
} from './agent-routing-scope';

describe('the two stores an Agent card can be read against', () => {
  it('names the record and the routing pool in the same sentence', () => {
    expect(AGENT_RECORD_SCOPE).toContain('Agent record');
    expect(AGENT_RECORD_SCOPE).toContain('Agent pool');
    expect(AGENT_RECORD_SCOPE).toContain('routing');
  });

  it('tells the operator that the record fields do not change routing', () => {
    expect(AGENT_RECORD_SCOPE).toMatch(/stored on that Agent record/i);
    expect(AGENT_RECORD_SCOPE).toMatch(/neither of them changes which model a turn uses/i);
  });

  it('scopes a record field away from the pool, in the words both controls use', () => {
    expect(AGENT_RECORD_FIELD_BASIS).toMatch(/A field on this Agent record/);
    expect(AGENT_RECORD_FIELD_BASIS).toContain('Agent pool');
    expect(AGENT_RECORD_FIELD_BASIS).toMatch(/not this field/i);
  });
});

describe('decodeAgentModelLabel', () => {
  it('keeps a readable label exactly as the record spelled it', () => {
    expect(decodeAgentModelLabel('qwen2.5-coder:7b')).toEqual({
      kind: 'labelled',
      label: 'qwen2.5-coder:7b',
      basis: AGENT_RECORD_FIELD_BASIS,
    });
  });

  it('keeps a label the operator typed with surrounding spaces, untrimmed', () => {
    expect(decodeAgentModelLabel('  gpt-4o  ')).toEqual({
      kind: 'labelled',
      label: '  gpt-4o  ',
      basis: AGENT_RECORD_FIELD_BASIS,
    });
  });

  it('carries the basis with every labelled verdict, so no caller can drop it', () => {
    expect(decodeAgentModelLabel('m1').basis).toBe(AGENT_RECORD_FIELD_BASIS);
  });

  it('reads an absent label as unlabelled rather than as an empty pill', () => {
    for (const value of ['', '   ', null, undefined, 42, {}, []]) {
      expect(decodeAgentModelLabel(value)).toEqual({
        kind: 'unlabelled',
        label: NO_MODEL_LABEL,
        basis: AGENT_RECORD_FIELD_BASIS,
      });
    }
  });

  it('says so in words the operator can read, not with a blank', () => {
    expect(NO_MODEL_LABEL).toBe('No model label');
    expect(NO_MODEL_LABEL).not.toMatch(/model:$/);
  });
});
