import { describe, expect, it } from 'vitest';
import {
  candidatePerformanceView,
  decodeCandidatePerformance,
  decideCandidatePerformance,
  initialCandidatePerformanceState,
  reduceCandidatePerformance,
  type CandidatePerformance,
  type CandidatePerformanceResponse,
  type CandidatePerformanceState,
} from './skill-candidate-performance';

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'candidate-1',
    promoted_at: '2026-09-01T00:00:00.000Z',
    task_types: ['debug'],
    before: { runs: 3, successes: 2, success_rate: 2 / 3 },
    after: { runs: 5, successes: 5, success_rate: 1 },
    delta: 1 / 3,
    ...overrides,
  };
}

const http = (status: number, value: unknown): CandidatePerformanceResponse => ({ kind: 'http', status, value });

function settled(response: CandidatePerformanceResponse, requestId = 1): CandidatePerformanceState {
  const started = reduceCandidatePerformance(initialCandidatePerformanceState(), { type: 'start', requestId });
  return reduceCandidatePerformance(started, { type: 'settle', requestId, response });
}

describe('decodeCandidatePerformance', () => {
  it('decodes a complete envelope without mutating the read result', () => {
    const body = envelope();
    const decoded = decodeCandidatePerformance(body);
    expect(decoded).toEqual({ kind: 'measured', performance: body as unknown as CandidatePerformance });
    expect(body).toEqual(envelope());
  });

  it('reads the server-serialised null as a confirmed absence of any measurement', () => {
    expect(decodeCandidatePerformance(null)).toEqual({ kind: 'unmeasured' });
  });

  it.each([
    ['array root', []],
    ['string root', 'ok'],
    ['number root', 1],
    ['boolean root', true],
    ['empty object', {}],
  ])('rejects a %s rather than reading it as no measurement', (_label, value) => {
    expect(decodeCandidatePerformance(value)).toEqual({ kind: 'invalid' });
  });

  it('rejects an envelope missing any top-level field', () => {
    for (const field of ['before', 'after', 'task_types', 'id', 'promoted_at', 'delta']) {
      const body = envelope();
      delete body[field];
      expect(decodeCandidatePerformance(body), `missing ${field}`).toEqual({ kind: 'invalid' });
    }
  });

  it.each([
    ['runs', { successes: 0, success_rate: null }],
    ['successes', { runs: 1 }],
    ['success_rate', { runs: 1, successes: 1 }],
  ])('rejects a window missing %s', (_label, window) => {
    expect(decodeCandidatePerformance(envelope({ after: window }))).toEqual({ kind: 'invalid' });
  });

  it.each([
    ['an empty candidate id', { id: '' }],
    ['an empty promoted_at', { promoted_at: '' }],
    ['a non-string task type', { task_types: ['debug', 3] }],
    ['a negative run count', { before: { runs: -1, successes: 0, success_rate: null } }],
    ['a fractional run count', { after: { runs: 1.5, successes: 0, success_rate: null } }],
    ['more successes than runs', { after: { runs: 2, successes: 3, success_rate: 1 } }],
    ['a rate for a window with no runs', { after: { runs: 0, successes: 0, success_rate: 0 } }],
    ['a non-numeric rate', { after: { runs: 4, successes: 2, success_rate: '0.5' } }],
    ['a non-finite rate', { after: { runs: 4, successes: 2, success_rate: Number.POSITIVE_INFINITY } }],
    ['a rate above one', { after: { runs: 4, successes: 4, success_rate: 1.25 } }],
    ['a delta outside [-1, 1]', { delta: 1.4 }],
    ['a delta beside an unmeasured window', { before: { runs: 0, successes: 0, success_rate: null }, delta: 0 }],
    ['a non-numeric delta', { delta: '33%' }],
  ])('rejects %s so an undecodable rate can never be rendered', (_label, overrides) => {
    expect(decodeCandidatePerformance(envelope(overrides))).toEqual({ kind: 'invalid' });
  });

  it('accepts a measured window with zero successes', () => {
    const decoded = decodeCandidatePerformance(
      envelope({ after: { runs: 4, successes: 0, success_rate: 0 }, delta: -2 / 3 }),
    );
    expect(decoded.kind).toBe('measured');
  });
});

describe('decideCandidatePerformance', () => {
  it.each([
    [404, 'not_found'],
    [409, 'not_promoted'],
    [422, 'invalid_record'],
    [500, 'http_error'],
    [503, 'http_error'],
  ])('reads a %i response as unavailable (%s)', (status, reason) => {
    expect(decideCandidatePerformance(http(status, { error: 'private detail' }))).toEqual({
      kind: 'unavailable',
      reason,
    });
  });

  it('reads a transport failure as unavailable without a reason from the network error', () => {
    expect(decideCandidatePerformance({ kind: 'transport' })).toEqual({ kind: 'unavailable', reason: 'transport' });
  });

  it('reads an unparsable body as unavailable', () => {
    expect(decideCandidatePerformance({ kind: 'body' })).toEqual({ kind: 'unavailable', reason: 'unparsable' });
  });

  it('reads a 200 with an undecodable body as unavailable, never as no measurement', () => {
    expect(decideCandidatePerformance(http(200, { error: 'wrong_status' }))).toEqual({
      kind: 'unavailable',
      reason: 'malformed',
    });
  });

  it('reads a 200 null body as a confirmed absence of any measurement', () => {
    expect(decideCandidatePerformance(http(200, null))).toEqual({ kind: 'unmeasured' });
  });

  it('carries a decoded measurement through unchanged', () => {
    const body = envelope();
    expect(decideCandidatePerformance(http(200, body))).toEqual({
      kind: 'measured',
      performance: body as unknown as CandidatePerformance,
    });
  });
});

describe('reduceCandidatePerformance', () => {
  it('marks a started read pending without inventing a measurement', () => {
    const state = reduceCandidatePerformance(initialCandidatePerformanceState(), { type: 'start', requestId: 1 });
    expect(state).toEqual({ phase: 'pending', requestId: 1, performance: null, reason: null });
  });

  it('ignores a superseded read so an older failure cannot mark a newer read unavailable', () => {
    const confirmed = settled(http(200, envelope()));
    const retried = reduceCandidatePerformance(confirmed, { type: 'start', requestId: 2 });
    const obsolete = reduceCandidatePerformance(retried, { type: 'settle', requestId: 1, response: { kind: 'transport' } });
    expect(obsolete).toBe(retried);
    expect(obsolete.phase).toBe('pending');
  });

  it('keeps the last confirmed measurement when a read fails, and clears it on the next success', () => {
    const confirmed = settled(http(200, envelope()));
    const failed = reduceCandidatePerformance(confirmed, { type: 'settle', requestId: 2, response: { kind: 'transport' } });
    expect(failed.phase).toBe('unavailable');
    expect(failed.performance).toEqual(confirmed.performance);
    const better = reduceCandidatePerformance(
      failed,
      { type: 'settle', requestId: 3, response: http(200, envelope({ after: { runs: 6, successes: 3, success_rate: 0.5 }, delta: -1 / 6 })) },
    );
    expect(better.phase).toBe('measured');
    expect(better.performance?.after.runs).toBe(6);
  });

  it('resets to idle when the candidate is no longer a promoted one', () => {
    const confirmed = settled(http(200, envelope()));
    const idle = reduceCandidatePerformance(confirmed, { type: 'invalidate', requestId: 2 });
    expect(idle).toEqual({ phase: 'idle', requestId: 2, performance: null, reason: null });
    expect(candidatePerformanceView(idle)).toBeNull();
  });

  it('records a zero-sample envelope as unmeasured while keeping its counts', () => {
    const state = settled(http(200, envelope({ before: { runs: 0, successes: 0, success_rate: null }, after: { runs: 0, successes: 0, success_rate: null }, delta: null })));
    expect(state.phase).toBe('unmeasured');
    expect(state.performance).not.toBeNull();
  });
});

describe('candidatePerformanceView', () => {
  it('keeps the standing failure while its retry is in flight, and clears it once the retry settles', () => {
    const failed = settled({ kind: 'transport' });
    const retrying = reduceCandidatePerformance(failed, { type: 'start', requestId: 2 });
    const retryingView = candidatePerformanceView(retrying)!;
    expect(retryingView.kind).toBe('pending');
    expect(retryingView.failureText).toMatch(/Could not reach/);
    expect(retryingView.retryable).toBe(false);
    const confirmed = reduceCandidatePerformance(retrying, { type: 'settle', requestId: 2, response: http(200, envelope()) });
    expect(candidatePerformanceView(confirmed)!.failureText).toBeNull();
  });

  it('says nothing at all while no promoted candidate is selected', () => {
    expect(candidatePerformanceView(initialCandidatePerformanceState())).toBeNull();
  });

  it('announces a read in flight as pending and renders no rate', () => {
    const view = candidatePerformanceView(reduceCandidatePerformance(initialCandidatePerformanceState(), { type: 'start', requestId: 1 }))!;
    expect(view.kind).toBe('pending');
    expect(view.retryable).toBe(false);
    expect(view.measured).toBeNull();
    expect(view.text).toMatch(/^Reading performance since promotion/);
  });

  it.each([
    ['not_found', /no longer on record/i],
    ['not_promoted', /not recorded as promoted/i],
    ['invalid_record', /candidate record could not be read/i],
    ['http_error', /read was rejected/i],
    ['malformed', /could not be understood/i],
    ['transport', /could not reach/i],
    ['unparsable', /could not be read/i],
  ])('gives the %s failure its own fixed sentence and a retry', (reason, expected) => {
    const response: CandidatePerformanceResponse =
      reason === 'transport' ? { kind: 'transport' } : reason === 'unparsable' ? { kind: 'body' } : http(
        reason === 'not_found' ? 404 : reason === 'not_promoted' ? 409 : reason === 'invalid_record' ? 422 : reason === 'http_error' ? 500 : 200,
        reason === 'malformed' ? { error: 'private detail' } : envelope(),
      );
    const view = candidatePerformanceView(settled(response))!;
    expect(view.kind).toBe('unavailable');
    expect(view.retryable).toBe(true);
    expect(view.text).toMatch(expected);
    expect(view.text).not.toMatch(/private detail/);
  });

  it('reads a confirmed null body as no measurement yet rather than unavailable', () => {
    const view = candidatePerformanceView(settled(http(200, null)))!;
    expect(view.kind).toBe('unmeasured');
    expect(view.retryable).toBe(false);
    expect(view.measured).toBeNull();
    expect(view.text).toMatch(/no measurement yet/i);
    expect(view.text).toMatch(/promoted-at/i);
  });

  it('shows the sample counts of a confirmed read with no runs, and renders no rate', () => {
    const view = candidatePerformanceView(
      settled(http(200, envelope({ before: { runs: 0, successes: 0, success_rate: null }, after: { runs: 0, successes: 0, success_rate: null }, delta: null }))),
    )!;
    expect(view.kind).toBe('unmeasured');
    expect(view.measured).toBeNull();
    expect(view.text).toBe('No measurement yet — 0 of 0 runs before promotion, 0 of 0 after.');
  });

  it('renders the measured rates, the delta, and the counts that produced them', () => {
    const view = candidatePerformanceView(settled(http(200, envelope())))!;
    expect(view.kind).toBe('measured');
    expect(view.measured).toEqual({
      before: { rate: '67%', counts: '2 of 3' },
      after: { rate: '100%', counts: '5 of 5' },
      delta: { text: '+33%', positive: true },
      text: '2 of 3 runs before promotion, 5 of 5 after.',
    });
    expect(view.stale).toBe(false);
  });

  it('marks a negative delta and leaves an unmeasurable one as a dash', () => {
    const negative = candidatePerformanceView(
      settled(http(200, envelope({ after: { runs: 5, successes: 1, success_rate: 0.2 }, delta: 0.2 - 2 / 3 }))),
    )!;
    expect(negative.measured?.delta).toEqual({ text: '-47%', positive: false });

    const unmeasurable = candidatePerformanceView(
      settled(http(200, envelope({ before: { runs: 0, successes: 0, success_rate: null }, after: { runs: 4, successes: 3, success_rate: 0.75 }, delta: null }))),
    )!;
    expect(unmeasurable.measured?.before.rate).toBe('—');
    expect(unmeasurable.measured?.after.rate).toBe('75%');
    expect(unmeasurable.measured?.delta).toBeNull();
    expect(unmeasurable.measured?.text).toBe('0 of 0 runs before promotion, 3 of 4 after.');
  });

  it('keeps the last confirmed measurement visible but stale after a failed read', () => {
    const confirmed = settled(http(200, envelope()));
    const failed = reduceCandidatePerformance(confirmed, { type: 'settle', requestId: 2, response: { kind: 'transport' } });
    const view = candidatePerformanceView(failed)!;
    expect(view.kind).toBe('unavailable');
    expect(view.stale).toBe(true);
    expect(view.measured?.after.rate).toBe('100%');
    expect(view.measured?.text).toBe('2 of 3 runs before promotion, 5 of 5 after.');
    expect(view.text).toMatch(/may be stale/i);
  });
});
