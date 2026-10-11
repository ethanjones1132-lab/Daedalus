import { describe, expect, it, vi } from 'vitest';
import {
  RUN_NOT_RECORDED_TEXT,
  RUN_OUTCOME_PENDING_TEXT,
  RUN_OUTCOME_UNAVAILABLE_TEXT,
  RUN_RECORD_CONFIRMING_TEXT,
  RUN_RECORD_DISAGREED_MESSAGE,
  RUN_RECORD_READ_FAILED_MESSAGE,
  RUN_RECORD_UNRECORDED_MESSAGE,
  RUN_RECORD_WRITE_FAILED_MESSAGE,
  RUN_RECORD_WRITING_TEXT,
  RUN_TELEMETRY_UNAVAILABLE_MESSAGE,
  decideRunRecord,
  decideSessionRunTelemetry,
  indexSessionRuns,
  runRecordView,
  sessionOutcomeView,
  singleFlightSessionRunRead,
  type RunRecordIntent,
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
    expect(view.kind === 'recorded' && view.olderCount).toBe(1);
  });

  it('counts every older run of a Session without counting another Session’s runs', () => {
    const telemetry = decideSessionRunTelemetry(
      {
        ok: true,
        value: [
          run({ run_id: 'run-1' }),
          run({ run_id: 'run-2' }),
          run({ run_id: 'run-3' }),
          run({ run_id: 'other-1', session_id: 's-2' }),
          run({ run_id: 'hidden-1', session_id: 'gone' }),
        ],
      },
      ['s-1', 's-2'],
    );
    expect(sessionOutcomeView(telemetry, 's-1')).toMatchObject({ kind: 'recorded', olderCount: 2 });
    expect(sessionOutcomeView(telemetry, 's-2')).toMatchObject({ kind: 'recorded', olderCount: 0 });
    expect(sessionOutcomeView(telemetry, 's-3')).toEqual({ kind: 'not_recorded' });
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

describe('session-run-telemetry: a recorded run is confirmed by read-back, not assumed', () => {
  const intent = (over: Partial<RunRecordIntent> = {}): RunRecordIntent => ({
    sessionId: 's-1',
    runId: 'run-77',
    outcome: 'success',
    ...over,
  });

  it('confirms only the durable run the read-back actually reports', () => {
    const stored = run({ run_id: 'run-77', outcome: 'success', selected_model: 'test-model' });
    const verdict = decideRunRecord(intent(), { ok: true }, { ok: true, value: [stored] });
    expect(verdict).toEqual({ phase: 'confirmed', run: stored });
  });

  it('confirms regardless of where the confirmed run sits in the newest-first list', () => {
    const stored = run({ run_id: 'run-77', outcome: 'success' });
    const verdict = decideRunRecord(
      intent(),
      { ok: true },
      { ok: true, value: [run({ run_id: 'run-78' }), stored] },
    );
    expect(verdict).toEqual({ phase: 'confirmed', run: stored });
  });

  it('never reports a write the read-back does not contain as recorded', () => {
    for (const value of [[], [run({ run_id: 'run-other' })]]) {
      expect(decideRunRecord(intent(), { ok: true }, { ok: true, value })).toEqual({ phase: 'unrecorded' });
    }
  });

  it('never confirms a run recorded against another Session', () => {
    const foreign = run({ run_id: 'run-77', session_id: 's-2' });
    expect(decideRunRecord(intent(), { ok: true }, { ok: true, value: [foreign] })).toEqual({
      phase: 'disagreed',
      run: foreign,
    });
  });

  it('renders the stored outcome when the read-back disagrees with the local one', () => {
    const stored = run({ run_id: 'run-77', outcome: 'cancelled', cancelled_reason: 'client_abort' });
    const verdict = decideRunRecord(intent({ outcome: 'success' }), { ok: true }, { ok: true, value: [stored] });
    expect(verdict).toEqual({ phase: 'disagreed', run: stored });
  });

  it('treats an outcome outside the recorded vocabulary as a disagreement, not a success', () => {
    const stored = run({ run_id: 'run-77', outcome: 'ok' as SessionRunRecord['outcome'] });
    expect(decideRunRecord(intent(), { ok: true }, { ok: true, value: [stored] })).toEqual({
      phase: 'disagreed',
      run: stored,
    });
  });

  it('treats a failed or undecodable read-back as unconfirmed, never as recorded', () => {
    expect(decideRunRecord(intent(), { ok: true }, { ok: false })).toEqual({ phase: 'unreadable' });
    const malformedId = { ...run(), run_id: 7 } as unknown as SessionRunRecord;
    for (const value of [null, {}, 'ok', [[]], [malformedId]]) {
      expect(decideRunRecord(intent(), { ok: true }, { ok: true, value }), JSON.stringify(value ?? null))
        .toEqual({ phase: 'unreadable' });
    }
  });

  it('reports a rejected write instead of a read-back that would have confirmed it', () => {
    const readable = run({ run_id: 'run-77' });
    expect(decideRunRecord(intent(), { ok: false }, { ok: true, value: [readable] }))
      .toEqual({ phase: 'write_failed' });
    expect(decideRunRecord(intent(), { ok: false }, { ok: true, value: [readable] }).phase)
      .not.toBe('confirmed');
  });

  it('never mutates the stored row it reports', () => {
    const stored = Object.freeze({ ...run({ run_id: 'run-77', outcome: 'partial' }) });
    const verdict = decideRunRecord(intent({ outcome: 'success' }), { ok: true }, { ok: true, value: [stored] });
    expect(verdict).toEqual({ phase: 'disagreed', run: stored });
    expect(stored).toEqual({ ...run({ run_id: 'run-77', outcome: 'partial' }) });
  });
});

describe('session-run-telemetry: the run-record surface is readable and retryable', () => {
  const intent: RunRecordIntent = { sessionId: 's-1', runId: 'run-77', outcome: 'success' };

  it('says nothing before a run record exists', () => {
    expect(runRecordView(null)).toBeNull();
  });

  it('announces the in-flight write and its read-back as pending, never as recorded', () => {
    const writing = runRecordView({ intent, phase: 'writing' });
    expect(writing?.text).toBe(RUN_RECORD_WRITING_TEXT);
    expect(writing?.confirmed).toBe(false);
    expect(writing?.retryable).toBe(false);
    const confirming = runRecordView({ intent, phase: 'confirming' });
    expect(confirming?.text).toBe(RUN_RECORD_CONFIRMING_TEXT);
    expect(confirming?.confirmed).toBe(false);
    expect(confirming?.retryable).toBe(false);
  });

  it('announces a confirmed run as confirmed and names the durable run id', () => {
    const view = runRecordView({
      intent,
      phase: 'confirmed',
      run: { ...run(), run_id: 'run-77', outcome: 'success' },
    });
    expect(view?.confirmed).toBe(true);
    expect(view?.retryable).toBe(false);
    expect(view?.text).toContain('run-77');
    expect(view?.text).toContain('success');
  });

  it('names the stored outcome when the read-back disagrees, and does not offer a rewrite', () => {
    const view = runRecordView({
      intent: { ...intent, outcome: 'success' },
      phase: 'disagreed',
      run: { ...run(), run_id: 'run-77', outcome: 'cancelled' },
    });
    expect(view?.confirmed).toBe(false);
    expect(view?.retryable).toBe(false);
    expect(view?.text).toContain('cancelled');
    expect(view?.text).toBe(RUN_RECORD_DISAGREED_MESSAGE('run-77', 'success', 'cancelled'));
  });

  it('offers a deliberate retry for an unrecorded, unreadable, and rejected write', () => {
    for (const phase of ['unrecorded', 'unreadable', 'write_failed'] as const) {
      const view = runRecordView({ intent, phase });
      expect(view?.retryable, phase).toBe(true);
      expect(view?.confirmed, phase).toBe(false);
    }
    expect(runRecordView({ intent, phase: 'unrecorded' })?.text).toBe(RUN_RECORD_UNRECORDED_MESSAGE('run-77'));
    expect(runRecordView({ intent, phase: 'unreadable' })?.text).toBe(RUN_RECORD_READ_FAILED_MESSAGE('run-77'));
    expect(runRecordView({ intent, phase: 'write_failed' })?.text).toBe(RUN_RECORD_WRITE_FAILED_MESSAGE('run-77'));
  });

  it('keeps the operator-facing vocabulary free of native error text', () => {
    const nativeDetail = 'invalid terminal outcome: success\n  at /Users/operator/.openclaw/jarvis.db';
    for (const phase of ['unrecorded', 'unreadable', 'write_failed'] as const) {
      const view = runRecordView({ intent, phase });
      expect(view?.text, phase).not.toContain(nativeDetail);
      expect(view?.text, phase).not.toMatch(/sqlite|\.db|Error:|at \/|terminal outcome:/);
    }
  });
});
