import { describe, expect, it, vi } from 'vitest';
import {
  RUN_NOT_RECORDED_TEXT,
  RUN_OUTCOME_PENDING_TEXT,
  RUN_OUTCOME_UNAVAILABLE_TEXT,
  RUN_TELEMETRY_UNAVAILABLE_MESSAGE,
  decideSessionRunTelemetry,
  indexSessionRuns,
  sessionOutcomeView,
  singleFlightSessionRunRead,
  type SessionRunTelemetry,
} from './session-run-telemetry';
import type { SessionRunRecord } from './types';

const run = (over: Partial<SessionRunRecord> = {}): SessionRunRecord => ({
  session_id: 's-1',
  run_id: 'run-1',
  outcome: 'success',
  selected_model: 'test-model',
  token_count: 10,
  tool_count: 2,
  ...over,
});

describe('session-run-telemetry: a failed read is never an empty read', () => {
  it('reports a rejected native read as unavailable for every Session', () => {
    const telemetry = decideSessionRunTelemetry({ ok: false }, ['s-1', 's-2']);
    expect(telemetry.state).toBe('unavailable');
    expect(sessionOutcomeView(telemetry, 's-1')).toEqual({ kind: 'unavailable' });
    expect(sessionOutcomeView(telemetry, 's-2')).toEqual({ kind: 'unavailable' });
  });

  it('reports a non-array read result as unavailable rather than as no runs', () => {
    for (const value of [null, undefined, 0, '', 'ok', {}, { rows: [] }, [null], [undefined], [[]], [42]]) {
      const telemetry = decideSessionRunTelemetry({ ok: true, value }, ['s-1']);
      expect(telemetry.state, JSON.stringify(value ?? null)).toBe('unavailable');
    }
  });

  it('rejects the whole read when one entry is malformed instead of trusting the rest', () => {
    const values: unknown[] = [
      [run(), { session_id: 's-2' }],
      [run(), { ...run({ session_id: 's-2' }), session_id: 7 }],
      [run(), { ...run({ session_id: 's-2' }), run_id: null }],
      [run(), { ...run({ session_id: 's-2' }), outcome: {} }],
      ['not-a-record'],
    ];
    for (const value of values) {
      expect(decideSessionRunTelemetry({ ok: true, value }, ['s-1']).state, JSON.stringify(value)).toBe('unavailable');
    }
  });

  it('does not carry native error text in the unavailable verdict', async () => {
    const read = singleFlightSessionRunRead(async () => {
      throw new Error('sqlite: /Users/operator/.openclaw/jarvis.db locked');
    });
    const verdict = await read();
    expect(verdict).toEqual({ ok: false });
    expect(Object.keys(verdict)).toEqual(['ok']);
  });
});

describe('session-run-telemetry: a confirmed read is authoritative', () => {
  it('reads a confirmed empty result as no runs recorded, never as unavailable', () => {
    const telemetry = decideSessionRunTelemetry({ ok: true, value: [] }, ['s-1']);
    expect(telemetry.state).toBe('available');
    expect(sessionOutcomeView(telemetry, 's-1')).toEqual({ kind: 'not_recorded' });
  });

  it('exposes the recorded outcome and model for a Session that has one', () => {
    const recorded = run({ outcome: 'timed_out', selected_model: 'slow-model' });
    const telemetry = decideSessionRunTelemetry({ ok: true, value: [recorded] }, ['s-1']);
    const view = sessionOutcomeView(telemetry, 's-1');
    expect(view.kind).toBe('recorded');
    expect(view.kind === 'recorded' && view.run.outcome).toBe('timed_out');
    expect(view.kind === 'recorded' && view.run.selected_model).toBe('slow-model');
  });

  it('drops runs belonging to Sessions that are no longer visible', () => {
    const telemetry = decideSessionRunTelemetry(
      { ok: true, value: [run({ session_id: 'gone' }), run({ session_id: 's-1' })] },
      ['s-1'],
    );
    expect(Object.keys(telemetry.state === 'available' ? telemetry.runs : {})).toEqual(['s-1']);
  });

  it('keeps the newest recorded run when one Session has several rows', () => {
    const newest = run({ run_id: 'run-new', outcome: 'failed' });
    const older = run({ run_id: 'run-old', outcome: 'success' });
    const telemetry = decideSessionRunTelemetry({ ok: true, value: [newest, older] }, ['s-1']);
    const view = sessionOutcomeView(telemetry, 's-1');
    expect(view.kind === 'recorded' && view.run.run_id).toBe('run-new');
  });

  it('is order independent on the visible Session set and never mutates its input', () => {
    const visible = new Set(['s-1']);
    const runs = [run({ session_id: 's-1' }), run({ session_id: 's-2' })];
    const indexed = indexSessionRuns(runs, visible);
    expect(Object.keys(indexed)).toEqual(['s-1']);
    expect(runs).toHaveLength(2);
  });
});

describe('session-run-telemetry: fixed operator-facing vocabulary', () => {
  it('distinguishes the four per-row states in text', () => {
    expect(RUN_OUTCOME_PENDING_TEXT).toBe('reading run outcome…');
    expect(RUN_OUTCOME_UNAVAILABLE_TEXT).toBe('run outcome unavailable');
    expect(RUN_NOT_RECORDED_TEXT).toBe('no run recorded');
    expect(RUN_TELEMETRY_UNAVAILABLE_MESSAGE).toBe(
      'Could not read recorded run outcomes. Every Session below shows its run outcome as unavailable until a read succeeds.',
    );
  });

  it('keeps a pending read distinguishable from a failed and from a confirmed read', () => {
    const pending: SessionRunTelemetry = { state: 'pending' };
    expect(sessionOutcomeView(pending, 's-1')).toEqual({ kind: 'pending' });
    expect(sessionOutcomeView({ state: 'unavailable' }, 's-1')).toEqual({ kind: 'unavailable' });
    expect(sessionOutcomeView(decideSessionRunTelemetry({ ok: true, value: [] }, ['s-1']), 's-1'))
      .toEqual({ kind: 'not_recorded' });
  });
});

describe('session-run-telemetry: one in-flight native read', () => {
  it('issues one native read for concurrent callers and one more after it settles', async () => {
    const read = vi.fn(async () => [run()]);
    const reader = singleFlightSessionRunRead(read);
    const first = reader();
    const second = reader();
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toEqual({ ok: true, value: [run()] });
    await expect(second).resolves.toEqual({ ok: true, value: [run()] });
    expect(read).toHaveBeenCalledTimes(1);
    await reader();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight slot after a rejection so a later read retries', async () => {
    const read = vi.fn(async () => {
      throw new Error('locked');
    });
    const reader = singleFlightSessionRunRead(read);
    expect(await reader()).toEqual({ ok: false });
    expect(await reader()).toEqual({ ok: false });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
