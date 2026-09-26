/**
 * Promoted-skill performance — pure decision helpers for the Jarvis
 * SkillsView detail panel.
 *
 * `GET /skills/candidates/:id/performance` was read with a bare
 * `.then((r) => (r.ok ? r.json() : null)).catch(() => setPerformance(null))`,
 * so a 404 unknown candidate, a 409 wrong-status candidate, a 422
 * `invalid_candidate_record`, a transport failure, an unparsable body, and a
 * genuinely unmeasured candidate all collapsed into the same `null` — and the
 * whole "Since promotion" row renders only when `performance` is truthy
 * (`SkillsView.tsx:460-473`). A failed read therefore removed the before/after
 * success rates and the delta with no pending state, no announced failure, and
 * no retry, which reads as "no performance data yet" — the one interpretation
 * that keeps a failed read looking fine on a panel whose only job is to show a
 * promoted skill's measured effect.
 *
 * These helpers keep four states apart, decide them from what the route
 * actually returned, and never render a rate a window cannot support:
 *
 *   - `pending`      — the read is in flight.
 *   - `unavailable`  — the read failed or returned something undecodable. The
 *                      performance is unknown, and retryable.
 *   - `unmeasured`   — the read was confirmed and there is nothing to show:
 *                      a candidate record with no `promoted_at` (the route
 *                      serialises `null` with a 200) or a window pair with no
 *                      runs. A confirmed absence, not a failure.
 *   - `measured`     — the route returned a complete, self-consistent envelope.
 *
 * `computeCandidatePerformance` (`server-jarvis/src/intelligence/
 * skill-promotion.ts`) stays the only computation and the SelfTuningStore
 * windows its only data source; nothing here re-evaluates a candidate,
 * re-promotes it, or recomputes a rate.
 */

export interface PerformanceWindowStats {
  runs: number;
  successes: number;
  success_rate: number | null;
}

export interface CandidatePerformance {
  id: string;
  promoted_at: string;
  task_types: string[];
  before: PerformanceWindowStats;
  after: PerformanceWindowStats;
  delta: number | null;
}

/**
 * What one read of the performance route produced. `http` carries a status and
 * whatever the body decoded to; `transport` is a rejected request; `body` is a
 * response whose body could not be parsed. No transport or server text is
 * carried, so no error detail can reach the surface.
 */
export type CandidatePerformanceResponse =
  | { kind: 'transport' }
  | { kind: 'body' }
  | { kind: 'http'; status: number; value: unknown };

export type CandidatePerformanceFailure =
  | 'not_found'
  | 'not_promoted'
  | 'invalid_record'
  | 'http_error'
  | 'malformed'
  | 'transport'
  | 'unparsable';

export type CandidatePerformanceOutcome =
  | { kind: 'unmeasured' }
  | { kind: 'unavailable'; reason: CandidatePerformanceFailure }
  | { kind: 'measured'; performance: CandidatePerformance };

export type DecodedCandidatePerformance =
  | { kind: 'unmeasured' }
  | { kind: 'measured'; performance: CandidatePerformance }
  | { kind: 'invalid' };

export type CandidatePerformancePhase = 'idle' | 'pending' | 'unavailable' | 'unmeasured' | 'measured';

export interface CandidatePerformanceState {
  phase: CandidatePerformancePhase;
  requestId: number;
  /** The last confirmed measurement, kept across a failed or pending read. */
  performance: CandidatePerformance | null;
  /** Why the last read could not be measured, when it could not be measured. */
  reason: CandidatePerformanceFailure | null;
}

export type CandidatePerformanceEvent =
  | { type: 'start'; requestId: number }
  | { type: 'invalidate'; requestId: number }
  | { type: 'settle'; requestId: number; response: CandidatePerformanceResponse };

export interface MeasuredWindowView {
  /** `67%`, or `—` when the window has no runs to measure. */
  rate: string;
  /** `2 of 3` — the sample counts the rate came from. */
  counts: string;
}

export interface MeasuredPerformanceView {
  before: MeasuredWindowView;
  after: MeasuredWindowView;
  /** `+33%`, or `null` when the delta cannot be computed from these windows. */
  delta: { text: string; positive: boolean } | null;
  text: string;
}

export interface CandidatePerformanceView {
  kind: Exclude<CandidatePerformancePhase, 'idle'>;
  /** One fixed sentence, or the sample counts behind a measured pair. */
  text: string;
  /**
   * The standing failure sentence, or `null`. It stays present while a retry
   * for that same failure is still in flight, so a re-read never makes the
   * previous failure look resolved.
   */
  failureText: string | null;
  /** True when the rates below were confirmed by an earlier read. */
  stale: boolean;
  retryable: boolean;
  measured: MeasuredPerformanceView | null;
}

export const PERFORMANCE_PENDING_TEXT = 'Reading performance since promotion…';

/** Announced, fixed message per unavailable reason. No server text is copied. */
const FAILURE_TEXTS: Record<CandidatePerformanceFailure, string> = {
  not_found: 'Could not read performance since promotion: this candidate is no longer on record on the server.',
  not_promoted: 'Could not read performance since promotion: this candidate is not recorded as promoted.',
  invalid_record: 'Could not read performance since promotion: the candidate record could not be read.',
  http_error: 'Could not read performance since promotion: the read was rejected by the server.',
  malformed: 'Could not read performance since promotion: the read could not be understood.',
  transport: 'Could not reach the performance read for this candidate.',
  unparsable: 'Could not read performance since promotion: the response could not be read.',
};

export const PERFORMANCE_UNMEASURED_TEXT =
  'No measurement yet — the candidate record has no promoted-at time to measure from.';

export const PERFORMANCE_STALE_SUFFIX = ' Showing the last confirmed measurement; it may be stale.';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isDelta(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1;
}

/**
 * A window is decodable only when its counts are whole, its successes do not
 * exceed its runs, and a rate exists if and only if the window has runs — a
 * rate over zero samples is not a measurement and must not be rendered.
 */
function decodeWindow(value: unknown): PerformanceWindowStats | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const window = value as Record<string, unknown>;
  if (!isCount(window.runs) || !isCount(window.successes)) return null;
  if (window.successes > window.runs) return null;
  const rate = window.success_rate;
  if (rate === null) {
    if (window.runs > 0) return null;
  } else if (!isRate(rate) || window.runs === 0) {
    return null;
  }
  return { runs: window.runs, successes: window.successes, success_rate: rate };
}

/**
 * Decode one performance envelope. A JSON `null` root is the route's own
 * `computeCandidatePerformance` result for a candidate with no `promoted_at`
 * (`server-jarvis/src/index.ts:5317-5322`), which is a confirmed absence of any
 * measurement. Anything else that is not a complete, self-consistent envelope
 * is `invalid`, so a schema-drifted body can never be presented as a
 * measurement or as an absence of one.
 */
export function decodeCandidatePerformance(value: unknown): DecodedCandidatePerformance {
  if (value === null) return { kind: 'unmeasured' };
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };
  const envelope = value as Record<string, unknown>;
  if (!isNonEmptyString(envelope.id) || !isNonEmptyString(envelope.promoted_at)) return { kind: 'invalid' };
  if (!Array.isArray(envelope.task_types) || !envelope.task_types.every(isNonEmptyString)) return { kind: 'invalid' };
  const before = decodeWindow(envelope.before);
  const after = decodeWindow(envelope.after);
  if (!before || !after) return { kind: 'invalid' };
  const delta = envelope.delta;
  if (delta === null) {
    if (before.success_rate !== null && after.success_rate !== null) return { kind: 'invalid' };
  } else if (!isDelta(delta) || before.success_rate === null || after.success_rate === null) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'measured',
    performance: { id: envelope.id, promoted_at: envelope.promoted_at, task_types: [...envelope.task_types], before, after, delta },
  };
}

/**
 * Decide one read. The route answers 404 for an unknown candidate, 409 for one
 * that is not promoted, and 422 for an unreadable record
 * (`server-jarvis/src/index.ts:5303-5316`); each is a distinct unavailable
 * reason so the surface can name what it could not learn.
 */
export function decideCandidatePerformance(response: CandidatePerformanceResponse): CandidatePerformanceOutcome {
  if (response.kind === 'transport') return { kind: 'unavailable', reason: 'transport' };
  if (response.kind === 'body') return { kind: 'unavailable', reason: 'unparsable' };
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404) return { kind: 'unavailable', reason: 'not_found' };
    if (response.status === 409) return { kind: 'unavailable', reason: 'not_promoted' };
    if (response.status === 422) return { kind: 'unavailable', reason: 'invalid_record' };
    return { kind: 'unavailable', reason: 'http_error' };
  }
  const decoded = decodeCandidatePerformance(response.value);
  if (decoded.kind === 'invalid') return { kind: 'unavailable', reason: 'malformed' };
  if (decoded.kind === 'unmeasured') return { kind: 'unmeasured' };
  return decoded;
}

export function initialCandidatePerformanceState(): CandidatePerformanceState {
  return { phase: 'idle', requestId: 0, performance: null, reason: null };
}

/**
 * Settle one read into the panel's state. A response from a request older than
 * the latest issued one is ignored entirely, so an obsolete read can neither
 * publish its own outcome nor end the pending state of the read that replaced
 * it. A failed read keeps the last confirmed measurement so it can be shown as
 * stale instead of vanishing, and `invalidate` drops it when the candidate is
 * no longer a promoted one and there is nothing left to measure since.
 */
export function reduceCandidatePerformance(
  state: CandidatePerformanceState,
  event: CandidatePerformanceEvent,
): CandidatePerformanceState {
  if (event.requestId < state.requestId) return state;
  if (event.type === 'start') {
    // A retry does not resolve the failure it is retrying: the reason stays
    // until this read settles, so the surface keeps saying what went wrong
    // while the re-read is in flight.
    return { phase: 'pending', requestId: event.requestId, performance: state.performance, reason: state.reason };
  }
  if (event.type === 'invalidate') {
    return { phase: 'idle', requestId: event.requestId, performance: null, reason: null };
  }
  const outcome = decideCandidatePerformance(event.response);
  if (outcome.kind === 'unavailable') {
    return { phase: 'unavailable', requestId: event.requestId, performance: state.performance, reason: outcome.reason };
  }
  if (outcome.kind === 'unmeasured') {
    return { phase: 'unmeasured', requestId: event.requestId, performance: state.performance, reason: null };
  }
  // An envelope whose two windows hold no runs at all is a confirmed absence
  // of a measurement, not a measurement of nothing: no rate can exist for it,
  // and the counts that prove that are kept so the surface can show them.
  if (outcome.performance.before.runs === 0 && outcome.performance.after.runs === 0) {
    return { phase: 'unmeasured', requestId: event.requestId, performance: outcome.performance, reason: null };
  }
  return { phase: 'measured', requestId: event.requestId, performance: outcome.performance, reason: null };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function measuredView(performance: CandidatePerformance): MeasuredPerformanceView {
  const window = (stats: PerformanceWindowStats): MeasuredWindowView => ({
    rate: stats.success_rate === null ? '—' : percent(stats.success_rate),
    counts: `${stats.successes} of ${stats.runs}`,
  });
  const delta = performance.delta === null
    ? null
    : { text: `${performance.delta >= 0 ? '+' : ''}${percent(performance.delta)}`, positive: performance.delta >= 0 };
  return {
    before: window(performance.before),
    after: window(performance.after),
    delta,
    text: `${performance.before.successes} of ${performance.before.runs} runs before promotion, ${performance.after.successes} of ${performance.after.runs} after.`,
  };
}

/** Project the panel state onto the one row the surface shows. */
export function candidatePerformanceView(state: CandidatePerformanceState): CandidatePerformanceView | null {
  if (state.phase === 'idle') return null;
  const confirmed = state.performance ? measuredView(state.performance) : null;
  // A retained measurement is only ever shown beside the reason it is no longer
  // the newest read, and is labelled stale whenever that is the case.
  const stale = confirmed !== null && state.phase !== 'measured';
  const withStaleness = (text: string) => (stale ? `${text}${PERFORMANCE_STALE_SUFFIX}` : text);
  const failureText = state.reason === null ? null : withStaleness(FAILURE_TEXTS[state.reason]);
  if (state.phase === 'pending') {
    return { kind: 'pending', text: PERFORMANCE_PENDING_TEXT, failureText, stale, retryable: false, measured: confirmed };
  }
  if (state.phase === 'unavailable') {
    return { kind: 'unavailable', text: failureText!, failureText, stale, retryable: true, measured: confirmed };
  }
  if (state.phase === 'unmeasured') {
    return {
      kind: 'unmeasured',
      text: state.performance
        ? `No measurement yet — ${state.performance.before.successes} of ${state.performance.before.runs} runs before promotion, ${state.performance.after.successes} of ${state.performance.after.runs} after.`
        : PERFORMANCE_UNMEASURED_TEXT,
      failureText,
      stale: false,
      retryable: false,
      measured: null,
    };
  }
  return { kind: 'measured', text: confirmed!.text, failureText, stale: false, retryable: false, measured: confirmed };
}
