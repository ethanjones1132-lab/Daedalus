// Contracts for the approval queue's read-back decisions. `get_approvals`
// is a pending-only snapshot of a vector nothing writes into, so a decoded
// snapshot can only ever describe one read — never certify that the live
// approval gate is clear, and never confirm a decision that was not read
// back.
import { describe, expect, it } from 'vitest';
import {
  classifyDecisionWrite,
  classifyReadBack,
  decodeApprovalQueue,
  decideQueueCoverage,
  LIVE_GATE_CAVEAT,
  NO_REQUESTS_LISTED,
  type ApprovalRow,
} from './approval-queue-state';

const row = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: 'call-1',
  request_type: 'tool',
  description: 'Run npm test',
  agent_id: 'executor',
  created_at: '2026-09-25T10:00:00Z',
  status: 'pending',
  tool_name: 'bash',
  tool_args: '{"command":"npm test"}',
  ...over,
});

describe('decodeApprovalQueue', () => {
  it('accepts a valid empty snapshot as a confirmed empty read', () => {
    expect(decodeApprovalQueue([])).toEqual([]);
  });

  it('accepts a valid snapshot and normalises absent optional fields to null', () => {
    const withoutOptional: Record<string, unknown> = { ...row() };
    delete withoutOptional.tool_args;
    expect(decodeApprovalQueue([withoutOptional])).toEqual([row({ tool_args: null })]);
  });

  it('drops unknown fields and never mutates the decoded input', () => {
    const input = [{ ...row(), credential: 'sk-live-secret' }];
    const decoded = decodeApprovalQueue(input);
    expect(decoded).toEqual([row()]);
    expect(Object.keys(decoded![0]!).sort()).toEqual([
      'agent_id',
      'created_at',
      'description',
      'id',
      'request_type',
      'status',
      'tool_args',
      'tool_name',
    ]);
    expect(input[0]).toHaveProperty('credential', 'sk-live-secret');
  });

  it.each([null, undefined, {}, 'call-1', 7, { rows: [] }])(
    'reads a non-array root (%p) as unavailable, not as an empty queue',
    (root) => {
      expect(decodeApprovalQueue(root)).toBeNull();
    },
  );

  it.each([
    ['a null entry', null],
    ['a string entry', 'call-1'],
    ['an array entry', []],
    ['a missing id', { ...row(), id: undefined }],
    ['a blank id', row({ id: '' })],
    ['a non-string id', { ...row(), id: 7 }],
  ])('reads a snapshot with %s as unavailable', (_label, entry) => {
    expect(decodeApprovalQueue([entry])).toBeNull();
  });

  it.each(['request_type', 'description', 'agent_id', 'created_at', 'status'] as const)(
    'reads a snapshot with a missing or mistyped %s as unavailable',
    (field) => {
      expect(decodeApprovalQueue([{ ...row(), [field]: undefined }])).toBeNull();
      expect(decodeApprovalQueue([{ ...row(), [field]: 3 }])).toBeNull();
    },
  );

  it.each(['tool_name', 'tool_args'] as const)(
    'reads a snapshot whose %s is neither null nor a string as unavailable',
    (field) => {
      expect(decodeApprovalQueue([{ ...row(), [field]: 7 }])).toBeNull();
    },
  );

  it('discards a whole snapshot when any one entry is malformed', () => {
    expect(decodeApprovalQueue([row(), { ...row({ id: 'call-2' }), status: null }])).toBeNull();
  });
});

describe('decideQueueCoverage', () => {
  it('reads a read in flight as pending, whatever the previous rows were', () => {
    expect(decideQueueCoverage({ loading: true, unavailable: false, rows: 0 })).toBe('pending');
    expect(decideQueueCoverage({ loading: true, unavailable: true, rows: 2 })).toBe('pending');
  });

  it('reads an unreadable queue as unavailable rather than empty', () => {
    expect(decideQueueCoverage({ loading: false, unavailable: true, rows: 0 })).toBe('unavailable');
    expect(decideQueueCoverage({ loading: false, unavailable: true, rows: 3 })).toBe('unavailable');
  });

  it('reads a confirmed empty read as "no requests listed", never as an all-clear', () => {
    expect(decideQueueCoverage({ loading: false, unavailable: false, rows: 0 })).toBe('no_requests_listed');
  });

  it('reads any listed request as awaiting a decision', () => {
    expect(decideQueueCoverage({ loading: false, unavailable: false, rows: 1 })).toBe('awaiting_decision');
  });
});

describe('classifyDecisionWrite', () => {
  it('confirms only an explicit true from the native write', () => {
    expect(classifyDecisionWrite(true)).toBe('confirmed');
  });

  it('treats an explicit false as a write that was not saved', () => {
    expect(classifyDecisionWrite(false)).toBe('declined');
  });

  it.each([undefined, null, 'true', 1, 0, {}, []])(
    'treats a non-boolean native result (%p) as unconfirmed rather than saved',
    (value) => {
      expect(classifyDecisionWrite(value)).toBe('malformed');
    },
  );
});

describe('classifyReadBack', () => {
  it('confirms a saved decision only when a later read no longer lists the request', () => {
    expect(classifyReadBack([], 'call-1')).toBe('absent');
    expect(classifyReadBack([row({ id: 'call-2' })], 'call-1')).toBe('absent');
  });

  it('refuses to confirm a decision the read still lists', () => {
    expect(classifyReadBack([row(), row({ id: 'call-2' })], 'call-1')).toBe('still_listed');
  });
});

describe('honest empty-queue wording', () => {
  it('states what the read proved and names the surface that holds the live gate', () => {
    expect(NO_REQUESTS_LISTED).toBe('No approval requests in the last read.');
    expect(NO_REQUESTS_LISTED.toLowerCase()).not.toContain('caught up');
    expect(NO_REQUESTS_LISTED.toLowerCase()).not.toContain('all clear');
    expect(LIVE_GATE_CAVEAT.toLowerCase()).toContain('not the live approval gate');
    expect(LIVE_GATE_CAVEAT.toLowerCase()).toContain('chat');
  });
});
