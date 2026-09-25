import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MAX_ITEMS,
  ACTIVITY_TEXT_LIMIT,
  activityLedgerItems,
  createActivityLedger,
  decodeConductorDirectiveFrame,
  reduceActivityLedger,
  type ActivityLedgerEvent,
  type ConductorDirectiveView,
} from './activity-ledger';

function frame(directive: unknown, sessionId = 'session-1') {
  return {
    type: 'conductor_directive',
    session_id: sessionId,
    stage: 'planner',
    directive,
  };
}

function validDirective(input: unknown): ConductorDirectiveView {
  const decoded = decodeConductorDirectiveFrame(frame(input));
  if (decoded.kind !== 'valid') throw new Error('expected a valid directive');
  return decoded.directive;
}

describe('decodeConductorDirectiveFrame', () => {
  it('accepts every current directive variant with bounded display data', () => {
    const directives: Array<[string, unknown]> = [
      ['continue', { type: 'continue' }],
      ['abort_stage', { type: 'abort_stage', stage: 'executor', reason: 'budget exhausted' }],
      ['reroute', { type: 'reroute', newRemaining: ['executor', 'reviewer'], reason: 'prioritize review' }],
      ['inject_context', { type: 'inject_context', forStage: 'executor', note: 'read the failing test', reason: 'missing context' }],
      ['mark_verified', {
        type: 'mark_verified',
        itemId: 'item-1',
        evidenceRef: 'evidence:1',
        evidenceSummary: 'tests passed',
        grounding: { source: 'runtime_check' },
        gradingMode: 'runtime_check',
        reason: 'authoritative check passed',
      }],
      ['escalate_reviewer', { type: 'escalate_reviewer', itemId: 'item-2', reason: 'local grade capacity', newRemaining: ['reviewer'] }],
      ['start_repair_chain', { type: 'start_repair_chain', itemId: 'item-3', reason: 'review found a gap', flaggedIssues: 'missing assertion', newRemaining: ['rewriter', 'executor', 'reviewer'] }],
      ['block_item', { type: 'block_item', itemId: 'item-4', reason: 'repair budget exhausted' }],
    ];

    for (const [type, directive] of directives) {
      const decoded = decodeConductorDirectiveFrame(frame(directive));
      expect(decoded.kind, type).toBe('valid');
      if (decoded.kind !== 'valid') continue;
      expect(decoded.directive.type, type).toBe(type);
      expect(decoded.directive.label.length, type).toBeGreaterThan(0);
      expect(decoded.directive.detail.length, type).toBeLessThanOrEqual(ACTIVITY_TEXT_LIMIT);
    }
  });

  it('rejects malformed and future directives without exposing their payloads', () => {
    const invalid = [
      { type: 'unknown_future_directive', reason: 'do not render this' },
      { type: 'abort_stage', stage: 'executor' },
      { type: 'reroute', newRemaining: ['not-a-stage'], reason: 'bad route' },
      { type: 'mark_verified', itemId: 'item', evidenceRef: 'evidence', grounding: null, gradingMode: 'runtime_check', reason: 'bad grounding' },
    ];

    for (const directive of invalid) {
      const decoded = decodeConductorDirectiveFrame(frame(directive));
      expect(decoded.kind).toBe('invalid');
      if (decoded.kind !== 'invalid') continue;
      expect(decoded.reason).toBe('malformed');
      expect(decoded.message).not.toContain('do not render this');
    }
  });

  it('ignores directives for another Session', () => {
    const decoded = decodeConductorDirectiveFrame(
      frame({ type: 'continue' }, 'session-2'),
      'session-1',
    );
    expect(decoded).toEqual({ kind: 'ignored', reason: 'session_mismatch' });
  });
});

describe('activity ledger reducer', () => {
  it('preserves stage, tool, directive, and result arrival order', () => {
    const reroute = validDirective({
      type: 'reroute',
      newRemaining: ['executor'],
      reason: 'use the executor next',
    });
    const repair = validDirective({
      type: 'start_repair_chain',
      itemId: 'item-1',
      reason: 'review found a gap',
      newRemaining: ['rewriter', 'executor', 'reviewer'],
    });
    const events: ActivityLedgerEvent[] = [
      { kind: 'stage', stage: 'planner', status: 'running' },
      { kind: 'tool_use', callId: 'call-1', name: 'read_file', arguments: { path: 'src/app.ts' } },
      { kind: 'directive', key: 'reroute-key', directive: reroute, stage: 'planner' },
      { kind: 'tool_result', callId: 'call-1', name: 'read_file', output: 'source loaded', isError: false },
      { kind: 'directive', key: 'repair-key', directive: repair, stage: 'reviewer' },
    ];

    const state = events.reduce(reduceActivityLedger, createActivityLedger());
    const items = activityLedgerItems(state);
    expect(items.map((item) => item.kind)).toEqual(['plan', 'tool', 'directive', 'tool_result', 'directive']);
    expect(items[2]).toMatchObject({ kind: 'directive', directive: { type: 'reroute' } });
    expect(items[3]).toMatchObject({ kind: 'tool_result', callId: 'call-1', isError: false });
    expect(items[4]).toMatchObject({ kind: 'directive', directive: { type: 'start_repair_chain' } });
    const tool = items[1];
    if (tool.kind !== 'tool') throw new Error('expected tool item');
    expect(tool.call.result).toBe('source loaded');
    expect(tool.call.terminalState).toBe('completed');
  });

  it('deduplicates repeated directives and bounds activity history and text', () => {
    const directive = validDirective({ type: 'continue' });
    let state = createActivityLedger();
    for (let i = 0; i < 100; i += 1) {
      state = reduceActivityLedger(state, { kind: 'directive', key: 'same-key', directive, stage: 'planner' });
    }
    expect(state.items.filter((item) => item.kind === 'directive')).toHaveLength(1);

    state = reduceActivityLedger(state, {
      kind: 'agent_activity',
      stage: 'executor',
      text: 'x'.repeat(ACTIVITY_TEXT_LIMIT * 4),
    });
    const plan = state.items.find((item) => item.kind === 'plan');
    expect(plan && 'text' in plan ? plan.text.length : 0).toBeLessThanOrEqual(ACTIVITY_TEXT_LIMIT);

    for (let i = 0; i < ACTIVITY_MAX_ITEMS + 20; i += 1) {
      state = reduceActivityLedger(state, { kind: 'stage', stage: `stage-${i}`, status: 'running' });
    }
    expect(state.items.length).toBeLessThanOrEqual(ACTIVITY_MAX_ITEMS);
  });

  it('closes unresolved tools on terminal outcomes', () => {
    let state = reduceActivityLedger(createActivityLedger(), {
      kind: 'tool_use',
      callId: 'call-open',
      name: 'grep',
      arguments: { pattern: 'needle' },
    });
    state = reduceActivityLedger(state, { kind: 'terminal', outcome: 'cancelled' });

    const tool = activityLedgerItems(state).find((item) => item.kind === 'tool');
    if (!tool || tool.kind !== 'tool') throw new Error('expected tool item');
    expect(tool.call.terminalState).toBe('cancelled');
    expect(tool.call.result).toContain('cancelled');
    expect(tool.call.result).not.toBe('');
  });

  it('records one bounded diagnostic for malformed directives', () => {
    let state = createActivityLedger();
    state = reduceActivityLedger(state, { kind: 'diagnostic', text: 'Conductor directive could not be decoded.' });
    state = reduceActivityLedger(state, { kind: 'diagnostic', text: 'Conductor directive could not be decoded.' });
    const diagnostics = state.items.filter((item) => item.kind === 'diagnostic');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].text.length).toBeLessThanOrEqual(ACTIVITY_TEXT_LIMIT);
  });
});
