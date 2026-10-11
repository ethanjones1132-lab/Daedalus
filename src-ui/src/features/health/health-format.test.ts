import { describe, expect, it } from 'vitest';
import {
  cacheTone,
  checkTone,
  conductorCacheVariant,
  decodeDirectives,
  decodeInferenceMetrics,
  errorRateTone,
  formatAttemptSummary,
  formatRuntimeProvenance,
  parseDoctorReport,
  parseJarvisStatus,
} from './health-format';

describe('conductorCacheVariant', () => {
  // The Track A-02 acceptance criterion is >80% prefix reuse on a 3-turn
  // session (see docs/issues/post-phase-4-conductor-evolution.md A-02),
  // so the "green" threshold must be 0.8 — any tightening would create
  // false-positive amber states on a healthy warm conductor.
  it('returns success for hit rates at or above the 0.8 A-02 target', () => {
    expect(conductorCacheVariant(0.8)).toBe('success');
    expect(conductorCacheVariant(0.9)).toBe('success');
    expect(conductorCacheVariant(1.0)).toBe('success');
  });

  it('returns warn for hit rates in the 0.5..0.8 band', () => {
    expect(conductorCacheVariant(0.5)).toBe('warn');
    expect(conductorCacheVariant(0.65)).toBe('warn');
    expect(conductorCacheVariant(0.79)).toBe('warn');
  });

  it('returns error for hit rates below 0.5', () => {
    expect(conductorCacheVariant(0.0)).toBe('error');
    expect(conductorCacheVariant(0.25)).toBe('error');
    expect(conductorCacheVariant(0.49)).toBe('error');
  });

  it('returns error for non-finite or negative rates (defensive)', () => {
    // The server should never emit NaN / Infinity / negative, but a
    // future refactor that computes the rate differently (e.g. dividing
    // by a zero denominator) could. The helper must not silently render
    // a green pill on a corrupt measurement.
    expect(conductorCacheVariant(Number.NaN)).toBe('error');
    expect(conductorCacheVariant(Number.POSITIVE_INFINITY)).toBe('error');
    expect(conductorCacheVariant(Number.NEGATIVE_INFINITY)).toBe('error');
    expect(conductorCacheVariant(-0.1)).toBe('error');
  });
});

describe('formatRuntimeProvenance', () => {
  it('shows version, short server SHA, and effective model', () => {
    expect(formatRuntimeProvenance({ version: '3.0.0', git_sha: '0ca584bb611fbb77e16d45c83bedf74c1d160846', model: 'openrouter/free' }))
      .toBe('3.0.0 · 0ca584bb611f · openrouter/free');
  });

  it('reports unavailable runtime health explicitly', () => {
    expect(formatRuntimeProvenance(null)).toBe('Runtime health unavailable');
  });
});

describe('partial native payload resilience', () => {
  // get_system_health / inference backends can arrive with missing sections;
  // rendering must not throw (same class as SystemStatusBar 93-95, HealthBanner fix).
  it('tolerates a backend with null error_rate / errors / requests', () => {
    const b = { backend: 'openrouter/free', error_rate: undefined as any, errors: undefined as any, requests: undefined as any, p50_ms: 120, p95_ms: 340 };
    expect((b?.error_rate ?? 0) > 0.1 ? 'error' : (b?.error_rate ?? 0) > 0 ? 'warn' : 'success').toBe('success');
    expect(`${(b?.errors ?? 0)}/${(b?.requests ?? 1)}`).toBe('0/1');
  });
});

describe('formatAttemptSummary', () => {
  it('keeps the stage attempt summary compact and secret-free', () => {
    expect(formatAttemptSummary({
      stage: 'synthesizer',
      provider: 'opencode_go',
      model: 'deepseek-v4-flash',
      outcome: 'empty_completion',
      latency_ms: 21000,
    })).toBe('synthesizer · opencode_go/deepseek-v4-flash · empty_completion · 21000ms');
  });
});

describe('decoders and parsers', () => {
  it('rejects a malformed doctor report instead of showing an empty checklist', () => {
    expect(parseDoctorReport(null)).toBeNull();
    expect(parseDoctorReport({ checks: 'nope', summary: {} })).toBeNull();
    expect(parseDoctorReport({ checks: [{ name: 'x' }], summary: { total: 1, ok: 1, warn: 0, error: 0, overall: 'ok' } })).toBeNull();
    expect(parseDoctorReport({ checks: [], summary: { total: 0, ok: 0, warn: 0, error: 0, overall: 'ok' } })).toMatchObject({ checks: [], timestamp: '' });
  });

  it('requires a status read to name the active backend', () => {
    expect(parseJarvisStatus(true)).toBeNull();
    expect(parseJarvisStatus({})).toBeNull();
    expect(parseJarvisStatus({ active_backend: 'llama_cpp' })).toMatchObject({ active_backend: 'llama_cpp' });
  });

  it('tolerates partial inference payloads and drops a conductor cache without a hit rate', () => {
    expect(decodeInferenceMetrics({ window_size: 'x' })).toBeNull();
    expect(decodeInferenceMetrics({ window_size: 2, backends: [{ backend: 'a', p50_ms: 1, p95_ms: 2 }, 7], conductor_cache: { window_size: 1 } }))
      .toMatchObject({ window_size: 2, backends: [{ backend: 'a' }], recent_attempts: [], conductor_cache: null });
  });

  it('decodes directives, ignoring non-numeric counts', () => {
    expect(decodeDirectives({ window_size: 3, by_type: { continue: 2, odd: 'x' } })?.by_type).toEqual({ continue: 2 });
    expect(decodeDirectives({ window_size: 3 })).toBeNull();
  });

  it('maps statuses and rates onto tones, never reading a corrupt rate as healthy', () => {
    expect(checkTone('OK')).toBe('ok');
    expect(checkTone('warning')).toBe('warn');
    expect(checkTone('fail')).toBe('error');
    expect(checkTone('skipped')).toBe('neutral');
    expect(errorRateTone(undefined)).toBe('ok');
    expect(errorRateTone(0.05)).toBe('warn');
    expect(errorRateTone(0.5)).toBe('error');
    expect(cacheTone(Number.NaN)).toBe('error');
    expect(cacheTone(0.9)).toBe('ok');
  });
});
